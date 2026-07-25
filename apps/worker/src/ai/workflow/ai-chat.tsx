/** @jsxImportSource smithers-orchestrator */
import { z } from "zod";

import type { WorkerConfig } from "../../config";
import { assertFinalSourceMap } from "../product-state/finalization";
import {
  registerSmithersWorkflowMaxConcurrency,
  type CreateSmithersApi,
} from "../smithers-interop";
import {
  AiRuntimeError,
  isAiRunErrorCode,
  isRetryableAiRunError,
  type AiRunErrorCode,
} from "../runtime/errors";
import type {
  AnswerLaneResult,
  FinalSourceRecord,
  PlanTurnResult,
  MemoryExtractionArtifact,
  MemoryReference,
  InternalReference,
  TopicPacket,
  WebEvidence,
} from "../runtime/types";
import type {
  ContextAssembly,
  ContextReductionPlan,
  ContextState,
  FanoutSourceKeySet,
  MemorySelectorResult,
  SelectorBundle,
  WebSelectorResult,
} from "./operations";
import { RunAcceptanceScopeSchema, type LoadedTurn } from "./types";
import { CanonicalWorkflowOperations } from "./operations";
import { PublicProvenanceSchema } from "../runtime/source-schemas";

const CharacterRangeSchema = z
  .strictObject({
    charStart: z.number().int().min(0),
    charEnd: z.number().int().positive(),
  })
  .superRefine((range, context) => {
    if (range.charEnd <= range.charStart) {
      context.addIssue({
        code: "custom",
        path: ["charEnd"],
        message: "character ranges must be non-empty half-open intervals",
      });
    }
  });
const NormalizedDocumentRangesSchema = z
  .array(CharacterRangeSchema)
  .min(1)
  .superRefine((ranges, context) => {
    for (let index = 1; index < ranges.length; index += 1) {
      const previous = ranges[index - 1]!;
      const current = ranges[index]!;
      if (current.charStart <= previous.charEnd) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: "document ranges must be sorted, non-overlapping, and non-adjacent",
        });
      }
    }
  });
const Sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const PublicDocumentSourceIdSchema = z.string().regex(/^public:[^:\s]+$/u);
const PublisherDocumentSourceIdSchema = z.string().regex(/^publisher:[^:\s]+$/u);
const ContextDecisionSchema = z.discriminatedUnion("action", [
  z.strictObject({ id: z.string(), action: z.literal("keep"), reason: z.string() }),
  z.strictObject({
    id: z.string(),
    action: z.literal("range"),
    ranges: z.array(CharacterRangeSchema),
    reason: z.string(),
  }),
  z.strictObject({ id: z.string(), action: z.literal("omit"), reason: z.string() }),
]);
const ConversationEntrySchema = z.union([
  z.strictObject({
    turnId: z.string(),
    userMessageId: z.string(),
    userContent: z.string(),
    assistantMessageId: z.string(),
    assistantContent: z.string(),
  }),
  z.strictObject({
    turnId: z.string(),
    userMessageId: z.string(),
    userContent: z.string(),
    errorCode: z.string(),
    retryable: z.boolean(),
  }),
]);
const _MemorySnapshotSchema = z.strictObject({
  memoryId: z.string(),
  memoryRevisionId: z.string(),
  kind: z.enum(["profile", "preference", "instruction", "fact", "episode"]),
  content: z.string(),
});
const LoadedTurnSchema = z.strictObject({
  aiRunId: z.string(),
  chatId: z.string(),
  initiatingUserId: z.string(),
  userMessageId: z.string(),
  userMessage: z.string(),
  locale: z.string(),
  market: z.string(),
  currentDate: z.string(),
  citationNamespace: z.string().regex(/^cn_[A-Za-z0-9_-]{22}$/u),
  acceptanceScope: RunAcceptanceScopeSchema,
});
// Provider output contains only logical document IDs.  Durable Smithers output
// keeps the server-owned binding that retrieval resolved before the task ended.
const BoundInternalReferenceSchema = z.union([
  z
    .strictObject({
      kind: z.literal("document"),
      documentId: z.string(),
      versionId: z.string(),
      publisherExtractionId: z.string().optional(),
      source: z.union([
        z.strictObject({ kind: z.literal("public"), sourceId: z.string() }),
        z.strictObject({
          kind: z.literal("publisher"),
          sourceId: z.string(),
          issueId: z.string(),
          documentId: z.string(),
        }),
      ]),
      ranges: z.array(CharacterRangeSchema).optional(),
      purpose: z.string(),
    })
    .superRefine((reference, context) => {
      if (
        reference.source.kind === "publisher" &&
        (reference.source.documentId !== reference.documentId ||
          reference.publisherExtractionId === undefined)
      ) {
        context.addIssue({
          code: "custom",
          message: "publisher source documentId must match reference",
        });
      }
      if (reference.source.kind === "public" && reference.publisherExtractionId !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["publisherExtractionId"],
          message: "public source cannot carry publisher extraction identity",
        });
      }
    }),
  z.strictObject({ kind: z.literal("chat_message"), messageId: z.string(), purpose: z.string() }),
]);
const PlanTurnWorkflowSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("clarify"), question: z.string() }),
  z.strictObject({
    mode: z.literal("single"),
    question: z.string(),
    relevantTurnIds: z.array(z.string()),
  }),
  z.strictObject({
    mode: z.literal("fanout"),
    question: z.string(),
    topics: z
      .array(
        z.strictObject({
          topicId: z.enum(["t1", "t2", "t3"]),
          question: z.string(),
          relevantTurnIds: z.array(z.string()),
        }),
      )
      .min(2)
      .max(3),
  }),
]);
const MemoryReferenceSchema = z.strictObject({
  memoryId: z.string(),
  memoryRevisionId: z.string(),
});
const WebEvidenceSchema = z.strictObject({
  url: z.string(),
  title: z.string(),
  domain: z.string(),
  quote: z.string(),
  publishedAt: z.string().optional(),
  capturedAt: z.string(),
  purpose: z.string(),
});
const MemorySelectorResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("disabled"),
    reason: z.literal("memory_mode_disabled"),
  }),
  z.strictObject({
    status: z.literal("enabled"),
    entries: z.array(MemoryReferenceSchema),
  }),
]);
const WebSelectorResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("disabled"),
    reason: z.enum(["not_requested", "policy_disabled"]),
  }),
  z.strictObject({
    status: z.literal("enabled"),
    entries: z.array(WebEvidenceSchema),
  }),
]);

const memorySelectorEntries = (result: MemorySelectorResult): readonly MemoryReference[] =>
  result.status === "enabled" ? result.entries : [];
const webSelectorEntries = (result: WebSelectorResult): readonly WebEvidence[] =>
  result.status === "enabled" ? result.entries : [];
const ProviderToolCallSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()),
});
const ProviderMessageSchema = z.union([
  z.strictObject({ role: z.literal("system"), content: z.string() }),
  z.strictObject({ role: z.literal("user"), content: z.string() }),
  z.strictObject({
    role: z.literal("assistant"),
    content: z.string(),
    toolCalls: z.array(ProviderToolCallSchema).optional(),
  }),
  z.strictObject({
    role: z.literal("tool"),
    toolCallId: z.string(),
    name: z.string(),
    content: z.string(),
  }),
]);
const ProviderRequestSchema = z.strictObject({
  requestClass: z.enum(["fast", "main"]),
  // Smithers output is durable live chat state. Historical GLM-5.2 captures
  // are evaluation-only and must fail closed before a resumed Pi call.
  model: z.literal("glm-5-turbo"),
  messages: z.array(ProviderMessageSchema),
  tools: z
    .array(
      z.strictObject({
        name: z.string(),
        description: z.string(),
        parameters: z.record(z.string(), z.unknown()),
      }),
    )
    .optional(),
  toolChoice: z
    .union([z.enum(["auto", "required", "none"]), z.strictObject({ name: z.string() })])
    .optional(),
  responseSchema: z.record(z.string(), z.unknown()).optional(),
  requestedOutputTokens: z.number().int().positive(),
  reasoning: z.enum(["minimal", "low", "medium", "high"]),
});
const DocumentCandidateSchema = z
  .strictObject({
    id: z.string(),
    kind: z.literal("document"),
    rank: z.number().int().nonnegative(),
    purpose: z.string(),
    sourceId: z.string(),
    documentId: z.string(),
    versionId: z.string(),
    publisherExtractionId: z.string().trim().min(1).optional(),
    publisherIssueId: z.string().optional(),
    publisherDocumentId: z.string().optional(),
    contentHash: Sha256HexSchema,
    text: z.string(),
    ranges: NormalizedDocumentRangesSchema,
    label: z.string().nullable(),
    publicProvenance: PublicProvenanceSchema,
    renderedTokenCount: z.number().int().nonnegative(),
  })
  .superRefine((candidate, context) => {
    const hasPublisherIssue = candidate.publisherIssueId !== undefined;
    const hasPublisherDocument = candidate.publisherDocumentId !== undefined;
    if (hasPublisherIssue !== hasPublisherDocument) {
      context.addIssue({
        code: "custom",
        path: ["publisherIssueId"],
        message: "publisher document identity must include both publisher fields",
      });
      return;
    }
    if (hasPublisherIssue) {
      if (candidate.publisherExtractionId === undefined) {
        context.addIssue({
          code: "custom",
          path: ["publisherExtractionId"],
          message: "publisher document candidates require an extraction binding",
        });
      }
      if (!PublisherDocumentSourceIdSchema.safeParse(candidate.sourceId).success) {
        context.addIssue({
          code: "custom",
          path: ["sourceId"],
          message: "publisher document candidates require a canonical publisher sourceId",
        });
      }
      if (candidate.publisherDocumentId !== candidate.documentId) {
        context.addIssue({
          code: "custom",
          path: ["publisherDocumentId"],
          message: "publisherDocumentId must equal documentId",
        });
      }
    } else if (!PublicDocumentSourceIdSchema.safeParse(candidate.sourceId).success) {
      context.addIssue({
        code: "custom",
        path: ["sourceId"],
        message: "public document candidates require a canonical public sourceId",
      });
    }
  });

const CandidateSchema = z.discriminatedUnion("kind", [
  DocumentCandidateSchema,
  z.strictObject({
    id: z.string(),
    kind: z.literal("chat_message"),
    rank: z.number().int().nonnegative(),
    purpose: z.string(),
    messageId: z.string(),
    text: z.string(),
    label: z.string().nullable(),
    renderedTokenCount: z.number().int().nonnegative(),
  }),
  z.strictObject({
    id: z.string(),
    kind: z.literal("memory"),
    rank: z.number().int().nonnegative(),
    purpose: z.string(),
    memoryId: z.string(),
    memoryRevisionId: z.string(),
    text: z.string(),
    label: z.string().nullable(),
    renderedTokenCount: z.number().int().nonnegative(),
  }),
  z.strictObject({
    id: z.string(),
    kind: z.literal("web"),
    rank: z.number().int().nonnegative(),
    purpose: z.string(),
    url: z.string(),
    title: z.string(),
    domain: z.string(),
    quote: z.string(),
    quoteHash: z.string(),
    publishedAt: z.string().optional(),
    capturedAt: z.string(),
    label: z.string().nullable(),
    renderedTokenCount: z.number().int().nonnegative(),
  }),
]);
const SourceUseSchema = z.strictObject({
  consumerTaskId: z.string(),
  topicId: z.enum(["t1", "t2", "t3"]).optional(),
  contextOrder: z.number().int().nonnegative(),
  renderedTokenCount: z.number().int().nonnegative(),
  ranges: z.array(CharacterRangeSchema),
});
const PublicDocumentLocatorSchema = z.strictObject({
  kind: z.literal("document"),
  sourceId: PublicDocumentSourceIdSchema,
  documentId: z.string(),
  versionId: z.string(),
  contentHash: Sha256HexSchema,
  ranges: NormalizedDocumentRangesSchema,
});
const PublisherDocumentLocatorSchema = z
  .strictObject({
    kind: z.literal("document"),
    sourceId: PublisherDocumentSourceIdSchema,
    documentId: z.string(),
    versionId: z.string(),
    contentHash: Sha256HexSchema,
    ranges: NormalizedDocumentRangesSchema,
    publisherExtractionId: z.string().trim().min(1),
    publisherIssueId: z.string().trim().min(1),
    publisherDocumentId: z.string().trim().min(1),
  })
  .superRefine((locator, context) => {
    if (locator.publisherDocumentId !== locator.documentId) {
      context.addIssue({
        code: "custom",
        path: ["publisherDocumentId"],
        message: "publisherDocumentId must equal documentId",
      });
    }
  });
const SourceLocatorSchema = z.union([
  PublicDocumentLocatorSchema,
  PublisherDocumentLocatorSchema,
  z.strictObject({ kind: z.literal("chat_message"), messageId: z.string() }),
  z.strictObject({ kind: z.literal("memory"), memoryId: z.string(), memoryRevisionId: z.string() }),
  z.strictObject({
    kind: z.literal("web"),
    url: z.string(),
    title: z.string(),
    domain: z.string(),
    quote: z.string(),
    quoteHash: z.string(),
    publishedAt: z.string().optional(),
    capturedAt: z.string(),
  }),
]);
const SourceRecordSchema = z.strictObject({
  sourceKey: z.string(),
  locator: SourceLocatorSchema,
  label: z.string().nullable(),
  publicProvenance: PublicProvenanceSchema,
  uses: z.array(SourceUseSchema).min(1),
});
const ContextAssemblySchema = z.strictObject({
  question: z.string(),
  topicId: z.enum(["t1", "t2", "t3"]).optional(),
  candidates: z.array(CandidateSchema),
  sourceMap: z.array(SourceRecordSchema),
  selectedConversation: z.array(ConversationEntrySchema),
  gaps: z.array(z.string()),
  consumerTaskId: z.string(),
  requestedOutputTokens: z.number().int().positive(),
});
const ContextSchema = z.strictObject({
  status: z.enum(["ready", "needs_reduction", "failed"]),
  question: z.string(),
  topicId: z.enum(["t1", "t2", "t3"]).optional(),
  candidates: z.array(CandidateSchema),
  sourceMap: z.array(SourceRecordSchema),
  ledgerCandidates: z.array(CandidateSchema),
  ledgerSourceMap: z.array(SourceRecordSchema),
  selectedConversation: z.array(ConversationEntrySchema),
  ledgerConversation: z.array(ConversationEntrySchema).optional(),
  ledgerConversationTokenCounts: z.array(z.number().int()).optional(),
  consumers: z.array(
    z.strictObject({
      consumer: z.enum(["direct", "topic", "synthesis"]),
      topicId: z.enum(["t1", "t2", "t3"]).optional(),
      inputTokens: z.number().int(),
      requestedOutputTokens: z.number().int().positive(),
      usableInputTokens: z.number().int(),
    }),
  ),
  gaps: z.array(z.string()),
  ledgerGaps: z.array(z.string()).optional(),
  reductionFeedback: z.array(z.string()),
  request: ProviderRequestSchema,
  inputTokens: z.number().int(),
  usableInputTokens: z.number().int(),
  reductionRan: z.boolean(),
  failureCode: z
    .enum([
      "context_mandatory_too_large",
      "context_plan_unfit",
      "context_budget_mismatch",
      "synthesis_budget_mismatch",
      "context_assembly_failed",
      "unsupported_policy",
    ])
    .optional(),
});
const AnswerSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("ok"),
    mode: z.enum(["clarification", "single", "synthesis"]),
    content: z.string(),
    sourceMap: z.array(SourceRecordSchema),
  }),
  z.strictObject({ status: z.literal("failed"), code: z.string(), retryable: z.boolean() }),
]);
const MemoryExtractionResultSchema = z.strictObject({
  proposals: z.array(
    z.strictObject({
      kind: z.enum(["profile", "preference", "instruction", "fact", "episode"]),
      content: z.string(),
      targetMemoryId: z.string().optional(),
      expectedHeadRevisionId: z.string().optional(),
    }),
  ),
  discardedCount: z.number().int().min(0),
});
const MemoryExtractionSchema = z.strictObject({
  result: MemoryExtractionResultSchema,
  producer: z.strictObject({
    taskId: z.enum(["memory-extract", "evaluation-general-planner"]),
    loopIteration: z.number().int().min(0),
    attempt: z.number().int().min(0),
    observationKey: z.string().min(1),
    extractionSha256Hex: z.string().regex(/^[a-f0-9]{64}$/),
  }),
});
const TopicPacketSchema = z.strictObject({
  topicId: z.enum(["t1", "t2", "t3"]),
  status: z.enum(["answered", "partial"]),
  claims: z.array(z.strictObject({ text: z.string(), sourceKeys: z.array(z.string()) })),
  gaps: z.array(z.string()),
});

export const aiChatSchemas = {
  input: z.strictObject({ aiRunId: z.string() }),
  aiChatLoadTurn: z.strictObject({ value: LoadedTurnSchema }),
  aiChatMemory: z.strictObject({ value: MemoryExtractionSchema }),
  aiChatPlanTurn: z.strictObject({ value: PlanTurnWorkflowSchema }),
  aiChatInternal: z.strictObject({ value: z.array(BoundInternalReferenceSchema) }),
  aiChatMemories: z.strictObject({ value: MemorySelectorResultSchema }),
  aiChatWeb: z.strictObject({ value: WebSelectorResultSchema }),
  aiChatAssembly: z.strictObject({ value: ContextAssemblySchema }),
  aiChatContext: z.strictObject({ value: ContextSchema }),
  aiChatReductionPlan: z.strictObject({
    value: z.strictObject({ decisions: z.array(ContextDecisionSchema) }),
  }),
  aiChatAnswer: z.strictObject({ value: AnswerSchema }),
  aiChatAllocation: z.strictObject({
    value: z.strictObject({
      packetOutputTokens: z.number().int().positive(),
      synthesisUsableInput: z.number().int(),
      fixedSynthesisInput: z.number().int(),
    }),
  }),
  aiChatFanoutSources: z.strictObject({
    value: z.strictObject({
      sources: z.array(z.strictObject({ candidateId: z.string(), sourceKey: z.string() })),
    }),
  }),
  aiChatTopicResult: z.strictObject({
    status: z.enum(["ok", "failed"]),
    packet: TopicPacketSchema.optional(),
    code: z.string().optional(),
  }),
  aiChatFanoutCollect: z.strictObject({
    status: z.enum(["ok", "failed"]),
    packets: z.array(TopicPacketSchema),
    sourceMap: z.array(SourceRecordSchema),
    contexts: z.array(ContextSchema),
    code: z.string().optional(),
  }),
  aiChatFinalize: z.strictObject({
    status: z.enum(["succeeded", "failed"]),
    assistantMessageId: z.string().optional(),
    code: z.string().optional(),
    alreadyTerminal: z.boolean(),
  }),
};

// Smithers adds its own persisted run key to non-payload input rows when it
// re-renders a durable workflow. It is framework metadata rather than a
// product input and therefore cannot be part of the `input` table shape (the
// table reserves `runId`), but it is the one additional key accepted at the
// workflow boundary. Keep this parser strict so arbitrary input keys still
// fail closed.
export const aiChatRuntimeInputSchema = aiChatSchemas.input.extend({
  runId: z.string().optional(),
});

export type AiChatSchemas = typeof aiChatSchemas;
export type AiChatWorkflow = ReturnType<CreateSmithersApi<AiChatSchemas>["smithers"]>;

export interface AiChatWorkflowRuntime {
  readonly config: Pick<
    WorkerConfig,
    | "aiFastTaskTimeoutMs"
    | "aiAnswerTimeoutMs"
    | "aiTopicResearchMaxConcurrency"
    | "aiTopicAnswerMaxConcurrency"
    | "aiContextReductionMaxIterations"
  >;
  readonly operations: CanonicalWorkflowOperations;
}

export const AI_CHAT_SINGLE_SELECTOR_MAX_CONCURRENCY = 3;
export const AI_CHAT_MEMORY_LANE_CONCURRENCY = 1;
export const AI_CHAT_TURN_LANE_MAX_CONCURRENCY = 2;

export const aiChatSmithersMaxConcurrency = (
  config: Pick<
    AiChatWorkflowRuntime["config"],
    "aiTopicResearchMaxConcurrency" | "aiTopicAnswerMaxConcurrency"
  >,
): number =>
  AI_CHAT_MEMORY_LANE_CONCURRENCY +
  Math.max(
    AI_CHAT_SINGLE_SELECTOR_MAX_CONCURRENCY,
    config.aiTopicResearchMaxConcurrency,
    config.aiTopicAnswerMaxConcurrency,
  );

export const aiChatRetryPolicy = Object.freeze({
  backoff: "exponential" as const,
  initialDelayMs: 250,
});
const controlledFailure = (code: AiRunErrorCode): AnswerLaneResult => ({
  status: "failed",
  code,
  retryable: isRetryableAiRunError(code),
});

const parseRunId = (input: unknown): string => aiChatRuntimeInputSchema.parse(input).aiRunId;

export function buildAiChatWorkflow(
  api: CreateSmithersApi<AiChatSchemas>,
  runtime: AiChatWorkflowRuntime,
): AiChatWorkflow {
  const { Workflow, Task, Sequence, Parallel, Branch, Loop, smithers, outputs } = api;
  const fast = runtime.config.aiFastTaskTimeoutMs;
  const answerTimeout = runtime.config.aiAnswerTimeoutMs;
  const retryPolicy = aiChatRetryPolicy;

  const workflow = smithers((ctx) => {
    const load = () =>
      ctx.output(outputs.aiChatLoadTurn, { nodeId: "load-turn" }).value as LoadedTurn;
    const planTurnMaybe = ctx.outputMaybe(outputs.aiChatPlanTurn, {
      nodeId: "plan-turn",
    })?.value as PlanTurnResult | undefined;
    const topics = planTurnMaybe?.mode === "fanout" ? planTurnMaybe.topics : [];

    const ReductionLoop = ({ prefix, initialNode }: { prefix: string; initialNode: string }) => {
      const initial = ctx.outputMaybe(outputs.aiChatContext, { nodeId: initialNode })?.value as
        | ContextState
        | undefined;
      const latest = ctx.latest(outputs.aiChatContext, `${prefix}-reduce-measure`)?.value as
        | ContextState
        | undefined;
      return (
        <Loop
          id={`${prefix}-reduction-loop`}
          skipIf={initial?.status !== "needs_reduction"}
          until={latest?.status === "ready"}
          maxIterations={runtime.config.aiContextReductionMaxIterations}
          onMaxReached="return-last"
        >
          <Sequence>
            <Task
              id={`${prefix}-reduce-plan`}
              output={outputs.aiChatReductionPlan}
              retries={2}
              retryPolicy={retryPolicy}
              timeoutMs={fast}
            >
              {async () => {
                const state = (ctx.latest(outputs.aiChatContext, `${prefix}-reduce-measure`)
                  ?.value ??
                  ctx.output(outputs.aiChatContext, { nodeId: initialNode }).value) as ContextState;
                const workflowIteration = ctx.iterations?.[`${prefix}-reduction-loop`] ?? 0;
                return {
                  value: await runtime.operations.planReduction(
                    load(),
                    state,
                    `${prefix}-reduce-plan`,
                    workflowIteration,
                  ),
                };
              }}
            </Task>
            <Task
              id={`${prefix}-reduce-measure`}
              output={outputs.aiChatContext}
              retries={2}
              retryPolicy={retryPolicy}
              timeoutMs={fast}
            >
              {async () => {
                const state = (ctx.latest(outputs.aiChatContext, `${prefix}-reduce-measure`)
                  ?.value ??
                  ctx.output(outputs.aiChatContext, { nodeId: initialNode }).value) as ContextState;
                const plan = ctx.latest(outputs.aiChatReductionPlan, `${prefix}-reduce-plan`)!
                  .value as ContextReductionPlan;
                const workflowIteration = ctx.iterations?.[`${prefix}-reduction-loop`] ?? 0;
                return {
                  value: await runtime.operations.measureReduction(
                    load(),
                    state,
                    plan,
                    `${prefix}-reduce-measure`,
                    workflowIteration,
                  ),
                };
              }}
            </Task>
          </Sequence>
        </Loop>
      );
    };

    const SingleAnswerFlow = () => {
      const selected = ctx.outputMaybe(outputs.aiChatContext, { nodeId: "single-answer-route" })
        ?.value as ContextState | undefined;
      return (
        <Sequence>
          <Parallel id="single-selectors" maxConcurrency={AI_CHAT_SINGLE_SELECTOR_MAX_CONCURRENCY}>
            <Task
              id="single-retrieve-internal"
              output={outputs.aiChatInternal}
              retries={2}
              retryPolicy={retryPolicy}
              timeoutMs={fast}
            >
              {async () => {
                const plan = ctx.output(outputs.aiChatPlanTurn, {
                  nodeId: "plan-turn",
                }).value as Extract<PlanTurnResult, { mode: "single" }>;
                return {
                  value: (await runtime.operations.retrieveInternal(
                    load(),
                    plan.question,
                    "single-retrieve-internal",
                    plan.relevantTurnIds,
                  )) as readonly InternalReference[],
                };
              }}
            </Task>
            <Task
              id="single-select-memories"
              output={outputs.aiChatMemories}
              retries={2}
              retryPolicy={retryPolicy}
              timeoutMs={fast}
            >
              {async () => {
                const plan = ctx.output(outputs.aiChatPlanTurn, {
                  nodeId: "plan-turn",
                }).value as Extract<PlanTurnResult, { mode: "single" }>;
                return {
                  value: await runtime.operations.selectMemories(
                    load(),
                    plan.question,
                    "single-select-memories",
                  ),
                };
              }}
            </Task>
            <Task
              id="single-retrieve-web"
              output={outputs.aiChatWeb}
              retries={2}
              retryPolicy={retryPolicy}
              timeoutMs={fast}
            >
              {async () => {
                const plan = ctx.output(outputs.aiChatPlanTurn, {
                  nodeId: "plan-turn",
                }).value as Extract<PlanTurnResult, { mode: "single" }>;
                return {
                  value: await runtime.operations.retrieveWeb(
                    load(),
                    plan.question,
                    "single-retrieve-web",
                  ),
                };
              }}
            </Task>
          </Parallel>
          <Task
            id="single-assemble"
            output={outputs.aiChatAssembly}
            retries={2}
            retryPolicy={retryPolicy}
            timeoutMs={fast}
          >
            {async () => {
              const plan = ctx.output(outputs.aiChatPlanTurn, {
                nodeId: "plan-turn",
              }).value as Extract<PlanTurnResult, { mode: "single" }>;
              const selectors: SelectorBundle = {
                internal: ctx.output(outputs.aiChatInternal, { nodeId: "single-retrieve-internal" })
                  .value as readonly InternalReference[],
                memories: memorySelectorEntries(
                  ctx.output(outputs.aiChatMemories, { nodeId: "single-select-memories" }).value,
                ),
                memorySelection: ctx.output(outputs.aiChatMemories, {
                  nodeId: "single-select-memories",
                }).value.status,
                web: webSelectorEntries(
                  ctx.output(outputs.aiChatWeb, { nodeId: "single-retrieve-web" }).value,
                ),
                webSelection: ctx.output(outputs.aiChatWeb, { nodeId: "single-retrieve-web" }).value
                  .status,
              };
              return {
                value: await runtime.operations.assembleContext(
                  load(),
                  plan.question,
                  selectors,
                  "single-assemble",
                  "single-answer",
                  undefined,
                  plan.relevantTurnIds,
                ),
              };
            }}
          </Task>
          <Task
            id="single-measure"
            output={outputs.aiChatContext}
            retries={2}
            retryPolicy={retryPolicy}
            timeoutMs={fast}
          >
            {async () => ({
              value: await runtime.operations.measureAssembly(
                load(),
                ctx.output(outputs.aiChatAssembly, { nodeId: "single-assemble" })
                  .value as ContextAssembly,
                "single-measure",
              ),
            })}
          </Task>
          <ReductionLoop prefix="single" initialNode="single-measure" />
          <Task
            id="single-context-select"
            output={outputs.aiChatContext}
            retries={2}
            retryPolicy={retryPolicy}
            timeoutMs={fast}
          >
            {async () => {
              const state = (ctx.latest(outputs.aiChatContext, "single-reduce-measure")?.value ??
                ctx.output(outputs.aiChatContext, { nodeId: "single-measure" })
                  .value) as ContextState;
              return { value: await runtime.operations.freezeContext(load(), state) };
            }}
          </Task>
          <Task
            id="single-answer-route"
            output={outputs.aiChatContext}
            retries={2}
            retryPolicy={retryPolicy}
            timeoutMs={fast}
          >
            {async () => ({
              value: ctx.output(outputs.aiChatContext, { nodeId: "single-context-select" }).value,
            })}
          </Task>
          <Branch
            if={selected?.status === "ready"}
            then={
              <Task
                id="single-answer"
                output={outputs.aiChatAnswer}
                retries={2}
                retryPolicy={retryPolicy}
                timeoutMs={answerTimeout}
              >
                {async () => ({
                  value: await runtime.operations.answerDirect(
                    load(),
                    ctx.output(outputs.aiChatContext, { nodeId: "single-answer-route" })
                      .value as ContextState,
                    "single-answer",
                  ),
                })}
              </Task>
            }
            else={
              <Task
                id="single-failure"
                output={outputs.aiChatAnswer}
                retries={2}
                retryPolicy={retryPolicy}
                timeoutMs={fast}
              >
                {async () => ({
                  value: controlledFailure(
                    (
                      ctx.output(outputs.aiChatContext, { nodeId: "single-answer-route" })
                        .value as ContextState
                    ).failureCode ?? "context_plan_unfit",
                  ),
                })}
              </Task>
            }
          />
          <Task
            id="single-result"
            output={outputs.aiChatAnswer}
            retries={2}
            retryPolicy={retryPolicy}
            timeoutMs={fast}
          >
            {async () => ({
              value: (
                ctx.outputMaybe(outputs.aiChatAnswer, { nodeId: "single-answer" }) ??
                ctx.output(outputs.aiChatAnswer, { nodeId: "single-failure" })
              ).value,
            })}
          </Task>
        </Sequence>
      );
    };

    const TopicAnswerFlow = ({ topicId }: { topicId: "t1" | "t2" | "t3"; key?: string }) => {
      const prefix = `topic-${topicId}`;
      const selected = ctx.outputMaybe(outputs.aiChatContext, {
        nodeId: `${prefix}-answer-route`,
      })?.value as ContextState | undefined;
      return (
        <Sequence key={topicId}>
          <Task
            id={`${prefix}-assemble`}
            output={outputs.aiChatAssembly}
            retries={2}
            retryPolicy={retryPolicy}
            timeoutMs={fast}
          >
            {async () => {
              const plan = ctx.output(outputs.aiChatPlanTurn, {
                nodeId: "plan-turn",
              }).value as Extract<PlanTurnResult, { mode: "fanout" }>;
              const topic = plan.topics.find((candidate) => candidate.topicId === topicId);
              if (topic === undefined) {
                throw new AiRuntimeError("invalid_workflow_output", "fanout topic missing", {
                  taskRetryable: false,
                });
              }
              const selectors: SelectorBundle = {
                internal: ctx.output(outputs.aiChatInternal, {
                  nodeId: `${prefix}-retrieve-internal`,
                }).value as readonly InternalReference[],
                memories: memorySelectorEntries(
                  ctx.output(outputs.aiChatMemories, {
                    nodeId: `${prefix}-select-memories`,
                  }).value,
                ),
                memorySelection: ctx.output(outputs.aiChatMemories, {
                  nodeId: `${prefix}-select-memories`,
                }).value.status,
                web: webSelectorEntries(
                  ctx.output(outputs.aiChatWeb, { nodeId: `${prefix}-retrieve-web` }).value,
                ),
                webSelection: ctx.output(outputs.aiChatWeb, { nodeId: `${prefix}-retrieve-web` })
                  .value.status,
              };
              return {
                value: await runtime.operations.assembleContext(
                  load(),
                  topic.question,
                  selectors,
                  `${prefix}-assemble`,
                  `${prefix}-answer`,
                  topicId,
                  topic.relevantTurnIds,
                  ctx.output(outputs.aiChatFanoutSources, {
                    nodeId: "fanout-merge-sources",
                  }).value as FanoutSourceKeySet,
                  ctx.output(outputs.aiChatAllocation, { nodeId: "fanout-allocate" }).value
                    .packetOutputTokens,
                ),
              };
            }}
          </Task>
          <Task
            id={`${prefix}-measure`}
            output={outputs.aiChatContext}
            retries={2}
            retryPolicy={retryPolicy}
            timeoutMs={fast}
          >
            {async () => ({
              value: await runtime.operations.measureAssembly(
                load(),
                ctx.output(outputs.aiChatAssembly, { nodeId: `${prefix}-assemble` })
                  .value as ContextAssembly,
                `${prefix}-measure`,
              ),
            })}
          </Task>
          <ReductionLoop prefix={prefix} initialNode={`${prefix}-measure`} />
          <Task
            id={`${prefix}-context-select`}
            output={outputs.aiChatContext}
            retries={2}
            retryPolicy={retryPolicy}
            timeoutMs={fast}
          >
            {async () => {
              const state = (ctx.latest(outputs.aiChatContext, `${prefix}-reduce-measure`)?.value ??
                ctx.output(outputs.aiChatContext, { nodeId: `${prefix}-measure` })
                  .value) as ContextState;
              return { value: await runtime.operations.freezeContext(load(), state) };
            }}
          </Task>
          <Task
            id={`${prefix}-answer-route`}
            output={outputs.aiChatContext}
            retries={2}
            retryPolicy={retryPolicy}
            timeoutMs={fast}
          >
            {async () => ({
              value: ctx.output(outputs.aiChatContext, { nodeId: `${prefix}-context-select` })
                .value,
            })}
          </Task>
          <Branch
            if={selected?.status === "ready"}
            then={
              <Task
                id={`${prefix}-answer`}
                output={outputs.aiChatTopicResult}
                retries={2}
                retryPolicy={retryPolicy}
                timeoutMs={answerTimeout}
              >
                {async () => {
                  try {
                    return {
                      status: "ok" as const,
                      packet: await runtime.operations.answerTopic(
                        load(),
                        ctx.output(outputs.aiChatContext, { nodeId: `${prefix}-answer-route` })
                          .value as ContextState,
                        `${prefix}-answer`,
                        ctx.output(outputs.aiChatAllocation, { nodeId: "fanout-allocate" }).value
                          .packetOutputTokens,
                      ),
                    };
                  } catch (error) {
                    if (error instanceof AiRuntimeError && !error.retryable) {
                      return { status: "failed" as const, code: error.code };
                    }
                    throw error;
                  }
                }}
              </Task>
            }
            else={
              <Task
                id={`${prefix}-failure`}
                output={outputs.aiChatTopicResult}
                retries={2}
                retryPolicy={retryPolicy}
                timeoutMs={fast}
              >
                {async () => ({
                  status: "failed" as const,
                  code:
                    (
                      ctx.output(outputs.aiChatContext, { nodeId: `${prefix}-answer-route` })
                        .value as ContextState
                    ).failureCode ?? "context_plan_unfit",
                })}
              </Task>
            }
          />
          <Task
            id={`${prefix}-result`}
            output={outputs.aiChatTopicResult}
            retries={2}
            retryPolicy={retryPolicy}
            timeoutMs={fast}
          >
            {async () => {
              const result =
                ctx.outputMaybe(outputs.aiChatTopicResult, { nodeId: `${prefix}-answer` }) ??
                ctx.output(outputs.aiChatTopicResult, { nodeId: `${prefix}-failure` });
              return result.status === "ok" && result.packet !== undefined
                ? { status: "ok" as const, packet: result.packet }
                : { status: "failed" as const, code: result.code ?? "context_plan_unfit" };
            }}
          </Task>
        </Sequence>
      );
    };

    const FanoutAnswerFlow = () => {
      const synthesis = ctx.outputMaybe(outputs.aiChatContext, {
        nodeId: "fanout-synthesis-route",
      })?.value as ContextState | undefined;
      return (
        <Sequence>
          <Task
            id="fanout-allocate"
            output={outputs.aiChatAllocation}
            retries={2}
            retryPolicy={retryPolicy}
            timeoutMs={fast}
          >
            {async () => ({
              value: await runtime.operations.allocateFanout(
                load(),
                ctx.output(outputs.aiChatPlanTurn, { nodeId: "plan-turn" }).value as Extract<
                  PlanTurnResult,
                  { mode: "fanout" }
                >,
              ),
            })}
          </Task>
          <Parallel
            id="fanout-topic-research"
            maxConcurrency={runtime.config.aiTopicResearchMaxConcurrency}
          >
            {topics.flatMap((topic) => {
              const prefix = `topic-${topic.topicId}`;
              return [
                <Task
                  key={`${prefix}-a`}
                  id={`${prefix}-retrieve-internal`}
                  output={outputs.aiChatInternal}
                  retries={2}
                  retryPolicy={retryPolicy}
                  timeoutMs={fast}
                >
                  {async () => ({
                    value: (await runtime.operations.retrieveInternal(
                      load(),
                      topic.question,
                      `${prefix}-retrieve-internal`,
                      topic.relevantTurnIds,
                    )) as readonly InternalReference[],
                  })}
                </Task>,
                <Task
                  key={`${prefix}-b`}
                  id={`${prefix}-select-memories`}
                  output={outputs.aiChatMemories}
                  retries={2}
                  retryPolicy={retryPolicy}
                  timeoutMs={fast}
                >
                  {async () => ({
                    value: await runtime.operations.selectMemories(
                      load(),
                      topic.question,
                      `${prefix}-select-memories`,
                    ),
                  })}
                </Task>,
                <Task
                  key={`${prefix}-w`}
                  id={`${prefix}-retrieve-web`}
                  output={outputs.aiChatWeb}
                  retries={2}
                  retryPolicy={retryPolicy}
                  timeoutMs={fast}
                >
                  {async () => ({
                    value: await runtime.operations.retrieveWeb(
                      load(),
                      topic.question,
                      `${prefix}-retrieve-web`,
                    ),
                  })}
                </Task>,
              ];
            })}
          </Parallel>
          <Task
            id="fanout-merge-sources"
            output={outputs.aiChatFanoutSources}
            retries={2}
            retryPolicy={retryPolicy}
            timeoutMs={fast}
          >
            {async () => {
              const plan = ctx.output(outputs.aiChatPlanTurn, {
                nodeId: "plan-turn",
              }).value as Extract<PlanTurnResult, { mode: "fanout" }>;
              const selectors = Object.fromEntries(
                plan.topics.map((topic) => [
                  topic.topicId,
                  {
                    internal: ctx.output(outputs.aiChatInternal, {
                      nodeId: `topic-${topic.topicId}-retrieve-internal`,
                    }).value,
                    memories: memorySelectorEntries(
                      ctx.output(outputs.aiChatMemories, {
                        nodeId: `topic-${topic.topicId}-select-memories`,
                      }).value,
                    ),
                    memorySelection: ctx.output(outputs.aiChatMemories, {
                      nodeId: `topic-${topic.topicId}-select-memories`,
                    }).value.status,
                    web: webSelectorEntries(
                      ctx.output(outputs.aiChatWeb, {
                        nodeId: `topic-${topic.topicId}-retrieve-web`,
                      }).value,
                    ),
                    webSelection: ctx.output(outputs.aiChatWeb, {
                      nodeId: `topic-${topic.topicId}-retrieve-web`,
                    }).value.status,
                  },
                ]),
              ) as unknown as Record<"t1" | "t2" | "t3", SelectorBundle>;
              return {
                value: await runtime.operations.mergeFanoutSources(load(), plan.topics, selectors),
              };
            }}
          </Task>
          <Parallel
            id="fanout-topic-answers"
            maxConcurrency={runtime.config.aiTopicAnswerMaxConcurrency}
          >
            {topics.map((topic) => (
              <TopicAnswerFlow key={topic.topicId} topicId={topic.topicId} />
            ))}
          </Parallel>
          <Task
            id="fanout-collect"
            output={outputs.aiChatFanoutCollect}
            retries={2}
            retryPolicy={retryPolicy}
            timeoutMs={fast}
          >
            {async () => {
              const results = topics.map((topic) =>
                ctx.output(outputs.aiChatTopicResult, { nodeId: `topic-${topic.topicId}-result` }),
              );
              const failed = results.find((result) => result.status === "failed");
              const contexts = topics.map(
                (topic) =>
                  ctx.output(outputs.aiChatContext, {
                    nodeId: `topic-${topic.topicId}-context-select`,
                  }).value as ContextState,
              );
              if (failed !== undefined)
                return {
                  status: "failed" as const,
                  packets: [],
                  sourceMap: [],
                  contexts,
                  code: failed.code ?? "context_plan_unfit",
                };
              const packets = results.flatMap((result) =>
                result.packet === undefined ? [] : [result.packet],
              );
              if (packets.length !== results.length)
                return {
                  status: "failed" as const,
                  packets: [],
                  sourceMap: [],
                  contexts,
                  code: "context_plan_unfit",
                };
              return {
                status: "ok" as const,
                packets,
                sourceMap: runtime.operations.mergeFanoutSourceMaps(contexts),
                contexts,
              };
            }}
          </Task>
          <Task
            id="fanout-synthesis-measure"
            output={outputs.aiChatContext}
            retries={2}
            retryPolicy={retryPolicy}
            timeoutMs={fast}
          >
            {async () => {
              const collected = ctx.output(outputs.aiChatFanoutCollect, {
                nodeId: "fanout-collect",
              });
              return {
                value:
                  collected.status === "ok"
                    ? await runtime.operations.synthesisContext(
                        load(),
                        collected.packets as TopicPacket[],
                        collected.sourceMap as FinalSourceRecord[],
                        collected.contexts as ContextState[],
                        ctx.output(outputs.aiChatAllocation, { nodeId: "fanout-allocate" }).value,
                      )
                    : await runtime.operations.synthesisContext(
                        load(),
                        [],
                        [],
                        collected.contexts as ContextState[],
                        ctx.output(outputs.aiChatAllocation, { nodeId: "fanout-allocate" }).value,
                      ),
              };
            }}
          </Task>
          <Task
            id="fanout-synthesis-route"
            output={outputs.aiChatContext}
            retries={2}
            retryPolicy={retryPolicy}
            timeoutMs={fast}
          >
            {async () => ({
              value: ctx.output(outputs.aiChatContext, { nodeId: "fanout-synthesis-measure" })
                .value,
            })}
          </Task>
          <Branch
            if={synthesis?.status === "ready"}
            then={
              <Task
                id="fanout-synthesis"
                output={outputs.aiChatAnswer}
                retries={2}
                retryPolicy={retryPolicy}
                timeoutMs={answerTimeout}
              >
                {async () => ({
                  value: await runtime.operations.synthesize(
                    load(),
                    ctx.output(outputs.aiChatContext, { nodeId: "fanout-synthesis-route" })
                      .value as ContextState,
                    "fanout-synthesis",
                  ),
                })}
              </Task>
            }
            else={
              <Task
                id="fanout-synthesis-failure"
                output={outputs.aiChatAnswer}
                retries={2}
                retryPolicy={retryPolicy}
                timeoutMs={fast}
              >
                {async () => {
                  const collected = ctx.output(outputs.aiChatFanoutCollect, {
                    nodeId: "fanout-collect",
                  });
                  const code =
                    collected.status === "failed" &&
                    collected.code !== undefined &&
                    isAiRunErrorCode(collected.code)
                      ? collected.code
                      : "synthesis_budget_mismatch";
                  return { value: controlledFailure(code) };
                }}
              </Task>
            }
          />
          <Task
            id="fanout-result"
            output={outputs.aiChatAnswer}
            retries={2}
            retryPolicy={retryPolicy}
            timeoutMs={fast}
          >
            {async () => ({
              value: (
                ctx.outputMaybe(outputs.aiChatAnswer, { nodeId: "fanout-synthesis" }) ??
                ctx.output(outputs.aiChatAnswer, { nodeId: "fanout-synthesis-failure" })
              ).value,
            })}
          </Task>
        </Sequence>
      );
    };

    const AnswerLane = () => (
      <Sequence>
        <Branch
          if={planTurnMaybe?.mode === "clarify"}
          then={
            <Task
              id="clarification-result"
              output={outputs.aiChatAnswer}
              retries={2}
              retryPolicy={retryPolicy}
              timeoutMs={fast}
            >
              {async () => ({
                value: await runtime.operations.clarify(
                  load(),
                  (
                    ctx.output(outputs.aiChatPlanTurn, { nodeId: "plan-turn" }).value as Extract<
                      PlanTurnResult,
                      { mode: "clarify" }
                    >
                  ).question,
                ),
              })}
            </Task>
          }
          else={
            <Branch
              if={planTurnMaybe?.mode === "fanout"}
              then={<FanoutAnswerFlow />}
              else={<SingleAnswerFlow />}
            />
          }
        />
        <Task
          id="answer-select"
          output={outputs.aiChatAnswer}
          retries={2}
          retryPolicy={retryPolicy}
          timeoutMs={fast}
        >
          {async () => {
            const answer = (
              ctx.outputMaybe(outputs.aiChatAnswer, { nodeId: "clarification-result" }) ??
              ctx.outputMaybe(outputs.aiChatAnswer, { nodeId: "single-result" }) ??
              ctx.output(outputs.aiChatAnswer, { nodeId: "fanout-result" })
            ).value as AnswerLaneResult;
            if (answer.status === "ok") {
              assertFinalSourceMap(answer, load().citationNamespace);
            }
            return { value: answer };
          }}
        </Task>
      </Sequence>
    );

    return (
      <Workflow name="ai-chat">
        <Sequence>
          <Task
            id="load-turn"
            output={outputs.aiChatLoadTurn}
            retries={2}
            retryPolicy={retryPolicy}
            timeoutMs={fast}
          >
            {async () => ({ value: await runtime.operations.loadTurn(parseRunId(ctx.input)) })}
          </Task>
          <Task
            id="plan-turn"
            output={outputs.aiChatPlanTurn}
            retries={2}
            retryPolicy={retryPolicy}
            timeoutMs={fast}
          >
            {async () => {
              const value = await runtime.operations.planTurn(load());
              if (value.mode === "fanout") {
                return {
                  value: {
                    ...value,
                    topics: value.topics.map((topic) => ({ ...topic })),
                  },
                };
              }
              return { value };
            }}
          </Task>
          {planTurnMaybe ? (
            <Sequence>
              <Parallel id="turn-lanes" maxConcurrency={AI_CHAT_TURN_LANE_MAX_CONCURRENCY}>
                <Task
                  id="memory-extract"
                  output={outputs.aiChatMemory}
                  retries={2}
                  retryPolicy={retryPolicy}
                  timeoutMs={fast}
                >
                  {async () => {
                    return {
                      value: await runtime.operations.extractMemory(load()),
                    };
                  }}
                </Task>
                <AnswerLane />
              </Parallel>
              <Task
                id="finalize"
                output={outputs.aiChatFinalize}
                retries={2}
                retryPolicy={retryPolicy}
                timeoutMs={fast}
              >
                {async () => {
                  const terminal = await runtime.operations.finalize(
                    load(),
                    ctx.output(outputs.aiChatAnswer, { nodeId: "answer-select" })
                      .value as AnswerLaneResult,
                    MemoryExtractionSchema.parse(
                      ctx.output(outputs.aiChatMemory, { nodeId: "memory-extract" }).value,
                    ) as MemoryExtractionArtifact,
                    `ai-chat:${load().aiRunId}`,
                  );
                  return terminal.status === "succeeded"
                    ? {
                        status: "succeeded" as const,
                        assistantMessageId: terminal.assistantMessageId,
                        alreadyTerminal: terminal.alreadyTerminal,
                      }
                    : {
                        status: "failed" as const,
                        code: terminal.code,
                        alreadyTerminal: terminal.alreadyTerminal,
                      };
                }}
              </Task>
            </Sequence>
          ) : null}
        </Sequence>
      </Workflow>
    );
  });

  return registerSmithersWorkflowMaxConcurrency(
    workflow,
    aiChatSmithersMaxConcurrency(runtime.config),
  );
}
