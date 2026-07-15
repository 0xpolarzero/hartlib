import { z } from "zod";

import { normalizeCharacterRanges, type TopicId } from "./canonicalization";
import type {
  AnswerCandidate,
  ContextDecision,
  ConversationResolution,
  MemoryExtractionResult,
  MemoryProposal,
  MemorySnapshot,
  NormalizedExecutionPlan,
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
export const ConversationResolutionSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("continue"),
      retrievalQuestion: nonEmpty,
      selectedTurnIds: z.array(nonEmpty),
    })
    .strict(),
  z.object({ mode: z.literal("clarify"), question: nonEmpty }).strict(),
]);

// Z.AI function parameters require one root object. Keep both branch fields
// optional only at the transport boundary; ConversationResolutionSchema and
// validateConversationResolution still enforce the exact strict union after
// the provider returns arguments.
export const ConversationResolutionProviderSchema = z
  .object({
    mode: z.enum(["continue", "clarify"]),
    retrievalQuestion: nonEmpty.optional(),
    selectedTurnIds: z.array(nonEmpty).optional(),
    question: nonEmpty.optional(),
  })
  .strict();

const ExecutionPlanSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("single"), reason: nonEmpty }).strict(),
  z
    .object({
      mode: z.literal("fanout"),
      reason: nonEmpty,
      topics: z
        .array(z.object({ question: nonEmpty, relevantTurnIds: z.array(nonEmpty) }).strict())
        .min(2)
        .max(3),
    })
    .strict(),
]);

const parseIssues = (error: z.ZodError): readonly string[] =>
  error.issues.map((issue) => `${issue.path.join(".") || "output"}: ${issue.message}`);

const unique = (values: readonly string[]): boolean => new Set(values).size === values.length;

export const validateConversationResolution = (
  value: unknown,
  inventoryTurnIds: readonly string[],
): ConversationResolution => {
  const parsed = ConversationResolutionSchema.safeParse(value);
  if (!parsed.success)
    throw new AgentOutputValidationError("conversation_resolver", parseIssues(parsed.error));
  if (parsed.data.mode === "clarify") return parsed.data;

  const allowed = new Set(inventoryTurnIds);
  const issues: string[] = [];
  if (!unique(parsed.data.selectedTurnIds)) issues.push("selected turn ids must be unique");
  for (const id of parsed.data.selectedTurnIds) {
    if (!allowed.has(id)) issues.push(`selected turn ${id} is outside the supplied inventory`);
  }
  if (issues.length > 0) throw new AgentOutputValidationError("conversation_resolver", issues);
  return parsed.data;
};

const topicIds: readonly TopicId[] = ["t1", "t2", "t3"];

export const validateAndNormalizeExecutionPlan = (
  value: unknown,
  selectedTurnIds: readonly string[],
  maximumTopics: number,
): NormalizedExecutionPlan => {
  const parsed = ExecutionPlanSchema.safeParse(value);
  if (!parsed.success)
    throw new AgentOutputValidationError("execution_planner", parseIssues(parsed.error));
  if (parsed.data.mode === "single") return parsed.data;

  const issues: string[] = [];
  const allowed = new Set(selectedTurnIds);
  if (parsed.data.topics.length > Math.min(maximumTopics, 3))
    issues.push("fanout exceeds topic limit");
  if (!unique(parsed.data.topics.map((topic) => topic.question)))
    issues.push("topic questions must be unique");
  for (const [index, topic] of parsed.data.topics.entries()) {
    if (!unique(topic.relevantTurnIds)) issues.push(`topic ${index + 1} repeats a turn id`);
    for (const id of topic.relevantTurnIds) {
      if (!allowed.has(id)) issues.push(`topic ${index + 1} references an unselected turn`);
    }
  }
  if (issues.length > 0) throw new AgentOutputValidationError("execution_planner", issues);

  return {
    mode: "fanout",
    reason: parsed.data.reason,
    topics: parsed.data.topics.map((topic, index) => ({
      topicId: topicIds[index]!,
      question: topic.question,
      relevantTurnIds: topic.relevantTurnIds,
    })),
  };
};

const ContextDecisionSchema = z.discriminatedUnion("action", [
  z.object({ id: nonEmpty, action: z.literal("keep"), reason: nonEmpty }).strict(),
  z
    .object({
      id: nonEmpty,
      action: z.literal("range"),
      ranges: z
        .array(z.object({ charStart: z.number().int(), charEnd: z.number().int() }).strict())
        .min(1),
      reason: nonEmpty,
    })
    .strict(),
  z.object({ id: nonEmpty, action: z.literal("omit"), reason: nonEmpty }).strict(),
]);

const TopicPacketSchema = z
  .object({
    topicId: z.enum(["t1", "t2", "t3"]),
    status: z.enum(["answered", "partial"]),
    claims: z.array(z.object({ text: z.string(), sourceKeys: z.array(z.string()) }).strict()),
    gaps: z.array(z.string()),
  })
  .strict();

export const validateContextDecisions = (
  value: unknown,
  candidates: readonly {
    readonly id: string;
    readonly kind: AnswerCandidate["kind"] | "conversation_entry";
    readonly text?: string | undefined;
  }[],
): readonly ContextDecision[] => {
  const parsed = z.array(ContextDecisionSchema).safeParse(value);
  if (!parsed.success)
    throw new AgentOutputValidationError("context_reducer", parseIssues(parsed.error));
  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const decisionIds = parsed.data.map((decision) => decision.id);
  const issues: string[] = [];
  if (!unique(decisionIds)) issues.push("each candidate must be decided exactly once");
  if (decisionIds.length !== candidates.length)
    issues.push("decision count does not match candidate count");
  for (const candidate of candidates) {
    if (!decisionIds.includes(candidate.id))
      issues.push(`candidate ${candidate.id} is unaccounted for`);
  }

  const normalized = parsed.data.map((decision): ContextDecision => {
    const candidate = candidateById.get(decision.id);
    if (candidate === undefined) {
      issues.push(`decision ${decision.id} does not identify a candidate`);
      return decision;
    }
    if (decision.action !== "range") return decision;
    if (candidate.kind !== "document") {
      issues.push(`range is not valid for ${candidate.kind} candidate ${candidate.id}`);
      return decision;
    }
    if (candidate.text === undefined) {
      issues.push(`document candidate ${candidate.id} has no immutable text`);
      return decision;
    }
    try {
      return {
        ...decision,
        ranges: normalizeCharacterRanges(decision.ranges, candidate.text.length),
      };
    } catch (error) {
      issues.push(error instanceof Error ? error.message : String(error));
      return decision;
    }
  });
  if (issues.length > 0) throw new AgentOutputValidationError("context_reducer", issues);
  return normalized;
};

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
      if (target === undefined) {
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
