import { z } from "zod";

import { type TopicId } from "./canonicalization";
import type {
  PlanTurnResult,
  MemoryExtractionResult,
  MemoryProposal,
  MemorySnapshot,
  TopicPacket,
} from "./types";

export class AgentOutputValidationError extends Error {
  constructor(
    readonly role: string,
    readonly issues: readonly string[],
  ) {
    super(`${role} output is invalid: ${issues.join("; ")}`);
    this.name = "AgentOutputValidationError";
  }
}

const nonEmpty = z.string().trim().min(1);
export const PlanTurnSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("clarify"), question: nonEmpty }).strict(),
  z
    .object({
      mode: z.literal("single"),
      question: nonEmpty,
      relevantTurnIds: z.array(nonEmpty),
    })
    .strict(),
  z
    .object({
      mode: z.literal("fanout"),
      question: nonEmpty,
      topics: z
        .array(z.object({ question: nonEmpty, relevantTurnIds: z.array(nonEmpty) }).strict())
        .min(2)
        .max(3),
    })
    .strict(),
]);

// Z.AI function parameters require one root object. Keep branch fields optional
// only at the transport boundary; validatePlanTurn enforces the strict union.
export const PlanTurnProviderSchema = z
  .object({
    mode: z.enum(["clarify", "single", "fanout"]),
    question: nonEmpty.optional(),
    relevantTurnIds: z.array(nonEmpty).optional(),
    topics: z
      .array(z.object({ question: nonEmpty, relevantTurnIds: z.array(nonEmpty) }).strict())
      .optional(),
  })
  .strict();

const parseIssues = (error: z.ZodError): readonly string[] =>
  error.issues.map((issue) => `${issue.path.join(".") || "output"}: ${issue.message}`);

const unique = (values: readonly string[]): boolean => new Set(values).size === values.length;

export const validatePlanTurn = (
  value: unknown,
  inventoryTurnIds: readonly string[],
  maximumTopics: number,
): PlanTurnResult => {
  const parsed = PlanTurnSchema.safeParse(value);
  if (!parsed.success) throw new AgentOutputValidationError("plan_turn", parseIssues(parsed.error));
  if (parsed.data.mode === "clarify") return parsed.data;

  const allowed = new Set(inventoryTurnIds);
  const issues: string[] = [];
  const ids =
    parsed.data.mode === "single"
      ? parsed.data.relevantTurnIds
      : parsed.data.topics.flatMap((topic) => topic.relevantTurnIds);
  if (parsed.data.mode === "fanout" && parsed.data.topics.length > Math.min(maximumTopics, 3)) {
    issues.push("fanout exceeds topic limit");
  }
  if (!unique(ids)) issues.push("selected turn ids must be unique");
  for (const id of ids) {
    if (!allowed.has(id)) issues.push(`selected turn ${id} is outside the supplied inventory`);
  }
  if (parsed.data.mode === "fanout") {
    if (!unique(parsed.data.topics.map((topic) => topic.question))) {
      issues.push("topic questions must be unique");
    }
    for (const [index, topic] of parsed.data.topics.entries()) {
      if (!unique(topic.relevantTurnIds)) issues.push(`topic ${index + 1} repeats a turn id`);
    }
  }
  if (issues.length > 0) throw new AgentOutputValidationError("plan_turn", issues);
  if (parsed.data.mode === "single") return parsed.data;
  return {
    mode: "fanout",
    question: parsed.data.question,
    topics: parsed.data.topics.map((topic, index) => ({
      topicId: (["t1", "t2", "t3"] as const)[index]!,
      question: topic.question,
      relevantTurnIds: topic.relevantTurnIds,
    })),
  };
};

const TopicPacketSchema = z
  .object({
    topicId: z.enum(["t1", "t2", "t3"]),
    status: z.enum(["answered", "partial"]),
    claims: z.array(z.object({ text: z.string(), sourceKeys: z.array(z.string()) }).strict()),
    gaps: z.array(z.string()),
  })
  .strict();

export const validateTopicPacket = (
  packet: TopicPacket,
  topicId: TopicId,
  visibleSourceKeys: readonly string[],
): TopicPacket => {
  const parsed = TopicPacketSchema.safeParse(packet);
  if (!parsed.success)
    throw new AgentOutputValidationError("topic_answer", parseIssues(parsed.error));
  const visible = new Set(visibleSourceKeys);
  const issues: string[] = [];
  if (packet.topicId !== topicId) issues.push("topic packet id does not match its branch");
  for (const [index, claim] of packet.claims.entries()) {
    if (claim.text.trim() === "") issues.push(`claim ${index + 1} is empty`);
    if (claim.sourceKeys.length === 0) issues.push(`claim ${index + 1} has no source key`);
    if (!unique(claim.sourceKeys)) issues.push(`claim ${index + 1} repeats a source key`);
    for (const key of claim.sourceKeys) {
      if (!visible.has(key)) issues.push(`claim ${index + 1} cites source outside topic context`);
    }
  }
  if (packet.status === "answered" && packet.claims.length === 0) {
    issues.push("answered packet must contain at least one claim");
  }
  for (const [index, gap] of packet.gaps.entries()) {
    if (gap.trim() === "") issues.push(`gap ${index + 1} is empty`);
  }
  if (visible.size === 0 && (packet.status !== "partial" || packet.claims.length > 0)) {
    issues.push("empty evidence must produce a partial packet without claims");
  }
  if (packet.status === "partial" && packet.gaps.length === 0) {
    issues.push("partial packet must state at least one gap");
  }
  if (issues.length > 0) throw new AgentOutputValidationError("topic_answer", issues);
  return packet;
};

export const validateMemoryProposals = (
  proposals: readonly MemoryProposal[],
  active: readonly MemorySnapshot[],
  discovered: ReadonlySet<string>,
): MemoryExtractionResult => {
  const snapshotById = new Map(active.map((memory) => [memory.memoryId, memory]));
  const activePairs = new Set(
    active.map((memory) => `${memory.kind}\u0000${memory.content.trim()}`),
  );
  const acceptedPairs = new Set<string>();
  const targeted = new Set<string>();
  const validated: MemoryExtractionResult["proposals"][number][] = [];
  let discardedCount = 0;

  for (const proposal of proposals) {
    const content = proposal.content.trim();
    if (content === "") {
      discardedCount += 1;
      continue;
    }
    const target =
      proposal.targetMemoryId === undefined ? undefined : snapshotById.get(proposal.targetMemoryId);
    if (proposal.targetMemoryId !== undefined) {
      if (targeted.has(proposal.targetMemoryId)) {
        throw new AgentOutputValidationError("memory_extractor", [
          `multiple proposals target memory ${proposal.targetMemoryId}`,
        ]);
      }
      // Target uniqueness is a property of the provider output, not only of the
      // proposals that survive content-pair deduplication.
      targeted.add(proposal.targetMemoryId);
      if (
        target === undefined ||
        !discovered.has(`${proposal.targetMemoryId}:${target.memoryRevisionId}`)
      ) {
        discardedCount += 1;
        continue;
      }
    }
    const pair = `${proposal.kind}\u0000${content}`;
    if (activePairs.has(pair) || acceptedPairs.has(pair)) {
      discardedCount += 1;
      continue;
    }
    if (proposal.targetMemoryId !== undefined) {
      validated.push({
        kind: proposal.kind,
        content,
        targetMemoryId: target!.memoryId,
        expectedHeadRevisionId: target!.memoryRevisionId,
      });
    } else {
      validated.push({ kind: proposal.kind, content });
    }
    acceptedPairs.add(pair);
  }
  return { proposals: validated, discardedCount };
};
