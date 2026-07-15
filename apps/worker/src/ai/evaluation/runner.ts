import { createHash } from "node:crypto";

import { z } from "zod";

import {
  ConversationResolverPrompt,
  DirectAnswerPrompt,
  SynthesisPrompt,
  TopicAnswerPrompt,
} from "../prompts";
import { resolveRegisteredModel, usableInputTokens } from "../runtime/model-registry";
import { providerRequestSha256Hex, type ProviderRequest } from "../runtime/provider-request";
import { ConversationResolutionProviderSchema } from "../runtime/validators";
import {
  GeneralPlannerEvaluationResultsSchema,
  GoldenEvaluationSetSchema,
  SpecializedEvaluationResultsSchema,
  type EvaluationRange,
  type GeneralPlannerEvaluationResult,
  type GoldenEvaluationCase,
  type GoldenEvaluationSet,
  type SelectorRole,
  type SpecializedEvaluationResult,
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

export const exactConversationResolverRequest = (
  fixture: GoldenEvaluationCase,
  selectedConversation: readonly ExactProductionConversationBinding[],
  currentDate: string,
): ProviderRequest => ({
  requestClass: "fast",
  model: "glm-5-turbo",
  messages: [
    { role: "system", content: ConversationResolverPrompt },
    {
      role: "user",
      content: JSON.stringify({
        currentMessage: fixture.currentMessage,
        entries: exactProductionConversation(fixture, selectedConversation),
        locale: fixture.locale,
        market: fixture.market,
        currentDate,
      }),
    },
  ],
  tools: [
    {
      name: "emit_conversation_resolution",
      description: "Emit the validated conversation resolution.",
      parameters: z.toJSONSchema(ConversationResolutionProviderSchema),
    },
  ],
  toolChoice: "auto",
  requestedOutputTokens: 2048,
  reasoning: "medium",
});

export const attestExactConversationResolverRequest = (
  fixture: GoldenEvaluationCase,
  selectedConversation: readonly ExactProductionConversationBinding[],
  currentDate: string,
): {
  readonly inputTokens: number;
  readonly usableInputTokens: number;
  readonly requestSha256Hex: string;
} => {
  const request = exactConversationResolverRequest(fixture, selectedConversation, currentDate);
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
    if (
      ranges.some(
        (range) =>
          range.charStart < 0 ||
          range.charEnd <= range.charStart ||
          range.charEnd > source.content.length,
      )
    ) {
      throw new EvaluationInputError(
        `${fixture.id}/${source.sourceId} has an out-of-bounds evaluation range`,
      );
    }
    const content =
      source.kind === "document" && ranges.length > 0
        ? ranges.map((range) => source.content.slice(range.charStart, range.charEnd)).join("\n…\n")
        : source.content;
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
      [
        `<source key=${JSON.stringify(productionSourceKey ?? source.sourceId)} kind=${JSON.stringify(source.kind)}${options.productionSourceKeys === undefined || productionLabel === null ? "" : ` label=${JSON.stringify(productionLabel)}`}>`,
        content,
        "</source>",
      ].join("\n"),
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
    (fixture.labels.resolution.mode === "continue"
      ? fixture.labels.resolution.canonicalRetrievalQuestion
      : fixture.currentMessage);
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
  if (
    new Set(bindings.map((binding) => binding.sourceId)).size !== bindings.length ||
    new Set(bindings.map((binding) => binding.sourceKey)).size !== bindings.length
  ) {
    throw new EvaluationInputError(`${fixture.id} production source bindings are not bijective`);
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
        source.kind === "document" && source.content.length < 100
          ? source.content.padEnd(100, " ")
          : source.content;
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
      return [
        `<source key=${JSON.stringify(binding.sourceKey)} kind=${JSON.stringify(source.kind)}${binding.label === null ? "" : ` label=${JSON.stringify(binding.label)}`}>`,
        text,
        "</source>",
      ].join("\n");
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
  retrievalQuestionFidelity: 0.85,
  clarificationPrecision: 1,
  clarificationRecall: 1,
  fanoutPrecision: 1,
  requiredFanoutRecall: 1,
  falseDecompositionRate: 0,
  selectorRecall: 0.9,
  selectorPrecision: 0.9,
  promptCountParity: 1,
  reductionPlanValidity: 1,
  reductionConvergence: 1,
  reductionCoverage: 1,
  reductionRangeValidity: 1,
  oversizedTokenReduction: 0.1,
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
  | "conversation.retrieval_question_fidelity"
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
  | "reducer.plan_validity"
  | "reducer.convergence"
  | "reducer.coverage"
  | "reducer.range_validity"
  | "reducer.token_reduction"
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
  readonly goldenSetVersion: 2;
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

interface ScoreCounts {
  readonly correct: number;
  readonly predicted: number;
  readonly expected: number;
}

interface SelectorScoreCounts {
  readonly precisionCorrect: number;
  readonly predicted: number;
  readonly recallCorrect: number;
  readonly expected: number;
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

const precision = ({ correct, predicted, expected }: ScoreCounts): number =>
  ratio(correct, predicted, expected === 0 ? 1 : 0);

const recall = ({ correct, expected }: ScoreCounts): number => ratio(correct, expected);

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

const sameRanges = (left: readonly EvaluationRange[], right: readonly EvaluationRange[]): boolean =>
  left.length === right.length &&
  left.every(
    (range, index) =>
      range.charStart === right[index]?.charStart && range.charEnd === right[index]?.charEnd,
  );

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

const sourceSelectionsForIds = (
  fixture: GoldenEvaluationCase,
  sourceIds: readonly string[],
  useLabeledRanges: boolean,
): readonly CanonicalEvaluationSourceSelection[] =>
  sourceIds.map((sourceId) => {
    const source = fixture.evidence.find((candidate) => candidate.sourceId === sourceId);
    const labeledRanges = fixture.labels.acceptableRanges[sourceId];
    return {
      sourceId,
      ranges:
        source?.kind === "document"
          ? useLabeledRanges && labeledRanges !== undefined
            ? labeledRanges
            : source.ranges
          : [],
    };
  });

const assertExactEvaluationTokenCount = (
  topology: "specialized" | "general_planner",
  fixture: GoldenEvaluationCase,
  field: string,
  actual: number,
  expected: number,
): void => {
  if (actual !== expected) {
    throw new EvaluationInputError(
      `${topology}/${fixture.id} ${field}=${actual} does not match exact reconstructed count ${expected}`,
    );
  }
};

type ProductionTerminal = Extract<
  SpecializedEvaluationResult["productionContext"],
  { readonly mode: "single_fit" }
>["terminal"];
type ProductionLedger = ProductionTerminal["ledger"];

const usageCoordinateKey = (coordinate: {
  readonly taskId: string;
  readonly loopIteration: number;
  readonly attempt: number;
  readonly providerRequestIndex: number;
}): string =>
  [
    coordinate.taskId,
    coordinate.loopIteration,
    coordinate.attempt,
    coordinate.providerRequestIndex,
  ].join(":");

const exactInputForProductionLedger = (
  ledger: ProductionLedger,
): Exclude<ExactProductionContextInput, { readonly requestKind: "synthesis" }> => {
  if (ledger.requestKind === "synthesis") {
    throw new EvaluationInputError("synthesis packet bodies are intentionally not persisted");
  }
  return ledger.requestKind === "topic"
    ? {
        requestKind: "topic",
        topicId: ledger.topicId,
        question: ledger.question,
        selectedConversation: ledger.selectedConversation,
        gaps: ledger.gaps,
        sources: ledger.sources.map(({ sourceId, sourceKey, kind, purpose, label, ranges }) => ({
          sourceId,
          sourceKey,
          kind,
          purpose,
          label,
          ranges,
        })),
        requestedOutputTokens: ledger.requestedOutputTokens,
      }
    : {
        requestKind: "direct",
        question: ledger.question,
        selectedConversation: ledger.selectedConversation,
        gaps: ledger.gaps,
        sources: ledger.sources.map(({ sourceId, sourceKey, kind, purpose, label, ranges }) => ({
          sourceId,
          sourceKey,
          kind,
          purpose,
          label,
          ranges,
        })),
        requestedOutputTokens: ledger.requestedOutputTokens,
      };
};

const attestArtifactProductionLedger = (
  fixture: GoldenEvaluationCase,
  ledger: ProductionLedger,
): void => {
  if (
    ledger.requestKind !== "synthesis" &&
    (new Set(ledger.sources.map((source) => source.candidateId)).size !== ledger.sources.length ||
      new Set(ledger.sources.map((source) => source.sourceId)).size !== ledger.sources.length ||
      new Set(ledger.sources.map((source) => source.sourceKey)).size !== ledger.sources.length)
  ) {
    throw new EvaluationInputError(
      `specialized/${fixture.id} production candidate/source bindings are not bijective`,
    );
  }
  if (ledger.requestKind === "synthesis") {
    if (
      ledger.usableInputTokens !== canonicalEvaluationUsableInputTokens() ||
      new Set(ledger.packets.map((packet) => packet.topicId)).size !== ledger.packets.length
    ) {
      throw new EvaluationInputError(
        `specialized/${fixture.id} synthesis ledger has invalid packet identities or allowance`,
      );
    }
    return;
  }
  const exact = attestExactProductionContext(fixture, exactInputForProductionLedger(ledger));
  assertExactEvaluationTokenCount(
    "specialized",
    fixture,
    `productionContext.${ledger.requestKind}.inputTokens`,
    ledger.inputTokens,
    exact.inputTokens,
  );
  if (ledger.requestSha256Hex !== exact.requestSha256Hex) {
    throw new EvaluationInputError(
      `specialized/${fixture.id} production ${ledger.requestKind} request digest mismatch`,
    );
  }
  assertExactEvaluationTokenCount(
    "specialized",
    fixture,
    `productionContext.${ledger.requestKind}.usableInputTokens`,
    ledger.usableInputTokens,
    canonicalEvaluationUsableInputTokens(),
  );
};

const assertTerminalProductionLedger = (
  fixture: GoldenEvaluationCase,
  result: SpecializedEvaluationResult,
  terminal: ProductionTerminal,
  requestKind: ProductionLedger["requestKind"],
  taskId: string,
): void => {
  if (
    terminal.ledger.requestKind !== requestKind ||
    terminal.terminalUsageCoordinate.taskId !== taskId ||
    terminal.providerInputTokens !== terminal.ledger.inputTokens
  ) {
    throw new EvaluationInputError(
      `specialized/${fixture.id} has a route-mismatched terminal production ledger`,
    );
  }
  attestArtifactProductionLedger(fixture, terminal.ledger);
  const requestId = [
    terminal.terminalUsageCoordinate.taskId,
    terminal.terminalUsageCoordinate.loopIteration,
    terminal.terminalUsageCoordinate.attempt,
    terminal.terminalUsageCoordinate.providerRequestIndex,
  ].join(":");
  if (
    !result.promptMeasurements.some(
      (measurement) =>
        measurement.requestId === requestId &&
        measurement.requestSha256Hex === terminal.ledger.requestSha256Hex &&
        measurement.localInputTokens === terminal.ledger.inputTokens &&
        measurement.providerInputTokens === terminal.ledger.inputTokens &&
        measurement.gatePassed,
    )
  ) {
    throw new EvaluationInputError(
      `specialized/${fixture.id} terminal production ledger lacks exact usage parity`,
    );
  }
};

const productionDecisionPlanValid = (
  initial: Extract<ProductionLedger, { readonly requestKind: "direct" | "topic" }>,
  terminal: Extract<ProductionLedger, { readonly requestKind: "direct" | "topic" }>,
  decisions: readonly {
    readonly candidateId: string;
    readonly action: "keep" | "range" | "omit";
    readonly ranges: readonly EvaluationRange[];
  }[],
): boolean => {
  const initialCandidates = new Map<string, { readonly kind: "conversation" | "source" }>();
  for (const entry of initial.selectedConversation) {
    initialCandidates.set(`conversation_entry:${entry.turnId}`, { kind: "conversation" });
  }
  for (const source of initial.sources) {
    initialCandidates.set(source.candidateId, { kind: "source" });
  }
  const terminalConversation = new Set(
    terminal.selectedConversation.map((entry) => `conversation_entry:${entry.turnId}`),
  );
  const terminalSources = new Map(
    terminal.sources.map((source) => [source.candidateId, source] as const),
  );
  if (
    initialCandidates.size !== initial.selectedConversation.length + initial.sources.length ||
    decisions.length !== initialCandidates.size ||
    new Set(decisions.map((decision) => decision.candidateId)).size !== decisions.length
  ) {
    return false;
  }
  return decisions.every((decision) => {
    const candidate = initialCandidates.get(decision.candidateId);
    if (candidate === undefined) return false;
    if (candidate.kind === "conversation") {
      return (
        decision.action !== "range" &&
        terminalConversation.has(decision.candidateId) === (decision.action === "keep")
      );
    }
    const initialSource = initial.sources.find(
      (source) => source.candidateId === decision.candidateId,
    )!;
    const terminalSource = terminalSources.get(decision.candidateId);
    if (decision.action === "omit") return terminalSource === undefined;
    if (terminalSource === undefined) return false;
    const expectedRanges = decision.action === "range" ? decision.ranges : initialSource.ranges;
    return (
      terminalSource.sourceId === initialSource.sourceId &&
      terminalSource.sourceKey === initialSource.sourceKey &&
      terminalSource.purpose === initialSource.purpose &&
      terminalSource.label === initialSource.label &&
      sameRanges(terminalSource.ranges, expectedRanges)
    );
  });
};

const attestProductionTopology = (
  fixture: GoldenEvaluationCase,
  result: SpecializedEvaluationResult,
): { readonly shouldReduce: boolean; readonly converged: boolean; readonly planValid: boolean } => {
  const production = result.productionContext;
  if (production.mode === "clarification") {
    const resolver = production.resolverRequest;
    const exact = attestExactConversationResolverRequest(
      fixture,
      resolver.conversation,
      resolver.currentDate,
    );
    const requestId = usageCoordinateKey(resolver.terminalUsageCoordinate);
    const valid = result.promptMeasurements.some(
      (measurement) =>
        measurement.requestId === requestId &&
        measurement.requestSha256Hex === resolver.requestSha256Hex &&
        measurement.localInputTokens === production.providerInputTokens &&
        measurement.providerInputTokens === production.providerInputTokens &&
        measurement.gatePassed,
    );
    if (
      !valid ||
      resolver.terminalUsageCoordinate.taskId !== "resolve-conversation" ||
      resolver.currentUserMessageId.length === 0 ||
      resolver.inputTokens !== exact.inputTokens ||
      resolver.usableInputTokens !== exact.usableInputTokens ||
      resolver.requestSha256Hex !== exact.requestSha256Hex ||
      resolver.requestedOutputTokens !== 2048
    ) {
      throw new EvaluationInputError(
        `specialized/${fixture.id} clarification lacks exact resolver usage`,
      );
    }
    return { shouldReduce: false, converged: true, planValid: true };
  }
  if (production.mode === "single_fit") {
    if (production.initial.requestKind !== "direct") {
      throw new EvaluationInputError(`specialized/${fixture.id} single-fit ledger is not direct`);
    }
    attestArtifactProductionLedger(fixture, production.initial);
    assertTerminalProductionLedger(fixture, result, production.terminal, "direct", "single-answer");
    const valid =
      production.initial.inputTokens <= production.initial.usableInputTokens &&
      canonicalValue(production.initial) !== undefined &&
      JSON.stringify(canonicalValue(production.initial)) ===
        JSON.stringify(canonicalValue(production.terminal.ledger));
    return { shouldReduce: false, converged: valid, planValid: valid };
  }
  if (production.mode === "single_reduced") {
    if (
      production.initial.requestKind !== "direct" ||
      production.terminal.ledger.requestKind !== "direct"
    ) {
      throw new EvaluationInputError(
        `specialized/${fixture.id} single-reduced ledger is not direct`,
      );
    }
    attestArtifactProductionLedger(fixture, production.initial);
    assertTerminalProductionLedger(fixture, result, production.terminal, "direct", "single-answer");
    const planValid = productionDecisionPlanValid(
      production.initial,
      production.terminal.ledger,
      production.decisions,
    );
    return {
      shouldReduce: true,
      converged:
        production.initial.inputTokens > production.initial.usableInputTokens &&
        production.terminal.ledger.inputTokens <= production.terminal.ledger.usableInputTokens &&
        production.iterations >= 1 &&
        production.iterations <= 2,
      planValid,
    };
  }
  let shouldReduce = false;
  let converged = true;
  let planValid = true;
  const expectedTopicIds = (["t1", "t2", "t3"] as const).slice(0, production.topics.length);
  if (
    JSON.stringify(production.topics.map((topic) => topic.topicId)) !==
    JSON.stringify(expectedTopicIds)
  ) {
    throw new EvaluationInputError(`specialized/${fixture.id} fanout topic order is not canonical`);
  }
  for (const topic of production.topics) {
    if (
      topic.initial.requestKind !== "topic" ||
      topic.terminal.ledger.requestKind !== "topic" ||
      topic.initial.topicId !== topic.topicId ||
      topic.terminal.ledger.topicId !== topic.topicId
    ) {
      throw new EvaluationInputError(`specialized/${fixture.id} has a route-mismatched topic`);
    }
    attestArtifactProductionLedger(fixture, topic.initial);
    assertTerminalProductionLedger(
      fixture,
      result,
      topic.terminal,
      "topic",
      `topic-${topic.topicId}-answer`,
    );
    shouldReduce ||= topic.reduced;
    if (topic.reduced) {
      converged &&=
        topic.initial.inputTokens > topic.initial.usableInputTokens &&
        topic.terminal.ledger.inputTokens <= topic.terminal.ledger.usableInputTokens &&
        topic.iterations >= 1 &&
        topic.iterations <= 2;
      planValid &&= productionDecisionPlanValid(
        topic.initial,
        topic.terminal.ledger,
        topic.decisions,
      );
    } else {
      converged &&=
        topic.iterations === 0 &&
        topic.decisions.length === 0 &&
        topic.initial.inputTokens <= topic.initial.usableInputTokens &&
        JSON.stringify(canonicalValue(topic.initial)) ===
          JSON.stringify(canonicalValue(topic.terminal.ledger));
    }
  }
  assertTerminalProductionLedger(
    fixture,
    result,
    production.synthesis,
    "synthesis",
    "fanout-synthesis",
  );
  if (
    production.synthesis.ledger.requestKind !== "synthesis" ||
    JSON.stringify(production.synthesis.ledger.packets.map((packet) => packet.topicId)) !==
      JSON.stringify(expectedTopicIds)
  ) {
    throw new EvaluationInputError(`specialized/${fixture.id} synthesis route mismatch`);
  }
  converged &&=
    production.synthesis.ledger.inputTokens <= production.synthesis.ledger.usableInputTokens;
  return { shouldReduce, converged, planValid };
};

export const evaluateSuite = (
  goldenInput: unknown,
  specializedInput: unknown,
  baselineInput: unknown,
  options: EvaluationOptions = {},
): EvaluationReport => {
  const golden: GoldenEvaluationSet = GoldenEvaluationSetSchema.parse(goldenInput);
  const specialized = SpecializedEvaluationResultsSchema.parse(specializedInput);
  const baseline = GeneralPlannerEvaluationResultsSchema.parse(baselineInput);
  const specializedByCase = indexExactResults(golden.cases, specialized, "specialized results");
  const baselineByCase = indexExactResults(golden.cases, baseline, "general-planner baseline");
  assertCapturePosture([...specialized, ...baseline], options.allowSyntheticCaptures === true);

  let selectedTurnCorrect = 0;
  let selectedTurnPredicted = 0;
  let selectedTurnExpected = 0;
  const retrievalFidelities: number[] = [];
  let clarifyTruePositive = 0;
  let clarifyPredicted = 0;
  let clarifyExpected = 0;
  let fanoutTruePositive = 0;
  let fanoutPredicted = 0;
  let fanoutRequired = 0;
  let fanoutRequiredSelected = 0;
  let falseDecompositions = 0;
  const selectorCounts: Record<SelectorRole, SelectorScoreCounts> = {
    A: { precisionCorrect: 0, predicted: 0, recallCorrect: 0, expected: 0 },
    B: { precisionCorrect: 0, predicted: 0, recallCorrect: 0, expected: 0 },
    W: { precisionCorrect: 0, predicted: 0, recallCorrect: 0, expected: 0 },
  };
  let promptMeasurements = 0;
  let promptParityMatches = 0;
  const reductionValid: number[] = [];
  const reductionConverged: number[] = [];
  const reductionCoverage: number[] = [];
  const reductionRangeValidity: number[] = [];
  const reductionRates: number[] = [];
  const answerScores: AnswerScore[] = [];
  const baselineAnswerScores: AnswerScore[] = [];
  let memoryCorrect = 0;
  let memoryPredicted = 0;
  let memoryExpected = 0;
  let updateCorrect = 0;
  let updatePredicted = 0;
  let sourceDefects = 0;
  let baselineSourceDefectTotal = 0;
  let pulledCount = 0;
  let serializedFromPullCount = 0;
  let serializedEligibleCount = 0;
  let citedFromSerializedCount = 0;
  let specializedSerializedContextTokens = 0;
  let baselineSerializedContextTokens = 0;
  const fanoutQualityRatios: number[] = [];
  const fanoutLatencyRatios: number[] = [];
  const fanoutCostRatios: number[] = [];

  for (const fixture of golden.cases) {
    const result = specializedByCase.get(fixture.id);
    const baselineResult = baselineByCase.get(fixture.id);
    if (result === undefined || baselineResult === undefined) {
      throw new EvaluationInputError(`missing indexed result for ${fixture.id}`);
    }

    const evidenceById = new Map(
      fixture.evidence.map((source) => [source.sourceId, source] as const),
    );
    if (
      !sameStringSet(
        result.reduction.candidateSourceIds,
        result.reduction.candidateSelections.map((selection) => selection.sourceId),
      )
    ) {
      throw new EvaluationInputError(
        `specialized/${fixture.id} candidate selections do not match candidate source IDs`,
      );
    }
    const exactCandidateTokens = measureCanonicalEvaluationRequestTokens(
      fixture,
      result.reduction.candidateSelections,
    );
    const exactSerializedTokens = measureCanonicalEvaluationRequestTokens(
      fixture,
      result.reduction.selections,
    );
    const productionAttestation = attestProductionTopology(fixture, result);
    const exactUsableInputTokens = canonicalEvaluationUsableInputTokens();
    const exactBaselineSerializedTokens = measureCanonicalEvaluationRequestTokens(
      fixture,
      sourceSelectionsForIds(fixture, baselineResult.serializedSourceIds, true),
    );
    assertExactEvaluationTokenCount(
      "specialized",
      fixture,
      "reduction.candidateTokens",
      result.reduction.candidateTokens,
      exactCandidateTokens,
    );
    assertExactEvaluationTokenCount(
      "specialized",
      fixture,
      "reduction.serializedTokens",
      result.reduction.serializedTokens,
      exactSerializedTokens,
    );
    assertExactEvaluationTokenCount(
      "specialized",
      fixture,
      "reduction.usableInputTokens",
      result.reduction.usableInputTokens,
      exactUsableInputTokens,
    );
    assertExactEvaluationTokenCount(
      "specialized",
      fixture,
      "serializedContextTokens",
      result.serializedContextTokens,
      exactSerializedTokens,
    );
    assertExactEvaluationTokenCount(
      "general_planner",
      fixture,
      "serializedContextTokens",
      baselineResult.serializedContextTokens,
      exactBaselineSerializedTokens,
    );
    specializedSerializedContextTokens += exactSerializedTokens;
    baselineSerializedContextTokens += exactBaselineSerializedTokens;
    const expectedTurns = new Set(fixture.labels.relevantTurnIds);
    if (result.conversationResolution.mode === "continue") {
      const selectedTurns = new Set(result.conversationResolution.selectedTurnIds);
      selectedTurnCorrect += setIntersectionCount(selectedTurns, expectedTurns);
      selectedTurnPredicted += selectedTurns.size;
      selectedTurnExpected += expectedTurns.size;
      if (fixture.labels.resolution.mode === "continue") {
        const termCoverage = termGroupCoverage(
          result.conversationResolution.retrievalQuestion,
          fixture.labels.resolution.requiredTermGroups,
        );
        retrievalFidelities.push(
          0.7 * termCoverage +
            0.3 *
              tokenF1(
                result.conversationResolution.retrievalQuestion,
                fixture.labels.resolution.canonicalRetrievalQuestion,
              ),
        );
      }
    } else {
      selectedTurnExpected += expectedTurns.size;
      clarifyPredicted += 1;
      if (
        fixture.labels.resolution.mode === "clarify" &&
        termGroupCoverage(
          result.conversationResolution.question,
          fixture.labels.resolution.requiredQuestionTermGroups,
        ) === 1
      ) {
        clarifyTruePositive += 1;
      }
    }
    if (fixture.labels.resolution.mode === "clarify") clarifyExpected += 1;

    const predictedFanout = result.executionPlan.mode === "fanout";
    const suitableForFanout = fixture.labels.fanoutSuitability !== "forbidden";
    if (predictedFanout) {
      fanoutPredicted += 1;
      if (suitableForFanout) fanoutTruePositive += 1;
      else falseDecompositions += 1;
    }
    if (fixture.labels.fanoutSuitability === "required") {
      fanoutRequired += 1;
      if (predictedFanout) fanoutRequiredSelected += 1;
    }

    for (const role of ["A", "B", "W"] as const) {
      const expectedRelevant = new Set(
        fixture.labels.relevantSourceIds.filter(
          (sourceId) => evidenceById.get(sourceId)?.selector === role,
        ),
      );
      const expectedRequired = new Set(
        fixture.labels.requiredSourceIds.filter(
          (sourceId) => evidenceById.get(sourceId)?.selector === role,
        ),
      );
      const selected = new Set(result.selectorSelections[role]);
      selectorCounts[role] = {
        precisionCorrect:
          selectorCounts[role].precisionCorrect + setIntersectionCount(selected, expectedRelevant),
        predicted: selectorCounts[role].predicted + selected.size,
        recallCorrect:
          selectorCounts[role].recallCorrect + setIntersectionCount(selected, expectedRequired),
        expected: selectorCounts[role].expected + expectedRequired.size,
      };
    }

    for (const measurement of [
      ...result.promptMeasurements,
      ...baselineResult.promptMeasurements,
    ]) {
      promptMeasurements += 1;
      if (
        measurement.gatePassed &&
        measurement.localInputTokens === measurement.providerInputTokens
      ) {
        promptParityMatches += 1;
      }
    }

    const shouldReduce = productionAttestation.shouldReduce;
    const selectorCandidateIds = [
      ...result.selectorSelections.A,
      ...result.selectorSelections.B,
      ...result.selectorSelections.W,
    ];
    const decisionIds = result.reduction.decisions.map((decision) => decision.sourceId);
    const keptDecisionIds = result.reduction.decisions
      .filter((decision) => decision.action !== "omit")
      .map((decision) => decision.sourceId);
    const selectedById = new Map(
      result.reduction.selections.map((selection) => [selection.sourceId, selection] as const),
    );
    const decisionsUnique = new Set(decisionIds).size === decisionIds.length;
    const selectionsUnique = selectedById.size === result.reduction.selections.length;
    const singleReduced = result.productionContext.mode === "single_reduced";
    const decisionsComplete = singleReduced
      ? sameStringSet(decisionIds, result.reduction.candidateSourceIds)
      : decisionIds.length === 0;
    const selectedSourcesCorrect = singleReduced
      ? sameStringSet(
          keptDecisionIds,
          result.reduction.selections.map((entry) => entry.sourceId),
        )
      : result.productionContext.mode === "fanout" && shouldReduce
        ? true
        : sameStringSet(
            result.reduction.candidateSourceIds,
            result.reduction.selections.map((entry) => entry.sourceId),
          );
    const decisionRangesValid = result.reduction.decisions.every((decision) => {
      if (decision.action !== "range") return true;
      const source = evidenceById.get(decision.sourceId);
      return (
        source?.kind === "document" &&
        sameRanges(decision.ranges, selectedById.get(decision.sourceId)?.ranges ?? [])
      );
    });
    const independentlyValidPlan =
      result.reduction.required === shouldReduce &&
      productionAttestation.planValid &&
      sameStringSet(result.reduction.candidateSourceIds, selectorCandidateIds) &&
      decisionsUnique &&
      selectionsUnique &&
      decisionsComplete &&
      selectedSourcesCorrect &&
      decisionRangesValid &&
      exactCandidateTokens >= exactSerializedTokens;
    reductionValid.push(independentlyValidPlan ? 1 : 0);
    const independentlyConverged =
      productionAttestation.converged &&
      (shouldReduce
        ? result.reduction.iterations >= 1 && result.reduction.iterations <= 2
        : result.reduction.iterations === 0);
    reductionConverged.push(independentlyConverged ? 1 : 0);
    const reducedSourceIds = new Set(result.reduction.selections.map((entry) => entry.sourceId));
    const requiredSourceIds = new Set(fixture.labels.requiredSourceIds);
    reductionCoverage.push(
      ratio(setIntersectionCount(reducedSourceIds, requiredSourceIds), requiredSourceIds.size),
    );
    let rangesValid = true;
    for (const selection of result.reduction.selections) {
      const source = evidenceById.get(selection.sourceId);
      if (source === undefined) {
        rangesValid = false;
        continue;
      }
      const acceptable = fixture.labels.acceptableRanges[selection.sourceId];
      if (
        acceptable !== undefined &&
        (selection.ranges.length === 0 ||
          selection.ranges.some((range) => !rangeIsCovered(range, acceptable)))
      ) {
        rangesValid = false;
      }
      if (selection.ranges.some((range) => range.charEnd > source.content.length)) {
        rangesValid = false;
      }
      if (source.kind !== "document" && selection.ranges.length > 0) rangesValid = false;
    }
    reductionRangeValidity.push(rangesValid ? 1 : 0);
    if (shouldReduce) {
      reductionRates.push(
        exactCandidateTokens === 0
          ? 0
          : (exactCandidateTokens - exactSerializedTokens) / exactCandidateTokens,
      );
    }

    const rawAnswerScore = scoreAnswer(fixture, result);
    const rawBaselineAnswerScore = scoreAnswer(fixture, baselineResult);
    let caseSourceDefects = rawAnswerScore.defects + commonSourceStageDefects(fixture, result);
    const baselineSourceDefects =
      rawBaselineAnswerScore.defects + commonSourceStageDefects(fixture, baselineResult);

    const knownSources = new Set(fixture.evidence.map((source) => source.sourceId));
    const specializedStageSources = [
      ...result.selectorSelections.A,
      ...result.selectorSelections.B,
      ...result.selectorSelections.W,
      ...result.reduction.selections.map((selection) => selection.sourceId),
    ];
    caseSourceDefects += specializedStageSources.filter(
      (sourceId) => !knownSources.has(sourceId),
    ).length;
    for (const role of ["A", "B", "W"] as const) {
      for (const sourceId of result.selectorSelections[role]) {
        if (evidenceById.get(sourceId)?.selector !== role) caseSourceDefects += 1;
      }
    }
    if (
      !sameStringSet(
        result.reduction.selections.map((selection) => selection.sourceId),
        result.serializedSourceIds,
      )
    ) {
      caseSourceDefects += 1;
    }
    if (
      (!fixture.webRequested || !fixture.webPolicyEnabled) &&
      result.selectorSelections.W.length > 0
    ) {
      caseSourceDefects += 1;
    }
    const answerScore: AnswerScore = {
      ...rawAnswerScore,
      grounding: caseSourceDefects === 0 ? rawAnswerScore.citationCorrectness : 0,
      defects: caseSourceDefects,
    };
    const baselineAnswerScore: AnswerScore = {
      ...rawBaselineAnswerScore,
      grounding: baselineSourceDefects === 0 ? rawBaselineAnswerScore.citationCorrectness : 0,
      defects: baselineSourceDefects,
    };
    answerScores.push(answerScore);
    baselineAnswerScores.push(baselineAnswerScore);
    sourceDefects += caseSourceDefects;
    baselineSourceDefectTotal += baselineSourceDefects;

    const expectedMemoryKeys = new Set(
      fixture.labels.expectedMemoryProposals.map(memoryProposalKey),
    );
    const actualMemoryKeys = new Set(result.memoryProposals.map(memoryProposalKey));
    memoryCorrect += setIntersectionCount(actualMemoryKeys, expectedMemoryKeys);
    memoryPredicted += actualMemoryKeys.size;
    memoryExpected += expectedMemoryKeys.size;
    for (const proposal of result.memoryProposals) {
      if (proposal.action === "update") {
        updatePredicted += 1;
        if (expectedMemoryKeys.has(memoryProposalKey(proposal))) updateCorrect += 1;
      }
    }

    const pulled = new Set(result.pulledSourceIds);
    const serialized = new Set(result.serializedSourceIds);
    const cited = new Set(result.answer.citationSourceIds);
    pulledCount += pulled.size;
    serializedFromPullCount += setIntersectionCount(serialized, pulled);
    if (fixture.labels.supportedClaims.length > 0) {
      serializedEligibleCount += serialized.size;
      citedFromSerializedCount += setIntersectionCount(cited, serialized);
    }

    if (predictedFanout) {
      fanoutQualityRatios.push(
        ratio(answerScore.quality, baselineAnswerScore.quality, answerScore.quality === 0 ? 1 : 0),
      );
      fanoutLatencyRatios.push(
        ratio(result.timing.timeToTerminalMs, baselineResult.timing.timeToTerminalMs),
      );
      fanoutCostRatios.push(ratio(result.usage.totalTokens, baselineResult.usage.totalTokens));
    }
  }

  const turnPrecision = precision({
    correct: selectedTurnCorrect,
    predicted: selectedTurnPredicted,
    expected: selectedTurnExpected,
  });
  const turnRecall = recall({
    correct: selectedTurnCorrect,
    predicted: selectedTurnPredicted,
    expected: selectedTurnExpected,
  });
  const selectorMetric = (role: SelectorRole, kind: "precision" | "recall"): number =>
    kind === "precision"
      ? ratio(
          selectorCounts[role].precisionCorrect,
          selectorCounts[role].predicted,
          selectorCounts[role].expected === 0 ? 1 : 0,
        )
      : ratio(selectorCounts[role].recallCorrect, selectorCounts[role].expected);
  const candidateQuality = mean(answerScores.map((score) => score.quality));
  const baselineQuality = mean(baselineAnswerScores.map((score) => score.quality));
  const candidateGrounding = mean(answerScores.map((score) => score.grounding));
  const baselineGrounding = mean(baselineAnswerScores.map((score) => score.grounding));
  const candidateContextTokens = specializedSerializedContextTokens;
  const baselineContextTokens = baselineSerializedContextTokens;
  const candidateTerminal = mean(specialized.map((result) => result.timing.timeToTerminalMs));
  const baselineTerminal = mean(baseline.map((result) => result.timing.timeToTerminalMs));
  const contextImprovement =
    baselineContextTokens === 0
      ? candidateContextTokens === 0
        ? 0
        : -1
      : (baselineContextTokens - candidateContextTokens) / baselineContextTokens;
  const terminalImprovement = (baselineTerminal - candidateTerminal) / baselineTerminal;
  const qualityDelta = candidateQuality - baselineQuality;
  const groundingDelta = candidateGrounding - baselineGrounding;
  const noQualityRegression =
    qualityDelta >= -EvaluationGateThresholds.baselineMaximumQualityRegression &&
    groundingDelta >= -EvaluationGateThresholds.baselineMaximumQualityRegression;
  const topologyJustified =
    noQualityRegression &&
    (contextImprovement >= EvaluationGateThresholds.baselineMinimumContextEfficiencyImprovement ||
      qualityDelta >= EvaluationGateThresholds.baselineMinimumAnswerQualityImprovement ||
      groundingDelta >= EvaluationGateThresholds.baselineMinimumGroundingImprovement ||
      terminalImprovement >= EvaluationGateThresholds.baselineMinimumTerminalLatencyImprovement);

  const metrics: Record<EvaluationMetricName, number> = {
    "conversation.turn_selection_f1": f1(turnPrecision, turnRecall),
    "conversation.retrieval_question_fidelity": mean(retrievalFidelities),
    "conversation.clarification_precision": precision({
      correct: clarifyTruePositive,
      predicted: clarifyPredicted,
      expected: clarifyExpected,
    }),
    "conversation.clarification_recall": ratio(clarifyTruePositive, clarifyExpected),
    "planner.fanout_precision": ratio(
      fanoutTruePositive,
      fanoutPredicted,
      fanoutRequired === 0 ? 1 : 0,
    ),
    "planner.required_fanout_recall": ratio(fanoutRequiredSelected, fanoutRequired),
    "planner.false_decomposition_rate": ratio(falseDecompositions, fanoutPredicted, 0),
    "selector.A.recall": selectorMetric("A", "recall"),
    "selector.A.precision": selectorMetric("A", "precision"),
    "selector.B.recall": selectorMetric("B", "recall"),
    "selector.B.precision": selectorMetric("B", "precision"),
    "selector.W.recall": selectorMetric("W", "recall"),
    "selector.W.precision": selectorMetric("W", "precision"),
    "prompt.exact_count_parity": ratio(promptParityMatches, promptMeasurements, 0),
    "reducer.plan_validity": mean(reductionValid),
    "reducer.convergence": mean(reductionConverged),
    "reducer.coverage": mean(reductionCoverage),
    "reducer.range_validity": mean(reductionRangeValidity),
    "reducer.token_reduction": mean(reductionRates, 0),
    "answer.factual_support": mean(answerScores.map((score) => score.factualSupport)),
    "answer.supported_claim_recall": mean(answerScores.map((score) => score.claimRecall)),
    "answer.citation_correctness": mean(answerScores.map((score) => score.citationCorrectness)),
    "answer.expected_gap_recall": mean(answerScores.map((score) => score.gapRecall)),
    "memory.proposal_precision": precision({
      correct: memoryCorrect,
      predicted: memoryPredicted,
      expected: memoryExpected,
    }),
    "memory.proposal_recall": ratio(memoryCorrect, memoryExpected),
    "memory.update_correctness": ratio(
      updateCorrect,
      updatePredicted,
      fixtureExpectedUpdates(golden) === 0 ? 1 : 0,
    ),
    "efficiency.pull_to_serialized": ratio(serializedFromPullCount, pulledCount),
    "efficiency.serialized_to_cited": ratio(citedFromSerializedCount, serializedEligibleCount),
    "source.defect_count": sourceDefects,
    "baseline.source_defect_count": baselineSourceDefectTotal,
    "latency.time_to_first_token_p95_ms": percentile(
      specialized.map((result) => result.timing.timeToFirstTokenMs),
      0.95,
    ),
    "latency.time_to_terminal_p95_ms": percentile(
      specialized.map((result) => result.timing.timeToTerminalMs),
      0.95,
    ),
    "fanout.quality_ratio": mean(fanoutQualityRatios, 0),
    "fanout.terminal_latency_ratio": mean(fanoutLatencyRatios, Number.MAX_SAFE_INTEGER),
    "fanout.token_cost_ratio": mean(fanoutCostRatios, Number.MAX_SAFE_INTEGER),
    "baseline.answer_quality_delta": qualityDelta,
    "baseline.grounding_delta": groundingDelta,
    "baseline.context_efficiency_improvement": contextImprovement,
    "baseline.terminal_latency_improvement": terminalImprovement,
    "baseline.topology_justified": topologyJustified ? 1 : 0,
  };

  const gates: EvaluationGate[] = [
    gateAtLeast(
      "conversation.turn_selection_f1",
      metrics["conversation.turn_selection_f1"],
      EvaluationGateThresholds.conversationTurnSelectionF1,
    ),
    gateAtLeast(
      "conversation.retrieval_question_fidelity",
      metrics["conversation.retrieval_question_fidelity"],
      EvaluationGateThresholds.retrievalQuestionFidelity,
    ),
    gateAtLeast(
      "conversation.clarification_precision",
      metrics["conversation.clarification_precision"],
      EvaluationGateThresholds.clarificationPrecision,
    ),
    gateAtLeast(
      "conversation.clarification_recall",
      metrics["conversation.clarification_recall"],
      EvaluationGateThresholds.clarificationRecall,
    ),
    gateAtLeast(
      "planner.fanout_precision",
      metrics["planner.fanout_precision"],
      EvaluationGateThresholds.fanoutPrecision,
    ),
    gateAtLeast(
      "planner.required_fanout_recall",
      metrics["planner.required_fanout_recall"],
      EvaluationGateThresholds.requiredFanoutRecall,
    ),
    gateAtMost(
      "planner.false_decomposition_rate",
      metrics["planner.false_decomposition_rate"],
      EvaluationGateThresholds.falseDecompositionRate,
    ),
    ...(["A", "B", "W"] as const).flatMap((role): EvaluationGate[] => [
      gateAtLeast(
        `selector.${role}.recall`,
        metrics[`selector.${role}.recall`],
        EvaluationGateThresholds.selectorRecall,
      ),
      gateAtLeast(
        `selector.${role}.precision`,
        metrics[`selector.${role}.precision`],
        EvaluationGateThresholds.selectorPrecision,
      ),
    ]),
    gateEqual(
      "prompt.exact_count_parity",
      metrics["prompt.exact_count_parity"],
      EvaluationGateThresholds.promptCountParity,
    ),
    gateEqual(
      "reducer.plan_validity",
      metrics["reducer.plan_validity"],
      EvaluationGateThresholds.reductionPlanValidity,
    ),
    gateEqual(
      "reducer.convergence",
      metrics["reducer.convergence"],
      EvaluationGateThresholds.reductionConvergence,
    ),
    gateEqual(
      "reducer.coverage",
      metrics["reducer.coverage"],
      EvaluationGateThresholds.reductionCoverage,
    ),
    gateEqual(
      "reducer.range_validity",
      metrics["reducer.range_validity"],
      EvaluationGateThresholds.reductionRangeValidity,
    ),
    gateAtLeast(
      "reducer.token_reduction",
      metrics["reducer.token_reduction"],
      EvaluationGateThresholds.oversizedTokenReduction,
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
    gateEqual(
      "memory.proposal_precision",
      metrics["memory.proposal_precision"],
      EvaluationGateThresholds.memoryProposalPrecision,
    ),
    gateEqual(
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
      -EvaluationGateThresholds.baselineMaximumQualityRegression,
    ),
    gateAtLeast(
      "baseline.grounding_delta",
      metrics["baseline.grounding_delta"],
      -EvaluationGateThresholds.baselineMaximumQualityRegression,
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

const fixtureExpectedUpdates = (golden: GoldenEvaluationSet): number =>
  golden.cases.reduce(
    (sum, fixture) =>
      sum +
      fixture.labels.expectedMemoryProposals.filter((proposal) => proposal.action === "update")
        .length,
    0,
  );
