import { createHash } from "node:crypto";

import { z } from "zod";

import { compactionGroupTaskId } from "../context/compaction-runtime";
import { reciprocalRankContribution } from "../retrieval/rank-fusion";
import { stripHistoricalCitationTags } from "../runtime/canonicalization";
import { PREVIEW_RANGE_SEPARATOR } from "../workflow/types";
import { PlanTurnPrompt, DirectAnswerPrompt, SynthesisPrompt, TopicAnswerPrompt } from "../prompts";
import { resolveRegisteredModel, usableInputTokens } from "../runtime/model-registry";
import {
  providerRequestSha256Hex,
  serializeAnswerSource,
  type ProviderRequest,
} from "../runtime/provider-request";
import { PlanTurnProviderSchema } from "../runtime/validators";
import {
  GeneralPlannerEvaluationResultsSchema,
  GoldenEvaluationSetSchema,
  SpecializedEvaluationResultsSchema,
  type EvaluationRange,
  type GeneralPlannerEvaluationResult,
  type GoldenEvaluationCase,
  type ProviderCoordinate,
  type SpecializedEvaluationResult,
  type TaskCoordinate,
} from "./schema";

export const CanonicalEvaluationTokenGate = Object.freeze({
  modelId: "glm-5-turbo" as const,
  inputTokens: 100_000,
  outputTokens: 16_384,
});

export interface CanonicalEvaluationSourceSelection {
  readonly sourceId: string;
  readonly ranges: readonly EvaluationRange[];
}

export type ExactProductionConversationBinding =
  | {
      readonly kind: "complete";
      readonly fixtureTurnId: string;
      readonly turnId: string;
      readonly userMessageId: string;
      readonly assistantMessageId: string;
    }
  | {
      readonly kind: "failed";
      readonly fixtureTurnId: string;
      readonly turnId: string;
      readonly userMessageId: string;
      readonly errorCode: string;
      readonly retryable: boolean;
    };

export interface ExactProductionSourceBinding extends CanonicalEvaluationSourceSelection {
  readonly kind: "document" | "chat_message" | "memory" | "web";
  readonly sourceKey: string;
  readonly purpose: string;
  readonly label: string | null;
  /** Live web quotations are bound by their durable hash during capture. */
  readonly contentOverride?: string | undefined;
}

export interface ExactProductionTopicPacket {
  readonly topicId: "t1" | "t2" | "t3";
  readonly status: "answered" | "partial";
  readonly claims: readonly { readonly text: string; readonly sourceKeys: readonly string[] }[];
  readonly gaps: readonly string[];
}

export type ExactProductionContextInput =
  | {
      readonly requestKind: "direct";
      readonly question: string;
      readonly selectedConversation: readonly ExactProductionConversationBinding[];
      readonly gaps: readonly string[];
      readonly sources: readonly ExactProductionSourceBinding[];
      readonly requestedOutputTokens: number;
    }
  | {
      readonly requestKind: "topic";
      readonly topicId: "t1" | "t2" | "t3";
      readonly question: string;
      readonly selectedConversation: readonly ExactProductionConversationBinding[];
      readonly gaps: readonly string[];
      readonly sources: readonly ExactProductionSourceBinding[];
      readonly requestedOutputTokens: number;
    }
  | {
      readonly requestKind: "synthesis";
      readonly selectedConversation: readonly ExactProductionConversationBinding[];
      readonly packets: readonly ExactProductionTopicPacket[];
      readonly requestedOutputTokens: number;
    };

const TopicPacketSchema = z
  .object({
    topicId: z.enum(["t1", "t2", "t3"]),
    status: z.enum(["answered", "partial"]),
    claims: z.array(z.object({ text: z.string(), sourceKeys: z.array(z.string()) }).strict()),
    gaps: z.array(z.string()),
  })
  .strict();

const canonicalValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Readonly<Record<string, unknown>>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalValue(nested)]),
  );
};

/**
 * Evaluation attestations use the same normalized transport digest as the
 * live Pi boundary.  The evaluation request builders intentionally produce
 * the pre-normalization shape, so hashing that shape directly would omit
 * transport-derived fields such as `strict: false` on tools.
 */
export const productionRequestSha256Hex = providerRequestSha256Hex;

export const productionPacketSha256Hex = (packet: ExactProductionTopicPacket): string =>
  createHash("sha256")
    .update(JSON.stringify(canonicalValue(packet)))
    .digest("hex");

export interface TerminalRequestEvidenceProjection {
  readonly coordinate: {
    readonly taskId: string;
    readonly loopIteration: number;
    readonly attempt: number;
    readonly providerRequestIndex: number;
  };
  readonly requestKind: "direct" | "topic" | "synthesis";
  readonly consumerTaskId: string;
  readonly topicId?: "t1" | "t2" | "t3" | undefined;
  readonly requestSha256Hex: string;
  readonly localInputTokens: number;
  readonly providerInputTokens: number;
  readonly requestedOutputTokens: number;
  readonly usableInputTokens: number;
  readonly sourceMap: readonly unknown[];
  readonly proofDigests: readonly string[];
}

export const terminalRequestEvidenceSha256Hex = (
  request: TerminalRequestEvidenceProjection,
): string =>
  createHash("sha256")
    .update(
      JSON.stringify(
        canonicalValue({
          coordinate: request.coordinate,
          requestKind: request.requestKind,
          consumerTaskId: request.consumerTaskId,
          ...(request.topicId === undefined ? {} : { topicId: request.topicId }),
          requestSha256Hex: request.requestSha256Hex,
          localInputTokens: request.localInputTokens,
          providerInputTokens: request.providerInputTokens,
          requestedOutputTokens: request.requestedOutputTokens,
          usableInputTokens: request.usableInputTokens,
          sourceMap: request.sourceMap,
          proofDigests: request.proofDigests,
        }),
      ),
    )
    .digest("hex");

export const exactPlanTurnRequest = (
  fixture: GoldenEvaluationCase,
  selectedConversation: readonly ExactProductionConversationBinding[],
  currentTimestamp: string,
): ProviderRequest => ({
  requestClass: "fast",
  model: "glm-5-turbo",
  messages: [
    { role: "system", content: PlanTurnPrompt },
    {
      role: "user",
      content: JSON.stringify({
        currentMessage: fixture.currentMessage,
        entries: exactProductionConversation(fixture, selectedConversation),
        locale: fixture.locale,
        market: fixture.market,
        currentTimestamp,
      }),
    },
  ],
  tools: [
    {
      name: "emit_plan_turn",
      description: "Emit the validated plan-turn result.",
      parameters: z.toJSONSchema(PlanTurnProviderSchema),
    },
  ],
  toolChoice: "auto",
  requestedOutputTokens: 2048,
  reasoning: "medium",
});

export const attestExactPlanTurnRequest = (
  fixture: GoldenEvaluationCase,
  selectedConversation: readonly ExactProductionConversationBinding[],
  currentTimestamp: string,
): {
  readonly inputTokens: number;
  readonly usableInputTokens: number;
  readonly requestSha256Hex: string;
} => {
  const request = exactPlanTurnRequest(fixture, selectedConversation, currentTimestamp);
  const model = resolveRegisteredModel(request.model);
  return {
    inputTokens: model.countRequestTokens(request),
    usableInputTokens: Math.min(100_000, model.contextWindow - request.requestedOutputTokens),
    requestSha256Hex: productionRequestSha256Hex(request),
  };
};

const canonicalRequestTokenCache = new Map<string, number>();

const canonicalEvaluationRequest = (
  fixture: GoldenEvaluationCase,
  selections: readonly CanonicalEvaluationSourceSelection[],
  options: {
    readonly productionSourceKeys?: ReadonlyMap<string, string> | undefined;
    readonly question?: string | undefined;
    readonly selectedTurnIds?: readonly string[] | undefined;
  } = {},
): ProviderRequest => {
  const bySourceId = new Map(selections.map((selection) => [selection.sourceId, selection]));
  const selectedEvidence = fixture.evidence.flatMap((source) => {
    const selection = bySourceId.get(source.sourceId);
    if (selection === undefined) return [];
    const ranges = [...selection.ranges].sort(
      (left, right) => left.charStart - right.charStart || left.charEnd - right.charEnd,
    );
    if (source.kind !== "document" && ranges.length > 0) {
      throw new EvaluationInputError(
        `${fixture.id}/${source.sourceId} gives ranges to non-document evidence`,
      );
    }
    // The production transport pads short document bodies to its minimum
    // evidence width. Apply the same canonicalization when validating a live
    // capture so storage-backed ranges and fixture-backed scoring agree.
    const canonicalSourceContent =
      source.kind === "memory"
        ? source.content.trim()
        : source.kind === "document" && source.content.length < 100
          ? source.content.padEnd(100, " ")
          : source.content;
    if (
      ranges.some(
        (range) =>
          range.charStart < 0 ||
          range.charEnd <= range.charStart ||
          range.charEnd > canonicalSourceContent.length,
      )
    ) {
      throw new EvaluationInputError(
        `${fixture.id}/${source.sourceId} has an out-of-bounds evaluation range`,
      );
    }
    const content =
      source.kind === "document" && ranges.length > 0
        ? ranges
            .map((range) => canonicalSourceContent.slice(range.charStart, range.charEnd))
            .join("\n…\n")
        : canonicalSourceContent;
    const productionSourceKey = options.productionSourceKeys?.get(source.sourceId);
    if (options.productionSourceKeys !== undefined && productionSourceKey === undefined) {
      throw new EvaluationInputError(
        `${fixture.id} lacks a production source key for ${source.sourceId}`,
      );
    }
    const productionLabel =
      source.kind === "document"
        ? `Canonical evidence ${source.sourceId}`
        : source.kind === "web"
          ? `Canonical golden web evidence ${fixture.id}`
          : null;
    return [
      serializeAnswerSource({
        key: productionSourceKey ?? source.sourceId,
        kind: source.kind,
        label:
          options.productionSourceKeys === undefined || productionLabel === null
            ? null
            : productionLabel,
        text: content,
      }),
    ];
  });
  if (selectedEvidence.length !== selections.length) {
    const known = new Set(fixture.evidence.map((source) => source.sourceId));
    const unknown = selections.find((selection) => !known.has(selection.sourceId));
    throw new EvaluationInputError(
      `${fixture.id} has unknown evaluation source ${unknown?.sourceId ?? "unknown"}`,
    );
  }
  const selectedTurns = new Set(options.selectedTurnIds ?? fixture.labels.relevantTurnIds);
  const selectedConversation = fixture.conversation
    .filter((entry) => selectedTurns.has(entry.turnId))
    .map((entry) => ({
      turnId: entry.turnId,
      userMessageId: `${entry.turnId}:user`,
      userContent: entry.userContent,
      assistantMessageId: `${entry.turnId}:assistant`,
      assistantContent: entry.assistantContent,
    }));
  const question =
    options.question ??
    (fixture.labels.planTurn.mode === "clarify"
      ? fixture.currentMessage
      : fixture.labels.planTurn.question);
  return {
    requestClass: "main",
    model: CanonicalEvaluationTokenGate.modelId,
    messages: [
      { role: "system", content: DirectAnswerPrompt },
      {
        role: "user",
        content: JSON.stringify({
          locale: fixture.locale,
          originalMessage: fixture.currentMessage,
          question,
          selectedConversation,
          evidence: selectedEvidence.join("\n\n"),
          gaps: fixture.labels.expectedGaps.map((gap) => gap.description),
        }),
      },
    ],
    requestedOutputTokens: CanonicalEvaluationTokenGate.outputTokens,
    reasoning: "medium",
  };
};

const exactProductionConversation = (
  fixture: GoldenEvaluationCase,
  bindings: readonly ExactProductionConversationBinding[],
) => {
  const fixtureById = new Map(fixture.conversation.map((entry) => [entry.turnId, entry] as const));
  if (
    new Set(bindings.map((binding) => binding.fixtureTurnId)).size !== bindings.length ||
    new Set(bindings.map((binding) => binding.turnId)).size !== bindings.length
  ) {
    throw new EvaluationInputError(`${fixture.id} production conversation bindings are not unique`);
  }
  return bindings.map((binding) => {
    const entry = fixtureById.get(binding.fixtureTurnId);
    if (entry === undefined) {
      throw new EvaluationInputError(
        `${fixture.id} has unknown production turn ${binding.fixtureTurnId}`,
      );
    }
    return binding.kind === "complete"
      ? {
          turnId: binding.turnId,
          userMessageId: binding.userMessageId,
          userContent: entry.userContent,
          assistantMessageId: binding.assistantMessageId,
          assistantContent: entry.assistantContent,
        }
      : {
          turnId: binding.turnId,
          userMessageId: binding.userMessageId,
          userContent: entry.userContent,
          errorCode: binding.errorCode,
          retryable: binding.retryable,
        };
  });
};

const exactProductionEvidence = (
  fixture: GoldenEvaluationCase,
  bindings: readonly ExactProductionSourceBinding[],
): string => {
  const fixtureById = new Map(fixture.evidence.map((source) => [source.sourceId, source] as const));
  const sourceIds = new Set<string>();
  const sourceKeys = new Set<string>();
  for (const binding of bindings) {
    if (sourceKeys.has(binding.sourceKey)) {
      throw new EvaluationInputError(`${fixture.id} production source bindings are not bijective`);
    }
    sourceKeys.add(binding.sourceKey);
    if (sourceIds.has(binding.sourceId)) {
      const source = fixtureById.get(binding.sourceId);
      if (source?.kind !== "web" || binding.contentOverride === undefined) {
        throw new EvaluationInputError(
          `${fixture.id} production source bindings are not bijective`,
        );
      }
    }
    sourceIds.add(binding.sourceId);
  }
  return bindings
    .map((binding) => {
      const source = fixtureById.get(binding.sourceId);
      if (source === undefined) {
        throw new EvaluationInputError(
          `${fixture.id} has unknown production source ${binding.sourceId}`,
        );
      }
      if (source.kind !== binding.kind) {
        throw new EvaluationInputError(
          `${fixture.id}/${binding.sourceId} production kind differs from the fixture`,
        );
      }
      if (source.kind !== "document" && binding.ranges.length > 0) {
        throw new EvaluationInputError(
          `${fixture.id}/${binding.sourceId} gives ranges to non-document evidence`,
        );
      }
      const sourceContent =
        binding.contentOverride ??
        (source.kind === "memory"
          ? source.content.trim()
          : source.kind === "document" && source.content.length < 100
            ? source.content.padEnd(100, " ")
            : source.content);
      if (
        binding.ranges.some(
          (range) =>
            range.charEnd <= range.charStart ||
            range.charStart < 0 ||
            range.charEnd > sourceContent.length,
        )
      ) {
        throw new EvaluationInputError(
          `${fixture.id}/${binding.sourceId} has an invalid production range`,
        );
      }
      for (let index = 1; index < binding.ranges.length; index += 1) {
        const previous = binding.ranges[index - 1]!;
        const current = binding.ranges[index]!;
        if (current.charStart < previous.charEnd) {
          throw new EvaluationInputError(
            `${fixture.id}/${binding.sourceId} production ranges are not normalized`,
          );
        }
      }
      const text =
        source.kind === "document" && binding.ranges.length > 0
          ? binding.ranges
              .map((range) => sourceContent.slice(range.charStart, range.charEnd))
              .join("\n…\n")
          : sourceContent;
      return serializeAnswerSource({
        key: binding.sourceKey,
        kind: source.kind,
        label: binding.label,
        text,
      });
    })
    .join("\n\n");
};

export const exactProductionContextRequest = (
  fixture: GoldenEvaluationCase,
  input: ExactProductionContextInput,
): ProviderRequest => {
  const selectedConversation = exactProductionConversation(fixture, input.selectedConversation);
  if (input.requestKind === "synthesis") {
    return {
      requestClass: "main",
      model: CanonicalEvaluationTokenGate.modelId,
      messages: [
        { role: "system", content: SynthesisPrompt },
        {
          role: "user",
          content: JSON.stringify({
            locale: fixture.locale,
            originalMessage: fixture.currentMessage,
            selectedConversation,
            packets: input.packets,
          }),
        },
      ],
      requestedOutputTokens: input.requestedOutputTokens,
      reasoning: "medium",
    };
  }
  const user = JSON.stringify({
    locale: fixture.locale,
    originalMessage: fixture.currentMessage,
    question: input.question,
    ...(input.requestKind === "topic" ? { topicId: input.topicId } : {}),
    selectedConversation,
    evidence: exactProductionEvidence(fixture, input.sources),
    gaps: input.gaps,
  });
  if (input.requestKind === "direct") {
    return {
      requestClass: "main",
      model: CanonicalEvaluationTokenGate.modelId,
      messages: [
        { role: "system", content: DirectAnswerPrompt },
        { role: "user", content: user },
      ],
      requestedOutputTokens: input.requestedOutputTokens,
      reasoning: "medium",
    };
  }
  return {
    requestClass: "main",
    model: CanonicalEvaluationTokenGate.modelId,
    messages: [
      { role: "system", content: TopicAnswerPrompt },
      { role: "user", content: user },
    ],
    tools: [
      {
        name: "emit_topic_packet",
        description: "Emit a grounded topic packet.",
        parameters: z.toJSONSchema(TopicPacketSchema),
      },
    ],
    toolChoice: "auto",
    requestedOutputTokens: input.requestedOutputTokens,
    reasoning: "medium",
  };
};

export const measureExactProductionContextMarginals = (
  fixture: GoldenEvaluationCase,
  input: ExactProductionContextInput,
): {
  readonly inputTokens: number;
  readonly requestSha256Hex: string;
  readonly conversationTokenCounts: readonly number[];
  readonly sourceTokenCounts: readonly number[];
} => {
  const request = exactProductionContextRequest(fixture, input);
  const model = resolveRegisteredModel(request.model);
  if (input.requestKind === "synthesis") {
    return {
      inputTokens: model.countRequestTokens(request),
      requestSha256Hex: productionRequestSha256Hex(request),
      conversationTokenCounts: [],
      sourceTokenCounts: [],
    };
  }
  const buildRequest = (
    selectedConversation: typeof input.selectedConversation,
    sources: typeof input.sources,
  ): ProviderRequest =>
    exactProductionContextRequest(
      fixture,
      input.requestKind === "topic"
        ? { ...input, selectedConversation, sources }
        : { ...input, selectedConversation, sources },
    );
  let priorTokens = model.countRequestTokens(buildRequest([], []));
  const conversationTokenCounts = input.selectedConversation.map((_entry, index) => {
    const nextTokens = model.countRequestTokens(
      buildRequest(input.selectedConversation.slice(0, index + 1), []),
    );
    const marginal = nextTokens - priorTokens;
    priorTokens = nextTokens;
    return marginal;
  });
  const sourceTokenCounts = input.sources.map((_source, index) => {
    const nextTokens = model.countRequestTokens(
      buildRequest(input.selectedConversation, input.sources.slice(0, index + 1)),
    );
    const marginal = nextTokens - priorTokens;
    priorTokens = nextTokens;
    return marginal;
  });
  const inputTokens = model.countRequestTokens(request);
  if (
    priorTokens !== inputTokens ||
    conversationTokenCounts.some((count) => count < 0) ||
    sourceTokenCounts.some((count) => count < 0)
  ) {
    throw new EvaluationInputError(
      `${fixture.id} production marginal token accounting is inconsistent`,
    );
  }
  return {
    inputTokens,
    requestSha256Hex: productionRequestSha256Hex(request),
    conversationTokenCounts,
    sourceTokenCounts,
  };
};

export const attestExactProductionContext = (
  fixture: GoldenEvaluationCase,
  input: ExactProductionContextInput,
): { readonly inputTokens: number; readonly requestSha256Hex: string } => {
  const measured = measureExactProductionContextMarginals(fixture, input);
  return {
    inputTokens: measured.inputTokens,
    requestSha256Hex: measured.requestSha256Hex,
  };
};

/** Exact pinned-tokenizer count for the canonical evaluation request reconstructed from a fixture. */
export const measureCanonicalEvaluationRequestTokens = (
  fixture: GoldenEvaluationCase,
  selections: readonly CanonicalEvaluationSourceSelection[],
): number => {
  if (new Set(selections.map((selection) => selection.sourceId)).size !== selections.length) {
    throw new EvaluationInputError(`${fixture.id} has duplicate evaluation source selections`);
  }
  const request = canonicalEvaluationRequest(fixture, selections);
  const serialized = JSON.stringify(request);
  const cacheKey = createHash("sha256").update(serialized).digest("hex");
  const cached = canonicalRequestTokenCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const measured = resolveRegisteredModel(request.model).countRequestTokens(request);
  canonicalRequestTokenCache.set(cacheKey, measured);
  return measured;
};

/** Reconstructs the exact production source framing for a specialized captured request. */
export const measureCanonicalProductionEvaluationRequestTokens = (
  fixture: GoldenEvaluationCase,
  selections: readonly CanonicalEvaluationSourceSelection[],
  sourceKeys: readonly { readonly sourceId: string; readonly sourceKey: string }[],
  options: {
    readonly question: string;
    readonly selectedTurnIds: readonly string[];
  },
): number => {
  if (
    new Set(sourceKeys.map((entry) => entry.sourceId)).size !== sourceKeys.length ||
    new Set(sourceKeys.map((entry) => entry.sourceKey)).size !== sourceKeys.length
  ) {
    throw new EvaluationInputError(`${fixture.id} has duplicate production source-key bindings`);
  }
  const bySourceId = new Map(sourceKeys.map((entry) => [entry.sourceId, entry.sourceKey] as const));
  if (selections.some((selection) => !bySourceId.has(selection.sourceId))) {
    throw new EvaluationInputError(`${fixture.id} production source-key bindings are incomplete`);
  }
  const request = canonicalEvaluationRequest(fixture, selections, {
    productionSourceKeys: bySourceId,
    question: options.question,
    selectedTurnIds: options.selectedTurnIds,
  });
  return resolveRegisteredModel(request.model).countRequestTokens(request);
};

export const canonicalEvaluationUsableInputTokens = (): number => {
  const model = resolveRegisteredModel(CanonicalEvaluationTokenGate.modelId);
  return usableInputTokens(
    model,
    {
      inputTokens: CanonicalEvaluationTokenGate.inputTokens,
      outputTokens: CanonicalEvaluationTokenGate.outputTokens,
    },
    CanonicalEvaluationTokenGate.outputTokens,
  );
};

export const EvaluationGateThresholds = {
  conversationTurnSelectionF1: 1,
  planQuestionFidelity: 0.85,
  clarificationPrecision: 1,
  clarificationRecall: 1,
  fanoutPrecision: 1,
  requiredFanoutRecall: 1,
  falseDecompositionRate: 0,
  selectorRecall: 0.9,
  selectorPrecision: 0.9,
  promptCountParity: 1,
  retrievalCoverage: 1,
  retrievalProvenance: 1,
  compactionPlanValidity: 1,
  compactionConvergence: 1,
  compactionCoverage: 1,
  compactionRangeValidity: 1,
  compactionTokenReduction: 0.1,
  factualSupport: 1,
  supportedClaimRecall: 0.8,
  citationCorrectness: 1,
  expectedGapRecall: 1,
  memoryProposalPrecision: 1,
  memoryProposalRecall: 1,
  memoryUpdateCorrectness: 1,
  pullToSerializedEfficiency: 0.2,
  serializedToCitedEfficiency: 0.5,
  maximumSourceDefects: 0,
  maximumTimeToFirstTokenP95Ms: 120_000,
  maximumTimeToTerminalP95Ms: 300_000,
  fanoutMinimumQualityRatio: 1,
  fanoutMaximumTerminalLatencyRatio: 1.5,
  fanoutMaximumTokenCostRatio: 2,
  baselineMaximumQualityRegression: 0,
  baselineMinimumContextEfficiencyImprovement: 0.05,
  baselineMinimumAnswerQualityImprovement: 0.02,
  baselineMinimumGroundingImprovement: 0.02,
  baselineMinimumTerminalLatencyImprovement: 0.05,
} as const;

export type EvaluationMetricName =
  | "conversation.turn_selection_f1"
  | "conversation.plan_question_fidelity"
  | "conversation.clarification_precision"
  | "conversation.clarification_recall"
  | "planner.fanout_precision"
  | "planner.required_fanout_recall"
  | "planner.false_decomposition_rate"
  | "selector.A.recall"
  | "selector.A.precision"
  | "selector.B.recall"
  | "selector.B.precision"
  | "selector.W.recall"
  | "selector.W.precision"
  | "prompt.exact_count_parity"
  | "retrieval.coverage"
  | "retrieval.provenance"
  | "compaction.plan_validity"
  | "compaction.convergence"
  | "compaction.coverage"
  | "compaction.range_validity"
  | "compaction.token_reduction"
  | "answer.factual_support"
  | "answer.supported_claim_recall"
  | "answer.citation_correctness"
  | "answer.expected_gap_recall"
  | "memory.proposal_precision"
  | "memory.proposal_recall"
  | "memory.update_correctness"
  | "efficiency.pull_to_serialized"
  | "efficiency.serialized_to_cited"
  | "source.defect_count"
  | "baseline.source_defect_count"
  | "latency.time_to_first_token_p95_ms"
  | "latency.time_to_terminal_p95_ms"
  | "fanout.quality_ratio"
  | "fanout.terminal_latency_ratio"
  | "fanout.token_cost_ratio"
  | "baseline.answer_quality_delta"
  | "baseline.grounding_delta"
  | "baseline.context_efficiency_improvement"
  | "baseline.terminal_latency_improvement"
  | "baseline.topology_justified";

export interface EvaluationGate {
  readonly metric: EvaluationMetricName;
  readonly actual: number;
  readonly comparator: ">=" | "<=" | "=";
  readonly threshold: number;
  readonly passed: boolean;
}

export interface EvaluationReport {
  readonly goldenSetVersion: 4;
  readonly caseCount: number;
  readonly specializedRunIds: readonly string[];
  readonly baselineRunIds: readonly string[];
  readonly metrics: Readonly<Record<EvaluationMetricName, number>>;
  readonly gates: readonly EvaluationGate[];
  readonly passed: boolean;
}

export class EvaluationInputError extends Error {
  readonly name = "EvaluationInputError";
}

interface AnswerScore {
  readonly factualSupport: number;
  readonly claimRecall: number;
  readonly citationCorrectness: number;
  readonly gapRecall: number;
  readonly gapPrecision: number;
  readonly quality: number;
  readonly grounding: number;
  readonly defects: number;
}

interface EvaluationOptions {
  readonly allowSyntheticCaptures?: boolean;
}

const ratio = (numerator: number, denominator: number, empty = 1): number =>
  denominator === 0 ? empty : numerator / denominator;

const f1 = (precisionValue: number, recallValue: number): number =>
  precisionValue + recallValue === 0
    ? 0
    : (2 * precisionValue * recallValue) / (precisionValue + recallValue);

const mean = (values: readonly number[], empty = 1): number =>
  values.length === 0 ? empty : values.reduce((sum, value) => sum + value, 0) / values.length;

const percentile = (values: readonly number[], quantile: number): number => {
  if (values.length === 0) throw new EvaluationInputError("cannot percentile an empty sample");
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(quantile * ordered.length) - 1);
  return ordered[index] ?? 0;
};

const normalize = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/\p{Mark}/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim();

const tokens = (value: string): ReadonlySet<string> =>
  new Set(
    normalize(value)
      .split(" ")
      .filter((token) => token !== ""),
  );

const tokenF1 = (actual: string, expected: string): number => {
  const actualTokens = tokens(actual);
  const expectedTokens = tokens(expected);
  let intersection = 0;
  for (const token of actualTokens) {
    if (expectedTokens.has(token)) intersection += 1;
  }
  return f1(ratio(intersection, actualTokens.size, 0), ratio(intersection, expectedTokens.size, 0));
};

const termGroupCoverage = (actual: string, groups: readonly (readonly string[])[]): number => {
  const normalized = ` ${normalize(actual)} `;
  const matched = groups.filter((group) =>
    group.some((alternative) => normalized.includes(` ${normalize(alternative)} `)),
  ).length;
  return ratio(matched, groups.length);
};

const setIntersectionCount = (left: ReadonlySet<string>, right: ReadonlySet<string>): number => {
  let count = 0;
  for (const value of left) {
    if (right.has(value)) count += 1;
  }
  return count;
};

const sameStringSet = (left: readonly string[], right: readonly string[]): boolean => {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
};

const sameUniqueStringSet = (left: readonly string[], right: readonly string[]): boolean =>
  new Set(left).size === left.length &&
  new Set(right).size === right.length &&
  sameStringSet(left, right);

const fanoutMatchesGoldenTopics = (
  fixture: GoldenEvaluationCase,
  plan: Extract<SpecializedEvaluationResult["planTurn"], { mode: "fanout" }>,
): boolean => {
  if (fixture.labels.planTurn.mode !== "fanout") return false;
  const expected = fixture.labels.planTurn.topics;
  if (plan.topics.length !== expected.length) return false;
  return plan.topics.every((topic, index) => {
    const golden = expected[index];
    return (
      golden !== undefined &&
      topic.topicId === golden.topicId &&
      topic.question === golden.question &&
      sameUniqueStringSet(topic.relevantTurnIds, golden.relevantTurnIds)
    );
  });
};

const rangeIsCovered = (
  selected: EvaluationRange,
  acceptable: readonly EvaluationRange[],
): boolean => {
  const ordered = [...acceptable].sort((left, right) => left.charStart - right.charStart);
  let cursor = selected.charStart;
  for (const range of ordered) {
    if (range.charEnd <= cursor) continue;
    if (range.charStart > cursor) return false;
    cursor = Math.max(cursor, range.charEnd);
    if (cursor >= selected.charEnd) return true;
  }
  return false;
};

const memoryProposalKey = (proposal: {
  readonly action: "create" | "update";
  readonly kind: string;
  readonly content: string;
  readonly targetMemoryId: string | null;
  readonly expectedHeadRevisionId: string | null;
}): string =>
  JSON.stringify([
    proposal.action,
    proposal.kind,
    proposal.content.trim(),
    proposal.targetMemoryId,
    proposal.expectedHeadRevisionId,
  ]);

const indexExactResults = <T extends { readonly caseId: string }>(
  fixtures: readonly GoldenEvaluationCase[],
  results: readonly T[],
  label: string,
): ReadonlyMap<string, T> => {
  const expectedIds = new Set(fixtures.map((fixture) => fixture.id));
  const indexed = new Map<string, T>();
  for (const result of results) {
    if (!expectedIds.has(result.caseId)) {
      throw new EvaluationInputError(`${label} contains unknown case ${result.caseId}`);
    }
    if (indexed.has(result.caseId)) {
      throw new EvaluationInputError(`${label} contains duplicate case ${result.caseId}`);
    }
    indexed.set(result.caseId, result);
  }
  for (const fixture of fixtures) {
    if (!indexed.has(fixture.id)) {
      throw new EvaluationInputError(`${label} is missing case ${fixture.id}`);
    }
  }
  return indexed;
};

const assertCapturePosture = (
  results: readonly (SpecializedEvaluationResult | GeneralPlannerEvaluationResult)[],
  allowSynthetic: boolean,
): void => {
  const runIds = new Set<string>();
  for (const result of results) {
    if (runIds.has(result.capture.runId)) {
      throw new EvaluationInputError(`run ${result.capture.runId} is reused across cases`);
    }
    runIds.add(result.capture.runId);
    if (!allowSynthetic && result.capture.origin !== "real_provider_turn") {
      throw new EvaluationInputError(
        `${result.topology}/${result.caseId} is not a real-provider turn`,
      );
    }
    if (
      result.capture.origin === "real_provider_turn" &&
      result.capture.attestation.topology !== result.topology
    ) {
      throw new EvaluationInputError(
        `${result.topology}/${result.caseId} has an attestation for ${result.capture.attestation.topology}`,
      );
    }
    if (Date.parse(result.capture.finishedAt) <= Date.parse(result.capture.startedAt)) {
      throw new EvaluationInputError(
        `${result.topology}/${result.caseId} has a non-positive capture duration`,
      );
    }
    if (result.usage.totalTokens !== result.usage.inputTokens + result.usage.outputTokens) {
      throw new EvaluationInputError(
        `${result.topology}/${result.caseId} has inconsistent aggregate token usage`,
      );
    }
    const measurementIds = result.promptMeasurements.map((measurement) => measurement.requestId);
    if (new Set(measurementIds).size !== measurementIds.length) {
      throw new EvaluationInputError(
        `${result.topology}/${result.caseId} has duplicate provider measurements`,
      );
    }
    if (result.promptMeasurements.length !== result.usage.providerRequestCount) {
      throw new EvaluationInputError(
        `${result.topology}/${result.caseId} does not account for every provider request`,
      );
    }
    const auditIds = result.sourceAudit.map((audit) => audit.sourceId);
    if (new Set(auditIds).size !== auditIds.length) {
      throw new EvaluationInputError(
        `${result.topology}/${result.caseId} has duplicate source-audit rows`,
      );
    }
    const elapsedMs = Date.parse(result.capture.finishedAt) - Date.parse(result.capture.startedAt);
    if (result.timing.timeToTerminalMs > elapsedMs) {
      throw new EvaluationInputError(
        `${result.topology}/${result.caseId} reports terminal completion after its capture`,
      );
    }
    const claimIds = result.answer.claims.map((claim) => claim.claimId);
    if (new Set(claimIds).size !== claimIds.length) {
      throw new EvaluationInputError(
        `${result.topology}/${result.caseId} has duplicate claim annotations`,
      );
    }
    const memoryKeys = result.memoryProposals.map(memoryProposalKey);
    if (new Set(memoryKeys).size !== memoryKeys.length) {
      throw new EvaluationInputError(
        `${result.topology}/${result.caseId} has duplicate memory proposals`,
      );
    }
  }
};

const scoreAnswer = (
  fixture: GoldenEvaluationCase,
  result: SpecializedEvaluationResult | GeneralPlannerEvaluationResult,
): AnswerScore => {
  const expectedClaims = new Map(
    fixture.labels.supportedClaims.map((claim) => [claim.claimId, claim] as const),
  );
  const serialized = new Set(result.serializedSourceIds);
  const audit = new Map(result.sourceAudit.map((entry) => [entry.sourceId, entry] as const));
  let supportedClaims = 0;
  let citationCorrectClaims = 0;
  let defects = result.answer.citationDefectCount;
  const observedClaimIds = new Set<string>();
  const annotatedCitationIds = new Set<string>();

  for (const claim of result.answer.claims) {
    observedClaimIds.add(claim.claimId);
    const expected = expectedClaims.get(claim.claimId);
    const supporting = new Set(expected?.supportingSourceIds ?? []);
    const citations = new Set(claim.citedSourceIds);
    for (const sourceId of citations) annotatedCitationIds.add(sourceId);
    const hasSupportingCitation = setIntersectionCount(citations, supporting) > 0;
    const noContradictoryCitation = [...citations].every((sourceId) => supporting.has(sourceId));
    if (expected !== undefined && hasSupportingCitation && noContradictoryCitation) {
      supportedClaims += 1;
    }

    const claimCitationsValid =
      expected !== undefined &&
      citations.size > 0 &&
      [...citations].every((sourceId) => {
        const sourceAudit = audit.get(sourceId);
        return (
          supporting.has(sourceId) &&
          serialized.has(sourceId) &&
          sourceAudit?.authorized === true &&
          sourceAudit.resolvable
        );
      });
    if (claimCitationsValid) citationCorrectClaims += 1;
  }

  const answerCitationIds = new Set(result.answer.citationSourceIds);
  if (!sameStringSet([...answerCitationIds], [...annotatedCitationIds])) defects += 1;
  if (result.answer.rawCitationTagCount < answerCitationIds.size) defects += 1;
  for (const sourceId of result.answer.citationSourceIds) {
    const sourceAudit = audit.get(sourceId);
    if (!serialized.has(sourceId)) defects += 1;
    if (sourceAudit?.authorized !== true) defects += 1;
    if (sourceAudit?.resolvable !== true) defects += 1;
  }
  const expectedGapIds = fixture.labels.expectedGaps.map((gap) => gap.gapId);
  const reportedGapIds = result.answer.reportedGapIds;
  const expectedGapSet = new Set(expectedGapIds);
  const correctGaps = reportedGapIds.filter((gapId) => expectedGapSet.has(gapId)).length;
  const predictedClaimCount = result.answer.claims.length;
  const factualSupport = ratio(
    supportedClaims,
    predictedClaimCount,
    expectedClaims.size === 0 ? 1 : 0,
  );
  const claimRecall = ratio(
    [...observedClaimIds].filter((claimId) => expectedClaims.has(claimId)).length,
    expectedClaims.size,
  );
  const citationCorrectness = ratio(
    citationCorrectClaims,
    predictedClaimCount,
    expectedClaims.size === 0 ? 1 : 0,
  );
  const gapRecall = ratio(correctGaps, expectedGapIds.length);
  const gapPrecision = ratio(
    correctGaps,
    reportedGapIds.length,
    expectedGapIds.length === 0 ? 1 : 0,
  );
  const quality = mean([factualSupport, claimRecall, gapRecall, gapPrecision]);
  const grounding = defects === 0 ? citationCorrectness : 0;

  return {
    factualSupport,
    claimRecall,
    citationCorrectness,
    gapRecall,
    gapPrecision,
    quality,
    grounding,
    defects,
  };
};

const commonSourceStageDefects = (
  fixture: GoldenEvaluationCase,
  result: SpecializedEvaluationResult | GeneralPlannerEvaluationResult,
): number => {
  const knownSources = new Set(fixture.evidence.map((source) => source.sourceId));
  const audit = new Map(result.sourceAudit.map((source) => [source.sourceId, source] as const));
  const staged = new Set([
    ...result.pulledSourceIds,
    ...result.serializedSourceIds,
    ...result.answer.citationSourceIds,
  ]);
  let defects = [...staged].filter((sourceId) => !knownSources.has(sourceId)).length;
  defects += result.sourceAudit.filter((source) => !knownSources.has(source.sourceId)).length;
  for (const sourceId of result.pulledSourceIds) {
    const sourceAudit = audit.get(sourceId);
    if (sourceAudit?.authorized !== true || sourceAudit.resolvable !== true) defects += 1;
  }
  for (const sourceId of result.serializedSourceIds) {
    const sourceAudit = audit.get(sourceId);
    if (sourceAudit?.authorized !== true || sourceAudit.resolvable !== true) defects += 1;
    if (!result.pulledSourceIds.includes(sourceId)) defects += 1;
  }
  return defects;
};

const gateAtLeast = (
  metric: EvaluationMetricName,
  actual: number,
  threshold: number,
): EvaluationGate => ({ metric, actual, comparator: ">=", threshold, passed: actual >= threshold });

const gateAtMost = (
  metric: EvaluationMetricName,
  actual: number,
  threshold: number,
): EvaluationGate => ({ metric, actual, comparator: "<=", threshold, passed: actual <= threshold });

const gateEqual = (
  metric: EvaluationMetricName,
  actual: number,
  threshold: number,
): EvaluationGate => ({ metric, actual, comparator: "=", threshold, passed: actual === threshold });

type EvaluationResult = SpecializedEvaluationResult | GeneralPlannerEvaluationResult;
type ArtifactCoordinate = TaskCoordinate | ProviderCoordinate;

const usageCoordinateKey = (coordinate: ArtifactCoordinate): string =>
  [
    coordinate.taskId,
    coordinate.loopIteration,
    coordinate.attempt,
    "providerRequestIndex" in coordinate ? coordinate.providerRequestIndex : "",
  ].join(":");
const taskCoordinateKey = (coordinate: {
  readonly taskId: string;
  readonly loopIteration: number;
  readonly attempt: number;
}): string => `${coordinate.taskId}:${coordinate.loopIteration}:${coordinate.attempt}`;
const outputCoordinateKey = (coordinate: {
  readonly nodeId: string;
  readonly iteration: number;
}): string => `${coordinate.nodeId}:${coordinate.iteration}`;

const jsonEqual = (left: unknown, right: unknown): boolean =>
  JSON.stringify(canonicalValue(left)) === JSON.stringify(canonicalValue(right));

const artifactError = (
  topology: "specialized" | "general_planner",
  fixture: GoldenEvaluationCase,
  path: string,
  message: string,
): never => {
  throw new EvaluationInputError(`${topology}/${fixture.id} ${path}: ${message}`);
};

const sourceIdForIdentity = (identity: {
  readonly kind: string;
  readonly sourceId?: string;
  readonly messageId?: string;
  readonly memoryId?: string;
  readonly canonicalUrl?: string;
}): string | undefined =>
  identity.kind === "public_document" || identity.kind === "publisher_document"
    ? identity.sourceId
    : identity.kind === "chat_message"
      ? identity.messageId
      : identity.kind === "memory"
        ? identity.memoryId
        : identity.canonicalUrl;

const assertPreviewRecords = (
  fixture: GoldenEvaluationCase,
  result: EvaluationResult,
  preview: EvaluationResult["retrieval"]["previews"][number],
  review: EvaluationResult["retrieval"]["reviews"][number],
): void => {
  const model = resolveRegisteredModel("glm-5-turbo");
  for (const [index, record] of preview.records.entries()) {
    const reviewed = review.results[index];
    if (reviewed === undefined) {
      artifactError(
        result.topology,
        fixture,
        "retrieval.previews",
        `record ${index} lacks review result`,
      );
    }
    const previewText = reviewed!.preview;
    const previewBytes = new TextEncoder().encode(previewText);
    const previewByteLength = previewBytes.byteLength;
    const previewSha256Hex = createHash("sha256").update(previewBytes).digest("hex");
    const fastTokenCount = model.countTextTokens(previewText);
    const mainTokenCount = model.countTextTokens(previewText);
    if (
      record.previewByteLength !== previewByteLength ||
      record.previewSha256Hex !== previewSha256Hex ||
      record.fastTokenCount !== fastTokenCount ||
      record.mainTokenCount !== mainTokenCount
    ) {
      artifactError(
        result.topology,
        fixture,
        "retrieval.previews",
        `record ${index} preview source proof mismatch`,
      );
    }
    const sourceId = sourceIdForIdentity(record.identity);
    const source = fixture.evidence.find((candidate) => candidate.sourceId === sourceId);
    if (source !== undefined) {
      const sourceText =
        record.identity.kind === "chat_message"
          ? stripHistoricalCitationTags(source.content)
          : source.content;
      const reconstructed = record.previewRanges
        .map((range) => sourceText.slice(range.charStart, range.charEnd))
        .join(PREVIEW_RANGE_SEPARATOR);
      if (reconstructed !== previewText) {
        artifactError(
          result.topology,
          fixture,
          "retrieval.previews",
          `record ${index} preview text mismatch`,
        );
      }
    }
    const withoutDigest = {
      identity: record.identity,
      snapshotId: record.snapshotId,
      contentHash: record.contentHash,
      ...(record.publisherExtractionId === undefined
        ? {}
        : { publisherExtractionId: record.publisherExtractionId }),
      previewRanges: record.previewRanges,
      previewByteLength: record.previewByteLength,
      previewSha256Hex: record.previewSha256Hex,
      fastTokenCount: record.fastTokenCount,
      mainTokenCount: record.mainTokenCount,
    };
    const expected = createHash("sha256")
      .update(JSON.stringify(canonicalValue(withoutDigest)))
      .digest("hex");
    if (record.recordDigestSha256Hex !== expected) {
      artifactError(
        result.topology,
        fixture,
        "retrieval.previews",
        `record ${index} digest mismatch`,
      );
    }
  }
};

const assertRetrievalArtifacts = (
  fixture: GoldenEvaluationCase,
  result: EvaluationResult,
): { readonly coverage: number; readonly provenance: number } => {
  const retrieval = result.retrieval;
  const reviews = new Map(
    retrieval.reviews.map((row) => [taskCoordinateKey(row.coordinate), row] as const),
  );
  const previews = new Map(
    retrieval.previews.map((row) => [usageCoordinateKey(row.coordinate), row] as const),
  );
  const finals = new Map(
    retrieval.finalResults.map((row) => [outputCoordinateKey(row.outputCoordinate), row] as const),
  );
  let covered = 0;
  let provenance = 0;
  const required = new Set(
    fixture.labels.requiredSourceIds.filter((sourceId) =>
      fixture.evidence.some((source) => source.sourceId === sourceId && source.selector === "A"),
    ),
  );
  const observed = new Set<string>();

  for (const traceRow of retrieval.traces) {
    const trace = traceRow.trace;
    const review = reviews.get(taskCoordinateKey(traceRow.coordinate));
    const preview =
      review === undefined ? undefined : previews.get(usageCoordinateKey(review.coordinate));
    const final = finals.get(
      outputCoordinateKey({
        nodeId: traceRow.coordinate.taskId,
        iteration: traceRow.coordinate.loopIteration,
      }),
    );
    if (trace.review === null) {
      if (review !== undefined || preview !== undefined) {
        artifactError(result.topology, fixture, "retrieval", "skip trace has review artifacts");
      }
      continue;
    }
    if (review === undefined) {
      artifactError(result.topology, fixture, "retrieval", "review lacks exact review row");
    }
    if (preview === undefined) {
      artifactError(result.topology, fixture, "retrieval", "review lacks exact preview row");
    }
    const reviewRow = review!;
    const previewRow = preview!;
    if (reviewRow.inputSha256Hex !== previewRow.requestSha256Hex) {
      artifactError(
        result.topology,
        fixture,
        "retrieval",
        "review/preview request digest mismatch",
      );
    }
    if (!jsonEqual(reviewRow.decision, trace.review)) {
      artifactError(
        result.topology,
        fixture,
        "retrieval.review",
        "review decision differs from trace",
      );
    }
    if (
      !jsonEqual(reviewRow.branchCoverage, previewRow.coverage) ||
      !jsonEqual(reviewRow.truncation, previewRow.truncation)
    ) {
      artifactError(
        result.topology,
        fixture,
        "retrieval.review",
        "review coverage differs from preview",
      );
    }
    if (
      !jsonEqual(
        reviewRow.results.map(({ preview: _preview, ...row }) => row),
        previewRow.results,
      )
    ) {
      artifactError(
        result.topology,
        fixture,
        "retrieval.preview",
        "preview metadata differs from review",
      );
    }
    assertPreviewRecords(fixture, result, previewRow, reviewRow);
    if (trace.outcome === "no_evidence") {
      if (final === undefined || final.result !== null) {
        artifactError(
          result.topology,
          fixture,
          "retrieval.finalResults",
          "no-evidence result is not null",
        );
      }
      continue;
    }
    if (final === undefined || final.result === null) {
      artifactError(result.topology, fixture, "retrieval.finalResults", "trace lacks final result");
    }
    const finalRow = final!;
    const finalResult = finalRow.result!;
    if (finalResult.plan.action !== "search") {
      artifactError(
        result.topology,
        fixture,
        "retrieval.finalResults",
        "search trace has non-search final plan",
      );
    }
    const acceptedReview = trace.review.action === "accept";
    if (acceptedReview && !jsonEqual(finalResult.branchCoverage, reviewRow.branchCoverage)) {
      artifactError(
        result.topology,
        fixture,
        "retrieval.finalResults",
        "accepted final coverage differs from review",
      );
    }
    const searchPlan = finalResult.plan as Extract<
      typeof finalResult.plan,
      { readonly action: "search" }
    >;
    const queryCount = searchPlan.queries.length;
    const model = resolveRegisteredModel("glm-5-turbo");
    for (const candidate of finalResult.candidates) {
      const previewIndex = Number(candidate.resultId.slice(1)) - 1;
      const previewRecord = previewRow.records[previewIndex];
      if (
        acceptedReview &&
        (previewRecord === undefined ||
          !jsonEqual(previewRecord.identity, candidate.identity) ||
          !jsonEqual(previewRecord.previewRanges, candidate.previewRanges) ||
          previewRecord.previewSha256Hex !== candidate.previewSha256Hex ||
          previewRecord.fastTokenCount !== candidate.fastTokenCount ||
          previewRecord.mainTokenCount !== candidate.mainTokenCount)
      ) {
        artifactError(
          result.topology,
          fixture,
          "retrieval.finalResults",
          `${candidate.resultId} preview differs from durable preview`,
        );
      }
      const candidateSourceId = sourceIdForIdentity(candidate.identity);
      const candidateSource = fixture.evidence.find(
        (source) => source.sourceId === candidateSourceId,
      );
      if (candidateSource !== undefined) {
        const sourceText =
          candidate.identity.kind === "chat_message"
            ? stripHistoricalCitationTags(candidateSource.content)
            : candidateSource.content;
        const reconstructed = candidate.previewRanges
          .map((range) => sourceText.slice(range.charStart, range.charEnd))
          .join(PREVIEW_RANGE_SEPARATOR);
        if (reconstructed !== candidate.preview) {
          artifactError(
            result.topology,
            fixture,
            "retrieval.finalResults",
            `${candidate.resultId} preview text differs from fixture source`,
          );
        }
      }
      if (candidateSourceId !== undefined) observed.add(candidateSourceId);
      const previewBytes = new TextEncoder().encode(candidate.preview);
      if (
        candidate.previewSha256Hex !== createHash("sha256").update(previewBytes).digest("hex") ||
        candidate.fastTokenCount !== model.countTextTokens(candidate.preview) ||
        candidate.mainTokenCount !== model.countTextTokens(candidate.preview)
      ) {
        artifactError(
          result.topology,
          fixture,
          "retrieval.finalResults",
          `${candidate.resultId} preview proof mismatch`,
        );
      }
      const contributionKeys = new Set<string>();
      let expectedScore = 0;
      for (const entry of candidate.provenance) {
        if (entry.queryOrdinal < 1 || entry.queryOrdinal > queryCount) {
          artifactError(
            result.topology,
            fixture,
            "retrieval.finalResults",
            `${candidate.resultId} provenance query ordinal exceeds final plan`,
          );
        }
        if (
          !finalResult.branchCoverage.some(
            (branch) =>
              branch.queryOrdinal === entry.queryOrdinal && branch.branch === entry.branch,
          )
        ) {
          artifactError(
            result.topology,
            fixture,
            "retrieval.finalResults",
            `${candidate.resultId} provenance branch lacks coverage`,
          );
        }
        const rank = entry.logicalRank ?? entry.rank;
        const contributionKey = `${entry.queryOrdinal}\u0000${rank}`;
        if (!candidate.matchedQueryOrdinals.includes(entry.queryOrdinal)) {
          artifactError(
            result.topology,
            fixture,
            "retrieval.finalResults",
            "candidate provenance is incomplete",
          );
        }
        if (!contributionKeys.has(contributionKey)) {
          contributionKeys.add(contributionKey);
          expectedScore += reciprocalRankContribution(rank, candidate.rrfK);
        }
      }
      const expectedBestRank = Math.min(
        ...candidate.provenance.map((entry) => entry.logicalRank ?? entry.rank),
      );
      const expectedMatchedQueryOrdinals = [
        ...new Set(candidate.provenance.map((entry) => entry.queryOrdinal)),
      ].sort((left, right) => left - right);
      if (
        candidate.bestRank !== expectedBestRank ||
        !jsonEqual(candidate.matchedQueryOrdinals, expectedMatchedQueryOrdinals)
      ) {
        artifactError(
          result.topology,
          fixture,
          "retrieval.finalResults",
          `${candidate.resultId} rank/query ordinal summary mismatch`,
        );
      }
      const tolerance = Number.EPSILON * Math.max(1, expectedScore) * 8;
      if (Math.abs(candidate.score - expectedScore) > tolerance) {
        artifactError(
          result.topology,
          fixture,
          "retrieval.finalResults",
          `${candidate.resultId} score does not match provenance`,
        );
      }
      provenance += 1;
    }
    covered += finalResult.candidates.length > 0 ? 1 : 0;
  }
  for (const sourceId of required) {
    if (observed.has(sourceId)) covered += 1;
  }
  const coverage =
    required.size === 0
      ? 1
      : ratio([...required].filter((id) => observed.has(id)).length, required.size, 0);
  const provenanceScore = provenance === 0 ? (required.size === 0 ? 1 : 0) : 1;
  return { coverage, provenance: provenanceScore };
};

const candidateRangesForId = (
  context: EvaluationResult["compaction"]["contexts"][number],
  candidateId: string,
): readonly EvaluationRange[] => {
  const candidate = context.candidateLedger.find((row) => row.candidateId === candidateId);
  return candidate?.baseRanges ?? [];
};

const assertCompactionArtifacts = (
  fixture: GoldenEvaluationCase,
  result: EvaluationResult,
): {
  readonly planValidity: number;
  readonly convergence: number;
  readonly coverage: number;
  readonly rangeValidity: number;
  readonly tokenReduction: number;
} => {
  const compaction = result.compaction;
  const groups = new Map<string, (typeof compaction.groups)[number]>(
    compaction.groups.map(
      (row) =>
        [
          `${row.phase}:${outputCoordinateKey(row.outputCoordinate)}:${row.envelope.groupId}`,
          row,
        ] as const,
    ),
  );
  const contexts = new Map<string, (typeof compaction.contexts)[number]>(
    compaction.contexts.map(
      (row) => [`${row.stage}:${outputCoordinateKey(row.outputCoordinate)}`, row] as const,
    ),
  );
  if (contexts.size !== compaction.contexts.length) {
    artifactError(
      result.topology,
      fixture,
      "compaction.contexts",
      "duplicate context summary coordinate",
    );
  }
  const contextMeasurementKey = (taskId: string, iteration: number): string =>
    `${taskId}:${iteration}`;
  const contextMeasurements = new Map<string, (typeof compaction.measurements)[number][]>();
  for (const measurement of compaction.measurements) {
    const key = contextMeasurementKey(
      measurement.coordinate.taskId,
      measurement.coordinate.loopIteration,
    );
    const rows = contextMeasurements.get(key) ?? [];
    rows.push(measurement);
    contextMeasurements.set(key, rows);
  }
  const contextKeys = new Set(
    compaction.contexts.map((context) =>
      contextMeasurementKey(context.outputCoordinate.nodeId, context.outputCoordinate.iteration),
    ),
  );
  for (const [key] of contextMeasurements) {
    if (!contextKeys.has(key)) {
      artifactError(
        result.topology,
        fixture,
        "compaction.measurements",
        "orphan context measurement",
      );
    }
  }
  for (const context of compaction.contexts) {
    const key = contextMeasurementKey(
      context.outputCoordinate.nodeId,
      context.outputCoordinate.iteration,
    );
    const rows = contextMeasurements.get(key);
    if (rows === undefined || rows.length === 0) {
      artifactError(result.topology, fixture, "compaction.contexts", "orphan context summary");
    }
    const latest = rows!.reduce((current, candidate) =>
      candidate.coordinate.attempt > current.coordinate.attempt ? candidate : current,
    );
    if (
      latest.consumerTaskId !== context.consumerTaskId ||
      latest.topicId !== context.topicId ||
      latest.totalInputTokens !== context.inputTokens ||
      latest.status !== context.status ||
      latest.usableInputTokens !== context.usableInputTokens ||
      latest.compactionRan !== context.compactionRan
    ) {
      artifactError(
        result.topology,
        fixture,
        "compaction.contexts",
        `${context.outputCoordinate.nodeId} context summary differs from latest context measurement`,
      );
    }
  }
  const expectedGroupKeys = new Set<string>();
  const expectedContextKeys = new Set<string>();
  let valid = 0;
  let convergence = 1;
  let rangesValid = 1;
  let tokenReductions: number[] = [];
  const planPrefix = (nodeId: string, phase: "initial" | "fallback"): string => {
    const suffix = phase === "initial" ? "-compact-plan" : "-fallback-plan";
    return nodeId.endsWith(suffix)
      ? nodeId.slice(0, -suffix.length)
      : nodeId.replace(/-(?:compact|fallback)-plan$/u, "");
  };
  const matchedCollectKeys = new Set<string>();
  for (const plan of compaction.plans) {
    const manifestCompactIds = plan.manifest.decisions.flatMap((decision) =>
      "groupId" in decision && (decision.action === "compact" || decision.action === "tighten")
        ? [decision.candidateId]
        : [],
    );
    const groupCandidateIds = plan.groups.flatMap((group) => group.candidateIds);
    if (!sameUniqueStringSet(manifestCompactIds, groupCandidateIds)) {
      artifactError(
        result.topology,
        fixture,
        "compaction.plans",
        "manifest compact candidates do not exactly match group candidate union",
      );
    }
    const groupIds = new Set(plan.groups.map((group) => group.groupId));
    if (groupIds.size !== plan.groups.length) {
      artifactError(result.topology, fixture, "compaction.plans", "duplicate group IDs");
    }
    for (const [groupIndex, group] of plan.groups.entries()) {
      const phase = plan.phase === "initial" ? "compact" : "fallback";
      const suffix = `-${phase}-plan`;
      const prefix = plan.outputCoordinate.nodeId.endsWith(suffix)
        ? plan.outputCoordinate.nodeId.slice(0, -suffix.length)
        : plan.outputCoordinate.nodeId.replace(/-plan$/u, "");
      const expectedNodeId = compactionGroupTaskId(prefix, phase, groupIndex + 1);
      const expectedKey = `${plan.phase}:${expectedNodeId}:${plan.outputCoordinate.iteration}:${group.groupId}`;
      expectedGroupKeys.add(expectedKey);
      const row = groups.get(expectedKey);
      if (row === undefined) {
        artifactError(
          result.topology,
          fixture,
          "compaction.groups",
          `missing result for ${group.groupId}`,
        );
        continue;
      }
      const groupRow = row!;
      if (groupRow.envelope.renderedTokenCount > group.renderedTokenBudget) {
        artifactError(
          result.topology,
          fixture,
          "compaction.groups",
          `${group.groupId} exceeds budget`,
        );
      }
      const decisionIds = groupRow.envelope.result.decisions.map(
        (decision) => decision.candidateId,
      );
      if (!sameStringSet(decisionIds, group.candidateIds)) {
        artifactError(
          result.topology,
          fixture,
          "compaction.groups",
          `${group.groupId} decisions mismatch`,
        );
      }
    }
    const prefix = planPrefix(plan.outputCoordinate.nodeId, plan.phase);
    const collectNodeId = `${prefix}-${plan.phase === "initial" ? "compact" : "fallback"}-collect`;
    const matchingCollects = compaction.collects.filter(
      (collect) =>
        collect.phase === plan.phase &&
        collect.outputCoordinate.nodeId === collectNodeId &&
        collect.outputCoordinate.iteration === plan.outputCoordinate.iteration,
    );
    if (matchingCollects.length !== 1) {
      artifactError(
        result.topology,
        fixture,
        "compaction.collects",
        `${plan.phase} plan lacks exactly one collect`,
      );
    } else {
      const collect = matchingCollects[0]!;
      matchedCollectKeys.add(`${collect.phase}:${outputCoordinateKey(collect.outputCoordinate)}`);
      const expectedTaskIds = plan.groups.map((_, index) =>
        compactionGroupTaskId(prefix, plan.phase === "initial" ? "compact" : "fallback", index + 1),
      );
      const expectedEnvelopes = plan.groups.map((group, index) => {
        const groupTaskId = compactionGroupTaskId(
          prefix,
          plan.phase === "initial" ? "compact" : "fallback",
          index + 1,
        );
        const groupRow = groups.get(
          `${plan.phase}:${groupTaskId}:${plan.outputCoordinate.iteration}:${group.groupId}`,
        );
        return groupRow?.envelope;
      });
      if (
        !sameUniqueStringSet(collect.taskIds, expectedTaskIds) ||
        !jsonEqual(collect.groups, plan.groups) ||
        expectedEnvelopes.some((envelope) => envelope === undefined) ||
        !jsonEqual(collect.envelopes, expectedEnvelopes)
      ) {
        artifactError(
          result.topology,
          fixture,
          "compaction.collects",
          `${plan.phase} collect does not match plan groups`,
        );
      }
      const manifestDecisions = new Map(
        plan.manifest.decisions.map((decision) => [decision.candidateId, decision] as const),
      );
      if (
        !sameUniqueStringSet(
          collect.selections.map((selection) => selection.candidateId),
          plan.manifest.decisions.map((decision) => decision.candidateId),
        )
      ) {
        artifactError(
          result.topology,
          fixture,
          "compaction.collects",
          `${plan.phase} collect selections do not match manifest decisions`,
        );
      }
      for (const selection of collect.selections) {
        const decision = manifestDecisions.get(selection.candidateId);
        if (decision === undefined) {
          artifactError(
            result.topology,
            fixture,
            "compaction.collects",
            `${plan.phase} collect has an unplanned selection`,
          );
          continue;
        }
        if (plan.phase === "fallback" && decision.action === "retain") continue;
        const expectedAction =
          decision.action === "keep" ? "keep" : decision.action === "omit" ? "omit" : "range";
        if (selection.action !== expectedAction) {
          artifactError(
            result.topology,
            fixture,
            "compaction.collects",
            `${plan.phase} selection action differs from manifest`,
          );
        }
        if (
          expectedAction === "range" &&
          "groupId" in decision &&
          selection.groupId !== decision.groupId
        ) {
          artifactError(
            result.topology,
            fixture,
            "compaction.collects",
            `${plan.phase} range selection group differs from manifest`,
          );
        }
      }
    }
    valid += 1;
  }
  for (const key of groups.keys()) {
    if (!expectedGroupKeys.has(key)) {
      artifactError(result.topology, fixture, "compaction.groups", "orphan group result");
    }
  }
  for (const collect of compaction.collects) {
    if (
      !matchedCollectKeys.has(`${collect.phase}:${outputCoordinateKey(collect.outputCoordinate)}`)
    ) {
      artifactError(result.topology, fixture, "compaction.collects", "orphan collect result");
    }
  }
  const contextBase = (nodeId: string): string =>
    nodeId.replace(/-(?:compact|fallback)-measure$/u, "").replace(/-measure$/u, "");
  const compactionPrefixKey = (prefix: string, iteration: number): string =>
    `${prefix}:${iteration}`;
  const initialPlans = new Map(
    compaction.plans
      .filter((plan) => plan.phase === "initial")
      .map(
        (plan) =>
          [
            compactionPrefixKey(
              planPrefix(plan.outputCoordinate.nodeId, "initial"),
              plan.outputCoordinate.iteration,
            ),
            plan,
          ] as const,
      ),
  );
  for (const initialPlan of compaction.plans.filter((plan) => plan.phase === "initial")) {
    const prefix = planPrefix(initialPlan.outputCoordinate.nodeId, "initial");
    const iteration = initialPlan.outputCoordinate.iteration;
    const initialContext = compaction.contexts.find(
      (context) =>
        context.stage === "initial" &&
        contextBase(context.outputCoordinate.nodeId) === prefix &&
        context.outputCoordinate.iteration === iteration,
    );
    if (initialContext === undefined) {
      artifactError(
        result.topology,
        fixture,
        "compaction.plans",
        "initial plan lacks initial context",
      );
    }
    if (
      !sameUniqueStringSet(
        initialPlan.manifest.decisions.map((decision) => decision.candidateId),
        initialContext!.candidateLedger.map((candidate) => candidate.candidateId),
      )
    ) {
      artifactError(
        result.topology,
        fixture,
        "compaction.plans",
        "initial manifest does not match initial context ledger",
      );
    }
    if (initialContext!.status !== "needs_compaction") {
      artifactError(
        result.topology,
        fixture,
        "compaction.contexts",
        "initial plan requires needs_compaction context",
      );
    }
  }
  for (const initialContext of compaction.contexts.filter(
    (context) => context.stage === "initial",
  )) {
    const prefix = contextBase(initialContext.outputCoordinate.nodeId);
    const key = compactionPrefixKey(prefix, initialContext.outputCoordinate.iteration);
    const initialPlan = initialPlans.get(key);
    if (initialPlan === undefined) {
      if (initialContext.status !== "ready" || initialContext.compactionRan) {
        artifactError(
          result.topology,
          fixture,
          "compaction.contexts",
          "initial context without plan is not fit-first",
        );
      }
    } else if (initialContext.status !== "needs_compaction") {
      artifactError(
        result.topology,
        fixture,
        "compaction.contexts",
        "initial plan context status is not needs_compaction",
      );
    }
  }
  for (const fallbackPlan of compaction.plans.filter((plan) => plan.phase === "fallback")) {
    const prefix = planPrefix(fallbackPlan.outputCoordinate.nodeId, "fallback");
    const iteration = fallbackPlan.outputCoordinate.iteration;
    const initialPlan = initialPlans.get(compactionPrefixKey(prefix, iteration));
    const initialContext = compaction.contexts.find(
      (context) =>
        context.stage === "initial" &&
        contextBase(context.outputCoordinate.nodeId) === prefix &&
        context.outputCoordinate.iteration === iteration,
    );
    const afterInitialContext = compaction.contexts.find(
      (context) =>
        context.stage === "after_initial" &&
        contextBase(context.outputCoordinate.nodeId) === prefix &&
        context.outputCoordinate.iteration === iteration,
    );
    if (afterInitialContext === undefined) {
      artifactError(
        result.topology,
        fixture,
        "compaction.contexts",
        "fallback lacks after_initial context",
      );
    }
    if (initialPlan === undefined || initialContext === undefined) {
      artifactError(
        result.topology,
        fixture,
        "compaction.plans",
        "fallback lacks initial plan/context",
      );
    }
    if (
      !sameUniqueStringSet(
        fallbackPlan.manifest.decisions.map((decision) => decision.candidateId),
        initialContext!.candidateLedger.map((candidate) => candidate.candidateId),
      )
    ) {
      artifactError(
        result.topology,
        fixture,
        "compaction.plans",
        "fallback manifest does not match initial context ledger",
      );
    }
    const initialLedgerIds = new Set(
      initialContext!.candidateLedger.map((candidate) => candidate.candidateId),
    );
    const initialSelectedIds = new Set(afterInitialContext!.selectedCandidateIds);
    const initialGroupByCandidate = new Map(
      initialPlan!.groups.flatMap((group) =>
        group.candidateIds.map((candidateId) => [candidateId, group] as const),
      ),
    );
    const fallbackCandidates = fallbackPlan.groups.flatMap((group) => group.candidateIds);
    for (const candidateId of fallbackCandidates) {
      if (!initialLedgerIds.has(candidateId)) {
        artifactError(
          result.topology,
          fixture,
          "compaction.plans",
          "fallback restores a candidate",
        );
      }
      if (!initialSelectedIds.has(candidateId)) {
        artifactError(
          result.topology,
          fixture,
          "compaction.plans",
          "fallback restores an omitted candidate",
        );
      }
      const initialGroup = initialGroupByCandidate.get(candidateId);
      const fallbackGroup = fallbackPlan.groups.find((group) =>
        group.candidateIds.includes(candidateId),
      );
      if (
        initialGroup !== undefined &&
        (fallbackGroup === undefined || fallbackGroup.groupId !== initialGroup.groupId)
      ) {
        artifactError(
          result.topology,
          fixture,
          "compaction.plans",
          "fallback changes a compacted group",
        );
      }
    }
    for (const group of fallbackPlan.groups) {
      const initialGroup = initialPlan!.groups.find(
        (candidate) => candidate.groupId === group.groupId,
      );
      if (initialGroup === undefined) continue;
      const groupIndex = initialPlan!.groups.indexOf(initialGroup);
      const initialGroupRow = groups.get(
        `initial:${compactionGroupTaskId(prefix, "compact", groupIndex + 1)}:${initialPlan!.outputCoordinate.iteration}:${group.groupId}`,
      );
      if (
        initialGroupRow !== undefined &&
        group.renderedTokenBudget > initialGroupRow.envelope.renderedTokenCount
      ) {
        artifactError(
          result.topology,
          fixture,
          "compaction.plans",
          "fallback budget exceeds prior rendered cost",
        );
      }
    }
  }
  const fallbackPlans = new Map(
    compaction.plans
      .filter((plan) => plan.phase === "fallback")
      .map(
        (plan) =>
          [
            compactionPrefixKey(
              planPrefix(plan.outputCoordinate.nodeId, "fallback"),
              plan.outputCoordinate.iteration,
            ),
            plan,
          ] as const,
      ),
  );
  for (const collect of compaction.collects) {
    const stage = collect.phase === "initial" ? "after_initial" : "after_fallback";
    const contextNodeId = collect.outputCoordinate.nodeId.replace(/-collect$/u, "-measure");
    const expectedContextKey = `${stage}:${contextNodeId}:${collect.outputCoordinate.iteration}`;
    expectedContextKeys.add(expectedContextKey);
    const context = contexts.get(expectedContextKey);
    if (context === undefined) {
      artifactError(
        result.topology,
        fixture,
        "compaction.collects",
        "collect lacks context summary",
      );
    }
    const contextRow = context!;
    const ledgerIds = new Set(contextRow.candidateLedger.map((candidate) => candidate.candidateId));
    for (const selection of collect.selections) {
      if (!ledgerIds.has(selection.candidateId)) {
        artifactError(
          result.topology,
          fixture,
          "compaction.collects",
          "selection lacks ledger candidate",
        );
      }
      if (selection.action === "range") {
        const acceptable = candidateRangesForId(contextRow, selection.candidateId);
        if (selection.ranges.some((range) => !rangeIsCovered(range, acceptable))) rangesValid = 0;
      }
    }
    const selectedIds = new Set(
      collect.selections
        .filter((selection) => selection.action !== "omit")
        .map((selection) => selection.candidateId),
    );
    const expectedSelectedIds = contextRow.candidateLedger
      .map((candidate) => candidate.candidateId)
      .filter((candidateId) => selectedIds.has(candidateId));
    if (!jsonEqual(contextRow.selectedCandidateIds, expectedSelectedIds)) {
      artifactError(
        result.topology,
        fixture,
        "compaction.contexts",
        "selected candidates differ from collect non-omit selections",
      );
    }
  }
  for (const [key] of contexts) {
    if (
      (key.startsWith("after_initial:") || key.startsWith("after_fallback:")) &&
      !expectedContextKeys.has(key)
    ) {
      artifactError(result.topology, fixture, "compaction.contexts", "orphan context summary");
    }
  }
  const initialContexts = new Map(
    compaction.contexts
      .filter((context) => context.stage === "initial")
      .map(
        (context) =>
          [
            compactionPrefixKey(
              contextBase(context.outputCoordinate.nodeId),
              context.outputCoordinate.iteration,
            ),
            context,
          ] as const,
      ),
  );
  if (
    initialContexts.size !==
    compaction.contexts.filter((context) => context.stage === "initial").length
  ) {
    artifactError(
      result.topology,
      fixture,
      "compaction.contexts",
      "duplicate initial context stage row",
    );
  }
  const afterInitialContexts = new Map(
    compaction.contexts
      .filter((context) => context.stage === "after_initial")
      .map(
        (context) =>
          [
            compactionPrefixKey(
              contextBase(context.outputCoordinate.nodeId),
              context.outputCoordinate.iteration,
            ),
            context,
          ] as const,
      ),
  );
  if (
    afterInitialContexts.size !==
    compaction.contexts.filter((context) => context.stage === "after_initial").length
  ) {
    artifactError(
      result.topology,
      fixture,
      "compaction.contexts",
      "duplicate after_initial context stage row",
    );
  }
  for (const fallbackContext of compaction.contexts.filter(
    (context) => context.stage === "after_fallback",
  )) {
    const initialContext = initialContexts.get(
      compactionPrefixKey(
        contextBase(fallbackContext.outputCoordinate.nodeId),
        fallbackContext.outputCoordinate.iteration,
      ),
    );
    if (initialContext === undefined) {
      artifactError(
        result.topology,
        fixture,
        "compaction.contexts",
        "fallback lacks initial ledger",
      );
      continue;
    }
    const afterInitialContext = afterInitialContexts.get(
      compactionPrefixKey(
        contextBase(fallbackContext.outputCoordinate.nodeId),
        fallbackContext.outputCoordinate.iteration,
      ),
    );
    if (afterInitialContext === undefined) {
      artifactError(
        result.topology,
        fixture,
        "compaction.contexts",
        "fallback lacks after_initial context",
      );
      continue;
    }
    const initialLedgerIds = new Set(
      initialContext!.candidateLedger.map((candidate) => candidate.candidateId),
    );
    if (
      fallbackContext.candidateLedger.some(
        (candidate) => !initialLedgerIds.has(candidate.candidateId),
      )
    ) {
      artifactError(
        result.topology,
        fixture,
        "compaction.contexts",
        "fallback adds a ledger candidate",
      );
    }
    const initialSelected = new Set(afterInitialContext.selectedCandidateIds);
    if (
      fallbackContext.selectedCandidateIds.some((candidateId) => !initialSelected.has(candidateId))
    ) {
      artifactError(
        result.topology,
        fixture,
        "compaction.contexts",
        "fallback restores a selected candidate",
      );
    }
  }
  const stageOrderForTaskId = (taskId: string): number =>
    taskId.includes("-fallback-") ? 2 : taskId.includes("-compact-") ? 1 : 0;
  const orderOf = (
    measurement: EvaluationResult["compaction"]["measurements"][number],
  ): readonly number[] => [
    stageOrderForTaskId(measurement.coordinate.taskId),
    measurement.coordinate.loopIteration,
    measurement.coordinate.attempt,
  ];
  const comesAfter = (
    left: EvaluationResult["compaction"]["measurements"][number],
    right: EvaluationResult["compaction"]["measurements"][number],
  ): boolean => {
    const leftOrder = orderOf(left);
    const rightOrder = orderOf(right);
    for (let index = 0; index < leftOrder.length; index += 1) {
      if (leftOrder[index] !== rightOrder[index]) {
        return leftOrder[index]! > rightOrder[index]!;
      }
    }
    return false;
  };
  for (const measurement of compaction.measurements) {
    if (measurement.status === "failed") {
      artifactError(
        result.topology,
        fixture,
        "compaction.measurements",
        "failed measurement in successful evaluation artifact",
      );
    }
    const exactTotal = measurement.mandatoryInputTokens + measurement.discretionaryInputTokens;
    if (
      measurement.totalInputTokens !== exactTotal ||
      measurement.restrictedContextLedger.inputTokens !== exactTotal ||
      measurement.restrictedContextLedger.usableInputTokens !== measurement.usableInputTokens ||
      measurement.restrictedContextLedger.requestedOutputTokens !==
        measurement.requestedOutputTokens
    ) {
      artifactError(
        result.topology,
        fixture,
        "compaction.measurements",
        "exact token marginal mismatch",
      );
    }
    const fits = exactTotal <= measurement.usableInputTokens;
    if (
      (measurement.status === "ready" && !fits) ||
      (measurement.status === "needs_compaction" && fits)
    ) {
      artifactError(
        result.topology,
        fixture,
        "compaction.measurements",
        "fit-first status mismatch",
      );
    }
    if (stageOrderForTaskId(measurement.coordinate.taskId) === 0) {
      const prefix = measurement.coordinate.taskId.replace(/-measure$/u, "");
      const iteration = measurement.coordinate.loopIteration;
      const initialPlan = initialPlans.get(compactionPrefixKey(prefix, iteration));
      const fallbackPlan = fallbackPlans.get(compactionPrefixKey(prefix, iteration));
      const afterInitial = compaction.measurements
        .filter(
          (candidate) =>
            stageOrderForTaskId(candidate.coordinate.taskId) === 1 &&
            candidate.coordinate.loopIteration === iteration &&
            candidate.consumerTaskId === measurement.consumerTaskId &&
            candidate.topicId === measurement.topicId,
        )
        .sort((left, right) => orderOf(left)[2]! - orderOf(right)[2]!);
      if (fits && (initialPlan !== undefined || fallbackPlan !== undefined)) {
        artifactError(
          result.topology,
          fixture,
          "compaction.plans",
          "fit-first context has compaction artifacts",
        );
      }
      if (!fits) {
        if (initialPlan === undefined || afterInitial.length === 0) {
          artifactError(
            result.topology,
            fixture,
            "compaction.plans",
            "oversized context lacks initial compaction",
          );
        }
        const compactReady = afterInitial.at(-1);
        const compactFits =
          compactReady !== undefined &&
          compactReady.totalInputTokens <= compactReady.usableInputTokens;
        if (!compactFits && fallbackPlan === undefined) {
          artifactError(
            result.topology,
            fixture,
            "compaction.plans",
            "still-oversized compact context lacks fallback",
          );
        }
        if (compactFits && fallbackPlan !== undefined) {
          artifactError(
            result.topology,
            fixture,
            "compaction.plans",
            "fallback exists after compact context fits",
          );
        }
      }
    }
    if (stageOrderForTaskId(measurement.coordinate.taskId) === 0 && !fits) {
      const finalReady = compaction.measurements
        .filter(
          (candidate) =>
            candidate.coordinate.loopIteration === measurement.coordinate.loopIteration &&
            candidate.consumerTaskId === measurement.consumerTaskId &&
            candidate.topicId === measurement.topicId &&
            candidate.status === "ready" &&
            candidate.totalInputTokens <= candidate.usableInputTokens &&
            comesAfter(candidate, measurement),
        )
        .sort((left, right) => {
          const leftOrder = orderOf(left);
          const rightOrder = orderOf(right);
          return (
            leftOrder[0]! - rightOrder[0]! ||
            leftOrder[1]! - rightOrder[1]! ||
            leftOrder[2]! - rightOrder[2]!
          );
        })[0];
      if (finalReady !== undefined) {
        tokenReductions.push(
          ratio(
            measurement.totalInputTokens - finalReady.totalInputTokens,
            measurement.totalInputTokens,
            0,
          ),
        );
      } else {
        artifactError(
          result.topology,
          fixture,
          "compaction.measurements",
          "oversized measurement lacks an ordered final ready measurement",
        );
      }
    }
  }
  const required = fixture.labels.requiredSourceIds;
  const serializedSourceIds = new Set(result.serializedSourceIds);
  for (const fallbackCollect of compaction.collects.filter(
    (collect) => collect.phase === "fallback",
  )) {
    const iteration = fallbackCollect.outputCoordinate.iteration;
    const prefix = fallbackCollect.outputCoordinate.nodeId.replace(/-fallback-collect$/u, "");
    const initialCollect = compaction.collects.find(
      (collect) =>
        collect.phase === "initial" &&
        collect.outputCoordinate.nodeId === `${prefix}-compact-collect` &&
        collect.outputCoordinate.iteration === iteration,
    );
    const fallbackPlan = fallbackPlans.get(compactionPrefixKey(prefix, iteration));
    const fallbackDecisions = new Map(
      fallbackPlan?.manifest.decisions.map(
        (decision) => [decision.candidateId, decision] as const,
      ) ?? [],
    );
    if (fallbackPlan === undefined) {
      artifactError(
        result.topology,
        fixture,
        "compaction.plans",
        "fallback collect lacks fallback plan",
      );
    }
    if (initialCollect === undefined) {
      artifactError(
        result.topology,
        fixture,
        "compaction.collects",
        "fallback lacks initial collect",
      );
    }
    const initialSelections = new Map(
      initialCollect!.selections.map((selection) => [selection.candidateId, selection] as const),
    );
    for (const selection of fallbackCollect.selections) {
      const initialSelection = initialSelections.get(selection.candidateId);
      if (initialSelection === undefined) {
        artifactError(
          result.topology,
          fixture,
          "compaction.collects",
          "fallback selection was not initially selected",
        );
      }
      if (initialSelection === undefined) continue;
      const priorSelection = initialSelection;
      const fallbackDecision = fallbackDecisions.get(selection.candidateId);
      if (fallbackDecision?.action === "retain" && !jsonEqual(selection, priorSelection)) {
        artifactError(
          result.topology,
          fixture,
          "compaction.collects",
          "fallback retain selection differs from initial selection",
        );
      }
      if (
        priorSelection.action === "range" &&
        selection.action === "range" &&
        (selection.groupId !== priorSelection.groupId ||
          selection.ranges.some((range) => !rangeIsCovered(range, priorSelection.ranges)))
      ) {
        artifactError(
          result.topology,
          fixture,
          "compaction.collects",
          "fallback passage selection widens or changes group",
        );
      }
    }
  }
  const coverage =
    required.length === 0
      ? 1
      : ratio(
          required.filter((sourceId) => serializedSourceIds.has(sourceId)).length,
          required.length,
          0,
        );
  if (
    compaction.contexts.some(
      (context) => context.stage === "after_fallback" && context.status === "needs_compaction",
    )
  ) {
    convergence = 0;
  }
  if (compaction.plans.length > 0 && tokenReductions.length === 0) {
    artifactError(
      result.topology,
      fixture,
      "compaction.measurements",
      "compaction plans lack token reduction evidence",
    );
  }
  return {
    planValidity: compaction.plans.length === 0 ? 1 : ratio(valid, compaction.plans.length, 0),
    convergence,
    coverage,
    rangeValidity: rangesValid,
    tokenReduction: compaction.plans.length === 0 ? 1 : mean(tokenReductions),
  };
};

const assertTerminalEvidence = (
  fixture: GoldenEvaluationCase,
  result: EvaluationResult,
): number => {
  const requests = result.terminalEvidence.requests;
  if (result.topology === "general_planner" || result.planTurn.mode === "clarify") {
    if (requests.length !== 0) {
      artifactError(
        result.topology,
        fixture,
        "terminalEvidence.requests",
        "general-planner or clarification result must not have terminal context requests",
      );
    }
  } else if (result.planTurn.mode === "single") {
    if (requests.length === 0 || requests.some((request) => request.requestKind !== "direct")) {
      artifactError(
        result.topology,
        fixture,
        "terminalEvidence.requests",
        "specialized single result requires direct terminal context requests only",
      );
    }
  } else if (result.planTurn.mode === "fanout") {
    const expectedTopics = new Set(result.planTurn.topics.map((topic) => topic.topicId));
    const topicRequests = requests.filter((request) => request.requestKind === "topic");
    if (
      requests.some((request) => request.requestKind === "direct") ||
      !requests.some((request) => request.requestKind === "synthesis") ||
      expectedTopics.size !== new Set(topicRequests.map((request) => request.topicId)).size ||
      topicRequests.some(
        (request) => request.topicId === undefined || !expectedTopics.has(request.topicId),
      )
    ) {
      artifactError(
        result.topology,
        fixture,
        "terminalEvidence.requests",
        "fanout terminal context request shape differs from planned topics",
      );
    }
  }
  const measurementByRequest = new Map(
    result.promptMeasurements.map((measurement) => [measurement.requestId, measurement] as const),
  );
  let defects = 0;
  for (const request of result.terminalEvidence.requests) {
    if (request.evidenceSha256Hex !== terminalRequestEvidenceSha256Hex(request)) {
      artifactError(
        result.topology,
        fixture,
        "terminalEvidence.requests",
        "evidence digest mismatch",
      );
    }
    if (
      request.requestKind === "topic"
        ? request.topicId === undefined
        : request.topicId !== undefined
    ) {
      artifactError(
        result.topology,
        fixture,
        "terminalEvidence.requests",
        "topic binding mismatch",
      );
    }
    const measurement = measurementByRequest.get(usageCoordinateKey(request.coordinate));
    const compactionMeasurement = [...result.compaction.measurements]
      .filter(
        (candidate) =>
          candidate.coordinate.loopIteration === request.coordinate.loopIteration &&
          candidate.consumerTaskId === request.consumerTaskId &&
          candidate.topicId === request.topicId &&
          candidate.restrictedContextLedger.requestKind === request.requestKind &&
          candidate.restrictedContextLedger.requestSha256Hex === request.requestSha256Hex,
      )
      .sort((left, right) => {
        const stage = (taskId: string): number =>
          taskId.includes("-fallback-") ? 2 : taskId.includes("-compact-") ? 1 : 0;
        return (
          stage(left.coordinate.taskId) - stage(right.coordinate.taskId) ||
          left.coordinate.attempt - right.coordinate.attempt
        );
      })
      .at(-1);
    if (
      measurement === undefined ||
      compactionMeasurement === undefined ||
      measurement.requestSha256Hex !== request.requestSha256Hex ||
      compactionMeasurement.restrictedContextLedger.requestSha256Hex !== request.requestSha256Hex ||
      compactionMeasurement.restrictedContextLedger.requestKind !== request.requestKind ||
      compactionMeasurement.restrictedContextLedger.inputTokens !== request.localInputTokens ||
      measurement.localInputTokens !== request.localInputTokens ||
      measurement.providerInputTokens !== request.providerInputTokens ||
      compactionMeasurement.restrictedContextLedger.requestedOutputTokens !==
        request.requestedOutputTokens ||
      compactionMeasurement.restrictedContextLedger.usableInputTokens !==
        request.usableInputTokens ||
      !measurement.gatePassed
    ) {
      defects += 1;
    }
    if (
      compactionMeasurement !== undefined &&
      request.requestKind !== "synthesis" &&
      compactionMeasurement.restrictedContextLedger.requestKind !== "synthesis"
    ) {
      const expectedSources = compactionMeasurement.restrictedContextLedger.sources.map(
        (source) => ({
          sourceKey: source.sourceKey,
          candidateId: source.candidateId,
          kind: source.kind,
          label: source.label,
          ranges: source.ranges,
        }),
      );
      const actualSources = request.sourceMap.map((source) => ({
        sourceKey: source.sourceKey,
        candidateId: source.candidateId,
        kind: source.kind,
        label: source.label,
        ranges: source.ranges,
      }));
      if (!jsonEqual(actualSources, expectedSources)) defects += 1;
    }
    if (request.sourceMap.some((source) => source.sourceIdentityDigest === undefined)) defects += 1;
    if (
      request.requestKind === "synthesis" &&
      request.sourceMap.some((source) => source.candidateId !== undefined)
    ) {
      defects += 1;
    }
    if (
      request.requestKind !== "synthesis" &&
      request.sourceMap.some((source) => source.candidateId === undefined)
    ) {
      defects += 1;
    }
    if (measurement === undefined || !measurement.gatePassed) {
      defects += 1;
    }
    const candidateIds = request.sourceMap.flatMap((source) =>
      source.candidateId === undefined ? [] : [source.candidateId],
    );
    if (request.requestKind === "synthesis" && candidateIds.length > 0) defects += 1;
    if (request.requestKind !== "synthesis" && candidateIds.length !== request.sourceMap.length)
      defects += 1;
  }
  return defects;
};

const scorePlan = (
  fixture: GoldenEvaluationCase,
  result: EvaluationResult,
): {
  readonly fidelity: number;
  readonly selectedF1: number;
  readonly clarify: boolean;
  readonly fanout: boolean;
} => {
  const plan = result.planTurn;
  const expected = fixture.labels.planTurn;
  const expectedQuestionGroups =
    expected.mode === "clarify"
      ? expected.requiredQuestionTermGroups
      : expected.mode === "single"
        ? expected.requiredTermGroups
        : [];
  const expectedTurnIds =
    expected.mode === "fanout"
      ? expected.topics.flatMap((topic) => topic.relevantTurnIds)
      : expected.relevantTurnIds;
  const expectedMode = expected.mode;
  const modeCorrect = plan.mode === expectedMode;
  const question = plan.mode === "fanout" ? plan.question : plan.question;
  const fidelity = modeCorrect
    ? mean([
        tokenF1(question, expected.question),
        termGroupCoverage(question, expectedQuestionGroups),
      ])
    : 0;
  const actualTurns =
    plan.mode === "fanout"
      ? plan.topics.flatMap((topic) => topic.relevantTurnIds)
      : plan.mode === "single"
        ? plan.relevantTurnIds
        : [];
  const selectedCorrect = actualTurns.filter((turnId) => expectedTurnIds.includes(turnId)).length;
  const selectedF1 = f1(
    ratio(selectedCorrect, actualTurns.length, expectedTurnIds.length === 0 ? 1 : 0),
    ratio(selectedCorrect, expectedTurnIds.length),
  );
  return {
    fidelity,
    selectedF1,
    clarify: expected.mode === "clarify" && plan.mode === "clarify",
    fanout:
      expected.mode === "fanout" &&
      plan.mode === "fanout" &&
      fanoutMatchesGoldenTopics(fixture, plan),
  };
};

export const evaluateSuite = (
  goldenInput: unknown,
  specializedInput: unknown,
  baselineInput: unknown,
  options: EvaluationOptions = {},
): EvaluationReport => {
  const golden = GoldenEvaluationSetSchema.parse(goldenInput);
  const specialized = SpecializedEvaluationResultsSchema.parse(specializedInput);
  const baseline = GeneralPlannerEvaluationResultsSchema.parse(baselineInput);
  const specializedByCase = indexExactResults(golden.cases, specialized, "specialized results");
  const baselineByCase = indexExactResults(golden.cases, baseline, "general-planner baseline");
  assertCapturePosture([...specialized, ...baseline], options.allowSyntheticCaptures === true);

  const selectedScores: number[] = [];
  const planFidelities: number[] = [];
  const compactionValidity: number[] = [];
  const compactionConvergence: number[] = [];
  const compactionCoverage: number[] = [];
  const compactionRangeValidity: number[] = [];
  const compactionTokenReduction: number[] = [];
  const answerScores: AnswerScore[] = [];
  const sourceDefects: number[] = [];
  const baselineSourceDefects: number[] = [];
  const firstTokenTimes: number[] = [];
  const terminalTimes: number[] = [];
  const promptParities: number[] = [];
  const answerQualityDeltas: number[] = [];
  const groundingDeltas: number[] = [];
  let clarificationTruePositive = 0;
  let clarificationPredicted = 0;
  let clarificationExpected = 0;
  let fanoutTruePositive = 0;
  let fanoutPredicted = 0;
  let fanoutExpected = 0;
  let falseDecompositionCount = 0;
  let memoryProposalCorrect = 0;
  let memoryProposalPredicted = 0;
  let memoryProposalExpected = 0;
  let memoryUpdateCorrect = 0;
  let memoryUpdateExpected = 0;
  const retrievalCoverage: number[] = [];
  const retrievalProvenance: number[] = [];
  const contextEfficiencyImprovements: number[] = [];
  const selectors: Record<
    "A" | "B" | "W",
    { precisionCorrect: number; predicted: number; recallCorrect: number; expected: number }
  > = {
    A: { precisionCorrect: 0, predicted: 0, recallCorrect: 0, expected: 0 },
    B: { precisionCorrect: 0, predicted: 0, recallCorrect: 0, expected: 0 },
    W: { precisionCorrect: 0, predicted: 0, recallCorrect: 0, expected: 0 },
  };
  const qualitySpecialized: number[] = [];
  const qualityBaseline: number[] = [];
  const groundingSpecialized: number[] = [];
  const groundingBaseline: number[] = [];
  const terminalSpecialized: number[] = [];
  const fanoutSpecializedTokenCosts: number[] = [];
  const fanoutBaselineTokenCosts: number[] = [];
  const terminalBaseline: number[] = [];
  for (const fixture of golden.cases) {
    const result = specializedByCase.get(fixture.id)!;
    const baselineResult = baselineByCase.get(fixture.id)!;
    const planScore = scorePlan(fixture, result);
    const expectedClarification = fixture.labels.planTurn.mode === "clarify";
    const predictedClarification = result.planTurn.mode === "clarify";
    clarificationExpected += expectedClarification ? 1 : 0;
    clarificationPredicted += predictedClarification ? 1 : 0;
    if (expectedClarification && predictedClarification) clarificationTruePositive += 1;
    const expectedFanout = fixture.labels.planTurn.mode === "fanout";
    const predictedFanout = result.planTurn.mode === "fanout";
    fanoutExpected += expectedFanout ? 1 : 0;
    fanoutPredicted += predictedFanout ? 1 : 0;
    if (expectedFanout && predictedFanout && planScore.fanout) fanoutTruePositive += 1;
    if (predictedFanout && !expectedFanout) falseDecompositionCount += 1;
    const expectedMemoryKeys = fixture.labels.expectedMemoryProposals.map(memoryProposalKey);
    const actualMemoryKeys = result.memoryProposals.map(memoryProposalKey);
    const expectedMemorySet = new Set(expectedMemoryKeys);
    const correctMemoryKeys = actualMemoryKeys.filter((key) => expectedMemorySet.has(key));
    memoryProposalCorrect += correctMemoryKeys.length;
    memoryProposalPredicted += actualMemoryKeys.length;
    memoryProposalExpected += expectedMemoryKeys.length;
    const expectedUpdateKeys = new Set(
      fixture.labels.expectedMemoryProposals
        .filter((proposal) => proposal.action === "update")
        .map(memoryProposalKey),
    );
    memoryUpdateExpected += expectedUpdateKeys.size;
    memoryUpdateCorrect += actualMemoryKeys.filter((key) => expectedUpdateKeys.has(key)).length;
    selectedScores.push(planScore.selectedF1);
    planFidelities.push(planScore.fidelity);
    const retrievalScore = assertRetrievalArtifacts(fixture, result);
    retrievalCoverage.push(retrievalScore.coverage);
    retrievalProvenance.push(retrievalScore.provenance);
    const compactionScore = assertCompactionArtifacts(fixture, result);
    compactionValidity.push(compactionScore.planValidity);
    compactionConvergence.push(compactionScore.convergence);
    compactionCoverage.push(compactionScore.coverage);
    compactionRangeValidity.push(compactionScore.rangeValidity);
    compactionTokenReduction.push(compactionScore.tokenReduction);
    const specializedAnswer = scoreAnswer(fixture, result);
    answerScores.push(specializedAnswer);
    const baselineAnswer = scoreAnswer(fixture, baselineResult);
    answerQualityDeltas.push(specializedAnswer.quality - baselineAnswer.quality);
    groundingDeltas.push(specializedAnswer.grounding - baselineAnswer.grounding);
    assertCompactionArtifacts(fixture, baselineResult);
    assertRetrievalArtifacts(fixture, baselineResult);
    sourceDefects.push(
      commonSourceStageDefects(fixture, result) + assertTerminalEvidence(fixture, result),
    );
    baselineSourceDefects.push(
      commonSourceStageDefects(fixture, baselineResult) +
        assertTerminalEvidence(fixture, baselineResult),
    );
    const promptParity = [...result.promptMeasurements, ...baselineResult.promptMeasurements].every(
      (measurement) =>
        measurement.gatePassed && measurement.localInputTokens === measurement.providerInputTokens,
    );
    promptParities.push(promptParity ? 1 : 0);
    if (!expectedClarification) {
      const finalRequestKind = expectedFanout ? "synthesis" : "direct";
      const finalRequest = [...result.terminalEvidence.requests]
        .filter((request) => request.requestKind === finalRequestKind)
        .sort(
          (left, right) =>
            left.coordinate.loopIteration - right.coordinate.loopIteration ||
            left.coordinate.attempt - right.coordinate.attempt ||
            left.coordinate.providerRequestIndex - right.coordinate.providerRequestIndex,
        )
        .at(-1);
      if (finalRequest === undefined) {
        artifactError(
          result.topology,
          fixture,
          "terminalEvidence.requests",
          `missing final ${finalRequestKind} request`,
        );
      }
      const baselineTokens = baselineResult.serializedContextTokens;
      if (baselineTokens <= 0) {
        artifactError(
          baselineResult.topology,
          fixture,
          "serializedContextTokens",
          "baseline context token count must be positive",
        );
      }
      contextEfficiencyImprovements.push(
        (baselineTokens - finalRequest!.localInputTokens) / baselineTokens,
      );
    }
    firstTokenTimes.push(result.timing.timeToFirstTokenMs);
    terminalTimes.push(result.timing.timeToTerminalMs);
    if (expectedFanout) {
      terminalSpecialized.push(result.timing.timeToTerminalMs);
      terminalBaseline.push(baselineResult.timing.timeToTerminalMs);
      qualitySpecialized.push(specializedAnswer.quality);
      groundingSpecialized.push(specializedAnswer.grounding);
      qualityBaseline.push(baselineAnswer.quality);
      groundingBaseline.push(baselineAnswer.grounding);
      fanoutSpecializedTokenCosts.push(result.usage.totalTokens);
      fanoutBaselineTokenCosts.push(baselineResult.usage.totalTokens);
    }
    for (const role of ["A", "B", "W"] as const) {
      const actual = result.topology === "specialized" ? result.selectorSelections[role] : [];
      const expected = fixture.evidence
        .filter((source) => source.selector === role)
        .map((source) => source.sourceId);
      const expectedSet = new Set(expected);
      selectors[role].predicted += actual.length;
      selectors[role].expected += expected.length;
      selectors[role].precisionCorrect += actual.filter((value) => expectedSet.has(value)).length;
      selectors[role].recallCorrect += actual.filter((value) => expectedSet.has(value)).length;
    }
  }
  const selectorMetric = (role: "A" | "B" | "W", kind: "precision" | "recall"): number => {
    const score = selectors[role];
    return kind === "precision"
      ? ratio(score.precisionCorrect, score.predicted, score.expected === 0 ? 1 : 0)
      : ratio(score.recallCorrect, score.expected);
  };
  const answerQualityDelta = mean(answerQualityDeltas, 0);
  const groundingDelta = mean(groundingDeltas, 0);
  const clarificationPrecision = ratio(
    clarificationTruePositive,
    clarificationPredicted,
    clarificationExpected === 0 ? 1 : 0,
  );
  const clarificationRecall = ratio(clarificationTruePositive, clarificationExpected);
  const fanoutPrecision = ratio(fanoutTruePositive, fanoutPredicted, fanoutExpected === 0 ? 1 : 0);
  const fanoutRecall = ratio(fanoutTruePositive, fanoutExpected);
  const falseDecompositionRate = ratio(falseDecompositionCount, golden.cases.length, 0);
  const metrics = {
    "conversation.turn_selection_f1": mean(selectedScores),
    "conversation.plan_question_fidelity": mean(planFidelities),
    "conversation.clarification_precision": clarificationPrecision,
    "conversation.clarification_recall": clarificationRecall,
    "planner.fanout_precision": fanoutPrecision,
    "planner.required_fanout_recall": fanoutRecall,
    "planner.false_decomposition_rate": falseDecompositionRate,
    "selector.A.recall": selectorMetric("A", "recall"),
    "selector.A.precision": selectorMetric("A", "precision"),
    "selector.B.recall": selectorMetric("B", "recall"),
    "selector.B.precision": selectorMetric("B", "precision"),
    "selector.W.recall": selectorMetric("W", "recall"),
    "selector.W.precision": selectorMetric("W", "precision"),
    "prompt.exact_count_parity": mean(promptParities),
    "retrieval.coverage": mean(retrievalCoverage),
    "retrieval.provenance": mean(retrievalProvenance),
    "compaction.plan_validity": mean(compactionValidity),
    "compaction.convergence": mean(compactionConvergence),
    "compaction.coverage": mean(compactionCoverage),
    "compaction.range_validity": mean(compactionRangeValidity),
    "compaction.token_reduction": mean(compactionTokenReduction),
    "answer.factual_support": mean(answerScores.map((score) => score.factualSupport)),
    "answer.supported_claim_recall": mean(answerScores.map((score) => score.claimRecall)),
    "answer.citation_correctness": mean(answerScores.map((score) => score.citationCorrectness)),
    "answer.expected_gap_recall": mean(answerScores.map((score) => score.gapRecall)),
    "memory.proposal_precision": ratio(
      memoryProposalCorrect,
      memoryProposalPredicted,
      memoryProposalExpected === 0 ? 1 : 0,
    ),
    "memory.proposal_recall": ratio(memoryProposalCorrect, memoryProposalExpected),
    "memory.update_correctness": ratio(
      memoryUpdateCorrect,
      memoryUpdateExpected,
      memoryUpdateExpected === 0 ? 1 : 0,
    ),
    "efficiency.pull_to_serialized": mean(
      specialized.map((result) =>
        ratio(result.serializedSourceIds.length, result.pulledSourceIds.length, 1),
      ),
    ),
    "efficiency.serialized_to_cited": mean(
      specialized.map((result) =>
        ratio(result.answer.citationSourceIds.length, result.serializedSourceIds.length, 1),
      ),
    ),
    "source.defect_count": mean(sourceDefects, 0),
    "baseline.source_defect_count": mean(baselineSourceDefects, 0),
    "latency.time_to_first_token_p95_ms": percentile(firstTokenTimes, 0.95),
    "latency.time_to_terminal_p95_ms": percentile(terminalTimes, 0.95),
    "fanout.quality_ratio": ratio(mean(qualitySpecialized), mean(qualityBaseline), 1),
    "fanout.terminal_latency_ratio": ratio(mean(terminalSpecialized), mean(terminalBaseline), 1),
    "fanout.token_cost_ratio": ratio(
      mean(fanoutSpecializedTokenCosts),
      mean(fanoutBaselineTokenCosts),
      1,
    ),
    "baseline.answer_quality_delta": answerQualityDelta,
    "baseline.grounding_delta": groundingDelta,
    "baseline.context_efficiency_improvement": mean(contextEfficiencyImprovements, 0),
    "baseline.terminal_latency_improvement": ratio(
      mean(terminalBaseline) - mean(terminalSpecialized),
      mean(terminalBaseline),
      0,
    ),
    "baseline.topology_justified": baseline.every((result) => result.topology === "general_planner")
      ? 1
      : 0,
  } as Record<EvaluationMetricName, number>;
  const gates: EvaluationGate[] = [
    gateAtLeast(
      "conversation.turn_selection_f1",
      metrics["conversation.turn_selection_f1"],
      EvaluationGateThresholds.conversationTurnSelectionF1,
    ),
    gateAtLeast(
      "conversation.plan_question_fidelity",
      metrics["conversation.plan_question_fidelity"],
      EvaluationGateThresholds.planQuestionFidelity,
    ),
    gateEqual(
      "conversation.clarification_precision",
      metrics["conversation.clarification_precision"],
      EvaluationGateThresholds.clarificationPrecision,
    ),
    gateEqual(
      "conversation.clarification_recall",
      metrics["conversation.clarification_recall"],
      EvaluationGateThresholds.clarificationRecall,
    ),
    gateEqual(
      "planner.fanout_precision",
      metrics["planner.fanout_precision"],
      EvaluationGateThresholds.fanoutPrecision,
    ),
    gateEqual(
      "planner.required_fanout_recall",
      metrics["planner.required_fanout_recall"],
      EvaluationGateThresholds.requiredFanoutRecall,
    ),
    gateEqual(
      "planner.false_decomposition_rate",
      metrics["planner.false_decomposition_rate"],
      EvaluationGateThresholds.falseDecompositionRate,
    ),
    gateAtLeast(
      "selector.A.recall",
      metrics["selector.A.recall"],
      EvaluationGateThresholds.selectorRecall,
    ),
    gateAtLeast(
      "selector.A.precision",
      metrics["selector.A.precision"],
      EvaluationGateThresholds.selectorPrecision,
    ),
    gateAtLeast(
      "selector.B.recall",
      metrics["selector.B.recall"],
      EvaluationGateThresholds.selectorRecall,
    ),
    gateAtLeast(
      "selector.B.precision",
      metrics["selector.B.precision"],
      EvaluationGateThresholds.selectorPrecision,
    ),
    gateAtLeast(
      "selector.W.recall",
      metrics["selector.W.recall"],
      EvaluationGateThresholds.selectorRecall,
    ),
    gateAtLeast(
      "selector.W.precision",
      metrics["selector.W.precision"],
      EvaluationGateThresholds.selectorPrecision,
    ),
    gateEqual(
      "prompt.exact_count_parity",
      metrics["prompt.exact_count_parity"],
      EvaluationGateThresholds.promptCountParity,
    ),
    gateEqual(
      "retrieval.coverage",
      metrics["retrieval.coverage"],
      EvaluationGateThresholds.retrievalCoverage,
    ),
    gateEqual(
      "retrieval.provenance",
      metrics["retrieval.provenance"],
      EvaluationGateThresholds.retrievalProvenance,
    ),
    gateEqual(
      "compaction.plan_validity",
      metrics["compaction.plan_validity"],
      EvaluationGateThresholds.compactionPlanValidity,
    ),
    gateEqual(
      "compaction.convergence",
      metrics["compaction.convergence"],
      EvaluationGateThresholds.compactionConvergence,
    ),
    gateEqual(
      "compaction.coverage",
      metrics["compaction.coverage"],
      EvaluationGateThresholds.compactionCoverage,
    ),
    gateEqual(
      "compaction.range_validity",
      metrics["compaction.range_validity"],
      EvaluationGateThresholds.compactionRangeValidity,
    ),
    gateAtLeast(
      "compaction.token_reduction",
      metrics["compaction.token_reduction"],
      EvaluationGateThresholds.compactionTokenReduction,
    ),
    gateEqual(
      "answer.factual_support",
      metrics["answer.factual_support"],
      EvaluationGateThresholds.factualSupport,
    ),
    gateAtLeast(
      "answer.supported_claim_recall",
      metrics["answer.supported_claim_recall"],
      EvaluationGateThresholds.supportedClaimRecall,
    ),
    gateEqual(
      "answer.citation_correctness",
      metrics["answer.citation_correctness"],
      EvaluationGateThresholds.citationCorrectness,
    ),
    gateEqual(
      "answer.expected_gap_recall",
      metrics["answer.expected_gap_recall"],
      EvaluationGateThresholds.expectedGapRecall,
    ),
    gateAtLeast(
      "memory.proposal_precision",
      metrics["memory.proposal_precision"],
      EvaluationGateThresholds.memoryProposalPrecision,
    ),
    gateAtLeast(
      "memory.proposal_recall",
      metrics["memory.proposal_recall"],
      EvaluationGateThresholds.memoryProposalRecall,
    ),
    gateEqual(
      "memory.update_correctness",
      metrics["memory.update_correctness"],
      EvaluationGateThresholds.memoryUpdateCorrectness,
    ),
    gateAtLeast(
      "efficiency.pull_to_serialized",
      metrics["efficiency.pull_to_serialized"],
      EvaluationGateThresholds.pullToSerializedEfficiency,
    ),
    gateAtLeast(
      "efficiency.serialized_to_cited",
      metrics["efficiency.serialized_to_cited"],
      EvaluationGateThresholds.serializedToCitedEfficiency,
    ),
    gateAtMost(
      "source.defect_count",
      metrics["source.defect_count"],
      EvaluationGateThresholds.maximumSourceDefects,
    ),
    gateAtMost(
      "baseline.source_defect_count",
      metrics["baseline.source_defect_count"],
      EvaluationGateThresholds.maximumSourceDefects,
    ),
    gateAtMost(
      "latency.time_to_first_token_p95_ms",
      metrics["latency.time_to_first_token_p95_ms"],
      EvaluationGateThresholds.maximumTimeToFirstTokenP95Ms,
    ),
    gateAtMost(
      "latency.time_to_terminal_p95_ms",
      metrics["latency.time_to_terminal_p95_ms"],
      EvaluationGateThresholds.maximumTimeToTerminalP95Ms,
    ),
    gateAtLeast(
      "fanout.quality_ratio",
      metrics["fanout.quality_ratio"],
      EvaluationGateThresholds.fanoutMinimumQualityRatio,
    ),
    gateAtMost(
      "fanout.terminal_latency_ratio",
      metrics["fanout.terminal_latency_ratio"],
      EvaluationGateThresholds.fanoutMaximumTerminalLatencyRatio,
    ),
    gateAtMost(
      "fanout.token_cost_ratio",
      metrics["fanout.token_cost_ratio"],
      EvaluationGateThresholds.fanoutMaximumTokenCostRatio,
    ),
    gateAtLeast(
      "baseline.answer_quality_delta",
      metrics["baseline.answer_quality_delta"],
      EvaluationGateThresholds.baselineMinimumAnswerQualityImprovement,
    ),
    gateAtLeast(
      "baseline.grounding_delta",
      metrics["baseline.grounding_delta"],
      EvaluationGateThresholds.baselineMinimumGroundingImprovement,
    ),
    gateAtLeast(
      "baseline.context_efficiency_improvement",
      metrics["baseline.context_efficiency_improvement"],
      EvaluationGateThresholds.baselineMinimumContextEfficiencyImprovement,
    ),
    gateAtLeast(
      "baseline.terminal_latency_improvement",
      metrics["baseline.terminal_latency_improvement"],
      EvaluationGateThresholds.baselineMinimumTerminalLatencyImprovement,
    ),
    gateEqual("baseline.topology_justified", metrics["baseline.topology_justified"], 1),
  ];
  return {
    goldenSetVersion: golden.version,
    caseCount: golden.cases.length,
    specializedRunIds: specialized.map((result) => result.capture.runId),
    baselineRunIds: baseline.map((result) => result.capture.runId),
    metrics,
    gates,
    passed: gates.every((gate) => gate.passed),
  };
};
