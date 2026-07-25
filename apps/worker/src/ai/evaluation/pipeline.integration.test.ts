import { createHash } from "node:crypto";

import { PgClient } from "@effect/sql-pg";
import * as SmithersTaskRuntimeModule from "@smithers-orchestrator/driver/task-runtime";
import { Effect, Redacted } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { WorkerConfig } from "../../config";
import { runMigrations } from "../../db/migrate";
import { handleAiChatRunJob, providerServiceIdForConfig } from "../../jobs/handlers";
import type { JobRecord } from "../../jobs/types";
import {
  appendAiRunEvent,
  failAiRun,
  finalizeAiRun,
  insertAiObservation,
  insertAiRunUsage,
  insertAiSourceExposure,
  markAiRunStarted,
} from "../product-state/repository";
import { insertAiExternalToolUsage, type AiRunUsageInput } from "../product-state/observability";
import type { PiRuntimeBoundary } from "../e2e/deterministic-provider";
import {
  canonicalizeWebUrl,
  chatMessageEvidenceIdentity,
  namespacedDocumentEvidenceIdentity,
  memoryEvidenceIdentity,
  memoryExtractionSha256Hex,
  sha256Base64Url,
  sourceKeyForNamespace,
  webEvidenceIdentity,
  webQuoteHash,
} from "../runtime/canonicalization";
import { CanonicalAgentClient, type ToolLoopInput } from "../runtime/agent-client";
import { measureProviderRequest, resolveRegisteredModel } from "../runtime/model-registry";
import { validateTopicPacket } from "../runtime/validators";
import { TINYFISH_SEARCH_PROVIDER_ENDPOINT_IDENTITY } from "../web/tinyfish-search";
import { createSmithersStorage } from "../smithers-interop";
import {
  deleteSmithersRowsForRunWithSchemas,
  sweepAiChatSmithersRows,
} from "../workflow/smithers-cleanup";
import { aiEvaluationGeneralPlannerSchemas } from "./general-planner-workflow";
import type {
  BeforeProviderRequest,
  ExactPiBoundary,
  PiBoundaryCoordinates,
  PiCompletion,
} from "../runtime/pi-boundary";
import {
  providerRequestSha256Hex,
  providerRequestSourceExposureProofBindings,
  providerVisibleSourceExposureProofSha256Hex,
  type ProviderRequest,
  type ProviderRequestSourceExposureProofBinding,
  type ProviderVisibleSourceExposureMarker,
  type ProviderVisibleSourceExposureProofBinding,
  type LiveProviderRequest,
} from "../runtime/provider-request";
import { publicSourceRecordFromFinalSource } from "../runtime/public-source";
import type {
  ContextDecision,
  FinalSourceRecord,
  InternalReference,
  MemoryExtractionResult,
  MemoryExtractionArtifact,
} from "../runtime/types";
import { type CanonicalAiConfig, CanonicalWorkflowOperations } from "../workflow/operations";
import { CanonicalGoldenEvaluationSet } from "./fixtures/golden-set.v3";
import {
  abortFocusedEvaluationSession,
  attestEvaluationCaseFromDurableRun,
  bindEvaluationCaseAnnotation,
  bindEvaluationAnnotations,
  canonicalJson,
  canonicalSha256Hex,
  canonicalEvaluationFailureReason,
  CanonicalEvaluationExecutionConfig,
  CanonicalGoldenFixtureSha256Hex,
  captureEvaluationSession,
  captureEvaluationCase,
  compareDurableUsageChronology,
  createEvaluationSession,
  deriveTrustedPromptMeasurements,
  ensureEvaluationCaseRunning,
  executeGeneralPlannerEvaluationCase,
  evaluationBindingGoldenSourceId,
  type EvaluationSeedManifest,
  EvaluationSeedManifestSchema,
  executeEvaluationSession,
  evaluationWebSourceAuthorized,
  evaluationCaseResumeAction,
  prepareAndExecuteEvaluationSession,
  revalidateCapturedArtifacts,
  recoverFailedEvaluationSessionChildren,
  seedEvaluationSession,
  withEvaluationSessionExecutionLease,
} from "./pipeline";
import {
  attestExactPlanTurnRequest,
  attestExactProductionContext,
  canonicalEvaluationUsableInputTokens,
  evaluateSuite,
  measureCanonicalEvaluationRequestTokens,
  measureCanonicalProductionEvaluationRequestTokens,
  measureExactProductionContextMarginals,
  productionPacketSha256Hex,
  type ExactProductionTopicPacket,
} from "./runner";

const sourceDatabaseUrl = process.env.WORKER_POSTGRES_TEST_DATABASE_URL;
const databaseName = `brief_eval_pipeline_${process.pid}_${crypto
  .randomUUID()
  .replaceAll("-", "")
  .slice(0, 8)}`;
const sessionId = "50000000-0000-4000-8000-000000000050";
const captureSessionId = "50000000-0000-4000-8000-000000000051";
const tokenTamperSessionId = "50000000-0000-4000-8000-000000000052";
const decisionTamperSessionId = "50000000-0000-4000-8000-000000000053";
const resumeSessionId = "50000000-0000-4000-8000-000000000054";
const identitySessionId = "50000000-0000-4000-8000-000000000055";
const exposureTamperSessionId = "50000000-0000-4000-8000-000000000056";
const terminalStopTamperSessionId = "50000000-0000-4000-8000-000000000057";
const clarificationStopTamperSessionId = "50000000-0000-4000-8000-000000000058";
const clarificationSubsetTamperSessionId = "50000000-0000-4000-8000-000000000059";
const concurrentSeedSessionId = "50000000-0000-4000-8000-000000000060";
const oExposureTamperSessionId = "50000000-0000-4000-8000-000000000061";
const clarificationOrderTamperSessionId = "50000000-0000-4000-8000-000000000062";
const clarificationBoundaryTamperSessionId = "50000000-0000-4000-8000-000000000063";
const documentVersionTamperSessionId = "50000000-0000-4000-8000-000000000064";
const documentHashTamperSessionId = "50000000-0000-4000-8000-000000000065";
const memoryRevisionTamperSessionId = "50000000-0000-4000-8000-000000000066";
const webIdentityTamperSessionId = "50000000-0000-4000-8000-000000000067";
const webStageTamperSessionId = "50000000-0000-4000-8000-000000000068";
const exposureCoordinateTamperSessionId = "50000000-0000-4000-8000-000000000069";
const reducerTerminalTamperSessionId = "50000000-0000-4000-8000-000000000070";
const clarificationModelTamperSessionId = "50000000-0000-4000-8000-000000000071";
const clarificationInputTamperSessionId = "50000000-0000-4000-8000-000000000072";
const clarificationDateTamperSessionId = "50000000-0000-4000-8000-000000000126";
const directDigestTamperSessionId = "50000000-0000-4000-8000-000000000073";
const topicDigestTamperSessionId = "50000000-0000-4000-8000-000000000074";
const synthesisDigestTamperSessionId = "50000000-0000-4000-8000-000000000075";
const memoryInternalStageTamperSessionId = "50000000-0000-4000-8000-000000000076";
const chatWebStageTamperSessionId = "50000000-0000-4000-8000-000000000077";
const wrongKindOTamperSessionId = "50000000-0000-4000-8000-000000000078";
const arbitraryTaskTamperSessionId = "50000000-0000-4000-8000-000000000079";
const invertedUsageTamperSessionId = "50000000-0000-4000-8000-000000000080";
const sealedSnapshotTamperSessionId = "50000000-0000-4000-8000-000000000081";
const completeEvidenceTamperSessionId = "50000000-0000-4000-8000-000000000082";
const preSealMessageTamperSessionId = "50000000-0000-4000-8000-000000000083";
const preSealOwnerTamperSessionId = "50000000-0000-4000-8000-000000000084";
const preSealLedgerTamperSessionId = "50000000-0000-4000-8000-000000000085";
const preSealContextTamperSessionId = "50000000-0000-4000-8000-000000000086";
const preSealDeltaTamperSessionId = "50000000-0000-4000-8000-000000000087";
const preSealUseTamperSessionId = "50000000-0000-4000-8000-000000000088";
const preSealMemoryCreateSessionId = "50000000-0000-4000-8000-000000000089";
const preSealMemoryUpdateSessionId = "50000000-0000-4000-8000-000000000090";
const preSealCitationInsertSessionId = "50000000-0000-4000-8000-000000000091";
const preSealCitationChangeSessionId = "50000000-0000-4000-8000-000000000092";
const preSealCitationDeleteSessionId = "50000000-0000-4000-8000-000000000093";
const preSealExposureCountSessionId = "50000000-0000-4000-8000-000000000094";
const preSealMemoryRetrySessionId = "50000000-0000-4000-8000-000000000095";
const preSealMembershipSessionId = "50000000-0000-4000-8000-000000000096";
const preSealUserRecoverySessionId = "50000000-0000-4000-8000-000000000097";
const preSealCompanyRecoverySessionId = "50000000-0000-4000-8000-000000000098";
const preSealManifestSessionId = "50000000-0000-4000-8000-000000000099";
const preSealResolutionSessionId = "50000000-0000-4000-8000-000000000100";
const postSealUsageTamperSessionId = "50000000-0000-4000-8000-000000000101";
const preSealMemoryTerminalMismatchSessionId = "50000000-0000-4000-8000-000000000102";
const oversizedMissingInspectionSessionId = "50000000-0000-4000-8000-000000000103";
const oversizedDuplicateInspectionSessionId = "50000000-0000-4000-8000-000000000104";
const oversizedWrongCoordinateInspectionSessionId = "50000000-0000-4000-8000-000000000105";
const manifestPurposeTamperSessionId = "50000000-0000-4000-8000-000000000106";
const deterministicProductionGraphSessionId = "50000000-0000-4000-8000-000000000107";
const liveProductionCaptureSessionId = "50000000-0000-4000-8000-000000000108";
const deterministicGeneralPlannerSessionId = "50000000-0000-4000-8000-000000000109";
const deterministicGeneralPlannerFanoutSessionId = "50000000-0000-4000-8000-000000000124";
const deterministicMemoryFinalizationSessionId = "50000000-0000-4000-8000-000000000125";
const failedGeneralPlannerSessionId = "50000000-0000-4000-8000-000000000110";
const preLaunchFailedGeneralPlannerSessionId = "50000000-0000-4000-8000-000000000111";
const crashResumeFailureSessionId = "50000000-0000-4000-8000-000000000112";
const sameMillisecondUsageSessionId = "50000000-0000-4000-8000-000000000113";
const focusedAbortSessionId = "50000000-0000-4000-8000-000000000114";
const invertedEventTimestampSessionId = "50000000-0000-4000-8000-000000000115";
const transcriptReconstructionSessionId = "50000000-0000-4000-8000-000000000116";
const documentMetadataTamperSessionId = "50000000-0000-4000-8000-000000000117";
const baselineRetentionSessionId = "50000000-0000-4000-8000-000000000119";
const nonselectedChatInspectionSessionId = "50000000-0000-4000-8000-000000000120";
const nonselectedChatSerializedSessionId = "50000000-0000-4000-8000-000000000121";
const currentChatPreviewSessionId = "50000000-0000-4000-8000-000000000122";
const selectedChatPreviewSessionId = "50000000-0000-4000-8000-000000000123";
const focusedProductionCaseId = "first-message-document-fr";
const focusedClarificationCaseId = "ambiguous-reference-needs-clarification";
const focusedFanoutCaseId = "cross-cutting-separable-energy-question";
const multiWebQuoteSessionId = "50000000-0000-4000-8000-000000000118";
const fixtureProviderRequestSha256Hex = "a".repeat(64);
const liveCaptureApiKey = process.env.ZAI_API_KEY?.trim();
const liveCaptureEnabled =
  process.env.AI_EVALUATION_LIVE_CAPTURE_TESTS === "1" &&
  liveCaptureApiKey !== undefined &&
  liveCaptureApiKey.length > 0;

const databaseUrlFor = (name: string): string => {
  if (sourceDatabaseUrl === undefined) throw new Error("database test URL is missing");
  const url = new URL(sourceDatabaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
};
const isolatedDatabaseUrl = (): string => databaseUrlFor(databaseName);
const adminDatabaseUrl = (): string => databaseUrlFor("postgres");
const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const withTaskRuntime = (
  SmithersTaskRuntimeModule as unknown as {
    readonly withTaskRuntime: <Value>(
      runtime: {
        readonly runId: string;
        readonly stepId: string;
        readonly attempt: number;
        readonly iteration: number;
        readonly signal: AbortSignal;
        readonly db: Readonly<Record<string, unknown>>;
        readonly heartbeat: (data?: unknown) => void;
        readonly lastHeartbeat: unknown | null;
      },
      execute: () => Value,
    ) => Value;
  }
).withTaskRuntime;
const inAiTask = <Value>(
  aiRunId: string,
  stepId: string,
  execute: () => Value,
  iteration = 0,
): Value =>
  withTaskRuntime(
    {
      runId: `ai-chat:${aiRunId}`,
      stepId,
      attempt: 1,
      iteration,
      signal: new AbortController().signal,
      db: {},
      heartbeat: () => undefined,
      lastHeartbeat: null,
    },
    execute,
  );
const runDb = <A, E>(url: string, effect: Effect.Effect<A, E, PgClient.PgClient>): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        PgClient.layer({
          url: Redacted.make(url),
          applicationName: "brief-evaluation-pipeline-test",
        }),
      ),
    ),
  );

const insertAiRunUsageAt = (input: AiRunUsageInput, createdAt: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<{ readonly id: string }>`
      insert into ai_run_usage (
        run_id, task_id, loop_iteration, attempt, provider_request_index,
        agent_role, model_id, provider_service_id, input_tokens, output_tokens,
        cached_tokens, reasoning_tokens, total_tokens, stop_reason, created_at
      ) values (
        ${input.runId}, ${input.taskId}, ${input.loopIteration}, ${input.attempt},
        ${input.providerRequestIndex}, ${input.agentRole}, ${input.modelId},
        ${input.providerServiceId}, ${input.usage.inputTokens}, ${input.usage.outputTokens},
        ${input.usage.cachedTokens}, ${input.usage.reasoningTokens}, ${input.usage.totalTokens},
        ${input.usage.stopReason}, ${createdAt}::timestamptz
      )
      on conflict (run_id, task_id, loop_iteration, attempt, provider_request_index) do nothing
      returning id::text
    `;
    yield* appendAiRunEvent({
      runId: input.runId,
      emissionKey: `usage:request:model:${input.taskId}:${input.loopIteration}:${input.attempt}:${input.providerRequestIndex}`,
      emittedByTask: input.taskId,
      event: {
        type: "usage",
        scope: "request",
        kind: "model",
        role: input.agentRole,
        attempt: input.attempt,
        inputTokens: input.usage.inputTokens,
        outputTokens: input.usage.outputTokens,
        cachedTokens: input.usage.cachedTokens,
        reasoningTokens: input.usage.reasoningTokens,
        totalTokens: input.usage.totalTokens,
      },
    });
    return rows.length === 1;
  });

const canonicalAiConfig: CanonicalAiConfig = {
  aiMainModel: "glm-5-turbo",
  aiFastModel: "glm-5-turbo",
  aiMainInputMaxTokens: 100_000,
  aiMainOutputMaxTokens: 16_384,
  aiFastInputMaxTokens: 100_000,
  aiFastOutputMaxTokens: 16_384,
  aiConversationRecentTurns: 12,
  aiFanoutMaxTopics: 3,
  aiRetrievalMaxTurns: 4,
  aiInternalMaxSearches: 4,
  aiInternalMaxInspections: 8,
  aiWebMaxSearches: 2,
  aiWebMaxFetches: 2,
  aiWebMaxDomainFilters: 8,
  aiContextReductionMaxIterations: 2,
  aiMemoryToolResultMaxItems: 20,
  webResearchProvider: "",
};

// Evaluation preflight intentionally exercises rejected historical model
// overrides. Keep that escape hatch local to this explicit evaluation helper;
// the live WorkerConfig contract remains the exact turbo literal.
type EvaluationWorkerConfigOverrides = Omit<
  Partial<WorkerConfig>,
  "aiMainModel" | "aiFastModel"
> & {
  readonly aiMainModel?: string;
  readonly aiFastModel?: string;
};

const canonicalEvaluationWorkerConfig = (
  overrides: EvaluationWorkerConfigOverrides = {},
): WorkerConfig =>
  ({
    ...CanonicalEvaluationExecutionConfig,
    databaseUrl: isolatedDatabaseUrl(),
    zaiApiKey: "test-zai-api-key",
    tinyfishApiKey: "test-tinyfish-api-key",
    aiE2eFakeProvider: false,
    ...overrides,
  }) as WorkerConfig;

class OlderChatEvaluationAgent extends CanonicalAgentClient {
  constructor(private readonly expectedMessageId: string) {
    super({} as ExactPiBoundary);
  }

  override async toolLoop<Output>(input: ToolLoopInput<Output>): Promise<Output> {
    if (input.terminalToolName !== "emit_internal_manifest") {
      throw new Error(`unexpected tool loop ${input.terminalToolName}`);
    }
    const search = input.tools.find((tool) => tool.definition.name === "search_internal");
    const inspect = input.tools.find((tool) => tool.definition.name === "inspect_internal");
    if (search === undefined || inspect === undefined) throw new Error("missing internal tools");
    const coordinates: PiBoundaryCoordinates = {
      ...input.coordinates,
      loopIteration: 0,
      providerRequestIndex: 0,
    };
    const result = (await search.execute(
      {
        query: {
          target: "chat_messages",
          terms: "storage evening ramp",
          purpose: "recover the older storage-pilot result",
          limit: 20,
        },
      },
      coordinates,
    )) as { readonly items: readonly { readonly messageId: string }[] };
    const match = result.items.find((item) => item.messageId === this.expectedMessageId);
    if (match === undefined) throw new Error("old evaluation message was not searchable");
    const reference: InternalReference = {
      kind: "chat_message",
      messageId: match.messageId,
      purpose: "recover the older storage-pilot result",
    };
    const inspected = (await inspect.execute({ reference }, coordinates)) as {
      readonly found: boolean;
      readonly complete: boolean;
    };
    if (!inspected.found || !inspected.complete) {
      throw new Error("old evaluation message was not inspectable");
    }
    return input.validateTerminal({ entries: [reference] });
  }
}

class OversizedSelectorBoundary implements PiRuntimeBoundary {
  readonly requestInputTokens = new Map<string, number[]>();
  readonly reductionCandidateHandles = new Set<string>();
  discoveredDocumentCount = 0;
  inspectedDocumentCount = 0;
  selectedMemoryCount = 0;
  private reductionDecisions: readonly ContextDecision[] = [];

  setReductionDecisions(decisions: readonly ContextDecision[]): void {
    this.reductionDecisions = decisions;
  }

  async complete(
    request: LiveProviderRequest,
    coordinates: PiBoundaryCoordinates,
    beforeProviderRequest?: BeforeProviderRequest,
  ): Promise<PiCompletion> {
    if (request.requestClass !== "fast" || request.model !== canonicalAiConfig.aiFastModel) {
      throw new Error("oversized selector preflight used the wrong provider gate");
    }
    const model = resolveRegisteredModel(request.model);
    const measurement = measureProviderRequest(request, model, {
      inputTokens: canonicalAiConfig.aiFastInputMaxTokens,
      outputTokens: canonicalAiConfig.aiFastOutputMaxTokens,
    });
    if (!measurement.passed) {
      throw new Error(
        `oversized selector transcript exceeded its exact fast gate: ${measurement.inputTokens}`,
      );
    }
    const roleMeasurements = this.requestInputTokens.get(coordinates.agentRole) ?? [];
    roleMeasurements.push(measurement.inputTokens);
    this.requestInputTokens.set(coordinates.agentRole, roleMeasurements);
    await beforeProviderRequest?.(
      request,
      { ...coordinates, providerRequestSha256Hex: providerRequestSha256Hex(request) },
      measurement,
    );

    const usage = {
      inputTokens: measurement.inputTokens,
      outputTokens: 1,
      cachedTokens: 0,
      reasoningTokens: 0,
      totalTokens: measurement.inputTokens + 1,
      stopReason: "toolUse",
    } as const;
    if (coordinates.agentRole === "context_reducer") {
      if (this.reductionDecisions.length === 0) {
        throw new Error("oversized O preflight has no complete reduction plan");
      }
      const userMessage = request.messages.find((message) => message.role === "user");
      if (userMessage?.role !== "user") throw new Error("oversized O input is missing");
      const input = JSON.parse(userMessage.content) as {
        readonly candidates: readonly { readonly id: string }[];
      };
      if (input.candidates.length !== this.reductionDecisions.length) {
        throw new Error("oversized O candidate handle count differs from its complete plan");
      }
      const providerDecisions = this.reductionDecisions.map((decision, index) => {
        const handle = input.candidates[index]?.id;
        if (handle === undefined || !/^opaque_candidate_[1-9][0-9]*$/u.test(handle)) {
          throw new Error("oversized O input exposed a non-opaque candidate handle");
        }
        this.reductionCandidateHandles.add(handle);
        return { ...decision, id: handle };
      });
      const rangeDecisions = providerDecisions.filter(
        (decision): decision is Extract<ContextDecision, { action: "range" }> =>
          decision.action === "range",
      );
      const searches = request.messages.filter(
        (message) => message.role === "tool" && message.name === "search_within_candidate",
      );
      if (searches.length < rangeDecisions.length) {
        const decision = rangeDecisions[searches.length];
        if (decision === undefined) throw new Error("oversized O search candidate is missing");
        return {
          text: "",
          toolCalls: [
            {
              id: `oversized-o-search-${searches.length + 1}`,
              name: "search_within_candidate",
              arguments: { id: decision.id, terms: "binding conclusion" },
            },
          ],
          usage,
          stopReason: "toolUse",
        };
      }
      const inspections = request.messages.filter(
        (message) => message.role === "tool" && message.name === "inspect_candidate",
      );
      if (inspections.length < rangeDecisions.length) {
        const decision = rangeDecisions[inspections.length];
        if (decision === undefined) throw new Error("oversized O inspection candidate is missing");
        return {
          text: "",
          toolCalls: [
            {
              id: `oversized-o-inspect-${inspections.length + 1}`,
              name: "inspect_candidate",
              arguments: { id: decision.id, range: decision.ranges[0] },
            },
          ],
          usage,
          stopReason: "toolUse",
        };
      }
      const measurementMessage = [...request.messages]
        .reverse()
        .find((message) => message.role === "tool" && message.name === "measure_plan");
      if (measurementMessage?.role !== "tool") {
        return {
          text: "",
          toolCalls: [
            {
              id: "oversized-o-measure",
              name: "measure_plan",
              arguments: { decisions: providerDecisions },
            },
          ],
          usage,
          stopReason: "toolUse",
        };
      }
      const planMeasurement = JSON.parse(measurementMessage.content) as {
        readonly valid: boolean;
        readonly resolved: boolean;
      };
      if (!planMeasurement.valid || !planMeasurement.resolved) {
        throw new Error("oversized O exact plan did not resolve the overage");
      }
      return {
        text: "",
        toolCalls: [
          {
            id: "oversized-o-terminal",
            name: "emit_context_plan",
            arguments: { decisions: providerDecisions },
          },
        ],
        usage,
        stopReason: "toolUse",
      };
    }
    if (coordinates.agentRole === "memory_selector") {
      const userMessage = request.messages.find((message) => message.role === "user");
      if (userMessage?.role !== "user") throw new Error("oversized B input is missing");
      const input = JSON.parse(userMessage.content) as {
        readonly activeMemoryCount: number;
      };
      if (input.activeMemoryCount !== 4) {
        throw new Error("oversized B did not receive exactly four saved memories");
      }
      if (coordinates.providerRequestIndex === 0) {
        return {
          text: "",
          toolCalls: [
            {
              id: "oversized-b-search",
              name: "search_memories",
              arguments: { query: "audit" },
            },
          ],
          usage,
          stopReason: "toolUse",
        };
      }
      const searchResultMessage = [...request.messages]
        .reverse()
        .find((message) => message.role === "tool" && message.name === "search_memories");
      if (searchResultMessage?.role !== "tool")
        throw new Error("oversized B search result is missing");
      const searchResult = JSON.parse(searchResultMessage.content) as {
        readonly items: readonly { readonly memoryId: string; readonly memoryRevisionId: string }[];
      };
      if (searchResult.items.length !== 4)
        throw new Error("oversized B search did not find four memories");
      this.selectedMemoryCount = searchResult.items.length;
      return {
        text: "",
        toolCalls: [
          {
            id: "oversized-b-terminal",
            name: "emit_memory_manifest",
            arguments: {
              entries: searchResult.items.map(({ memoryId, memoryRevisionId }) => ({
                memoryId,
                memoryRevisionId,
              })),
            },
          },
        ],
        usage,
        stopReason: "toolUse",
      };
    }
    if (coordinates.agentRole !== "internal_retrieval") {
      throw new Error(`unexpected oversized selector role ${coordinates.agentRole}`);
    }
    if (coordinates.providerRequestIndex === 0) {
      return {
        text: "",
        toolCalls: [
          {
            id: "oversized-a-search",
            name: "search_internal",
            arguments: {
              query: {
                target: "documents",
                terms: "binding conclusion",
                purpose: "answer every regional curtailment result",
                limit: 6,
              },
            },
          },
        ],
        usage,
        stopReason: "toolUse",
      };
    }
    if (coordinates.providerRequestIndex === 1) {
      const searchResultMessage = [...request.messages]
        .reverse()
        .find((message) => message.role === "tool" && message.name === "search_internal");
      if (searchResultMessage?.role !== "tool") {
        throw new Error("oversized A inspection request lacks its search result");
      }
      const searchResult = JSON.parse(searchResultMessage.content) as {
        readonly complete: boolean;
        readonly truncated: boolean;
        readonly items: readonly {
          readonly kind: "document";
          readonly documentId: string;
        }[];
      };
      if (!searchResult.complete || searchResult.truncated || searchResult.items.length !== 6) {
        throw new Error("oversized A search did not discover exactly six complete results");
      }
      this.discoveredDocumentCount = searchResult.items.length;
      return {
        text: "",
        toolCalls: searchResult.items.map((item, index) => ({
          id: `oversized-a-inspect-${index + 1}`,
          name: "inspect_internal",
          arguments: {
            reference: {
              kind: "document" as const,
              documentId: item.documentId,
              range: { charStart: 0, charEnd: 2_048 },
              purpose: "answer every regional curtailment result",
            },
          },
        })),
        usage,
        stopReason: "toolUse",
      };
    }
    const inspections = request.messages.filter(
      (message) => message.role === "tool" && message.name === "inspect_internal",
    );
    if (inspections.length !== 6) {
      throw new Error("oversized A terminal request lacks six inspections");
    }
    for (const inspection of inspections) {
      if (inspection.role !== "tool") continue;
      const result = JSON.parse(inspection.content) as {
        readonly found: boolean;
        readonly complete: boolean;
      };
      if (!result.found || !result.complete) {
        throw new Error("oversized A inspection was not complete");
      }
      if (model.countTextTokens(inspection.content) > canonicalAiConfig.aiFastOutputMaxTokens) {
        throw new Error("oversized A inspection exceeded the fast output bound");
      }
    }
    this.inspectedDocumentCount = inspections.length;
    const references = request.messages
      .filter((message) => message.role === "assistant")
      .flatMap((message) =>
        message.role === "assistant"
          ? (message.toolCalls ?? [])
              .filter((call) => call.name === "inspect_internal")
              .map(
                (call) => (call.arguments as { readonly reference: InternalReference }).reference,
              )
          : [],
      )
      .map((reference) =>
        reference.kind === "document"
          ? {
              kind: "document" as const,
              documentId: reference.documentId,
              purpose: reference.purpose,
            }
          : reference,
      );
    return {
      text: "",
      toolCalls: [
        {
          id: "oversized-a-terminal",
          name: "emit_internal_manifest",
          arguments: { entries: references },
        },
      ],
      usage,
      stopReason: "toolUse",
    };
  }

  async stream(): Promise<PiCompletion> {
    throw new Error("oversized A preflight must not stream");
  }
}

const completeAnnotations = () => ({
  artifactVersion: 3 as const,
  goldenSetVersion: 3 as const,
  sessionId,
  annotations: CanonicalGoldenEvaluationSet.cases.flatMap((fixture) =>
    (["specialized", "general_planner"] as const).map((topology) => ({
      caseId: fixture.id,
      topology,
      claims: [],
      reportedGapIds: [],
    })),
  ),
});

const labeledAnnotations = (targetSessionId = captureSessionId) => ({
  artifactVersion: 3 as const,
  goldenSetVersion: 3 as const,
  sessionId: targetSessionId,
  annotations: CanonicalGoldenEvaluationSet.cases.flatMap((fixture) =>
    (["specialized", "general_planner"] as const).map((topology) => ({
      caseId: fixture.id,
      topology,
      claims: fixture.labels.supportedClaims.map((claim) => ({
        claimId: claim.claimId,
        citedSourceIds: [claim.supportingSourceIds[0]!],
      })),
      reportedGapIds: fixture.labels.expectedGaps.map((gap) => gap.gapId),
    })),
  ),
});

const completeDurableCaptureSession = async (
  targetSessionId = captureSessionId,
  tamper?:
    | "pre_token_mismatch"
    | "later_invalid_decision"
    | "unknown_exposure"
    | "unknown_o_exposure"
    | "terminal_error_stop"
    | "clarification_error_stop"
    | "clarification_subset"
    | "clarification_reordered"
    | "clarification_boundary_count"
    | "wrong_document_version"
    | "coordinated_document_hash"
    | "tampered_document_reconstruction"
    | "wrong_memory_revision"
    | "wrong_web_identity"
    | "wrong_web_stage"
    | "wrong_exposure_coordinate"
    | "o_later_error"
    | "clarification_model_mismatch"
    | "clarification_input_mismatch"
    | "clarification_date_mismatch"
    | "direct_request_digest"
    | "topic_request_digest"
    | "synthesis_request_digest"
    | "memory_as_internal_preview"
    | "chat_as_web_preview"
    | "wrong_kind_o"
    | "arbitrary_internal_task"
    | "cross_task_same_millisecond_usage"
    | "o_inverted_chronology"
    | "preseal_event_timestamp_inversion"
    | "preseal_current_message_author"
    | "preseal_terminal_owner"
    | "preseal_duplicate_run_started"
    | "preseal_context_payload"
    | "preseal_delta_gap"
    | "preseal_coordinated_source_use"
    | "preseal_memory_create_before"
    | "preseal_memory_update_before"
    | "preseal_citation_insert"
    | "preseal_citation_change"
    | "preseal_citation_delete"
    | "preseal_exposure_count"
    | "preseal_stale_memory_retry"
    | "preseal_terminal_memory_mismatch"
    | "preseal_membership_revoked"
    | "preseal_user_recovery_deleted"
    | "preseal_company_recovery_deleted"
    | "preseal_manifest_delete"
    | "preseal_duplicate_resolution"
    | "oversized_missing_internal_inspection"
    | "oversized_duplicate_internal_inspection"
    | "oversized_wrong_coordinate_internal_inspection"
    | "nonselected_chat_inspection"
    | "nonselected_chat_serialized"
    | "current_chat_preview"
    | "selected_chat_preview"
    | "manifest_purpose",
  multiWebQuotes = false,
): Promise<void> => {
  await createEvaluationSession(isolatedDatabaseUrl(), targetSessionId);
  await seedEvaluationSession(isolatedDatabaseUrl(), targetSessionId);
  await runDb(
    isolatedDatabaseUrl(),
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      yield* sql`
        update ai_evaluation_sessions
        set status = 'running',
            execution_config_sha256_hex = ${canonicalSha256Hex(CanonicalEvaluationExecutionConfig)},
            provider_endpoint_identity = ${TINYFISH_SEARCH_PROVIDER_ENDPOINT_IDENTITY},
            updated_at = now()
        where id = ${targetSessionId}
      `;
    }),
  );
  const rows = await runDb(
    isolatedDatabaseUrl(),
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      return yield* sql<{
        readonly caseId: string;
        readonly topology: "specialized" | "general_planner";
        readonly runId: string;
        readonly seedManifest: unknown;
      }>`
        select case_id as "caseId", topology, ai_run_id::text as "runId",
               seed_manifest as "seedManifest"
        from ai_evaluation_case_runs where session_id = ${targetSessionId}
        order by case_id, topology
      `;
    }),
  );
  let preSealTamperApplied = false;
  for (const row of rows) {
    const fixture = CanonicalGoldenEvaluationSet.cases.find((item) => item.id === row.caseId)!;
    const manifest = EvaluationSeedManifestSchema.parse(row.seedManifest);
    await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update ai_evaluation_case_runs
          set status = 'running', started_at = now(), updated_at = now()
          where session_id = ${targetSessionId} and case_id = ${row.caseId}
            and topology = ${row.topology}
        `;
        yield* markAiRunStarted(row.runId);
        const smithersRunId =
          row.topology === "specialized"
            ? `ai-chat:${row.runId}`
            : `ai-evaluation-general-planner:${targetSessionId}:${row.caseId}`;
        yield* sql`
          update ai_runs
          set started_at = now() - interval '1 second', smithers_run_id = ${smithersRunId}
          where id = ${row.runId}
        `;
      }),
    );
    const citationNamespace = await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const values = yield* sql<{ readonly citationNamespace: string }>`
          select citation_namespace as "citationNamespace" from ai_runs where id = ${row.runId}
        `;
        return values[0]!.citationNamespace;
      }),
    );
    const selectedIds = fixture.labels.requiredSourceIds;
    const selected = selectedIds.map((sourceId) => ({
      sourceId,
      ranges:
        fixture.evidence.find((source) => source.sourceId === sourceId)?.kind === "document"
          ? (fixture.labels.acceptableRanges[sourceId] ??
            fixture.evidence.find((source) => source.sourceId === sourceId)!.ranges)
          : [],
    }));
    const fullCandidateSelections = selectedIds.map((sourceId) => ({
      sourceId,
      ranges: fixture.evidence.find((source) => source.sourceId === sourceId)?.ranges ?? [],
    }));
    const candidateTokens = measureCanonicalEvaluationRequestTokens(
      fixture,
      fullCandidateSelections,
    );
    const isSpecializedOversized =
      row.topology === "specialized" && fixture.dimensions.includes("oversized_evidence");
    const isSpecializedFanout =
      row.topology === "specialized" && fixture.labels.planTurn.mode === "fanout";
    const fanoutTopicIds =
      fixture.labels.planTurn.mode === "fanout"
        ? fixture.labels.planTurn.topics.map((topic) => topic.topicId)
        : [];
    const topicWebEligible = (topicId: string): boolean => {
      const topic =
        fixture.labels.planTurn.mode === "fanout"
          ? fixture.labels.planTurn.topics.find((candidate) => candidate.topicId === topicId)
          : undefined;
      return (
        topic === undefined ||
        /\b(current|latest|official|public|web|online|today|recent|status|update|live|price|actual)\b|\b(actuel(?:le|s)?|dernier(?:e|s)?|officiel(?:le|s)?|public(?:s)?|marché|prix|récent(?:e|s)?|mise à jour|en ligne)\b/iu.test(
          topic.question.normalize("NFC"),
        )
      );
    };
    const selectorHasProviderCall = (prefix: string, selector: "A" | "B" | "W"): boolean => {
      if (selector === "A") return true;
      if (selector === "B") {
        return selectedIds.some(
          (sourceId) =>
            fixture.evidence.find((source) => source.sourceId === sourceId)?.selector === "B",
        );
      }
      return (
        fixture.webRequested &&
        fixture.webPolicyEnabled &&
        topicWebEligible(prefix.startsWith("topic-") ? prefix.slice("topic-".length) : "")
      );
    };
    const noCallReasonForSelector = (
      prefix: string,
      selector: "A" | "B" | "W",
    ):
      | "no_active_memories"
      | "web_not_requested"
      | "web_policy_disabled"
      | "topic_not_web_eligible"
      | undefined => {
      if (selector === "B" && !selectorHasProviderCall(prefix, selector)) {
        return "no_active_memories";
      }
      if (selector !== "W") return undefined;
      if (!fixture.webRequested) return "web_not_requested";
      if (!fixture.webPolicyEnabled) return "web_policy_disabled";
      if (!topicWebEligible(prefix.startsWith("topic-") ? prefix.slice("topic-".length) : "")) {
        return "topic_not_web_eligible";
      }
      return undefined;
    };
    const durableReductionDecisions = isSpecializedOversized
      ? selectedIds.map((sourceId) => {
          const binding = manifest.sourceBindings.find(
            (item) => evaluationBindingGoldenSourceId(item) === sourceId,
          )!;
          const ranges = fixture.labels.acceptableRanges[sourceId];
          if (binding.kind === "document") {
            if (ranges === undefined) throw new Error("test reduction range is missing");
            return {
              id: namespacedDocumentEvidenceIdentity(binding.source, binding.documentId),
              action: "range" as const,
              ranges,
              reason: "retain the binding conclusion window",
            };
          }
          if (binding.kind === "memory") {
            return {
              id: memoryEvidenceIdentity(binding.memoryId),
              action: "keep" as const,
              reason: "keep the complete selected saved audit-rule set",
            };
          }
          throw new Error("oversized durable fixture contains an unexpected source kind");
        })
      : [];
    const model = resolveRegisteredModel("glm-5-turbo");
    let sourceMap: FinalSourceRecord[] = selected.map((selection, index) => {
      const binding = manifest.sourceBindings.find(
        (item) => evaluationBindingGoldenSourceId(item) === selection.sourceId,
      )!;
      const source = fixture.evidence.find((item) => item.sourceId === selection.sourceId)!;
      const sourceKey = sourceKeyForNamespace(citationNamespace, index + 1);
      const selectedText =
        source.kind === "document" && selection.ranges.length > 0
          ? selection.ranges
              .map((range) => source.content.slice(range.charStart, range.charEnd))
              .join("\n…\n")
          : source.content;
      const uses = isSpecializedFanout
        ? fanoutTopicIds.map((topicId) => ({
            consumerTaskId: `topic-${topicId}-answer`,
            topicId,
            contextOrder: index,
            renderedTokenCount: model.countTextTokens(selectedText),
            ranges: selection.ranges,
          }))
        : [
            {
              consumerTaskId: "single-answer",
              contextOrder: index,
              renderedTokenCount: model.countTextTokens(selectedText),
              ranges: selection.ranges,
            },
          ];
      if (binding.kind === "document") {
        const locator: FinalSourceRecord["locator"] =
          binding.source.kind === "publisher"
            ? {
                kind: "document",
                sourceId: binding.source.sourceId as `publisher:${string}`,
                documentId: binding.documentId,
                versionId: binding.versionId,
                contentHash: binding.contentHash,
                ranges: selection.ranges,
                publisherIssueId: binding.source.issueId,
                publisherDocumentId: binding.source.documentId,
                publisherExtractionId:
                  binding.publisherExtractionId ??
                  (() => {
                    throw new Error("publisher evaluation binding lacks its extraction identity");
                  })(),
              }
            : {
                kind: "document",
                sourceId: binding.source.sourceId,
                documentId: binding.documentId,
                versionId: binding.versionId,
                contentHash: binding.contentHash,
                ranges: selection.ranges,
              };
        return {
          sourceKey,
          locator,
          label:
            row.topology === "specialized"
              ? `Canonical evidence ${evaluationBindingGoldenSourceId(binding)}`
              : evaluationBindingGoldenSourceId(binding),
          publicProvenance: {
            sourceName:
              row.topology === "specialized"
                ? `Evaluation source ${fixture.id}`
                : "Brief canonical evaluation",
            documentTitle: `Canonical evidence ${evaluationBindingGoldenSourceId(binding)}`,
            citationUrl: `https://evaluation.invalid/documents/${binding.documentId}`,
            ...(row.topology === "specialized" ? { publishedAt: "2026-07-01T00:00:00.000Z" } : {}),
          },
          uses,
        };
      }
      if (binding.kind === "chat_message") {
        return {
          sourceKey,
          locator: { kind: "chat_message", messageId: binding.messageId },
          label: row.topology === "specialized" ? null : evaluationBindingGoldenSourceId(binding),
          publicProvenance: {},
          uses,
        };
      }
      if (binding.kind === "memory") {
        return {
          sourceKey,
          locator: {
            kind: "memory",
            memoryId: binding.memoryId,
            memoryRevisionId: binding.memoryRevisionId,
          },
          label: row.topology === "specialized" ? null : evaluationBindingGoldenSourceId(binding),
          publicProvenance: {},
          uses,
        };
      }
      return {
        sourceKey,
        locator: {
          kind: "web",
          url: binding.url,
          title: binding.title,
          domain: binding.domain,
          quote: source.content,
          quoteHash: webQuoteHash(source.content),
          publishedAt: "2026-03-14T00:00:00.000Z",
          capturedAt: binding.capturedAt,
        },
        label:
          row.topology === "specialized" ? binding.title : evaluationBindingGoldenSourceId(binding),
        publicProvenance: { citationUrl: binding.url },
        uses,
      };
    });
    const turnMap = new Map(
      manifest.turnBindings.map((binding) => [binding.turnId, binding.aiRunId]),
    );
    const goldenRelevantTurnIds =
      fixture.labels.planTurn.mode === "fanout"
        ? fixture.labels.planTurn.topics.flatMap((topic) => topic.relevantTurnIds)
        : fixture.labels.planTurn.relevantTurnIds;
    const resolution =
      fixture.labels.planTurn.mode === "clarify"
        ? { mode: "clarify" as const, question: fixture.labels.planTurn.question }
        : row.topology === "general_planner"
          ? {
              mode: "single" as const,
              question: fixture.labels.planTurn.question,
              relevantTurnIds: goldenRelevantTurnIds.map((turnId) => turnMap.get(turnId)!),
            }
          : fixture.labels.planTurn.mode === "fanout"
            ? {
                mode: "fanout" as const,
                question: fixture.labels.planTurn.question,
                topics: fixture.labels.planTurn.topics.map((topic) => ({
                  topicId: topic.topicId,
                  question: topic.question,
                  relevantTurnIds: topic.relevantTurnIds.map((turnId) => turnMap.get(turnId)!),
                })),
              }
            : {
                mode: "single" as const,
                question:
                  row.topology === "specialized" && manifest.turnBindings.length === 0
                    ? fixture.currentMessage
                    : fixture.labels.planTurn.question,
                relevantTurnIds: goldenRelevantTurnIds.map((turnId) => turnMap.get(turnId)!),
              };
    const memoryResult: MemoryExtractionResult = {
      proposals: fixture.labels.expectedMemoryProposals.map((proposal) => {
        if (proposal.targetMemoryId === null) {
          return { kind: proposal.kind, content: proposal.content };
        }
        const sourceId = `memory:${proposal.targetMemoryId}:${proposal.expectedHeadRevisionId}`;
        const binding = manifest.sourceBindings.find(
          (candidate) => evaluationBindingGoldenSourceId(candidate) === sourceId,
        );
        if (binding?.kind !== "memory") {
          throw new Error("expected memory proposal has no bound memory source");
        }
        return {
          kind: proposal.kind,
          content: proposal.content,
          targetMemoryId: binding.memoryId,
          expectedHeadRevisionId: binding.memoryRevisionId,
        };
      }),
      discardedCount: 0,
    };
    const memoryTaskId =
      row.topology === "general_planner" ? "evaluation-general-planner" : "memory-extract";
    const memoryAttempt =
      row.topology === "specialized" && tamper === "preseal_stale_memory_retry" ? 2 : 0;
    const memoryObservationKey = `${memoryTaskId}:0:${memoryAttempt}:memory_extraction_result:result`;
    const memoryArtifact: MemoryExtractionArtifact = {
      result: memoryResult,
      producer: {
        taskId: memoryTaskId,
        loopIteration: 0,
        attempt: memoryAttempt,
        observationKey: memoryObservationKey,
        extractionSha256Hex: memoryExtractionSha256Hex(memoryResult),
      },
    };
    const exactSelectedConversation =
      resolution.mode === "single"
        ? fixture.labels.relevantTurnIds.map((fixtureTurnId) => {
            const binding = manifest.turnBindings.find((item) => item.turnId === fixtureTurnId)!;
            return {
              kind: "complete" as const,
              fixtureTurnId,
              turnId: binding.aiRunId,
              userMessageId: binding.userMessageId,
              assistantMessageId: binding.assistantMessageId,
            };
          })
        : [];
    const restrictedSelectedConversation = exactSelectedConversation.map(
      ({ fixtureTurnId: _fixtureTurnId, ...binding }) => binding,
    );
    const candidateIdFor = (sourceId: string): string => {
      const binding = manifest.sourceBindings.find(
        (item) => evaluationBindingGoldenSourceId(item) === sourceId,
      )!;
      const source = fixture.evidence.find((item) => item.sourceId === sourceId)!;
      return binding.kind === "document"
        ? namespacedDocumentEvidenceIdentity(binding.source, binding.documentId)
        : binding.kind === "chat_message"
          ? chatMessageEvidenceIdentity(binding.messageId)
          : binding.kind === "memory"
            ? memoryEvidenceIdentity(binding.memoryId)
            : webEvidenceIdentity(binding.url, source.content);
    };
    const extraConversationExposure = (() => {
      if (row.topology !== "specialized") return undefined;
      let messageId: string | undefined;
      let content: string | undefined;
      if (tamper === "current_chat_preview" && fixture.id === "first-message-document-fr") {
        messageId = manifest.userMessageId;
        content = fixture.currentMessage;
      } else if (
        tamper === "selected_chat_preview" &&
        fixture.id === "follow-up-with-irrelevant-recent-turn"
      ) {
        const selected = exactSelectedConversation[0];
        const turn = fixture.conversation.find(
          (candidate) => candidate.turnId === selected?.fixtureTurnId,
        );
        messageId = selected?.userMessageId;
        content = turn?.userContent;
      } else if (
        (tamper === "nonselected_chat_inspection" || tamper === "nonselected_chat_serialized") &&
        fixture.id === "long-history-older-chat-evidence"
      ) {
        const boundMessageIds = new Set(
          manifest.sourceBindings.flatMap((binding) =>
            binding.kind === "chat_message" ? [binding.messageId] : [],
          ),
        );
        const turn = manifest.turnBindings.find(
          (candidate) =>
            !boundMessageIds.has(candidate.userMessageId) &&
            !boundMessageIds.has(candidate.assistantMessageId),
        );
        const fixtureTurn = fixture.conversation.find(
          (candidate) => candidate.turnId === turn?.turnId,
        );
        messageId = turn?.assistantMessageId;
        content = fixtureTurn?.assistantContent;
      }
      if (messageId === undefined || content === undefined) return undefined;
      return {
        sourceKind: "chat_message" as const,
        logicalSourceIdentity: chatMessageEvidenceIdentity(messageId),
        contentItemIdentity: messageId,
        exposureStage:
          tamper === "nonselected_chat_serialized"
            ? ("answer_serialized" as const)
            : ("internal_inspection" as const),
        visibleTokenCount: model.countTextTokens(content),
        content,
      };
    })();
    const productionSourcesFor = (
      sourceSelections: readonly {
        readonly sourceId: string;
        readonly ranges: readonly { readonly charStart: number; readonly charEnd: number }[];
      }[],
    ) => {
      const exact = sourceSelections.map((selection) => {
        const source = fixture.evidence.find((item) => item.sourceId === selection.sourceId)!;
        const finalSource = sourceMap[selectedIds.indexOf(selection.sourceId)]!;
        return {
          sourceId: selection.sourceId,
          sourceKey: finalSource.sourceKey,
          kind: source.kind,
          purpose:
            source.selector === "B" ? "relevant saved memory" : "canonical evaluation evidence",
          label: finalSource.label,
          ranges: selection.ranges,
        };
      });
      return {
        exact,
        restricted: exact.map(({ sourceId, ...source }) => ({
          candidateId: candidateIdFor(sourceId),
          ...source,
        })),
      };
    };
    const marginalSourceTokens = new Map<string, readonly number[]>();
    const directOrTopicLedger = (
      requestKind: "direct" | "topic",
      sourceSelections: readonly {
        readonly sourceId: string;
        readonly ranges: readonly { readonly charStart: number; readonly charEnd: number }[];
      }[],
      question: string,
      topicId?: "t1" | "t2" | "t3",
    ) => {
      const sources = productionSourcesFor(sourceSelections);
      const exactInput =
        requestKind === "topic"
          ? {
              requestKind,
              topicId: topicId!,
              question,
              selectedConversation: exactSelectedConversation,
              gaps: fixture.labels.expectedGaps.map((gap) => gap.description),
              sources: sources.exact,
              requestedOutputTokens: 16_384,
            }
          : {
              requestKind,
              question,
              selectedConversation: exactSelectedConversation,
              gaps: fixture.labels.expectedGaps.map((gap) => gap.description),
              sources: sources.exact,
              requestedOutputTokens: 16_384,
            };
      const measured = measureExactProductionContextMarginals(fixture, exactInput);
      marginalSourceTokens.set(topicId ?? "direct", measured.sourceTokenCounts);
      return {
        requestKind,
        ...(requestKind === "topic" ? { topicId: topicId! } : {}),
        modelId: "glm-5-turbo" as const,
        inputTokens: measured.inputTokens,
        requestSha256Hex: measured.requestSha256Hex,
        usableInputTokens: canonicalEvaluationUsableInputTokens(),
        requestedOutputTokens: 16_384,
        selectedConversation: restrictedSelectedConversation,
        question,
        gaps: fixture.labels.expectedGaps.map((gap) => gap.description),
        sources: sources.restricted,
      };
    };
    const directInitialLedger =
      resolution.mode === "single" && !isSpecializedFanout
        ? directOrTopicLedger("direct", fullCandidateSelections, resolution.question)
        : undefined;
    const directTerminalLedger =
      resolution.mode === "single" && !isSpecializedFanout
        ? directOrTopicLedger("direct", selected, resolution.question)
        : undefined;
    const topicDefinitions =
      fixture.labels.planTurn.mode === "fanout"
        ? fixture.labels.planTurn.topics.map(({ topicId, question }) => ({ topicId, question }))
        : [];
    const topicLedgers = isSpecializedFanout
      ? topicDefinitions.map((topic) => ({
          ...topic,
          ledger: directOrTopicLedger("topic", selected, topic.question, topic.topicId),
        }))
      : [];
    const topicPackets: ExactProductionTopicPacket[] = topicLedgers.map(
      ({ topicId, ledger }, topicIndex) => {
        const supportedClaim = fixture.labels.supportedClaims[topicIndex];
        const claimSourceKeys =
          supportedClaim?.supportingSourceIds.flatMap((sourceId) => {
            const source = sourceMap[selectedIds.indexOf(sourceId)];
            return source === undefined ? [] : [source.sourceKey];
          }) ?? [];
        const packet: ExactProductionTopicPacket =
          claimSourceKeys.length > 0
            ? {
                topicId,
                status: "answered",
                claims: [
                  {
                    text: `Canonical answer for ${topicId}.`,
                    sourceKeys: claimSourceKeys,
                  },
                ],
                gaps: [],
              }
            : {
                topicId,
                status: "partial",
                claims: [],
                gaps: [`No additional ${topicId} claim.`],
              };
        return validateTopicPacket(
          packet,
          topicId,
          ledger.sources.map((source) => source.sourceKey),
        );
      },
    );
    const synthesisLedger = isSpecializedFanout
      ? (() => {
          const exact = attestExactProductionContext(fixture, {
            requestKind: "synthesis",
            selectedConversation: exactSelectedConversation,
            packets: topicPackets,
            requestedOutputTokens: 16_384,
          });
          return {
            requestKind: "synthesis" as const,
            modelId: "glm-5-turbo" as const,
            ...exact,
            usableInputTokens: canonicalEvaluationUsableInputTokens(),
            requestedOutputTokens: 16_384,
            selectedConversation: restrictedSelectedConversation,
            packets: topicPackets.map((packet) => ({
              topicId: packet.topicId,
              status: packet.status,
              claimCount: packet.claims.length,
              gapCount: packet.gaps.length,
              packetSha256Hex: productionPacketSha256Hex(packet),
            })),
          };
        })()
      : undefined;
    if (
      row.topology === "specialized" &&
      (resolution.mode === "single" || resolution.mode === "fanout")
    ) {
      sourceMap = sourceMap.map((source, sourceIndex) => ({
        ...source,
        uses: source.uses.map((use) => ({
          ...use,
          renderedTokenCount:
            marginalSourceTokens.get(use.topicId ?? "direct")?.[sourceIndex] ?? -1,
        })),
      }));
    }
    const answerSerializedMarkersForTask = (
      taskId: string,
    ): readonly ProviderVisibleSourceExposureMarker[] => {
      const topicId = /^topic-(t[1-3])-answer$/u.exec(taskId)?.[1];
      return sourceMap.flatMap((source, sourceIndex) => {
        const use = source.uses.find(
          (candidate) => candidate.consumerTaskId === taskId && candidate.topicId === topicId,
        );
        if (use === undefined) return [];
        const sourceId = selectedIds[sourceIndex];
        if (sourceId === undefined) return [];
        const evidence = fixture.evidence.find((candidate) => candidate.sourceId === sourceId);
        if (evidence === undefined) return [];
        const binding = manifest.sourceBindings.find(
          (candidate) => evaluationBindingGoldenSourceId(candidate) === sourceId,
        );
        if (binding === undefined) return [];
        const locator = source.locator;
        const text =
          locator.kind === "document" && use.ranges.length > 0
            ? use.ranges
                .map((range) => evidence.content.slice(range.charStart, range.charEnd))
                .join("\n…\n")
            : evidence.content;
        const logicalSourceIdentity =
          locator.kind === "document"
            ? binding.kind === "document"
              ? namespacedDocumentEvidenceIdentity(binding.source, binding.documentId)
              : ""
            : locator.kind === "chat_message"
              ? chatMessageEvidenceIdentity(locator.messageId)
              : locator.kind === "memory"
                ? memoryEvidenceIdentity(locator.memoryId)
                : webEvidenceIdentity(locator.url, text);
        const contentItemIdentity =
          locator.kind === "document"
            ? `${logicalSourceIdentity}:${locator.versionId}:${sha256Base64Url(JSON.stringify(use.ranges))}`
            : locator.kind === "chat_message"
              ? locator.messageId
              : locator.kind === "memory"
                ? locator.memoryRevisionId
                : `${canonicalizeWebUrl(locator.url)}:${webQuoteHash(text)}`;
        return [
          {
            sourceKind: locator.kind,
            logicalSourceIdentity,
            contentItemIdentity,
            exposureStage: "answer_serialized" as const,
            visibleTokenCount: model.countTextTokens(text),
          },
        ];
      });
    };
    const planTurnRequest =
      row.topology === "specialized" && manifest.turnBindings.length > 0
        ? (() => {
            const exactConversation = fixture.conversation.slice(-12).map((entry) => {
              const binding = manifest.turnBindings.find((item) => item.turnId === entry.turnId)!;
              return {
                kind: "complete" as const,
                fixtureTurnId: entry.turnId,
                turnId: binding.aiRunId,
                userMessageId: binding.userMessageId,
                assistantMessageId: binding.assistantMessageId,
              };
            });
            const attestedConversation =
              resolution.mode === "clarify" && tamper === "clarification_subset"
                ? exactConversation.slice(1)
                : resolution.mode === "clarify" && tamper === "clarification_reordered"
                  ? [...exactConversation].reverse()
                  : exactConversation;
            const currentDate =
              tamper === "clarification_date_mismatch" ? "2026-07-11" : "2026-07-10";
            const exact = attestExactPlanTurnRequest(fixture, attestedConversation, currentDate);
            return {
              requestKind: "plan_turn" as const,
              modelId: "glm-5-turbo" as const,
              ...exact,
              requestedOutputTokens: 2048 as const,
              currentUserMessageId: manifest.userMessageId,
              currentDate,
              conversation: attestedConversation.map(
                ({ fixtureTurnId: _fixtureTurnId, ...binding }) => binding,
              ),
              terminalUsageCoordinate: {
                taskId: "plan-turn",
                loopIteration: 0,
                attempt: 0,
                providerRequestIndex: 0,
              },
            };
          })()
        : undefined;
    const retrievalRequestPrefixBase =
      row.topology === "specialized" &&
      (resolution.mode === "single" || resolution.mode === "fanout")
        ? (isSpecializedFanout
            ? fanoutTopicIds.map((topicId) => `topic-${topicId}`)
            : ["single"]
          ).flatMap((prefix) =>
            (["A", "B", "W"] as const)
              .filter((selector) => selectorHasProviderCall(prefix, selector))
              .map((selector) => ({
                taskId:
                  tamper === "memory_as_internal_preview" && selector === "B"
                    ? `${prefix}-retrieve-internal`
                    : tamper === "arbitrary_internal_task" && selector === "A"
                      ? "forged-retrieve-internal"
                      : tamper === "chat_as_web_preview" &&
                          selector === "A" &&
                          selectedIds.some(
                            (sourceId) =>
                              fixture.evidence.find((source) => source.sourceId === sourceId)!
                                .kind === "chat_message",
                          )
                        ? `${prefix}-retrieve-web`
                        : `${prefix}-${
                            selector === "B"
                              ? "select-memories"
                              : `retrieve-${selector === "A" ? "internal" : "web"}`
                          }`,
                agentRole:
                  selector === "A"
                    ? ("internal_retrieval" as const)
                    : selector === "B"
                      ? ("memory_selector" as const)
                      : ("web_research" as const),
                modelId: "glm-5-turbo" as const,
                inputTokens: 10,
                requestedOutputTokens: 2,
                outputTokens: 2,
                stopReason: "toolUse" as const,
                loopIteration: 0,
              })),
          )
        : [];
    const retrievalRequestPrefix = retrievalRequestPrefixBase.flatMap((request) =>
      isSpecializedOversized && request.taskId === "single-retrieve-internal"
        ? ([0, 1, 2] as const).map((providerRequestIndex) => ({
            ...request,
            providerRequestIndex,
          }))
        : [{ ...request, providerRequestIndex: 0 }],
    );
    const previewRangesFor = (
      source: (typeof fixture.evidence)[number],
    ): readonly { readonly charStart: number; readonly charEnd: number }[] =>
      source.kind === "document"
        ? [{ charStart: 0, charEnd: Math.min(300, source.content.length) }]
        : [];
    const previewMarkerFor = (sourceId: string) => {
      const source = fixture.evidence.find((candidate) => candidate.sourceId === sourceId)!;
      const binding = manifest.sourceBindings.find(
        (candidate) => evaluationBindingGoldenSourceId(candidate) === sourceId,
      )!;
      const exposureStage =
        source.selector === "A"
          ? source.kind === "chat_message"
            ? "internal_inspection"
            : "internal_search_preview"
          : source.selector === "B"
            ? "memory_tool_result"
            : "web_search_preview";
      return {
        sourceKind: source.kind,
        logicalSourceIdentity:
          binding.kind === "web" ? canonicalizeWebUrl(binding.url) : candidateIdFor(sourceId),
        contentItemIdentity:
          binding.kind === "document"
            ? `${candidateIdFor(sourceId)}:${binding.versionId}:${sha256Base64Url(JSON.stringify(previewRangesFor(source)))}`
            : binding.kind === "chat_message"
              ? binding.messageId
              : binding.kind === "memory"
                ? binding.memoryRevisionId
                : `${canonicalizeWebUrl(binding.url)}:${sha256Base64Url(source.content.slice(0, 300))}`,
        exposureStage,
        visibleTokenCount: model.countTextTokens(
          exposureStage === "internal_search_preview" || exposureStage === "web_search_preview"
            ? source.content.slice(0, 300)
            : source.content,
        ),
      } as const;
    };
    const inspectionMarkerFor = (
      sourceId: string,
      ranges: readonly { readonly charStart: number; readonly charEnd: number }[],
    ) => {
      const source = fixture.evidence.find((candidate) => candidate.sourceId === sourceId)!;
      const binding = manifest.sourceBindings.find(
        (candidate) => evaluationBindingGoldenSourceId(candidate) === sourceId,
      )!;
      if (source.kind !== "document" || binding.kind !== "document") {
        throw new Error("internal inspection marker requires a document binding");
      }
      const text = ranges
        .map((range) => source.content.slice(range.charStart, range.charEnd))
        .join("\n…\n");
      return {
        sourceKind: "document" as const,
        logicalSourceIdentity: namespacedDocumentEvidenceIdentity(
          binding.source,
          binding.documentId,
        ),
        contentItemIdentity: `${namespacedDocumentEvidenceIdentity(binding.source, binding.documentId)}:${binding.versionId}:${sha256Base64Url(JSON.stringify(ranges))}`,
        exposureStage: "internal_inspection" as const,
        visibleTokenCount: model.countTextTokens(text),
        documentReconstruction: {
          sourceId: binding.sourceId,
          documentId: binding.documentId,
          versionId: binding.versionId,
          contentHash: binding.contentHash,
          ranges,
        },
      };
    };
    const oversizedDocumentSourceIds = isSpecializedOversized
      ? selectedIds.filter((sourceId) => {
          const source = fixture.evidence.find((candidate) => candidate.sourceId === sourceId)!;
          return source.selector === "A" && source.kind === "document";
        })
      : [];
    const canonicalOversizedInspectionMarkers = oversizedDocumentSourceIds.map((sourceId) => {
      return inspectionMarkerFor(sourceId, [{ charStart: 0, charEnd: 2_048 }]);
    });
    const oversizedInspectionMarkers = (() => {
      if (tamper === "oversized_missing_internal_inspection") {
        return canonicalOversizedInspectionMarkers.slice(0, 5);
      }
      if (tamper === "oversized_duplicate_internal_inspection") {
        const duplicateSourceId = oversizedDocumentSourceIds[0];
        if (duplicateSourceId === undefined) return canonicalOversizedInspectionMarkers;
        const duplicateRanges = fixture.labels.acceptableRanges[duplicateSourceId];
        if (duplicateRanges === undefined) throw new Error("duplicate inspection range is missing");
        return [
          ...canonicalOversizedInspectionMarkers,
          inspectionMarkerFor(duplicateSourceId, duplicateRanges),
        ];
      }
      return canonicalOversizedInspectionMarkers;
    })();
    const reductionMarkerFor = (sourceId: string) => {
      const source = fixture.evidence.find((candidate) => candidate.sourceId === sourceId)!;
      const binding = manifest.sourceBindings.find(
        (candidate) => evaluationBindingGoldenSourceId(candidate) === sourceId,
      )!;
      return {
        sourceKind: source.kind,
        logicalSourceIdentity: candidateIdFor(sourceId),
        contentItemIdentity:
          binding.kind === "document"
            ? `${candidateIdFor(sourceId)}:${binding.versionId}:${sha256Base64Url(JSON.stringify(source.ranges))}`
            : binding.kind === "chat_message"
              ? binding.messageId
              : binding.kind === "memory"
                ? binding.memoryRevisionId
                : `${canonicalizeWebUrl(binding.url)}:${webQuoteHash(source.content)}`,
        exposureStage: "context_candidate_inspection",
        visibleTokenCount: model.countTextTokens(source.content),
        ...(binding.kind === "document"
          ? {
              documentReconstruction: {
                sourceId: binding.sourceId,
                documentId: binding.documentId,
                versionId: binding.versionId,
                contentHash: binding.contentHash,
                ranges: source.ranges,
              },
            }
          : {}),
      } as const;
    };
    const exposedPreviewMarkerFor = (sourceId: string) => {
      const marker = previewMarkerFor(sourceId);
      const source = fixture.evidence.find((candidate) => candidate.sourceId === sourceId)!;
      if (tamper === "memory_as_internal_preview" && source.kind === "memory") {
        return { ...marker, exposureStage: "internal_search_preview" as const };
      }
      if (tamper === "chat_as_web_preview" && source.kind === "chat_message") {
        return { ...marker, exposureStage: "web_search_preview" as const };
      }
      return marker;
    };
    const webFetchMarkerFor = (sourceId: string) => {
      const source = fixture.evidence.find((candidate) => candidate.sourceId === sourceId)!;
      const binding = manifest.sourceBindings.find(
        (candidate) => evaluationBindingGoldenSourceId(candidate) === sourceId,
      );
      if (source.kind !== "web" || binding?.kind !== "web") {
        throw new Error("web fetch marker requires a web binding");
      }
      const url = canonicalizeWebUrl(binding.url);
      return {
        sourceKind: "web" as const,
        logicalSourceIdentity: url,
        contentItemIdentity: `${url}:${sha256Base64Url(source.content)}`,
        exposureStage: "web_fetch" as const,
        visibleTokenCount: model.countTextTokens(source.content),
      };
    };
    const exposedReductionMarkerFor = (sourceId: string) => {
      const marker = reductionMarkerFor(sourceId);
      const source = fixture.evidence.find((candidate) => candidate.sourceId === sourceId)!;
      if (tamper !== "wrong_kind_o" || source.kind !== "memory") return marker;
      const documentSource = fixture.evidence.find((candidate) => candidate.kind === "document");
      const documentBinding = manifest.sourceBindings.find(
        (
          candidate,
        ): candidate is Extract<
          EvaluationSeedManifest["sourceBindings"][number],
          { kind: "document" }
        > =>
          candidate.kind === "document" &&
          evaluationBindingGoldenSourceId(candidate) === documentSource?.sourceId,
      );
      if (documentSource === undefined || documentBinding === undefined) {
        throw new Error("wrong-kind O tamper lacks a canonical document binding");
      }
      return {
        ...marker,
        sourceKind: "document" as const,
        documentReconstruction: {
          sourceId: documentBinding.sourceId,
          documentId: documentBinding.documentId,
          versionId: documentBinding.versionId,
          contentHash: documentBinding.contentHash,
          ranges: documentSource.ranges,
        },
      };
    };
    const sourceMarkersForRequest = (
      taskId: string,
      providerRequestIndex: number,
    ): readonly ProviderVisibleSourceExposureMarker[] => {
      const previewMarkers = selectedIds
        .filter((sourceId) => {
          const source = fixture.evidence.find((candidate) => candidate.sourceId === sourceId)!;
          return (
            source.selector === "A" ||
            (tamper === "memory_as_internal_preview" && source.kind === "memory")
          );
        })
        .map(exposedPreviewMarkerFor);
      const markers = taskId.endsWith("retrieve-internal")
        ? isSpecializedOversized && taskId === "single-retrieve-internal"
          ? tamper === "oversized_wrong_coordinate_internal_inspection"
            ? providerRequestIndex === 1
              ? [...previewMarkers, canonicalOversizedInspectionMarkers[0]!]
              : providerRequestIndex === 2
                ? [...previewMarkers, ...canonicalOversizedInspectionMarkers.slice(1)]
                : []
            : providerRequestIndex === 1
              ? previewMarkers
              : providerRequestIndex === 2
                ? [...previewMarkers, ...oversizedInspectionMarkers]
                : []
          : previewMarkers
        : taskId === "single-reduce-plan"
          ? selectedIds.map(exposedReductionMarkerFor)
          : taskId.endsWith("select-memories")
            ? selectedIds
                .filter(
                  (sourceId) =>
                    fixture.evidence.find((candidate) => candidate.sourceId === sourceId)
                      ?.selector === "B",
                )
                .map(exposedPreviewMarkerFor)
            : taskId.endsWith("retrieve-web")
              ? [
                  ...selectedIds
                    .filter(
                      (sourceId) =>
                        fixture.evidence.find((candidate) => candidate.sourceId === sourceId)
                          ?.selector === "W",
                    )
                    .map(exposedPreviewMarkerFor),
                  ...selectedIds
                    .filter(
                      (sourceId) =>
                        fixture.evidence.find((candidate) => candidate.sourceId === sourceId)
                          ?.selector === "W",
                    )
                    .map(webFetchMarkerFor),
                ]
              : [];
      const requestMarkers =
        extraConversationExposure !== undefined &&
        extraConversationExposure.exposureStage !== "answer_serialized" &&
        taskId === "single-retrieve-internal" &&
        providerRequestIndex === 0
          ? [...markers, extraConversationExposure]
          : markers;
      return requestMarkers.map((marker) => ({
        sourceKind: marker.sourceKind,
        logicalSourceIdentity: marker.logicalSourceIdentity,
        contentItemIdentity: marker.contentItemIdentity,
        exposureStage: marker.exposureStage,
        visibleTokenCount: marker.visibleTokenCount,
      }));
    };
    const markerDetailsFor = (
      marker: ProviderVisibleSourceExposureMarker,
    ):
      | {
          readonly sourceId?: string;
          readonly source: (typeof fixture.evidence)[number];
          readonly binding: EvaluationSeedManifest["sourceBindings"][number];
          readonly text: string;
          readonly ranges?: readonly { readonly charStart: number; readonly charEnd: number }[];
        }
      | undefined => {
      for (const sourceId of selectedIds) {
        const source = fixture.evidence.find((candidate) => candidate.sourceId === sourceId);
        const binding = manifest.sourceBindings.find(
          (candidate) => evaluationBindingGoldenSourceId(candidate) === sourceId,
        );
        if (source === undefined || binding === undefined) continue;
        const variants: readonly {
          readonly marker: ProviderVisibleSourceExposureMarker;
          readonly text: string;
          readonly ranges?: readonly { readonly charStart: number; readonly charEnd: number }[];
        }[] = [
          (() => {
            const candidate =
              tamper === "memory_as_internal_preview" && source.kind === "memory"
                ? exposedPreviewMarkerFor(sourceId)
                : previewMarkerFor(sourceId);
            return {
              marker: {
                sourceKind: candidate.sourceKind,
                logicalSourceIdentity: candidate.logicalSourceIdentity,
                contentItemIdentity: candidate.contentItemIdentity,
                exposureStage: candidate.exposureStage,
                visibleTokenCount: candidate.visibleTokenCount,
              },
              text:
                candidate.exposureStage === "internal_search_preview" ||
                candidate.exposureStage === "web_search_preview"
                  ? source.content.slice(0, 300)
                  : source.content,
              ...(source.kind === "document" ? { ranges: previewRangesFor(source) } : {}),
            };
          })(),
          ...(source.kind === "web" && binding.kind === "web"
            ? [
                (() => {
                  const candidate = webFetchMarkerFor(sourceId);
                  return {
                    marker: {
                      sourceKind: candidate.sourceKind,
                      logicalSourceIdentity: candidate.logicalSourceIdentity,
                      contentItemIdentity: candidate.contentItemIdentity,
                      exposureStage: candidate.exposureStage,
                      visibleTokenCount: candidate.visibleTokenCount,
                    },
                    text: source.content,
                  };
                })(),
              ]
            : []),
          ...(isSpecializedOversized && source.kind === "document"
            ? canonicalOversizedInspectionMarkers
                .map((candidate, index) => ({
                  candidate,
                  sourceId: oversizedDocumentSourceIds[index],
                }))
                .filter((candidate) => candidate.sourceId === sourceId)
                .map(({ candidate }) => ({
                  marker: {
                    sourceKind: candidate.sourceKind,
                    logicalSourceIdentity: candidate.logicalSourceIdentity,
                    contentItemIdentity: candidate.contentItemIdentity,
                    exposureStage: candidate.exposureStage,
                    visibleTokenCount: candidate.visibleTokenCount,
                  },
                  text: source.content.slice(0, 2_048),
                  ranges: [{ charStart: 0, charEnd: 2_048 }],
                }))
            : []),
          ...(tamper === "oversized_duplicate_internal_inspection" &&
          source.kind === "document" &&
          sourceId === oversizedDocumentSourceIds[0]
            ? [
                (() => {
                  const ranges = fixture.labels.acceptableRanges[sourceId];
                  if (ranges === undefined)
                    throw new Error("duplicate inspection range is missing");
                  const candidate = inspectionMarkerFor(sourceId, ranges);
                  return {
                    marker: {
                      sourceKind: candidate.sourceKind,
                      logicalSourceIdentity: candidate.logicalSourceIdentity,
                      contentItemIdentity: candidate.contentItemIdentity,
                      exposureStage: candidate.exposureStage,
                      visibleTokenCount: candidate.visibleTokenCount,
                    },
                    text: ranges
                      .map((range) => source.content.slice(range.charStart, range.charEnd))
                      .join("\n…\n"),
                    ranges,
                  };
                })(),
              ]
            : []),
          ...(source.kind === "document" || source.kind === "memory"
            ? [
                (() => {
                  const candidate = isSpecializedOversized
                    ? exposedReductionMarkerFor(sourceId)
                    : reductionMarkerFor(sourceId);
                  return {
                    marker: {
                      sourceKind: candidate.sourceKind,
                      logicalSourceIdentity: candidate.logicalSourceIdentity,
                      contentItemIdentity: candidate.contentItemIdentity,
                      exposureStage: candidate.exposureStage,
                      visibleTokenCount: candidate.visibleTokenCount,
                    },
                    text: source.content,
                    ranges: source.ranges,
                  };
                })(),
              ]
            : []),
        ];
        if (marker.exposureStage === "answer_serialized") {
          const answerSource = sourceMap[selectedIds.indexOf(sourceId)];
          const answerUse = answerSource?.uses.find((use) => {
            const taskIds = new Set([
              "single-answer",
              "fanout-synthesis",
              "topic-t1-answer",
              "topic-t2-answer",
              "topic-t3-answer",
            ]);
            return taskIds.has(use.consumerTaskId);
          });
          const answerText =
            source.kind === "document" && answerUse !== undefined && answerUse.ranges.length > 0
              ? answerUse.ranges
                  .map((range) => source.content.slice(range.charStart, range.charEnd))
                  .join("\n…\n")
              : source.content;
          const answerMarkerMatch =
            answerUse !== undefined && answerSource !== undefined
              ? (() => {
                  const locator = answerSource.locator;
                  const logicalSourceIdentity =
                    locator.kind === "document"
                      ? binding.kind === "document"
                        ? namespacedDocumentEvidenceIdentity(binding.source, binding.documentId)
                        : ""
                      : locator.kind === "chat_message"
                        ? chatMessageEvidenceIdentity(locator.messageId)
                        : locator.kind === "memory"
                          ? memoryEvidenceIdentity(locator.memoryId)
                          : webEvidenceIdentity(locator.url, answerText);
                  const contentItemIdentity =
                    locator.kind === "document"
                      ? `${logicalSourceIdentity}:${locator.versionId}:${sha256Base64Url(JSON.stringify(answerUse.ranges))}`
                      : locator.kind === "chat_message"
                        ? locator.messageId
                        : locator.kind === "memory"
                          ? locator.memoryRevisionId
                          : `${canonicalizeWebUrl(locator.url)}:${webQuoteHash(answerText)}`;
                  return (
                    canonicalJson({
                      sourceKind: locator.kind,
                      logicalSourceIdentity,
                      contentItemIdentity,
                      exposureStage: "answer_serialized",
                      visibleTokenCount: model.countTextTokens(answerText),
                    }) === canonicalJson(marker)
                  );
                })()
              : false;
          if (answerMarkerMatch && answerUse !== undefined) {
            if (marker.visibleTokenCount === model.countTextTokens(answerText)) {
              return {
                sourceId,
                source,
                binding,
                text: answerText,
                ranges: answerUse.ranges,
              };
            }
          }
        }
        const match = variants.find(
          ({ marker: candidate }) => canonicalJson(candidate) === canonicalJson(marker),
        );
        if (match !== undefined) return { sourceId, source, binding, ...match };
      }
      if (extraConversationExposure !== undefined) {
        const candidate = extraConversationExposure;
        const candidateMarker = {
          sourceKind: candidate.sourceKind,
          logicalSourceIdentity: candidate.logicalSourceIdentity,
          contentItemIdentity: candidate.contentItemIdentity,
          exposureStage: candidate.exposureStage,
          visibleTokenCount: candidate.visibleTokenCount,
        };
        if (canonicalJson(candidateMarker) === canonicalJson(marker)) {
          const source = fixture.evidence.find(
            (entry) =>
              entry.kind === "chat_message" &&
              (candidate.contentItemIdentity === entry.sourceId ||
                candidate.contentItemIdentity === entry.sourceId.slice("chat:".length)),
          );
          const binding = manifest.sourceBindings.find(
            (entry) =>
              entry.kind === "chat_message" && candidate.contentItemIdentity === entry.messageId,
          );
          return {
            sourceId: source?.sourceId ?? candidate.contentItemIdentity,
            source:
              source ??
              ({
                sourceId: candidate.contentItemIdentity,
                selector: "A",
                kind: "chat_message",
                content: candidate.content,
                ranges: [],
              } as (typeof fixture.evidence)[number]),
            binding:
              binding ??
              ({ kind: "chat_message", messageId: candidate.contentItemIdentity } as Extract<
                EvaluationSeedManifest["sourceBindings"][number],
                { kind: "chat_message" }
              >),
            text: candidate.content,
          };
        }
      }
      return undefined;
    };
    const providerSidecarForMarkers = (
      markers: readonly ProviderVisibleSourceExposureMarker[],
    ): {
      readonly requestSha256Hex: string;
      readonly proofs: readonly string[];
      readonly bindings: readonly ProviderRequestSourceExposureProofBinding[];
    } => {
      const messages: Array<ProviderRequest["messages"][number]> = [
        { role: "system", content: "Evaluation provider sidecar request." },
        { role: "user", content: "The supplied evidence is canonical." },
      ];
      for (const [index, marker] of markers.entries()) {
        const details = markerDetailsFor(marker);
        if (details === undefined) {
          throw new Error("provider sidecar marker lacks canonical fixture content");
        }
        const callId = `fixture-sidecar-${index + 1}`;
        let name: string;
        let arguments_: Record<string, unknown>;
        let result: Record<string, unknown>;
        if (marker.exposureStage === "internal_search_preview") {
          name = "search_internal";
          arguments_ = {
            query: { target: "documents", terms: "canonical", purpose: "evaluation", limit: 1 },
          };
          result =
            details.source.kind === "document"
              ? {
                  items: [
                    {
                      kind: "document",
                      documentId:
                        details.binding.kind === "document" ? details.binding.documentId : "",
                      snippet: details.text,
                      ranges: details.ranges,
                      ...(details.binding.kind === "document"
                        ? {
                            __briefSourceIdentity: {
                              versionId: details.binding.versionId,
                              contentHash: details.binding.contentHash,
                              ranges: details.ranges,
                              ...(details.binding.publisherExtractionId === null
                                ? {}
                                : { publisherExtractionId: details.binding.publisherExtractionId }),
                              source: details.binding.source,
                            },
                          }
                        : {}),
                    },
                  ],
                }
              : {
                  items: [
                    {
                      messageId:
                        details.binding.kind === "chat_message" ? details.binding.messageId : "",
                      snippet: details.text,
                    },
                  ],
                };
        } else if (marker.exposureStage === "internal_inspection") {
          name = "inspect_internal";
          arguments_ =
            details.source.kind === "document"
              ? {
                  reference: {
                    kind: "document",
                    documentId:
                      details.binding.kind === "document" ? details.binding.documentId : "",
                    range: details.ranges?.[0],
                  },
                }
              : {
                  reference: {
                    kind: "chat_message",
                    messageId:
                      details.binding.kind === "chat_message" ? details.binding.messageId : "",
                  },
                };
          result =
            details.source.kind === "document"
              ? {
                  found: true,
                  complete: true,
                  ranges: details.ranges,
                  text: details.text,
                  documentId: details.binding.kind === "document" ? details.binding.documentId : "",
                  ...(details.binding.kind === "document"
                    ? {
                        __briefSourceIdentity: {
                          versionId: details.binding.versionId,
                          contentHash: details.binding.contentHash,
                          ...(details.binding.publisherExtractionId === null
                            ? {}
                            : { publisherExtractionId: details.binding.publisherExtractionId }),
                          source: details.binding.source,
                        },
                      }
                    : {}),
                }
              : {
                  found: true,
                  complete: true,
                  message: {
                    messageId:
                      details.binding.kind === "chat_message" ? details.binding.messageId : "",
                    content: details.text,
                  },
                };
        } else if (marker.exposureStage === "memory_tool_result") {
          name = "search_memories";
          arguments_ = { query: "canonical" };
          result = {
            items: [
              {
                memoryId: details.binding.kind === "memory" ? details.binding.memoryId : "",
                memoryRevisionId:
                  details.binding.kind === "memory" ? details.binding.memoryRevisionId : "",
                content: details.text,
              },
            ],
          };
        } else if (marker.exposureStage === "web_search_preview") {
          name = "web_search";
          arguments_ = { query: "canonical" };
          result = {
            results: [
              {
                url:
                  details.binding.kind === "web"
                    ? details.binding.url
                    : "https://evaluation.invalid",
                snippet: details.text,
              },
            ],
          };
        } else if (marker.exposureStage === "web_fetch") {
          name = "web_fetch";
          arguments_ = {
            url:
              details.binding.kind === "web" ? details.binding.url : "https://evaluation.invalid",
          };
          result = {
            url:
              details.binding.kind === "web" ? details.binding.url : "https://evaluation.invalid",
            text: details.text,
          };
        } else if (marker.exposureStage === "context_candidate_inspection") {
          name = "inspect_candidate";
          const candidateId = marker.logicalSourceIdentity;
          arguments_ = {
            id: candidateId,
            ...(details.ranges?.[0] === undefined ? {} : { range: details.ranges[0] }),
          };
          result =
            details.source.kind === "document"
              ? {
                  found: true,
                  complete: true,
                  text: details.text,
                  documentId: details.binding.kind === "document" ? details.binding.documentId : "",
                  versionId: details.binding.kind === "document" ? details.binding.versionId : "",
                  source: details.binding.kind === "document" ? details.binding.source : {},
                  ranges: details.ranges,
                  ...(details.binding.kind === "document"
                    ? {
                        __briefSourceIdentity: {
                          versionId: details.binding.versionId,
                          contentHash: details.binding.contentHash,
                          ...(details.binding.publisherExtractionId === null
                            ? {}
                            : { publisherExtractionId: details.binding.publisherExtractionId }),
                          source: details.binding.source,
                        },
                      }
                    : {}),
                }
              : details.source.kind === "memory"
                ? {
                    found: true,
                    complete: true,
                    text: details.text,
                    memoryId: details.binding.kind === "memory" ? details.binding.memoryId : "",
                    memoryRevisionId:
                      details.binding.kind === "memory" ? details.binding.memoryRevisionId : "",
                  }
                : { found: true, complete: true, text: details.text };
        } else {
          throw new Error(`provider sidecar does not support ${marker.exposureStage}`);
        }
        messages.push(
          {
            role: "assistant",
            content: "",
            toolCalls: [{ id: callId, name, arguments: arguments_ }],
          },
          { role: "tool", toolCallId: callId, name, content: JSON.stringify(result) },
        );
      }
      const request = {
        requestClass: "main" as const,
        model: "glm-5-turbo",
        messages,
        requestedOutputTokens: 2,
        reasoning: "medium" as const,
        sourceExposureProofs: markers,
      };
      const bindings = providerRequestSourceExposureProofBindings(request, (text) =>
        model.countTextTokens(text),
      );
      return {
        requestSha256Hex: providerRequestSha256Hex(request),
        proofs: bindings
          .map(({ providerSerializationProofSha256Hex }) => providerSerializationProofSha256Hex)
          .sort(),
        bindings,
      };
    };
    const conversationProviderMarkers = (): readonly ProviderVisibleSourceExposureMarker[] => {
      const markers: ProviderVisibleSourceExposureMarker[] = [
        {
          sourceKind: "chat_message",
          logicalSourceIdentity: chatMessageEvidenceIdentity(manifest.userMessageId),
          contentItemIdentity: manifest.userMessageId,
          exposureStage: "provider_input",
          visibleTokenCount: model.countTextTokens(fixture.currentMessage),
        },
      ];
      const firstTurn = manifest.turnBindings[0];
      const firstGoldenTurn = fixture.conversation[0];
      if (firstTurn !== undefined && firstGoldenTurn !== undefined) {
        markers.push({
          sourceKind: "chat_message",
          logicalSourceIdentity: chatMessageEvidenceIdentity(firstTurn.assistantMessageId),
          contentItemIdentity: firstTurn.assistantMessageId,
          exposureStage: "provider_input",
          visibleTokenCount: model.countTextTokens(firstGoldenTurn.assistantContent),
        });
      }
      return markers;
    };
    const conversationTextForMarker = (marker: ProviderVisibleSourceExposureMarker): string => {
      if (marker.contentItemIdentity === manifest.userMessageId) return fixture.currentMessage;
      if (
        extraConversationExposure !== undefined &&
        marker.contentItemIdentity === extraConversationExposure.contentItemIdentity &&
        marker.logicalSourceIdentity === extraConversationExposure.logicalSourceIdentity &&
        marker.exposureStage === extraConversationExposure.exposureStage
      ) {
        return extraConversationExposure.content;
      }
      const turn = manifest.turnBindings.find(
        (candidate) => candidate.assistantMessageId === marker.contentItemIdentity,
      );
      const fixtureTurn = fixture.conversation.find(
        (candidate) => candidate.turnId === turn?.turnId,
      );
      if (fixtureTurn === undefined) throw new Error("conversation sidecar lacks fixture content");
      return fixtureTurn.assistantContent;
    };
    const providerSidecarForCodeOwnedMarkers = (
      markers: readonly ProviderVisibleSourceExposureMarker[],
    ): {
      readonly requestSha256Hex: string;
      readonly proofs: readonly string[];
      readonly bindings: readonly ProviderRequestSourceExposureProofBinding[];
    } => {
      const entries = markers
        .filter(
          (marker) =>
            marker.exposureStage === "provider_input" &&
            marker.contentItemIdentity !== manifest.userMessageId,
        )
        .map((marker) => ({
          assistantMessageId: marker.contentItemIdentity,
          assistantContent: conversationTextForMarker(marker),
        }));
      const answerMarkers = markers.filter(
        (marker) => marker.exposureStage === "answer_serialized",
      );
      const evidence = answerMarkers
        .map((marker) => {
          const details = markerDetailsFor(marker);
          const sourceIndex =
            details?.sourceId === undefined ? -1 : selectedIds.indexOf(details.sourceId);
          const sourceKey =
            sourceMap[sourceIndex]?.sourceKey ??
            sourceKeyForNamespace(citationNamespace, sourceMap.length + 1);
          const text =
            marker.sourceKind === "chat_message"
              ? conversationTextForMarker(marker)
              : (details?.text ?? "");
          return `<source key="${sourceKey}" kind="${marker.sourceKind}" length="${text.length}">\n${text}\n</source>`;
        })
        .join("\n\n");
      const proofInputs = markers.map((marker) => ({
        ...marker,
        visibleText:
          marker.exposureStage === "provider_input"
            ? conversationTextForMarker(marker)
            : marker.sourceKind === "chat_message"
              ? conversationTextForMarker(marker)
              : (markerDetailsFor(marker)?.text ?? ""),
      }));
      const request: ProviderRequest = {
        requestClass: "main",
        model: "glm-5-turbo",
        messages: [
          { role: "system", content: "Evaluation provider sidecar request." },
          {
            role: "user",
            content: JSON.stringify({
              originalMessage: fixture.currentMessage,
              entries,
              evidence,
            }),
          },
        ],
        requestedOutputTokens: 2,
        reasoning: "medium",
        sourceExposureProofs: proofInputs,
      };
      const bindings = providerRequestSourceExposureProofBindings(request, (text) =>
        model.countTextTokens(text),
      );
      return {
        requestSha256Hex: providerRequestSha256Hex(request),
        proofs: bindings
          .map(({ providerSerializationProofSha256Hex }) => providerSerializationProofSha256Hex)
          .sort(),
        bindings,
      };
    };
    const providerSidecarForGeneralPlanner = (
      markers: readonly ProviderVisibleSourceExposureMarker[],
    ): {
      readonly requestSha256Hex: string;
      readonly proofs: readonly string[];
      readonly bindings: readonly ProviderRequestSourceExposureProofBinding[];
    } => {
      const visibleBindings: ProviderVisibleSourceExposureProofBinding[] = markers.map(
        (marker, index) => ({
          messageIndex: 2,
          sourceOrdinal: index,
          serializedField: `messages[2].content.matches[${index}].text`,
          orderedSourceDescriptor: canonicalJson({
            sourceOrdinal: index,
            messageIndex: 2,
            serializedField: `messages[2].content.matches[${index}].text`,
            sourceKind: marker.sourceKind,
            exposureStage: marker.exposureStage,
            logicalSourceIdentity: marker.logicalSourceIdentity,
            contentItemIdentity: marker.contentItemIdentity,
            visibleTokenCount: marker.visibleTokenCount,
          }),
        }),
      );
      const bindings: ProviderRequestSourceExposureProofBinding[] = visibleBindings.map(
        (binding, index) => {
          const marker = markers[index]!;
          return {
            providerSerializationProofSha256Hex: providerVisibleSourceExposureProofSha256Hex(
              marker,
              binding,
            ),
            marker,
            binding,
          };
        },
      );
      const request: ProviderRequest = {
        requestClass: "main",
        model: "glm-5-turbo",
        messages: [
          { role: "system", content: "Evaluation general planner provider request." },
          {
            role: "user",
            content: JSON.stringify({
              requestText: fixture.currentMessage,
              evidenceCatalog: selectedIds,
              matches: markers.map((marker) => marker.contentItemIdentity),
            }),
          },
        ],
        requestedOutputTokens: 16_384,
        reasoning: "medium",
      };
      return {
        requestSha256Hex: providerRequestSha256Hex(request),
        proofs: bindings
          .map(({ providerSerializationProofSha256Hex }) => providerSerializationProofSha256Hex)
          .sort(),
        bindings,
      };
    };
    const providerEvidenceForRequest = (
      taskId: string,
      providerRequestIndex: number,
    ): {
      readonly requestSha256Hex: string;
      readonly proofs: readonly string[];
      readonly bindings: readonly ProviderRequestSourceExposureProofBinding[];
    } => {
      const markers = sourceMarkersForRequest(taskId, providerRequestIndex);
      if (taskId === "evaluation-general-planner") {
        const generalMarkers = selectedIds.map((sourceId) => {
          const source = fixture.evidence.find((candidate) => candidate.sourceId === sourceId)!;
          const binding = manifest.sourceBindings.find(
            (candidate) => evaluationBindingGoldenSourceId(candidate) === sourceId,
          )!;
          const logicalSourceIdentity =
            binding.kind === "document"
              ? namespacedDocumentEvidenceIdentity(binding.source, binding.documentId)
              : sourceId;
          return {
            sourceKind: source.kind,
            logicalSourceIdentity,
            contentItemIdentity:
              binding.kind === "document"
                ? `${logicalSourceIdentity}:${binding.versionId}:${sha256Base64Url(JSON.stringify(source.ranges.map(({ charStart, charEnd }) => ({ charStart, charEnd }))))}`
                : `${logicalSourceIdentity}:0:${source.content.length}:${createHash("sha256").update(source.content).digest("hex")}`,
            exposureStage: "evaluation_general_planner_inspect",
            visibleTokenCount: model.countTextTokens(source.content),
          } satisfies ProviderVisibleSourceExposureMarker;
        });
        const sidecar = providerSidecarForGeneralPlanner(generalMarkers);
        return {
          requestSha256Hex: sidecar.requestSha256Hex,
          proofs: sidecar.proofs,
          bindings: sidecar.bindings,
        };
      }
      const codeOwnedMarkers =
        taskId === "plan-turn" ||
        taskId === "single-answer" ||
        (row.topology === "specialized" && /^topic-t[1-3]-answer$/u.test(taskId)) ||
        (row.topology === "specialized" && taskId === "fanout-synthesis")
          ? conversationProviderMarkers()
          : [];
      const answerMarkers =
        taskId === "single-answer" ||
        (row.topology === "specialized" && /^topic-t[1-3]-answer$/u.test(taskId)) ||
        (row.topology === "specialized" && taskId === "fanout-synthesis")
          ? answerSerializedMarkersForTask(taskId)
          : [];
      const allMarkers = [...codeOwnedMarkers, ...markers, ...answerMarkers];
      if (allMarkers.length === 0) {
        const request: ProviderRequest = {
          requestClass:
            taskId === "single-answer" ||
            (row.topology === "specialized" && /^topic-t[1-3]-answer$/u.test(taskId)) ||
            (row.topology === "specialized" && taskId === "fanout-synthesis")
              ? "main"
              : "fast",
          model: "glm-5-turbo",
          messages: [
            { role: "system", content: "Evaluation provider request." },
            { role: "user", content: JSON.stringify({ taskId, providerRequestIndex }) },
          ],
          requestedOutputTokens: 2,
          reasoning: "medium",
          sourceExposureProofs: [],
        };
        return { requestSha256Hex: providerRequestSha256Hex(request), proofs: [], bindings: [] };
      }
      const codeOwned = codeOwnedMarkers.length > 0;
      const sidecar = codeOwned
        ? providerSidecarForCodeOwnedMarkers(allMarkers)
        : providerSidecarForMarkers(allMarkers);
      const topicId = /^topic-(t[1-3])-answer$/u.exec(taskId)?.[1];
      const productionRequestSha256Hex =
        taskId === "plan-turn" && planTurnRequest !== undefined
          ? planTurnRequest.requestSha256Hex
          : taskId === "single-answer" && directTerminalLedger !== undefined
            ? directTerminalLedger.requestSha256Hex
            : topicId !== undefined
              ? topicLedgers.find((topic) => topic.topicId === topicId)?.ledger.requestSha256Hex
              : taskId === "fanout-synthesis" && synthesisLedger !== undefined
                ? synthesisLedger.requestSha256Hex
                : undefined;
      return {
        requestSha256Hex: productionRequestSha256Hex ?? sidecar.requestSha256Hex,
        proofs: sidecar.proofs,
        bindings: sidecar.bindings,
      };
    };
    const specializedMemoryRequest = {
      taskId: "memory-extract",
      agentRole: "memory_extractor" as const,
      modelId: "glm-5-turbo" as const,
      inputTokens: 10,
      requestedOutputTokens: 2,
      outputTokens: 2,
      stopReason: "stop" as const,
      loopIteration: 0,
    };
    const specializedPlanRequest = {
      taskId: "plan-turn",
      agentRole: "plan_turn" as const,
      modelId: "glm-5-turbo" as const,
      inputTokens: 10,
      requestedOutputTokens: 2,
      outputTokens: 2,
      stopReason: "stop" as const,
      loopIteration: 0,
    };
    const specializedResolverRequests =
      planTurnRequest === undefined
        ? []
        : [
            {
              taskId: "plan-turn",
              agentRole: "plan_turn" as const,
              modelId: "glm-5-turbo" as const,
              inputTokens: planTurnRequest.inputTokens,
              requestedOutputTokens: 2048,
              outputTokens: 2,
              stopReason: "stop" as const,
              loopIteration: 0,
            },
          ];
    const providerRequests: Array<{
      readonly taskId: string;
      readonly agentRole: AiRunUsageInput["agentRole"];
      readonly modelId: "glm-5-turbo" | "glm-5-turbo";
      readonly inputTokens: number;
      readonly requestedOutputTokens: number;
      readonly outputTokens: number;
      readonly stopReason: "stop" | "toolUse";
      readonly loopIteration: number;
      readonly providerRequestIndex?: number;
    }> =
      row.topology === "general_planner"
        ? [
            {
              taskId: "evaluation-general-planner",
              agentRole: "evaluation_general_planner",
              modelId: "glm-5-turbo",
              inputTokens: 10,
              requestedOutputTokens: 2,
              outputTokens: 2,
              stopReason: "stop",
              loopIteration: 0,
            },
          ]
        : resolution.mode === "clarify"
          ? [...specializedResolverRequests, specializedMemoryRequest]
          : isSpecializedFanout
            ? [
                ...specializedResolverRequests,
                specializedMemoryRequest,
                ...(planTurnRequest === undefined ? [specializedPlanRequest] : []),
                ...retrievalRequestPrefix,
                ...topicLedgers.map(({ topicId, ledger }) => ({
                  taskId: `topic-${topicId}-answer`,
                  agentRole: "topic_answer" as const,
                  modelId: "glm-5-turbo" as const,
                  inputTokens: ledger.inputTokens,
                  requestedOutputTokens: 16_384,
                  outputTokens: 2,
                  stopReason: "toolUse" as const,
                  loopIteration: 0,
                })),
                {
                  taskId: "fanout-synthesis",
                  agentRole: "synthesis",
                  modelId: "glm-5-turbo",
                  inputTokens: synthesisLedger!.inputTokens,
                  requestedOutputTokens: 16_384,
                  outputTokens: 2,
                  stopReason: "stop",
                  loopIteration: 0,
                },
              ]
            : [
                ...specializedResolverRequests,
                specializedMemoryRequest,
                ...(planTurnRequest === undefined ? [specializedPlanRequest] : []),
                ...retrievalRequestPrefix,
                {
                  taskId: "single-answer",
                  agentRole: "direct_answer",
                  modelId: "glm-5-turbo",
                  inputTokens: directTerminalLedger!.inputTokens,
                  requestedOutputTokens: 16_384,
                  outputTokens: 2,
                  stopReason: "stop",
                  loopIteration: 0,
                },
                ...(isSpecializedOversized
                  ? [
                      {
                        taskId: "single-reduce-plan",
                        agentRole: "context_reducer" as const,
                        modelId: "glm-5-turbo" as const,
                        inputTokens: 20,
                        requestedOutputTokens: 2,
                        outputTokens: 2,
                        stopReason: "toolUse" as const,
                        loopIteration: 1,
                      },
                    ]
                  : []),
              ];
    const providerEvidenceByCoordinate = new Map<
      string,
      {
        readonly proofs: readonly string[];
        readonly requestSha256Hex: string;
        readonly bindings: readonly ProviderRequestSourceExposureProofBinding[];
      }
    >();
    let deferredUnknownExposure: Parameters<typeof insertAiSourceExposure>[0] | undefined;
    let deferredUnknownOExposure: Parameters<typeof insertAiSourceExposure>[0] | undefined;
    const providerEvidenceKey = (
      taskId: string,
      providerRequestIndex: number,
      loopIteration = 0,
      attempt = taskId === memoryTaskId ? memoryAttempt : 0,
    ): string => `${taskId}:${loopIteration}:${attempt}:${providerRequestIndex}`;
    const insertFixtureSourceExposure = (input: Parameters<typeof insertAiSourceExposure>[0]) => {
      const marker = {
        sourceKind: input.sourceKind,
        logicalSourceIdentity: input.logicalSourceIdentity,
        contentItemIdentity: input.contentItemIdentity,
        exposureStage: input.exposureStage,
        visibleTokenCount: input.visibleTokenCount,
      } as const;
      const evidence = providerEvidenceByCoordinate.get(
        providerEvidenceKey(
          input.taskId,
          input.providerRequestIndex,
          input.loopIteration,
          input.attempt,
        ),
      );
      const candidates = [
        ...(evidence?.bindings ?? []),
        ...[...providerEvidenceByCoordinate.values()].flatMap((candidate) => candidate.bindings),
      ];
      const binding =
        candidates.find((candidate) => canonicalJson(candidate.marker) === canonicalJson(marker))
          ?.binding ??
        candidates.find(
          (candidate) =>
            candidate.marker.sourceKind === marker.sourceKind &&
            candidate.marker.logicalSourceIdentity === marker.logicalSourceIdentity &&
            candidate.marker.contentItemIdentity === marker.contentItemIdentity &&
            candidate.marker.visibleTokenCount === marker.visibleTokenCount,
        )?.binding;
      return insertAiSourceExposure({
        ...input,
        ...(binding === undefined ? {} : { providerSerializationProofBinding: binding }),
      });
    };
    const providerRequestDigestForTask = (
      taskId: string,
      providerRequestIndex = 0,
      loopIteration = 0,
      attempt = taskId === memoryTaskId ? memoryAttempt : 0,
    ): string => {
      const topicId = /^topic-(t[1-3])-answer$/u.exec(taskId)?.[1];
      const exact =
        providerEvidenceByCoordinate.get(
          providerEvidenceKey(taskId, providerRequestIndex, loopIteration, attempt),
        )?.requestSha256Hex ??
        (taskId === "plan-turn" && planTurnRequest !== undefined
          ? planTurnRequest.requestSha256Hex
          : taskId === "single-answer"
            ? directTerminalLedger!.requestSha256Hex
            : topicId !== undefined
              ? topicLedgers.find((topic) => topic.topicId === topicId)!.ledger.requestSha256Hex
              : taskId === "fanout-synthesis"
                ? synthesisLedger!.requestSha256Hex
                : fixtureProviderRequestSha256Hex);
      return (tamper === "direct_request_digest" && taskId === "single-answer") ||
        (tamper === "topic_request_digest" && taskId === "topic-t1-answer") ||
        (tamper === "synthesis_request_digest" && taskId === "fanout-synthesis") ||
        ((tamper === "clarification_error_stop" || tamper === "clarification_boundary_count") &&
          taskId === "plan-turn")
        ? "c".repeat(64)
        : exact;
    };
    const usageChronologyBase = new Date(Date.now() - 500).toISOString();
    const sameMillisecondUsageBase = new Date().toISOString();
    const sameMillisecondUsageTimestamp = (microsecondSuffix: "845" | "853"): string =>
      sameMillisecondUsageBase.replace(/Z$/u, `${microsecondSuffix}Z`);
    await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        if (row.topology === "specialized" && tamper === "preseal_stale_memory_retry") {
          const staleResult: MemoryExtractionResult = { proposals: [], discardedCount: 0 };
          const staleDigest = memoryExtractionSha256Hex(staleResult);
          yield* insertAiObservation({
            runId: row.runId,
            chatId: manifest.chatId,
            emittingTask: "memory-extract",
            loopIteration: 0,
            attempt: 0,
            observationKey: "provider_request_measurement:memory-extract:0:0:0",
            kind: "provider_request_measurement",
            payload: {
              providerRequestIndex: 0,
              agentRole: "memory_extractor",
              modelId: "glm-5-turbo",
              requestSha256Hex: fixtureProviderRequestSha256Hex,
              sourceExposureProofSha256Hexes: [],
              inputTokens: 10,
              requestedOutputTokens: 2,
              usableInputTokens: canonicalEvaluationUsableInputTokens(),
              contextWindow: 200_000,
              passed: true,
            },
          });
          yield* insertAiRunUsage({
            runId: row.runId,
            taskId: "memory-extract",
            loopIteration: 0,
            attempt: 0,
            providerRequestIndex: 0,
            agentRole: "memory_extractor",
            modelId: "glm-5-turbo",
            providerServiceId: "zai_coding_plan_official",
            usage: {
              inputTokens: 10,
              outputTokens: 2,
              cachedTokens: 0,
              reasoningTokens: 0,
              totalTokens: 12,
              stopReason: "stop",
            },
          });
          yield* insertAiObservation({
            runId: row.runId,
            chatId: manifest.chatId,
            emittingTask: "memory-extract",
            loopIteration: 0,
            attempt: 0,
            observationKey: "memory-extract:0:0:memory_extraction_result:result",
            kind: "memory_extraction_result",
            payload: {
              proposalCount: 0,
              discardedCount: 0,
              extractionSha256Hex: staleDigest,
            },
          });
          // A passed Pi gate can remain without usage when transport fails. The
          // later successful attempt must remain sealable without deleting this
          // append-only failed-attempt measurement.
          yield* insertAiObservation({
            runId: row.runId,
            chatId: manifest.chatId,
            emittingTask: "memory-extract",
            loopIteration: 0,
            attempt: 1,
            observationKey: "provider_request_measurement:memory-extract:0:1:0",
            kind: "provider_request_measurement",
            payload: {
              providerRequestIndex: 0,
              agentRole: "memory_extractor",
              modelId: "glm-5-turbo",
              requestSha256Hex: "d".repeat(64),
              sourceExposureProofSha256Hexes: [],
              inputTokens: 10,
              requestedOutputTokens: 2,
              usableInputTokens: canonicalEvaluationUsableInputTokens(),
              contextWindow: 200_000,
              passed: true,
            },
          });
        }
        for (const request of providerRequests) {
          const requestAttempt = request.taskId === memoryTaskId ? memoryAttempt : 0;
          const providerRequestIndex = request.providerRequestIndex ?? 0;
          const stopReason = request.stopReason;
          const modelId =
            tamper === "clarification_model_mismatch" && request.taskId === "plan-turn"
              ? ("glm-5.2" as const)
              : request.modelId;
          const inputTokens =
            tamper === "clarification_input_mismatch" && request.taskId === "plan-turn"
              ? request.inputTokens + 1
              : request.inputTokens;
          const providerEvidence = providerEvidenceForRequest(request.taskId, providerRequestIndex);
          providerEvidenceByCoordinate.set(
            providerEvidenceKey(
              request.taskId,
              providerRequestIndex,
              request.loopIteration,
              requestAttempt,
            ),
            providerEvidence,
          );
          const providerRequestDigest = providerRequestDigestForTask(
            request.taskId,
            providerRequestIndex,
            request.loopIteration,
            requestAttempt,
          );
          yield* insertAiObservation({
            runId: row.runId,
            chatId: manifest.chatId,
            emittingTask: request.taskId,
            loopIteration: request.loopIteration,
            attempt: requestAttempt,
            observationKey: `provider_request_measurement:${request.taskId}:${request.loopIteration}:${requestAttempt}:${providerRequestIndex}`,
            kind: "provider_request_measurement",
            payload: {
              providerRequestIndex,
              agentRole: request.agentRole,
              modelId,
              requestSha256Hex: providerRequestDigest,
              sourceExposureProofSha256Hexes: providerEvidence.proofs,
              sourceExposureProofBindings: providerEvidence.bindings.map(
                ({ providerSerializationProofSha256Hex, binding }) => ({
                  providerSerializationProofSha256Hex,
                  providerSerializationProofBinding: binding,
                }),
              ),
              inputTokens,
              requestedOutputTokens: request.requestedOutputTokens,
              usableInputTokens: canonicalEvaluationUsableInputTokens(),
              contextWindow: 200_000,
              passed: true,
            },
          });
          const usageInput: AiRunUsageInput = {
            runId: row.runId,
            taskId: request.taskId,
            loopIteration: request.loopIteration,
            attempt: requestAttempt,
            providerRequestIndex,
            agentRole: request.agentRole,
            modelId,
            providerServiceId: "zai_coding_plan_official",
            usage: {
              inputTokens,
              outputTokens: request.outputTokens,
              cachedTokens: 0,
              reasoningTokens: 0,
              totalTokens: inputTokens + request.outputTokens,
              stopReason,
            },
          };
          const crossTaskTimestamp =
            tamper === "cross_task_same_millisecond_usage" &&
            request.taskId === "topic-t1-retrieve-internal"
              ? sameMillisecondUsageTimestamp("853")
              : tamper === "cross_task_same_millisecond_usage" &&
                  request.taskId === "topic-t2-retrieve-internal"
                ? sameMillisecondUsageTimestamp("845")
                : null;
          yield* crossTaskTimestamp === null
            ? insertAiRunUsage(usageInput)
            : insertAiRunUsageAt(usageInput, crossTaskTimestamp);
          if (request.taskId === "single-reduce-plan") {
            const terminalProviderRequestIndex =
              tamper === "o_inverted_chronology" && isSpecializedOversized
                ? 1
                : providerRequestIndex;
            const terminalRequestSha256Hex =
              tamper === "o_inverted_chronology" && isSpecializedOversized
                ? "b".repeat(64)
                : providerRequestDigest;
            const terminalInputTokens =
              tamper === "o_inverted_chronology" && isSpecializedOversized ? 20 : inputTokens;
            const terminalTotalTokens =
              tamper === "o_inverted_chronology" && isSpecializedOversized
                ? 20
                : inputTokens + request.outputTokens;
            const terminalStopReason =
              tamper === "o_inverted_chronology" && isSpecializedOversized ? "stop" : stopReason;
            yield* insertAiObservation({
              runId: row.runId,
              chatId: manifest.chatId,
              emittingTask: request.taskId,
              loopIteration: request.loopIteration,
              attempt: 0,
              observationKey: `context_reducer_terminal:${request.loopIteration}:0:0`,
              kind: "context_reducer_terminal",
              payload: {
                terminalUsageCoordinate: {
                  taskId: request.taskId,
                  loopIteration: request.loopIteration,
                  attempt: 0,
                  providerRequestIndex: terminalProviderRequestIndex,
                },
                modelId: "glm-5-turbo",
                requestSha256Hex: terminalRequestSha256Hex,
                providerInputTokens: terminalInputTokens,
                totalTokens: terminalTotalTokens,
                stopReason: terminalStopReason,
              },
            });
          }
        }
        if (
          (tamper === "o_later_error" || tamper === "o_inverted_chronology") &&
          isSpecializedOversized
        ) {
          yield* insertAiObservation({
            runId: row.runId,
            chatId: manifest.chatId,
            emittingTask: "single-reduce-plan",
            loopIteration: 1,
            attempt: 0,
            observationKey: "provider_request_measurement:single-reduce-plan:1:0:1",
            kind: "provider_request_measurement",
            payload: {
              providerRequestIndex: 1,
              agentRole: "context_reducer",
              modelId: "glm-5-turbo",
              requestSha256Hex: "b".repeat(64),
              sourceExposureProofSha256Hexes: [],
              inputTokens: 20,
              requestedOutputTokens: 2,
              usableInputTokens: canonicalEvaluationUsableInputTokens(),
              contextWindow: 200_000,
              passed: true,
            },
          });
          if (tamper === "o_inverted_chronology") {
            yield* insertAiRunUsageAt(
              {
                runId: row.runId,
                taskId: "single-reduce-plan",
                loopIteration: 1,
                attempt: 0,
                providerRequestIndex: 1,
                agentRole: "context_reducer",
                modelId: "glm-5-turbo",
                providerServiceId: "zai_coding_plan_official",
                usage: {
                  inputTokens: 20,
                  outputTokens: 0,
                  cachedTokens: 0,
                  reasoningTokens: 0,
                  totalTokens: 20,
                  stopReason: "stop",
                },
              },
              usageChronologyBase,
            );
          }
        }
        yield* insertAiObservation({
          runId: row.runId,
          chatId: manifest.chatId,
          emittingTask:
            row.topology === "general_planner" ? "evaluation-general-planner" : "memory-extract",
          loopIteration: 0,
          attempt: memoryAttempt,
          observationKey: memoryObservationKey,
          kind: "memory_extraction_result",
          payload: {
            proposalCount: memoryResult.proposals.length,
            discardedCount: memoryResult.discardedCount,
            extractionSha256Hex: memoryArtifact.producer.extractionSha256Hex,
          },
        });
        if (resolution.mode === "clarify") {
          yield* insertAiObservation({
            runId: row.runId,
            chatId: manifest.chatId,
            emittingTask:
              row.topology === "general_planner" ? "evaluation-general-planner" : "plan-turn",
            loopIteration: 0,
            attempt: 0,
            observationKey: "evaluation-test:turn-plan",
            kind: "turn_plan",
            payload: resolution,
          });
        }
        if (resolution.mode === "single" || resolution.mode === "fanout") {
          yield* insertAiObservation({
            runId: row.runId,
            chatId: manifest.chatId,
            emittingTask:
              row.topology === "general_planner" ? "evaluation-general-planner" : "plan-turn",
            loopIteration: 0,
            attempt: 0,
            observationKey: "evaluation-test:turn-plan",
            kind: "turn_plan",
            payload: resolution,
          });
          if (row.topology === "specialized") {
            const retrievalPrefixes = isSpecializedFanout
              ? fanoutTopicIds.map((topicId) => `topic-${topicId}`)
              : ["single"];
            for (const prefix of retrievalPrefixes) {
              for (const selector of ["A", "B", "W"] as const) {
                const retrievalTaskSuffix =
                  selector === "A"
                    ? "retrieve-internal"
                    : selector === "B"
                      ? "select-memories"
                      : "retrieve-web";
                const retrievalTaskId = `${prefix}-${retrievalTaskSuffix}`;
                const noCallReason = noCallReasonForSelector(prefix, selector);
                const references: Array<Record<string, unknown>> = [];
                for (const sourceId of selectedIds) {
                  if (noCallReason !== undefined) continue;
                  const source = fixture.evidence.find((item) => item.sourceId === sourceId)!;
                  if (source.selector !== selector) continue;
                  const binding = manifest.sourceBindings.find(
                    (item) => evaluationBindingGoldenSourceId(item) === sourceId,
                  )!;
                  if (binding.kind === "document") {
                    references.push({
                      kind: "document",
                      documentId: binding.documentId,
                      versionId: binding.versionId,
                      source: binding.source,
                      ranges: fullCandidateSelections.find(
                        (selection) => selection.sourceId === sourceId,
                      )!.ranges,
                      purpose:
                        tamper === "manifest_purpose"
                          ? "forged manifest purpose"
                          : "canonical evaluation evidence",
                    });
                    continue;
                  }
                  if (binding.kind === "chat_message") {
                    references.push({
                      kind: "chat_message",
                      messageId: binding.messageId,
                      purpose:
                        tamper === "manifest_purpose"
                          ? "forged manifest purpose"
                          : "canonical evaluation evidence",
                    });
                    continue;
                  }
                  if (binding.kind === "memory") {
                    references.push({
                      memoryId: binding.memoryId,
                      memoryRevisionId: binding.memoryRevisionId,
                    });
                    continue;
                  }
                  references.push({
                    url: binding.url,
                    title: binding.title,
                    domain: binding.domain,
                    quote: source.content,
                    publishedAt: "2026-03-14T00:00:00.000Z",
                    capturedAt: binding.capturedAt,
                    purpose:
                      tamper === "manifest_purpose"
                        ? "forged manifest purpose"
                        : "canonical evaluation evidence",
                  });
                  if (
                    multiWebQuotes &&
                    fixture.id === "cross-cutting-separable-energy-question" &&
                    prefix === "topic-t3" &&
                    selector === "W"
                  ) {
                    references.push({
                      url: binding.url,
                      title: binding.title,
                      domain: binding.domain,
                      quote: source.content.slice(0, 24),
                      publishedAt: "2026-03-14T00:00:00.000Z",
                      capturedAt: binding.capturedAt,
                      purpose: "canonical evaluation evidence excerpt",
                    });
                  }
                }
                yield* insertAiObservation({
                  runId: row.runId,
                  chatId: manifest.chatId,
                  emittingTask: retrievalTaskId,
                  loopIteration: 0,
                  attempt: 0,
                  observationKey:
                    noCallReason === undefined
                      ? `evaluation-test:retrieval:${prefix}:${selector}`
                      : `${retrievalTaskId}:0:0:retrieval_manifest:result`,
                  kind: "retrieval_manifest",
                  payload: {
                    selectorRole:
                      selector === "A" ? "internal" : selector === "B" ? "memory" : "web",
                    references,
                    ...(references.length === 0 && noCallReason !== undefined
                      ? { noCallReason }
                      : {}),
                  },
                });
              }
            }
          }
          if (row.topology === "general_planner") {
            yield* insertAiObservation({
              runId: row.runId,
              chatId: manifest.chatId,
              emittingTask: "evaluation-general-planner",
              loopIteration: 0,
              attempt: 0,
              observationKey: "evaluation-test:baseline-context-measurement",
              kind: "context_measurement",
              payload: {
                consumerTaskId: resolution.mode === "fanout" ? "fanout-synthesis" : "single-answer",
                totalInputTokens: candidateTokens,
                usableInputTokens: canonicalEvaluationUsableInputTokens(),
                status: "ready",
                reductionRan: false,
              },
            });
            yield* insertAiObservation({
              runId: row.runId,
              chatId: manifest.chatId,
              emittingTask: "evaluation-general-planner",
              loopIteration: 0,
              attempt: 0,
              observationKey: "evaluation-test:baseline-context-serialized",
              kind: "context_serialized",
              payload: {
                consumerTaskId: resolution.mode === "fanout" ? "fanout-synthesis" : "single-answer",
                sourceKeys: sourceMap.map((source) => source.sourceKey),
              },
            });
            yield* insertAiObservation({
              runId: row.runId,
              chatId: manifest.chatId,
              emittingTask: "evaluation-general-planner",
              loopIteration: 0,
              attempt: 0,
              observationKey: "evaluation-test:general-planner-retrieval",
              kind: "retrieval_manifest",
              payload: {
                selectorRole: "general_planner",
                references: selectedIds.map((sourceId) => {
                  const source = fixture.evidence.find(
                    (candidate) => candidate.sourceId === sourceId,
                  )!;
                  return {
                    sourceId,
                    ranges: source.kind === "document" ? source.ranges : [],
                  };
                }),
              },
            });
          }
          if (row.topology === "specialized" && !isSpecializedFanout) {
            yield* insertAiObservation({
              runId: row.runId,
              chatId: manifest.chatId,
              emittingTask: "single-measure",
              loopIteration: 0,
              attempt: 0,
              observationKey: "evaluation-test:context-measurement:pre",
              kind: "context_measurement",
              payload: {
                consumerTaskId: "single-answer",
                mandatoryInputTokens: 0,
                discretionaryInputTokens:
                  isSpecializedOversized && tamper === "pre_token_mismatch"
                    ? directInitialLedger!.inputTokens + 1
                    : directInitialLedger!.inputTokens,
                totalInputTokens:
                  isSpecializedOversized && tamper === "pre_token_mismatch"
                    ? directInitialLedger!.inputTokens + 1
                    : directInitialLedger!.inputTokens,
                usableInputTokens: directInitialLedger!.usableInputTokens,
                requestedOutputTokens: directInitialLedger!.requestedOutputTokens,
                contextWindow: 200_000,
                status: isSpecializedOversized ? "needs_reduction" : "ready",
                reductionRan: false,
                reductionFeedback: [],
                restrictedContextLedger: directInitialLedger,
              },
            });
            yield* insertAiObservation({
              runId: row.runId,
              chatId: manifest.chatId,
              emittingTask: "single-answer",
              loopIteration: 0,
              attempt: 0,
              observationKey: "evaluation-test:context-serialized:single-answer",
              kind: "context_serialized",
              payload: {
                consumerTaskId: "single-answer",
                sourceKeys: sourceMap.map((source) => source.sourceKey),
                restrictedContextLedger: directTerminalLedger,
                terminalUsageCoordinate: {
                  taskId: "single-answer",
                  loopIteration: 0,
                  attempt: tamper === "terminal_error_stop" ? 1 : 0,
                  providerRequestIndex: 0,
                },
              },
            });
            if (tamper === "terminal_error_stop") {
              const retryMarkers = answerSerializedMarkersForTask("single-answer");
              const retrySidecar = providerSidecarForCodeOwnedMarkers([
                ...conversationProviderMarkers(),
                ...retryMarkers,
              ]);
              const retryProviderRequestSha256Hex = directTerminalLedger!.requestSha256Hex;
              providerEvidenceByCoordinate.set("single-answer:0:1:0", {
                requestSha256Hex: retryProviderRequestSha256Hex,
                proofs: retrySidecar.proofs,
                bindings: retrySidecar.bindings,
              });
              yield* insertAiObservation({
                runId: row.runId,
                chatId: manifest.chatId,
                emittingTask: "single-answer",
                loopIteration: 0,
                attempt: 1,
                observationKey: "provider_request_measurement:single-answer:0:1:0",
                kind: "provider_request_measurement",
                payload: {
                  providerRequestIndex: 0,
                  agentRole: "direct_answer",
                  modelId: "glm-5-turbo",
                  requestSha256Hex: retryProviderRequestSha256Hex,
                  sourceExposureProofSha256Hexes: retrySidecar.proofs,
                  sourceExposureProofBindings: retrySidecar.bindings.map(
                    ({ providerSerializationProofSha256Hex, binding }) => ({
                      providerSerializationProofSha256Hex,
                      providerSerializationProofBinding: binding,
                    }),
                  ),
                  inputTokens: directTerminalLedger!.inputTokens,
                  requestedOutputTokens: directTerminalLedger!.requestedOutputTokens,
                  usableInputTokens: directTerminalLedger!.usableInputTokens,
                  contextWindow: 200_000,
                  passed: true,
                },
              });
              yield* insertAiRunUsage({
                runId: row.runId,
                taskId: "single-answer",
                loopIteration: 0,
                attempt: 1,
                providerRequestIndex: 0,
                agentRole: "direct_answer",
                modelId: "glm-5-turbo",
                providerServiceId: "zai_coding_plan_official",
                usage: {
                  inputTokens: directTerminalLedger!.inputTokens,
                  outputTokens: 0,
                  cachedTokens: 0,
                  reasoningTokens: 0,
                  totalTokens: directTerminalLedger!.inputTokens,
                  stopReason: "stop",
                },
              });
              yield* insertAiObservation({
                runId: row.runId,
                chatId: manifest.chatId,
                emittingTask: "single-answer",
                loopIteration: 0,
                attempt: 1,
                observationKey: "evaluation-test:context-serialized:single-answer:retry",
                kind: "context_serialized",
                payload: {
                  consumerTaskId: "single-answer",
                  sourceKeys: sourceMap.map((source) => source.sourceKey),
                  restrictedContextLedger: directTerminalLedger,
                  terminalUsageCoordinate: {
                    taskId: "single-answer",
                    loopIteration: 0,
                    attempt: 1,
                    providerRequestIndex: 0,
                  },
                },
              });
              for (const marker of conversationProviderMarkers()) {
                const sidecarBinding = retrySidecar.bindings.find(
                  (candidate) =>
                    candidate.marker.sourceKind === marker.sourceKind &&
                    candidate.marker.logicalSourceIdentity === marker.logicalSourceIdentity &&
                    candidate.marker.contentItemIdentity === marker.contentItemIdentity &&
                    candidate.marker.exposureStage === marker.exposureStage &&
                    candidate.marker.visibleTokenCount === marker.visibleTokenCount,
                )?.binding;
                if (sidecarBinding === undefined) {
                  throw new Error("terminal retry lacks its exact conversation sidecar binding");
                }
                yield* insertFixtureSourceExposure({
                  runId: row.runId,
                  taskId: "single-answer",
                  loopIteration: 0,
                  attempt: 1,
                  providerRequestIndex: 0,
                  providerRequestSha256Hex: retryProviderRequestSha256Hex,
                  sourceKind: marker.sourceKind,
                  logicalSourceIdentity: marker.logicalSourceIdentity,
                  contentItemIdentity: marker.contentItemIdentity,
                  exposureStage: marker.exposureStage,
                  visibleTokenCount: marker.visibleTokenCount,
                  providerSerializationProofBinding: sidecarBinding,
                });
              }
              for (const [index, source] of sourceMap.entries()) {
                const marker = retryMarkers.filter(
                  (candidate) => candidate.exposureStage === "answer_serialized",
                )[index];
                if (marker === undefined) continue;
                const sidecarBinding = retrySidecar.bindings.find(
                  (candidate) =>
                    candidate.marker.sourceKind === marker.sourceKind &&
                    candidate.marker.logicalSourceIdentity === marker.logicalSourceIdentity &&
                    candidate.marker.contentItemIdentity === marker.contentItemIdentity &&
                    candidate.marker.exposureStage === marker.exposureStage &&
                    candidate.marker.visibleTokenCount === marker.visibleTokenCount,
                )?.binding;
                if (sidecarBinding === undefined) {
                  throw new Error("terminal retry lacks its exact answer sidecar binding");
                }
                yield* insertFixtureSourceExposure({
                  runId: row.runId,
                  taskId: "single-answer",
                  loopIteration: 0,
                  attempt: 1,
                  providerRequestIndex: 0,
                  providerRequestSha256Hex: retryProviderRequestSha256Hex,
                  sourceKind: marker.sourceKind,
                  logicalSourceIdentity: marker.logicalSourceIdentity,
                  contentItemIdentity: marker.contentItemIdentity,
                  exposureStage: marker.exposureStage,
                  visibleTokenCount: marker.visibleTokenCount,
                  providerSerializationProofBinding: sidecarBinding,
                  ...(source.locator.kind === "document"
                    ? {
                        documentReconstruction: {
                          sourceId: source.locator.sourceId,
                          documentId: source.locator.documentId,
                          versionId: source.locator.versionId,
                          contentHash: source.locator.contentHash,
                          ranges:
                            source.uses.find((use) => use.consumerTaskId === "single-answer")
                              ?.ranges ?? [],
                          ...(source.locator.publisherExtractionId === undefined
                            ? {}
                            : { publisherExtractionId: source.locator.publisherExtractionId }),
                        },
                      }
                    : {}),
                });
              }
            }
          }
          if (isSpecializedOversized) {
            if (tamper === "later_invalid_decision") {
              yield* insertAiObservation({
                runId: row.runId,
                chatId: manifest.chatId,
                emittingTask: "single-reduce-measure",
                loopIteration: 2,
                attempt: 0,
                observationKey: "evaluation-test:context-decision:later-invalid",
                kind: "context_decision",
                payload: {
                  valid: false,
                  decisions: durableReductionDecisions,
                  feedback: "forged later invalid decision",
                },
              });
            }
            yield* insertAiObservation({
              runId: row.runId,
              chatId: manifest.chatId,
              emittingTask: "single-reduce-measure",
              loopIteration: 1,
              attempt: 0,
              observationKey: "evaluation-test:context-decision",
              kind: "context_decision",
              payload: { valid: true, decisions: durableReductionDecisions },
            });
            yield* insertAiObservation({
              runId: row.runId,
              chatId: manifest.chatId,
              emittingTask: "single-reduce-measure",
              loopIteration: 1,
              attempt: 0,
              observationKey: "evaluation-test:context-measurement:post",
              kind: "context_measurement",
              payload: {
                consumerTaskId: "single-answer",
                mandatoryInputTokens: 0,
                discretionaryInputTokens: directTerminalLedger!.inputTokens,
                totalInputTokens: directTerminalLedger!.inputTokens,
                requestedOutputTokens: directTerminalLedger!.requestedOutputTokens,
                usableInputTokens: directTerminalLedger!.usableInputTokens,
                contextWindow: 200_000,
                status: "ready",
                reductionRan: true,
                reductionFeedback: [],
                restrictedContextLedger: directTerminalLedger,
              },
            });
          }
          if (row.topology === "specialized" && isSpecializedFanout) {
            for (const [topicIndex, { topicId, ledger }] of topicLedgers.entries()) {
              yield* insertAiObservation({
                runId: row.runId,
                chatId: manifest.chatId,
                emittingTask: `topic-${topicId}-measure`,
                loopIteration: 0,
                attempt: 0,
                observationKey: `evaluation-test:context-measurement:${topicId}:pre`,
                kind: "context_measurement",
                payload: {
                  consumerTaskId: `topic-${topicId}-answer`,
                  mandatoryInputTokens: 0,
                  discretionaryInputTokens: ledger.inputTokens,
                  totalInputTokens: ledger.inputTokens,
                  usableInputTokens: ledger.usableInputTokens,
                  requestedOutputTokens: ledger.requestedOutputTokens,
                  contextWindow: 200_000,
                  status: "ready",
                  reductionRan: false,
                  reductionFeedback: [],
                  restrictedContextLedger: ledger,
                },
              });
              yield* insertAiObservation({
                runId: row.runId,
                chatId: manifest.chatId,
                emittingTask: `topic-${topicId}-answer`,
                loopIteration: 0,
                attempt: 0,
                observationKey: `evaluation-test:context-serialized:${topicId}`,
                kind: "context_serialized",
                payload: {
                  consumerTaskId: `topic-${topicId}-answer`,
                  topicId,
                  sourceKeys: sourceMap.map((source) => source.sourceKey),
                  restrictedContextLedger: ledger,
                  terminalUsageCoordinate: {
                    taskId: `topic-${topicId}-answer`,
                    loopIteration: 0,
                    attempt: 0,
                    providerRequestIndex: 0,
                  },
                },
              });
              const packet = topicPackets[topicIndex];
              if (packet?.topicId !== topicId) {
                throw new Error("fanout packet order does not match the planned topics");
              }
              yield* insertAiObservation({
                runId: row.runId,
                chatId: manifest.chatId,
                emittingTask: `topic-${topicId}-answer`,
                loopIteration: 0,
                attempt: 0,
                observationKey: `evaluation-test:topic-packet:${topicId}`,
                kind: "topic_packet",
                payload: {
                  topicId,
                  sourceKeys: [...new Set(packet.claims.flatMap((claim) => claim.sourceKeys))],
                  status: packet.status,
                  claimCount: packet.claims.length,
                  gapCount: packet.gaps.length,
                  packetSha256Hex: productionPacketSha256Hex(packet),
                },
              });
            }
            yield* insertAiObservation({
              runId: row.runId,
              chatId: manifest.chatId,
              emittingTask: "fanout-synthesis-measure",
              loopIteration: 0,
              attempt: 0,
              observationKey: "evaluation-test:context-measurement:synthesis",
              kind: "context_measurement",
              payload: {
                consumerTaskId: "fanout-synthesis",
                mandatoryInputTokens: 0,
                discretionaryInputTokens: synthesisLedger!.inputTokens,
                totalInputTokens: synthesisLedger!.inputTokens,
                requestedOutputTokens: synthesisLedger!.requestedOutputTokens,
                usableInputTokens: synthesisLedger!.usableInputTokens,
                contextWindow: 200_000,
                status: "ready",
                reductionRan: false,
                reductionFeedback: [],
                restrictedContextLedger: synthesisLedger,
              },
            });
            yield* insertAiObservation({
              runId: row.runId,
              chatId: manifest.chatId,
              emittingTask: "fanout-synthesis",
              loopIteration: 0,
              attempt: 0,
              observationKey: "evaluation-test:context-serialized:fanout-synthesis",
              kind: "context_serialized",
              payload: {
                consumerTaskId: "fanout-synthesis",
                sourceKeys: [],
                restrictedContextLedger: synthesisLedger,
                terminalUsageCoordinate: {
                  taskId: "fanout-synthesis",
                  loopIteration: 0,
                  attempt: 0,
                  providerRequestIndex: 0,
                },
              },
            });
          }
        }
        for (const sourceId of selectedIds) {
          const source = fixture.evidence.find((candidate) => candidate.sourceId === sourceId)!;
          const marker = exposedPreviewMarkerFor(sourceId);
          const binding = manifest.sourceBindings.find(
            (candidate) => evaluationBindingGoldenSourceId(candidate) === sourceId,
          )!;
          const tamperedContentItemIdentity =
            row.topology !== "specialized"
              ? marker.contentItemIdentity
              : tamper === "wrong_document_version" && binding.kind === "document"
                ? `unknown-evaluation-version:${marker.contentItemIdentity.split(":").at(-1)}`
                : tamper === "coordinated_document_hash" && binding.kind === "document"
                  ? `${binding.versionId}:${"A".repeat(43)}`
                  : tamper === "wrong_memory_revision" && binding.kind === "memory"
                    ? "00000000-0000-4000-8000-000000000099"
                    : tamper === "wrong_web_identity" && binding.kind === "web"
                      ? `https://forged.invalid/source:${sha256Base64Url(source.content.slice(0, 300))}`
                      : marker.contentItemIdentity;
          const baselineLogicalIdentity =
            binding.kind === "document"
              ? namespacedDocumentEvidenceIdentity(binding.source, binding.documentId)
              : sourceId;
          const canonicalBaselineIdentity =
            binding.kind === "document"
              ? `${baselineLogicalIdentity}:${binding.versionId}:${sha256Base64Url(JSON.stringify(source.ranges.map(({ charStart, charEnd }) => ({ charStart, charEnd }))))}`
              : `${baselineLogicalIdentity}:0:${source.content.length}:${createHash("sha256")
                  .update(source.content)
                  .digest("hex")}`;
          const exposureTaskIds =
            row.topology === "general_planner"
              ? ["evaluation-general-planner"]
              : (isSpecializedFanout
                  ? fanoutTopicIds.map((topicId) => `topic-${topicId}`)
                  : ["single"]
                )
                  .filter((prefix) => selectorHasProviderCall(prefix, source.selector))
                  .map((prefix) =>
                    tamper === "memory_as_internal_preview" && source.kind === "memory"
                      ? `${prefix}-retrieve-internal`
                      : tamper === "chat_as_web_preview" && source.kind === "chat_message"
                        ? `${prefix}-retrieve-web`
                        : tamper === "arbitrary_internal_task" && source.selector === "A"
                          ? "forged-retrieve-internal"
                          : `${prefix}-${
                              source.selector === "B"
                                ? "select-memories"
                                : `retrieve-${source.selector === "A" ? "internal" : "web"}`
                            }`,
                  );
          for (const exposureTaskId of exposureTaskIds) {
            const exposureProviderRequestIndices =
              row.topology === "specialized" &&
              tamper === "wrong_exposure_coordinate" &&
              binding.kind === "document"
                ? [1]
                : isSpecializedOversized &&
                    source.selector === "A" &&
                    exposureTaskId === "single-retrieve-internal"
                  ? [1, 2]
                  : [0];
            for (const providerRequestIndex of exposureProviderRequestIndices) {
              yield* insertFixtureSourceExposure({
                runId: row.runId,
                taskId: exposureTaskId,
                loopIteration: 0,
                attempt: 0,
                providerRequestIndex,
                providerRequestSha256Hex: providerRequestDigestForTask(
                  exposureTaskId,
                  providerRequestIndex,
                ),
                sourceKind: source.kind,
                logicalSourceIdentity:
                  row.topology === "general_planner"
                    ? baselineLogicalIdentity
                    : marker.logicalSourceIdentity,
                contentItemIdentity:
                  row.topology === "general_planner"
                    ? canonicalBaselineIdentity
                    : tamperedContentItemIdentity,
                exposureStage:
                  row.topology === "general_planner"
                    ? "evaluation_general_planner_inspect"
                    : tamper === "wrong_web_stage" && binding.kind === "web"
                      ? "web_fetch"
                      : marker.exposureStage,
                visibleTokenCount:
                  row.topology === "general_planner"
                    ? model.countTextTokens(source.content)
                    : marker.visibleTokenCount,
                ...(source.kind === "document" && binding.kind === "document"
                  ? {
                      documentReconstruction: {
                        sourceId: binding.sourceId,
                        documentId: binding.documentId,
                        versionId: binding.versionId,
                        contentHash:
                          tamper === "tampered_document_reconstruction"
                            ? "b".repeat(64)
                            : binding.contentHash,
                        ranges:
                          row.topology === "specialized" &&
                          marker.exposureStage === "internal_search_preview"
                            ? previewRangesFor(source)
                            : source.ranges,
                      },
                    }
                  : {}),
              });
            }
            if (row.topology === "specialized" && binding.kind === "web") {
              const canonicalUrl = canonicalizeWebUrl(binding.url);
              yield* insertFixtureSourceExposure({
                runId: row.runId,
                taskId: exposureTaskId,
                loopIteration: 0,
                attempt: 0,
                providerRequestIndex: 0,
                providerRequestSha256Hex: providerRequestDigestForTask(exposureTaskId),
                sourceKind: "web",
                logicalSourceIdentity: canonicalUrl,
                contentItemIdentity: `${canonicalUrl}:${sha256Base64Url(source.content)}`,
                exposureStage: "web_fetch",
                visibleTokenCount: model.countTextTokens(source.content),
              });
            }
          }
          if (isSpecializedOversized) {
            const reductionMarker = exposedReductionMarkerFor(sourceId);
            yield* insertFixtureSourceExposure({
              runId: row.runId,
              taskId: "single-reduce-plan",
              loopIteration: 1,
              attempt: 0,
              providerRequestIndex: 0,
              providerRequestSha256Hex: providerRequestDigestForTask("single-reduce-plan", 0, 1),
              sourceKind: reductionMarker.sourceKind,
              logicalSourceIdentity: reductionMarker.logicalSourceIdentity,
              contentItemIdentity: reductionMarker.contentItemIdentity,
              exposureStage: "context_candidate_inspection",
              visibleTokenCount: model.countTextTokens(source.content),
              ...(reductionMarker.sourceKind === "document" &&
              "documentReconstruction" in reductionMarker &&
              reductionMarker.documentReconstruction !== undefined
                ? {
                    documentReconstruction:
                      tamper === "tampered_document_reconstruction"
                        ? {
                            ...reductionMarker.documentReconstruction,
                            contentHash: "b".repeat(64),
                          }
                        : reductionMarker.documentReconstruction,
                  }
                : {}),
            });
          }
        }
        if (isSpecializedOversized) {
          for (const [index, marker] of oversizedInspectionMarkers.entries()) {
            yield* insertFixtureSourceExposure({
              runId: row.runId,
              taskId: "single-retrieve-internal",
              loopIteration: 0,
              attempt: 0,
              providerRequestIndex:
                tamper === "oversized_wrong_coordinate_internal_inspection" && index === 0 ? 1 : 2,
              providerRequestSha256Hex: providerRequestDigestForTask(
                "single-retrieve-internal",
                tamper === "oversized_wrong_coordinate_internal_inspection" && index === 0 ? 1 : 2,
              ),
              sourceKind: marker.sourceKind,
              logicalSourceIdentity: marker.logicalSourceIdentity,
              contentItemIdentity: marker.contentItemIdentity,
              exposureStage: marker.exposureStage,
              visibleTokenCount: marker.visibleTokenCount,
              ...(marker.sourceKind === "document" &&
              "documentReconstruction" in marker &&
              marker.documentReconstruction !== undefined
                ? {
                    documentReconstruction:
                      tamper === "tampered_document_reconstruction"
                        ? { ...marker.documentReconstruction, contentHash: "b".repeat(64) }
                        : marker.documentReconstruction,
                  }
                : {}),
            });
          }
        }
        if (extraConversationExposure !== undefined) {
          const serialized = extraConversationExposure.exposureStage === "answer_serialized";
          if (serialized) {
            const extraMarker: ProviderVisibleSourceExposureMarker = {
              sourceKind: extraConversationExposure.sourceKind,
              logicalSourceIdentity: extraConversationExposure.logicalSourceIdentity,
              contentItemIdentity: extraConversationExposure.contentItemIdentity,
              exposureStage: extraConversationExposure.exposureStage,
              visibleTokenCount: extraConversationExposure.visibleTokenCount,
            };
            const retryMarkers = [
              ...conversationProviderMarkers(),
              ...answerSerializedMarkersForTask("single-answer"),
              extraMarker,
            ];
            const retrySidecar = providerSidecarForCodeOwnedMarkers(retryMarkers);
            yield* insertAiObservation({
              runId: row.runId,
              chatId: manifest.chatId,
              emittingTask: "topic-t1-answer",
              loopIteration: 0,
              attempt: 1,
              observationKey: "provider_request_measurement:topic-t1-answer:0:1:0",
              kind: "provider_request_measurement",
              payload: {
                providerRequestIndex: 0,
                agentRole: "topic_answer",
                modelId: "glm-5-turbo",
                requestSha256Hex: retrySidecar.requestSha256Hex,
                sourceExposureProofSha256Hexes: retrySidecar.proofs,
                sourceExposureProofBindings: retrySidecar.bindings.map(
                  ({ providerSerializationProofSha256Hex, binding }) => ({
                    providerSerializationProofSha256Hex,
                    providerSerializationProofBinding: binding,
                  }),
                ),
                inputTokens: directTerminalLedger!.inputTokens,
                requestedOutputTokens: 16_384,
                usableInputTokens: canonicalEvaluationUsableInputTokens(),
                contextWindow: 200_000,
                passed: true,
              },
            });
            yield* insertAiRunUsage({
              runId: row.runId,
              taskId: "topic-t1-answer",
              loopIteration: 0,
              attempt: 1,
              providerRequestIndex: 0,
              agentRole: "topic_answer",
              modelId: "glm-5-turbo",
              providerServiceId: "zai_coding_plan_official",
              usage: {
                inputTokens: directTerminalLedger!.inputTokens,
                outputTokens: 0,
                cachedTokens: 0,
                reasoningTokens: 0,
                totalTokens: directTerminalLedger!.inputTokens,
                stopReason: "stop",
              },
            });
            for (const marker of retryMarkers) {
              const sidecarBinding = retrySidecar.bindings.find(
                (candidate) =>
                  candidate.marker.sourceKind === marker.sourceKind &&
                  candidate.marker.logicalSourceIdentity === marker.logicalSourceIdentity &&
                  candidate.marker.contentItemIdentity === marker.contentItemIdentity &&
                  candidate.marker.exposureStage === marker.exposureStage &&
                  candidate.marker.visibleTokenCount === marker.visibleTokenCount,
              )?.binding;
              if (sidecarBinding === undefined) {
                throw new Error("serialized conversation tamper lacks its exact sidecar binding");
              }
              const details = markerDetailsFor(marker);
              const documentBinding =
                details?.binding.kind === "document" ? details.binding : undefined;
              yield* insertFixtureSourceExposure({
                runId: row.runId,
                taskId: "topic-t1-answer",
                loopIteration: 0,
                attempt: 1,
                providerRequestIndex: 0,
                providerRequestSha256Hex: retrySidecar.requestSha256Hex,
                sourceKind: marker.sourceKind,
                logicalSourceIdentity: marker.logicalSourceIdentity,
                contentItemIdentity: marker.contentItemIdentity,
                exposureStage: marker.exposureStage,
                visibleTokenCount: marker.visibleTokenCount,
                providerSerializationProofBinding: sidecarBinding,
                ...(documentBinding !== undefined && details?.ranges !== undefined
                  ? {
                      documentReconstruction: {
                        sourceId: documentBinding.sourceId,
                        documentId: documentBinding.documentId,
                        versionId: documentBinding.versionId,
                        contentHash: documentBinding.contentHash,
                        ranges: details.ranges,
                        ...(documentBinding.publisherExtractionId === null
                          ? {}
                          : { publisherExtractionId: documentBinding.publisherExtractionId }),
                      },
                    }
                  : {}),
              });
            }
          } else {
            yield* insertFixtureSourceExposure({
              runId: row.runId,
              taskId: "single-retrieve-internal",
              loopIteration: 0,
              attempt: 0,
              providerRequestIndex: 0,
              providerRequestSha256Hex: providerRequestDigestForTask("single-retrieve-internal"),
              sourceKind: extraConversationExposure.sourceKind,
              logicalSourceIdentity: extraConversationExposure.logicalSourceIdentity,
              contentItemIdentity: extraConversationExposure.contentItemIdentity,
              exposureStage: extraConversationExposure.exposureStage,
              visibleTokenCount: extraConversationExposure.visibleTokenCount,
            });
          }
        }
        if (row.topology === "specialized") {
          const conversationTaskIds = [
            ...(resolution.mode === "clarify"
              ? planTurnRequest === undefined
                ? []
                : ["plan-turn"]
              : ["plan-turn"]),
            ...(resolution.mode === "clarify"
              ? []
              : isSpecializedFanout
                ? [
                    ...fanoutTopicIds.map((topicId) => `topic-${topicId}-answer`),
                    "fanout-synthesis",
                  ]
                : ["single-answer"]),
          ];
          const firstTurn = manifest.turnBindings[0];
          const firstGoldenTurn = fixture.conversation[0];
          for (const conversationTaskId of conversationTaskIds) {
            const conversationRequestDigest = providerRequestDigestForTask(conversationTaskId);
            yield* insertFixtureSourceExposure({
              runId: row.runId,
              taskId: conversationTaskId,
              loopIteration: 0,
              attempt: 0,
              providerRequestIndex: 0,
              providerRequestSha256Hex: conversationRequestDigest,
              sourceKind: "chat_message",
              logicalSourceIdentity: chatMessageEvidenceIdentity(manifest.userMessageId),
              contentItemIdentity: manifest.userMessageId,
              exposureStage: "provider_input",
              visibleTokenCount: model.countTextTokens(fixture.currentMessage),
            });
            if (firstTurn !== undefined && firstGoldenTurn !== undefined) {
              yield* insertFixtureSourceExposure({
                runId: row.runId,
                taskId: conversationTaskId,
                loopIteration: 0,
                attempt: 0,
                providerRequestIndex: 0,
                providerRequestSha256Hex: conversationRequestDigest,
                sourceKind: "chat_message",
                logicalSourceIdentity: chatMessageEvidenceIdentity(firstTurn.assistantMessageId),
                contentItemIdentity: firstTurn.assistantMessageId,
                exposureStage: "provider_input",
                visibleTokenCount: model.countTextTokens(firstGoldenTurn.assistantContent),
              });
            }
          }
          const answerTaskIds =
            resolution.mode === "clarify"
              ? []
              : isSpecializedFanout
                ? [
                    ...fanoutTopicIds.map((topicId) => `topic-${topicId}-answer`),
                    "fanout-synthesis",
                  ]
                : ["single-answer"];
          for (const taskId of answerTaskIds) {
            const markers = answerSerializedMarkersForTask(taskId);
            for (const [index, source] of sourceMap.entries()) {
              const marker = markers[index];
              if (marker === undefined) continue;
              const locator = source.locator;
              yield* insertFixtureSourceExposure({
                runId: row.runId,
                taskId,
                loopIteration: 0,
                attempt: 0,
                providerRequestIndex: 0,
                providerRequestSha256Hex: providerRequestDigestForTask(taskId),
                sourceKind: marker.sourceKind,
                logicalSourceIdentity: marker.logicalSourceIdentity,
                contentItemIdentity: marker.contentItemIdentity,
                exposureStage: marker.exposureStage,
                visibleTokenCount: marker.visibleTokenCount,
                ...(locator.kind === "document"
                  ? {
                      documentReconstruction: {
                        sourceId: locator.sourceId,
                        documentId: locator.documentId,
                        versionId: locator.versionId,
                        contentHash: locator.contentHash,
                        ranges:
                          source.uses.find((use) => use.consumerTaskId === taskId)?.ranges ?? [],
                        ...(locator.publisherExtractionId === undefined
                          ? {}
                          : { publisherExtractionId: locator.publisherExtractionId }),
                      },
                    }
                  : {}),
              });
            }
          }
        }
        if (
          tamper === "unknown_exposure" &&
          row.topology === "specialized" &&
          row.caseId === CanonicalGoldenEvaluationSet.cases[0]?.id
        ) {
          const forgedSourceId = selectedIds.find(
            (sourceId) =>
              fixture.evidence.find((source) => source.sourceId === sourceId)?.kind ===
                "document" &&
              fixture.evidence.find((source) => source.sourceId === sourceId)?.selector === "A",
          );
          const forgedSource =
            forgedSourceId === undefined
              ? undefined
              : fixture.evidence.find((source) => source.sourceId === forgedSourceId);
          const forgedBinding =
            forgedSourceId === undefined
              ? undefined
              : manifest.sourceBindings.find(
                  (binding) => evaluationBindingGoldenSourceId(binding) === forgedSourceId,
                );
          if (
            forgedSourceId === undefined ||
            forgedSource?.kind !== "document" ||
            forgedBinding?.kind !== "document"
          ) {
            throw new Error("unknown exposure tamper lacks a canonical document fixture");
          }
          const forgedMarker = exposedPreviewMarkerFor(forgedSourceId);
          const forgedProviderBinding = [...providerEvidenceByCoordinate.values()]
            .flatMap((evidence) => evidence.bindings)
            .find(
              (candidate) =>
                canonicalJson(candidate.marker) ===
                canonicalJson({
                  sourceKind: forgedMarker.sourceKind,
                  logicalSourceIdentity: forgedMarker.logicalSourceIdentity,
                  contentItemIdentity: forgedMarker.contentItemIdentity,
                  exposureStage: forgedMarker.exposureStage,
                  visibleTokenCount: forgedMarker.visibleTokenCount,
                }),
            )?.binding;
          if (forgedProviderBinding === undefined) {
            throw new Error("unknown exposure tamper lacks a canonical provider field binding");
          }
          deferredUnknownExposure = {
            runId: row.runId,
            taskId: "evaluation-test-forged-exposure",
            loopIteration: 0,
            attempt: 0,
            providerRequestIndex: 0,
            providerRequestSha256Hex: fixtureProviderRequestSha256Hex,
            sourceKind: forgedMarker.sourceKind,
            logicalSourceIdentity: forgedMarker.logicalSourceIdentity,
            contentItemIdentity: forgedMarker.contentItemIdentity,
            exposureStage: forgedMarker.exposureStage,
            visibleTokenCount: forgedMarker.visibleTokenCount,
            providerSerializationProofBinding: forgedProviderBinding,
            documentReconstruction: {
              sourceId: forgedBinding.sourceId,
              documentId: forgedBinding.documentId,
              versionId: forgedBinding.versionId,
              contentHash: forgedBinding.contentHash,
              ranges: [{ charStart: 0, charEnd: Math.min(300, forgedSource.content.length) }],
            },
          };
        }
        if (
          tamper === "unknown_o_exposure" &&
          row.topology === "specialized" &&
          isSpecializedOversized
        ) {
          const forgedMarker = {
            sourceKind: "memory" as const,
            logicalSourceIdentity: "memory:00000000-0000-4000-8000-000000000000",
            contentItemIdentity: "00000000-0000-4000-8000-000000000001",
            exposureStage: "context_candidate_inspection" as const,
            visibleTokenCount: 1,
          };
          const forgedBinding: ProviderVisibleSourceExposureProofBinding = {
            messageIndex: 2,
            sourceOrdinal: 0,
            serializedField: "messages[2].content.matches[0].text",
            orderedSourceDescriptor: canonicalJson({
              sourceOrdinal: 0,
              messageIndex: 2,
              serializedField: "messages[2].content.matches[0].text",
              ...forgedMarker,
            }),
          };
          deferredUnknownOExposure = {
            runId: row.runId,
            taskId: "single-reduce-plan",
            loopIteration: 1,
            attempt: 0,
            providerRequestIndex: selectedIds.length + 1,
            providerRequestSha256Hex: fixtureProviderRequestSha256Hex,
            ...forgedMarker,
            providerSerializationProofBinding: forgedBinding,
          };
        }
        if (row.topology === "specialized" && fixture.webRequested && fixture.webPolicyEnabled) {
          const webTasks = (
            isSpecializedFanout ? fanoutTopicIds.map((topicId) => `topic-${topicId}`) : ["single"]
          )
            .filter((prefix) => selectorHasProviderCall(prefix, "W"))
            .map((prefix) => `${prefix}-retrieve-web`);
          const webSources = selectedIds.filter(
            (sourceId) =>
              fixture.evidence.find((source) => source.sourceId === sourceId)!.selector === "W",
          );
          for (const taskId of webTasks) {
            const extraFetch =
              multiWebQuotes &&
              row.topology === "specialized" &&
              fixture.id === "cross-cutting-separable-energy-question" &&
              taskId === "topic-t3-retrieve-web"
                ? 1
                : 0;
            yield* insertAiExternalToolUsage({
              runId: row.runId,
              taskId,
              loopIteration: 0,
              attempt: 0,
              toolRequestIndex: 0,
              providerServiceId: "tinyfish_search_official",
              operation: "web_search",
              status: "ok",
              resultCount: webSources.length,
              responseBytes: 128,
              billedUnits: null,
              durationMs: 0,
            });
            for (const index of Array.from(
              { length: webSources.length + extraFetch },
              (_, i) => i,
            )) {
              yield* insertAiExternalToolUsage({
                runId: row.runId,
                taskId,
                loopIteration: 0,
                attempt: 0,
                toolRequestIndex: index + 1,
                providerServiceId: "brief_fetch",
                operation: "web_fetch",
                status: "ok",
                resultCount: 1,
                responseBytes: 128,
                billedUnits: null,
                durationMs: 0,
              });
            }
          }
        }
        const terminalMode =
          resolution.mode === "clarify"
            ? "clarification"
            : resolution.mode === "fanout" || isSpecializedFanout
              ? "synthesis"
              : "single";
        const answerEventTaskId =
          row.topology === "general_planner"
            ? "evaluation-general-planner"
            : terminalMode === "clarification"
              ? "clarification-result"
              : terminalMode === "synthesis"
                ? "fanout-synthesis"
                : "single-answer";
        yield* appendAiRunEvent({
          runId: row.runId,
          emissionKey: "context_ready",
          event: {
            type: "context_ready",
            mode: terminalMode,
            reductionRan: isSpecializedOversized,
            sourcesRead:
              terminalMode === "clarification"
                ? []
                : sourceMap.map(publicSourceRecordFromFinalSource),
            consumers:
              terminalMode === "clarification"
                ? []
                : row.topology === "general_planner"
                  ? [
                      {
                        consumer: terminalMode === "synthesis" ? "synthesis" : "direct",
                        inputTokens: measureCanonicalEvaluationRequestTokens(fixture, selected),
                        requestedOutputTokens: 16_384,
                        usableInputTokens: canonicalEvaluationUsableInputTokens(),
                      },
                    ]
                  : isSpecializedFanout
                    ? [
                        ...topicLedgers.map(({ topicId, ledger }) => ({
                          consumer: "topic" as const,
                          topicId,
                          inputTokens: ledger.inputTokens,
                          requestedOutputTokens: ledger.requestedOutputTokens,
                          usableInputTokens: ledger.usableInputTokens,
                        })),
                        {
                          consumer: "synthesis" as const,
                          inputTokens: synthesisLedger!.inputTokens,
                          requestedOutputTokens: synthesisLedger!.requestedOutputTokens,
                          usableInputTokens: synthesisLedger!.usableInputTokens,
                        },
                      ]
                    : [
                        {
                          consumer: "direct",
                          inputTokens: directTerminalLedger!.inputTokens,
                          requestedOutputTokens: directTerminalLedger!.requestedOutputTokens,
                          usableInputTokens: directTerminalLedger!.usableInputTokens,
                        },
                      ],
          },
          emittedByTask: answerEventTaskId,
        });
        yield* appendAiRunEvent({
          runId: row.runId,
          emissionKey: `answer_started:${answerEventTaskId}:0`,
          event: {
            type: "answer_started",
            mode: terminalMode,
            attempt: 0,
          },
          emittedByTask: answerEventTaskId,
        });
        const answer =
          resolution.mode === "clarify"
            ? resolution.question
            : `Canonical answer${sourceMap.length === 0 ? "" : ` [[cite:${sourceMap.map((source) => source.sourceKey).join(",")}]]`}`;
        yield* appendAiRunEvent({
          runId: row.runId,
          emissionKey: `text_delta:${answerEventTaskId}:0:0`,
          event: { type: "text_delta", delta: answer },
          emittedByTask: answerEventTaskId,
        });
        yield* finalizeAiRun({
          runId: row.runId,
          expectedSmithersRunId:
            row.topology === "specialized"
              ? `ai-chat:${row.runId}`
              : `ai-evaluation-general-planner:${targetSessionId}:${row.caseId}`,
          answer: {
            status: "ok",
            mode: terminalMode,
            content: answer,
            sourceMap,
          },
          memory: memoryArtifact,
          coordinates: { loopIteration: 0, attempt: 1 },
        });
      }),
    );
    if (deferredUnknownExposure !== undefined) {
      await runDb(isolatedDatabaseUrl(), insertAiSourceExposure(deferredUnknownExposure));
    }
    if (deferredUnknownOExposure !== undefined) {
      await runDb(isolatedDatabaseUrl(), insertAiSourceExposure(deferredUnknownOExposure));
    }
    if (row.topology === "general_planner") {
      const outputPlanTurn =
        fixture.labels.planTurn.mode === "clarify"
          ? { mode: "clarify" as const, question: fixture.labels.planTurn.question }
          : {
              mode: "single" as const,
              question: fixture.labels.planTurn.question,
              relevantTurnIds: fixture.labels.relevantTurnIds,
            };
      const output = {
        planTurn: outputPlanTurn,
        selectedSources: selected,
        answerContent: "Canonical baseline answer",
        citationSourceIds: selectedIds,
        memoryProposals: fixture.labels.expectedMemoryProposals.map((proposal) => ({
          action: proposal.action,
          kind: proposal.kind,
          content: proposal.content,
          targetMemorySourceId:
            proposal.targetMemoryId === null
              ? null
              : `memory:${proposal.targetMemoryId}:${proposal.expectedHeadRevisionId}`,
        })),
      };
      await runDb(
        isolatedDatabaseUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            update ai_evaluation_case_runs
            set execution_output = ${canonicalJson(output)}::jsonb,
                execution_output_sha256_hex = ${canonicalSha256Hex(output)}, updated_at = now()
            where session_id = ${targetSessionId} and case_id = ${row.caseId}
              and topology = 'general_planner'
          `;
        }),
      );
    }
    const exposureSourceId = selectedIds.find(
      (sourceId) =>
        fixture.evidence.find((source) => source.sourceId === sourceId)?.selector === "A",
    );
    const exposureMarker =
      exposureSourceId === undefined ? undefined : exposedPreviewMarkerFor(exposureSourceId);
    const memoryAction = fixture.labels.expectedMemoryProposals[0]?.action;
    const preSealEligible =
      row.topology === "specialized" &&
      !preSealTamperApplied &&
      tamper?.startsWith("preseal_") === true &&
      ((tamper === "preseal_memory_create_before" && memoryAction === "create") ||
        (tamper === "preseal_memory_update_before" && memoryAction === "update") ||
        (tamper === "preseal_exposure_count" && exposureMarker !== undefined) ||
        ((tamper === "preseal_context_payload" ||
          tamper === "preseal_delta_gap" ||
          tamper === "preseal_coordinated_source_use" ||
          tamper === "preseal_citation_insert" ||
          tamper === "preseal_citation_change" ||
          tamper === "preseal_citation_delete" ||
          tamper === "preseal_manifest_delete") &&
          resolution.mode === "single" &&
          sourceMap.length > 0) ||
        (tamper !== "preseal_memory_create_before" &&
          tamper !== "preseal_memory_update_before" &&
          tamper !== "preseal_exposure_count" &&
          tamper !== "preseal_context_payload" &&
          tamper !== "preseal_delta_gap" &&
          tamper !== "preseal_coordinated_source_use" &&
          tamper !== "preseal_citation_insert" &&
          tamper !== "preseal_citation_change" &&
          tamper !== "preseal_citation_delete" &&
          tamper !== "preseal_manifest_delete"));
    if (preSealEligible) {
      const forgedExposureCount = (exposureMarker?.visibleTokenCount ?? 0) + 1;
      const forgedExposureProof =
        exposureMarker === undefined
          ? ""
          : providerVisibleSourceExposureProofSha256Hex({
              ...exposureMarker,
              visibleTokenCount: forgedExposureCount,
            });
      const forgedAdminId = `eval-forged-admin-${targetSessionId}`;
      await runDb(
        isolatedDatabaseUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          switch (tamper) {
            case "preseal_current_message_author":
              yield* sql`update chat_messages set author = 'assistant' where id = ${manifest.userMessageId}`;
              break;
            case "preseal_terminal_owner":
              yield* sql`update ai_run_events set emitted_by_task = 'forged-finalizer' where run_id = ${row.runId} and emission_key = 'terminal'`;
              break;
            case "preseal_event_timestamp_inversion":
              yield* sql`
                update ai_run_events event
                set created_at = run.finished_at
                from ai_runs run
                where event.run_id = run.id and event.run_id = ${row.runId} and event.seq = 1
              `;
              break;
            case "preseal_duplicate_run_started":
              yield* sql`
                insert into ai_run_events (
                  run_id, seq, emission_key, event, emitted_by_task, created_at
                )
                select id, next_event_seq, 'forged-run-started',
                       jsonb_build_object('type', 'run_started'), null, finished_at
                from ai_runs where id = ${row.runId}
              `;
              yield* sql`update ai_runs set next_event_seq = next_event_seq + 1 where id = ${row.runId}`;
              break;
            case "preseal_context_payload":
              yield* sql`
                update ai_run_events
                set event = jsonb_set(
                  event, '{consumers,0,inputTokens}',
                  to_jsonb(((event #>> '{consumers,0,inputTokens}')::int + 1))
                )
                where run_id = ${row.runId} and emission_key = 'context_ready'
              `;
              break;
            case "preseal_delta_gap":
              yield* sql`
                update ai_run_events
                set emission_key = regexp_replace(emission_key, ':0$', ':1')
                where run_id = ${row.runId} and event->>'type' = 'text_delta'
              `;
              break;
            case "preseal_coordinated_source_use":
              yield* sql`
                update assistant_message_source_uses
                set rendered_token_count = rendered_token_count + 1
                where assistant_message_id = (
                  select assistant_message_id from ai_runs where id = ${row.runId}
                ) and source_key = ${sourceMap[0]!.sourceKey}
              `;
              yield* sql`
                update ai_run_events
                set event = jsonb_set(
                  event, '{sourcesRead,0,tokenCount}',
                  to_jsonb(((event #>> '{sourcesRead,0,tokenCount}')::int + 1))
                )
                where run_id = ${row.runId} and emission_key = 'context_ready'
              `;
              break;
            case "preseal_memory_create_before":
            case "preseal_memory_update_before":
              yield* sql`
                update user_memory_revisions
                set state_before = ${JSON.stringify({ kind: "preference", content: "forged prior memory state", deleted: false })}::jsonb
                where run_id = ${row.runId}
              `;
              break;
            case "preseal_citation_insert":
              yield* sql`
                insert into ai_observations (
                  run_id, chat_id, emitting_task, loop_iteration, attempt,
                  observation_key, kind, payload, created_at
                )
                select id, chat_id, 'finalize', 0, 1, 'citation:999:0', 'citation',
                       jsonb_build_object(
                         'assistantMessageId', assistant_message_id::text,
                         'sourceKey', ${sourceMap[0]!.sourceKey}
                       ),
                       finished_at
                from ai_runs where id = ${row.runId}
              `;
              break;
            case "preseal_citation_change":
              yield* sql`
                update ai_observations
                set payload = jsonb_set(payload, '{sourceKey}', to_jsonb('forged-source-key'::text))
                where id = (
                  select id from ai_observations
                  where run_id = ${row.runId} and kind = 'citation'
                  order by observation_key limit 1
                )
              `;
              break;
            case "preseal_citation_delete":
              yield* sql`
                delete from ai_observations where id = (
                  select id from ai_observations
                  where run_id = ${row.runId} and kind = 'citation'
                  order by observation_key limit 1
                )
              `;
              break;
            case "preseal_exposure_count": {
              const changedExposures = yield* sql<{ readonly id: string }>`
                update ai_source_exposures
                set visible_token_count = ${forgedExposureCount}
                where run_id = ${row.runId}
                  and exposure_stage = ${exposureMarker!.exposureStage}
                  and content_item_identity = ${exposureMarker!.contentItemIdentity}
                returning id::text
              `;
              const changedAttestations = yield* sql<{ readonly id: string }>`
                update ai_observations
                set payload = jsonb_set(
                  jsonb_set(payload, '{visibleTokenCount}', to_jsonb(${forgedExposureCount}::int)),
                  '{providerSerializationProofSha256Hex}', to_jsonb(${forgedExposureProof}::text)
                )
                where run_id = ${row.runId} and kind = 'source_exposure_attestation'
                  and payload->>'exposureStage' = ${exposureMarker!.exposureStage}
                  and payload->>'contentItemIdentity' = ${exposureMarker!.contentItemIdentity}
                returning id::text
              `;
              if (changedExposures.length !== 1 || changedAttestations.length !== 1) {
                throw new Error("pre-seal exposure-count tamper did not bind exactly one exposure");
              }
              break;
            }
            case "preseal_stale_memory_retry":
              // The lower successful extraction attempt was inserted before
              // the consumed attempt and remains valid append-only evidence.
              break;
            case "preseal_terminal_memory_mismatch":
              yield* sql`
                update ai_observations
                set payload = jsonb_set(
                  payload,
                  '{proposalCount}',
                  to_jsonb(((payload->>'proposalCount')::int + 1))
                )
                where run_id = ${row.runId} and kind = 'memory_extraction_result'
              `;
              break;
            case "preseal_membership_revoked":
              yield* sql`
                insert into platform_users (id, primary_email, display_name, clerk_user_id)
                values (${forgedAdminId}, ${`${forgedAdminId}@evaluation.invalid`}, 'Evaluation guard admin', ${`clerk_${forgedAdminId}`})
              `;
              yield* sql`
                insert into client_company_memberships (company_id, user_id, role)
                values (${manifest.companyId}, ${forgedAdminId}, 'admin')
              `;
              yield* sql`
                update client_company_memberships
                set revoked_at = now(), revoked_by_user_id = ${forgedAdminId}
                where company_id = ${manifest.companyId} and user_id = ${manifest.userId}
              `;
              break;
            case "preseal_user_recovery_deleted":
              yield* sql`
                update platform_users
                set recovery_deleted_at = now(), purge_after = now() + interval '180 days'
                where id = ${manifest.userId}
              `;
              break;
            case "preseal_company_recovery_deleted":
              yield* sql`
                update client_companies
                set recovery_deleted_at = now(), purge_after = now() + interval '180 days'
                where id = ${manifest.companyId}
              `;
              break;
            case "preseal_manifest_delete":
              yield* sql`
                update ai_observations
                set payload = jsonb_set(payload, '{references}', (payload->'references') - 0)
                where id = (
                  select id from ai_observations
                  where run_id = ${row.runId} and kind = 'retrieval_manifest'
                    and jsonb_array_length(payload->'references') > 0
                  order by observation_key limit 1
                )
              `;
              break;
            case "preseal_duplicate_resolution":
              yield* insertAiObservation({
                runId: row.runId,
                chatId: manifest.chatId,
                emittingTask: "plan-turn",
                loopIteration: 0,
                attempt: 0,
                observationKey: "evaluation-test:turn-plan:forged-duplicate",
                kind: "turn_plan",
                payload: resolution,
              });
              yield* sql`
                update ai_observations
                set created_at = (select finished_at from ai_runs where id = ${row.runId})
                where run_id = ${row.runId}
                  and observation_key = 'evaluation-test:turn-plan:forged-duplicate'
              `;
              break;
          }
        }),
      );
      preSealTamperApplied = true;
    }
    await attestEvaluationCaseFromDurableRun(
      isolatedDatabaseUrl(),
      targetSessionId,
      row.caseId,
      row.topology,
    );
  }
  if (tamper?.startsWith("preseal_") === true && !preSealTamperApplied) {
    throw new Error(`pre-seal tamper ${tamper} did not find an eligible run`);
  }
  await runDb(
    isolatedDatabaseUrl(),
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      yield* sql`
        update ai_evaluation_sessions set status = 'awaiting_annotations', updated_at = now()
        where id = ${targetSessionId}
      `;
    }),
  );
};

const beginFocusedProductionGraphCase = async (
  targetSessionId: string,
  targetCaseId = focusedProductionCaseId,
  providerServiceId:
    | "deterministic_test"
    | "zai_coding_plan_official"
    | "openai_compatible_custom" =
    "zai_coding_plan_official",
) => {
  await createEvaluationSession(isolatedDatabaseUrl(), targetSessionId);
  const manifests = await seedEvaluationSession(
    isolatedDatabaseUrl(),
    targetSessionId,
    providerServiceId,
  );
  await runDb(
    isolatedDatabaseUrl(),
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      yield* sql`
        update ai_evaluation_sessions
        set status = 'running',
            execution_config_sha256_hex = ${canonicalSha256Hex(CanonicalEvaluationExecutionConfig)},
            provider_endpoint_identity = ${TINYFISH_SEARCH_PROVIDER_ENDPOINT_IDENTITY},
            updated_at = now()
        where id = ${targetSessionId} and status = 'preparing'
      `;
    }),
  );
  const manifest = manifests.find(
    (candidate) => candidate.caseId === targetCaseId && candidate.topology === "specialized",
  );
  if (manifest === undefined) throw new Error("focused production graph seed manifest is missing");
  await ensureEvaluationCaseRunning(isolatedDatabaseUrl(), {
    sessionId: targetSessionId,
    caseId: manifest.caseId,
    topology: manifest.topology,
    aiRunId: manifest.aiRunId,
  });
  return manifest;
};

const executeFocusedProductionGraphCase = async (
  targetSessionId: string,
  config: WorkerConfig,
  targetCaseId = focusedProductionCaseId,
) => {
  const manifest = await beginFocusedProductionGraphCase(
    targetSessionId,
    targetCaseId,
    providerServiceIdForConfig(config),
  );
  const job: JobRecord = {
    id: crypto.randomUUID(),
    kind: "ai_chat_run",
    payload: { aiRunId: manifest.aiRunId },
    attempts: 0,
  };
  const result = await Effect.runPromise(handleAiChatRunJob(job, { config }));
  expect(result).toEqual({
    status: "completed",
    message: `ai chat run completed: ${manifest.aiRunId}`,
  });
  return manifest;
};

const beginFocusedGeneralPlannerCase = async (
  targetSessionId: string,
  caseId: string,
  providerServiceId:
    | "deterministic_test"
    | "zai_coding_plan_official"
    | "openai_compatible_custom" =
    "zai_coding_plan_official",
) => {
  await createEvaluationSession(isolatedDatabaseUrl(), targetSessionId);
  const manifests = await seedEvaluationSession(
    isolatedDatabaseUrl(),
    targetSessionId,
    providerServiceId,
  );
  await runDb(
    isolatedDatabaseUrl(),
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      yield* sql`
        update ai_evaluation_sessions
        set status = 'running',
            execution_config_sha256_hex = ${canonicalSha256Hex(CanonicalEvaluationExecutionConfig)},
            provider_endpoint_identity = ${TINYFISH_SEARCH_PROVIDER_ENDPOINT_IDENTITY},
            updated_at = now()
        where id = ${targetSessionId} and status = 'preparing'
      `;
    }),
  );
  const manifest = manifests.find(
    (candidate) => candidate.caseId === caseId && candidate.topology === "general_planner",
  );
  if (manifest === undefined) throw new Error("focused general-planner seed manifest is missing");
  return manifest;
};

const smithersRowsForRun = (smithersRunId: string): Promise<readonly string[]> =>
  runDb(
    isolatedDatabaseUrl(),
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      const tables = yield* sql<{ readonly tableName: string }>`
        select distinct table_name as "tableName"
        from information_schema.columns
        where table_schema = 'public' and column_name = 'run_id'
          and (
            table_name like '\\_smithers\\_%' escape '\\'
            or table_name in ('input', 'ai_evaluation_general_planner')
          )
        order by table_name
      `;
      const present: string[] = [];
      for (const { tableName } of tables) {
        const rows = yield* sql<{ readonly present: boolean }>`
          select exists (
            select 1 from ${sql(tableName)} where run_id = ${smithersRunId}
          ) as present
        `;
        if (rows[0]?.present === true) present.push(tableName);
      }
      return present;
    }),
  );

const focusedProductionRuntimeEvidence = (aiRunId: string) =>
  runDb(
    isolatedDatabaseUrl(),
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      const runs = yield* sql<{
        readonly finishedAt: Date | null;
        readonly failedAt: Date | null;
        readonly errorCode: string | null;
      }>`
        select finished_at as "finishedAt", failed_at as "failedAt", error_code as "errorCode"
        from ai_runs where id = ${aiRunId}
      `;
      const usage = yield* sql<{
        readonly taskId: string;
        readonly modelId: string;
        readonly providerServiceId: string;
      }>`
        select task_id as "taskId", model_id as "modelId",
               provider_service_id as "providerServiceId"
        from ai_run_usage where run_id = ${aiRunId}
        order by created_at, id
      `;
      const measurements = yield* sql<{
        readonly taskId: string;
        readonly modelId: string | null;
      }>`
        select emitting_task as "taskId", payload->>'modelId' as "modelId"
        from ai_observations
        where run_id = ${aiRunId} and kind = 'provider_request_measurement'
        order by created_at, id
      `;
      const internalManifests = yield* sql<{ readonly payload: unknown }>`
        select payload from ai_observations
        where run_id = ${aiRunId} and kind = 'retrieval_manifest'
          and emitting_task = 'single-retrieve-internal'
        order by created_at, id
      `;
      const exposures = yield* sql<{
        readonly sourceKind: string;
        readonly exposureStage: string;
        readonly documentSourceId: string | null;
        readonly documentId: string | null;
        readonly versionId: string | null;
        readonly contentHash: string | null;
        readonly documentRanges:
          | readonly { readonly charStart: number; readonly charEnd: number }[]
          | null;
      }>`
        select source_kind as "sourceKind", exposure_stage as "exposureStage",
               document_source_id as "documentSourceId", document_id as "documentId",
               version_id as "versionId", content_hash as "contentHash",
               document_ranges as "documentRanges"
        from ai_source_exposures
        where run_id = ${aiRunId}
        order by created_at, id
      `;
      const sources = yield* sql<{
        readonly kind: string;
        readonly locator: unknown;
      }>`
        select sources.kind, sources.locator
        from ai_runs runs
        join assistant_message_sources sources
          on sources.assistant_message_id = runs.assistant_message_id
        where runs.id = ${aiRunId}
        order by sources.source_key
      `;
      const run = runs[0];
      if (run === undefined) return yield* Effect.fail(new Error("focused production run missing"));
      return { run, usage, measurements, internalManifests, exposures, sources };
    }),
  );

const assertFocusedTurboRuntimeEvidence = (
  evidence: Awaited<ReturnType<typeof focusedProductionRuntimeEvidence>>,
  expectedProviderServiceId: "deterministic_test" | "zai_coding_plan_official",
  expectedDocument: Extract<
    EvaluationSeedManifest["sourceBindings"][number],
    { readonly kind: "document" }
  >,
): void => {
  expect(evidence.run.finishedAt).toBeInstanceOf(Date);
  expect(evidence.run.failedAt).toBeNull();
  expect(evidence.run.errorCode).toBeNull();
  expect(evidence.usage.length).toBeGreaterThan(0);
  expect(new Set(evidence.usage.map((entry) => entry.modelId))).toEqual(new Set(["glm-5-turbo"]));
  expect(new Set(evidence.usage.map((entry) => entry.providerServiceId))).toEqual(
    new Set([expectedProviderServiceId]),
  );
  // A request that passes the exact local gate can time out before the
  // provider reports usage. Trusted capture validates such unmatched rows as
  // terminal measurement-only failed attempts; this focused smoke assertion
  // must not pre-empt that authoritative attestation with raw count equality.
  expect(evidence.measurements.length).toBeGreaterThanOrEqual(evidence.usage.length);
  expect(new Set(evidence.measurements.map((entry) => entry.modelId))).toEqual(
    new Set(["glm-5-turbo"]),
  );
  expect(evidence.internalManifests).toHaveLength(1);
  const internalManifest = evidence.internalManifests[0]?.payload as {
    readonly selectorRole?: unknown;
    readonly references?: readonly {
      readonly kind?: unknown;
      readonly documentId?: unknown;
      readonly versionId?: unknown;
      readonly source?: unknown;
      readonly ranges?: unknown;
      readonly purpose?: unknown;
    }[];
  };
  expect(internalManifest.selectorRole).toBe("internal");
  expect(internalManifest.references).toHaveLength(1);
  const reference = internalManifest.references?.[0];
  const expectedReferenceIdentity = {
    kind: "document",
    documentId: expectedDocument.documentId,
    versionId: expectedDocument.versionId,
    source: expectedDocument.source,
  } as const;
  if (expectedProviderServiceId === "deterministic_test") {
    expect(reference).toEqual({
      ...expectedReferenceIdentity,
      purpose: "ground the deterministic E2E answer",
    });
  } else {
    // The live provider owns optional range selection and purpose prose. The
    // durable attestation below validates the exact provider-authored manifest,
    // exposure coordinate, source identity, and final serialized locator ranges.
    expect(reference).toMatchObject({ ...expectedReferenceIdentity, purpose: expect.any(String) });
    expect(
      typeof reference?.purpose === "string" ? reference.purpose.trim().length : 0,
    ).toBeGreaterThan(0);
  }
  const expectedLocatorIdentity = {
    kind: "document",
    sourceId: expectedDocument.source.sourceId,
    documentId: expectedDocument.documentId,
    versionId: expectedDocument.versionId,
    contentHash: expectedDocument.contentHash,
  } as const;
  expect(evidence.sources).toEqual([
    {
      kind: "document",
      locator: { ...expectedLocatorIdentity, ranges: expect.any(Array) },
    },
  ]);
  const locator = evidence.sources[0]?.locator as { readonly ranges?: unknown } | undefined;
  const inspectedExposures = evidence.exposures.filter(
    (exposure) =>
      exposure.sourceKind === "document" &&
      exposure.exposureStage === "internal_inspection" &&
      exposure.documentSourceId === expectedDocument.source.sourceId &&
      exposure.documentId === expectedDocument.documentId &&
      exposure.versionId === expectedDocument.versionId &&
      exposure.contentHash === expectedDocument.contentHash,
  );
  expect(inspectedExposures).toHaveLength(1);
  const inspectedExposure = inspectedExposures[0];
  expect(inspectedExposure?.documentRanges).toEqual([
    { charStart: 0, charEnd: expect.any(Number) },
  ]);
  expect(locator?.ranges).toEqual(inspectedExposure?.documentRanges);
  expect(expectedDocument.source.sourceId).toMatch(/^public:[^:\s]+$/u);
  expect(expectedDocument.sourceId).toBe(expectedDocument.source.sourceId);
  expect(expectedDocument.goldenSourceId).toMatch(/^doc:[^:\s]+$/u);
};

describe.skipIf(sourceDatabaseUrl === undefined)("trusted canonical evaluation pipeline", () => {
  beforeAll(async () => {
    await runDb(
      adminDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql.unsafe(`create database ${quoteIdentifier(databaseName)}`);
      }),
    );
    await runDb(isolatedDatabaseUrl(), runMigrations);
  }, 120_000);

  beforeEach(async () => {
    await createEvaluationSession(isolatedDatabaseUrl(), sessionId);
    await seedEvaluationSession(isolatedDatabaseUrl(), sessionId);
  }, 120_000);

  afterAll(async () => {
    await runDb(
      adminDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          select pg_terminate_backend(pid)
          from pg_stat_activity
          where datname = ${databaseName} and pid <> pg_backend_pid()
        `;
        yield* sql.unsafe(`drop database if exists ${quoteIdentifier(databaseName)}`);
      }),
    );
  }, 120_000);

  it("seeds exactly one immutable run per canonical case and topology, idempotently", async () => {
    expect(await createEvaluationSession(isolatedDatabaseUrl(), sessionId)).toBe(sessionId);
    const first = await seedEvaluationSession(isolatedDatabaseUrl(), sessionId);
    const replay = await seedEvaluationSession(isolatedDatabaseUrl(), sessionId);
    expect(first).toHaveLength(CanonicalGoldenEvaluationSet.cases.length * 2);
    expect(replay).toEqual(first);

    const state = await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const sessions = yield* sql<{
          readonly artifactVersion: number;
          readonly goldenSetVersion: number;
          readonly fixtureDigest: string;
        }>`
          select artifact_version as "artifactVersion",
                 golden_set_version as "goldenSetVersion",
                 fixture_sha256_hex as "fixtureDigest"
          from ai_evaluation_sessions where id = ${sessionId}
        `;
        const counts = yield* sql<{
          readonly topology: string;
          readonly count: number;
        }>`
          select topology, count(*)::int as count
          from ai_evaluation_case_runs where session_id = ${sessionId}
          group by topology order by topology
        `;
        const documents = yield* sql<{
          readonly durableSourceId: string;
          readonly goldenSourceId: string;
          readonly text: string;
        }>`
          select binding->>'sourceId' as "durableSourceId",
                 binding->>'goldenSourceId' as "goldenSourceId",
                 documents.text
          from ai_evaluation_case_runs runs
          cross join lateral jsonb_array_elements(runs.seed_manifest->'sourceBindings') binding
          join public_source_documents documents
            on documents.document_id = binding->>'documentId'
          where runs.session_id = ${sessionId} and binding->>'kind' = 'document'
        `;
        return { sessions, counts, documents };
      }),
    );
    expect(state.sessions).toEqual([
      {
        artifactVersion: 3,
        goldenSetVersion: 3,
        fixtureDigest: CanonicalGoldenFixtureSha256Hex,
      },
    ]);
    expect(state.counts).toEqual([
      { topology: "general_planner", count: CanonicalGoldenEvaluationSet.cases.length },
      { topology: "specialized", count: CanonicalGoldenEvaluationSet.cases.length },
    ]);
    for (const document of state.documents) {
      const fixtureSource = CanonicalGoldenEvaluationSet.cases
        .flatMap((fixture) => fixture.evidence)
        .find((source) => source.sourceId === document.goldenSourceId);
      expect(fixtureSource?.kind).toBe("document");
      expect(document.durableSourceId).toMatch(/^public:[^:\s]+$/u);
      expect(document.text.startsWith(fixtureSource!.content)).toBe(true);
      expect(document.text.slice(fixtureSource!.content.length).trim()).toBe("");
    }
    const manifest = await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const rows = yield* sql<{ readonly value: unknown }>`
          select seed_manifest as value from ai_evaluation_case_runs
          where session_id = ${sessionId}
            and jsonb_array_length(seed_manifest->'sourceBindings') > 0
          order by case_id, topology limit 1
        `;
        return rows[0]!.value;
      }),
    );
    const unknownManifestRoot = structuredClone(manifest) as Record<string, unknown>;
    unknownManifestRoot.forgedRootField = true;
    expect(() => EvaluationSeedManifestSchema.parse(unknownManifestRoot)).toThrow();
    const unknownManifestNested = structuredClone(manifest) as {
      readonly sourceBindings: Array<Record<string, unknown>>;
    };
    unknownManifestNested.sourceBindings[0]!.forgedNestedField = true;
    expect(() => EvaluationSeedManifestSchema.parse(unknownManifestNested)).toThrow();
  }, 120_000);

  it("runs the real specialized handler graph with deterministic provider evidence that remains capture-ineligible", async () => {
    const config = canonicalEvaluationWorkerConfig({
      nodeEnv: "test",
      aiE2eFakeProvider: true,
    });
    const manifest = await executeFocusedProductionGraphCase(
      deterministicProductionGraphSessionId,
      config,
    );
    const document = manifest.sourceBindings.find((binding) => binding.kind === "document");
    if (document === undefined)
      throw new Error("focused deterministic document binding is missing");
    const evidence = await focusedProductionRuntimeEvidence(manifest.aiRunId);
    assertFocusedTurboRuntimeEvidence(evidence, "deterministic_test", document);
    await expect(
      attestEvaluationCaseFromDurableRun(
        isolatedDatabaseUrl(),
        deterministicProductionGraphSessionId,
        focusedProductionCaseId,
        "specialized",
      ),
    ).rejects.toThrow(/not exclusively backed by real Z\.AI usage/u);
    await abortFocusedEvaluationSession(
      isolatedDatabaseUrl(),
      deterministicProductionGraphSessionId,
    );
  }, 180_000);

  it("finalizes an isolated deterministic memory turn with bound citation evidence", async () => {
    const config = canonicalEvaluationWorkerConfig({
      nodeEnv: "test",
      aiE2eFakeProvider: true,
    });
    const manifest = await executeFocusedProductionGraphCase(
      deterministicMemoryFinalizationSessionId,
      config,
      "memory-preference-selection-and-update",
    );
    const memoryBinding = manifest.sourceBindings.find((binding) => binding.kind === "memory");
    if (memoryBinding === undefined) throw new Error("deterministic memory binding is missing");
    const evidence = await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const [run] = yield* sql<{
          readonly finishedAt: Date | null;
          readonly failedAt: Date | null;
          readonly errorCode: string | null;
          readonly assistantMessageId: string;
        }>`
          select finished_at as "finishedAt", failed_at as "failedAt", error_code as "errorCode",
                 assistant_message_id::text as "assistantMessageId"
          from ai_runs where id = ${manifest.aiRunId}
        `;
        const citations = yield* sql<{ readonly payload: Record<string, unknown> }>`
          select payload from ai_observations
          where run_id = ${manifest.aiRunId} and kind = 'citation'
          order by observation_key
        `;
        const sources = yield* sql<{
          readonly sourceKey: string;
          readonly kind: string;
          readonly locator: Record<string, unknown>;
          readonly memoryRevisionId: string | null;
        }>`
          select source_key as "sourceKey", kind, locator,
                 memory_revision_id::text as "memoryRevisionId"
          from assistant_message_sources
          where assistant_message_id = (select assistant_message_id from ai_runs where id = ${manifest.aiRunId})
          order by source_key
        `;
        const uses = yield* sql<{
          readonly sourceKey: string;
          readonly consumerTaskId: string;
          readonly topicId: string | null;
          readonly contextOrder: number;
          readonly ranges: readonly { readonly charStart: number; readonly charEnd: number }[];
        }>`
          select source_key as "sourceKey", consumer_task_id as "consumerTaskId",
                 topic_id as "topicId", context_order as "contextOrder", ranges
          from assistant_message_source_uses
          where assistant_message_id = (select assistant_message_id from ai_runs where id = ${manifest.aiRunId})
          order by source_key, context_order
        `;
        const revisions = yield* sql<{
          readonly id: string;
          readonly memoryId: string;
          readonly action: string;
          readonly stateAfter: {
            readonly kind: string;
            readonly content: string;
            readonly deleted: boolean;
          };
        }>`
          select id::text as id, memory_id::text as "memoryId", action,
                 state_after as "stateAfter"
          from user_memory_revisions where run_id = ${manifest.aiRunId}
          order by created_at, id
        `;
        const [memory] = yield* sql<{
          readonly memoryId: string;
          readonly headRevisionId: string;
          readonly content: string;
        }>`
          select id::text as "memoryId", head_revision_id::text as "headRevisionId", content
          from user_memories where id = ${memoryBinding.memoryId}
        `;
        return { run, citations, sources, uses, revisions, memory };
      }),
    );
    const run = evidence.run;
    if (run === undefined) throw new Error("deterministic memory run is missing");
    expect(run).toEqual({
      finishedAt: expect.any(Date),
      failedAt: null,
      errorCode: null,
      assistantMessageId: expect.any(String),
    });
    expect(evidence.citations).toHaveLength(1);
    expect(evidence.sources).toHaveLength(1);
    expect(evidence.uses).toHaveLength(1);
    const citation = evidence.citations[0]!.payload;
    const source = evidence.sources[0]!;
    expect(citation).toMatchObject({
      assistantMessageId: run.assistantMessageId,
      sourceKey: source.sourceKey,
    });
    expect(source).toMatchObject({
      kind: "memory",
      memoryRevisionId: memoryBinding.memoryRevisionId,
      locator: {
        kind: "memory",
        memoryId: memoryBinding.memoryId,
        memoryRevisionId: memoryBinding.memoryRevisionId,
      },
    });
    expect(evidence.uses[0]).toMatchObject({
      sourceKey: source.sourceKey,
      consumerTaskId: "single-answer",
      topicId: null,
      contextOrder: 0,
      ranges: [],
    });
    expect(evidence.revisions).toEqual([
      {
        id: expect.any(String),
        memoryId: memoryBinding.memoryId,
        action: "update",
        stateAfter: {
          kind: "preference",
          content: "Prefer concise answers in French and report energy quantities in MWh.",
          deleted: false,
        },
      },
    ]);
    const revision = evidence.revisions[0]!;
    expect(evidence.memory).toEqual({
      memoryId: memoryBinding.memoryId,
      headRevisionId: revision.id,
      content: revision.stateAfter.content,
    });
    await abortFocusedEvaluationSession(
      isolatedDatabaseUrl(),
      deterministicMemoryFinalizationSessionId,
    );
  }, 180_000);

  it("runs the real general-planner Smithers workflow on the shared Postgres input schema", async () => {
    const manifest = await beginFocusedGeneralPlannerCase(
      deterministicGeneralPlannerSessionId,
      focusedClarificationCaseId,
      "deterministic_test",
    );
    const config = canonicalEvaluationWorkerConfig({
      nodeEnv: "test",
      aiE2eFakeProvider: true,
    });
    await executeGeneralPlannerEvaluationCase(
      isolatedDatabaseUrl(),
      deterministicGeneralPlannerSessionId,
      focusedClarificationCaseId,
      config,
      { testOnlyAllowDeterministicProvider: true },
    );

    const smithersRunId = `ai-evaluation-general-planner:${deterministicGeneralPlannerSessionId}:${focusedClarificationCaseId}`;
    const state = await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const [run] = yield* sql<{
          readonly finishedAt: Date | null;
          readonly failedAt: Date | null;
          readonly errorCode: string | null;
          readonly smithersRunId: string | null;
        }>`
          select finished_at as "finishedAt", failed_at as "failedAt",
                 error_code as "errorCode", smithers_run_id as "smithersRunId"
          from ai_runs where id = ${manifest.aiRunId}
        `;
        const [caseRun] = yield* sql<{
          readonly status: string;
          readonly output: unknown;
        }>`
          select status, execution_output as output
          from ai_evaluation_case_runs
          where session_id = ${deterministicGeneralPlannerSessionId}
            and case_id = ${focusedClarificationCaseId}
            and topology = 'general_planner'
        `;
        const usage = yield* sql<{ readonly providerServiceId: string }>`
          select provider_service_id as "providerServiceId"
          from ai_run_usage where run_id = ${manifest.aiRunId}
        `;
        const inputColumns = yield* sql<{ readonly name: string }>`
          select column_name as name from information_schema.columns
          where table_schema = 'public' and table_name = 'input'
          order by ordinal_position
        `;
        return { run, caseRun, usage, inputColumns };
      }),
    );

    expect(state.run).toMatchObject({
      finishedAt: expect.any(Date),
      failedAt: null,
      errorCode: null,
      smithersRunId,
    });
    expect(state.caseRun).toMatchObject({
      status: "running",
      output: {
        planTurn: { mode: "clarify" },
        selectedSources: [],
      },
    });
    expect(new Set(state.usage.map((row) => row.providerServiceId))).toEqual(
      new Set(["deterministic_test"]),
    );
    expect(state.inputColumns.map((column) => column.name)).not.toContain("case_id");
    expect(await smithersRowsForRun(smithersRunId)).toEqual([]);
    await expect(
      attestEvaluationCaseFromDurableRun(
        isolatedDatabaseUrl(),
        deterministicGeneralPlannerSessionId,
        focusedClarificationCaseId,
        "general_planner",
      ),
    ).rejects.toThrow(/not exclusively backed by real Z\.AI usage/u);
    await abortFocusedEvaluationSession(
      isolatedDatabaseUrl(),
      deterministicGeneralPlannerSessionId,
    );
  }, 180_000);

  it("seals a deterministic general-planner fanout baseline with synthesis context", async () => {
    const manifest = await beginFocusedGeneralPlannerCase(
      deterministicGeneralPlannerFanoutSessionId,
      focusedFanoutCaseId,
      "deterministic_test",
    );
    const config = canonicalEvaluationWorkerConfig({
      nodeEnv: "test",
      aiE2eFakeProvider: true,
    });
    await executeGeneralPlannerEvaluationCase(
      isolatedDatabaseUrl(),
      deterministicGeneralPlannerFanoutSessionId,
      focusedFanoutCaseId,
      config,
      { testOnlyAllowDeterministicProvider: true },
    );
    const state = await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const [caseRun] = yield* sql<{ readonly output: unknown }>`
          select execution_output as output
          from ai_evaluation_case_runs
          where session_id = ${deterministicGeneralPlannerFanoutSessionId}
            and case_id = ${focusedFanoutCaseId}
            and topology = 'general_planner'
        `;
        const events = yield* sql<{ readonly type: string; readonly mode: string | null }>`
          select event->>'type' as type, event->>'mode' as mode
          from ai_run_events
          where run_id = ${manifest.aiRunId} and event->>'type' = 'context_ready'
        `;
        return { caseRun, events };
      }),
    );
    if (state.caseRun === undefined) throw new Error("focused fanout case run is missing");
    expect(state.caseRun.output).toMatchObject({
      planTurn: {
        mode: "fanout",
        topics: [{ topicId: "t1" }, { topicId: "t2" }, { topicId: "t3" }],
      },
    });
    expect(state.events).toEqual([{ type: "context_ready", mode: "synthesis" }]);
    await abortFocusedEvaluationSession(
      isolatedDatabaseUrl(),
      deterministicGeneralPlannerFanoutSessionId,
    );
  }, 180_000);

  it("sweeps aged baseline input and output rows from the default retention inventory", async () => {
    const manifest = await beginFocusedGeneralPlannerCase(
      baselineRetentionSessionId,
      focusedClarificationCaseId,
    );
    const smithersRunId = `ai-evaluation-general-planner:${baselineRetentionSessionId}:${focusedClarificationCaseId}`;
    const storage = await createSmithersStorage(aiEvaluationGeneralPlannerSchemas, {
      connectionString: isolatedDatabaseUrl(),
    });
    try {
      await runDb(
        isolatedDatabaseUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            update ai_runs
            set smithers_run_id = ${smithersRunId},
                started_at = now() - interval '2 days',
                failed_at = now() - interval '2 days',
                error_code = 'finalization_failed',
                retryable = true
            where id = ${manifest.aiRunId}
          `;
          yield* sql`
            insert into input (run_id, ai_run_id)
            values (${smithersRunId}, ${manifest.aiRunId})
          `;
          yield* sql`
            insert into ai_evaluation_general_planner (run_id, node_id, iteration, value)
            values (
              ${smithersRunId},
              'evaluation-general-planner',
              0,
              ${JSON.stringify({
                planTurn: { mode: "clarify", question: "test" },
                selectedSources: [],
                answerContent: "test",
                citationSourceIds: [],
                memoryProposals: [],
              })}::jsonb
            )
          `;
        }),
      );
    } finally {
      await storage.close();
    }

    expect(await smithersRowsForRun(smithersRunId)).toEqual([
      "ai_evaluation_general_planner",
      "input",
    ]);

    await expect(runDb(isolatedDatabaseUrl(), sweepAiChatSmithersRows(10))).resolves.toMatchObject({
      deletedRuns: 1,
      selectedCandidates: 1,
    });
    expect(await smithersRowsForRun(smithersRunId)).toEqual([]);
  }, 120_000);

  it("aborts a focused success without changing it or leaving active siblings", async () => {
    const manifest = await beginFocusedGeneralPlannerCase(
      focusedAbortSessionId,
      focusedClarificationCaseId,
      "deterministic_test",
    );
    await executeGeneralPlannerEvaluationCase(
      isolatedDatabaseUrl(),
      focusedAbortSessionId,
      focusedClarificationCaseId,
      canonicalEvaluationWorkerConfig({ nodeEnv: "test", aiE2eFakeProvider: true }),
      { testOnlyAllowDeterministicProvider: true },
    );
    await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const rows = yield* sql<{ readonly id: string }>`
          update ai_evaluation_case_runs
          set status = 'succeeded', run_evidence_sha256_hex = ${"f".repeat(64)},
              finished_at = now(), updated_at = now()
          where session_id = ${focusedAbortSessionId}
            and case_id = ${focusedClarificationCaseId}
            and topology = 'general_planner' and status = 'running'
          returning ai_run_id::text as id
        `;
        if (rows.length !== 1 || rows[0]?.id !== manifest.aiRunId) {
          return yield* Effect.fail(new Error("focused success fixture transition was not exact"));
        }
      }),
    );

    await abortFocusedEvaluationSession(isolatedDatabaseUrl(), focusedAbortSessionId);
    await abortFocusedEvaluationSession(isolatedDatabaseUrl(), focusedAbortSessionId);

    const state = await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const [session] = yield* sql<{
          readonly status: string;
          readonly failureReason: string | null;
        }>`
          select status, failure_reason as "failureReason"
          from ai_evaluation_sessions where id = ${focusedAbortSessionId}
        `;
        const statuses = yield* sql<{ readonly status: string; readonly count: number }>`
          select status, count(*)::int as count
          from ai_evaluation_case_runs where session_id = ${focusedAbortSessionId}
          group by status order by status
        `;
        const [runs] = yield* sql<{
          readonly started: number;
          readonly terminal: number;
        }>`
          select count(*) filter (where product.started_at is not null)::int as started,
                 count(*) filter (
                   where product.finished_at is not null or product.failed_at is not null
                 )::int as terminal
          from ai_evaluation_case_runs cases
          join ai_runs product on product.id = cases.ai_run_id
          where cases.session_id = ${focusedAbortSessionId}
        `;
        return { session, statuses, runs };
      }),
    );
    expect(state).toEqual({
      session: {
        status: "failed",
        failureReason: `specialized/${focusedClarificationCaseId}:evaluation_case_execution_failed`,
      },
      statuses: [
        { status: "failed", count: CanonicalGoldenEvaluationSet.cases.length * 2 - 1 },
        { status: "succeeded", count: 1 },
      ],
      runs: {
        started: CanonicalGoldenEvaluationSet.cases.length * 2,
        terminal: CanonicalGoldenEvaluationSet.cases.length * 2,
      },
    });
  }, 180_000);

  it("terminalizes a failed general-planner product run before failing its case and cleaning Smithers", async () => {
    const manifest = await beginFocusedGeneralPlannerCase(
      failedGeneralPlannerSessionId,
      focusedProductionCaseId,
      "deterministic_test",
    );
    const config = canonicalEvaluationWorkerConfig({
      nodeEnv: "test",
      aiE2eFakeProvider: true,
    });
    await expect(
      executeGeneralPlannerEvaluationCase(
        isolatedDatabaseUrl(),
        failedGeneralPlannerSessionId,
        focusedProductionCaseId,
        config,
        { testOnlyAllowDeterministicProvider: true, testOnlyForceProviderFailure: true },
      ),
    ).rejects.toThrow();

    const smithersRunId = `ai-evaluation-general-planner:${failedGeneralPlannerSessionId}:${focusedProductionCaseId}`;
    const state = await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const [run] = yield* sql<{
          readonly startedAt: Date | null;
          readonly finishedAt: Date | null;
          readonly failedAt: Date | null;
          readonly errorCode: string | null;
          readonly retryable: boolean | null;
        }>`
          select started_at as "startedAt", finished_at as "finishedAt",
                 failed_at as "failedAt", error_code as "errorCode", retryable
          from ai_runs where id = ${manifest.aiRunId}
        `;
        const [caseRun] = yield* sql<{
          readonly status: string;
          readonly failureReason: string | null;
        }>`
          select status, failure_reason as "failureReason"
          from ai_evaluation_case_runs
          where session_id = ${failedGeneralPlannerSessionId}
            and case_id = ${focusedProductionCaseId}
            and topology = 'general_planner'
        `;
        const [session] = yield* sql<{
          readonly status: string;
          readonly failureReason: string | null;
        }>`
          select status, failure_reason as "failureReason"
          from ai_evaluation_sessions where id = ${failedGeneralPlannerSessionId}
        `;
        const [terminalChildren] = yield* sql<{
          readonly caseCount: number;
          readonly failedCaseCount: number;
          readonly startedRunCount: number;
          readonly terminalRunCount: number;
        }>`
          select count(*)::int as "caseCount",
                 count(*) filter (where cases.status = 'failed')::int as "failedCaseCount",
                 count(*) filter (where runs.started_at is not null)::int as "startedRunCount",
                 count(*) filter (
                   where runs.finished_at is not null or runs.failed_at is not null
                 )::int as "terminalRunCount"
          from ai_evaluation_case_runs cases
          join ai_runs runs on runs.id = cases.ai_run_id
          where cases.session_id = ${failedGeneralPlannerSessionId}
        `;
        return { run, caseRun, session, terminalChildren };
      }),
    );

    expect(state.run).toEqual({
      startedAt: expect.any(Date),
      finishedAt: null,
      failedAt: expect.any(Date),
      errorCode: "finalization_failed",
      retryable: true,
    });
    expect(state.caseRun).toEqual({
      status: "failed",
      failureReason: "evaluation_case_execution_failed",
    });
    expect(state.session).toEqual({
      status: "failed",
      failureReason: `general_planner/${focusedProductionCaseId}:evaluation_case_execution_failed`,
    });
    expect(state.terminalChildren).toEqual({
      caseCount: CanonicalGoldenEvaluationSet.cases.length * 2,
      failedCaseCount: CanonicalGoldenEvaluationSet.cases.length * 2,
      startedRunCount: CanonicalGoldenEvaluationSet.cases.length * 2,
      terminalRunCount: CanonicalGoldenEvaluationSet.cases.length * 2,
    });
    expect(await smithersRowsForRun(smithersRunId)).toEqual([]);
  }, 180_000);

  it("resumes a crashed failure cascade exactly once from its immutable failed origin", async () => {
    const manifest = await beginFocusedGeneralPlannerCase(
      crashResumeFailureSessionId,
      focusedProductionCaseId,
    );
    await ensureEvaluationCaseRunning(isolatedDatabaseUrl(), {
      sessionId: crashResumeFailureSessionId,
      caseId: manifest.caseId,
      topology: manifest.topology,
      aiRunId: manifest.aiRunId,
    });
    await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* markAiRunStarted(manifest.aiRunId);
        yield* failAiRun(manifest.aiRunId, "finalization_failed");
        const failed = yield* sql<{ readonly id: string }>`
          update ai_evaluation_case_runs
          set status = 'failed', failure_reason = 'evaluation_case_execution_failed',
              finished_at = now(), updated_at = now()
          where session_id = ${crashResumeFailureSessionId}
            and case_id = ${manifest.caseId}
            and topology = ${manifest.topology}
            and status = 'running'
          returning ai_run_id::text as id
        `;
        if (failed.length !== 1) {
          return yield* Effect.fail(new Error("crash fixture origin transition was not exact"));
        }
      }),
    );

    await recoverFailedEvaluationSessionChildren(
      isolatedDatabaseUrl(),
      crashResumeFailureSessionId,
    );
    await recoverFailedEvaluationSessionChildren(
      isolatedDatabaseUrl(),
      crashResumeFailureSessionId,
    );

    const state = await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const [session] = yield* sql<{
          readonly status: string;
          readonly failureReason: string | null;
        }>`
          select status, failure_reason as "failureReason"
          from ai_evaluation_sessions where id = ${crashResumeFailureSessionId}
        `;
        const [origin] = yield* sql<{
          readonly status: string;
          readonly failureReason: string | null;
        }>`
          select status, failure_reason as "failureReason"
          from ai_evaluation_case_runs
          where session_id = ${crashResumeFailureSessionId}
            and case_id = ${manifest.caseId}
            and topology = ${manifest.topology}
        `;
        const [terminalChildren] = yield* sql<{
          readonly caseCount: number;
          readonly failedCaseCount: number;
          readonly startedRunCount: number;
          readonly terminalRunCount: number;
          readonly startedEventCount: number;
          readonly terminalEventCount: number;
        }>`
          select count(distinct cases.ai_run_id)::int as "caseCount",
                 count(distinct cases.ai_run_id) filter (
                   where cases.status = 'failed'
                 )::int as "failedCaseCount",
                 count(distinct cases.ai_run_id) filter (
                   where runs.started_at is not null
                 )::int as "startedRunCount",
                 count(distinct cases.ai_run_id) filter (
                   where runs.finished_at is not null or runs.failed_at is not null
                 )::int as "terminalRunCount",
                 count(events.id) filter (
                   where events.emission_key = 'run_started'
                 )::int as "startedEventCount",
                 count(events.id) filter (
                   where events.emission_key = 'terminal'
                 )::int as "terminalEventCount"
          from ai_evaluation_case_runs cases
          join ai_runs runs on runs.id = cases.ai_run_id
          left join ai_run_events events on events.run_id = cases.ai_run_id
          where cases.session_id = ${crashResumeFailureSessionId}
        `;
        return { session, origin, terminalChildren };
      }),
    );
    const childCount = CanonicalGoldenEvaluationSet.cases.length * 2;
    expect(state.session).toEqual({
      status: "failed",
      failureReason: `general_planner/${focusedProductionCaseId}:evaluation_case_execution_failed`,
    });
    expect(state.origin).toEqual({
      status: "failed",
      failureReason: "evaluation_case_execution_failed",
    });
    expect(state.terminalChildren).toEqual({
      caseCount: childCount,
      failedCaseCount: childCount,
      startedRunCount: childCount,
      terminalRunCount: childCount,
      startedEventCount: childCount,
      terminalEventCount: childCount,
    });
  }, 180_000);

  it("terminalizes the immutable child when baseline launch fails before its inner failure path", async () => {
    const manifest = await beginFocusedGeneralPlannerCase(
      preLaunchFailedGeneralPlannerSessionId,
      focusedClarificationCaseId,
    );
    const staleSmithersRunId = `forged-general-planner:${manifest.aiRunId}`;
    await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update ai_runs set smithers_run_id = ${staleSmithersRunId}
          where id = ${manifest.aiRunId}
        `;
      }),
    );

    await expect(
      executeGeneralPlannerEvaluationCase(
        isolatedDatabaseUrl(),
        preLaunchFailedGeneralPlannerSessionId,
        focusedClarificationCaseId,
        canonicalEvaluationWorkerConfig(),
      ),
    ).rejects.toThrow(/different Smithers identity/u);

    const state = await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const [run] = yield* sql<{
          readonly startedAt: Date | null;
          readonly failedAt: Date | null;
          readonly errorCode: string | null;
          readonly smithersRunId: string | null;
        }>`
          select started_at as "startedAt", failed_at as "failedAt",
                 error_code as "errorCode", smithers_run_id as "smithersRunId"
          from ai_runs where id = ${manifest.aiRunId}
        `;
        const [caseRun] = yield* sql<{ readonly status: string }>`
          select status from ai_evaluation_case_runs
          where session_id = ${preLaunchFailedGeneralPlannerSessionId}
            and case_id = ${focusedClarificationCaseId}
            and topology = 'general_planner'
        `;
        const [session] = yield* sql<{ readonly status: string }>`
          select status from ai_evaluation_sessions
          where id = ${preLaunchFailedGeneralPlannerSessionId}
        `;
        return { run, caseRun, session };
      }),
    );
    expect(state.run).toEqual({
      startedAt: expect.any(Date),
      failedAt: expect.any(Date),
      errorCode: "finalization_failed",
      smithersRunId: staleSmithersRunId,
    });
    expect(state.caseRun).toEqual({ status: "failed" });
    expect(state.session).toEqual({ status: "failed" });
    expect(await smithersRowsForRun(staleSmithersRunId)).toEqual([]);
  }, 180_000);

  it.skipIf(!liveCaptureEnabled)(
    "captures one production specialized handler run backed by the opt-in live provider",
    async () => {
      if (liveCaptureApiKey === undefined || liveCaptureApiKey.length === 0) {
        throw new Error("live capture API key is missing");
      }
      const config = canonicalEvaluationWorkerConfig({
        nodeEnv: "test",
        aiE2eFakeProvider: false,
        zaiApiKey: liveCaptureApiKey,
      });
      const manifest = await executeFocusedProductionGraphCase(
        liveProductionCaptureSessionId,
        config,
      );
      const document = manifest.sourceBindings.find((binding) => binding.kind === "document");
      if (document === undefined) throw new Error("focused live document binding is missing");
      const evidence = await focusedProductionRuntimeEvidence(manifest.aiRunId);
      assertFocusedTurboRuntimeEvidence(evidence, "zai_coding_plan_official", document);

      await attestEvaluationCaseFromDurableRun(
        isolatedDatabaseUrl(),
        liveProductionCaptureSessionId,
        focusedProductionCaseId,
        "specialized",
      );
      await abortFocusedEvaluationSession(isolatedDatabaseUrl(), liveProductionCaptureSessionId);
      const fixture = CanonicalGoldenEvaluationSet.cases.find(
        (candidate) => candidate.id === focusedProductionCaseId,
      );
      if (fixture === undefined) throw new Error("focused live golden fixture is missing");
      await bindEvaluationCaseAnnotation(isolatedDatabaseUrl(), liveProductionCaptureSessionId, {
        caseId: focusedProductionCaseId,
        topology: "specialized",
        claims: fixture.labels.supportedClaims.map((claim) => ({
          claimId: claim.claimId,
          citedSourceIds: [claim.supportingSourceIds[0]!],
        })),
        reportedGapIds: fixture.labels.expectedGaps.map((gap) => gap.gapId),
      });
      const captured = await captureEvaluationCase(
        isolatedDatabaseUrl(),
        liveProductionCaptureSessionId,
        focusedProductionCaseId,
        "specialized",
      );
      if (captured.topology !== "specialized") {
        throw new Error("focused live capture returned the wrong topology");
      }
      expect(captured.capture.origin).toBe("real_provider_turn");
      expect(captured.capture.modelIds).toEqual(["glm-5-turbo"]);
      expect(captured.pulledSourceIds).toEqual([document.goldenSourceId]);
      expect(captured.serializedSourceIds).toEqual([document.goldenSourceId]);
      if (
        captured.productionContext.mode !== "single_fit" &&
        captured.productionContext.mode !== "single_reduced"
      ) {
        throw new Error("focused live capture did not retain the expected single-answer topology");
      }
      expect(captured.productionContext.terminal.ledger.modelId).toBe("glm-5-turbo");
      if (captured.productionContext.terminal.ledger.requestKind !== "direct") {
        throw new Error("focused live capture terminal ledger is not direct");
      }
      expect(captured.productionContext.terminal.ledger.sources).toEqual([
        expect.objectContaining({
          candidateId: namespacedDocumentEvidenceIdentity(document.source, document.documentId),
          sourceId: document.goldenSourceId,
        }),
      ]);
    },
    300_000,
  );

  it("serializes concurrent session leases and concurrent idempotent seeding", async () => {
    await createEvaluationSession(isolatedDatabaseUrl(), concurrentSeedSessionId);
    const seeded = await Promise.all([
      seedEvaluationSession(isolatedDatabaseUrl(), concurrentSeedSessionId),
      seedEvaluationSession(isolatedDatabaseUrl(), concurrentSeedSessionId),
      seedEvaluationSession(isolatedDatabaseUrl(), concurrentSeedSessionId),
    ]);
    expect(seeded[1]).toEqual(seeded[0]);
    expect(seeded[2]).toEqual(seeded[0]);
    expect(seeded[0]).toHaveLength(CanonicalGoldenEvaluationSet.cases.length * 2);

    let active = 0;
    let maximumActive = 0;
    const visits: number[] = [];
    await Promise.all(
      [0, 1, 2].map((index) =>
        withEvaluationSessionExecutionLease(
          isolatedDatabaseUrl(),
          concurrentSeedSessionId,
          async () => {
            active += 1;
            maximumActive = Math.max(maximumActive, active);
            visits.push(index);
            await new Promise<void>((resolve) => setTimeout(resolve, 10));
            active -= 1;
          },
        ),
      ),
    );
    expect(maximumActive).toBe(1);
    expect(visits).toHaveLength(3);

    await expect(
      withEvaluationSessionExecutionLease(
        isolatedDatabaseUrl(),
        concurrentSeedSessionId,
        async () => {
          throw new Error("lease failure sentinel");
        },
      ),
    ).rejects.toThrow("lease failure sentinel");
    await expect(
      withEvaluationSessionExecutionLease(
        isolatedDatabaseUrl(),
        concurrentSeedSessionId,
        async () => "released",
      ),
    ).resolves.toBe("released");
  }, 120_000);

  it("keeps the thirteenth turn outside C while A can search and inspect its assistant message", async () => {
    const fixture = CanonicalGoldenEvaluationSet.cases.find(
      (candidate) => candidate.id === "long-history-older-chat-evidence",
    );
    if (fixture === undefined) throw new Error("older-chat fixture is missing");
    const row = await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const rows = yield* sql<{ readonly runId: string; readonly seedManifest: unknown }>`
          select ai_run_id::text as "runId", seed_manifest as "seedManifest"
          from ai_evaluation_case_runs
          where session_id = ${sessionId} and case_id = ${fixture.id}
            and topology = 'specialized'
        `;
        return rows[0]!;
      }),
    );
    const manifest = EvaluationSeedManifestSchema.parse(row.seedManifest);
    const oldTurn = manifest.turnBindings.find((binding) => binding.turnId === "turn-old-storage");
    if (oldTurn === undefined) throw new Error("old evaluation turn is not bound");
    await runDb(isolatedDatabaseUrl(), markAiRunStarted(row.runId));

    const operations = new CanonicalWorkflowOperations(
      isolatedDatabaseUrl(),
      canonicalAiConfig,
      new OlderChatEvaluationAgent(oldTurn.assistantMessageId),
    );
    const load = await inAiTask(row.runId, "load-turn", () => operations.loadTurn(row.runId));
    expect(load.userMessageId).toBe(manifest.userMessageId);
    expect(load.aiRunId).toBe(row.runId);
    await expect(
      inAiTask(row.runId, "single-retrieve-internal", () =>
        operations.retrieveInternal(load, fixture.currentMessage, "single-retrieve-internal", []),
      ),
    ).resolves.toEqual([
      {
        kind: "chat_message",
        messageId: oldTurn.assistantMessageId,
        purpose: "recover the older storage-pilot result",
      },
    ]);
    expect(fixture.labels.relevantTurnIds).toEqual([]);
  }, 120_000);

  it("resumes an already-running case and does not seal a baseline before its output binding", async () => {
    await createEvaluationSession(isolatedDatabaseUrl(), resumeSessionId);
    await seedEvaluationSession(isolatedDatabaseUrl(), resumeSessionId);
    const row = await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update ai_evaluation_sessions
          set status = 'running',
              execution_config_sha256_hex = ${canonicalSha256Hex(CanonicalEvaluationExecutionConfig)},
              provider_endpoint_identity = ${TINYFISH_SEARCH_PROVIDER_ENDPOINT_IDENTITY}
          where id = ${resumeSessionId}
        `;
        const rows = yield* sql<{
          readonly sessionId: string;
          readonly caseId: string;
          readonly topology: "specialized" | "general_planner";
          readonly aiRunId: string;
        }>`
          select session_id::text as "sessionId", case_id as "caseId", topology,
                 ai_run_id::text as "aiRunId"
          from ai_evaluation_case_runs where session_id = ${resumeSessionId}
          order by case_id, topology limit 1
        `;
        return rows[0]!;
      }),
    );
    await ensureEvaluationCaseRunning(isolatedDatabaseUrl(), row);
    const firstStartedAt = await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const rows = yield* sql<{ readonly startedAt: Date }>`
          select started_at as "startedAt" from ai_evaluation_case_runs
          where session_id = ${resumeSessionId} and case_id = ${row.caseId}
            and topology = ${row.topology}
        `;
        return rows[0]!.startedAt;
      }),
    );
    await ensureEvaluationCaseRunning(isolatedDatabaseUrl(), row);
    const replayState = await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const rows = yield* sql<{ readonly status: string; readonly startedAt: Date }>`
          select status, started_at as "startedAt" from ai_evaluation_case_runs
          where session_id = ${resumeSessionId} and case_id = ${row.caseId}
            and topology = ${row.topology}
        `;
        return rows[0]!;
      }),
    );
    expect(replayState.status).toBe("running");
    expect(replayState.startedAt.toISOString()).toBe(firstStartedAt.toISOString());
    expect(evaluationCaseResumeAction("specialized", false, false)).toBe("resume_workflow");
    expect(evaluationCaseResumeAction("general_planner", true, false)).toBe("resume_workflow");
    expect(evaluationCaseResumeAction("general_planner", true, true)).toBe("seal_evidence");
  }, 120_000);

  it("mounts O through the production candidate path and reduces the real oversized ledger", async () => {
    const fixture = CanonicalGoldenEvaluationSet.cases.find((candidate) =>
      candidate.dimensions.includes("oversized_evidence"),
    );
    if (fixture === undefined) throw new Error("oversized fixture is missing");
    const row = await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const rows = yield* sql<{ readonly runId: string; readonly seedManifest: unknown }>`
          select ai_run_id::text as "runId", seed_manifest as "seedManifest"
          from ai_evaluation_case_runs
          where session_id = ${sessionId} and case_id = ${fixture.id}
            and topology = 'specialized'
        `;
        return rows[0]!;
      }),
    );
    const manifest = EvaluationSeedManifestSchema.parse(row.seedManifest);
    await runDb(isolatedDatabaseUrl(), markAiRunStarted(row.runId));
    const boundary = new OversizedSelectorBoundary();
    const operations = new CanonicalWorkflowOperations(
      isolatedDatabaseUrl(),
      canonicalAiConfig,
      new CanonicalAgentClient(boundary),
    );
    const load = await inAiTask(row.runId, "load-turn", () => operations.loadTurn(row.runId));
    const documentBindings = manifest.sourceBindings.filter(
      (
        binding,
      ): binding is Extract<(typeof manifest.sourceBindings)[number], { kind: "document" }> =>
        binding.kind === "document",
    );
    const internal = await inAiTask(row.runId, "single-retrieve-internal", () =>
      operations.retrieveInternal(load, fixture.currentMessage, "single-retrieve-internal", []),
    );
    const memories = await inAiTask(row.runId, "single-select-memories", () =>
      operations.selectMemories(load, fixture.currentMessage, "single-select-memories"),
    );
    const internalMeasurements = boundary.requestInputTokens.get("internal_retrieval") ?? [];
    const memoryMeasurements = boundary.requestInputTokens.get("memory_selector") ?? [];
    expect(internal).toHaveLength(6);
    if (memories.status !== "enabled") throw new Error("memory selector unexpectedly disabled");
    expect(Array.isArray(memories.entries)).toBe(true);
    expect(memories.entries).toHaveLength(4);
    expect(boundary.discoveredDocumentCount).toBe(6);
    expect(boundary.inspectedDocumentCount).toBe(6);
    expect(boundary.selectedMemoryCount).toBe(4);
    expect(internalMeasurements).toHaveLength(3);
    expect(memoryMeasurements).toHaveLength(2);
    expect(Math.max(...internalMeasurements, ...memoryMeasurements)).toBeLessThanOrEqual(100_000);
    const assembly = await inAiTask(row.runId, "single-assemble", () =>
      operations.assembleContext(
        load,
        fixture.labels.planTurn.mode !== "clarify"
          ? fixture.labels.planTurn.question
          : fixture.currentMessage,
        {
          internal,
          memories: memories.entries,
          memorySelection: memories.status,
          web: [],
          webSelection: "enabled",
        },
        "single-assemble",
        "single-answer",
        undefined,
        [],
      ),
    );
    const oversized = await inAiTask(row.runId, "single-measure", () =>
      operations.measureAssembly(load, assembly, "single-measure"),
    );
    expect(oversized.ledgerCandidates).toHaveLength(10);
    expect(oversized.status).toBe("needs_reduction");
    expect(oversized.inputTokens).toBeGreaterThan(100_000);
    expect(oversized.usableInputTokens).toBe(100_000);
    expect(oversized.reductionRan).toBe(false);
    const preflightTokenSourceSelections = oversized.sourceMap.map((source) => {
      const binding = manifest.sourceBindings.find((candidate) => {
        if (candidate.kind !== source.locator.kind) return false;
        if (candidate.kind === "document" && source.locator.kind === "document") {
          return candidate.versionId === source.locator.versionId;
        }
        if (candidate.kind === "memory" && source.locator.kind === "memory") {
          return candidate.memoryRevisionId === source.locator.memoryRevisionId;
        }
        return false;
      });
      if (binding === undefined) throw new Error("preflight source-key binding is missing");
      return {
        sourceId: evaluationBindingGoldenSourceId(binding),
        sourceKey: source.sourceKey,
        ranges: source.locator.kind === "document" ? source.locator.ranges : [],
      };
    });
    expect(oversized.inputTokens).toBe(
      measureCanonicalProductionEvaluationRequestTokens(
        fixture,
        preflightTokenSourceSelections.map(({ sourceId, ranges }) => ({ sourceId, ranges })),
        preflightTokenSourceSelections.map(({ sourceId, sourceKey }) => ({ sourceId, sourceKey })),
        {
          question:
            fixture.labels.planTurn.mode !== "clarify"
              ? fixture.labels.planTurn.question
              : fixture.currentMessage,
          selectedTurnIds: [],
        },
      ),
    );

    const decisions: readonly ContextDecision[] = oversized.ledgerCandidates.map((candidate) => {
      if (candidate.kind === "memory") {
        return {
          id: candidate.id,
          action: "keep" as const,
          reason: "keep the complete selected saved audit-rule set",
        };
      }
      if (candidate.kind !== "document") throw new Error("unexpected oversized candidate kind");
      const binding = documentBindings.find((item) => item.versionId === candidate.versionId);
      if (binding === undefined) throw new Error("oversized candidate binding is missing");
      const ranges = fixture.labels.acceptableRanges[evaluationBindingGoldenSourceId(binding)];
      if (ranges === undefined) throw new Error("oversized range label is missing");
      return {
        id: candidate.id,
        action: "range" as const,
        ranges,
        reason: "retain the binding regional result and remove routine audit rows",
      };
    });
    boundary.setReductionDecisions(decisions);
    const plan = await inAiTask(row.runId, "single-reduce-plan", () =>
      operations.planReduction(load, oversized, "single-reduce-plan", 1),
    );
    expect(plan.decisions).toEqual(decisions);
    expect(boundary.reductionCandidateHandles).toEqual(
      new Set(decisions.map((_, index) => `opaque_candidate_${index + 1}`)),
    );
    const reducerTerminal = await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const rows = yield* sql<{ readonly payload: unknown }>`
          select payload
          from ai_observations
          where run_id = ${row.runId}
            and emitting_task = 'single-reduce-plan'
            and kind = 'context_reducer_terminal'
          order by created_at desc, id desc
          limit 1
        `;
        return rows[0]?.payload;
      }),
    );
    expect(reducerTerminal).toMatchObject({
      terminalUsageCoordinate: {
        taskId: "single-reduce-plan",
        loopIteration: 0,
        attempt: 1,
        providerRequestIndex: 13,
      },
    });
    const reducerMeasurements = boundary.requestInputTokens.get("context_reducer") ?? [];
    expect(reducerMeasurements).toHaveLength(14);
    expect(Math.max(...reducerMeasurements)).toBeLessThanOrEqual(100_000);
    const reduced = await inAiTask(
      row.runId,
      "single-reduce-measure",
      () => operations.measureReduction(load, oversized, plan, "single-reduce-measure", 1),
      1,
    );
    expect(reduced.status).toBe("ready");
    expect(reduced.inputTokens).toBeLessThanOrEqual(reduced.usableInputTokens);
    expect(reduced.inputTokens).toBeLessThan(oversized.inputTokens * 0.9);
    expect(reduced.reductionRan).toBe(true);
    expect(reduced.sourceMap).toHaveLength(10);
    expect(reduced.inputTokens).toBe(
      measureCanonicalProductionEvaluationRequestTokens(
        fixture,
        fixture.labels.requiredSourceIds.map((sourceId) => ({
          sourceId,
          ranges: fixture.labels.acceptableRanges[sourceId] ?? [],
        })),
        preflightTokenSourceSelections.map(({ sourceId, sourceKey }) => ({ sourceId, sourceKey })),
        {
          question:
            fixture.labels.planTurn.mode !== "clarify"
              ? fixture.labels.planTurn.question
              : fixture.currentMessage,
          selectedTurnIds: [],
        },
      ),
    );
  }, 120_000);

  it("rejects missing, duplicate, extra, and pre-terminal annotation bindings", async () => {
    const complete = completeAnnotations();
    await expect(
      bindEvaluationAnnotations(isolatedDatabaseUrl(), sessionId, {
        ...complete,
        annotations: complete.annotations.slice(1),
      }),
    ).rejects.toThrow(/missing result/u);
    await expect(
      bindEvaluationAnnotations(isolatedDatabaseUrl(), sessionId, {
        ...complete,
        annotations: [...complete.annotations, complete.annotations[0]],
      }),
    ).rejects.toThrow(/duplicates result/u);
    await expect(
      bindEvaluationAnnotations(isolatedDatabaseUrl(), sessionId, {
        ...complete,
        annotations: [
          { ...complete.annotations[0]!, caseId: "not-canonical" },
          ...complete.annotations.slice(1),
        ],
      }),
    ).rejects.toThrow(/unknown result/u);
    await expect(
      bindEvaluationAnnotations(isolatedDatabaseUrl(), sessionId, complete),
    ).rejects.toThrow(/not ready for annotation/u);
  });

  it("rejects malformed relationships, event ownership, and a duplicate start before sealing", async () => {
    await expect(
      completeDurableCaptureSession(
        preSealMessageTamperSessionId,
        "preseal_current_message_author",
      ),
    ).rejects.toThrow(/durable chat\/message scope is invalid/u);
    await expect(
      completeDurableCaptureSession(preSealOwnerTamperSessionId, "preseal_terminal_owner"),
    ).rejects.toThrow(/invalid terminal event ownership/u);
    await expect(
      completeDurableCaptureSession(preSealLedgerTamperSessionId, "preseal_duplicate_run_started"),
    ).rejects.toThrow(/invalid terminal event ownership/u);
  }, 120_000);

  it("uses durable event sequence rather than concurrent wall-clock timestamps", async () => {
    await expect(
      completeDurableCaptureSession(
        invertedEventTimestampSessionId,
        "preseal_event_timestamp_inversion",
      ),
    ).resolves.toBeUndefined();
  }, 120_000);
  it("attests only eligible non-selected conversation retrieval exposures", async () => {
    await expect(
      completeDurableCaptureSession(
        nonselectedChatInspectionSessionId,
        "nonselected_chat_inspection",
      ),
    ).resolves.toBeUndefined();
    await expect(
      completeDurableCaptureSession(
        nonselectedChatSerializedSessionId,
        "nonselected_chat_serialized",
      ),
    ).rejects.toThrow(/unmapped chat_message\/answer_serialized source exposure/u);
    await expect(
      completeDurableCaptureSession(currentChatPreviewSessionId, "current_chat_preview"),
    ).rejects.toThrow(/invalid non-selected conversation exposure/u);
    await expect(
      completeDurableCaptureSession(selectedChatPreviewSessionId, "selected_chat_preview"),
    ).rejects.toThrow(/invalid non-selected conversation exposure/u);
  }, 180_000);

  it("rejects coordinated pre-seal event, source, memory, citation, exposure, routing, and authorization forgeries", async () => {
    const rejectionCases = [
      [
        preSealContextTamperSessionId,
        "preseal_context_payload",
        /context event payload is not exact/u,
      ],
      [preSealDeltaTamperSessionId, "preseal_delta_gap", /text-delta chronology is invalid/u],
      [
        preSealUseTamperSessionId,
        "preseal_coordinated_source_use",
        /Failed to execute statement|assistant message source use identity is immutable|durable source uses are not exact/u,
      ],
      [
        preSealMemoryCreateSessionId,
        "preseal_memory_create_before",
        /applied memory state is not exact/u,
      ],
      [
        preSealMemoryUpdateSessionId,
        "preseal_memory_update_before",
        /applied memory state is not exact/u,
      ],
      [
        preSealCitationInsertSessionId,
        "preseal_citation_insert",
        /Failed to execute statement|append-only|citation observations are not exact/u,
      ],
      [
        preSealCitationChangeSessionId,
        "preseal_citation_change",
        /Failed to execute statement|append-only|citation observations are not exact/u,
      ],
      [
        preSealCitationDeleteSessionId,
        "preseal_citation_delete",
        /Failed to execute statement|append-only|citation observations are not exact/u,
      ],
      [
        preSealExposureCountSessionId,
        "preseal_exposure_count",
        /Failed to execute statement|append-only|source-serialization proof|visible/u,
      ],
      [
        preSealMembershipSessionId,
        "preseal_membership_revoked",
        /current evaluation authorization is invalid/u,
      ],
      [
        preSealUserRecoverySessionId,
        "preseal_user_recovery_deleted",
        /current evaluation authorization is invalid/u,
      ],
      [
        preSealCompanyRecoverySessionId,
        "preseal_company_recovery_deleted",
        /current evaluation authorization is invalid/u,
      ],
      [
        preSealManifestSessionId,
        "preseal_manifest_delete",
        /Failed to execute statement|append-only|manifest cardinality differs/u,
      ],
      [
        preSealResolutionSessionId,
        "preseal_duplicate_resolution",
        /Failed to execute statement|append-only|duplicate terminal turn_plan output/u,
      ],
      [
        preSealMemoryTerminalMismatchSessionId,
        "preseal_terminal_memory_mismatch",
        /Failed to execute statement|append-only|memory event is not exactly reconstructable/u,
      ],
      [
        oversizedMissingInspectionSessionId,
        "oversized_missing_internal_inspection",
        /oversized inspection identity set differs/u,
      ],
      [
        oversizedDuplicateInspectionSessionId,
        "oversized_duplicate_internal_inspection",
        /oversized inspection identity set differs/u,
      ],
      [
        oversizedWrongCoordinateInspectionSessionId,
        "oversized_wrong_coordinate_internal_inspection",
        /oversized inspection identity set differs/u,
      ],
    ] as const;
    for (const [targetSessionId, tamper, expectedError] of rejectionCases) {
      let rejection: unknown;
      try {
        await completeDurableCaptureSession(targetSessionId, tamper);
      } catch (error) {
        rejection = error;
      }
      expect(rejection, `${tamper} unexpectedly resolved`).toBeInstanceOf(Error);
      expect((rejection as Error).message, tamper).toMatch(expectedError);
    }
    await expect(
      completeDurableCaptureSession(preSealMemoryRetrySessionId, "preseal_stale_memory_retry"),
    ).resolves.toBeUndefined();
  }, 120_000);

  it("accepts multiple durable web quotations for one canonical golden source", async () => {
    await completeDurableCaptureSession(multiWebQuoteSessionId, undefined, true);
    await bindEvaluationAnnotations(
      isolatedDatabaseUrl(),
      multiWebQuoteSessionId,
      labeledAnnotations(multiWebQuoteSessionId),
    );
    const suite = await captureEvaluationSession(isolatedDatabaseUrl(), multiWebQuoteSessionId);
    const result = suite.specialized.find(
      (candidate) => candidate.caseId === "cross-cutting-separable-energy-question",
    );
    expect(result?.selectorSelections.W).toEqual(["web:market-price-signal"]);
    expect(result?.pulledSourceIds).toEqual([
      "doc:solar-connections",
      "doc:storage-operations",
      "web:market-price-signal",
    ]);
  }, 120_000);

  it("captures and revalidates the exact durable suite and rejects provenance or annotation tampering", async () => {
    await completeDurableCaptureSession();
    const annotations = labeledAnnotations();
    const duplicateClaims = structuredClone(annotations);
    const firstWithClaim = duplicateClaims.annotations.find((item) => item.claims.length > 0)!;
    firstWithClaim.claims.push(structuredClone(firstWithClaim.claims[0]!));
    await expect(
      bindEvaluationAnnotations(isolatedDatabaseUrl(), captureSessionId, duplicateClaims),
    ).rejects.toThrow(/claim annotation IDs must be unique/u);

    await bindEvaluationAnnotations(isolatedDatabaseUrl(), captureSessionId, annotations);
    await expect(
      bindEvaluationAnnotations(isolatedDatabaseUrl(), captureSessionId, annotations),
    ).resolves.toBeUndefined();
    const changed = structuredClone(annotations);
    const changedClaim = changed.annotations.find((item) => item.claims.length > 0)!.claims[0]!;
    changedClaim.citedSourceIds = [];
    await expect(
      bindEvaluationAnnotations(isolatedDatabaseUrl(), captureSessionId, changed),
    ).rejects.toThrow(/different immutable annotations/u);

    const suite = await captureEvaluationSession(isolatedDatabaseUrl(), captureSessionId);
    expect(suite.specialized).toHaveLength(CanonicalGoldenEvaluationSet.cases.length);
    expect(suite.baseline).toHaveLength(CanonicalGoldenEvaluationSet.cases.length);
    for (const result of [...suite.specialized, ...suite.baseline]) {
      const fixture = CanonicalGoldenEvaluationSet.cases.find(
        (candidate) => candidate.id === result.caseId,
      )!;
      expect(result.pulledSourceIds).toEqual(fixture.labels.requiredSourceIds);
      expect(result.sourceAudit.map((source) => source.sourceId)).toEqual(
        fixture.labels.requiredSourceIds,
      );
    }
    expect(
      evaluateSuite(CanonicalGoldenEvaluationSet, suite.specialized, suite.baseline).caseCount,
    ).toBe(CanonicalGoldenEvaluationSet.cases.length);
    await expect(
      revalidateCapturedArtifacts(
        isolatedDatabaseUrl(),
        captureSessionId,
        suite.specialized,
        suite.baseline,
      ),
    ).resolves.toEqual(suite);
    const forged = structuredClone(suite.specialized);
    forged[0]!.timing.timeToTerminalMs += 1;
    await expect(
      revalidateCapturedArtifacts(isolatedDatabaseUrl(), captureSessionId, forged, suite.baseline),
    ).rejects.toThrow(/does not exactly match/u);
    const unknownRoot = structuredClone(suite.specialized) as unknown as Array<
      Record<string, unknown>
    >;
    unknownRoot[0]!.forgedRootField = true;
    await expect(
      revalidateCapturedArtifacts(
        isolatedDatabaseUrl(),
        captureSessionId,
        unknownRoot,
        suite.baseline,
      ),
    ).rejects.toThrow(/raw specialized artifact does not exactly match/u);
    const unknownNested = structuredClone(suite.specialized) as unknown as Array<
      Record<string, unknown>
    >;
    const nestedResult = unknownNested.find((candidate) => {
      const production = candidate.productionContext as
        | { readonly initial?: { readonly sources?: readonly unknown[] } }
        | undefined;
      return (production?.initial?.sources?.length ?? 0) > 0;
    });
    const nestedProduction = nestedResult?.productionContext as
      | { readonly initial?: { readonly sources?: Array<Record<string, unknown>> } }
      | undefined;
    const nestedSource = nestedProduction?.initial?.sources?.[0];
    if (nestedSource === undefined) throw new Error("captured nested source is missing");
    nestedSource.forgedNestedField = true;
    await expect(
      revalidateCapturedArtifacts(
        isolatedDatabaseUrl(),
        captureSessionId,
        unknownNested,
        suite.baseline,
      ),
    ).rejects.toThrow(/raw specialized artifact does not exactly match/u);
    const forgedSourceKeys = structuredClone(suite.specialized);
    const oversized = forgedSourceKeys.find((result) => result.reduction.required);
    if (
      oversized?.productionContext.mode !== "single_reduced" ||
      oversized.productionContext.initial.sources.length < 2
    ) {
      throw new Error("captured oversized source-key ledger is missing");
    }
    const firstSourceKey = oversized.productionContext.initial.sources[0]!.sourceKey;
    oversized.productionContext.initial.sources[0]!.sourceKey =
      oversized.productionContext.initial.sources[1]!.sourceKey;
    oversized.productionContext.initial.sources[1]!.sourceKey = firstSourceKey;
    await expect(
      revalidateCapturedArtifacts(
        isolatedDatabaseUrl(),
        captureSessionId,
        forgedSourceKeys,
        suite.baseline,
      ),
    ).rejects.toThrow(/does not exactly match/u);

    const tampered = suite.specialized[0]!;
    await expect(
      runDb(
        isolatedDatabaseUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            update ai_run_usage
            set input_tokens = input_tokens + 1, total_tokens = total_tokens + 1
            where run_id = ${tampered.capture.runId}
          `;
        }),
      ),
    ).rejects.toThrow(/Failed to execute statement|append-only/u);
    await expect(
      attestEvaluationCaseFromDurableRun(
        isolatedDatabaseUrl(),
        captureSessionId,
        tampered.caseId,
        "specialized",
      ),
    ).resolves.toBeTypeOf("string");
  }, 120_000);

  it("reconstructs durable document inspections after Smithers transcript deletion", async () => {
    await completeDurableCaptureSession(transcriptReconstructionSessionId);
    await bindEvaluationAnnotations(
      isolatedDatabaseUrl(),
      transcriptReconstructionSessionId,
      labeledAnnotations(transcriptReconstructionSessionId),
    );
    const suite = await captureEvaluationSession(
      isolatedDatabaseUrl(),
      transcriptReconstructionSessionId,
    );
    const captured = suite.specialized[0];
    if (captured === undefined) throw new Error("durable specialized capture is missing");
    const smithersRunId = `ai-chat:${captured.capture.runId}`;

    await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          create table if not exists _smithers_reconstruction_test (
            run_id text primary key,
            transcript text not null
          )
        `;
        yield* sql`
          insert into _smithers_reconstruction_test (run_id, transcript)
          values (${smithersRunId}, 'provider transcript')
        `;
      }),
    );
    expect(await smithersRowsForRun(smithersRunId)).toContain("_smithers_reconstruction_test");

    await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        yield* deleteSmithersRowsForRunWithSchemas({}, smithersRunId);
      }),
    );
    expect(await smithersRowsForRun(smithersRunId)).toEqual([]);

    const storedDocument = await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const rows = yield* sql<{
          readonly documentId: string;
          readonly text: string;
          readonly contentHash: string;
        }>`
          select documents.document_id::text as "documentId",
                 documents.text,
                 documents.content_hash as "contentHash"
          from ai_evaluation_case_runs cases
          cross join lateral jsonb_array_elements(cases.seed_manifest->'sourceBindings') binding
          join public_source_documents documents
            on documents.document_id::text = binding.value->>'documentId'
          where cases.session_id = ${transcriptReconstructionSessionId}
            and binding.value->>'kind' = 'document'
          order by cases.case_id, cases.topology
          limit 1
        `;
        const row = rows[0];
        if (row === undefined) return yield* Effect.fail(new Error("stored document is missing"));
        return row;
      }),
    );
    const forgedText = `${storedDocument.text} forged after transcript deletion`;
    const forgedHash = createHash("sha256").update(forgedText).digest("hex");
    await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          alter table public_source_documents
          drop constraint if exists public_source_documents_content_hash_sha256
        `;
        yield* sql`
          alter table public_source_documents
          disable trigger public_source_documents_protect_text_hash
        `;
        yield* sql`
          update public_source_documents
          set text = ${forgedText}, text_char_count = ${forgedText.length},
              content_hash = ${storedDocument.contentHash}
          where document_id = ${storedDocument.documentId}
        `;
      }),
    );
    try {
      await expect(
        revalidateCapturedArtifacts(
          isolatedDatabaseUrl(),
          transcriptReconstructionSessionId,
          suite.specialized,
          suite.baseline,
        ),
      ).rejects.toThrow(/stored document text\/hash drift/u);

      await runDb(
        isolatedDatabaseUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            update public_source_documents
            set text = ${storedDocument.text},
                text_char_count = ${storedDocument.text.length},
                content_hash = ${forgedHash}
            where document_id = ${storedDocument.documentId}
          `;
        }),
      );
      await expect(
        revalidateCapturedArtifacts(
          isolatedDatabaseUrl(),
          transcriptReconstructionSessionId,
          suite.specialized,
          suite.baseline,
        ),
      ).rejects.toThrow(/stored document text\/hash drift/u);
    } finally {
      await runDb(
        isolatedDatabaseUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            update public_source_documents
            set text = ${storedDocument.text},
                text_char_count = ${storedDocument.text.length},
                content_hash = ${storedDocument.contentHash}
            where document_id = ${storedDocument.documentId}
          `;
          yield* sql`
            alter table public_source_documents
            enable trigger public_source_documents_protect_text_hash
          `;
          yield* sql`
            alter table public_source_documents
            add constraint public_source_documents_content_hash_sha256
            check (content_hash = encode(digest(convert_to(text, 'UTF8'), 'sha256'), 'hex'))
            not valid
          `;
        }),
      );
    }
    await expect(
      revalidateCapturedArtifacts(
        isolatedDatabaseUrl(),
        transcriptReconstructionSessionId,
        suite.specialized,
        suite.baseline,
      ),
    ).resolves.toEqual(suite);
  }, 120_000);

  it("binds the complete accepted run snapshot and durable usage chronology after sealing", async () => {
    await completeDurableCaptureSession(sealedSnapshotTamperSessionId);
    await bindEvaluationAnnotations(
      isolatedDatabaseUrl(),
      sealedSnapshotTamperSessionId,
      labeledAnnotations(sealedSnapshotTamperSessionId),
    );
    const sealed = await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const rows = yield* sql<{
          readonly caseId: string;
          readonly topology: "specialized" | "general_planner";
          readonly runId: string;
          readonly companyId: string;
          readonly chatId: string;
          readonly chatUserId: string;
          readonly alternateChatId: string;
          readonly userMessageId: string;
          readonly initiatingUserId: string;
          readonly locale: "fr-FR" | "en-US";
          readonly market: "FR" | "US";
          readonly acceptanceScope: Record<string, unknown>;
          readonly smithersRunId: string;
          readonly nextEventSeq: number;
          readonly createdAt: Date;
          readonly startedAt: Date;
          readonly finishedAt: Date;
          readonly assistantMessageId: string;
          readonly citationNamespace: string;
          readonly usageId: string;
          readonly usageCreatedAt: Date;
        }>`
          select cases.case_id as "caseId", cases.topology, runs.id::text as "runId",
                 cases.seed_manifest->>'companyId' as "companyId",
                 runs.chat_id::text as "chatId", alternate.chat_id::text as "alternateChatId",
                 runs.user_message_id::text as "userMessageId",
                 runs.initiating_user_id as "initiatingUserId", runs.locale, runs.market,
                 runs.acceptance_scope as "acceptanceScope",
                 runs.smithers_run_id as "smithersRunId",
                 runs.next_event_seq as "nextEventSeq",
                 runs.created_at as "createdAt", runs.started_at as "startedAt",
                 runs.finished_at as "finishedAt",
                 runs.assistant_message_id::text as "assistantMessageId",
                 runs.citation_namespace as "citationNamespace",
                 usage.id::text as "usageId", usage.created_at as "usageCreatedAt"
          from ai_evaluation_case_runs cases
          join ai_runs runs on runs.id = cases.ai_run_id
          join lateral (
            select other_runs.chat_id
            from ai_evaluation_case_runs other_cases
            join ai_runs other_runs on other_runs.id = other_cases.ai_run_id
            where other_cases.session_id = cases.session_id and other_runs.chat_id <> runs.chat_id
            order by other_cases.case_id, other_cases.topology limit 1
          ) alternate on true
          join lateral (
            select id, created_at from ai_run_usage
            where run_id = runs.id order by created_at, id limit 1
          ) usage on true
          where cases.session_id = ${sealedSnapshotTamperSessionId}
            and cases.topology = 'specialized'
            and (runs.acceptance_scope->>'webEnabled')::boolean
          order by cases.case_id limit 1
        `;
        const row = rows[0];
        if (row === undefined) return yield* Effect.fail(new Error("sealed web run is missing"));
        return row;
      }),
    );
    const foreignUserMessageId = crypto.randomUUID();
    const foreignAssistantMessageId = crypto.randomUUID();
    await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          insert into chat_messages (id, chat_id, author, content)
          values (${foreignUserMessageId}, ${sealed.chatId}, 'user', 'foreign sealed user input')
        `;
        yield* sql`
          insert into chat_messages (id, chat_id, author, content)
          values (${foreignAssistantMessageId}, ${sealed.chatId}, 'assistant', 'foreign assistant')
        `;
      }),
    );
    type SealedRunSnapshot = Pick<
      typeof sealed,
      | "chatId"
      | "userMessageId"
      | "initiatingUserId"
      | "locale"
      | "market"
      | "acceptanceScope"
      | "smithersRunId"
      | "nextEventSeq"
      | "createdAt"
      | "startedAt"
      | "finishedAt"
      | "assistantMessageId"
      | "citationNamespace"
    >;
    const original: SealedRunSnapshot = sealed;
    const writeRun = (snapshot: SealedRunSnapshot) =>
      runDb(
        isolatedDatabaseUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            update ai_runs
            set chat_id = ${snapshot.chatId}, user_message_id = ${snapshot.userMessageId},
                initiating_user_id = ${snapshot.initiatingUserId}, locale = ${snapshot.locale},
                market = ${snapshot.market}, acceptance_scope = ${JSON.stringify(snapshot.acceptanceScope)}::jsonb,
                smithers_run_id = ${snapshot.smithersRunId},
                next_event_seq = ${snapshot.nextEventSeq},
                created_at = ${snapshot.createdAt}, started_at = ${snapshot.startedAt},
                finished_at = ${snapshot.finishedAt},
                assistant_message_id = ${snapshot.assistantMessageId},
                citation_namespace = ${snapshot.citationNamespace}
            where id = ${sealed.runId}
          `;
        }),
      );
    const expectSealedMutationRejected = async (
      mutated: SealedRunSnapshot,
      expectedError = /accepted run snapshot differs|durable evidence changed|not successfully terminal|invalid terminal event ownership|non-contiguous durable event ledger|invalid final source map/u,
    ): Promise<void> => {
      let stored = false;
      try {
        await writeRun(mutated);
        stored = true;
      } catch {
        // The immutable run trigger may reject the tamper at storage rather
        // than leaving an altered row for attestation to inspect.
        return;
      }
      try {
        await expect(
          attestEvaluationCaseFromDurableRun(
            isolatedDatabaseUrl(),
            sealedSnapshotTamperSessionId,
            sealed.caseId,
            sealed.topology,
          ),
        ).rejects.toThrow(expectedError);
      } finally {
        if (stored) await writeRun(original);
      }
    };
    await expectSealedMutationRejected({ ...original, chatId: sealed.alternateChatId });
    await expectSealedMutationRejected({ ...original, userMessageId: foreignUserMessageId });
    await expectSealedMutationRejected({
      ...original,
      initiatingUserId: `${original.initiatingUserId}-forged`,
    });
    await expectSealedMutationRejected({
      ...original,
      locale: original.locale === "fr-FR" ? "en-US" : "fr-FR",
    });
    await expectSealedMutationRejected({
      ...original,
      market: original.market === "FR" ? "US" : "FR",
    });
    await expectSealedMutationRejected({
      ...original,
      acceptanceScope: {
        ...original.acceptanceScope,
        webEnabled: false,
        webTransportProvider: null,
        allowedDomains: null,
      },
    });
    await expectSealedMutationRejected({
      ...original,
      acceptanceScope: {
        ...original.acceptanceScope,
        webTransportProvider: null,
      },
    });
    await expectSealedMutationRejected({
      ...original,
      smithersRunId: `${original.smithersRunId}:x`,
    });
    await expectSealedMutationRejected({ ...original, nextEventSeq: original.nextEventSeq + 1 });
    await expectSealedMutationRejected({
      ...original,
      createdAt: new Date(original.createdAt.getTime() + 1),
    });
    await expectSealedMutationRejected({
      ...original,
      startedAt: new Date(original.startedAt.getTime() + 1),
    });
    await expectSealedMutationRejected({
      ...original,
      finishedAt: new Date(original.finishedAt.getTime() + 1),
    });
    await expectSealedMutationRejected(
      {
        ...original,
        assistantMessageId: foreignAssistantMessageId,
      },
      /live web exposure lacks its durable quotation/u,
    );
    await expectSealedMutationRejected({ ...original, citationNamespace: "cn_" + "b".repeat(22) });

    try {
      await expect(
        runDb(
          isolatedDatabaseUrl(),
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
              update ai_run_usage
              set created_at = ${new Date(sealed.usageCreatedAt.getTime() + 60_000)}
              where id = ${sealed.usageId}
            `;
          }),
        ),
      ).rejects.toThrow(/Failed to execute statement|append-only/u);
    } finally {
      await runDb(
        isolatedDatabaseUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            delete from chat_messages where id in (${foreignUserMessageId}, ${foreignAssistantMessageId})
          `;
        }),
      );
    }
    await expect(
      attestEvaluationCaseFromDurableRun(
        isolatedDatabaseUrl(),
        sealedSnapshotTamperSessionId,
        sealed.caseId,
        sealed.topology,
      ),
    ).resolves.toBeTypeOf("string");

    const assertCapturedWebAuthorized = async (): Promise<void> => {
      const captured = await captureEvaluationSession(
        isolatedDatabaseUrl(),
        sealedSnapshotTamperSessionId,
      );
      const result = captured.specialized.find((candidate) => candidate.caseId === sealed.caseId);
      const fixture = CanonicalGoldenEvaluationSet.cases.find(
        (candidate) => candidate.id === sealed.caseId,
      )!;
      const webSourceIds = new Set(
        fixture.evidence.filter((source) => source.kind === "web").map((source) => source.sourceId),
      );
      const webAudit = result?.sourceAudit.filter((source) => webSourceIds.has(source.sourceId));
      expect(webAudit?.length).toBeGreaterThan(0);
      expect(webAudit?.every((source) => source.authorized)).toBe(true);
    };
    await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update client_company_ai_settings
          set web_search_enabled = false, web_domain_allowlist = null
          where company_id = ${sealed.companyId}
        `;
      }),
    );
    try {
      await assertCapturedWebAuthorized();
    } finally {
      await runDb(
        isolatedDatabaseUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            update client_company_ai_settings
            set web_search_enabled = true, web_domain_allowlist = null
            where company_id = ${sealed.companyId}
          `;
        }),
      );
    }
    await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update client_company_ai_settings
          set web_search_enabled = true, web_domain_allowlist = array['example.com']::text[]
          where company_id = ${sealed.companyId}
        `;
      }),
    );
    try {
      await assertCapturedWebAuthorized();
    } finally {
      await runDb(
        isolatedDatabaseUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            update client_company_ai_settings
            set web_search_enabled = true, web_domain_allowlist = null
            where company_id = ${sealed.companyId}
          `;
        }),
      );
    }
  }, 120_000);

  it("rejects every omitted relational and ordered evidence column after sealing", async () => {
    await completeDurableCaptureSession(completeEvidenceTamperSessionId);
    const target = await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const rows = yield* sql<{
          readonly caseId: string;
          readonly topology: "specialized" | "general_planner";
          readonly runId: string;
          readonly companyId: string;
          readonly chatId: string;
          readonly chatUserId: string;
          readonly alternateChatId: string;
          readonly currentMessageId: string;
          readonly currentMessageContent: string;
          readonly currentMessageCreatedAt: Date;
          readonly assistantMessageId: string;
          readonly assistantChatId: string;
          readonly assistantAuthor: string;
          readonly assistantContent: string;
          readonly assistantCreatedAt: Date;
          readonly priorRunId: string;
          readonly priorInitiatingUserId: string;
          readonly priorSmithersRunId: string;
          readonly priorLocale: string;
          readonly priorMarket: string;
          readonly priorAcceptanceScope: Record<string, unknown>;
          readonly priorStartedAt: Date;
          readonly priorRunCreatedAt: Date;
          readonly priorUserMessageId: string;
          readonly priorUserChatId: string;
          readonly priorUserAuthor: string;
          readonly priorUserContent: string;
          readonly priorUserCreatedAt: Date;
          readonly priorAssistantMessageId: string;
          readonly priorAssistantChatId: string;
          readonly priorAssistantAuthor: string;
          readonly priorAssistantContent: string;
          readonly priorAssistantCreatedAt: Date;
          readonly observationId: string;
          readonly observationCreatedAt: Date;
          readonly exposureId: string;
          readonly exposureCreatedAt: Date;
          readonly terminalEventId: string;
          readonly terminalEmissionKey: string;
          readonly terminalOwner: string;
          readonly terminalCreatedAt: Date;
          readonly contextEventId: string;
          readonly contextEvent: Record<string, unknown>;
          readonly deltaEventId: string;
          readonly deltaEmissionKey: string;
          readonly deltaEvent: Record<string, unknown>;
          readonly answerStartEventId: string;
          readonly answerStartEmissionKey: string;
          readonly answerStartEvent: Record<string, unknown>;
          readonly sourceKey: string;
          readonly sourceLabel: string | null;
          readonly sourceProvenance: Record<string, unknown>;
          readonly sourceCreatedAt: Date;
          readonly sourceUseConsumer: string;
          readonly sourceUseTopic: "t1" | "t2" | "t3" | null;
          readonly sourceUseRenderedTokens: number;
          readonly sourceUseContextOrder: number;
          readonly sourceUseRanges: readonly {
            readonly charStart: number;
            readonly charEnd: number;
          }[];
          readonly sourceUseCreatedAt: Date;
        }>`
          select cases.case_id as "caseId", cases.topology,
                 runs.id::text as "runId", chats.company_id::text as "companyId",
                 runs.chat_id::text as "chatId", chats.user_id as "chatUserId",
                 alternate.chat_id::text as "alternateChatId",
                 current_message.id::text as "currentMessageId",
                 current_message.content as "currentMessageContent",
                 current_message.created_at as "currentMessageCreatedAt",
                 runs.assistant_message_id::text as "assistantMessageId",
                 current_assistant.chat_id::text as "assistantChatId",
                 current_assistant.author as "assistantAuthor",
                 current_assistant.content as "assistantContent",
                 current_assistant.created_at as "assistantCreatedAt",
                 prior.id::text as "priorRunId",
                 prior.initiating_user_id as "priorInitiatingUserId",
                 prior.smithers_run_id as "priorSmithersRunId",
                 prior.locale as "priorLocale", prior.market as "priorMarket",
                 prior.acceptance_scope as "priorAcceptanceScope",
                 prior.started_at as "priorStartedAt",
                 prior.created_at as "priorRunCreatedAt",
                 prior_user.id::text as "priorUserMessageId",
                 prior_user.chat_id::text as "priorUserChatId",
                 prior_user.author as "priorUserAuthor", prior_user.content as "priorUserContent",
                 prior_user.created_at as "priorUserCreatedAt",
                 prior.assistant_message_id::text as "priorAssistantMessageId",
                 prior_assistant.chat_id::text as "priorAssistantChatId",
                 prior_assistant.author as "priorAssistantAuthor",
                 prior_assistant.content as "priorAssistantContent",
                 prior_assistant.created_at as "priorAssistantCreatedAt",
                 observation.id::text as "observationId",
                 observation.created_at as "observationCreatedAt",
                 exposure.id::text as "exposureId",
                 exposure.created_at as "exposureCreatedAt",
                 terminal.id::text as "terminalEventId",
                 terminal.emission_key as "terminalEmissionKey",
                 terminal.emitted_by_task as "terminalOwner",
                 terminal.created_at as "terminalCreatedAt",
                 context_event.id::text as "contextEventId",
                 context_event.event as "contextEvent",
                 delta_event.id::text as "deltaEventId",
                 delta_event.emission_key as "deltaEmissionKey",
                 delta_event.event as "deltaEvent",
                 answer_start_event.id::text as "answerStartEventId",
                 answer_start_event.emission_key as "answerStartEmissionKey",
                 answer_start_event.event as "answerStartEvent",
                 source.source_key as "sourceKey", source.display_label as "sourceLabel",
                 source.public_provenance as "sourceProvenance",
                 source.created_at as "sourceCreatedAt",
                 source_use.consumer_task_id as "sourceUseConsumer",
                 source_use.topic_id as "sourceUseTopic",
                 source_use.rendered_token_count as "sourceUseRenderedTokens",
                 source_use.context_order as "sourceUseContextOrder",
                 source_use.ranges as "sourceUseRanges",
                 source_use.created_at as "sourceUseCreatedAt"
          from ai_evaluation_case_runs cases
          join ai_runs runs on runs.id = cases.ai_run_id
          join chats on chats.id = runs.chat_id
          join chat_messages current_message on current_message.id = runs.user_message_id
          join chat_messages current_assistant on current_assistant.id = runs.assistant_message_id
          join lateral (
            select other_runs.chat_id
            from ai_evaluation_case_runs other_cases
            join ai_runs other_runs on other_runs.id = other_cases.ai_run_id
            where other_cases.session_id = cases.session_id and other_runs.chat_id <> runs.chat_id
            order by other_cases.case_id, other_cases.topology limit 1
          ) alternate on true
          join lateral (
            select prior_runs.* from ai_runs prior_runs
            where prior_runs.chat_id = runs.chat_id and prior_runs.id <> runs.id
            order by prior_runs.created_at, prior_runs.id limit 1
          ) prior on true
          join chat_messages prior_user on prior_user.id = prior.user_message_id
          join chat_messages prior_assistant on prior_assistant.id = prior.assistant_message_id
          join lateral (
            select id, created_at from ai_observations
            where run_id = runs.id order by observation_key limit 1
          ) observation on true
          join lateral (
            select id, created_at from ai_source_exposures
            where run_id = runs.id order by id limit 1
          ) exposure on true
          join ai_run_events terminal
            on terminal.run_id = runs.id and terminal.emission_key = 'terminal'
          join ai_run_events context_event
            on context_event.run_id = runs.id and context_event.emission_key = 'context_ready'
          join lateral (
            select id, emission_key, event from ai_run_events
            where run_id = runs.id and event->>'type' = 'text_delta'
            order by seq limit 1
          ) delta_event on true
          join lateral (
            select id, emission_key, event from ai_run_events
            where run_id = runs.id and event->>'type' = 'answer_started'
            order by seq limit 1
          ) answer_start_event on true
          join assistant_message_sources source
            on source.assistant_message_id = runs.assistant_message_id and source.kind = 'document'
          join assistant_message_source_uses source_use
            on source_use.assistant_message_id = source.assistant_message_id
           and source_use.source_key = source.source_key
          where cases.session_id = ${completeEvidenceTamperSessionId}
            and cases.topology = 'specialized'
            and jsonb_array_length(cases.seed_manifest->'turnBindings') > 0
          order by cases.case_id, source.source_key, source_use.consumer_task_id limit 1
        `;
        const row = rows[0];
        if (row === undefined) {
          return yield* Effect.fail(new Error("complete relational evidence target is missing"));
        }
        return row;
      }),
    );
    const memoryTarget = await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const rows = yield* sql<{
          readonly caseId: string;
          readonly topology: "specialized" | "general_planner";
          readonly revisionId: string;
          readonly action: "create" | "update";
          readonly createdAt: Date;
        }>`
          select cases.case_id as "caseId", cases.topology,
                 revisions.id::text as "revisionId", revisions.action,
                 revisions.created_at as "createdAt"
          from ai_evaluation_case_runs cases
          join user_memory_revisions revisions on revisions.run_id = cases.ai_run_id
          where cases.session_id = ${completeEvidenceTamperSessionId}
          order by cases.case_id, cases.topology, revisions.created_at, revisions.id limit 1
        `;
        const row = rows[0];
        if (row === undefined) {
          return yield* Effect.fail(new Error("complete memory evidence target is missing"));
        }
        return row;
      }),
    );
    const foreignUserId = `eval-forged-${crypto.randomUUID()}`;
    const forgedObservationId = crypto.randomUUID();
    const forgedExposureId = (BigInt(target.exposureId) + 1_000_000_000n).toString();
    const forgedTerminalEventId = (BigInt(target.terminalEventId) + 1_000_000_000n).toString();
    await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          insert into platform_users (id, primary_email, display_name, clerk_user_id)
          values (${foreignUserId}, ${`${foreignUserId}@evaluation.invalid`}, 'Forged evaluator', ${`clerk_${foreignUserId}`})
        `;
        yield* sql`
          insert into client_company_memberships (company_id, user_id, role)
          values (${target.companyId}, ${foreignUserId}, 'member')
        `;
      }),
    );
    type Mutation =
      | "chat_creator"
      | "chat_deleted"
      | "current_content"
      | "current_author"
      | "current_chat"
      | "current_created"
      | "current_assistant_link"
      | "assistant_link"
      | "assistant_chat"
      | "assistant_author"
      | "assistant_content"
      | "assistant_created"
      | "prior_initiating_user"
      | "prior_smithers_run"
      | "prior_locale"
      | "prior_market"
      | "prior_web_search_enabled"
      | "prior_effective_web_policy"
      | "prior_started"
      | "prior_run_created"
      | "prior_assistant_link"
      | "prior_user_chat"
      | "prior_user_author"
      | "prior_user_content"
      | "prior_user_link"
      | "prior_user_created"
      | "prior_assistant_chat"
      | "prior_assistant_author"
      | "prior_assistant_content"
      | "prior_assistant_created"
      | "observation_id"
      | "observation_chat"
      | "observation_created"
      | "exposure_id"
      | "exposure_created"
      | "exposure_publisher"
      | "terminal_id"
      | "terminal_key"
      | "terminal_owner"
      | "terminal_created"
      | "context_payload"
      | "delta_key"
      | "delta_payload"
      | "answer_attempt"
      | "source_label"
      | "source_provenance"
      | "source_created"
      | "source_use_consumer"
      | "source_use_topic"
      | "source_use_tokens"
      | "source_use_order"
      | "source_use_ranges"
      | "source_use_created"
      | "memory_created"
      | "memory_action";
    const writeMutation = (mutation: Mutation, restore: boolean) =>
      runDb(
        isolatedDatabaseUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          switch (mutation) {
            case "chat_creator":
              yield* sql`update chats set user_id = ${restore ? target.chatUserId : foreignUserId} where id = ${target.chatId}`;
              break;
            case "chat_deleted":
              yield* restore
                ? sql`update chats set deleted_at = null, deleted_by_user_id = null, purge_after = null where id = ${target.chatId}`
                : sql`update chats set deleted_at = now(), deleted_by_user_id = ${foreignUserId}, purge_after = now() + interval '1 day' where id = ${target.chatId}`;
              break;
            case "current_content":
              yield* sql`update chat_messages set content = ${restore ? target.currentMessageContent : `${target.currentMessageContent} forged`} where id = ${target.currentMessageId}`;
              break;
            case "current_author":
              yield* sql`update chat_messages set author = ${restore ? "user" : "assistant"} where id = ${target.currentMessageId}`;
              break;
            case "current_chat":
              yield* sql`update chat_messages set chat_id = ${restore ? target.chatId : target.alternateChatId} where id = ${target.currentMessageId}`;
              break;
            case "current_created":
              yield* sql`update chat_messages set created_at = ${restore ? target.currentMessageCreatedAt : new Date(target.currentMessageCreatedAt.getTime() + 1)} where id = ${target.currentMessageId}`;
              break;
            case "current_assistant_link":
              if (restore) {
                yield* sql`update chat_messages set assistant_ai_run_id = null where id = ${target.currentMessageId}`;
                yield* sql`update chat_messages set assistant_ai_run_id = ${target.runId} where id = ${target.assistantMessageId}`;
              } else {
                yield* sql`update chat_messages set assistant_ai_run_id = null where id = ${target.assistantMessageId}`;
                yield* sql`update chat_messages set assistant_ai_run_id = ${target.runId} where id = ${target.currentMessageId}`;
              }
              break;
            case "assistant_link":
              yield* sql`update chat_messages set assistant_ai_run_id = ${restore ? target.runId : null} where id = ${target.assistantMessageId}`;
              break;
            case "assistant_chat":
              yield* sql`update chat_messages set chat_id = ${restore ? target.assistantChatId : target.alternateChatId} where id = ${target.assistantMessageId}`;
              break;
            case "assistant_author":
              yield* sql`update chat_messages set author = ${restore ? target.assistantAuthor : "user"} where id = ${target.assistantMessageId}`;
              break;
            case "assistant_content":
              yield* sql`update chat_messages set content = ${restore ? target.assistantContent : `${target.assistantContent} forged`} where id = ${target.assistantMessageId}`;
              break;
            case "assistant_created":
              yield* sql`update chat_messages set created_at = ${restore ? target.assistantCreatedAt : new Date(target.assistantCreatedAt.getTime() + 1)} where id = ${target.assistantMessageId}`;
              break;
            case "prior_run_created":
              yield* sql`update ai_runs set created_at = ${restore ? target.priorRunCreatedAt : new Date(target.priorRunCreatedAt.getTime() + 1)} where id = ${target.priorRunId}`;
              break;
            case "prior_initiating_user":
              yield* sql`update ai_runs set initiating_user_id = ${restore ? target.priorInitiatingUserId : foreignUserId} where id = ${target.priorRunId}`;
              break;
            case "prior_smithers_run":
              yield* sql`update ai_runs set smithers_run_id = ${restore ? target.priorSmithersRunId : `forged:${target.priorSmithersRunId}`} where id = ${target.priorRunId}`;
              break;
            case "prior_locale":
              yield* sql`update ai_runs set locale = ${restore ? target.priorLocale : target.priorLocale === "fr-FR" ? "en-US" : "fr-FR"} where id = ${target.priorRunId}`;
              break;
            case "prior_market":
              yield* sql`update ai_runs set market = ${restore ? target.priorMarket : target.priorMarket === "FR" ? "US" : "FR"} where id = ${target.priorRunId}`;
              break;
            case "prior_web_search_enabled":
              yield* restore
                ? sql`update ai_runs set acceptance_scope = ${JSON.stringify(target.priorAcceptanceScope)}::jsonb where id = ${target.priorRunId}`
                : sql`update ai_runs set acceptance_scope = jsonb_set(acceptance_scope, '{webEnabled}', to_jsonb(not (acceptance_scope->>'webEnabled')::boolean)) where id = ${target.priorRunId}`;
              break;
            case "prior_effective_web_policy":
              yield* restore
                ? sql`update ai_runs set acceptance_scope = ${JSON.stringify(target.priorAcceptanceScope)}::jsonb where id = ${target.priorRunId}`
                : sql`update ai_runs set acceptance_scope = jsonb_set(acceptance_scope, '{allowedDomains}', '["forged.example"]'::jsonb) where id = ${target.priorRunId}`;
              break;
            case "prior_started":
              yield* sql`update ai_runs set started_at = ${restore ? target.priorStartedAt : new Date(target.priorStartedAt.getTime() + 1)} where id = ${target.priorRunId}`;
              break;
            case "prior_assistant_link":
              yield* sql`update chat_messages set assistant_ai_run_id = ${restore ? target.priorRunId : null} where id = ${target.priorAssistantMessageId}`;
              break;
            case "prior_user_chat":
              yield* sql`update chat_messages set chat_id = ${restore ? target.priorUserChatId : target.alternateChatId} where id = ${target.priorUserMessageId}`;
              break;
            case "prior_user_author":
              yield* sql`update chat_messages set author = ${restore ? target.priorUserAuthor : "assistant"} where id = ${target.priorUserMessageId}`;
              break;
            case "prior_user_content":
              yield* sql`update chat_messages set content = ${restore ? target.priorUserContent : `${target.priorUserContent} forged`} where id = ${target.priorUserMessageId}`;
              break;
            case "prior_user_link":
              if (restore) {
                yield* sql`update chat_messages set assistant_ai_run_id = null where id = ${target.priorUserMessageId}`;
                yield* sql`update chat_messages set assistant_ai_run_id = ${target.priorRunId} where id = ${target.priorAssistantMessageId}`;
              } else {
                yield* sql`update chat_messages set assistant_ai_run_id = null where id = ${target.priorAssistantMessageId}`;
                yield* sql`update chat_messages set assistant_ai_run_id = ${target.priorRunId} where id = ${target.priorUserMessageId}`;
              }
              break;
            case "prior_user_created":
              yield* sql`update chat_messages set created_at = ${restore ? target.priorUserCreatedAt : new Date(target.priorUserCreatedAt.getTime() + 1)} where id = ${target.priorUserMessageId}`;
              break;
            case "prior_assistant_chat":
              yield* sql`update chat_messages set chat_id = ${restore ? target.priorAssistantChatId : target.alternateChatId} where id = ${target.priorAssistantMessageId}`;
              break;
            case "prior_assistant_author":
              yield* sql`update chat_messages set author = ${restore ? target.priorAssistantAuthor : "user"} where id = ${target.priorAssistantMessageId}`;
              break;
            case "prior_assistant_content":
              yield* sql`update chat_messages set content = ${restore ? target.priorAssistantContent : `${target.priorAssistantContent} forged`} where id = ${target.priorAssistantMessageId}`;
              break;
            case "prior_assistant_created":
              yield* sql`update chat_messages set created_at = ${restore ? target.priorAssistantCreatedAt : new Date(target.priorAssistantCreatedAt.getTime() + 1)} where id = ${target.priorAssistantMessageId}`;
              break;
            case "observation_id":
              yield* sql`update ai_observations set id = ${restore ? target.observationId : forgedObservationId} where id = ${restore ? forgedObservationId : target.observationId}`;
              break;
            case "observation_chat":
              yield* sql`update ai_observations set chat_id = ${restore ? target.chatId : target.alternateChatId} where id = ${target.observationId}`;
              break;
            case "observation_created":
              yield* sql`update ai_observations set created_at = ${restore ? target.observationCreatedAt : new Date(target.observationCreatedAt.getTime() + 1)} where id = ${target.observationId}`;
              break;
            case "exposure_id":
              yield* sql`update ai_source_exposures set id = ${restore ? target.exposureId : forgedExposureId} where id = ${restore ? forgedExposureId : target.exposureId}`;
              break;
            case "exposure_created":
              yield* sql`update ai_source_exposures set created_at = ${restore ? target.exposureCreatedAt : new Date(target.exposureCreatedAt.getTime() + 1)} where id = ${target.exposureId}`;
              break;
            case "exposure_publisher":
              yield* sql`update ai_source_exposures set publisher_issue_id = ${restore ? null : "forged-issue"}, publisher_document_id = ${restore ? null : "forged-document"} where id = ${target.exposureId}`;
              break;
            case "terminal_id":
              yield* sql`update ai_run_events set id = ${restore ? target.terminalEventId : forgedTerminalEventId} where id = ${restore ? forgedTerminalEventId : target.terminalEventId}`;
              break;
            case "terminal_key":
              yield* sql`update ai_run_events set emission_key = ${restore ? target.terminalEmissionKey : "terminal-forged"} where id = ${target.terminalEventId}`;
              break;
            case "terminal_owner":
              yield* sql`update ai_run_events set emitted_by_task = ${restore ? target.terminalOwner : "forged-finalizer"} where id = ${target.terminalEventId}`;
              break;
            case "terminal_created":
              yield* sql`update ai_run_events set created_at = ${restore ? target.terminalCreatedAt : new Date(target.terminalCreatedAt.getTime() + 1)} where id = ${target.terminalEventId}`;
              break;
            case "context_payload":
              yield* restore
                ? sql`update ai_run_events set event = ${JSON.stringify(target.contextEvent)}::jsonb where id = ${target.contextEventId}`
                : sql`update ai_run_events set event = jsonb_set(event, '{consumers,0,inputTokens}', to_jsonb(((event #>> '{consumers,0,inputTokens}')::int + 1))) where id = ${target.contextEventId}`;
              break;
            case "delta_key":
              yield* sql`update ai_run_events set emission_key = ${restore ? target.deltaEmissionKey : `${target.deltaEmissionKey}:forged`} where id = ${target.deltaEventId}`;
              break;
            case "delta_payload":
              yield* restore
                ? sql`update ai_run_events set event = ${JSON.stringify(target.deltaEvent)}::jsonb where id = ${target.deltaEventId}`
                : sql`update ai_run_events set event = jsonb_set(event, '{delta}', to_jsonb(((event->>'delta') || ' forged')::text)) where id = ${target.deltaEventId}`;
              break;
            case "answer_attempt":
              yield* restore
                ? sql`update ai_run_events set event = ${JSON.stringify(target.answerStartEvent)}::jsonb, emission_key = ${target.answerStartEmissionKey} where id = ${target.answerStartEventId}`
                : sql`update ai_run_events set event = jsonb_set(event, '{attempt}', '-1'::jsonb), emission_key = ${target.answerStartEmissionKey.replace(/:[0-9]+$/u, ":-1")} where id = ${target.answerStartEventId}`;
              break;
            case "source_label":
              yield* sql`update assistant_message_sources set display_label = ${restore ? target.sourceLabel : "forged label"} where assistant_message_id = ${target.assistantMessageId} and source_key = ${target.sourceKey}`;
              break;
            case "source_provenance":
              yield* sql`update assistant_message_sources set public_provenance = ${JSON.stringify(restore ? target.sourceProvenance : { ...target.sourceProvenance, forged: true })}::jsonb where assistant_message_id = ${target.assistantMessageId} and source_key = ${target.sourceKey}`;
              break;
            case "source_created":
              yield* sql`update assistant_message_sources set created_at = ${restore ? target.sourceCreatedAt : new Date(target.sourceCreatedAt.getTime() + 1)} where assistant_message_id = ${target.assistantMessageId} and source_key = ${target.sourceKey}`;
              break;
            case "source_use_consumer":
              yield* sql`update assistant_message_source_uses set consumer_task_id = ${restore ? target.sourceUseConsumer : "forged-consumer"} where assistant_message_id = ${target.assistantMessageId} and source_key = ${target.sourceKey} and consumer_task_id = ${restore ? "forged-consumer" : target.sourceUseConsumer}`;
              break;
            case "source_use_topic":
              yield* sql`update assistant_message_source_uses set topic_id = ${restore ? target.sourceUseTopic : target.sourceUseTopic === null ? "t1" : null} where assistant_message_id = ${target.assistantMessageId} and source_key = ${target.sourceKey} and consumer_task_id = ${target.sourceUseConsumer}`;
              break;
            case "source_use_tokens":
              yield* sql`update assistant_message_source_uses set rendered_token_count = ${restore ? target.sourceUseRenderedTokens : target.sourceUseRenderedTokens + 1} where assistant_message_id = ${target.assistantMessageId} and source_key = ${target.sourceKey} and consumer_task_id = ${target.sourceUseConsumer}`;
              break;
            case "source_use_order":
              yield* sql`update assistant_message_source_uses set context_order = ${restore ? target.sourceUseContextOrder : target.sourceUseContextOrder + 1000} where assistant_message_id = ${target.assistantMessageId} and source_key = ${target.sourceKey} and consumer_task_id = ${target.sourceUseConsumer}`;
              break;
            case "source_use_ranges":
              yield* restore
                ? sql`update assistant_message_source_uses set ranges = ${JSON.stringify(target.sourceUseRanges)}::jsonb where assistant_message_id = ${target.assistantMessageId} and source_key = ${target.sourceKey} and consumer_task_id = ${target.sourceUseConsumer}`
                : sql`update assistant_message_source_uses set ranges = case when ranges = '[]'::jsonb then '[{"charStart":0,"charEnd":1}]'::jsonb else '[]'::jsonb end where assistant_message_id = ${target.assistantMessageId} and source_key = ${target.sourceKey} and consumer_task_id = ${target.sourceUseConsumer}`;
              break;
            case "source_use_created":
              yield* sql`update assistant_message_source_uses set created_at = ${restore ? target.sourceUseCreatedAt : new Date(target.sourceUseCreatedAt.getTime() + 1)} where assistant_message_id = ${target.assistantMessageId} and source_key = ${target.sourceKey} and consumer_task_id = ${target.sourceUseConsumer}`;
              break;
            case "memory_created":
              yield* sql`update user_memory_revisions set created_at = ${restore ? memoryTarget.createdAt : new Date(memoryTarget.createdAt.getTime() + 1)} where id = ${memoryTarget.revisionId}`;
              break;
            case "memory_action":
              yield* sql`update user_memory_revisions set action = ${restore ? memoryTarget.action : "delete"} where id = ${memoryTarget.revisionId}`;
              break;
          }
        }),
      );
    const attestTargetRejected = async (
      mutation: Mutation,
      selected: Pick<typeof target, "caseId" | "topology"> = target,
    ): Promise<void> => {
      try {
        await writeMutation(mutation, false);
      } catch (error) {
        // Evaluation-bound append-only ledgers reject coordinated mutation at
        // storage; mutable product projections continue to exercise attestation.
        if (mutation.startsWith("observation_") || mutation.startsWith("exposure_")) return;
        throw error;
      }
      try {
        await expect(
          attestEvaluationCaseFromDurableRun(
            isolatedDatabaseUrl(),
            completeEvidenceTamperSessionId,
            selected.caseId,
            selected.topology,
          ),
        ).rejects.toThrow();
      } finally {
        await writeMutation(mutation, true);
      }
    };
    const expectDatabaseReject = async (mutation: Mutation): Promise<void> => {
      // Migration 0059 protects the complete source/source-use identity at
      // the database boundary. These tamper attempts must fail before the
      // attestation query runs; the transaction rollback leaves no restore
      // write to perform.
      try {
        await writeMutation(mutation, false);
      } catch {
        return;
      }
      throw new Error(`expected database reject: ${mutation}`);
    };
    for (const mutation of [
      "chat_creator",
      "chat_deleted",
      "current_content",
      "current_author",
      "current_chat",
      "current_created",
      "current_assistant_link",
      "assistant_link",
      "assistant_chat",
      "assistant_author",
      "assistant_content",
      "assistant_created",
      "prior_smithers_run",
      "prior_locale",
      "prior_market",
      "prior_started",
      "prior_run_created",
      "prior_assistant_link",
      "prior_user_chat",
      "prior_user_author",
      "prior_user_content",
      "prior_user_link",
      "prior_user_created",
      "prior_assistant_chat",
      "prior_assistant_author",
      "prior_assistant_content",
      "prior_assistant_created",
      "observation_id",
      "observation_chat",
      "observation_created",
      "exposure_created",
      "exposure_publisher",
      "terminal_key",
      "terminal_owner",
      "terminal_created",
      "context_payload",
      "delta_key",
      "delta_payload",
      "answer_attempt",
    ] as const) {
      try {
        await attestTargetRejected(mutation);
      } catch (error) {
        throw new Error(`relational evidence mutation was not rejected: ${mutation}`, {
          cause: error,
        });
      }
    }
    for (const mutation of [
      "source_label",
      "source_provenance",
      "source_use_consumer",
      "source_use_topic",
      "source_use_tokens",
      "source_use_order",
      "source_use_ranges",
      "source_created",
      "source_use_created",
      "prior_initiating_user",
      "prior_web_search_enabled",
      "prior_effective_web_policy",
    ] as const) {
      await expectDatabaseReject(mutation);
    }
    await expect(writeMutation("exposure_id", false)).rejects.toThrow(
      /Failed to execute statement/u,
    );
    await expect(writeMutation("terminal_id", false)).rejects.toThrow(
      /Failed to execute statement/u,
    );
    await attestTargetRejected("memory_created", memoryTarget);
    await attestTargetRejected("memory_action", memoryTarget);
  }, 120_000);

  it("rejects forged O token ledgers and a stale valid decision followed by an invalid terminal decision", async () => {
    await expect(
      completeDurableCaptureSession(tokenTamperSessionId, "pre_token_mismatch"),
    ).rejects.toThrow(/initial measurement differs from its ledger/u);
    await completeDurableCaptureSession(postSealUsageTamperSessionId);
    await expect(
      runDb(
        isolatedDatabaseUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            update ai_external_tool_usage set response_bytes = response_bytes + 1
            where id = (
              select usage.id from ai_external_tool_usage usage
              join ai_evaluation_case_runs runs on runs.ai_run_id = usage.run_id
              where runs.session_id = ${postSealUsageTamperSessionId}
              order by runs.case_id, runs.topology limit 1
            )
          `;
        }),
      ),
    ).rejects.toThrow(/Failed to execute statement|append-only/u);

    await completeDurableCaptureSession(decisionTamperSessionId, "later_invalid_decision");
    await bindEvaluationAnnotations(
      isolatedDatabaseUrl(),
      decisionTamperSessionId,
      labeledAnnotations(decisionTamperSessionId),
    );
    await expect(
      captureEvaluationSession(isolatedDatabaseUrl(), decisionTamperSessionId),
    ).rejects.toThrow(/lacks a valid terminal O decision/u);
    await expect(
      runDb(
        isolatedDatabaseUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            delete from ai_external_tool_usage where id = (
              select usage.id from ai_external_tool_usage usage
              join ai_evaluation_case_runs runs on runs.ai_run_id = usage.run_id
              where runs.session_id = ${decisionTamperSessionId}
              order by runs.case_id, runs.topology limit 1
            )
          `;
        }),
      ),
    ).rejects.toThrow(/Failed to execute statement|append-only/u);
  }, 120_000);

  it("rejects a numerically later failed O request backdated before the earlier success", async () => {
    await expect(
      completeDurableCaptureSession(invertedUsageTamperSessionId, "o_inverted_chronology"),
    ).rejects.toThrow(/usage chronology contradicts provider coordinates/u);
  }, 120_000);

  it("captures concurrent cross-task usage in canonical serialized-millisecond order", async () => {
    await completeDurableCaptureSession(
      sameMillisecondUsageSessionId,
      "cross_task_same_millisecond_usage",
    );
    const rawChronology = await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql<{
          readonly id: string;
          readonly taskId: string;
          readonly createdAt: Date;
          readonly createdAtMicros: string;
        }>`
          select usage.id::text, usage.task_id as "taskId", usage.created_at as "createdAt",
                 to_char(usage.created_at, 'YYYY-MM-DD HH24:MI:SS.US') as "createdAtMicros"
          from ai_run_usage usage
          join ai_evaluation_case_runs cases on cases.ai_run_id = usage.run_id
          where cases.session_id = ${sameMillisecondUsageSessionId}
            and cases.case_id = 'cross-cutting-separable-energy-question'
            and cases.topology = 'specialized'
            and usage.task_id in (
              'topic-t1-retrieve-internal', 'topic-t2-retrieve-internal'
            )
            and usage.loop_iteration = 0 and usage.attempt = 0
            and usage.provider_request_index = 0
          order by usage.created_at, usage.id
        `;
      }),
    );
    expect(rawChronology).toHaveLength(2);
    expect(BigInt(rawChronology[0]!.id)).toBeGreaterThan(BigInt(rawChronology[1]!.id));
    expect(rawChronology[0]!.createdAtMicros).toMatch(/845$/u);
    expect(rawChronology[1]!.createdAtMicros).toMatch(/853$/u);
    expect(rawChronology[0]!.createdAt.toISOString()).toBe(
      rawChronology[1]!.createdAt.toISOString(),
    );

    await bindEvaluationAnnotations(
      isolatedDatabaseUrl(),
      sameMillisecondUsageSessionId,
      labeledAnnotations(sameMillisecondUsageSessionId),
    );
    const captured = await captureEvaluationSession(
      isolatedDatabaseUrl(),
      sameMillisecondUsageSessionId,
    );
    expect(captured.specialized).toHaveLength(CanonicalGoldenEvaluationSet.cases.length);
    expect(captured.baseline).toHaveLength(CanonicalGoldenEvaluationSet.cases.length);
  }, 120_000);

  it("rejects unknown exposures, failed terminal stops, and incomplete C inventories", async () => {
    const cases = [
      {
        sessionId: exposureTamperSessionId,
        tamper: "unknown_exposure" as const,
        error: /provider-request-bound attestation/u,
      },
      {
        sessionId: terminalStopTamperSessionId,
        tamper: "terminal_error_stop" as const,
        error: /unbound serialized retry output/u,
      },
      {
        sessionId: clarificationStopTamperSessionId,
        tamper: "clarification_error_stop" as const,
        error:
          /output is not bound to its latest provider execution|clarification lacks exact plan-turn provider usage/u,
      },
      {
        sessionId: clarificationSubsetTamperSessionId,
        tamper: "clarification_subset" as const,
        error: /clarification lacks exact plan-turn provider usage/u,
      },
      {
        sessionId: oExposureTamperSessionId,
        tamper: "unknown_o_exposure" as const,
        error: /provider-request-bound attestation|unmapped memory\/context_candidate_inspection/u,
      },
      {
        sessionId: clarificationOrderTamperSessionId,
        tamper: "clarification_reordered" as const,
        error: /clarification lacks exact plan-turn provider usage/u,
      },
      {
        sessionId: clarificationBoundaryTamperSessionId,
        tamper: "clarification_boundary_count" as const,
        error: /clarification lacks exact plan-turn provider usage/u,
      },
      {
        sessionId: documentVersionTamperSessionId,
        tamper: "wrong_document_version" as const,
        error:
          /missing or unbound source-serialization proof|source exposure lacks its exact durable provider sidecar binding/u,
      },
      {
        sessionId: documentHashTamperSessionId,
        tamper: "coordinated_document_hash" as const,
        error:
          /missing or unbound source-serialization proof|source exposure lacks its exact durable provider sidecar binding/u,
      },
      {
        sessionId: documentMetadataTamperSessionId,
        tamper: "tampered_document_reconstruction" as const,
        error:
          /public exposure is not bound to the exact immutable document|publisher exposure is not bound to the exact version extraction relation/u,
      },
      {
        sessionId: memoryRevisionTamperSessionId,
        tamper: "wrong_memory_revision" as const,
        error:
          /stage-incompatible content-item identity|source exposure lacks its exact durable provider sidecar binding/u,
      },
      {
        sessionId: webIdentityTamperSessionId,
        tamper: "wrong_web_identity" as const,
        error:
          /stage-incompatible content-item identity|source exposure lacks its exact durable provider sidecar binding/u,
      },
      {
        sessionId: webStageTamperSessionId,
        tamper: "wrong_web_stage" as const,
        error:
          /missing or unbound source-serialization proof|source exposure lacks its exact durable provider sidecar binding|source exposure lacks its exact provider measurement/u,
      },
      {
        sessionId: exposureCoordinateTamperSessionId,
        tamper: "wrong_exposure_coordinate" as const,
        error:
          /provider-request-bound attestation|source exposure lacks its exact provider measurement/u,
      },
      {
        sessionId: manifestPurposeTamperSessionId,
        tamper: "manifest_purpose" as const,
        error: /manifest semantics differ/u,
      },
      {
        sessionId: reducerTerminalTamperSessionId,
        tamper: "o_later_error" as const,
        error:
          /exact terminal context-reducer usage|provider-authored output without provider usage|context_reducer_terminal output is not bound to its latest provider usage/u,
      },
      {
        sessionId: clarificationModelTamperSessionId,
        tamper: "clarification_model_mismatch" as const,
        error:
          /invalid exact provider measurement|clarification lacks exact plan-turn provider usage|invalid provider request measurement observation/u,
      },
      {
        sessionId: clarificationInputTamperSessionId,
        tamper: "clarification_input_mismatch" as const,
        error: /clarification lacks exact plan-turn provider usage/u,
      },
      {
        sessionId: clarificationDateTamperSessionId,
        tamper: "clarification_date_mismatch" as const,
        error: /clarification lacks exact plan-turn provider usage/u,
      },
      {
        sessionId: directDigestTamperSessionId,
        tamper: "direct_request_digest" as const,
        error:
          /terminal ledger lacks exact real-provider usage|context ledger differs from its provider measurement/u,
      },
      {
        sessionId: topicDigestTamperSessionId,
        tamper: "topic_request_digest" as const,
        error:
          /terminal ledger lacks exact real-provider usage|context ledger differs from its provider measurement/u,
      },
      {
        sessionId: synthesisDigestTamperSessionId,
        tamper: "synthesis_request_digest" as const,
        error:
          /terminal ledger lacks exact real-provider usage|(?:synthesis )?context ledger differs from its provider measurement/u,
      },
      {
        sessionId: memoryInternalStageTamperSessionId,
        tamper: "memory_as_internal_preview" as const,
        error:
          /lacks terminal provider usage|stage-incompatible|invalid provider-visible source exposure: sidecar does not match the exact visible tool result|replay conflicts with an existing immutable row/u,
      },
      {
        sessionId: chatWebStageTamperSessionId,
        tamper: "chat_as_web_preview" as const,
        error:
          /invalid exact provider measurement|stage-incompatible|source exposure binding is absent from its provider measurement|durable chat\/message scope/u,
      },
      {
        sessionId: wrongKindOTamperSessionId,
        tamper: "wrong_kind_o" as const,
        error:
          /unmapped document\/context_candidate_inspection|invalid provider-visible source exposure: sidecar does not match the exact visible tool result/u,
      },
      {
        sessionId: arbitraryTaskTamperSessionId,
        tamper: "arbitrary_internal_task" as const,
        error:
          /unknown canonical provider task specialized\/forged-retrieve-internal|source exposure has a foreign task owner|lacks terminal provider usage|stage-incompatible/u,
      },
    ];
    for (const scenario of cases) {
      let sealError: unknown;
      try {
        await completeDurableCaptureSession(scenario.sessionId, scenario.tamper);
      } catch (error) {
        sealError = error;
      }
      if (sealError !== undefined) {
        expect(sealError).toBeInstanceOf(Error);
        if (scenario.tamper === "tampered_document_reconstruction") {
          const messages: string[] = [];
          const seen = new Set<object>();
          let current: unknown = sealError;
          while (typeof current === "object" && current !== null && !seen.has(current)) {
            seen.add(current);
            if (
              "message" in current &&
              typeof (current as { readonly message?: unknown }).message === "string"
            ) {
              messages.push((current as { readonly message: string }).message);
            }
            current =
              "cause" in current ? (current as { readonly cause?: unknown }).cause : undefined;
          }
          expect(messages.join("\n"), scenario.tamper).toMatch(scenario.error);
        } else {
          expect((sealError as Error).message).toMatch(scenario.error);
        }
        continue;
      }
      await bindEvaluationAnnotations(
        isolatedDatabaseUrl(),
        scenario.sessionId,
        labeledAnnotations(scenario.sessionId),
      );
      await expect(
        captureEvaluationSession(isolatedDatabaseUrl(), scenario.sessionId),
      ).rejects.toThrow(scenario.error);
    }
  }, 300_000);

  it("makes provider origin and evaluation identity immutable and rejects fake execution", async () => {
    await createEvaluationSession(isolatedDatabaseUrl(), identitySessionId);
    await seedEvaluationSession(isolatedDatabaseUrl(), identitySessionId);
    await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update ai_evaluation_sessions
          set status = 'running',
              execution_config_sha256_hex = ${canonicalSha256Hex(CanonicalEvaluationExecutionConfig)},
              provider_endpoint_identity = ${TINYFISH_SEARCH_PROVIDER_ENDPOINT_IDENTITY}
          where id = ${identitySessionId}
        `;
      }),
    );
    const row = await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const rows = yield* sql<{ readonly runId: string; readonly caseId: string }>`
          select ai_run_id::text as "runId", case_id as "caseId"
          from ai_evaluation_case_runs
          where session_id = ${sessionId} and topology = 'general_planner'
          order by case_id limit 1
        `;
        return rows[0]!;
      }),
    );
    await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          insert into ai_run_usage (
            run_id, task_id, loop_iteration, attempt, provider_request_index,
            agent_role, model_id, provider_service_id, input_tokens, output_tokens,
            cached_tokens, reasoning_tokens, total_tokens, stop_reason
          ) values (
            ${row.runId}, 'test-provider', 0, 0, 0, 'evaluation_general_planner',
            'glm-5.2', 'deterministic_test', 10, 2, 0, 0, 12, 'stop'
          )
        `;
      }),
    );
    await expect(
      runDb(
        isolatedDatabaseUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`update ai_run_usage set provider_service_id = 'zai_coding_plan_official' where run_id = ${row.runId}`;
        }),
      ),
    ).rejects.toThrow(/Failed to execute statement/u);
    for (const mutation of [
      `execution_config_sha256_hex = '${"f".repeat(64)}'`,
      "provider_endpoint_identity = 'openai_compatible_custom:https://compatible.example/v1'",
    ]) {
      await expect(
        runDb(
          isolatedDatabaseUrl(),
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql.unsafe(
              `update ai_evaluation_sessions set ${mutation} where id = '${identitySessionId}'`,
            );
          }),
        ),
      ).rejects.toThrow(/Failed to execute statement/u);
    }
    await expect(
      runDb(
        isolatedDatabaseUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const rows = yield* sql<{ readonly provider: string }>`
            select provider_service_id as provider from ai_run_usage where run_id = ${row.runId}
          `;
          return rows[0]?.provider;
        }),
      ),
    ).resolves.toBe("deterministic_test");
    await expect(
      runDb(
        isolatedDatabaseUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            update ai_evaluation_case_runs
            set seed_manifest = seed_manifest || '{"forged":true}'::jsonb
            where session_id = ${sessionId} and case_id = ${row.caseId}
              and topology = 'general_planner'
          `;
        }),
      ),
    ).rejects.toThrow(/Failed to execute statement/u);
    await expect(
      runDb(
        isolatedDatabaseUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            update ai_evaluation_sessions set fixture_sha256_hex = ${"f".repeat(64)}
            where id = ${sessionId}
          `;
        }),
      ),
    ).rejects.toThrow(/Failed to execute statement/u);
    await expect(
      runDb(
        isolatedDatabaseUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            insert into ai_evaluation_sessions (
              id, artifact_version, golden_set_version, fixture_sha256_hex
            ) values (${crypto.randomUUID()}, 1, 2, ${CanonicalGoldenFixtureSha256Hex})
          `;
        }),
      ),
    ).rejects.toThrow(/Failed to execute statement/u);
    await expect(
      runDb(
        isolatedDatabaseUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            insert into ai_evaluation_sessions (
              id, artifact_version, golden_set_version, fixture_sha256_hex
            ) values (${crypto.randomUUID()}, 3, 2, ${CanonicalGoldenFixtureSha256Hex})
          `;
        }),
      ),
    ).rejects.toThrow(/Failed to execute statement/u);
    await expect(
      executeEvaluationSession(
        isolatedDatabaseUrl(),
        sessionId,
        canonicalEvaluationWorkerConfig({ aiE2eFakeProvider: true }),
      ),
    ).rejects.toThrow(/aiE2eFakeProvider/u);
    await expect(
      executeEvaluationSession(
        isolatedDatabaseUrl(),
        sessionId,
        canonicalEvaluationWorkerConfig({ tinyfishApiKey: "" }),
      ),
    ).rejects.toThrow(/tinyfishApiKey/u);
    await expect(
      executeEvaluationSession(
        isolatedDatabaseUrl(),
        sessionId,
        canonicalEvaluationWorkerConfig({ aiMainModel: "glm-5.2" }),
      ),
    ).rejects.toThrow(/aiMainModel/u);
    const unstartedState = await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const sessions = yield* sql<{
          readonly status: string;
          readonly configDigest: string | null;
          readonly endpoint: string | null;
        }>`
          select status, execution_config_sha256_hex as "configDigest",
                 provider_endpoint_identity as endpoint
          from ai_evaluation_sessions where id = ${sessionId}
        `;
        const cases = yield* sql<{ readonly status: string; readonly count: number }>`
          select status, count(*)::int as count from ai_evaluation_case_runs
          where session_id = ${sessionId} group by status
        `;
        return { session: sessions[0], cases };
      }),
    );
    expect(unstartedState).toEqual({
      session: { status: "preparing", configDigest: null, endpoint: null },
      cases: [{ status: "seeded", count: CanonicalGoldenEvaluationSet.cases.length * 2 }],
    });

    const rejectedCliSessionId = crypto.randomUUID();
    await expect(
      prepareAndExecuteEvaluationSession(
        isolatedDatabaseUrl(),
        rejectedCliSessionId,
        canonicalEvaluationWorkerConfig({ zaiApiKey: "" }),
      ),
    ).rejects.toThrow(/zaiApiKey/u);
    const rejectedCliState = await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const sessions = yield* sql<{ readonly count: number }>`
          select count(*)::int as count from ai_evaluation_sessions
          where id = ${rejectedCliSessionId}
        `;
        const cases = yield* sql<{ readonly count: number }>`
          select count(*)::int as count from ai_evaluation_case_runs
          where session_id = ${rejectedCliSessionId}
        `;
        return { sessions: sessions[0]!.count, cases: cases[0]!.count };
      }),
    );
    expect(rejectedCliState).toEqual({ sessions: 0, cases: 0 });
  });
});

describe("trusted provider accounting", () => {
  const usage = [
    {
      id: "10",
      taskId: "evaluation-general-planner",
      loopIteration: 0,
      attempt: 1,
      providerRequestIndex: 0,
      agentRole: "evaluation_general_planner",
      modelId: "glm-5-turbo",
      providerServiceId: "zai_coding_plan_official",
      inputTokens: 10,
      outputTokens: 2,
      cachedTokens: 0,
      reasoningTokens: 0,
      totalTokens: 12,
      stopReason: "toolUse",
      createdAt: "2026-07-10T00:00:00.000Z",
    },
  ] as const;
  const measurements = [
    {
      kind: "provider_request_measurement",
      emittingTask: "evaluation-general-planner",
      loopIteration: 0,
      attempt: 1,
      observationKey: "measurement",
      payload: {
        providerRequestIndex: 0,
        agentRole: "evaluation_general_planner",
        modelId: "glm-5-turbo",
        requestSha256Hex: fixtureProviderRequestSha256Hex,
        sourceExposureProofSha256Hexes: [],
        inputTokens: 10,
        requestedOutputTokens: 16_384,
        usableInputTokens: 100_000,
        contextWindow: 200_000,
        passed: true,
      },
      createdAt: "2026-07-10T00:00:00.000Z",
    },
  ] as const;

  it("orders durable usage by timestamp and numeric bigint ID", () => {
    const createdAt = "2026-07-10T00:00:00.000Z";
    expect(compareDurableUsageChronology({ id: "9", createdAt }, { id: "10", createdAt })).toBe(-1);
    expect(
      compareDurableUsageChronology(
        { id: "999", createdAt: "2026-07-10T00:00:00.000Z" },
        { id: "1", createdAt: "2026-07-10T00:00:00.001Z" },
      ),
    ).toBeLessThan(0);

    const rawMicrosecondOrder = [
      { id: "33", createdAt: new Date("2026-07-14T09:12:18.374845Z").toISOString() },
      { id: "31", createdAt: new Date("2026-07-14T09:12:18.374853Z").toISOString() },
    ];
    expect(rawMicrosecondOrder.map((entry) => entry.createdAt)).toEqual([
      "2026-07-14T09:12:18.374Z",
      "2026-07-14T09:12:18.374Z",
    ]);
    expect(
      [...rawMicrosecondOrder].sort(compareDurableUsageChronology).map((entry) => entry.id),
    ).toEqual(["31", "33"]);
  });

  it("authorizes web audit sources only through the accepted snapshot", () => {
    const enabledAtAcceptance = {
      webSearchEnabled: true,
      effectiveWebPolicy: {
        enabled: true as const,
        provider: "tinyfish" as const,
        allowedDomains: null,
      },
    };
    const disabledAtAcceptance = {
      webSearchEnabled: false,
      effectiveWebPolicy: {
        enabled: false as const,
        reason: "company_disabled" as const,
        allowlistActive: false,
      },
    };
    expect(evaluationWebSourceAuthorized(enabledAtAcceptance, "https://example.com/report")).toBe(
      true,
    );
    expect(evaluationWebSourceAuthorized(disabledAtAcceptance, "https://example.com/report")).toBe(
      false,
    );
  });

  it("maps secret-bearing execution errors to a content-free durable failure code", () => {
    const secret = "sk-secret-provider-credential raw private prompt";
    const reason = canonicalEvaluationFailureReason(new Error(secret));
    expect(reason).toBe("evaluation_case_execution_failed");
    expect(reason).not.toContain(secret);
  });

  it("pairs each exact local measurement to one real provider usage coordinate", () => {
    expect(deriveTrustedPromptMeasurements("general_planner", "case", usage, measurements)).toEqual(
      [
        {
          requestId: "evaluation-general-planner:0:1:0",
          requestSha256Hex: fixtureProviderRequestSha256Hex,
          localInputTokens: 10,
          providerInputTokens: 10,
          gatePassed: true,
        },
      ],
    );
  });

  it("retains a terminal measurement-only failed attempt before a later successful retry", () => {
    const failedAttempt = {
      ...measurements[0],
      attempt: 0,
      observationKey: "failed-attempt-measurement",
      payload: {
        ...measurements[0].payload,
        requestSha256Hex: "d".repeat(64),
      },
    };
    expect(
      deriveTrustedPromptMeasurements("general_planner", "retry-case", usage, [
        failedAttempt,
        measurements[0],
      ]),
    ).toEqual([
      {
        requestId: "evaluation-general-planner:0:1:0",
        requestSha256Hex: fixtureProviderRequestSha256Hex,
        localInputTokens: 10,
        providerInputTokens: 10,
        gatePassed: true,
      },
    ]);
  });

  it("rejects a terminal unmatched measurement that did not pass the exact gate", () => {
    const failedAttempt = {
      ...measurements[0],
      attempt: 0,
      observationKey: "failed-gate-measurement",
      payload: { ...measurements[0].payload, passed: false },
    };
    expect(() =>
      deriveTrustedPromptMeasurements("general_planner", "failed-gate-case", usage, [
        failedAttempt,
        measurements[0],
      ]),
    ).toThrow(/invalid exact provider measurement/u);
  });

  it("rejects noncanonical role, model, and task identities on unmatched measurements", () => {
    const unmatched = {
      ...measurements[0],
      attempt: 0,
      observationKey: "unmatched-measurement",
    };
    expect(() =>
      deriveTrustedPromptMeasurements("general_planner", "wrong-role-case", usage, [
        {
          ...unmatched,
          payload: { ...unmatched.payload, agentRole: "direct_answer" },
        },
        measurements[0],
      ]),
    ).toThrow(/invalid exact provider measurement/u);
    expect(() =>
      deriveTrustedPromptMeasurements("general_planner", "wrong-model-case", usage, [
        {
          ...unmatched,
          payload: { ...unmatched.payload, modelId: "glm-5.2" },
        },
        measurements[0],
      ]),
    ).toThrow(/invalid exact provider measurement/u);
    expect(() =>
      deriveTrustedPromptMeasurements("general_planner", "unknown-task-case", usage, [
        { ...unmatched, emittingTask: "unknown-provider-task" },
        measurements[0],
      ]),
    ).toThrow(/unknown canonical provider task/u);
  });

  it("rejects a suffix-lookalike provider usage and measurement without source exposures", () => {
    const forgedUsage = [
      {
        ...usage[0],
        taskId: "forged-retrieve-internal",
        agentRole: "internal_retrieval",
      },
    ];
    const forgedMeasurement = {
      ...measurements[0],
      emittingTask: "forged-retrieve-internal",
      payload: {
        ...measurements[0].payload,
        agentRole: "internal_retrieval",
      },
    };
    expect(() =>
      deriveTrustedPromptMeasurements(
        "specialized",
        "suffix-lookalike-provider-task",
        forgedUsage,
        [forgedMeasurement],
      ),
    ).toThrow(/unknown canonical provider task specialized\/forged-retrieve-internal/u);
  });

  it("rejects provider-authored output on an unmatched measurement execution", () => {
    const failedAttempt = {
      ...measurements[0],
      attempt: 0,
      observationKey: "failed-attempt-measurement",
    };
    const providerOutput = {
      ...measurements[0],
      kind: "turn_plan",
      attempt: 0,
      observationKey: "failed-attempt-output",
      payload: { mode: "single", question: "provider output without usage", relevantTurnIds: [] },
    };
    expect(() =>
      deriveTrustedPromptMeasurements("general_planner", "unbound-output-case", usage, [
        failedAttempt,
        measurements[0],
        providerOutput,
      ]),
    ).toThrow(/provider-authored output without provider usage/u);
  });

  it("rejects an unmatched measurement when the same attempt continued to a later request", () => {
    const laterUsage = [{ ...usage[0], providerRequestIndex: 1 }] as const;
    const laterMeasurement = {
      ...measurements[0],
      observationKey: "later-measurement",
      payload: { ...measurements[0].payload, providerRequestIndex: 1 },
    };
    expect(() =>
      deriveTrustedPromptMeasurements("general_planner", "invalid-retry-case", laterUsage, [
        measurements[0],
        laterMeasurement,
      ]),
    ).toThrow(/non-terminal failed measurement/u);
  });

  it("treats Pi cache tokens as provider prompt tokens without double-counting totals", () => {
    expect(
      deriveTrustedPromptMeasurements(
        "general_planner",
        "cached-case",
        [
          {
            ...usage[0],
            inputTokens: 7,
            cachedTokens: 3,
            totalTokens: 12,
          },
        ],
        measurements,
      ),
    ).toEqual([
      {
        requestId: "evaluation-general-planner:0:1:0",
        requestSha256Hex: fixtureProviderRequestSha256Hex,
        localInputTokens: 10,
        providerInputTokens: 10,
        gatePassed: true,
      },
    ]);
  });

  it("rejects fake origins, missing/duplicate measurements, model mismatches, and usage mismatches", () => {
    expect(() =>
      deriveTrustedPromptMeasurements(
        "general_planner",
        "case",
        [{ ...usage[0], providerServiceId: "deterministic_test" }],
        measurements,
      ),
    ).toThrow(/non-Z\.AI/u);
    expect(() => deriveTrustedPromptMeasurements("general_planner", "case", usage, [])).toThrow(
      /usage lacks an exact provider measurement/u,
    );
    expect(() =>
      deriveTrustedPromptMeasurements("general_planner", "case", usage, [
        measurements[0],
        { ...measurements[0], observationKey: "duplicate" },
      ]),
    ).toThrow(/duplicate provider measurements/u);
    expect(() =>
      deriveTrustedPromptMeasurements("general_planner", "case", usage, [
        { ...measurements[0], payload: { ...measurements[0].payload, modelId: "glm-5.2" } },
      ]),
    ).toThrow(/invalid exact provider measurement/u);
    expect(() =>
      deriveTrustedPromptMeasurements(
        "general_planner",
        "case",
        [{ ...usage[0], cachedTokens: 1, totalTokens: 13 }],
        measurements,
      ),
    ).not.toThrow();
    expect(() =>
      deriveTrustedPromptMeasurements(
        "general_planner",
        "case",
        [{ ...usage[0], cachedTokens: 1, totalTokens: 12 }],
        measurements,
      ),
    ).toThrow(/inconsistent provider usage totals/u);
  });
});
