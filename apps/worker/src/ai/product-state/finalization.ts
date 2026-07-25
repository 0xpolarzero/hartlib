import { PgClient } from "@effect/sql-pg";
import { Effect } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { z } from "zod";
import {
  canonicalPublicSourceHttpsUrl,
  isCanonicalPublicDocumentSourceId,
  isCanonicalPublisherDocumentSourceId,
  parseRunAcceptanceScope,
  publisherIssueAdvisoryLockKey,
  type RunAcceptanceScope,
} from "@brief/shared";

import { isRetryableAiRunError, type AiRunErrorCode } from "../runtime/errors";
import {
  canonicalizeWebUrl,
  chatMessageEvidenceIdentity,
  memoryEvidenceIdentity,
  namespacedDocumentEvidenceIdentity,
  normalizeCharacterRanges,
  normalizeWebQuote,
  memoryExtractionSha256Hex,
  sha256Base64Url,
  webEvidenceIdentity,
  webQuoteHash,
} from "../runtime/canonicalization";
import { PublicProvenanceSchema } from "../runtime/source-schemas";
import {
  providerVisibleSourceExposureProofSha256Hex,
  type ProviderVisibleSourceExposureMarker,
} from "../runtime/provider-request";
import type {
  AnswerLaneResult,
  FinalSourceRecord,
  MemoryExtractionArtifact,
} from "../runtime/types";
import { parseCurrentTurnCitations } from "./citations";
import { appendAiRunEventInTransaction } from "./events";
import {
  applyMemoryProposalsInTransaction,
  type AppliedMemoryChanges,
  type MemoryConflictError,
} from "./memory";
import {
  appendAggregateAiRunUsageInTransaction,
  assertCanonicalDocumentExposureIdentity,
  deriveAggregateAiRunUsage,
  insertAiObservation,
  type AggregateAiRunUsage,
} from "./observability";

interface RunRow {
  readonly id: string;
  readonly chatId: string;
  readonly initiatingUserId: string;
  readonly smithersRunId: string | null;
  readonly assistantMessageId: string | null;
  readonly errorCode: AiRunErrorCode | null;
  readonly retryable: boolean | null;
  readonly finishedAt: Date | null;
  readonly failedAt: Date | null;
  readonly citationNamespace: string;
  readonly acceptanceScope: unknown;
}

/**
 * The handler's durable Smithers coordinate fence failed.  This is a typed
 * failure so callers can preserve both product and Smithers state rather than
 * attempting a best-effort terminal transition or cleanup against an
 * untrusted coordinate.
 */
export class AiRunSmithersRunIdMismatch extends Error {
  constructor(
    readonly aiRunId: string,
    readonly actualSmithersRunId: string | null,
    readonly expectedSmithersRunId: string,
  ) {
    super(
      `ai run ${aiRunId} has Smithers identity ${actualSmithersRunId ?? "null"}; expected ${expectedSmithersRunId}`,
    );
    this.name = "AiRunSmithersRunIdMismatch";
  }
}

interface IdRow {
  readonly id: string;
}

interface RunExecutionScope {
  readonly chatId: string;
  readonly companyId: string;
  readonly initiatingUserId: string;
}

export interface FinalizeAiRunInput {
  readonly runId: string;
  /** The durable Smithers coordinate owned by the currently executing workflow. */
  readonly expectedSmithersRunId: string;
  readonly answer: AnswerLaneResult;
  readonly memory: MemoryExtractionArtifact;
  readonly coordinates: {
    readonly loopIteration: number;
    readonly attempt: number;
  };
}

const MemoryExtractionObservationPayloadSchema = z
  .object({
    proposalCount: z.number().int().nonnegative(),
    discardedCount: z.number().int().nonnegative(),
    extractionSha256Hex: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

const MemoryApplicationObservationPayloadSchema = z
  .object({
    extractionTaskId: z.string().trim().min(1),
    extractionLoopIteration: z.number().int().nonnegative(),
    extractionAttempt: z.number().int().nonnegative(),
    extractionObservationKey: z.string().trim().min(1),
    extractionSha256Hex: z.string().regex(/^[a-f0-9]{64}$/),
    proposalCount: z.number().int().nonnegative(),
    discardedCount: z.number().int().nonnegative(),
  })
  .strict();

const MemoryWrittenObservationPayloadSchema = z
  .object({
    ordinal: z.number().int().nonnegative(),
    memoryId: z.string().uuid(),
    revisionId: z.string().uuid(),
    previousRevisionId: z.string().uuid().nullable(),
    action: z.enum(["create", "update"]),
  })
  .strict();

const MemoryExtractionArtifactSchema = z
  .object({
    result: z
      .object({
        proposals: z.array(
          z
            .object({
              kind: z.enum(["profile", "preference", "instruction", "fact", "episode"]),
              content: z.string().trim().min(1),
              targetMemoryId: z.string().uuid().optional(),
              expectedHeadRevisionId: z.string().uuid().optional(),
            })
            .strict()
            .superRefine((proposal, context) => {
              if (
                (proposal.targetMemoryId === undefined) !==
                (proposal.expectedHeadRevisionId === undefined)
              ) {
                context.addIssue({
                  code: "custom",
                  message: "memory update target and expected head must be supplied together",
                });
              }
            }),
        ),
        discardedCount: z.number().int().nonnegative(),
      })
      .strict(),
    producer: z
      .object({
        taskId: z.enum(["memory-extract", "evaluation-general-planner"]),
        loopIteration: z.number().int().nonnegative(),
        attempt: z.number().int().nonnegative(),
        observationKey: z.string().min(1).max(512),
        extractionSha256Hex: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
  })
  .strict();

/**
 * The durable plan includes the topic identities that the provider boundary
 * adds after parsing.  Reparse that stored value here instead of inspecting
 * a few fields and silently dropping malformed nested values.
 */
const DurableTurnPlanSchema = z
  .discriminatedUnion("mode", [
    z.object({ mode: z.literal("clarify"), question: z.string().trim().min(1) }).strict(),
    z
      .object({
        mode: z.literal("single"),
        question: z.string().trim().min(1),
        relevantTurnIds: z.array(z.string().trim().min(1)),
      })
      .strict(),
    z
      .object({
        mode: z.literal("fanout"),
        question: z.string().trim().min(1),
        topics: z
          .array(
            z
              .object({
                topicId: z.enum(["t1", "t2", "t3"]),
                question: z.string().trim().min(1),
                relevantTurnIds: z.array(z.string().trim().min(1)),
              })
              .strict(),
          )
          .min(2)
          .max(3)
          .superRefine((topics, context) => {
            const expected = ["t1", "t2", "t3"];
            for (const [index, topic] of topics.entries()) {
              if (topic.topicId !== expected[index]) {
                context.addIssue({
                  code: "custom",
                  path: [index, "topicId"],
                  message: "fanout topic IDs must be ordered t1, t2, t3",
                });
              }
            }
            if (new Set(topics.map((topic) => topic.question)).size !== topics.length) {
              context.addIssue({
                code: "custom",
                message: "fanout topic questions must be unique",
              });
            }
          }),
      })
      .strict(),
  ])
  .superRefine((plan, context) => {
    const selectedTurnIds =
      plan.mode === "clarify"
        ? []
        : plan.mode === "single"
          ? plan.relevantTurnIds
          : plan.topics.flatMap((topic) => topic.relevantTurnIds);
    if (new Set(selectedTurnIds).size !== selectedTurnIds.length) {
      context.addIssue({ code: "custom", message: "selected turn IDs must be unique" });
    }
  });

const EvaluationTurnPlanSchema = z
  .discriminatedUnion("mode", [
    z.object({ mode: z.literal("clarify"), question: z.string().trim().min(1) }).strict(),
    z
      .object({
        mode: z.literal("single"),
        question: z.string().trim().min(1),
        relevantTurnIds: z.array(z.string().trim().min(1)),
      })
      .strict(),
    z
      .object({
        mode: z.literal("fanout"),
        question: z.string().trim().min(1),
        topics: z
          .array(
            z
              .object({
                topicId: z.enum(["t1", "t2", "t3"]),
                question: z.string().trim().min(1),
                relevantTurnIds: z.array(z.string().trim().min(1)),
              })
              .strict(),
          )
          .min(2)
          .max(3)
          .superRefine((topics, context) => {
            const expected = ["t1", "t2", "t3"];
            for (const [index, topic] of topics.entries()) {
              if (topic.topicId !== expected[index]) {
                context.addIssue({
                  code: "custom",
                  path: [index, "topicId"],
                  message: "fanout topic IDs must be ordered t1, t2, t3",
                });
              }
            }
            if (new Set(topics.map((topic) => topic.question)).size !== topics.length) {
              context.addIssue({
                code: "custom",
                message: "fanout topic questions must be unique",
              });
            }
          }),
      })
      .strict(),
  ])
  .superRefine((plan, context) => {
    const selectedTurnIds =
      plan.mode === "clarify"
        ? []
        : plan.mode === "single"
          ? plan.relevantTurnIds
          : plan.topics.flatMap((topic) => topic.relevantTurnIds);
    if (new Set(selectedTurnIds).size !== selectedTurnIds.length) {
      context.addIssue({ code: "custom", message: "selected turn IDs must be unique" });
    }
  });

const canonicalProviderTaskRoles = new Map<string, string>([
  ["plan-turn", "plan_turn"],
  ["memory-extract", "memory_extractor"],
  ["evaluation-general-planner", "evaluation_general_planner"],
  ["single-retrieve-internal", "internal_retrieval"],
  ["single-select-memories", "memory_selector"],
  ["single-retrieve-web", "web_research"],
  ["single-reduce-plan", "context_reducer"],
  ["single-answer", "direct_answer"],
  ["topic-t1-retrieve-internal", "internal_retrieval"],
  ["topic-t1-select-memories", "memory_selector"],
  ["topic-t1-retrieve-web", "web_research"],
  ["topic-t1-reduce-plan", "context_reducer"],
  ["topic-t1-answer", "topic_answer"],
  ["topic-t2-retrieve-internal", "internal_retrieval"],
  ["topic-t2-select-memories", "memory_selector"],
  ["topic-t2-retrieve-web", "web_research"],
  ["topic-t2-reduce-plan", "context_reducer"],
  ["topic-t2-answer", "topic_answer"],
  ["topic-t3-retrieve-internal", "internal_retrieval"],
  ["topic-t3-select-memories", "memory_selector"],
  ["topic-t3-retrieve-web", "web_research"],
  ["topic-t3-reduce-plan", "context_reducer"],
  ["topic-t3-answer", "topic_answer"],
  ["fanout-synthesis", "synthesis"],
]);

const RestrictedConversationEntrySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("complete"),
      turnId: z.string().uuid(),
      userMessageId: z.string().uuid(),
      assistantMessageId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("failed"),
      turnId: z.string().uuid(),
      userMessageId: z.string().uuid(),
      errorCode: z.string(),
      retryable: z.boolean(),
    })
    .strict(),
]);

const RestrictedContextSourceSchema = z
  .object({
    candidateId: z.string().trim().min(1),
    sourceKey: z.string().trim().min(1),
    kind: z.enum(["document", "chat_message", "memory", "web"]),
    purpose: z.string().trim().min(1),
    label: z.string().nullable(),
    ranges: z.array(
      z
        .object({ charStart: z.number().int().nonnegative(), charEnd: z.number().int().positive() })
        .strict(),
    ),
  })
  .strict();

const RestrictedTopicPacketSchema = z
  .object({
    topicId: z.enum(["t1", "t2", "t3"]),
    status: z.enum(["answered", "partial"]),
    claimCount: z.number().int().nonnegative(),
    gapCount: z.number().int().nonnegative(),
    packetSha256Hex: z.string().regex(/^[0-9a-f]{64}$/u),
  })
  .strict();

const TopicPacketObservationSchema = z
  .object({
    topicId: z.enum(["t1", "t2", "t3"]),
    status: z.enum(["answered", "partial"]),
    sourceKeys: z.array(z.string()),
    claimCount: z.number().int().nonnegative(),
    gapCount: z.number().int().nonnegative(),
    packetSha256Hex: z.string().regex(/^[0-9a-f]{64}$/u),
  })
  .strict();

const RestrictedLedgerCommon = {
  modelId: z.string().trim().min(1),
  requestSha256Hex: z.string().regex(/^[0-9a-f]{64}$/u),
  inputTokens: z.number().int().nonnegative(),
  usableInputTokens: z.number().int().positive(),
  requestedOutputTokens: z.number().int().positive(),
  selectedConversation: z.array(RestrictedConversationEntrySchema),
} as const;

const RestrictedContextLedgerSchema = z.discriminatedUnion("requestKind", [
  z
    .object({
      ...RestrictedLedgerCommon,
      requestKind: z.literal("direct"),
      question: z.string().trim().min(1),
      gaps: z.array(z.string()),
      sources: z.array(RestrictedContextSourceSchema),
    })
    .strict(),
  z
    .object({
      ...RestrictedLedgerCommon,
      requestKind: z.literal("topic"),
      topicId: z.enum(["t1", "t2", "t3"]),
      question: z.string().trim().min(1),
      gaps: z.array(z.string()),
      sources: z.array(RestrictedContextSourceSchema),
    })
    .strict(),
  z
    .object({
      ...RestrictedLedgerCommon,
      requestKind: z.literal("synthesis"),
      packets: z.array(RestrictedTopicPacketSchema).min(2).max(3),
    })
    .strict(),
]);

const RetrievalRangeSchema = z
  .object({ charStart: z.number().int().nonnegative(), charEnd: z.number().int().positive() })
  .strict()
  .refine((range) => range.charEnd > range.charStart);
const RetrievalDocumentSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("public"), sourceId: z.string().trim().min(1) }).strict(),
  z
    .object({
      kind: z.literal("publisher"),
      sourceId: z.string().trim().min(1),
      issueId: z.string().trim().min(1),
      documentId: z.string().trim().min(1),
    })
    .strict(),
]);
const RetrievalReferenceSchema = z.union([
  z
    .object({
      kind: z.literal("document"),
      documentId: z.string().trim().min(1),
      versionId: z.string().trim().min(1),
      publisherExtractionId: z.string().trim().min(1).optional(),
      source: RetrievalDocumentSourceSchema,
      ranges: z.array(RetrievalRangeSchema).optional(),
      purpose: z.string().trim().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("chat_message"),
      messageId: z.string().trim().min(1),
      purpose: z.string().trim().min(1),
    })
    .strict(),
  z
    .object({
      memoryId: z.string().trim().min(1),
      memoryRevisionId: z.string().trim().min(1),
    })
    .strict(),
  z
    .object({
      url: z.string().trim().min(1),
      title: z.string().trim().min(1),
      domain: z.string().trim().min(1),
      quote: z.string().trim().min(1),
      publishedAt: z.string().optional(),
      capturedAt: z.string().trim().min(1),
      purpose: z.string().trim().min(1),
    })
    .strict(),
  z.object({ sourceId: z.string().trim().min(1), ranges: z.array(RetrievalRangeSchema) }).strict(),
]);
const RetrievalManifestSchema = z
  .object({
    selectorRole: z.enum(["internal", "memory", "web", "general_planner"]),
    references: z.array(RetrievalReferenceSchema),
    noCallReason: z
      .enum([
        "memory_mode_disabled",
        "no_active_memories",
        "web_not_requested",
        "web_policy_disabled",
        "topic_not_web_eligible",
      ])
      .optional(),
  })
  .strict()
  .superRefine((manifest, context) => {
    if (manifest.noCallReason === undefined) return;
    if (manifest.references.length !== 0) {
      context.addIssue({
        code: "custom",
        path: ["noCallReason"],
        message: "a no-call retrieval manifest cannot carry references",
      });
    }
    const expectedRole =
      manifest.noCallReason === "memory_mode_disabled" ||
      manifest.noCallReason === "no_active_memories"
        ? "memory"
        : "web";
    if (manifest.selectorRole !== expectedRole) {
      context.addIssue({
        code: "custom",
        path: ["noCallReason"],
        message: "the no-call reason does not belong to this selector role",
      });
    }
  });

const RetrievalNoCallSealPayloadSchema = z
  .object({
    selectorTaskId: z.string().trim().min(1),
    selectorLoopIteration: z.number().int().nonnegative(),
    selectorAttempt: z.number().int().nonnegative(),
    selectorObservationKey: z.string().trim().min(1),
    noCallReason: z.enum([
      "memory_mode_disabled",
      "no_active_memories",
      "web_not_requested",
      "web_policy_disabled",
      "topic_not_web_eligible",
    ]),
  })
  .strict();

type RetrievalNoCallReason = z.infer<typeof RetrievalNoCallSealPayloadSchema>["noCallReason"];

const ProviderSerializationProofBindingSchema = z
  .object({
    messageIndex: z.number().int().nonnegative(),
    sourceOrdinal: z.number().int().nonnegative(),
    serializedField: z.string().trim().min(1),
    characterOffset: z.number().int().nonnegative().optional(),
    orderedSourceDescriptor: z.string().trim().min(1),
    publicDocumentId: z.string().trim().min(1).optional(),
  })
  .strict();

const ProviderSerializationProofBindingRowSchema = z
  .object({
    providerSerializationProofSha256Hex: z.string().regex(/^[0-9a-f]{64}$/u),
    providerSerializationProofBinding: ProviderSerializationProofBindingSchema,
  })
  .strict();

const ContextReducerTerminalSchema = z
  .object({
    terminalUsageCoordinate: z
      .object({
        taskId: z.string().trim().min(1),
        loopIteration: z.number().int().nonnegative(),
        attempt: z.number().int().nonnegative(),
        providerRequestIndex: z.number().int().nonnegative(),
      })
      .strict(),
    modelId: z.string().trim().min(1),
    requestSha256Hex: z.string().regex(/^[0-9a-f]{64}$/u),
    providerInputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    stopReason: z.enum(["stop", "length", "toolUse"]),
  })
  .strict();

export type TerminalAiRunResult =
  | {
      readonly status: "succeeded";
      readonly assistantMessageId: string;
      readonly memory: AppliedMemoryChanges;
      readonly usage: AggregateAiRunUsage;
      readonly alreadyTerminal: boolean;
    }
  | {
      readonly status: "failed";
      readonly code: AiRunErrorCode;
      readonly retryable: boolean;
      readonly memory: AppliedMemoryChanges | null;
      readonly usage: AggregateAiRunUsage | null;
      readonly alreadyTerminal: boolean;
    };

const validateDurableObservability = (
  run: RunRow,
  answer: AnswerLaneResult,
  finalizationCoordinates: FinalizeAiRunInput["coordinates"],
): Effect.Effect<void, SqlError | Error, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const runId = run.id;
    const acceptanceScope = parseRunAcceptanceScope(run.acceptanceScope);
    const observationRows = yield* sql<{
      readonly observationKey: string;
      readonly kind: string;
      readonly emittingTask: string;
      readonly loopIteration: number;
      readonly attempt: number;
      readonly payload: Record<string, unknown>;
    }>`
      select observation_key as "observationKey", kind, emitting_task as "emittingTask", loop_iteration as "loopIteration",
             attempt, payload
      from ai_observations
      where run_id = ${runId}
    `;
    const evaluationRows = yield* sql<{ readonly topology: string | null }>`
      select (
        select topology
        from ai_evaluation_case_runs
        where ai_run_id = ${runId}
        limit 1
      ) as topology
    `;
    const evaluationTopology = evaluationRows[0]?.topology ?? null;
    const isEvaluationRun = evaluationTopology !== null;
    const isGeneralPlannerEvaluationRun = evaluationTopology === "general_planner";
    const selectorStateRows = yield* sql<{
      readonly memoryMode: string;
      readonly webRequested: boolean;
      readonly webPolicyEnabled: boolean;
      readonly activeMemoryCount: number;
    }>`
      select runs.acceptance_scope->>'memoryMode' as "memoryMode",
             coalesce((runs.acceptance_scope->>'webRequested')::boolean, false) as "webRequested",
             coalesce((runs.acceptance_scope->>'webEnabled')::boolean, false) as "webPolicyEnabled",
             coalesce(jsonb_array_length(runs.acceptance_scope->'memoryRevisionIds'), 0)::int as "activeMemoryCount"
      from ai_runs runs
      where runs.id = ${runId}
    `;
    const selectorState = selectorStateRows[0];
    if (selectorState === undefined) {
      return yield* Effect.fail(new Error("finalization selector state is missing"));
    }
    const allowedObservationKinds = new Set([
      "turn_plan",
      "retrieval_manifest",
      "retrieval_no_call_seal",
      "candidate_rejected",
      "provider_request_measurement",
      "source_exposure_attestation",
      "context_measurement",
      "context_decision",
      "context_reducer_terminal",
      "context_serialized",
      "topic_packet",
      "memory_extraction_result",
      "memory_application",
      "answer_started",
      "answer_delta",
      "answer_completed",
      "citation",
      "citation_defect",
      "memory_written",
    ]);
    const canonicalProviderTaskId = (taskId: string): boolean =>
      canonicalProviderTaskRoles.has(taskId);
    const unknownObservation = observationRows.find(
      (row) => !allowedObservationKinds.has(row.kind),
    );
    if (unknownObservation !== undefined) {
      return yield* Effect.fail(
        new Error(`unknown or legacy observation kind: ${unknownObservation.kind}`),
      );
    }
    const terminalPlans = observationRows.filter((row) => row.kind === "turn_plan");
    if (terminalPlans.length === 0) {
      return yield* Effect.fail(new Error("finalization requires a terminal turn_plan"));
    }
    if (
      terminalPlans.some(
        (plan) =>
          plan.emittingTask !== "plan-turn" && plan.emittingTask !== "evaluation-general-planner",
      )
    ) {
      return yield* Effect.fail(new Error("turn_plan has a foreign owner"));
    }
    if (
      terminalPlans.some(
        (plan) =>
          (plan.emittingTask === "evaluation-general-planner") !== isGeneralPlannerEvaluationRun,
      )
    ) {
      return yield* Effect.fail(new Error("turn_plan owner does not match the run topology"));
    }
    const terminalPlanCoordinates = new Set<string>();
    for (const plan of terminalPlans) {
      const coordinate = `${plan.loopIteration}:${plan.attempt}`;
      if (terminalPlanCoordinates.has(coordinate)) {
        return yield* Effect.fail(new Error("duplicate terminal turn_plan output"));
      }
      terminalPlanCoordinates.add(coordinate);
    }
    const orderedByAttempt = <
      T extends { readonly loopIteration: number; readonly attempt: number },
    >(
      rows: readonly T[],
    ): readonly T[] =>
      [...rows].sort(
        (left, right) => left.loopIteration - right.loopIteration || left.attempt - right.attempt,
      );
    const terminalPlan = orderedByAttempt(terminalPlans).at(-1);
    if (terminalPlan === undefined) {
      return yield* Effect.fail(new Error("finalization requires a terminal turn_plan"));
    }
    if (
      terminalPlan.emittingTask !== "plan-turn" &&
      terminalPlan.emittingTask !== "evaluation-general-planner"
    ) {
      return yield* Effect.fail(new Error("terminal turn_plan has invalid owner"));
    }
    const parsedPlan =
      terminalPlan.emittingTask === "evaluation-general-planner"
        ? EvaluationTurnPlanSchema.safeParse(terminalPlan.payload)
        : DurableTurnPlanSchema.safeParse(terminalPlan.payload);
    if (!parsedPlan.success) {
      return yield* Effect.fail(new Error("terminal turn_plan is not a strict durable plan"));
    }
    if (
      answer.status === "ok" &&
      ((parsedPlan.data.mode === "clarify" && answer.mode !== "clarification") ||
        (parsedPlan.data.mode === "single" && answer.mode !== "single") ||
        (parsedPlan.data.mode === "fanout" && answer.mode !== "synthesis"))
    ) {
      return yield* Effect.fail(new Error("terminal answer mode differs from turn_plan"));
    }
    const selectedTurnIds =
      parsedPlan.data.mode === "clarify"
        ? []
        : "relevantTurnIds" in parsedPlan.data
          ? parsedPlan.data.relevantTurnIds
          : parsedPlan.data.topics.flatMap((topic) => topic.relevantTurnIds);
    if (selectedTurnIds.length > 0) {
      const selectedRows = yield* sql<{ readonly id: string }>`
        select prior.id::text as id
        from ai_runs current
        join ai_runs prior on prior.chat_id = current.chat_id
        where current.id = ${runId}
          and prior.id::text in (
            select value from jsonb_array_elements_text(${JSON.stringify(selectedTurnIds)}::jsonb)
          )
          and prior.id <> current.id
          and (prior.finished_at is not null or prior.failed_at is not null)
      `;
      if (selectedRows.length !== selectedTurnIds.length) {
        return yield* Effect.fail(new Error("terminal turn_plan selects an unavailable chat turn"));
      }
    }
    const retrievalRows = observationRows.filter(
      (observation) => observation.kind === "retrieval_manifest",
    );
    const noCallSealRows = observationRows.filter(
      (observation) => observation.kind === "retrieval_no_call_seal",
    );
    const noCallSealsBySelectorObservation = new Map<
      string,
      z.infer<typeof RetrievalNoCallSealPayloadSchema>
    >();
    for (const row of noCallSealRows) {
      const parsed = RetrievalNoCallSealPayloadSchema.safeParse(row.payload);
      const expectedObservationKey = parsed.success
        ? [
            "retrieval_no_call_seal",
            parsed.data.selectorTaskId,
            parsed.data.selectorLoopIteration,
            parsed.data.selectorAttempt,
          ].join(":")
        : "";
      if (
        !parsed.success ||
        row.emittingTask !== "finalize" ||
        row.observationKey !== expectedObservationKey ||
        parsed.data.selectorObservationKey !==
          [
            parsed.data.selectorTaskId,
            parsed.data.selectorLoopIteration,
            parsed.data.selectorAttempt,
            "retrieval_manifest",
            "result",
          ].join(":") ||
        noCallSealsBySelectorObservation.has(parsed.data.selectorObservationKey)
      ) {
        return yield* Effect.fail(new Error("retrieval no-call seal is not exact"));
      }
      noCallSealsBySelectorObservation.set(parsed.data.selectorObservationKey, parsed.data);
    }
    const terminalReplay = run.finishedAt !== null || run.failedAt !== null;
    const historicalNoCallReasonsByTask = new Map<string, RetrievalNoCallReason>();
    for (const seal of noCallSealsBySelectorObservation.values()) {
      const previous = historicalNoCallReasonsByTask.get(seal.selectorTaskId);
      if (previous !== undefined && previous !== seal.noCallReason) {
        return yield* Effect.fail(new Error("retrieval no-call seal has conflicting reasons"));
      }
      historicalNoCallReasonsByTask.set(seal.selectorTaskId, seal.noCallReason);
    }
    if (!terminalReplay && noCallSealRows.length > 0) {
      return yield* Effect.fail(new Error("active run carries a forged retrieval no-call seal"));
    }
    const terminalRetrievalRows = new Map<string, (typeof observationRows)[number]>();
    for (const row of retrievalRows) {
      const parsed = RetrievalManifestSchema.safeParse(row.payload);
      if (!parsed.success) {
        return yield* Effect.fail(new Error("retrieval manifest is not strict"));
      }
      const expectedRole = canonicalProviderTaskRoles.get(row.emittingTask);
      if (expectedRole === undefined && row.emittingTask !== "evaluation-general-planner") {
        return yield* Effect.fail(new Error("retrieval manifest has a foreign owner"));
      }
      const previous = terminalRetrievalRows.get(row.emittingTask);
      if (
        previous === undefined ||
        row.loopIteration > previous.loopIteration ||
        (row.loopIteration === previous.loopIteration && row.attempt > previous.attempt)
      ) {
        terminalRetrievalRows.set(row.emittingTask, row);
      }
    }
    const expectedRetrievalOwners =
      terminalPlan.emittingTask === "evaluation-general-planner"
        ? ["evaluation-general-planner"]
        : parsedPlan.data.mode === "single"
          ? ["single-retrieve-internal", "single-select-memories", "single-retrieve-web"]
          : parsedPlan.data.mode === "fanout"
            ? parsedPlan.data.topics.flatMap((topic) => [
                `topic-${topic.topicId}-retrieve-internal`,
                `topic-${topic.topicId}-select-memories`,
                `topic-${topic.topicId}-retrieve-web`,
              ])
            : [];
    const expectedRetrievalRoles = new Map(
      expectedRetrievalOwners.map(
        (owner) =>
          [
            owner,
            owner === "evaluation-general-planner"
              ? "general_planner"
              : owner.endsWith("retrieve-internal")
                ? "internal"
                : owner.endsWith("select-memories")
                  ? "memory"
                  : "web",
          ] as const,
      ),
    );
    const expectedRetrievalOwnerSet = new Set(expectedRetrievalOwners);
    for (const row of retrievalRows) {
      if (!expectedRetrievalOwnerSet.has(row.emittingTask)) {
        return yield* Effect.fail(
          new Error(
            `retrieval manifest has an owner outside the selected route: ${row.emittingTask}`,
          ),
        );
      }
      if (
        RetrievalManifestSchema.parse(row.payload).selectorRole !==
        expectedRetrievalRoles.get(row.emittingTask)
      ) {
        return yield* Effect.fail(
          new Error(`retrieval manifest role differs for ${row.emittingTask}`),
        );
      }
    }
    if (parsedPlan.data.mode === "clarify") {
      if (retrievalRows.length > 0) {
        return yield* Effect.fail(new Error("clarification cannot carry a retrieval manifest"));
      }
    } else {
      for (const owner of expectedRetrievalOwners) {
        if (terminalRetrievalRows.get(owner) === undefined) {
          return yield* Effect.fail(new Error(`missing retrieval manifest for ${owner}`));
        }
      }
    }
    const exposureRows = yield* sql<{
      readonly taskId: string;
      readonly loopIteration: number;
      readonly attempt: number;
      readonly providerRequestIndex: number;
      readonly logicalSourceIdentity: string;
      readonly contentItemIdentity: string;
      readonly sourceKind: string;
      readonly exposureStage: string;
      readonly visibleTokenCount: number;
      readonly versionId: string | null;
      readonly contentHash: string | null;
      readonly documentSourceId: string | null;
      readonly documentId: string | null;
      readonly publisherIssueId: string | null;
      readonly publisherDocumentId: string | null;
      readonly documentRanges:
        | readonly { readonly charStart: number; readonly charEnd: number }[]
        | null;
      readonly publisherExtractionId: string | null;
    }>`
      select task_id as "taskId", loop_iteration as "loopIteration", attempt,
             provider_request_index as "providerRequestIndex",
             logical_source_identity as "logicalSourceIdentity",
             content_item_identity as "contentItemIdentity",
             source_kind as "sourceKind", exposure_stage as "exposureStage",
             visible_token_count as "visibleTokenCount",
             version_id as "versionId", content_hash as "contentHash",
             document_source_id as "documentSourceId", document_id as "documentId",
             publisher_issue_id::text as "publisherIssueId",
             publisher_document_id::text as "publisherDocumentId",
             document_ranges as "documentRanges",
             publisher_extraction_id::text as "publisherExtractionId"
      from ai_source_exposures where run_id = ${runId}
    `;
    for (const exposure of exposureRows) {
      if (!canonicalProviderTaskId(exposure.taskId)) {
        return yield* Effect.fail(new Error("source exposure has a foreign task owner"));
      }
      if (exposure.sourceKind === "document") {
        if (
          exposure.versionId === null ||
          exposure.contentHash === null ||
          exposure.documentSourceId === null ||
          exposure.documentId === null ||
          exposure.documentRanges === null ||
          exposure.documentSourceId.startsWith("publisher:") !==
            (exposure.publisherExtractionId !== null)
        ) {
          return yield* Effect.fail(
            new Error("document exposure lacks its exact reconstruction binding"),
          );
        }
        try {
          assertCanonicalDocumentExposureIdentity({
            sourceKind: "document",
            logicalSourceIdentity: exposure.logicalSourceIdentity,
            contentItemIdentity: exposure.contentItemIdentity,
            requireCanonicalDocumentIdentity: true,
            ...(exposure.publisherIssueId === null || exposure.publisherDocumentId === null
              ? {}
              : {
                  publisherIssueId: exposure.publisherIssueId,
                  publisherDocumentId: exposure.publisherDocumentId,
                }),
            documentReconstruction: {
              sourceId: exposure.documentSourceId,
              documentId: exposure.documentId,
              versionId: exposure.versionId,
              contentHash: exposure.contentHash,
              ranges: exposure.documentRanges,
              ...(exposure.publisherExtractionId === null
                ? {}
                : { publisherExtractionId: exposure.publisherExtractionId }),
            },
          });
        } catch (error) {
          return yield* Effect.fail(
            error instanceof Error
              ? error
              : new Error("document exposure identity does not match its reconstruction"),
          );
        }
      } else if (
        exposure.versionId !== null ||
        exposure.contentHash !== null ||
        exposure.documentSourceId !== null ||
        exposure.documentId !== null ||
        exposure.documentRanges !== null ||
        exposure.publisherExtractionId !== null
      ) {
        return yield* Effect.fail(new Error("non-document exposure carries document identity"));
      }
    }
    const attestationCount = observationRows.filter(
      (row) => row.kind === "source_exposure_attestation",
    ).length;
    if (attestationCount !== exposureRows.length) {
      return yield* Effect.fail(
        new Error("source exposure and attestation ledgers are not bijective"),
      );
    }
    const attestationRows = observationRows.filter(
      (row) => row.kind === "source_exposure_attestation",
    );
    const exposureKeys = new Set(
      exposureRows.map((exposure) =>
        [
          exposure.taskId,
          exposure.loopIteration,
          exposure.attempt,
          exposure.providerRequestIndex,
          exposure.sourceKind,
          exposure.logicalSourceIdentity,
          exposure.contentItemIdentity,
          exposure.exposureStage,
        ].join(":"),
      ),
    );
    if (exposureKeys.size !== exposureRows.length) {
      return yield* Effect.fail(new Error("duplicate source exposure coordinates"));
    }
    const attestedExposureKeys = new Set<string>();
    const exposureProofsByCoordinate = new Map<string, string[]>();
    const exposureBindingsByCoordinate = new Map<
      string,
      z.infer<typeof ProviderSerializationProofBindingSchema>[]
    >();
    const exposureRequestDigestsByCoordinate = new Map<string, string>();
    for (const row of attestationRows) {
      if (!canonicalProviderTaskId(row.emittingTask)) {
        return yield* Effect.fail(
          new Error("source exposure attestation has a foreign task owner"),
        );
      }
      const providerRequestIndex = row.payload.providerRequestIndex;
      const proof = row.payload.providerSerializationProofSha256Hex;
      const providerSerializationProofBinding = row.payload.providerSerializationProofBinding;
      const requestDigest = row.payload.providerRequestSha256Hex;
      const sourceKind = row.payload.sourceKind;
      const logicalSourceIdentity = row.payload.logicalSourceIdentity;
      const contentItemIdentity = row.payload.contentItemIdentity;
      const exposureStage = row.payload.exposureStage;
      const visibleTokenCount = row.payload.visibleTokenCount;
      if (
        !Number.isSafeInteger(providerRequestIndex) ||
        typeof proof !== "string" ||
        !/^[0-9a-f]{64}$/u.test(proof) ||
        !ProviderSerializationProofBindingSchema.safeParse(providerSerializationProofBinding)
          .success ||
        typeof requestDigest !== "string" ||
        !/^[0-9a-f]{64}$/u.test(requestDigest) ||
        typeof sourceKind !== "string" ||
        typeof logicalSourceIdentity !== "string" ||
        typeof contentItemIdentity !== "string" ||
        typeof exposureStage !== "string" ||
        !Number.isSafeInteger(visibleTokenCount)
      ) {
        return yield* Effect.fail(new Error("invalid source exposure attestation payload"));
      }
      const parsedBinding = ProviderSerializationProofBindingSchema.parse(
        providerSerializationProofBinding,
      );
      const marker: ProviderVisibleSourceExposureMarker = {
        sourceKind: sourceKind as ProviderVisibleSourceExposureMarker["sourceKind"],
        logicalSourceIdentity,
        contentItemIdentity,
        exposureStage,
        visibleTokenCount: visibleTokenCount as number,
      };
      if (providerVisibleSourceExposureProofSha256Hex(marker, parsedBinding) !== proof) {
        return yield* Effect.fail(
          new Error("source exposure attestation proof is not bound to its exact field"),
        );
      }
      const key = [row.emittingTask, row.loopIteration, row.attempt, providerRequestIndex].join(
        ":",
      );
      const exposureKey = [
        row.emittingTask,
        row.loopIteration,
        row.attempt,
        providerRequestIndex,
        sourceKind,
        logicalSourceIdentity,
        contentItemIdentity,
        exposureStage,
      ].join(":");
      const exposure = exposureRows.find(
        (candidate) =>
          [
            candidate.taskId,
            candidate.loopIteration,
            candidate.attempt,
            candidate.providerRequestIndex,
            candidate.sourceKind,
            candidate.logicalSourceIdentity,
            candidate.contentItemIdentity,
            candidate.exposureStage,
          ].join(":") === exposureKey,
      );
      if (
        exposure === undefined ||
        exposure.visibleTokenCount !== visibleTokenCount ||
        attestedExposureKeys.has(exposureKey)
      ) {
        return yield* Effect.fail(
          new Error("source exposure attestation is not an exact bijection"),
        );
      }
      const reconstructionFields = [
        "documentSourceId",
        "documentId",
        "versionId",
        "documentContentHash",
        "documentRanges",
        "publisherExtractionId",
      ] as const;
      if (sourceKind === "document") {
        if (
          row.payload.documentSourceId !== exposure.documentSourceId ||
          row.payload.documentId !== exposure.documentId ||
          row.payload.versionId !== exposure.versionId ||
          row.payload.documentContentHash !== exposure.contentHash ||
          canonicalJson(row.payload.documentRanges) !== canonicalJson(exposure.documentRanges) ||
          (row.payload.publisherExtractionId ?? null) !== exposure.publisherExtractionId
        ) {
          return yield* Effect.fail(
            new Error("document exposure attestation reconstruction differs"),
          );
        }
      } else if (reconstructionFields.some((field) => Object.hasOwn(row.payload, field))) {
        return yield* Effect.fail(
          new Error("non-document exposure attestation carries document reconstruction"),
        );
      }
      attestedExposureKeys.add(exposureKey);
      const existingRequestDigest = exposureRequestDigestsByCoordinate.get(key);
      if (existingRequestDigest !== undefined && existingRequestDigest !== requestDigest) {
        return yield* Effect.fail(
          new Error(`source exposure attestations disagree on request digest: ${key}`),
        );
      }
      exposureRequestDigestsByCoordinate.set(key, requestDigest);
      const proofs = exposureProofsByCoordinate.get(key) ?? [];
      proofs.push(proof);
      exposureProofsByCoordinate.set(key, proofs);
      const bindings = exposureBindingsByCoordinate.get(key) ?? [];
      bindings.push(parsedBinding);
      exposureBindingsByCoordinate.set(key, bindings);
    }
    if (attestedExposureKeys.size !== exposureKeys.size) {
      return yield* Effect.fail(new Error("source exposure attestation ledger has missing rows"));
    }
    const kinds = new Set(observationRows.map((row) => row.kind));
    const required = new Set<string>(["turn_plan"]);
    required.add("memory_extraction_result");
    if (answer.status === "ok" && answer.mode !== "clarification") {
      for (const kind of [
        "turn_plan",
        "retrieval_manifest",
        "context_measurement",
        "context_serialized",
      ]) {
        required.add(kind);
      }
      if (answer.mode === "synthesis") required.add("topic_packet");
    }
    for (const kind of required) {
      if (!kinds.has(kind)) return yield* Effect.fail(new Error(`missing ${kind} observation`));
    }
    const serializedContextRows = observationRows.filter(
      (observation) => observation.kind === "context_serialized",
    );
    if (answer.status === "ok") {
      const allowedContextOwners =
        answer.mode === "clarification"
          ? new Set<string>()
          : isEvaluationRun
            ? isGeneralPlannerEvaluationRun
              ? new Set(["evaluation-general-planner"])
              : answer.mode === "single"
                ? new Set(["single-answer"])
                : new Set([
                    "fanout-synthesis",
                    "topic-t1-answer",
                    "topic-t2-answer",
                    "topic-t3-answer",
                  ])
            : answer.mode === "single"
              ? new Set(["single-answer"])
              : new Set([
                  "fanout-synthesis",
                  "topic-t1-answer",
                  "topic-t2-answer",
                  "topic-t3-answer",
                ]);
      if (serializedContextRows.some((row) => !allowedContextOwners.has(row.emittingTask))) {
        return yield* Effect.fail(new Error("context serialization has a foreign owner"));
      }
      if (answer.mode === "clarification" && serializedContextRows.length > 0) {
        return yield* Effect.fail(new Error("clarification cannot carry serialized context"));
      }
    }

    const measurements = new Map<string, Record<string, unknown>>();
    const measurementProofBindingsByCoordinate = new Map<
      string,
      readonly z.infer<typeof ProviderSerializationProofBindingRowSchema>[]
    >();
    for (const row of observationRows.filter(
      (observation) => observation.kind === "provider_request_measurement",
    )) {
      if (!canonicalProviderTaskId(row.emittingTask)) {
        return yield* Effect.fail(
          new Error("provider request measurement has a foreign task owner"),
        );
      }
      const requestIndex = row.payload.providerRequestIndex;
      const expectedRole = canonicalProviderTaskRoles.get(row.emittingTask);
      const modelId = row.payload.modelId;
      const requestSha256Hex = row.payload.requestSha256Hex;
      const sourceExposureProofs = row.payload.sourceExposureProofSha256Hexes;
      const sourceExposureProofBindings = row.payload.sourceExposureProofBindings;
      const safeInteger = (value: unknown): value is number =>
        typeof value === "number" && Number.isSafeInteger(value);
      if (
        !safeInteger(requestIndex) ||
        requestIndex < 0 ||
        row.payload.agentRole !== expectedRole ||
        modelId !== "glm-5-turbo" ||
        typeof requestSha256Hex !== "string" ||
        !/^[0-9a-f]{64}$/u.test(requestSha256Hex) ||
        !Array.isArray(sourceExposureProofs) ||
        sourceExposureProofs.some(
          (proof) => typeof proof !== "string" || !/^[0-9a-f]{64}$/u.test(proof),
        ) ||
        new Set(sourceExposureProofs).size !== sourceExposureProofs.length ||
        JSON.stringify(sourceExposureProofs) !== JSON.stringify([...sourceExposureProofs].sort()) ||
        (sourceExposureProofs.length > 0 && !Array.isArray(sourceExposureProofBindings)) ||
        row.payload.passed !== true
      ) {
        return yield* Effect.fail(new Error("invalid provider request measurement observation"));
      }
      const inputTokens = row.payload.inputTokens;
      const requestedOutputTokens = row.payload.requestedOutputTokens;
      const usableInputTokens = row.payload.usableInputTokens;
      const contextWindow = row.payload.contextWindow;
      const measurementFields = new Set([
        "providerRequestIndex",
        "agentRole",
        "modelId",
        "requestSha256Hex",
        "sourceExposureProofSha256Hexes",
        "sourceExposureProofBindings",
        "inputTokens",
        "requestedOutputTokens",
        "usableInputTokens",
        "contextWindow",
        "passed",
      ]);
      if (
        Object.keys(row.payload).some((field) => !measurementFields.has(field)) ||
        !safeInteger(inputTokens) ||
        inputTokens < 0 ||
        !safeInteger(requestedOutputTokens) ||
        requestedOutputTokens <= 0 ||
        !safeInteger(usableInputTokens) ||
        usableInputTokens < 0 ||
        !safeInteger(contextWindow) ||
        contextWindow <= requestedOutputTokens ||
        usableInputTokens > contextWindow - requestedOutputTokens ||
        inputTokens > usableInputTokens
      ) {
        return yield* Effect.fail(new Error("provider request measurement token gate is invalid"));
      }
      const key = [row.emittingTask, row.loopIteration, row.attempt, requestIndex].join(":");
      if (measurements.has(key)) {
        return yield* Effect.fail(new Error(`duplicate provider measurement coordinates: ${key}`));
      }
      const expectedProofs = [...(exposureProofsByCoordinate.get(key) ?? [])].sort();
      const measuredProofs = [...sourceExposureProofs].sort();
      if (JSON.stringify(expectedProofs) !== JSON.stringify(measuredProofs)) {
        return yield* Effect.fail(
          new Error(
            `source exposure lacks its exact provider measurement: provider measurement proof set differs from exposed content: ${key}`,
          ),
        );
      }
      if (sourceExposureProofs.length > 0) {
        const parsedBindings = z
          .array(ProviderSerializationProofBindingRowSchema)
          .safeParse(sourceExposureProofBindings);
        if (
          !parsedBindings.success ||
          parsedBindings.data.length !== sourceExposureProofs.length ||
          new Set(parsedBindings.data.map((binding) => binding.providerSerializationProofSha256Hex))
            .size !== parsedBindings.data.length ||
          JSON.stringify(
            parsedBindings.data
              .map((binding) => binding.providerSerializationProofSha256Hex)
              .sort(),
          ) !== JSON.stringify(measuredProofs)
        ) {
          return yield* Effect.fail(
            new Error("provider request measurement source proof bindings are not exact"),
          );
        }
        const attestedBindings = (exposureBindingsByCoordinate.get(key) ?? [])
          .map((binding, index) => ({ binding, index }))
          .sort((left, right) =>
            JSON.stringify(left.binding).localeCompare(JSON.stringify(right.binding)),
          )
          .map(({ binding }) => binding);
        const measuredBindings = [...parsedBindings.data]
          .sort((left, right) =>
            JSON.stringify(left.providerSerializationProofBinding).localeCompare(
              JSON.stringify(right.providerSerializationProofBinding),
            ),
          )
          .map((binding) => binding.providerSerializationProofBinding);
        if (JSON.stringify(attestedBindings) !== JSON.stringify(measuredBindings)) {
          return yield* Effect.fail(
            new Error("provider measurement bindings differ from exposure attestations"),
          );
        }
        measurementProofBindingsByCoordinate.set(key, parsedBindings.data);
      } else if (sourceExposureProofBindings !== undefined) {
        const parsedBindings = z
          .array(ProviderSerializationProofBindingRowSchema)
          .safeParse(sourceExposureProofBindings);
        if (!parsedBindings.success || parsedBindings.data.length !== 0) {
          return yield* Effect.fail(
            new Error("empty provider proof set carries unexpected source proof bindings"),
          );
        }
        measurementProofBindingsByCoordinate.set(key, []);
      }
      measurements.set(key, row.payload);
    }
    const measurementKeysFor = (taskId: string, loopIteration: number, attempt: number): string[] =>
      [...measurements.keys()]
        .filter((key) => {
          const [keyTaskId, keyLoopIteration, keyAttempt] = key.split(":");
          return (
            keyTaskId === taskId &&
            Number(keyLoopIteration) === loopIteration &&
            Number(keyAttempt) === attempt
          );
        })
        .sort((left, right) => Number(left.split(":").at(-1)) - Number(right.split(":").at(-1)));
    const latestMeasurementKeyFor = (
      taskId: string,
      loopIteration: number,
      attempt: number,
    ): string | undefined => measurementKeysFor(taskId, loopIteration, attempt).at(-1);
    const measurementGroups = new Map<string, string[]>();
    for (const key of measurements.keys()) {
      const [taskId, loopIteration, attempt] = key.split(":");
      const groupKey = [taskId, loopIteration, attempt].join(":");
      const group = measurementGroups.get(groupKey) ?? [];
      group.push(key);
      measurementGroups.set(groupKey, group);
    }
    for (const [groupKey, keys] of measurementGroups) {
      const ordered = [...keys].sort(
        (left, right) => Number(left.split(":").at(-1)) - Number(right.split(":").at(-1)),
      );
      if (ordered.some((key, index) => Number(key.split(":").at(-1)) !== index)) {
        return yield* Effect.fail(
          new Error("provider measurement indices are not contiguous: " + groupKey),
        );
      }
    }
    for (const [key, requestDigest] of exposureRequestDigestsByCoordinate) {
      if (measurements.get(key)?.requestSha256Hex !== requestDigest) {
        return yield* Effect.fail(
          new Error(`source exposure lacks its exact provider measurement: ${key}`),
        );
      }
    }
    const usageRows = yield* sql<{
      readonly taskId: string;
      readonly loopIteration: number;
      readonly attempt: number;
      readonly providerRequestIndex: number;
      readonly agentRole: string;
      readonly modelId: string;
      readonly providerServiceId: string;
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly cachedTokens: number;
      readonly stopReason: string;
    }>`
      select task_id as "taskId", loop_iteration as "loopIteration", attempt,
             provider_request_index as "providerRequestIndex", agent_role as "agentRole",
             model_id as "modelId", provider_service_id as "providerServiceId",
             input_tokens as "inputTokens", output_tokens as "outputTokens",
             cached_tokens as "cachedTokens",
             stop_reason as "stopReason"
      from ai_run_usage
      where run_id = ${runId}
    `;
    for (const usage of usageRows) {
      if (!canonicalProviderTaskId(usage.taskId)) {
        return yield* Effect.fail(new Error("provider usage has a foreign task owner"));
      }
      if (usage.providerServiceId !== acceptanceScope.provider) {
        return yield* Effect.fail(new Error("provider usage differs from accepted provider"));
      }
      if (canonicalProviderTaskRoles.get(usage.taskId) !== undefined) {
        // The task-to-role map is shared by measurements and usage.  A row
        // with a copied coordinate but a different role is not a retry.
        const roleRows = observationRows.filter(
          (observation) =>
            observation.kind === "provider_request_measurement" &&
            observation.emittingTask === usage.taskId &&
            observation.loopIteration === usage.loopIteration &&
            observation.attempt === usage.attempt &&
            observation.payload.providerRequestIndex === usage.providerRequestIndex,
        );
        if (
          usage.agentRole !== canonicalProviderTaskRoles.get(usage.taskId) ||
          !["zai_coding_plan_official", "deterministic_test", "openai_compatible_custom"].includes(
            usage.providerServiceId,
          ) ||
          !["stop", "length", "toolUse"].includes(usage.stopReason) ||
          roleRows.length !== 1 ||
          roleRows[0]!.payload.agentRole !== canonicalProviderTaskRoles.get(usage.taskId)
        ) {
          return yield* Effect.fail(new Error("provider usage has a foreign task role"));
        }
      }
      const key = [
        usage.taskId,
        usage.loopIteration,
        usage.attempt,
        usage.providerRequestIndex,
      ].join(":");
      const measurement = measurements.get(key);
      if (measurement === undefined || measurement.modelId !== usage.modelId) {
        return yield* Effect.fail(new Error(`usage lacks matching exact measurement: ${key}`));
      }
      if (
        usage.inputTokens + usage.cachedTokens !== measurement.inputTokens ||
        usage.outputTokens > Number(measurement.requestedOutputTokens)
      ) {
        return yield* Effect.fail(new Error(`usage token totals differ from measurement: ${key}`));
      }
    }
    const externalUsageRows = yield* sql<{
      readonly taskId: string;
      readonly loopIteration: number;
      readonly attempt: number;
      readonly toolRequestIndex: number;
      readonly providerServiceId: string;
      readonly operation: "web_search" | "web_fetch";
      readonly status: "ok" | "empty" | "failed";
      readonly resultCount: number;
      readonly responseBytes: number;
      readonly billedUnits: number | null;
      readonly durationMs: number;
    }>`
      select task_id as "taskId", loop_iteration as "loopIteration", attempt,
             tool_request_index as "toolRequestIndex",
             provider_service_id as "providerServiceId", operation, status,
             result_count as "resultCount", response_bytes::float8 as "responseBytes",
             billed_units::float8 as "billedUnits", duration_ms::float8 as "durationMs"
      from ai_external_tool_usage
      where run_id = ${runId}
    `;
    const externalUsageEvents = yield* sql<{
      readonly emissionKey: string;
      readonly emittedByTask: string | null;
      readonly event: Record<string, unknown>;
    }>`
      select emission_key as "emissionKey", emitted_by_task as "emittedByTask", event
      from ai_run_events
      where run_id = ${runId}
        and (
          emission_key like 'usage:request:web_search:%'
          or emission_key like 'usage:request:web_fetch:%'
          or (
            event->>'type' = 'usage'
            and event->>'scope' = 'request'
            and event->>'kind' in ('web_search', 'web_fetch')
          )
        )
    `;
    const expectedExternalEventKeys = new Set<string>();
    const externalUsageGroups = new Map<string, number[]>();
    const isNonnegativeSafeInteger = (value: unknown): value is number =>
      typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
    for (const usage of externalUsageRows) {
      if (
        !expectedRetrievalOwnerSet.has(usage.taskId) ||
        (!usage.taskId.endsWith("retrieve-web") && usage.taskId !== "evaluation-general-planner")
      ) {
        return yield* Effect.fail(new Error("external usage has a foreign task owner"));
      }
      const expectedProviderServiceId =
        usage.operation === "web_search" ? "tinyfish_search_official" : "brief_fetch";
      if (
        usage.providerServiceId !== expectedProviderServiceId ||
        !["ok", "empty", "failed"].includes(usage.status) ||
        !isNonnegativeSafeInteger(usage.loopIteration) ||
        !isNonnegativeSafeInteger(usage.attempt) ||
        !isNonnegativeSafeInteger(usage.toolRequestIndex) ||
        !isNonnegativeSafeInteger(usage.resultCount) ||
        !isNonnegativeSafeInteger(usage.responseBytes) ||
        !isNonnegativeSafeInteger(usage.durationMs) ||
        (usage.billedUnits !== null &&
          (!Number.isFinite(usage.billedUnits) || usage.billedUnits < 0))
      ) {
        return yield* Effect.fail(new Error("external usage row is not canonical"));
      }
      const groupKey = [usage.taskId, usage.loopIteration, usage.attempt].join(":");
      externalUsageGroups.set(groupKey, [
        ...(externalUsageGroups.get(groupKey) ?? []),
        usage.toolRequestIndex,
      ]);
      const eventKey = [
        "usage",
        "request",
        usage.operation,
        usage.taskId,
        usage.loopIteration,
        usage.attempt,
        usage.toolRequestIndex,
      ].join(":");
      if (expectedExternalEventKeys.has(eventKey)) {
        return yield* Effect.fail(new Error("duplicate external usage coordinates"));
      }
      expectedExternalEventKeys.add(eventKey);
      const matchingEvents = externalUsageEvents.filter((event) => event.emissionKey === eventKey);
      const expectedEvent = {
        type: "usage",
        scope: "request",
        kind: usage.operation,
        attempt: usage.attempt,
        status: usage.status,
        resultCount: usage.resultCount,
        responseBytes: usage.responseBytes,
        billedUnits: usage.billedUnits,
        durationMs: usage.durationMs,
      };
      if (
        matchingEvents.length !== 1 ||
        matchingEvents[0]!.emittedByTask !== usage.taskId ||
        canonicalJson(matchingEvents[0]!.event) !== canonicalJson(expectedEvent)
      ) {
        return yield* Effect.fail(
          new Error("external usage row lacks its exact durable request event"),
        );
      }
    }
    for (const [groupKey, indexes] of externalUsageGroups) {
      const ordered = [...indexes].sort((left, right) => left - right);
      if (ordered.some((value, index) => value !== index)) {
        return yield* Effect.fail(
          new Error(`external usage indices are not contiguous: ${groupKey}`),
        );
      }
    }
    if (
      externalUsageEvents.length !== expectedExternalEventKeys.size ||
      externalUsageEvents.some((event) => !expectedExternalEventKeys.has(event.emissionKey))
    ) {
      return yield* Effect.fail(new Error("external request event has no exact usage row"));
    }
    const usageCoordinates = new Set(
      usageRows.map((usage) =>
        [usage.taskId, usage.loopIteration, usage.attempt, usage.providerRequestIndex].join(":"),
      ),
    );
    const planMeasurementKey = latestMeasurementKeyFor(
      terminalPlan.emittingTask,
      terminalPlan.loopIteration,
      terminalPlan.attempt,
    );
    if (planMeasurementKey === undefined || !measurements.has(planMeasurementKey)) {
      return yield* Effect.fail(new Error("turn_plan lacks its exact provider measurement"));
    }
    const answerFailureCode = answer.status === "failed" ? answer.code : undefined;
    const allowsTerminalTransportMeasurement =
      answerFailureCode !== undefined &&
      [
        "plan_turn_failed",
        "internal_retrieval_failed",
        "memory_selector_failed",
        "web_research_failed",
        "context_reducer_failed",
        "answer_failed",
        "topic_answer_failed",
        "synthesis_failed",
        "memory_extraction_failed",
      ].includes(answerFailureCode);
    const coordinateOrder = (left: string, right: string): number => {
      const leftParts = left.split(":").map(Number);
      const rightParts = right.split(":").map(Number);
      const leftOffset = leftParts.length - 3;
      const rightOffset = rightParts.length - 3;
      const leftLoop = leftParts[leftOffset] ?? Number.POSITIVE_INFINITY;
      const leftAttempt = leftParts[leftOffset + 1] ?? Number.POSITIVE_INFINITY;
      const leftRequest = leftParts[leftOffset + 2] ?? Number.POSITIVE_INFINITY;
      const rightLoop = rightParts[rightOffset] ?? Number.POSITIVE_INFINITY;
      const rightAttempt = rightParts[rightOffset + 1] ?? Number.POSITIVE_INFINITY;
      const rightRequest = rightParts[rightOffset + 2] ?? Number.POSITIVE_INFINITY;
      return leftLoop - rightLoop || leftAttempt - rightAttempt || leftRequest - rightRequest;
    };
    const allMeasurementKeysFor = (taskId: string): readonly string[] =>
      [...measurements.keys()].filter((key) => key.startsWith(`${taskId}:`)).sort(coordinateOrder);
    const usageKeyFor = (usage: (typeof usageRows)[number]): string =>
      [usage.taskId, usage.loopIteration, usage.attempt, usage.providerRequestIndex].join(":");
    const latestUsageKeyFor = (taskId: string): string | undefined => {
      const keys = usageRows
        .filter((usage) => usage.taskId === taskId)
        .map(usageKeyFor)
        .sort(coordinateOrder);
      return keys.at(-1);
    };
    const permittedTerminalFailureOwner = (taskId: string): boolean =>
      (answerFailureCode === "plan_turn_failed" && taskId === "plan-turn") ||
      (answerFailureCode === "internal_retrieval_failed" && taskId.endsWith("retrieve-internal")) ||
      (answerFailureCode === "memory_selector_failed" && taskId.endsWith("select-memories")) ||
      (answerFailureCode === "web_research_failed" && taskId.endsWith("retrieve-web")) ||
      (answerFailureCode === "context_reducer_failed" && taskId.endsWith("reduce-plan")) ||
      (answerFailureCode === "answer_failed" && taskId === "single-answer") ||
      (answerFailureCode === "topic_answer_failed" && /^topic-t[123]-answer$/u.test(taskId)) ||
      (answerFailureCode === "synthesis_failed" && taskId === "fanout-synthesis") ||
      (answerFailureCode === "memory_extraction_failed" && taskId === "memory-extract");
    const topicRequestsWebEvidenceForFinalization = (question: string): boolean =>
      /\b(current|latest|official|public|web|online|today|recent|status|update|live|price|actual)\b|\b(actuel(?:le|s)?|dernier(?:e|s)?|officiel(?:le|s)?|public(?:s)?|marché|prix|récent(?:e|s)?|mise à jour|en ligne)\b/iu.test(
        question.normalize("NFC"),
      );
    const externalRequestEventBelongsToTask = (
      event: (typeof externalUsageEvents)[number],
      taskId: string,
    ): boolean => {
      if (event.emittedByTask === taskId) return true;
      const match = /^usage:request:(?:web_search|web_fetch):([^:]+):/u.exec(event.emissionKey);
      return match?.[1] === taskId;
    };
    const documentedNoCallRetrieval = (row: (typeof observationRows)[number]): boolean => {
      if (row.kind !== "retrieval_manifest") return false;
      const parsed = RetrievalManifestSchema.safeParse(row.payload);
      if (
        !parsed.success ||
        parsed.data.references.length !== 0 ||
        parsed.data.noCallReason === undefined
      ) {
        return false;
      }
      if (
        !Number.isSafeInteger(row.loopIteration) ||
        row.loopIteration < 0 ||
        !Number.isSafeInteger(row.attempt) ||
        row.attempt < 0 ||
        row.observationKey !==
          `${row.emittingTask}:${row.loopIteration}:${row.attempt}:retrieval_manifest:result`
      ) {
        return false;
      }
      if (
        allMeasurementKeysFor(row.emittingTask).length !== 0 ||
        usageRows.some((usage) => usage.taskId === row.emittingTask) ||
        externalUsageRows.some((usage) => usage.taskId === row.emittingTask) ||
        externalUsageEvents.some((event) =>
          externalRequestEventBelongsToTask(event, row.emittingTask),
        )
      ) {
        return false;
      }
      if (
        terminalReplay &&
        historicalNoCallReasonsByTask.get(row.emittingTask) === parsed.data.noCallReason
      ) {
        return true;
      }
      switch (parsed.data.noCallReason) {
        case "memory_mode_disabled":
          return (
            row.emittingTask.endsWith("select-memories") && selectorState.memoryMode === "disabled"
          );
        case "no_active_memories":
          return (
            row.emittingTask.endsWith("select-memories") &&
            selectorState.memoryMode === "private_owner" &&
            (terminalReplay || selectorState.activeMemoryCount === 0)
          );
        case "web_not_requested":
          return row.emittingTask.endsWith("retrieve-web") && !selectorState.webRequested;
        case "web_policy_disabled":
          return (
            row.emittingTask.endsWith("retrieve-web") &&
            selectorState.webRequested &&
            !selectorState.webPolicyEnabled
          );
        case "topic_not_web_eligible": {
          if (
            !row.emittingTask.startsWith("topic-") ||
            !row.emittingTask.endsWith("retrieve-web") ||
            !selectorState.webRequested ||
            !selectorState.webPolicyEnabled
          ) {
            return false;
          }
          const topicId = row.emittingTask.slice("topic-".length, -"-retrieve-web".length);
          const topic =
            parsedPlan.data.mode === "fanout"
              ? parsedPlan.data.topics.find((candidate) => candidate.topicId === topicId)
              : undefined;
          return topic !== undefined && !topicRequestsWebEvidenceForFinalization(topic.question);
        }
      }
    };
    const requiredNoCallReasonFor = (taskId: string): RetrievalNoCallReason | undefined => {
      // A terminal replay uses the reason sealed during the first locked
      // finalization when one exists. Current active memories may have changed
      // since then, so an unsealed private-owner memory task is treated as a
      // historical provider call below.
      if (terminalReplay) {
        const historicalReason = historicalNoCallReasonsByTask.get(taskId);
        if (historicalReason !== undefined) return historicalReason;
        // A private-owner memory can be deleted after a provider-backed
        // selector call. Without a seal, treat that replay as a historical
        // call rather than deriving a new no-call reason from current rows.
        // The disabled mode is immutable and remains an exact no-call state.
        if (taskId.endsWith("select-memories")) {
          return selectorState.memoryMode === "disabled" ? "memory_mode_disabled" : undefined;
        }
      }
      if (taskId.endsWith("select-memories")) {
        if (selectorState.memoryMode === "disabled") return "memory_mode_disabled";
        if (selectorState.memoryMode === "private_owner" && selectorState.activeMemoryCount === 0) {
          return "no_active_memories";
        }
        return undefined;
      }
      if (!taskId.endsWith("retrieve-web")) return undefined;
      if (!selectorState.webRequested) return "web_not_requested";
      if (!selectorState.webPolicyEnabled) return "web_policy_disabled";
      if (!taskId.startsWith("topic-")) return undefined;
      const topicId = taskId.slice("topic-".length, -"-retrieve-web".length);
      const topic =
        parsedPlan.data.mode === "fanout"
          ? parsedPlan.data.topics.find((candidate) => candidate.topicId === topicId)
          : undefined;
      if (topic !== undefined && !topicRequestsWebEvidenceForFinalization(topic.question)) {
        return "topic_not_web_eligible";
      }
      return undefined;
    };
    const noCallRowsToSeal: (typeof observationRows)[number][] = [];
    for (const row of retrievalRows) {
      const parsed = RetrievalManifestSchema.parse(row.payload);
      const requiredReason = requiredNoCallReasonFor(row.emittingTask);
      if (requiredReason !== undefined && parsed.noCallReason !== requiredReason) {
        return yield* Effect.fail(
          new Error("retrieval manifest has an invalid durable no-call reason"),
        );
      }
      if (parsed.noCallReason !== undefined) {
        if (!documentedNoCallRetrieval(row)) {
          return yield* Effect.fail(
            new Error("retrieval manifest has an invalid durable no-call reason"),
          );
        }
        const seal = noCallSealsBySelectorObservation.get(row.observationKey);
        if (terminalReplay) {
          if (
            seal === undefined ||
            seal.selectorTaskId !== row.emittingTask ||
            seal.selectorLoopIteration !== row.loopIteration ||
            seal.selectorAttempt !== row.attempt ||
            seal.noCallReason !== parsed.noCallReason
          ) {
            return yield* Effect.fail(
              new Error("retrieval manifest lacks its exact durable no-call seal"),
            );
          }
        } else {
          noCallRowsToSeal.push(row);
        }
        continue;
      }
      const rowMeasurementKey = latestMeasurementKeyFor(
        row.emittingTask,
        row.loopIteration,
        row.attempt,
      );
      if (rowMeasurementKey === undefined) {
        return yield* Effect.fail(
          new Error("retrieval manifest attempt lacks its latest provider measurement"),
        );
      }
      const matchingUsage = usageRows.filter((usage) => usageKeyFor(usage) === rowMeasurementKey);
      if (matchingUsage.length !== 1) {
        return yield* Effect.fail(
          new Error("retrieval manifest attempt lacks its exact provider usage"),
        );
      }
    }
    for (const owner of expectedRetrievalOwners) {
      const requiredReason = requiredNoCallReasonFor(owner);
      if (requiredReason === undefined) continue;
      const row = terminalRetrievalRows.get(owner);
      if (row === undefined) {
        return yield* Effect.fail(new Error(`missing retrieval manifest for ${owner}`));
      }
      const manifest = RetrievalManifestSchema.safeParse(row.payload);
      if (!manifest.success || manifest.data.noCallReason !== requiredReason) {
        return yield* Effect.fail(
          new Error("retrieval manifest has an invalid durable no-call reason"),
        );
      }
    }
    const noCallRetrievalRowCount = retrievalRows.filter(
      (row) => RetrievalManifestSchema.parse(row.payload).noCallReason !== undefined,
    ).length;
    if (terminalReplay && noCallSealsBySelectorObservation.size !== noCallRetrievalRowCount) {
      return yield* Effect.fail(new Error("retrieval no-call seal has no exact manifest"));
    }
    if (!terminalReplay) {
      for (const row of noCallRowsToSeal) {
        const manifest = RetrievalManifestSchema.parse(row.payload);
        yield* insertAiObservation({
          runId,
          chatId: run.chatId,
          emittingTask: "finalize",
          loopIteration: finalizationCoordinates.loopIteration,
          attempt: finalizationCoordinates.attempt,
          observationKey: [
            "retrieval_no_call_seal",
            row.emittingTask,
            row.loopIteration,
            row.attempt,
          ].join(":"),
          kind: "retrieval_no_call_seal",
          payload: {
            selectorTaskId: row.emittingTask,
            selectorLoopIteration: row.loopIteration,
            selectorAttempt: row.attempt,
            selectorObservationKey: row.observationKey,
            noCallReason: manifest.noCallReason!,
          },
        });
      }
    }
    const latestOutputRows = new Map<string, (typeof observationRows)[number]>();
    for (const row of observationRows) {
      if (
        ![
          "turn_plan",
          "retrieval_manifest",
          "topic_packet",
          "context_reducer_terminal",
          "memory_extraction_result",
          "context_serialized",
        ].includes(row.kind)
      ) {
        continue;
      }
      const key = `${row.kind}:${row.emittingTask}`;
      const previous = latestOutputRows.get(key);
      if (
        previous === undefined ||
        coordinateOrder(
          [previous.loopIteration, previous.attempt, 0].join(":"),
          [row.loopIteration, row.attempt, 0].join(":"),
        ) < 0
      ) {
        latestOutputRows.set(key, row);
      }
    }
    for (const row of latestOutputRows.values()) {
      if (documentedNoCallRetrieval(row)) continue;
      const taskMeasurements = allMeasurementKeysFor(row.emittingTask);
      if (taskMeasurements.length === 0) {
        return yield* Effect.fail(
          new Error(`${row.kind} output lacks its latest provider measurement`),
        );
      }
      const rowMeasurementKeys = measurementKeysFor(
        row.emittingTask,
        row.loopIteration,
        row.attempt,
      );
      const rowMeasurementKey = rowMeasurementKeys.at(-1);
      const latestMeasurementKey = taskMeasurements.at(-1);
      if (rowMeasurementKey === undefined || rowMeasurementKey !== latestMeasurementKey) {
        return yield* Effect.fail(
          new Error(`${row.kind} output is not bound to its latest provider measurement`),
        );
      }
      const latestUsageKey = latestUsageKeyFor(row.emittingTask);
      if (latestUsageKey !== rowMeasurementKey) {
        if (
          row.kind === "context_serialized" &&
          allowsTerminalTransportMeasurement &&
          permittedTerminalFailureOwner(row.emittingTask)
        ) {
          continue;
        }
        return yield* Effect.fail(
          new Error(`${row.kind} output is not bound to its latest provider usage`),
        );
      }
      if (!usageCoordinates.has(rowMeasurementKey)) {
        return yield* Effect.fail(new Error(`${row.kind} output lacks its exact provider usage`));
      }
    }
    for (const row of latestOutputRows.values()) {
      if (row.kind !== "context_reducer_terminal") continue;
      const parsed = ContextReducerTerminalSchema.safeParse(row.payload);
      if (!parsed.success) {
        return yield* Effect.fail(new Error("context reducer terminal output is not strict"));
      }
      const coordinate = parsed.data.terminalUsageCoordinate;
      const key = [
        coordinate.taskId,
        coordinate.loopIteration,
        coordinate.attempt,
        coordinate.providerRequestIndex,
      ].join(":");
      const measurement = measurements.get(key);
      const usage = usageRows.find((candidate) => usageKeyFor(candidate) === key);
      if (
        coordinate.taskId !== row.emittingTask ||
        coordinate.loopIteration !== row.loopIteration ||
        coordinate.attempt !== row.attempt ||
        latestMeasurementKeyFor(row.emittingTask, row.loopIteration, row.attempt) !== key ||
        measurement === undefined ||
        usage === undefined ||
        parsed.data.modelId !== measurement.modelId ||
        parsed.data.requestSha256Hex !== measurement.requestSha256Hex ||
        parsed.data.providerInputTokens !== measurement.inputTokens ||
        parsed.data.totalTokens !== usage.inputTokens + usage.cachedTokens + usage.outputTokens ||
        parsed.data.stopReason !== usage.stopReason
      ) {
        return yield* Effect.fail(
          new Error("context reducer terminal output is not bound to its exact provider result"),
        );
      }
    }
    const providerOutputAttemptKeys = new Set(
      observationRows
        .filter((observation) =>
          [
            "turn_plan",
            "retrieval_manifest",
            "topic_packet",
            "context_decision",
            "context_reducer_terminal",
            "memory_extraction_result",
          ].includes(observation.kind),
        )
        .map((observation) =>
          [observation.emittingTask, observation.loopIteration, observation.attempt].join(":"),
        ),
    );
    const providerOutputCoordinates = new Set<string>();
    for (const observation of observationRows) {
      if (
        ![
          "turn_plan",
          "retrieval_manifest",
          "topic_packet",
          "context_decision",
          "context_reducer_terminal",
          "memory_extraction_result",
        ].includes(observation.kind)
      ) {
        continue;
      }
      const coordinate = [
        observation.kind,
        observation.emittingTask,
        observation.loopIteration,
        observation.attempt,
      ].join(":");
      if (providerOutputCoordinates.has(coordinate)) {
        return yield* Effect.fail(new Error("duplicate provider output at one attempt"));
      }
      providerOutputCoordinates.add(coordinate);
    }
    for (const [groupKey, keys] of measurementGroups) {
      const unmatched = keys.filter((key) => !usageCoordinates.has(key));
      if (unmatched.length === 0) continue;
      const [taskId, loopIteration, attempt] = groupKey.split(":");
      const latest = latestMeasurementKeyFor(taskId!, Number(loopIteration), Number(attempt));
      const retryOrCrashMeasurement = unmatched.length === 1 && unmatched[0] === latest;
      if (!retryOrCrashMeasurement || providerOutputAttemptKeys.has(groupKey)) {
        return yield* Effect.fail(
          new Error(
            "unmatched provider measurement is not an allowed terminal retry row: " + groupKey,
          ),
        );
      }
    }
    if (
      !usageCoordinates.has(planMeasurementKey) &&
      !(
        allowsTerminalTransportMeasurement &&
        permittedTerminalFailureOwner(terminalPlan.emittingTask)
      )
    ) {
      return yield* Effect.fail(new Error("turn_plan lacks matching provider usage"));
    }

    const terminalUsageKeys = new Set([planMeasurementKey]);
    const contextMeasureTaskIdsFor = (consumerTaskId: string): readonly string[] => {
      if (consumerTaskId === "single-answer") {
        return ["single-measure", "single-reduce-measure"];
      }
      if (/^topic-t[123]-answer$/u.test(consumerTaskId)) {
        const topicId = consumerTaskId.slice("topic-".length, -"-answer".length);
        return [`topic-${topicId}-measure`, `topic-${topicId}-reduce-measure`];
      }
      if (consumerTaskId === "fanout-synthesis") {
        return ["fanout-synthesis-measure"];
      }
      if (consumerTaskId === "evaluation-general-planner") {
        return ["evaluation-general-planner"];
      }
      return [];
    };

    const failedContextLedgerMeasurementError = (
      serialized: (typeof observationRows)[number],
      usageKey: string,
      measureTaskIds: readonly string[],
      consumerTaskId: string,
    ): string | null => {
      const parsed = RestrictedContextLedgerSchema.safeParse(
        serialized.payload.restrictedContextLedger,
      );
      const measurement = measurements.get(usageKey);
      if (!parsed.success || measurement === undefined) {
        return "context serialization lacks its strict measurement ledger";
      }
      if (measureTaskIds.length === 0) {
        return "context serialization lacks its path-specific context measurement";
      }
      const expectedMeasureTaskSet = new Set(measureTaskIds);
      const foreignPathMeasurement = observationRows.find(
        (observation) =>
          observation.kind === "context_measurement" &&
          !expectedMeasureTaskSet.has(observation.emittingTask) &&
          [
            "single-measure",
            "single-reduce-measure",
            "fanout-synthesis-measure",
            "topic-t1-measure",
            "topic-t1-reduce-measure",
            "topic-t2-measure",
            "topic-t2-reduce-measure",
            "topic-t3-measure",
            "topic-t3-reduce-measure",
          ].includes(observation.emittingTask) &&
          observation.payload.consumerTaskId === consumerTaskId,
      );
      if (foreignPathMeasurement !== undefined) {
        return "context path measurement has a foreign measure owner";
      }
      const pathMeasurements = observationRows.filter(
        (observation) =>
          observation.kind === "context_measurement" &&
          expectedMeasureTaskSet.has(observation.emittingTask),
      );
      if (pathMeasurements.length === 0) {
        return "context serialization lacks its path-specific context measurement";
      }
      const pathCoordinates = new Set<string>();
      const parsedPathMeasurements: Array<{
        readonly row: (typeof observationRows)[number];
        readonly payload: {
          readonly consumerTaskId: string;
          readonly mandatoryInputTokens: number;
          readonly discretionaryInputTokens: number;
          readonly totalInputTokens: number;
          readonly requestedOutputTokens: number;
          readonly usableInputTokens: number;
          readonly contextWindow: number;
          readonly status: "ready" | "needs_reduction";
          readonly restrictedContextLedger: z.infer<typeof RestrictedContextLedgerSchema>;
        };
      }> = [];
      for (const pathMeasurement of pathMeasurements) {
        const coordinate = `${pathMeasurement.emittingTask}:${pathMeasurement.loopIteration}:${pathMeasurement.attempt}`;
        if (pathCoordinates.has(coordinate)) {
          return "context serialization has duplicate path-specific context measurements";
        }
        pathCoordinates.add(coordinate);
        const payload = z
          .object({
            consumerTaskId: z.string().trim().min(1),
            topicId: z.enum(["t1", "t2", "t3"]).optional(),
            mandatoryInputTokens: z.number().int().nonnegative(),
            discretionaryInputTokens: z.number().int().nonnegative(),
            totalInputTokens: z.number().int().nonnegative(),
            requestedOutputTokens: z.number().int().positive(),
            usableInputTokens: z.number().int().positive(),
            contextWindow: z.number().int().positive(),
            status: z.enum(["ready", "needs_reduction"]),
            reductionRan: z.boolean(),
            reductionFeedback: z.array(z.string()),
            restrictedContextLedger: RestrictedContextLedgerSchema,
          })
          .strict()
          .safeParse(pathMeasurement.payload);
        if (!payload.success) {
          return "context path measurement payload is not exact";
        }
        if (payload.data.consumerTaskId !== consumerTaskId) {
          return "context path measurement consumer is not exact";
        }
        parsedPathMeasurements.push({ row: pathMeasurement, payload: payload.data });
      }
      const reductionMeasureTaskId = measureTaskIds[1];
      const terminalPathMeasurements =
        reductionMeasureTaskId === undefined
          ? parsedPathMeasurements.filter((entry) => entry.row.emittingTask === measureTaskIds[0])
          : parsedPathMeasurements.filter(
                (entry) => entry.row.emittingTask === reductionMeasureTaskId,
              ).length > 0
            ? parsedPathMeasurements.filter(
                (entry) => entry.row.emittingTask === reductionMeasureTaskId,
              )
            : parsedPathMeasurements.filter(
                (entry) => entry.row.emittingTask === measureTaskIds[0],
              );
      const terminalPathMeasurement = terminalPathMeasurements
        .sort(
          (left, right) =>
            left.row.loopIteration - right.row.loopIteration ||
            left.row.attempt - right.row.attempt ||
            left.row.emittingTask.localeCompare(right.row.emittingTask),
        )
        .at(-1)!;
      if (
        canonicalJson(terminalPathMeasurement.payload.restrictedContextLedger) !==
        canonicalJson(parsed.data)
      ) {
        return "context ledger differs from its path-specific context measurement";
      }
      if (
        terminalPathMeasurement.payload.totalInputTokens !== parsed.data.inputTokens ||
        terminalPathMeasurement.payload.totalInputTokens !== measurement.inputTokens ||
        terminalPathMeasurement.payload.requestedOutputTokens !==
          parsed.data.requestedOutputTokens ||
        terminalPathMeasurement.payload.requestedOutputTokens !==
          measurement.requestedOutputTokens ||
        terminalPathMeasurement.payload.usableInputTokens !== parsed.data.usableInputTokens ||
        terminalPathMeasurement.payload.usableInputTokens !== measurement.usableInputTokens ||
        terminalPathMeasurement.payload.contextWindow !== measurement.contextWindow ||
        terminalPathMeasurement.payload.status !== "ready" ||
        terminalPathMeasurement.payload.discretionaryInputTokens !==
          Math.max(
            0,
            terminalPathMeasurement.payload.totalInputTokens -
              terminalPathMeasurement.payload.mandatoryInputTokens,
          )
      ) {
        return "context path measurement token ledger differs from its provider measurement";
      }
      return null;
    };
    if (answer.status === "ok" && answer.mode !== "clarification") {
      const evaluationTopology = terminalPlan.emittingTask === "evaluation-general-planner";
      const expectedContextTask = evaluationTopology
        ? "evaluation-general-planner"
        : answer.mode === "single"
          ? "single-answer"
          : "fanout-synthesis";
      const expectedSerializedConsumer = evaluationTopology
        ? answer.mode === "synthesis"
          ? "fanout-synthesis"
          : "single-answer"
        : expectedContextTask;
      const contextRows = observationRows.filter(
        (observation) =>
          observation.kind === "context_serialized" &&
          observation.emittingTask === expectedContextTask,
      );
      if (contextRows.length === 0) {
        return yield* Effect.fail(new Error("answer has no serialized context owner"));
      }
      type ObservationRow = (typeof observationRows)[number];
      const expectedSourcesFor = (consumerTaskId: string, topicId: string | undefined) =>
        answer.sourceMap
          .flatMap((source) => {
            const use = source.uses.find(
              (candidate) =>
                candidate.consumerTaskId === consumerTaskId && candidate.topicId === topicId,
            );
            return use === undefined ? [] : [{ source, use }];
          })
          .sort((left, right) => left.use.contextOrder - right.use.contextOrder);
      const sourceKeysMatch = (
        serialized: ObservationRow,
        expectedSources: readonly { readonly source: FinalSourceRecord }[],
      ): boolean => {
        const sourceKeys = serialized.payload.sourceKeys;
        const expectedSourceKeys = expectedSources.map(({ source }) => source.sourceKey);
        return (
          Array.isArray(sourceKeys) &&
          sourceKeys.every((sourceKey) => typeof sourceKey === "string") &&
          JSON.stringify(sourceKeys) === JSON.stringify(expectedSourceKeys)
        );
      };
      const contextLedgerError = (
        serialized: ObservationRow,
        expectedConsumerTaskId: string,
        expectedTopicId: string | undefined,
        expectedQuestion: string,
        expectedSelectedTurnIds: readonly string[],
        expectedSources: readonly {
          readonly source: FinalSourceRecord;
          readonly use: FinalSourceRecord["uses"][number];
        }[],
      ): string | null => {
        const parsed = RestrictedContextLedgerSchema.safeParse(
          serialized.payload.restrictedContextLedger,
        );
        if (!parsed.success) {
          return "context serialization lacks its source ledger";
        }
        const ledger = parsed.data;
        const expectedKind = expectedTopicId === undefined ? "direct" : "topic";
        if (ledger.requestKind !== expectedKind || ledger.modelId !== "glm-5-turbo") {
          return "context request kind or model differs";
        }
        if (ledger.requestKind === "topic" && ledger.topicId !== expectedTopicId) {
          return "context topic differs";
        }
        if (ledger.question !== expectedQuestion) {
          return "context question differs from the turn plan";
        }
        if (ledger.selectedConversation.some((entry) => entry.turnId.trim() === "")) {
          return "context conversation ledger contains an empty turn";
        }
        const ledgerTurnIds = ledger.selectedConversation.map((entry) => entry.turnId);
        if (
          new Set(ledgerTurnIds).size !== ledgerTurnIds.length ||
          new Set(ledgerTurnIds).size !== new Set(expectedSelectedTurnIds).size ||
          ledgerTurnIds.some((turnId) => !expectedSelectedTurnIds.includes(turnId))
        ) {
          return "context conversation ledger differs from the turn plan";
        }
        const ledgerSources = ledger.sources;
        if (ledgerSources.length !== expectedSources.length) {
          return "context source ledger cardinality differs";
        }
        for (const [index, expected] of expectedSources.entries()) {
          const ledgerSource = ledgerSources[index]!;
          const source = expected.source;
          const use = expected.use;
          if (
            ledgerSource.candidateId !== candidateIdentity(source) ||
            ledgerSource.sourceKey !== source.sourceKey ||
            ledgerSource.kind !== source.locator.kind ||
            ledgerSource.label !== (source.label || null) ||
            !rangesEqual(ledgerSource.ranges, use.ranges) ||
            use.contextOrder !== index
          ) {
            return "context source ledger differs from the saved answer source map";
          }
        }
        return null;
      };
      const contextLedgerMeasurementError = (
        serialized: ObservationRow,
        usageKey: string,
        measureTaskIds: readonly string[],
        consumerTaskId: string,
      ): string | null => {
        const parsed = RestrictedContextLedgerSchema.safeParse(
          serialized.payload.restrictedContextLedger,
        );
        if (!parsed.success) {
          return "context serialization lacks its strict ledger";
        }
        const measurement = measurements.get(usageKey);
        if (measurement === undefined) return "context serialization lacks its measurement";
        if (
          parsed.data.modelId !== measurement.modelId ||
          parsed.data.requestSha256Hex !== measurement.requestSha256Hex ||
          parsed.data.inputTokens !== measurement.inputTokens ||
          parsed.data.usableInputTokens !== measurement.usableInputTokens ||
          parsed.data.requestedOutputTokens !== measurement.requestedOutputTokens
        ) {
          return "context ledger differs from its provider measurement";
        }
        if (measureTaskIds.length === 0) {
          return "context ledger lacks its path-specific context measurement";
        }
        const expectedMeasureTaskSet = new Set(measureTaskIds);
        const foreignPathMeasurement = observationRows.find(
          (observation) =>
            observation.kind === "context_measurement" &&
            !expectedMeasureTaskSet.has(observation.emittingTask) &&
            [
              "single-measure",
              "single-reduce-measure",
              "fanout-synthesis-measure",
              "topic-t1-measure",
              "topic-t1-reduce-measure",
              "topic-t2-measure",
              "topic-t2-reduce-measure",
              "topic-t3-measure",
              "topic-t3-reduce-measure",
            ].includes(observation.emittingTask) &&
            observation.payload.consumerTaskId === consumerTaskId,
        );
        if (foreignPathMeasurement !== undefined) {
          return "context path measurement has a foreign measure owner";
        }
        const pathMeasurements = observationRows.filter(
          (observation) =>
            observation.kind === "context_measurement" &&
            expectedMeasureTaskSet.has(observation.emittingTask),
        );
        if (pathMeasurements.length === 0) {
          return "context ledger lacks its path-specific context measurement";
        }
        const pathCoordinates = new Set<string>();
        const parsedPathMeasurements: Array<{
          readonly row: ObservationRow;
          readonly payload: {
            readonly mandatoryInputTokens: number;
            readonly discretionaryInputTokens: number;
            readonly totalInputTokens: number;
            readonly requestedOutputTokens: number;
            readonly usableInputTokens: number;
            readonly contextWindow: number;
            readonly status: "ready" | "needs_reduction";
            readonly reductionRan: boolean;
            readonly reductionFeedback: readonly string[];
            readonly restrictedContextLedger: unknown;
          };
        }> = [];
        for (const pathMeasurement of pathMeasurements) {
          const coordinate = `${pathMeasurement.emittingTask}:${pathMeasurement.loopIteration}:${pathMeasurement.attempt}`;
          if (pathCoordinates.has(coordinate)) {
            return "context ledger has duplicate path-specific measurements";
          }
          pathCoordinates.add(coordinate);
          const payload = z
            .object({
              consumerTaskId: z.string().trim().min(1),
              topicId: z.enum(["t1", "t2", "t3"]).optional(),
              mandatoryInputTokens: z.number().int().nonnegative(),
              discretionaryInputTokens: z.number().int().nonnegative(),
              totalInputTokens: z.number().int().nonnegative(),
              requestedOutputTokens: z.number().int().positive(),
              usableInputTokens: z.number().int().positive(),
              contextWindow: z.number().int().positive(),
              status: z.enum(["ready", "needs_reduction"]),
              reductionRan: z.boolean(),
              reductionFeedback: z.array(z.string()),
              restrictedContextLedger: RestrictedContextLedgerSchema,
            })
            .strict()
            .safeParse(pathMeasurement.payload);
          if (!payload.success || payload.data.consumerTaskId !== consumerTaskId) {
            return "context ledger path measurement payload is not exact";
          }
          parsedPathMeasurements.push({ row: pathMeasurement, payload: payload.data });
        }
        const reductionMeasureTaskId = measureTaskIds[1];
        const terminalMeasurements =
          reductionMeasureTaskId === undefined
            ? parsedPathMeasurements.filter((entry) => entry.row.emittingTask === measureTaskIds[0])
            : parsedPathMeasurements.filter(
                  (entry) => entry.row.emittingTask === reductionMeasureTaskId,
                ).length > 0
              ? parsedPathMeasurements.filter(
                  (entry) => entry.row.emittingTask === reductionMeasureTaskId,
                )
              : parsedPathMeasurements.filter(
                  (entry) => entry.row.emittingTask === measureTaskIds[0],
                );
        const terminalMeasurement = terminalMeasurements
          .sort(
            (left, right) =>
              left.row.loopIteration - right.row.loopIteration ||
              left.row.attempt - right.row.attempt ||
              left.row.emittingTask.localeCompare(right.row.emittingTask),
          )
          .at(-1)!;
        const measuredLedger = RestrictedContextLedgerSchema.safeParse(
          terminalMeasurement.payload.restrictedContextLedger,
        );
        if (
          !measuredLedger.success ||
          canonicalJson(measuredLedger.data) !== canonicalJson(parsed.data)
        ) {
          return "context ledger differs from its path-specific context measurement";
        }
        if (
          terminalMeasurement.payload.totalInputTokens !== parsed.data.inputTokens ||
          terminalMeasurement.payload.totalInputTokens !== measurement.inputTokens ||
          terminalMeasurement.payload.requestedOutputTokens !== parsed.data.requestedOutputTokens ||
          terminalMeasurement.payload.requestedOutputTokens !== measurement.requestedOutputTokens ||
          terminalMeasurement.payload.usableInputTokens !== parsed.data.usableInputTokens ||
          terminalMeasurement.payload.usableInputTokens !== measurement.usableInputTokens ||
          terminalMeasurement.payload.contextWindow !== measurement.contextWindow ||
          terminalMeasurement.payload.status !== "ready" ||
          terminalMeasurement.payload.discretionaryInputTokens !==
            Math.max(
              0,
              terminalMeasurement.payload.totalInputTokens -
                terminalMeasurement.payload.mandatoryInputTokens,
            )
        ) {
          return "context path measurement token ledger differs from its provider measurement";
        }
        return null;
      };
      const synthesisLedgerError = (
        serialized: ObservationRow,
        usageKey: string,
        expectedSelectedTurnIds: readonly string[],
      ): string | null => {
        const parsed = RestrictedContextLedgerSchema.safeParse(
          serialized.payload.restrictedContextLedger,
        );
        if (!parsed.success || parsed.data.requestKind !== "synthesis") {
          return "synthesis context serialization lacks its strict ledger";
        }
        const measurement = measurements.get(usageKey);
        if (
          measurement === undefined ||
          parsed.data.modelId !== measurement.modelId ||
          parsed.data.requestSha256Hex !== measurement.requestSha256Hex ||
          parsed.data.inputTokens !== measurement.inputTokens ||
          parsed.data.usableInputTokens !== measurement.usableInputTokens ||
          parsed.data.requestedOutputTokens !== measurement.requestedOutputTokens
        ) {
          return "synthesis context ledger differs from its provider measurement";
        }
        if (
          parsed.data.packets.map((packet) => packet.topicId).join(",") !==
          (parsedPlan.data.mode === "fanout"
            ? parsedPlan.data.topics.map((topic) => topic.topicId).join(",")
            : "")
        ) {
          return "synthesis packet order differs from the fanout plan";
        }
        const ledgerTurnIds = parsed.data.selectedConversation.map((entry) => entry.turnId);
        if (
          new Set(ledgerTurnIds).size !== ledgerTurnIds.length ||
          new Set(ledgerTurnIds).size !== new Set(expectedSelectedTurnIds).size ||
          ledgerTurnIds.some((turnId) => !expectedSelectedTurnIds.includes(turnId))
        ) {
          return "synthesis conversation ledger differs from the turn plan";
        }
        const packetRows = new Map<
          string,
          {
            readonly payload: z.infer<typeof TopicPacketObservationSchema>;
            readonly loopIteration: number;
            readonly attempt: number;
          }
        >();
        for (const packetRow of observationRows.filter(
          (observation) => observation.kind === "topic_packet",
        )) {
          const parsedPacket = TopicPacketObservationSchema.safeParse(packetRow.payload);
          if (!parsedPacket.success) return "topic packet observation is not strict";
          if (packetRow.emittingTask !== `topic-${parsedPacket.data.topicId}-answer`) {
            return "topic packet observation has a foreign owner";
          }
          const visibleTopicKeys = answer.sourceMap
            .filter((source) =>
              source.uses.some(
                (use) =>
                  use.consumerTaskId === `topic-${parsedPacket.data.topicId}-answer` &&
                  use.topicId === parsedPacket.data.topicId,
              ),
            )
            .map((source) => source.sourceKey);
          if (
            new Set(parsedPacket.data.sourceKeys).size !== parsedPacket.data.sourceKeys.length ||
            parsedPacket.data.sourceKeys.some((sourceKey) => !visibleTopicKeys.includes(sourceKey))
          ) {
            return "topic packet source keys differ from its topic context";
          }
          const previous = packetRows.get(parsedPacket.data.topicId);
          if (
            previous === undefined ||
            packetRow.loopIteration > previous.loopIteration ||
            (packetRow.loopIteration === previous.loopIteration &&
              packetRow.attempt > previous.attempt)
          ) {
            packetRows.set(parsedPacket.data.topicId, {
              payload: parsedPacket.data,
              loopIteration: packetRow.loopIteration,
              attempt: packetRow.attempt,
            });
          }
        }
        if (packetRows.size !== parsed.data.packets.length) {
          return "synthesis ledger packet set differs from topic packets";
        }
        for (const packet of parsed.data.packets) {
          const observed = packetRows.get(packet.topicId)?.payload;
          if (
            observed === undefined ||
            observed.status !== packet.status ||
            observed.claimCount !== packet.claimCount ||
            observed.gapCount !== packet.gapCount ||
            observed.packetSha256Hex !== packet.packetSha256Hex
          ) {
            return "synthesis ledger differs from topic packet observations";
          }
        }
        return null;
      };
      const sourceExposureIdentityFor = (
        source: FinalSourceRecord,
        use: FinalSourceRecord["uses"][number],
      ): {
        readonly sourceKind: string;
        readonly logicalSourceIdentity: string;
        readonly contentItemIdentity: string;
        readonly documentRanges:
          | readonly { readonly charStart: number; readonly charEnd: number }[]
          | null;
      } => {
        const locator = source.locator;
        switch (locator.kind) {
          case "document": {
            const logicalSourceIdentity = candidateIdentity(source);
            return {
              sourceKind: locator.kind,
              logicalSourceIdentity,
              contentItemIdentity: `${logicalSourceIdentity}:${locator.versionId}:${sha256Base64Url(JSON.stringify(use.ranges))}`,
              documentRanges: use.ranges,
            };
          }
          case "chat_message":
            return {
              sourceKind: locator.kind,
              logicalSourceIdentity: candidateIdentity(source),
              contentItemIdentity: locator.messageId,
              documentRanges: null,
            };
          case "memory":
            return {
              sourceKind: locator.kind,
              logicalSourceIdentity: candidateIdentity(source),
              contentItemIdentity: locator.memoryRevisionId,
              documentRanges: null,
            };
          case "web":
            return {
              sourceKind: locator.kind,
              logicalSourceIdentity: candidateIdentity(source),
              contentItemIdentity: `${locator.url}:${locator.quoteHash}`,
              documentRanges: null,
            };
        }
      };
      const answerExposureError = (
        serialized: ObservationRow,
        usageKey: string,
        expectedSources: readonly {
          readonly source: FinalSourceRecord;
          readonly use: FinalSourceRecord["uses"][number];
        }[],
      ): string | null => {
        const [taskId, loopIterationText, attemptText, requestIndexText] = usageKey.split(":");
        const loopIteration = Number(loopIterationText);
        const attempt = Number(attemptText);
        const providerRequestIndex = Number(requestIndexText);
        const actual = exposureRows.filter(
          (exposure) =>
            exposure.taskId === taskId &&
            exposure.loopIteration === loopIteration &&
            exposure.attempt === attempt &&
            exposure.providerRequestIndex === providerRequestIndex &&
            exposure.exposureStage === "answer_serialized",
        );
        const measurement = measurements.get(usageKey);
        const measuredProofs = measurement?.sourceExposureProofSha256Hexes;
        if (
          expectedSources.length > 0 &&
          (!Array.isArray(measuredProofs) || measuredProofs.length === 0)
        ) {
          return "non-empty serialized answer sources have an empty provider proof set";
        }
        if (actual.length !== expectedSources.length) {
          return "serialized answer sources and answer_serialized exposures are not bijective";
        }
        const used = new Set<string>();
        for (const expected of expectedSources) {
          const identity = sourceExposureIdentityFor(expected.source, expected.use);
          const expectedDocument =
            expected.source.locator.kind === "document" ? expected.source.locator : null;
          const matching = actual.filter(
            (exposure) =>
              exposure.sourceKind === identity.sourceKind &&
              exposure.logicalSourceIdentity === identity.logicalSourceIdentity &&
              exposure.contentItemIdentity === identity.contentItemIdentity &&
              (identity.documentRanges === null
                ? exposure.documentRanges === null &&
                  exposure.documentSourceId === null &&
                  exposure.documentId === null &&
                  exposure.versionId === null &&
                  exposure.contentHash === null &&
                  exposure.publisherExtractionId === null
                : exposure.documentRanges !== null &&
                  rangesEqual(exposure.documentRanges, identity.documentRanges) &&
                  exposure.documentSourceId === expectedDocument?.sourceId &&
                  exposure.documentId === expectedDocument?.documentId &&
                  exposure.versionId === expectedDocument?.versionId &&
                  exposure.contentHash === expectedDocument?.contentHash &&
                  exposure.publisherExtractionId ===
                    (expectedDocument?.publisherExtractionId ?? null)),
          );
          if (matching.length !== 1) {
            return "serialized answer source lacks its exact answer_serialized exposure";
          }
          const key = [
            matching[0]!.taskId,
            matching[0]!.loopIteration,
            matching[0]!.attempt,
            matching[0]!.providerRequestIndex,
            matching[0]!.sourceKind,
            matching[0]!.logicalSourceIdentity,
            matching[0]!.contentItemIdentity,
            matching[0]!.exposureStage,
          ].join(":");
          if (used.has(key)) return "duplicate answer_serialized exposure binding";
          used.add(key);
        }
        if (used.size !== actual.length) return "answer_serialized exposure has an unknown source";
        if (serialized.payload.sourceKeys !== undefined) {
          const sourceKeys = serialized.payload.sourceKeys;
          const expectedKeys = expectedSources.map(({ source }) => source.sourceKey);
          if (
            !Array.isArray(sourceKeys) ||
            JSON.stringify(sourceKeys) !== JSON.stringify(expectedKeys)
          ) {
            return "answer_serialized exposure source keys differ from its context ledger";
          }
        }
        return null;
      };
      const terminalContextUsageKey = (
        serialized: ObservationRow,
        expectedOwner: string,
      ): string | null => {
        const coordinate = z
          .object({
            taskId: z.string().min(1),
            loopIteration: z.number().int().nonnegative(),
            attempt: z.number().int().nonnegative(),
            providerRequestIndex: z.number().int().nonnegative(),
          })
          .strict()
          .safeParse(serialized.payload.terminalUsageCoordinate);
        if (!coordinate.success) return null;
        const owner = coordinate.data;
        const key = [
          owner.taskId,
          owner.loopIteration,
          owner.attempt,
          owner.providerRequestIndex,
        ].join(":");
        const rowKey = [
          serialized.emittingTask,
          serialized.loopIteration,
          serialized.attempt,
          owner.providerRequestIndex,
        ].join(":");
        return owner.taskId === expectedOwner &&
          rowKey === key &&
          latestMeasurementKeyFor(owner.taskId, owner.loopIteration, owner.attempt) === key &&
          measurements.has(key) &&
          usageCoordinates.has(key)
          ? key
          : null;
      };
      const row = orderedByAttempt(contextRows).at(-1)!;
      const serializedFields = evaluationTopology
        ? new Set(["consumerTaskId", "sourceKeys"])
        : new Set([
            "consumerTaskId",
            "sourceKeys",
            "restrictedContextLedger",
            "terminalUsageCoordinate",
            ...(answer.mode === "synthesis" ? [] : ["topicId"]),
          ]);
      if (Object.keys(row.payload).some((field) => !serializedFields.has(field))) {
        return yield* Effect.fail(
          new Error("context serialization payload contains an unknown field"),
        );
      }
      const expectedSources = expectedSourcesFor(expectedContextTask, undefined);
      const serializedSourceExpectations =
        evaluationTopology || answer.mode === "synthesis"
          ? answer.sourceMap.map((source) => ({ source }))
          : expectedSources;
      if (!sourceKeysMatch(row, serializedSourceExpectations)) {
        return yield* Effect.fail(
          new Error("context serialization source keys differ from the saved answer source map"),
        );
      }
      if (row.payload.consumerTaskId !== expectedSerializedConsumer) {
        return yield* Effect.fail(new Error("context serialization has a foreign consumer"));
      }
      if (answer.mode === "single") {
        if (row.payload.topicId !== undefined) {
          return yield* Effect.fail(new Error("single context serialization has a topic owner"));
        }
        if (!evaluationTopology) {
          const ledgerError = contextLedgerError(
            row,
            expectedContextTask,
            undefined,
            parsedPlan.data.question,
            selectedTurnIds,
            expectedSources,
          );
          if (ledgerError !== null) return yield* Effect.fail(new Error(ledgerError));
        }
      } else if (!evaluationTopology) {
        if (row.payload.topicId !== undefined) {
          return yield* Effect.fail(new Error("synthesis context serialization has a topic owner"));
        }
        if (parsedPlan.data.mode !== "fanout") {
          return yield* Effect.fail(new Error("synthesis answer lacks a fanout turn plan"));
        }
        for (const topic of parsedPlan.data.topics) {
          const topicTask = `topic-${topic.topicId}-answer`;
          const topicRows = observationRows.filter(
            (observation) =>
              observation.kind === "context_serialized" && observation.emittingTask === topicTask,
          );
          if (topicRows.length === 0) {
            return yield* Effect.fail(new Error(`answer has no serialized ${topicTask} context`));
          }
          const topicRow = orderedByAttempt(topicRows).at(-1)!;
          const topicSources = expectedSourcesFor(topicTask, topic.topicId);
          if (
            Object.keys(topicRow.payload).some(
              (field) =>
                !new Set([
                  "consumerTaskId",
                  "topicId",
                  "sourceKeys",
                  "restrictedContextLedger",
                  "terminalUsageCoordinate",
                ]).has(field),
            )
          ) {
            return yield* Effect.fail(new Error(`${topicTask} context has an unknown field`));
          }
          if (
            !sourceKeysMatch(topicRow, topicSources) ||
            topicRow.payload.consumerTaskId !== topicTask ||
            topicRow.payload.topicId !== topic.topicId
          ) {
            return yield* Effect.fail(
              new Error(`${topicTask} context differs from the saved answer source map`),
            );
          }
          const ledgerError = contextLedgerError(
            topicRow,
            topicTask,
            topic.topicId,
            topic.question,
            topic.relevantTurnIds,
            topicSources,
          );
          if (ledgerError !== null) return yield* Effect.fail(new Error(ledgerError));
          const topicUsageKey = terminalContextUsageKey(topicRow, topicTask);
          if (topicUsageKey === null) {
            return yield* Effect.fail(new Error(`${topicTask} context lacks an exact usage owner`));
          }
          const topicMeasurementError = contextLedgerMeasurementError(
            topicRow,
            topicUsageKey,
            contextMeasureTaskIdsFor(topicTask),
            topicTask,
          );
          if (topicMeasurementError !== null) {
            return yield* Effect.fail(new Error(topicMeasurementError));
          }
          const topicExposureError = answerExposureError(topicRow, topicUsageKey, topicSources);
          if (topicExposureError !== null) {
            return yield* Effect.fail(new Error(topicExposureError));
          }
          terminalUsageKeys.add(topicUsageKey);
        }
      }

      if (evaluationTopology) {
        const evaluationUsage = usageRows
          .filter(
            (usage) =>
              usage.taskId === expectedContextTask &&
              usage.loopIteration === row.loopIteration &&
              usage.attempt === row.attempt,
          )
          .sort((left, right) => left.providerRequestIndex - right.providerRequestIndex)
          .at(-1);
        if (evaluationUsage === undefined) {
          return yield* Effect.fail(new Error("evaluation context lacks its provider usage"));
        }
        const evaluationUsageKey = [
          evaluationUsage.taskId,
          evaluationUsage.loopIteration,
          evaluationUsage.attempt,
          evaluationUsage.providerRequestIndex,
        ].join(":");
        if (
          latestMeasurementKeyFor(
            evaluationUsage.taskId,
            evaluationUsage.loopIteration,
            evaluationUsage.attempt,
          ) !== evaluationUsageKey
        ) {
          return yield* Effect.fail(
            new Error("evaluation context does not own the latest provider measurement"),
          );
        }
        terminalUsageKeys.add(evaluationUsageKey);
      } else if (answer.mode === "synthesis") {
        const key = terminalContextUsageKey(row, expectedContextTask);
        if (key === null) {
          return yield* Effect.fail(
            new Error("synthesis context serialization does not belong to a successful attempt"),
          );
        }
        const synthesisMeasurementError = contextLedgerMeasurementError(
          row,
          key,
          contextMeasureTaskIdsFor(expectedContextTask),
          expectedContextTask,
        );
        if (synthesisMeasurementError !== null) {
          return yield* Effect.fail(new Error(synthesisMeasurementError));
        }
        const ledgerError = synthesisLedgerError(row, key, selectedTurnIds);
        if (ledgerError !== null) return yield* Effect.fail(new Error(ledgerError));
        terminalUsageKeys.add(key);
      } else {
        const key = terminalContextUsageKey(row, expectedContextTask);
        if (key === null) {
          return yield* Effect.fail(
            new Error("context serialization does not belong to a successful attempt"),
          );
        }
        const ledgerMeasurementError = contextLedgerMeasurementError(
          row,
          key,
          contextMeasureTaskIdsFor(expectedContextTask),
          expectedContextTask,
        );
        if (ledgerMeasurementError !== null) {
          return yield* Effect.fail(new Error(ledgerMeasurementError));
        }
        const exposureError = answerExposureError(row, key, expectedSources);
        if (exposureError !== null) return yield* Effect.fail(new Error(exposureError));
        terminalUsageKeys.add(key);
      }
    }

    // A context serialization is code-owned request evidence, so it may
    // survive a transport failure without provider usage.  If a failed run
    // retains one, validate the exact terminal answer owner and allow the
    // missing usage only for that owner's transport failure code.
    if (answer.status === "failed") {
      const latestContextRows = new Map<string, (typeof observationRows)[number]>();
      for (const row of observationRows.filter(
        (observation) => observation.kind === "context_serialized",
      )) {
        const previous = latestContextRows.get(row.emittingTask);
        if (
          previous === undefined ||
          row.loopIteration > previous.loopIteration ||
          (row.loopIteration === previous.loopIteration && row.attempt > previous.attempt)
        ) {
          latestContextRows.set(row.emittingTask, row);
        }
      }
      for (const row of latestContextRows.values()) {
        const expectedRequestKind =
          row.emittingTask === "single-answer"
            ? "direct"
            : row.emittingTask.startsWith("topic-") && row.emittingTask.endsWith("-answer")
              ? "topic"
              : row.emittingTask === "fanout-synthesis"
                ? "synthesis"
                : null;
        const permittedFailure =
          (answer.code === "answer_failed" && row.emittingTask === "single-answer") ||
          (answer.code === "topic_answer_failed" && expectedRequestKind === "topic") ||
          (answer.code === "synthesis_failed" && row.emittingTask === "fanout-synthesis");
        if (expectedRequestKind === null || !permittedFailure) {
          return yield* Effect.fail(new Error("failed context serialization has a foreign owner"));
        }
        const expectedFields = new Set([
          "consumerTaskId",
          "sourceKeys",
          "restrictedContextLedger",
          "terminalUsageCoordinate",
          ...(expectedRequestKind === "topic" ? ["topicId"] : []),
        ]);
        if (Object.keys(row.payload).some((field) => !expectedFields.has(field))) {
          return yield* Effect.fail(new Error("failed context serialization has an unknown field"));
        }
        if (
          row.payload.consumerTaskId !== row.emittingTask ||
          !z.array(z.string()).safeParse(row.payload.sourceKeys).success
        ) {
          return yield* Effect.fail(new Error("failed context serialization owner is not exact"));
        }
        const ledger = RestrictedContextLedgerSchema.safeParse(row.payload.restrictedContextLedger);
        if (!ledger.success || ledger.data.requestKind !== expectedRequestKind) {
          return yield* Effect.fail(new Error("failed context serialization ledger is not exact"));
        }
        if (expectedRequestKind === "topic") {
          const topicId = row.emittingTask.slice("topic-".length, -"-answer".length);
          if (
            !["t1", "t2", "t3"].includes(topicId) ||
            row.payload.topicId !== topicId ||
            ledger.data.requestKind !== "topic" ||
            ledger.data.topicId !== topicId
          ) {
            return yield* Effect.fail(
              new Error("failed topic context serialization topic differs"),
            );
          }
        } else if (row.payload.topicId !== undefined) {
          return yield* Effect.fail(new Error("failed direct context serialization has a topic"));
        }
        const coordinate = z
          .object({
            taskId: z.string().min(1),
            loopIteration: z.number().int().nonnegative(),
            attempt: z.number().int().nonnegative(),
            providerRequestIndex: z.number().int().nonnegative(),
          })
          .strict()
          .safeParse(row.payload.terminalUsageCoordinate);
        if (!coordinate.success) {
          return yield* Effect.fail(new Error("failed context serialization lacks usage owner"));
        }
        const owner = coordinate.data;
        const usageKey = [
          owner.taskId,
          owner.loopIteration,
          owner.attempt,
          owner.providerRequestIndex,
        ].join(":");
        if (
          owner.taskId !== row.emittingTask ||
          owner.loopIteration !== row.loopIteration ||
          owner.attempt !== row.attempt ||
          latestMeasurementKeyFor(owner.taskId, owner.loopIteration, owner.attempt) !== usageKey ||
          !measurements.has(usageKey)
        ) {
          return yield* Effect.fail(
            new Error("failed context serialization lacks latest measurement"),
          );
        }
        const measurement = measurements.get(usageKey)!;
        if (
          ledger.data.modelId !== measurement.modelId ||
          ledger.data.requestSha256Hex !== measurement.requestSha256Hex ||
          ledger.data.inputTokens !== measurement.inputTokens ||
          ledger.data.usableInputTokens !== measurement.usableInputTokens ||
          ledger.data.requestedOutputTokens !== measurement.requestedOutputTokens
        ) {
          return yield* Effect.fail(new Error("failed context ledger differs from measurement"));
        }
        const measureTaskIds = contextMeasureTaskIdsFor(row.emittingTask);
        const pathMeasurementError = failedContextLedgerMeasurementError(
          row,
          usageKey,
          measureTaskIds,
          row.emittingTask,
        );
        if (pathMeasurementError !== null) {
          return yield* Effect.fail(new Error(`failed context ledger ${pathMeasurementError}`));
        }
        if (usageCoordinates.has(usageKey)) terminalUsageKeys.add(usageKey);
      }
    }
    for (const key of terminalUsageKeys) {
      if (
        !usageCoordinates.has(key) &&
        !(allowsTerminalTransportMeasurement && permittedTerminalFailureOwner(key.split(":")[0]!))
      ) {
        return yield* Effect.fail(new Error(`terminal measurement lacks matching usage: ${key}`));
      }
    }
  });

const loadRunForUpdate = (
  runId: string,
): Effect.Effect<RunRow, SqlError | Error, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<RunRow>`
      select
        id::text,
        chat_id::text as "chatId",
        initiating_user_id as "initiatingUserId",
        smithers_run_id as "smithersRunId",
        assistant_message_id::text as "assistantMessageId",
        error_code as "errorCode",
        retryable,
        finished_at as "finishedAt",
        failed_at as "failedAt",
        citation_namespace as "citationNamespace",
        acceptance_scope as "acceptanceScope"
      from ai_runs
      where id = ${runId}
      for update
    `;
    const row = rows[0];
    if (row === undefined) {
      return yield* Effect.fail(new Error(`ai run not found: ${runId}`));
    }
    return row;
  });

/**
 * Match API message acceptance's canonical order before finalization can make
 * a terminal assistant message visible: user-memory lane, chat row, company
 * membership lane, then chat execution lane. Full chat reads hold the latter
 * three through their complete projection, so they observe finalization wholly
 * before or wholly after it.
 */
const lockRunExecutionScope = (
  runId: string,
): Effect.Effect<RunExecutionScope, SqlError | Error, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const scopes = yield* sql<RunExecutionScope>`
      select run.chat_id::text as "chatId",
             chat.company_id::text as "companyId",
             run.initiating_user_id as "initiatingUserId"
      from ai_runs run
      join chats chat on chat.id = run.chat_id
      where run.id = ${runId}
    `;
    const scope = scopes[0];
    if (scope === undefined) {
      return yield* Effect.fail(new Error(`ai run not found: ${runId}`));
    }
    yield* sql`
      select pg_advisory_xact_lock(
        hashtext(${`brief:user-memory:${scope.initiatingUserId}`})
      )
    `;
    const chats = yield* sql<{ readonly id: string }>`
      select id::text
      from chats
      where id = ${scope.chatId}
      for share
    `;
    if (chats[0] === undefined) {
      return yield* Effect.fail(new Error(`chat not found: ${scope.chatId}`));
    }
    yield* sql`
      select pg_advisory_xact_lock(
        hashtext(${`brief:client-members:${scope.companyId}`})
      )
    `;
    yield* sql`
      select pg_advisory_xact_lock(
        hashtext(${`brief:ai-chat:${scope.chatId}`})
      )
    `;
    return scope;
  });

/**
 * Restriction changes and finalization share one transaction advisory lane per
 * publisher issue. The sorted acquisition order keeps a fanout answer from
 * deadlocking another transaction that touches the same set of issues.
 */
const lockPublisherIssueLanes = (
  sourceMap: readonly FinalSourceRecord[],
): Effect.Effect<void, SqlError | Error, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const issueIds = [
      ...new Set(
        sourceMap.flatMap((source) =>
          source.locator.kind === "document" && source.locator.publisherIssueId !== undefined
            ? [source.locator.publisherIssueId]
            : [],
        ),
      ),
    ].sort();
    for (const issueId of issueIds) {
      yield* sql`
        select pg_advisory_xact_lock(
          hashtextextended(${publisherIssueAdvisoryLockKey(issueId)}, 0)
        )
      `;
    }
  });

const existingTerminalResult = (row: RunRow): TerminalAiRunResult | null => {
  if (row.finishedAt !== null && row.assistantMessageId !== null) {
    return {
      status: "succeeded",
      assistantMessageId: row.assistantMessageId,
      memory: { created: 0, updated: 0, discarded: 0, writes: [] },
      usage: {
        model: {
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
          reasoningTokens: 0,
          totalTokens: 0,
          requestCount: 0,
        },
        web: { searchCount: 0, fetchCount: 0, responseBytes: 0, billedUnits: 0 },
      },
      alreadyTerminal: true,
    };
  }

  if (row.failedAt !== null && row.errorCode !== null && row.retryable !== null) {
    return {
      status: "failed",
      code: row.errorCode,
      retryable: row.retryable,
      memory: null,
      usage: null,
      alreadyTerminal: true,
    };
  }

  return null;
};

const validateTerminalProductLedger = (
  run: RunRow,
  answer: AnswerLaneResult,
  memoryArtifact: MemoryExtractionArtifact,
): Effect.Effect<void, SqlError | Error, PgClient.PgClient> =>
  Effect.gen(function* () {
    if (
      (run.finishedAt !== null && run.assistantMessageId === null) ||
      (run.failedAt !== null && (run.errorCode === null || run.retryable === null)) ||
      (run.finishedAt !== null && run.failedAt !== null)
    ) {
      return yield* Effect.fail(new Error("terminal run state is incomplete or conflicting"));
    }
    const terminal = existingTerminalResult(run);
    if (terminal === null) return;
    if (run.finishedAt !== null && answer.status !== "ok") {
      return yield* Effect.fail(new Error("terminal success replay has a failed answer"));
    }
    if (run.failedAt !== null) {
      if (
        answer.status === "failed" &&
        (answer.code !== run.errorCode || answer.retryable !== run.retryable)
      ) {
        return yield* Effect.fail(new Error("terminal failure replay differs from its run state"));
      }
      if (answer.status !== "failed") {
        return yield* Effect.fail(new Error("terminal failure replay has a different answer"));
      }
    }

    const sql = yield* PgClient.PgClient;
    const observations = yield* sql<{
      readonly kind: string;
      readonly emittingTask: string;
      readonly loopIteration: number;
      readonly attempt: number;
      readonly observationKey: string;
      readonly payload: Record<string, unknown>;
    }>`
      select kind, emitting_task as "emittingTask", loop_iteration as "loopIteration", attempt,
             observation_key as "observationKey", payload
      from ai_observations
      where run_id = ${run.id}
    `;
    const applicationRows = observations.filter((row) => row.kind === "memory_application");
    if (applicationRows.length !== 1) {
      return yield* Effect.fail(new Error("terminal ledger lacks one memory application"));
    }
    const applicationRow = applicationRows[0]!;
    const application = MemoryApplicationObservationPayloadSchema.safeParse(applicationRow.payload);
    const extractionSha256Hex = memoryExtractionSha256Hex(memoryArtifact.result);
    if (
      applicationRow.emittingTask !== "finalize" ||
      applicationRow.observationKey !==
        `finalize:${applicationRow.loopIteration}:${applicationRow.attempt}:memory_application:result` ||
      !application.success ||
      application.data.extractionTaskId !== memoryArtifact.producer.taskId ||
      application.data.extractionLoopIteration !== memoryArtifact.producer.loopIteration ||
      application.data.extractionAttempt !== memoryArtifact.producer.attempt ||
      application.data.extractionObservationKey !== memoryArtifact.producer.observationKey ||
      application.data.extractionSha256Hex !== extractionSha256Hex ||
      application.data.proposalCount !== memoryArtifact.result.proposals.length ||
      application.data.discardedCount !== memoryArtifact.result.discardedCount
    ) {
      return yield* Effect.fail(new Error("terminal memory application is not exact"));
    }
    const terminalCoordinates = {
      loopIteration: applicationRow.loopIteration,
      attempt: applicationRow.attempt,
    };

    const writtenRows = observations.filter((row) => row.kind === "memory_written");
    if (writtenRows.length !== memoryArtifact.result.proposals.length) {
      return yield* Effect.fail(new Error("terminal memory write ledger is incomplete"));
    }
    const writtenByOrdinal = new Map<
      number,
      z.infer<typeof MemoryWrittenObservationPayloadSchema>
    >();
    for (const row of writtenRows) {
      const parsed = MemoryWrittenObservationPayloadSchema.safeParse(row.payload);
      if (
        row.emittingTask !== "finalize" ||
        row.loopIteration !== terminalCoordinates.loopIteration ||
        row.attempt !== terminalCoordinates.attempt ||
        !parsed.success ||
        row.observationKey !==
          `memory_written:${parsed.success ? parsed.data.ordinal : "invalid"}` ||
        writtenByOrdinal.has(parsed.success ? parsed.data.ordinal : -1)
      ) {
        return yield* Effect.fail(new Error("terminal memory write ledger is not exact"));
      }
      writtenByOrdinal.set(parsed.data.ordinal, parsed.data);
    }
    for (const [ordinal, proposal] of memoryArtifact.result.proposals.entries()) {
      const write = writtenByOrdinal.get(ordinal);
      if (
        write === undefined ||
        (proposal.targetMemoryId === undefined && write.action !== "create") ||
        (proposal.targetMemoryId !== undefined &&
          (write.action !== "update" ||
            write.memoryId !== proposal.targetMemoryId ||
            write.previousRevisionId !== proposal.expectedHeadRevisionId))
      ) {
        return yield* Effect.fail(new Error("terminal memory write does not match its proposal"));
      }
    }
    const revisionRows = yield* sql<{
      readonly revisionId: string;
      readonly memoryId: string;
      readonly action: string;
      readonly userId: string;
      readonly stateBefore: unknown;
      readonly stateAfter: unknown;
      readonly runId: string | null;
    }>`
      select revisions.id::text as "revisionId", revisions.memory_id::text as "memoryId",
             revisions.action, memories.user_id as "userId",
             revisions.state_before as "stateBefore", revisions.state_after as "stateAfter",
             revisions.run_id::text as "runId"
      from user_memory_revisions revisions
      join user_memories memories on memories.id = revisions.memory_id
      where memories.user_id = ${run.initiatingUserId}
      order by revisions.id
    `;
    const runRevisionRows = revisionRows.filter((row) => row.runId === run.id);
    if (runRevisionRows.length !== writtenRows.length) {
      return yield* Effect.fail(new Error("terminal memory revisions do not match writes"));
    }
    const revisionById = new Map(revisionRows.map((row) => [row.revisionId, row]));
    const referencedRevisionIds = new Set<string>();
    for (const write of writtenByOrdinal.values()) {
      const revision = revisionById.get(write.revisionId);
      if (
        revision === undefined ||
        revision.runId !== run.id ||
        referencedRevisionIds.has(write.revisionId) ||
        revision.memoryId !== write.memoryId ||
        revision.action !== write.action ||
        revision.userId !== run.initiatingUserId
      ) {
        return yield* Effect.fail(new Error("terminal memory write lacks its exact revision"));
      }
      referencedRevisionIds.add(write.revisionId);
      const proposal = memoryArtifact.result.proposals[write.ordinal]!;
      const expectedAfter = {
        kind: proposal.kind,
        content: proposal.content.trim(),
        deleted: false,
      };
      if (canonicalJson(revision.stateAfter) !== canonicalJson(expectedAfter)) {
        return yield* Effect.fail(
          new Error("terminal memory revision state differs from its proposal"),
        );
      }
      if (write.action === "create") {
        if (revision.stateBefore !== null || write.previousRevisionId !== null) {
          return yield* Effect.fail(new Error("terminal memory create revision has prior state"));
        }
      } else {
        const previous = revisionById.get(write.previousRevisionId ?? "");
        if (
          previous === undefined ||
          canonicalJson(revision.stateBefore) !== canonicalJson(previous.stateAfter)
        ) {
          return yield* Effect.fail(
            new Error("terminal memory update revision lacks its prior state"),
          );
        }
      }
    }
    if (
      referencedRevisionIds.size !== runRevisionRows.length ||
      runRevisionRows.some((row) => !referencedRevisionIds.has(row.revisionId))
    ) {
      return yield* Effect.fail(new Error("terminal memory revisions do not match writes"));
    }

    const events = yield* sql<{
      readonly emissionKey: string;
      readonly emittedByTask: string | null;
      readonly event: Record<string, unknown>;
    }>`
      select emission_key as "emissionKey", emitted_by_task as "emittedByTask", event
      from ai_run_events
      where run_id = ${run.id}
        and emission_key in ('memory_updated', 'usage:run', 'terminal')
    `;
    const eventFor = (emissionKey: string) =>
      events.filter((event) => event.emissionKey === emissionKey);
    const memoryUpdatedRows = eventFor("memory_updated");
    const usageRows = eventFor("usage:run");
    const terminalRows = eventFor("terminal");
    const expectedMemoryUpdatedEvent = {
      type: "memory_updated",
      created: memoryArtifact.result.proposals.filter(
        (proposal) => proposal.targetMemoryId === undefined,
      ).length,
      updated: memoryArtifact.result.proposals.filter(
        (proposal) => proposal.targetMemoryId !== undefined,
      ).length,
      discarded: memoryArtifact.result.discardedCount,
    };
    const expectedUsageEvent = {
      type: "usage",
      scope: "run",
      ...(yield* deriveAggregateAiRunUsage(run.id)),
    };
    if (
      memoryUpdatedRows.length !== 1 ||
      usageRows.length !== 1 ||
      terminalRows.length !== 1 ||
      memoryUpdatedRows[0]!.emittedByTask !== "finalize" ||
      usageRows[0]!.emittedByTask !== "finalize" ||
      canonicalJson(memoryUpdatedRows[0]!.event) !== canonicalJson(expectedMemoryUpdatedEvent) ||
      canonicalJson(usageRows[0]!.event) !== canonicalJson(expectedUsageEvent)
    ) {
      return yield* Effect.fail(new Error("terminal event ledger is incomplete or inconsistent"));
    }
    const terminalEvent = terminalRows[0]!;
    if (terminalEvent.emittedByTask !== "finalize") {
      return yield* Effect.fail(new Error("terminal event has a foreign owner"));
    }
    if (run.finishedAt !== null) {
      if (answer.status !== "ok") {
        return yield* Effect.fail(new Error("terminal success replay has a failed answer"));
      }
      if (
        canonicalJson(terminalEvent.event) !==
        canonicalJson({ type: "done", assistantMessageId: run.assistantMessageId })
      ) {
        return yield* Effect.fail(new Error("terminal success event is not exact"));
      }
      assertFinalSourceMap(answer, run.citationNamespace);
      const assistantRows = yield* sql<{
        readonly id: string;
        readonly author: string;
        readonly content: string;
        readonly runId: string | null;
        readonly chatId: string;
      }>`
        select id::text, chat_id::text as "chatId", author, content,
               assistant_ai_run_id::text as "runId"
        from chat_messages
        where assistant_ai_run_id = ${run.id}
      `;
      if (
        assistantRows.length !== 1 ||
        assistantRows[0]!.id !== run.assistantMessageId ||
        assistantRows[0]!.author !== "assistant" ||
        assistantRows[0]!.chatId !== run.chatId ||
        assistantRows[0]!.runId !== run.id ||
        assistantRows[0]!.content !== answer.content
      ) {
        return yield* Effect.fail(new Error("terminal assistant message is not exact"));
      }
      const assistantMessageId = assistantRows[0]!.id;
      const sourceRows = yield* sql<{
        readonly sourceKey: string;
        readonly kind: string;
        readonly locator: unknown;
        readonly label: string | null;
        readonly publicProvenance: unknown;
        readonly versionId: string | null;
        readonly publisherExtractionId: string | null;
        readonly documentSourceId: string | null;
        readonly documentId: string | null;
        readonly contentHash: string | null;
        readonly messageId: string | null;
        readonly memoryRevisionId: string | null;
      }>`
        select source_key as "sourceKey", kind, locator, display_label as label,
               public_provenance as "publicProvenance", version_id::text as "versionId",
               publisher_extraction_id::text as "publisherExtractionId",
               document_source_id as "documentSourceId", document_id as "documentId",
               content_hash as "contentHash", message_id::text as "messageId",
               memory_revision_id::text as "memoryRevisionId"
        from assistant_message_sources
        where assistant_message_id = ${assistantMessageId}
      `;
      if (sourceRows.length !== answer.sourceMap.length) {
        return yield* Effect.fail(new Error("terminal source ledger is incomplete"));
      }
      const expectedSources = new Map(answer.sourceMap.map((source) => [source.sourceKey, source]));
      for (const row of sourceRows) {
        const expected = expectedSources.get(row.sourceKey);
        const expectedIndexedIdentity =
          expected?.locator.kind === "document"
            ? {
                versionId: expected.locator.versionId,
                publisherExtractionId: expected.locator.publisherExtractionId ?? null,
                documentSourceId: expected.locator.sourceId,
                documentId: expected.locator.documentId,
                contentHash: expected.locator.contentHash,
                messageId: null,
                memoryRevisionId: null,
              }
            : expected?.locator.kind === "chat_message"
              ? {
                  versionId: null,
                  publisherExtractionId: null,
                  documentSourceId: null,
                  documentId: null,
                  contentHash: null,
                  messageId: expected.locator.messageId,
                  memoryRevisionId: null,
                }
              : expected?.locator.kind === "memory"
                ? {
                    versionId: null,
                    publisherExtractionId: null,
                    documentSourceId: null,
                    documentId: null,
                    contentHash: null,
                    messageId: null,
                    memoryRevisionId: expected.locator.memoryRevisionId,
                  }
                : {
                    versionId: null,
                    publisherExtractionId: null,
                    documentSourceId: null,
                    documentId: null,
                    contentHash: null,
                    messageId: null,
                    memoryRevisionId: null,
                  };
        if (
          expected === undefined ||
          expectedIndexedIdentity === undefined ||
          row.kind !== expected.locator.kind ||
          canonicalJson(row.locator) !== canonicalJson(expected.locator) ||
          row.label !== expected.label ||
          canonicalJson(row.publicProvenance) !== canonicalJson(expected.publicProvenance) ||
          row.versionId !== expectedIndexedIdentity.versionId ||
          row.publisherExtractionId !== expectedIndexedIdentity.publisherExtractionId ||
          row.documentSourceId !== expectedIndexedIdentity.documentSourceId ||
          row.documentId !== expectedIndexedIdentity.documentId ||
          row.contentHash !== expectedIndexedIdentity.contentHash ||
          row.messageId !== expectedIndexedIdentity.messageId ||
          row.memoryRevisionId !== expectedIndexedIdentity.memoryRevisionId
        ) {
          return yield* Effect.fail(new Error("terminal source ledger differs from the answer"));
        }
      }
      const useRows = yield* sql<{
        readonly sourceKey: string;
        readonly consumerTaskId: string;
        readonly topicId: string | null;
        readonly renderedTokenCount: number;
        readonly contextOrder: number;
        readonly ranges: unknown;
      }>`
        select source_key as "sourceKey", consumer_task_id as "consumerTaskId",
               topic_id as "topicId", rendered_token_count as "renderedTokenCount",
               context_order as "contextOrder", ranges
        from assistant_message_source_uses
        where assistant_message_id = ${assistantMessageId}
      `;
      const expectedUses = answer.sourceMap.flatMap((source) =>
        source.uses.map((use) => ({
          sourceKey: source.sourceKey,
          consumerTaskId: use.consumerTaskId,
          topicId: use.topicId ?? null,
          renderedTokenCount: use.renderedTokenCount,
          contextOrder: use.contextOrder,
          ranges: use.ranges,
        })),
      );
      if (useRows.length !== expectedUses.length) {
        return yield* Effect.fail(new Error("terminal source-use ledger is incomplete"));
      }
      const useKey = (use: {
        readonly sourceKey: string;
        readonly consumerTaskId: string;
        readonly topicId: string | null;
        readonly renderedTokenCount: number;
        readonly contextOrder: number;
        readonly ranges: unknown;
      }) =>
        `${use.sourceKey}:${use.consumerTaskId}:${use.topicId ?? ""}:${use.contextOrder}:${use.renderedTokenCount}:${canonicalJson(use.ranges)}`;
      const expectedUseKeys = new Set(expectedUses.map(useKey));
      if (
        new Set(useRows.map(useKey)).size !== useRows.length ||
        useRows.some((row) => !expectedUseKeys.has(useKey(row)))
      ) {
        return yield* Effect.fail(new Error("terminal source-use ledger differs from the answer"));
      }
      const parsedCitations = parseCurrentTurnCitations(
        answer.content,
        new Set(answer.sourceMap.map((source) => source.sourceKey)),
      );
      const citationRows = observations.filter((row) => row.kind === "citation");
      const defectRows = observations.filter((row) => row.kind === "citation_defect");
      if (
        citationRows.length !== parsedCitations.citations.length ||
        defectRows.length !== parsedCitations.defects.length
      ) {
        return yield* Effect.fail(new Error("terminal citation ledger is incomplete"));
      }
      const citationKeys = new Set<string>();
      for (const row of citationRows) {
        const payload = z
          .object({ assistantMessageId: z.string().uuid(), sourceKey: z.string().trim().min(1) })
          .strict()
          .safeParse(row.payload);
        if (
          row.emittingTask !== "finalize" ||
          row.loopIteration !== terminalCoordinates.loopIteration ||
          row.attempt !== terminalCoordinates.attempt ||
          !payload.success ||
          payload.data.assistantMessageId !== assistantMessageId ||
          citationKeys.has(row.observationKey) ||
          !parsedCitations.citations.some(
            (citation) =>
              `citation:${citation.tagIndex}:${citation.keyIndex}` === row.observationKey &&
              citation.sourceKey === payload.data.sourceKey,
          )
        ) {
          return yield* Effect.fail(new Error("terminal citation ledger is not exact"));
        }
        citationKeys.add(row.observationKey);
      }
      const defectKeys = new Set<string>();
      for (const row of defectRows) {
        const payload = z
          .object({
            token: z.string().min(1).max(256),
            reason: z.enum(["malformed", "unknown_source_key"]),
          })
          .strict()
          .safeParse(row.payload);
        if (
          row.emittingTask !== "finalize" ||
          row.loopIteration !== terminalCoordinates.loopIteration ||
          row.attempt !== terminalCoordinates.attempt ||
          !payload.success ||
          defectKeys.has(row.observationKey) ||
          !parsedCitations.defects.some(
            (defect) =>
              `citation_defect:${defect.tagIndex}:${defect.defectSlot}` === row.observationKey &&
              defect.token === payload.data.token &&
              defect.reason === payload.data.reason,
          )
        ) {
          return yield* Effect.fail(new Error("terminal citation-defect ledger is not exact"));
        }
        defectKeys.add(row.observationKey);
      }
    } else {
      if (
        canonicalJson(terminalEvent.event) !==
        canonicalJson({
          type: "error",
          code: run.errorCode,
          retryable: run.retryable,
        })
      ) {
        return yield* Effect.fail(new Error("terminal failure event is not exact"));
      }
      const assistantRows = yield* sql<{ readonly id: string }>`
        select id::text from chat_messages where assistant_ai_run_id = ${run.id}
      `;
      const sourceRows = yield* sql<{ readonly sourceKey: string }>`
        select source_key as "sourceKey"
        from assistant_message_sources sources
        join chat_messages messages on messages.id = sources.assistant_message_id
        where messages.assistant_ai_run_id = ${run.id}
      `;
      const citationRows = observations.filter(
        (row) => row.kind === "citation" || row.kind === "citation_defect",
      );
      if (
        run.assistantMessageId !== null ||
        assistantRows.length !== 0 ||
        sourceRows.length !== 0 ||
        citationRows.length !== 0
      ) {
        return yield* Effect.fail(new Error("failed terminal ledger carries success rows"));
      }
    }
  });

const sourceIdentity = (source: FinalSourceRecord): string => {
  const locator = source.locator;
  switch (locator.kind) {
    case "document":
      return `document:${locator.sourceId}:${
        locator.publisherIssueId === undefined
          ? "public"
          : `publisher:${locator.publisherIssueId}:${locator.publisherDocumentId ?? ""}`
      }:${locator.versionId}:${locator.contentHash}:${locator.publisherExtractionId ?? ""}`;
    case "chat_message":
      return `chat_message:${locator.messageId}`;
    case "memory":
      return `memory:${locator.memoryId}:${locator.memoryRevisionId}`;
    case "web":
      return `web:${locator.url}:${locator.quoteHash}`;
  }
};

const candidateIdentity = (source: FinalSourceRecord): string => {
  const locator = source.locator;
  switch (locator.kind) {
    case "document":
      return namespacedDocumentEvidenceIdentity(
        locator.publisherIssueId === undefined
          ? { kind: "public", sourceId: locator.sourceId }
          : {
              kind: "publisher",
              sourceId: locator.sourceId,
              issueId: locator.publisherIssueId,
              documentId: locator.publisherDocumentId!,
            },
        locator.documentId,
      );
    case "chat_message":
      return chatMessageEvidenceIdentity(locator.messageId);
    case "memory":
      return memoryEvidenceIdentity(locator.memoryId);
    case "web":
      return webEvidenceIdentity(locator.url, locator.quote);
  }
  throw new Error("unknown source kind");
};

const rangesEqual = (
  left: readonly { readonly charStart: number; readonly charEnd: number }[],
  right: readonly { readonly charStart: number; readonly charEnd: number }[],
): boolean => canonicalJson(left) === canonicalJson(right);

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

export const assertFinalSourceMap = (
  answer: Extract<AnswerLaneResult, { readonly status: "ok" }>,
  citationNamespace: string,
): void => {
  for (const source of answer.sourceMap) {
    // Reparse the durable public projection at the finalization boundary so
    // unknown/nested/wrongly typed provenance cannot survive into storage.
    PublicProvenanceSchema.parse(source.publicProvenance);
  }
  const sourceMap = answer.sourceMap;
  if (answer.mode === "clarification" && sourceMap.length !== 0) {
    throw new Error("clarification result must have an empty source map");
  }
  if (!/^cn_[A-Za-z0-9_-]{22}$/u.test(citationNamespace)) {
    throw new Error("invalid citation namespace");
  }
  const keyPattern = new RegExp(`^k_${citationNamespace}_[1-9][0-9]*$`, "u");
  const keys = new Set<string>();
  const identities = new Set<string>();
  const consumerOrders = new Map<string, Set<number>>();
  for (const source of sourceMap) {
    if (!keyPattern.test(source.sourceKey)) {
      throw new Error(`source key is outside the current citation namespace: ${source.sourceKey}`);
    }
    if (keys.has(source.sourceKey)) {
      throw new Error(`duplicate final source key: ${source.sourceKey}`);
    }
    keys.add(source.sourceKey);
    const identity = sourceIdentity(source);
    if (identities.has(identity)) throw new Error(`duplicate final source identity: ${identity}`);
    identities.add(identity);
    if (source.uses.length === 0)
      throw new Error(`source has no answer consumer: ${source.sourceKey}`);

    if (source.locator.kind === "document") {
      const ranges = normalizeCharacterRanges(
        source.locator.ranges,
        Math.max(0, ...source.locator.ranges.map((range) => range.charEnd)),
      );
      if (ranges.length === 0 || !rangesEqual(ranges, source.locator.ranges)) {
        throw new Error(`document locator ranges are not a normalized non-empty union`);
      }
      if (
        !(
          isCanonicalPublicDocumentSourceId(source.locator.sourceId) ||
          isCanonicalPublisherDocumentSourceId(source.locator.sourceId)
        ) ||
        source.locator.documentId.trim() === "" ||
        source.locator.versionId.trim() === "" ||
        !/^[a-f0-9]{64}$/u.test(source.locator.contentHash)
      ) {
        throw new Error("document locator identity is incomplete");
      }
      if (
        typeof source.publicProvenance.documentTitle !== "string" ||
        source.publicProvenance.documentTitle.trim() === "" ||
        typeof source.publicProvenance.citationUrl !== "string" ||
        source.publicProvenance.citationUrl.trim() === "" ||
        ((source.locator.publisherIssueId === undefined ||
          source.locator.publisherDocumentId === undefined) &&
          canonicalPublicSourceHttpsUrl(source.publicProvenance.citationUrl) !==
            source.publicProvenance.citationUrl)
      ) {
        throw new Error("document public provenance is incomplete");
      }
      const publisherIssueId = source.locator.publisherIssueId;
      const publisherDocumentId = source.locator.publisherDocumentId;
      if ((publisherIssueId === undefined) !== (publisherDocumentId === undefined)) {
        throw new Error("publisher document identity is incomplete");
      }
      if (publisherIssueId !== undefined && publisherDocumentId !== undefined) {
        if (
          !isCanonicalPublisherDocumentSourceId(source.locator.sourceId) ||
          publisherIssueId.trim() === "" ||
          publisherDocumentId.trim() === "" ||
          publisherDocumentId !== source.locator.documentId ||
          typeof source.locator.publisherExtractionId !== "string" ||
          source.locator.publisherExtractionId.trim() === "" ||
          source.publicProvenance.sourceName?.trim() === "" ||
          source.publicProvenance.issueTitle?.trim() === "" ||
          typeof source.publicProvenance.sourceName !== "string" ||
          typeof source.publicProvenance.issueTitle !== "string" ||
          typeof source.publicProvenance.publishedAt !== "string" ||
          !Number.isFinite(Date.parse(source.publicProvenance.publishedAt)) ||
          source.publicProvenance.citationUrl !==
            `/v1/issues/${publisherIssueId}/documents/${publisherDocumentId}/content`
        ) {
          throw new Error("publisher document provenance is incomplete");
        }
      } else if (!isCanonicalPublicDocumentSourceId(source.locator.sourceId)) {
        throw new Error("public document source identity is incomplete");
      } else if (source.locator.publisherExtractionId !== undefined) {
        throw new Error("public document cannot carry publisher extraction identity");
      }
    } else if (source.locator.kind === "web") {
      if (
        canonicalizeWebUrl(source.locator.url) !== source.locator.url ||
        normalizeWebQuote(source.locator.quote) !== source.locator.quote ||
        webQuoteHash(source.locator.quote) !== source.locator.quoteHash ||
        source.locator.title.trim() === "" ||
        source.locator.domain.trim() === "" ||
        new URL(source.locator.url).hostname !== source.locator.domain ||
        !Number.isFinite(Date.parse(source.locator.capturedAt))
      ) {
        throw new Error("web locator provenance is not canonical");
      }
      if (source.publicProvenance.citationUrl !== source.locator.url) {
        throw new Error("web public provenance URL differs from its immutable locator");
      }
    } else if (source.locator.kind === "chat_message") {
      if (source.locator.messageId.trim() === "") {
        throw new Error("chat-message locator identity is incomplete");
      }
    } else if (
      source.locator.memoryId.trim() === "" ||
      source.locator.memoryRevisionId.trim() === ""
    ) {
      throw new Error("memory locator identity is incomplete");
    }
    const consumers = new Set<string>();
    for (const use of source.uses) {
      if (consumers.has(use.consumerTaskId)) {
        throw new Error(`duplicate source consumer: ${source.sourceKey}/${use.consumerTaskId}`);
      }
      consumers.add(use.consumerTaskId);
      if (!Number.isSafeInteger(use.contextOrder) || use.contextOrder < 0) {
        throw new Error(`invalid source context order: ${source.sourceKey}`);
      }
      if (!Number.isSafeInteger(use.renderedTokenCount) || use.renderedTokenCount < 0) {
        throw new Error(`invalid rendered token count: ${source.sourceKey}`);
      }
      const orders = consumerOrders.get(use.consumerTaskId) ?? new Set<number>();
      if (orders.has(use.contextOrder)) {
        throw new Error(`duplicate context order for consumer ${use.consumerTaskId}`);
      }
      orders.add(use.contextOrder);
      consumerOrders.set(use.consumerTaskId, orders);
      if (source.locator.kind !== "document" && use.ranges.length !== 0) {
        throw new Error(`non-document source has ranges: ${source.sourceKey}`);
      }
      if (source.locator.kind === "document") {
        const locator = source.locator;
        const normalizedUse = normalizeCharacterRanges(
          use.ranges,
          Math.max(0, ...locator.ranges.map((range) => range.charEnd)),
        );
        if (normalizedUse.length === 0 || !rangesEqual(normalizedUse, use.ranges)) {
          throw new Error(`document use ranges are not normalized: ${source.sourceKey}`);
        }
        if (
          use.ranges.some(
            (range) =>
              !locator.ranges.some(
                (locatorRange) =>
                  range.charStart >= locatorRange.charStart &&
                  range.charEnd <= locatorRange.charEnd,
              ),
          )
        ) {
          throw new Error(`document use range exceeds locator union: ${source.sourceKey}`);
        }
      }
      if (answer.mode === "single") {
        if (use.consumerTaskId !== "single-answer" || use.topicId !== undefined) {
          throw new Error(`single answer has a non-single source consumer`);
        }
      } else if (answer.mode === "synthesis") {
        if (use.topicId === undefined || use.consumerTaskId !== `topic-${use.topicId}-answer`) {
          throw new Error(`fanout source consumer does not own its topic`);
        }
      }
    }

    // A document locator is the exact union of every serialized consumer
    // slice.  Checking only that each slice is contained by one locator range
    // would accept stale/orphan locator ranges that no answer consumer saw,
    // which makes a replayed source map differ from the prompt ledger.
    if (source.locator.kind === "document") {
      const textCharCount = Math.max(0, ...source.locator.ranges.map((range) => range.charEnd));
      const consumerRangeUnion = normalizeCharacterRanges(
        source.uses.flatMap((use) => use.ranges),
        textCharCount,
      );
      if (!rangesEqual(consumerRangeUnion, source.locator.ranges)) {
        throw new Error(`document use ranges do not equal locator union: ${source.sourceKey}`);
      }
    }
  }

  // Each consumer's source ledger is a zero-based contiguous sequence.  A
  // uniqueness check alone admits gaps (for example [0, 2]), which cannot
  // reproduce the exact terminal context order on chat replay.
  for (const [consumerTaskId, orders] of consumerOrders) {
    const ordered = [...orders].sort((left, right) => left - right);
    for (let index = 0; index < ordered.length; index += 1) {
      if (ordered[index] !== index) {
        throw new Error(`non-contiguous context order for consumer ${consumerTaskId}`);
      }
    }
  }
};

const persistAssistantSources = (
  assistantMessageId: string,
  sourceMap: readonly FinalSourceRecord[],
  acceptanceScope: RunAcceptanceScope,
): Effect.Effect<void, SqlError | Error, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    for (const source of sourceMap) {
      const versionId = source.locator.kind === "document" ? source.locator.versionId : null;
      const messageId = source.locator.kind === "chat_message" ? source.locator.messageId : null;
      const memoryRevisionId =
        source.locator.kind === "memory" ? source.locator.memoryRevisionId : null;
      let publisherExtractionId: string | null = null;
      if (source.locator.kind === "document") {
        const publisherIssueId = source.locator.publisherIssueId;
        const publisherDocumentId = source.locator.publisherDocumentId;
        if ((publisherIssueId === undefined) !== (publisherDocumentId === undefined)) {
          return yield* Effect.fail(new Error("publisher document identity is incomplete"));
        }
        if (publisherIssueId !== undefined && publisherDocumentId !== undefined) {
          const deliveredRows = yield* sql<{ readonly accessId: string }>`
            select deliveries.access_id::text as "accessId"
            from issue_deliveries deliveries
            join issue_delivery_recipients recipients
              on recipients.issue_id = deliveries.issue_id
             and recipients.client_company_id = deliveries.client_company_id
             and recipients.user_id = ${acceptanceScope.userId}
             and recipients.delivered_at = deliveries.delivered_at
            join publisher_issues issues
              on issues.id = deliveries.issue_id
             and issues.id::text = ${publisherIssueId}
             and issues.subscription_id::text = ${source.locator.sourceId.slice("publisher:".length)}
             and issues.restricted_at is null
             and issues.deleted_at is null
            join brief_documents documents
              on documents.issue_id = issues.id
             and documents.id::text = ${publisherDocumentId}
             and documents.deleted_at is null
            join brief_document_versions versions
              on versions.brief_document_id = documents.id
             and versions.id::text = ${source.locator.versionId}
             and versions.content_hash = ${source.locator.contentHash}
             and versions.publisher_extraction_id::text = ${source.locator.publisherExtractionId ?? ""}
            where deliveries.client_company_id = ${acceptanceScope.companyId}
              and deliveries.access_id::text = any(${acceptanceScope.accessIds}::text[])
              and deliveries.subscription_id::text = any(${acceptanceScope.subscriptionIds}::text[])
            limit 1
          `;
          if (deliveredRows[0] === undefined) {
            return yield* Effect.fail(
              new Error("publisher document lacks its accepted historical recipient"),
            );
          }
          const publisherExtractions = yield* sql<{ readonly id: string }>`
            select versions.publisher_extraction_id::text as id
            from brief_document_extractions extractions
            join brief_documents documents
              on documents.id = extractions.brief_document_id
             and documents.id::text = ${publisherDocumentId}
             and documents.deleted_at is null
            join brief_document_versions versions
              on versions.brief_document_id = documents.id
             and versions.id::text = ${source.locator.versionId}
             and versions.content_hash = ${source.locator.contentHash}
             and versions.publisher_extraction_id = extractions.id
            join publisher_issues issues
              on issues.id = documents.issue_id
             and issues.restricted_at is null
             and issues.deleted_at is null
            join publisher_subscriptions subscriptions on subscriptions.id = issues.subscription_id
            where issues.id::text = ${publisherIssueId}
              and ('publisher:' || subscriptions.id::text) = ${source.locator.sourceId}
              and extractions.input_sha256_hex = documents.sha256_hex
              and extractions.id::text = ${source.locator.publisherExtractionId ?? ""}
            limit 1
          `;
          publisherExtractionId = publisherExtractions[0]?.id ?? null;
          if (publisherExtractionId === null) {
            return yield* Effect.fail(
              new Error("publisher document identity does not match database ownership"),
            );
          }
        } else {
          const publicVersions = yield* sql<{ readonly id: string }>`
            select document_id as id
            from public_source_documents
            where source_id = ${source.locator.sourceId.slice("public:".length)}
              and document_id = ${source.locator.versionId}
              and document_id = ${source.locator.documentId}
              and content_hash = ${source.locator.contentHash}
              and canonical_url = ${source.publicProvenance.citationUrl ?? ""}
            limit 1
          `;
          if (publicVersions[0] === undefined) {
            return yield* Effect.fail(
              new Error(`public document version not found: ${source.locator.versionId}`),
            );
          }
        }
      }
      yield* sql`
        insert into assistant_message_sources (
          assistant_message_id,
          source_key,
          kind,
          locator,
          version_id,
          publisher_extraction_id,
          document_source_id,
          document_id,
          content_hash,
          message_id,
          memory_revision_id,
          display_label,
          public_provenance
        )
        values (
          ${assistantMessageId},
          ${source.sourceKey},
          ${source.locator.kind},
          ${sql.json(source.locator)},
          ${versionId},
          ${publisherExtractionId},
          ${source.locator.kind === "document" ? source.locator.sourceId : null},
          ${source.locator.kind === "document" ? source.locator.documentId : null},
          ${source.locator.kind === "document" ? source.locator.contentHash : null},
          ${messageId},
          ${memoryRevisionId},
          ${source.label},
          ${sql.json(source.publicProvenance)}
        )
      `;

      for (const use of source.uses) {
        yield* sql`
          insert into assistant_message_source_uses (
            assistant_message_id,
            source_key,
            consumer_task_id,
            topic_id,
            rendered_token_count,
            context_order,
            ranges
          )
          values (
            ${assistantMessageId},
            ${source.sourceKey},
            ${use.consumerTaskId},
            ${use.topicId ?? null},
            ${use.renderedTokenCount},
            ${use.contextOrder},
          ${JSON.stringify(use.ranges)}::jsonb
          )
        `;
      }
    }
  });

const persistCitationObservations = (
  run: RunRow,
  assistantMessageId: string,
  content: string,
  sourceMap: readonly FinalSourceRecord[],
  coordinates: FinalizeAiRunInput["coordinates"],
): Effect.Effect<void, SqlError | Error, PgClient.PgClient> =>
  Effect.gen(function* () {
    const parsed = parseCurrentTurnCitations(
      content,
      new Set(sourceMap.map((source) => source.sourceKey)),
    );

    for (const citation of parsed.citations) {
      yield* insertAiObservation({
        runId: run.id,
        chatId: run.chatId,
        emittingTask: "finalize",
        loopIteration: coordinates.loopIteration,
        attempt: coordinates.attempt,
        observationKey: `citation:${citation.tagIndex}:${citation.keyIndex}`,
        kind: "citation",
        payload: { assistantMessageId, sourceKey: citation.sourceKey },
      });
    }
    for (const defect of parsed.defects) {
      yield* insertAiObservation({
        runId: run.id,
        chatId: run.chatId,
        emittingTask: "finalize",
        loopIteration: coordinates.loopIteration,
        attempt: coordinates.attempt,
        observationKey: `citation_defect:${defect.tagIndex}:${defect.defectSlot}`,
        kind: "citation_defect",
        payload: { token: defect.token, reason: defect.reason },
      });
    }
  });

const transitionToFailure = (
  runId: string,
  code: AiRunErrorCode,
  emittedByTask: string,
  retryable: boolean = isRetryableAiRunError(code),
): Effect.Effect<
  { readonly code: AiRunErrorCode; readonly retryable: boolean },
  SqlError | Error,
  PgClient.PgClient
> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    yield* sql`
      update ai_runs
      set failed_at = now(),
          error_code = ${code},
          retryable = ${retryable}
      where id = ${runId}
        and finished_at is null
        and failed_at is null
    `;
    yield* appendAiRunEventInTransaction({
      runId,
      emissionKey: "terminal",
      event: { type: "error", code, retryable },
      emittedByTask,
    });
    return { code, retryable };
  });

export const finalizeAiRun = (
  input: FinalizeAiRunInput,
): Effect.Effect<TerminalAiRunResult, SqlError | Error | MemoryConflictError, PgClient.PgClient> =>
  Effect.gen(function* () {
    const memoryArtifact = MemoryExtractionArtifactSchema.parse(input.memory);
    if (
      !Number.isSafeInteger(input.coordinates.loopIteration) ||
      input.coordinates.loopIteration < 0 ||
      !Number.isSafeInteger(input.coordinates.attempt) ||
      input.coordinates.attempt < 1
    ) {
      return yield* Effect.fail(new Error("finalization requires exact Smithers coordinates"));
    }
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const executionScope = yield* lockRunExecutionScope(input.runId);
        const run = yield* loadRunForUpdate(input.runId);
        const acceptanceScope = parseRunAcceptanceScope(run.acceptanceScope);
        if (
          run.chatId !== executionScope.chatId ||
          run.initiatingUserId !== executionScope.initiatingUserId ||
          acceptanceScope.userId !== run.initiatingUserId ||
          acceptanceScope.chatId !== run.chatId ||
          acceptanceScope.companyId !== executionScope.companyId
        ) {
          return yield* Effect.fail(new Error("ai run execution scope changed"));
        }
        const tenantAvailable = yield* sql<{ readonly available: boolean }>`
          select exists(
            select 1
            from ai_runs runs
            join chats chat on chat.id = runs.chat_id
            join client_companies company on company.id = chat.company_id
            join platform_users users on users.id = runs.initiating_user_id
            where runs.id = ${run.id}
              and runs.chat_id = ${run.chatId}
              and runs.initiating_user_id = ${run.initiatingUserId}
              and chat.deleted_at is null
              and company.id = ${acceptanceScope.companyId}::uuid
              and company.recovery_deleted_at is null
              and company.purged_at is null
              and users.recovery_deleted_at is null
              and users.purged_at is null
          ) as available
        `;
        if (tenantAvailable[0]?.available !== true) {
          return yield* Effect.fail(new Error("ai run execution scope is no longer available"));
        }
        if (run.smithersRunId !== input.expectedSmithersRunId) {
          return yield* Effect.fail(
            new AiRunSmithersRunIdMismatch(
              input.runId,
              run.smithersRunId,
              input.expectedSmithersRunId,
            ),
          );
        }
        // Acquire every publisher restriction lane before immutable source
        // writes. The lane remains held until this transaction commits, so a
        // restriction either linearizes before finalization (and fails the
        // source-integrity check) or after the complete terminal answer write.
        if (input.answer.status === "ok") {
          yield* lockPublisherIssueLanes(input.answer.sourceMap);
        }

        // A terminal run is replayable only while its complete product ledger
        // still matches the answer and consumed memory artifact.  Validate
        // those terminal rows before the replay branch and before any other
        // finalization work can treat the row as idempotent.
        yield* validateTerminalProductLedger(run, input.answer, memoryArtifact);
        yield* validateDurableObservability(run, input.answer, input.coordinates);

        const extractionSha256Hex = memoryExtractionSha256Hex(memoryArtifact.result);
        if (extractionSha256Hex !== memoryArtifact.producer.extractionSha256Hex) {
          return yield* Effect.fail(new Error("memory extraction artifact digest differs"));
        }
        const extractionRows = yield* sql<{
          readonly payload: unknown;
          readonly loopIteration: number;
          readonly attempt: number;
          readonly observationKey: string;
        }>`
          select payload,
                 loop_iteration as "loopIteration",
                 attempt,
                 observation_key as "observationKey"
          from ai_observations
          where run_id = ${run.id}
            and chat_id = ${run.chatId}
            and emitting_task = ${memoryArtifact.producer.taskId}
            and loop_iteration = ${memoryArtifact.producer.loopIteration}
            and attempt = ${memoryArtifact.producer.attempt}
            and observation_key = ${memoryArtifact.producer.observationKey}
            and kind = 'memory_extraction_result'
        `;
        if (extractionRows.length !== 1) {
          return yield* Effect.fail(new Error("memory extraction artifact has no exact producer"));
        }
        const latestExtraction = yield* sql<{
          readonly loopIteration: number;
          readonly attempt: number;
          readonly observationKey: string;
        }>`
          select loop_iteration as "loopIteration",
                 attempt,
                 observation_key as "observationKey"
          from ai_observations
          where run_id = ${run.id}
            and chat_id = ${run.chatId}
            and emitting_task = ${memoryArtifact.producer.taskId}
            and kind = 'memory_extraction_result'
          order by loop_iteration desc, attempt desc
          limit 1
        `;
        const producerExtraction = extractionRows[0]!;
        const latestExtractionRow = latestExtraction[0];
        if (
          latestExtractionRow === undefined ||
          latestExtractionRow.loopIteration !== memoryArtifact.producer.loopIteration ||
          latestExtractionRow.attempt !== memoryArtifact.producer.attempt ||
          latestExtractionRow.observationKey !== memoryArtifact.producer.observationKey
        ) {
          return yield* Effect.fail(
            new Error("memory extraction artifact is not the latest extraction result"),
          );
        }
        const extractionPayload = MemoryExtractionObservationPayloadSchema.parse(
          producerExtraction.payload,
        );
        if (
          extractionPayload.proposalCount !== memoryArtifact.result.proposals.length ||
          extractionPayload.discardedCount !== memoryArtifact.result.discardedCount ||
          extractionPayload.extractionSha256Hex !== extractionSha256Hex
        ) {
          return yield* Effect.fail(new Error("memory extraction artifact producer differs"));
        }
        const memoryMeasurementRows = yield* sql<{
          readonly loopIteration: number;
          readonly attempt: number;
          readonly providerRequestIndex: number;
          readonly agentRole: string;
          readonly modelId: string;
          readonly requestSha256Hex: string;
          readonly inputTokens: number;
          readonly requestedOutputTokens: number;
          readonly passed: boolean;
        }>`
          select loop_iteration as "loopIteration", attempt,
                 (payload->>'providerRequestIndex')::int as "providerRequestIndex",
                 payload->>'agentRole' as "agentRole",
                 payload->>'modelId' as "modelId",
                 payload->>'requestSha256Hex' as "requestSha256Hex",
                 (payload->>'inputTokens')::int as "inputTokens",
                 (payload->>'requestedOutputTokens')::int as "requestedOutputTokens",
                 (payload->>'passed')::boolean as passed
          from ai_observations
          where run_id = ${run.id}
            and emitting_task = ${memoryArtifact.producer.taskId}
            and kind = 'provider_request_measurement'
          order by loop_iteration, attempt, (payload->>'providerRequestIndex')::int
        `;
        const producerCoordinate = [
          memoryArtifact.producer.loopIteration,
          memoryArtifact.producer.attempt,
        ];
        // A memory-extract attempt is a bounded tool loop.  Every provider
        // request in that loop owns a distinct measurement and usage row; the
        // terminal extraction belongs to the latest provider coordinate, not
        // to the first request in the attempt.
        const producerMeasurements = memoryMeasurementRows.filter(
          (row) =>
            row.loopIteration === producerCoordinate[0] && row.attempt === producerCoordinate[1],
        );
        const producerMeasurement = producerMeasurements.at(-1);
        const latestMemoryMeasurement = memoryMeasurementRows.at(-1);
        if (
          producerMeasurement === undefined ||
          producerMeasurement.agentRole !==
            (memoryArtifact.producer.taskId === "memory-extract"
              ? "memory_extractor"
              : "evaluation_general_planner") ||
          producerMeasurement.modelId !== "glm-5-turbo" ||
          !/^[0-9a-f]{64}$/u.test(producerMeasurement.requestSha256Hex) ||
          producerMeasurement.passed !== true ||
          latestMemoryMeasurement !== producerMeasurement
        ) {
          return yield* Effect.fail(
            new Error("memory extraction result is not bound to its latest passed measurement"),
          );
        }
        const memoryUsageRows = yield* sql<{
          readonly providerRequestIndex: number;
          readonly agentRole: string;
          readonly modelId: string;
          readonly providerServiceId: string;
          readonly inputTokens: number;
          readonly outputTokens: number;
          readonly cachedTokens: number;
          readonly stopReason: string;
        }>`
          select provider_request_index as "providerRequestIndex", agent_role as "agentRole",
                 model_id as "modelId", provider_service_id as "providerServiceId",
                 input_tokens as "inputTokens", output_tokens as "outputTokens",
                 cached_tokens as "cachedTokens", stop_reason as "stopReason"
          from ai_run_usage
          where run_id = ${run.id}
            and task_id = ${memoryArtifact.producer.taskId}
            and loop_iteration = ${memoryArtifact.producer.loopIteration}
            and attempt = ${memoryArtifact.producer.attempt}
        `;
        const memoryUsageRowsAtProducerCoordinate = memoryUsageRows.filter(
          (row) => row.providerRequestIndex === producerMeasurement.providerRequestIndex,
        );
        const memoryUsage = memoryUsageRowsAtProducerCoordinate[0];
        if (
          memoryUsageRowsAtProducerCoordinate.length !== 1 ||
          memoryUsage === undefined ||
          memoryUsage.providerRequestIndex !== producerMeasurement.providerRequestIndex ||
          memoryUsage.agentRole !== producerMeasurement.agentRole ||
          memoryUsage.modelId !== producerMeasurement.modelId ||
          memoryUsage.providerServiceId !== acceptanceScope.provider ||
          !["zai_coding_plan_official", "deterministic_test", "openai_compatible_custom"].includes(
            memoryUsage.providerServiceId,
          ) ||
          !["stop", "length", "toolUse"].includes(memoryUsage.stopReason) ||
          memoryUsage.inputTokens + memoryUsage.cachedTokens !== producerMeasurement.inputTokens ||
          memoryUsage.outputTokens > producerMeasurement.requestedOutputTokens
        ) {
          return yield* Effect.fail(
            new Error("memory extraction result lacks its exact provider usage"),
          );
        }

        const terminal = existingTerminalResult(run);
        if (terminal !== null) return terminal;

        yield* insertAiObservation({
          runId: run.id,
          chatId: run.chatId,
          emittingTask: "finalize",
          loopIteration: input.coordinates.loopIteration,
          attempt: input.coordinates.attempt,
          observationKey: `finalize:${input.coordinates.loopIteration}:${input.coordinates.attempt}:memory_application:result`,
          kind: "memory_application",
          payload: {
            extractionTaskId: memoryArtifact.producer.taskId,
            extractionLoopIteration: memoryArtifact.producer.loopIteration,
            extractionAttempt: memoryArtifact.producer.attempt,
            extractionObservationKey: memoryArtifact.producer.observationKey,
            extractionSha256Hex,
            proposalCount: memoryArtifact.result.proposals.length,
            discardedCount: memoryArtifact.result.discardedCount,
          },
        });

        let answer = input.answer;
        if (answer.status === "ok") {
          assertFinalSourceMap(answer, run.citationNamespace);
          const sourceAllowed = answer.sourceMap.map((source) => {
            if (source.locator.kind === "document") {
              const sourceId = source.locator.sourceId;
              return sourceId.startsWith("public:")
                ? acceptanceScope.publicSourceIds.includes(sourceId.slice("public:".length))
                : sourceId.startsWith("publisher:")
                  ? acceptanceScope.subscriptionIds.includes(sourceId.slice("publisher:".length))
                  : false;
            }
            if (source.locator.kind === "memory") {
              return (
                acceptanceScope.memoryMode === "private_owner" &&
                acceptanceScope.memoryRevisionIds.includes(source.locator.memoryRevisionId)
              );
            }
            if (source.locator.kind === "web") return acceptanceScope.webEnabled;
            return true;
          });
          if (
            sourceAllowed.length !== answer.sourceMap.length ||
            sourceAllowed.some((allowed) => !allowed)
          ) {
            answer = {
              status: "failed",
              code: "finalization_failed",
              retryable: isRetryableAiRunError("finalization_failed"),
            };
          }
        }

        // Authorize against the revision that was actually rendered. Memory
        // proposals are applied below; doing that first would advance a cited
        // memory's head revision and make an otherwise valid answer appear to
        // have lost access to its source during the same transaction.
        const memory = yield* applyMemoryProposalsInTransaction(
          run.id,
          run.initiatingUserId,
          memoryArtifact.result,
        );
        for (const write of memory.writes) {
          yield* insertAiObservation({
            runId: run.id,
            chatId: run.chatId,
            emittingTask: "finalize",
            loopIteration: input.coordinates.loopIteration,
            attempt: input.coordinates.attempt,
            observationKey: `memory_written:${write.ordinal}`,
            kind: "memory_written",
            payload: write,
          });
        }
        yield* appendAiRunEventInTransaction({
          runId: run.id,
          emissionKey: "memory_updated",
          event: {
            type: "memory_updated",
            created: memory.created,
            updated: memory.updated,
            discarded: memory.discarded,
          },
          emittedByTask: "finalize",
        });
        const usage = yield* appendAggregateAiRunUsageInTransaction(run.id, "finalize");

        if (answer.status === "failed") {
          const failure = yield* transitionToFailure(
            run.id,
            answer.code,
            "finalize",
            answer.retryable,
          );
          return {
            status: "failed" as const,
            ...failure,
            memory,
            usage,
            alreadyTerminal: false,
          };
        }

        const messages = yield* sql<IdRow>`
          insert into chat_messages (chat_id, author, content, assistant_ai_run_id)
          values (${run.chatId}, 'assistant', ${answer.content}, ${run.id})
          returning id::text
        `;
        const assistantMessageId = messages[0]?.id;
        if (assistantMessageId === undefined) {
          return yield* Effect.fail(new Error("assistant message insert returned no row"));
        }

        // Source identity triggers resolve the owning terminal run through
        // this pointer, so publish it before inserting any source rows. The
        // whole finalization transaction rolls back if a source fails.
        yield* sql`
          update ai_runs
          set assistant_message_id = ${assistantMessageId}
          where id = ${run.id}
        `;
        yield* persistAssistantSources(assistantMessageId, answer.sourceMap, acceptanceScope);
        yield* persistCitationObservations(
          run,
          assistantMessageId,
          answer.content,
          answer.sourceMap,
          input.coordinates,
        );
        yield* sql`
          update ai_runs
          set assistant_message_id = ${assistantMessageId},
              finished_at = now(),
              error_code = null,
              retryable = null
          where id = ${run.id}
        `;
        yield* appendAiRunEventInTransaction({
          runId: run.id,
          emissionKey: "terminal",
          event: { type: "done", assistantMessageId },
          emittedByTask: "finalize",
        });

        return {
          status: "succeeded" as const,
          assistantMessageId,
          memory,
          usage,
          alreadyTerminal: false,
        };
      }),
    );
  });

export const failAiRun = (
  runId: string,
  code: AiRunErrorCode,
  retryable: boolean = isRetryableAiRunError(code),
  expectedSmithersRunId?: string,
): Effect.Effect<TerminalAiRunResult, SqlError | Error, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const executionScope = yield* lockRunExecutionScope(runId);
        const run = yield* loadRunForUpdate(runId);
        if (
          run.chatId !== executionScope.chatId ||
          run.initiatingUserId !== executionScope.initiatingUserId
        ) {
          return yield* Effect.fail(new Error("ai run execution scope changed"));
        }
        const acceptanceScope = parseRunAcceptanceScope(run.acceptanceScope);
        if (
          acceptanceScope.userId !== run.initiatingUserId ||
          acceptanceScope.chatId !== run.chatId ||
          acceptanceScope.companyId !== executionScope.companyId
        ) {
          return yield* Effect.fail(new Error("ai run acceptance scope binding is invalid"));
        }
        const tenantAvailable = yield* sql<{ readonly available: boolean }>`
          select exists(
            select 1
            from chats chat
            join client_companies company on company.id = chat.company_id
            join platform_users users on users.id = ${run.initiatingUserId}
            where chat.id = ${run.chatId}
              and chat.deleted_at is null
              and company.id = ${acceptanceScope.companyId}::uuid
              and company.recovery_deleted_at is null
              and company.purged_at is null
              and users.recovery_deleted_at is null
              and users.purged_at is null
          ) as available
        `;
        if (tenantAvailable[0]?.available !== true) {
          return yield* Effect.fail(new Error("ai run execution scope is no longer available"));
        }
        if (expectedSmithersRunId !== undefined && run.smithersRunId !== expectedSmithersRunId) {
          return yield* Effect.fail(
            new AiRunSmithersRunIdMismatch(runId, run.smithersRunId, expectedSmithersRunId),
          );
        }
        const terminal = existingTerminalResult(run);
        if (terminal !== null) return terminal;

        const usage = yield* appendAggregateAiRunUsageInTransaction(run.id, "failure-handler");
        const failure = yield* transitionToFailure(run.id, code, "failure-handler", retryable);
        return {
          status: "failed" as const,
          ...failure,
          memory: null,
          usage,
          alreadyTerminal: false,
        };
      }),
    );
  });
