import {
  makePublicSourceAdapter,
  publicSourceDefinitions,
  type PublicSourceId,
} from "@brief/source-ingestion";
import { PgClient } from "@effect/sql-pg";
import { Cause, Effect } from "effect";
import { z } from "zod";
import { loadDatabaseUrl } from "@brief/config";
import { CanonicalAgentClient } from "../ai/runtime/agent-client";
import {
  ExactPiBoundary,
  type PiBoundaryCoordinates,
  type PiBoundaryOptions,
} from "../ai/runtime/pi-boundary";
import { providerRequestSha256Hex } from "../ai/runtime/provider-request";
import {
  RUNTIME_MODEL_ID,
  ZAI_CODING_PLAN_BASE_URL,
  ZAI_CODING_PLAN_PROVIDER_SERVICE_ID,
} from "../ai/runtime/model-registry";
import {
  currentTaskAbortSignal,
  forwardAbortSignal,
  throwIfAborted,
} from "../ai/runtime/task-cancellation";
import { DeterministicE2eProviderBoundary } from "../ai/e2e/deterministic-provider";
import { e2eStreamGateLockKey } from "../ai/e2e/stream-gate";
import {
  aiRuntimeFailureMetadata,
  aiRuntimeFailureMetadataFromDurableJson,
  isRetryableAiRunError,
  type AiRunErrorCode,
} from "../ai/runtime/errors";
import {
  createSmithersStorage,
  runWithAiChatSmithersProducerFence,
  runSmithersWorkflow,
  smithersRunExists,
  type SmithersStorage,
} from "../ai/smithers-interop";
import {
  aiChatSchemas,
  aiChatSmithersMaxConcurrency,
  buildAiChatWorkflow,
} from "../ai/workflow/ai-chat";
import { CanonicalWorkflowOperations, type WebResearchBoundary } from "../ai/workflow/operations";
import { decodeRunAcceptanceScope } from "../ai/workflow/types";
import {
  safeAiPhaseLogFields,
  withAiPhaseLogging,
  type AiPhaseLogger,
} from "../ai/workflow/phase-logging";
import {
  AiRunSmithersRunIdMismatch,
  failAiRun,
  insertAiExternalToolUsage,
  insertAiObservation,
  insertAiRunUsage,
  runAiProductState,
} from "../ai/product-state/repository";
import {
  safeFetchPage,
  searchTinyfishWeb,
  TINYFISH_SEARCH_DOMAIN_FILTER_HARD_MAX,
  TINYFISH_SEARCH_PROVIDER_SERVICE_ID,
  WebBoundaryError,
  type WebOperationAccounting,
} from "../ai/web";
import { deleteSmithersRowsForRun, purgeAiRuntimeRetention } from "../ai/workflow/smithers-cleanup";
import { purgeUserMemoryTombstones } from "../ai/product-state/retention";
import { loadWorkerConfig } from "../config";
import { JsonLoggerLayer, serviceLogFields } from "../logging";
import { runPublicSourceIngestion } from "../source-ingestion/orchestrator";
import type { PublicSourceIngestionRepository } from "../source-ingestion/repository";
import type { PublicSourceIngestionOptions } from "../source-ingestion/types";
import type { WorkerConfig } from "../config";
import { PlatformFileStore } from "../platform/file-store";
import { handlePlatformJob, isPlatformJobKind } from "../platform/jobs";
import { PdfTextExtractor } from "../platform/pdf-text";
import { ExportObjectStoreService, NotificationEmailService } from "../platform/adapters";
import type { JobRecord, JobResult } from "./types";

const publicSourceIds = new Set<string>(publicSourceDefinitions.map((source) => source.id));
const resumeMetadataMismatchCode = "RESUME_METADATA_MISMATCH";

type PublicSourceIngestionJobPayload = {
  readonly sourceId: PublicSourceId;
  readonly mode: PublicSourceIngestionOptions["mode"];
  readonly since?: string;
  readonly operationTimeoutMs?: number;
};

export const parsePublicSourceIngestionPayload = (
  payload: unknown,
): PublicSourceIngestionJobPayload => {
  if (!payload || typeof payload !== "object") {
    throw new Error("public_source_ingestion payload must be an object");
  }

  const candidate = payload as Record<string, unknown>;
  if (typeof candidate.sourceId !== "string" || !publicSourceIds.has(candidate.sourceId)) {
    throw new Error("public_source_ingestion payload has an invalid sourceId");
  }

  if (candidate.mode !== "backfill" && candidate.mode !== "poll") {
    throw new Error("public_source_ingestion payload has an invalid mode");
  }

  if ("since" in candidate && typeof candidate.since !== "string") {
    throw new Error("public_source_ingestion payload has an invalid since value");
  }
  if (
    "operationTimeoutMs" in candidate &&
    (typeof candidate.operationTimeoutMs !== "number" ||
      !Number.isFinite(candidate.operationTimeoutMs) ||
      candidate.operationTimeoutMs <= 0)
  ) {
    throw new Error("public_source_ingestion payload has an invalid operationTimeoutMs value");
  }

  return {
    sourceId: candidate.sourceId as PublicSourceId,
    mode: candidate.mode,
    ...(typeof candidate.since === "string" ? { since: candidate.since } : {}),
    ...(typeof candidate.operationTimeoutMs === "number"
      ? { operationTimeoutMs: candidate.operationTimeoutMs }
      : {}),
  };
};

const handlePublicSourceIngestionJob = (
  job: JobRecord,
): Effect.Effect<JobResult, unknown, PublicSourceIngestionRepository> =>
  Effect.gen(function* () {
    const payload = yield* Effect.try({
      try: () => parsePublicSourceIngestionPayload(job.payload),
      catch: (error) => error,
    });
    const since = payload.since ? new Date(payload.since) : undefined;
    if (payload.since && Number.isNaN(since?.getTime())) {
      return yield* Effect.fail(
        new Error("public_source_ingestion payload has an invalid since date"),
      );
    }

    const stats = yield* runPublicSourceIngestion(makePublicSourceAdapter(payload.sourceId), {
      mode: payload.mode,
      ...(since ? { since } : {}),
      ...(payload.operationTimeoutMs ? { operationTimeoutMs: payload.operationTimeoutMs } : {}),
    });

    if (stats.failedCount > 0) {
      yield* Effect.logWarning("public source ingestion completed with item failures").pipe(
        Effect.annotateLogs({
          sourceId: stats.sourceId,
          mode: stats.mode,
          failedCount: stats.failedCount,
          storedDocumentCount: stats.storedDocumentCount,
        }),
      );
    }

    return {
      status: "completed",
      message: `public source ingestion completed: ${stats.storedDocumentCount} stored, ${stats.failedCount} failed`,
    } satisfies JobResult;
  });

type AiChatRunJobPayload = {
  readonly aiRunId: string;
};

export interface HandleJobOptions {
  readonly signal?: AbortSignal | undefined;
  readonly smithersStorage?: SmithersStorage<typeof aiChatSchemas> | undefined;
  /** Hermetic configuration for bounded handler integration tests. */
  readonly config?: WorkerConfig | undefined;
  readonly operationsFactory?:
    | ((
        config: WorkerConfig,
        aiRunId: string,
        connectionString: string,
      ) => CanonicalWorkflowOperations)
    | undefined;
}

const runAiWorkflowDb = runAiProductState;

interface TerminalRunRow {
  readonly terminal: boolean;
  readonly smithersRunId: string | null;
}

const smithersTerminalMetadataReadFailureTag = Symbol("smithersTerminalMetadataReadFailure");

class SmithersTerminalMetadataReadFailure extends Error {
  readonly [smithersTerminalMetadataReadFailureTag] = true;

  constructor() {
    super("unable to read Smithers terminal metadata");
    this.name = "SmithersTerminalMetadataReadFailure";
  }
}

const isSmithersTerminalMetadataReadFailure = (error: unknown): boolean =>
  typeof error === "object" && error !== null && smithersTerminalMetadataReadFailureTag in error;

const parseAiChatRunPayload = (payload: unknown): AiChatRunJobPayload => {
  if (!payload || typeof payload !== "object") {
    throw new Error("ai_chat_run payload must be an object");
  }

  const candidate = payload as Record<string, unknown>;
  if (typeof candidate.aiRunId !== "string" || candidate.aiRunId.length === 0) {
    throw new Error("ai_chat_run payload has an invalid aiRunId");
  }

  return { aiRunId: candidate.aiRunId };
};

const validateEmptyMaintenancePayload = (payload: unknown, kind: string): void => {
  if (payload === undefined || payload === null) {
    return;
  }

  if (typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`${kind} payload must be an empty object`);
  }

  if (Object.keys(payload).length !== 0) {
    throw new Error(`${kind} payload must be an empty object`);
  }
};

export const deriveAiChatSmithersRunId = (aiRunId: string): string => `ai-chat:${aiRunId}`;

export const assertCanonicalAiChatSmithersRunId = (
  aiRunId: string,
  smithersRunId: string | null,
  expectedSmithersRunId: string = deriveAiChatSmithersRunId(aiRunId),
): void => {
  if (smithersRunId !== null && smithersRunId !== expectedSmithersRunId) {
    throw new AiRunSmithersRunIdMismatch(aiRunId, smithersRunId, expectedSmithersRunId);
  }
};

const isAiChatSmithersRunIdMismatch = (error: unknown, seen = new Set<unknown>()): boolean => {
  if (error instanceof AiRunSmithersRunIdMismatch) return true;
  if (typeof error !== "object" || error === null || seen.has(error)) return false;
  seen.add(error);
  if (!("cause" in error)) return false;
  return isAiChatSmithersRunIdMismatch((error as { readonly cause?: unknown }).cause, seen);
};

const assertCanonicalAiChatSmithersRunIdEffect = (
  aiRunId: string,
  smithersRunId: string | null,
  expectedSmithersRunId: string = deriveAiChatSmithersRunId(aiRunId),
) =>
  Effect.try({
    try: () => assertCanonicalAiChatSmithersRunId(aiRunId, smithersRunId, expectedSmithersRunId),
    catch: (error) => error,
  });

const isResumeMetadataMismatch = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { readonly code?: unknown }).code)
      : "";

  return code === resumeMetadataMismatchCode || message.includes(resumeMetadataMismatchCode);
};

const runJsonLog = (effect: Effect.Effect<void>): Promise<void> =>
  Effect.runPromise(
    effect.pipe(Effect.provide(JsonLoggerLayer), Effect.annotateLogs(serviceLogFields)),
  );

const localAiPhaseLogger: AiPhaseLogger = (entry) =>
  runJsonLog(
    Effect.logInfo("ai chat phase").pipe(
      Effect.annotateLogs({ component: "ai_chat", ...safeAiPhaseLogFields(entry) }),
    ),
  );

const runResultError = (result: unknown): unknown =>
  typeof result === "object" && result !== null && "error" in result
    ? (result as { readonly error?: unknown }).error
    : undefined;

const topicFromTaskId = (taskId: string): "t1" | "t2" | "t3" | undefined => {
  const topicId = /^topic-(t[123])-/u.exec(taskId)?.[1];
  return topicId === "t1" || topicId === "t2" || topicId === "t3" ? topicId : undefined;
};

export interface TerminalAiFailure {
  readonly code: AiRunErrorCode;
  readonly retryable: boolean;
}

const smithersTerminalErrorLaneSchema = z.strictObject({
  runErrorJson: z.string().max(131_072).nullable(),
  attemptErrorJson: z.array(z.string().max(131_072)).max(128),
});

const smithersTerminalErrorEnvelopeSchema = z.strictObject({
  workflow: z.unknown(),
  durable: smithersTerminalErrorLaneSchema,
});

const terminalAiFailureFallback = (): TerminalAiFailure => ({
  code: "finalization_failed",
  retryable: isRetryableAiRunError("finalization_failed"),
});

export const terminalAiFailure = (error: unknown): TerminalAiFailure => {
  const runtimeMetadata = aiRuntimeFailureMetadata(error);
  if (runtimeMetadata !== undefined) {
    return { code: runtimeMetadata.code, retryable: runtimeMetadata.retryable };
  }
  let envelope: ReturnType<typeof smithersTerminalErrorEnvelopeSchema.safeParse>;
  try {
    envelope = smithersTerminalErrorEnvelopeSchema.safeParse(error);
  } catch {
    return terminalAiFailureFallback();
  }
  if (!envelope.success) return terminalAiFailureFallback();

  const { runErrorJson, attemptErrorJson } = envelope.data.durable;
  const orderedDurableRecords = [
    ...(runErrorJson === null ? [] : [runErrorJson]),
    ...attemptErrorJson,
  ];
  for (const record of orderedDurableRecords) {
    const metadata = aiRuntimeFailureMetadataFromDurableJson(record);
    if (metadata !== undefined) {
      return { code: metadata.code, retryable: metadata.retryable };
    }
  }
  return terminalAiFailureFallback();
};

const loadSmithersTerminalError = (
  connectionString: string,
  smithersRunId: string,
): Promise<unknown> =>
  runAiWorkflowDb(
    connectionString,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      const rows = yield* sql<{
        readonly runErrorJson: string | null;
        readonly attemptErrorJson: readonly string[];
      }>`
        select runs.error_json as "runErrorJson",
               coalesce(
                 array(
                   select attempts.error_json
                   from _smithers_attempts attempts
                   where attempts.run_id = runs.run_id
                     and attempts.error_json is not null
                   order by attempts.finished_at_ms desc nulls last,
                            attempts.node_id,
                            attempts.iteration desc,
                            attempts.attempt desc
                   limit 128
                 ),
                 array[]::text[]
               ) as "attemptErrorJson"
        from _smithers_runs runs
        where runs.run_id = ${smithersRunId}
      `;
      return rows[0] ?? null;
    }),
  ).catch(() => {
    throw new SmithersTerminalMetadataReadFailure();
  });

const loadRunTerminalState = (connectionString: string, aiRunId: string) =>
  runAiWorkflowDb(
    connectionString,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      const rows = yield* sql<TerminalRunRow>`
        select
          (finished_at is not null or failed_at is not null) as terminal,
          smithers_run_id as "smithersRunId"
        from ai_runs
        where id = ${aiRunId}
      `;
      const row = rows[0];

      if (row === undefined) {
        throw new Error(`ai run not found: ${aiRunId}`);
      }

      return row;
    }),
  );

const setRunSmithersRunId = (connectionString: string, aiRunId: string, smithersRunId: string) =>
  runAiWorkflowDb(
    connectionString,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      const bound = yield* sql<{ readonly smithersRunId: string | null }>`
        update ai_runs
        set smithers_run_id = ${smithersRunId}
        where id = ${aiRunId}
          and (smithers_run_id is null or smithers_run_id = ${smithersRunId})
        returning smithers_run_id as "smithersRunId"
      `;
      if (bound.length === 1) return bound[0]!;

      const rows = yield* sql<{ readonly smithersRunId: string | null }>`
        select smithers_run_id as "smithersRunId"
        from ai_runs
        where id = ${aiRunId}
      `;
      const row = rows[0];
      if (row === undefined) {
        throw new Error(`ai run not found: ${aiRunId}`);
      }
      return row;
    }),
  );

/**
 * Fence Smithers cleanup to the durable owner in the same PostgreSQL
 * transaction as the delete.  The row lock makes a concurrent coordinate
 * replacement wait until this decision commits; a stale coordinate therefore
 * cannot delete another run's durable Smithers state.
 */
const deleteSmithersRowsForRunIfFenced = (
  connectionString: string,
  aiRunId: string,
  smithersRunId: string,
): Promise<void> =>
  runAiWorkflowDb(
    connectionString,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{ readonly smithersRunId: string | null }>`
            select smithers_run_id as "smithersRunId"
            from ai_runs
            where id = ${aiRunId}
            for update
          `;
          const row = rows[0];
          if (row === undefined) {
            return yield* Effect.fail(new Error(`ai run not found: ${aiRunId}`));
          }
          if (row.smithersRunId !== smithersRunId) {
            return yield* Effect.fail(
              new AiRunSmithersRunIdMismatch(aiRunId, row.smithersRunId, smithersRunId),
            );
          }
          yield* deleteSmithersRowsForRun(smithersRunId);
        }),
      );
    }),
  ).then(() => undefined);

const markRunFailedForResumeMismatch = (connectionString: string, aiRunId: string): Promise<void> =>
  runAiWorkflowDb(
    connectionString,
    failAiRun(
      aiRunId,
      "workflow_resume_incompatible",
      undefined,
      deriveAiChatSmithersRunId(aiRunId),
    ),
  ).then(() => undefined);

const markRunFailedForSmithersTerminalStatus = (
  connectionString: string,
  aiRunId: string,
  smithersRunId: string,
  status: "failed" | "cancelled",
  error: unknown,
): Promise<void> =>
  runAiWorkflowDb(
    connectionString,
    Effect.gen(function* () {
      const failure = terminalAiFailure(error);
      yield* failAiRun(aiRunId, failure.code, failure.retryable, smithersRunId);
      yield* Effect.logError("ai chat Smithers run ended terminal without finishing").pipe(
        Effect.annotateLogs({
          aiRunId,
          status,
          errorCode: failure.code,
          retryable: failure.retryable,
        }),
      );
    }),
  );

const markRunFailedForUnexpectedError = (
  connectionString: string,
  aiRunId: string,
): Promise<void> =>
  runAiWorkflowDb(
    connectionString,
    failAiRun(
      aiRunId,
      "finalization_failed",
      isRetryableAiRunError("finalization_failed"),
      deriveAiChatSmithersRunId(aiRunId),
    ),
  ).then(() =>
    deleteSmithersRowsForRunIfFenced(connectionString, aiRunId, deriveAiChatSmithersRunId(aiRunId)),
  );

export const makeWebResearchBoundary = (
  connectionString: string,
  aiRunId: string,
  config: WorkerConfig,
): WebResearchBoundary => {
  const requestIndexes = new Map<string, number>();
  const persist = async (
    coordinates: PiBoundaryCoordinates,
    operation: WebOperationAccounting,
    signal?: AbortSignal,
  ) => {
    throwIfAborted(signal);
    const requestKey = `${coordinates.taskId}:${coordinates.loopIteration}:${coordinates.attempt}`;
    const toolRequestIndex = requestIndexes.get(requestKey) ?? 0;
    requestIndexes.set(requestKey, toolRequestIndex + 1);
    await runAiWorkflowDb(
      connectionString,
      insertAiExternalToolUsage({
        runId: aiRunId,
        taskId: coordinates.taskId,
        loopIteration: coordinates.loopIteration,
        attempt: coordinates.attempt,
        toolRequestIndex,
        providerServiceId:
          operation.provider === "tinyfish"
            ? TINYFISH_SEARCH_PROVIDER_SERVICE_ID
            : operation.provider,
        operation: operation.kind === "search" ? "web_search" : "web_fetch",
        status:
          operation.outcome === "succeeded"
            ? "ok"
            : operation.outcome === "empty"
              ? "empty"
              : "failed",
        resultCount: operation.resultCount,
        responseBytes: operation.responseBytes,
        billedUnits: null,
        durationMs: operation.durationMs,
      }),
      signal === undefined ? undefined : { signal },
    );
    throwIfAborted(signal);
    await localAiPhaseLogger({
      phase: operation.kind === "search" ? "web_search_call" : "web_fetch_call",
      status: operation.outcome === "failed" ? "failed" : "succeeded",
      runId: aiRunId,
      taskId: coordinates.taskId,
      ...(topicFromTaskId(coordinates.taskId) === undefined
        ? {}
        : { topicId: topicFromTaskId(coordinates.taskId) }),
      durationMs: operation.durationMs,
      attempt: coordinates.attempt,
      loopIteration: coordinates.loopIteration,
      providerRequestIndex: coordinates.providerRequestIndex,
      itemCount: operation.resultCount,
      totalTokens: 0,
    });
    throwIfAborted(signal);
  };
  if (config.nodeEnv === "test" && config.aiE2eFakeProvider) {
    const text =
      "Deterministic web evidence reports that French solar-grid monitoring should track connection queues and storage availability.";
    return {
      search: async (
        _query,
        _locale,
        _market,
        acceptedPolicy,
        coordinates,
        _cursor,
        signal,
      ) => {
        throwIfAborted(signal);
        if (!acceptedPolicy.enabled || acceptedPolicy.provider !== "tinyfish") {
          throw new WebBoundaryError(
            "unsupported_policy",
            "saved web provider is unavailable",
            false,
          );
        }
        throwIfAborted(signal);
        await persist(
          coordinates,
          {
            kind: "search",
            provider: "tinyfish",
            outcome: "succeeded",
            resultCount: 1,
            responseBytes: 256,
            durationMs: 1,
          },
          signal,
        );
        throwIfAborted(signal);
        return {
          results: [
            {
              url: "https://e2e.example/web/solar-grid",
              title: "Deterministic solar grid update",
              domain: "e2e.example",
              snippet: "Connection queues and storage remain the main monitoring signals.",
            },
          ],
          complete: true,
          truncated: false,
          cursor: null,
          scope: {
            kind: "provider_ranked_results",
            maximumResults: 10,
            cursorSupported: false,
          },
        };
      },
      fetch: async (url, acceptedPolicy, coordinates, signal) => {
        throwIfAborted(signal);
        if (!acceptedPolicy.enabled || acceptedPolicy.provider !== "tinyfish") {
          throw new WebBoundaryError(
            "unsupported_policy",
            "saved web provider is unavailable",
            false,
          );
        }
        throwIfAborted(signal);
        await persist(
          coordinates,
          {
            kind: "fetch",
            provider: "brief_fetch",
            outcome: "succeeded",
            resultCount: 1,
            responseBytes: new TextEncoder().encode(text).byteLength,
            durationMs: 1,
          },
          signal,
        );
        throwIfAborted(signal);
        return {
          url,
          title: "Deterministic solar grid update",
          domain: "e2e.example",
          text,
          publishedAt: "2026-07-10T00:00:00.000Z",
          capturedAt: "2026-07-10T00:00:01.000Z",
        };
      },
    };
  }

  return {
    search: async (
      query,
      locale,
      market,
      acceptedPolicy,
      coordinates,
      _cursor,
      signal,
    ) => {
      try {
        throwIfAborted(signal);
        const response = await searchTinyfishWeb(query, 10, {
          apiKey: config.tinyfishApiKey,
          locale,
          market,
          acceptedPolicy,
          maxDomainFilters: TINYFISH_SEARCH_DOMAIN_FILTER_HARD_MAX,
          signal,
        });
        throwIfAborted(signal);
        for (const operation of response.operations) {
          await persist(coordinates, operation, signal);
        }
        throwIfAborted(signal);
        // Tinyfish exposes a fixed page-0 boundary with no cursor. Preserve
        // the adapter's pre-dedup completeness decision; deriving this from
        // the unique URL list would let an incomplete provider page collapse
        // to fewer rows and silently bypass the continuation requirement.
        const truncated = response.truncated;
        return {
          results: response.results,
          complete: response.complete,
          truncated,
          cursor: null,
          scope: {
            kind: "provider_ranked_results",
            maximumResults: 10,
            cursorSupported: false,
          },
        };
      } catch (error) {
        await persistWebBoundaryErrorOperations(
          error,
          (operation) => persist(coordinates, operation, signal),
          signal,
        );
        throw error;
      }
    },
    fetch: async (url, acceptedPolicy, coordinates, signal) => {
      try {
        throwIfAborted(signal);
        const page = await safeFetchPage(url, {
          acceptedPolicy,
          signal,
        });
        throwIfAborted(signal);
        await persist(coordinates, page.operation, signal);
        throwIfAborted(signal);
        return {
          url: page.canonicalUrl,
          title: page.title,
          domain: page.domain,
          text: page.text,
          ...(page.publishedAt === undefined ? {} : { publishedAt: page.publishedAt }),
          capturedAt: page.capturedAt,
        };
      } catch (error) {
        await persistWebBoundaryErrorOperations(
          error,
          (operation) => persist(coordinates, operation, signal),
          signal,
        );
        throw error;
      }
    },
  };
};

export const persistWebBoundaryErrorOperations = async (
  error: unknown,
  persist: (operation: WebOperationAccounting) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> => {
  throwIfAborted(signal);
  if (!(error instanceof WebBoundaryError)) return;
  for (const operation of error.operations) {
    throwIfAborted(signal);
    await persist(operation);
  }
  throwIfAborted(signal);
};

/**
 * Canonical production operations factory. Evaluation uses this same real
 * Tinyfish search and Brief-owned fetch boundary; model requests cross the
 * exact real Pi/Z.AI boundary and retain the same durable measurement hooks.
 */
export const providerServiceIdForConfig = (
  config: WorkerConfig,
): "zai_coding_plan_official" | "deterministic_test" | "openai_compatible_custom" =>
  config.nodeEnv === "test" && config.aiE2eFakeProvider
    ? "deterministic_test"
    : config.aiBaseUrl === ZAI_CODING_PLAN_BASE_URL
      ? ZAI_CODING_PLAN_PROVIDER_SERVICE_ID
      : "openai_compatible_custom";

export const makeDurableProviderBoundary = (
  connectionString: string,
  aiRunId: string,
  config: WorkerConfig,
): ExactPiBoundary | DeterministicE2eProviderBoundary => {
  const providerServiceId = providerServiceIdForConfig(config);
  const boundaryOptions: PiBoundaryOptions = {
    apiKey: config.zaiApiKey,
    baseUrl: config.aiBaseUrl,
    providerServiceId,
    fastModelId: config.aiFastModel,
    mainModelId: config.aiMainModel,
    requireAcceptedProviderProfile: true,
    loadAcceptedProviderProfile: async () => {
      const signal = currentTaskAbortSignal();
      return runAiWorkflowDb(
        connectionString,
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const rows = yield* sql<{ readonly scope: unknown }>`
            select acceptance_scope as scope from ai_runs where id = ${aiRunId} for share
          `;
          const scope = decodeRunAcceptanceScope(rows[0]?.scope);
          return {
            providerServiceId: scope.provider,
            fastModelId: scope.fastModelId,
            mainModelId: scope.mainModelId,
          } as const;
        }),
        signal === undefined ? undefined : { signal },
      );
    },
    fastLimits: {
      inputTokens: config.aiFastInputMaxTokens,
      outputTokens: config.aiFastOutputMaxTokens,
    },
    mainLimits: {
      inputTokens: config.aiMainInputMaxTokens,
      outputTokens: config.aiMainOutputMaxTokens,
    },
    fastTimeoutMs: config.aiFastTaskTimeoutMs,
    answerTimeoutMs: config.aiAnswerTimeoutMs,
    hooks: {
      onMeasurement: async (
        coordinates,
        measurement,
        request,
        sourceExposureProofSha256Hexes,
        sourceExposureProofBindings,
      ) => {
        const signal = currentTaskAbortSignal();
        throwIfAborted(signal);
        await runAiWorkflowDb(
          connectionString,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            const rows = yield* sql<{ readonly chatId: string }>`
              select chat_id::text as "chatId" from ai_runs where id = ${aiRunId}
            `;
            const chatId = rows[0]?.chatId;
            if (chatId === undefined) return yield* Effect.fail(new Error("ai run not found"));
            yield* insertAiObservation({
              runId: aiRunId,
              chatId,
              emittingTask: coordinates.taskId,
              loopIteration: coordinates.loopIteration,
              attempt: coordinates.attempt,
              observationKey: [
                "provider_request_measurement",
                coordinates.taskId,
                coordinates.loopIteration,
                coordinates.attempt,
                coordinates.providerRequestIndex,
              ].join(":"),
              kind: "provider_request_measurement",
              payload: {
                agentRole: coordinates.agentRole,
                modelId: measurement.modelId,
                requestSha256Hex: providerRequestSha256Hex(request),
                sourceExposureProofSha256Hexes,
                sourceExposureProofBindings: sourceExposureProofBindings.map(
                  ({ providerSerializationProofSha256Hex, binding }) => ({
                    providerSerializationProofSha256Hex,
                    providerSerializationProofBinding: binding,
                  }),
                ),
                providerRequestIndex: coordinates.providerRequestIndex,
                inputTokens: measurement.inputTokens,
                requestedOutputTokens: measurement.requestedOutputTokens,
                usableInputTokens: measurement.usableInputTokens,
                contextWindow: measurement.contextWindow,
                passed: measurement.passed,
              },
            });
          }),
          signal === undefined ? undefined : { signal },
        );
        throwIfAborted(signal);
        await localAiPhaseLogger({
          phase: "exact_provider_gate",
          status: measurement.passed ? "passed" : "rejected",
          runId: aiRunId,
          taskId: coordinates.taskId,
          ...(topicFromTaskId(coordinates.taskId) === undefined
            ? {}
            : { topicId: topicFromTaskId(coordinates.taskId) }),
          model: measurement.modelId,
          attempt: coordinates.attempt,
          loopIteration: coordinates.loopIteration,
          providerRequestIndex: coordinates.providerRequestIndex,
          inputTokens: measurement.inputTokens,
          requestedOutputTokens: measurement.requestedOutputTokens,
          usableInputTokens: measurement.usableInputTokens,
          ...(measurement.passed ? {} : { errorCode: "agent_context_budget_exceeded" }),
        });
        throwIfAborted(signal);
      },
      onUsage: async (coordinates, modelId, usage) => {
        const signal = currentTaskAbortSignal();
        throwIfAborted(signal);
        await runAiWorkflowDb(
          connectionString,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            const rows = yield* sql<{ readonly scope: unknown }>`
              select acceptance_scope as scope from ai_runs where id = ${aiRunId} for share
            `;
            const scope = decodeRunAcceptanceScope(rows[0]?.scope);
            yield* insertAiRunUsage({
              runId: aiRunId,
              taskId: coordinates.taskId,
              loopIteration: coordinates.loopIteration,
              attempt: coordinates.attempt,
              providerRequestIndex: coordinates.providerRequestIndex,
              agentRole: coordinates.agentRole,
              modelId,
              providerServiceId: scope.provider,
              usage,
            });
          }),
          signal === undefined ? undefined : { signal },
        );
        throwIfAborted(signal);
        await localAiPhaseLogger({
          phase: "provider_call",
          status: "succeeded",
          runId: aiRunId,
          taskId: coordinates.taskId,
          ...(topicFromTaskId(coordinates.taskId) === undefined
            ? {}
            : { topicId: topicFromTaskId(coordinates.taskId) }),
          model: modelId,
          attempt: coordinates.attempt,
          loopIteration: coordinates.loopIteration,
          providerRequestIndex: coordinates.providerRequestIndex,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens,
        });
        throwIfAborted(signal);
      },
    },
  };
  return config.nodeEnv === "test" && config.aiE2eFakeProvider
    ? new DeterministicE2eProviderBoundary({
        ...boundaryOptions,
        waitForStreamGate: (gateId, signal) =>
          runAiWorkflowDb(
            connectionString,
            Effect.gen(function* () {
              const sql = yield* PgClient.PgClient;
              yield* sql`
                select pg_advisory_xact_lock(hashtext(${e2eStreamGateLockKey(gateId)}))
              `;
            }),
            signal === undefined ? undefined : { signal },
          ),
      })
    : new ExactPiBoundary(boundaryOptions);
};

export const makeCanonicalOperations = (
  connectionString: string,
  aiRunId: string,
  config: WorkerConfig,
  webResearchBoundary?: WebResearchBoundary,
): CanonicalWorkflowOperations => {
  const boundary = makeDurableProviderBoundary(connectionString, aiRunId, config);
  const providerServiceId = providerServiceIdForConfig(config);
  return new CanonicalWorkflowOperations(
    connectionString,
    { ...config, providerServiceId },
    new CanonicalAgentClient(boundary),
    webResearchBoundary ?? makeWebResearchBoundary(connectionString, aiRunId, config),
  );
};

export const handleAiChatRunJob = (
  job: JobRecord,
  options?: HandleJobOptions,
): Effect.Effect<JobResult, unknown> => {
  const aiRunIdForFailure =
    typeof job.payload === "object" &&
    job.payload !== null &&
    "aiRunId" in job.payload &&
    typeof (job.payload as { readonly aiRunId?: unknown }).aiRunId === "string" &&
    (job.payload as { readonly aiRunId: string }).aiRunId.length > 0
      ? (job.payload as { readonly aiRunId: string }).aiRunId
      : undefined;
  let connectionStringForFailure: string | undefined;

  const execution = Effect.gen(function* () {
    const payload = yield* Effect.try({
      try: () => parseAiChatRunPayload(job.payload),
      catch: (error) => error,
    });
    yield* Effect.logInfo("ai chat job started").pipe(
      Effect.annotateLogs({
        component: "ai_chat",
        jobId: job.id,
        jobKind: job.kind,
        aiRunId: payload.aiRunId,
      }),
    );
    const config = options?.config ?? (yield* loadWorkerConfig);
    const connectionString = config.databaseUrl;
    connectionStringForFailure = connectionString;
    const smithersRunId = deriveAiChatSmithersRunId(payload.aiRunId);
    const terminalState = yield* Effect.tryPromise(() =>
      loadRunTerminalState(connectionString, payload.aiRunId),
    );
    // Keep this check in the handler Effect rather than inside the database
    // Promise boundary so the typed mismatch remains visible to catchCause.
    yield* assertCanonicalAiChatSmithersRunIdEffect(
      payload.aiRunId,
      terminalState.smithersRunId,
      smithersRunId,
    );

    if (terminalState.terminal) {
      yield* Effect.logInfo("ai chat job already terminal").pipe(
        Effect.annotateLogs({
          component: "ai_chat",
          jobId: job.id,
          aiRunId: payload.aiRunId,
          smithersRunId: terminalState.smithersRunId,
        }),
      );
      if (terminalState.smithersRunId !== null) {
        yield* Effect.tryPromise({
          try: () =>
            deleteSmithersRowsForRunIfFenced(connectionString, payload.aiRunId, smithersRunId),
          catch: (error) => error,
        });
        yield* Effect.logInfo("ai chat Smithers rows cleaned").pipe(
          Effect.annotateLogs({
            component: "ai_chat",
            jobId: job.id,
            aiRunId: payload.aiRunId,
            smithersRunId,
            reason: "already_terminal",
          }),
        );
      }

      return {
        status: "completed",
        message: "ai chat run already terminal",
      } satisfies JobResult;
    }

    const boundState = yield* Effect.tryPromise(() =>
      setRunSmithersRunId(connectionString, payload.aiRunId, smithersRunId),
    );
    yield* assertCanonicalAiChatSmithersRunIdEffect(
      payload.aiRunId,
      boundState.smithersRunId,
      smithersRunId,
    );
    yield* Effect.logInfo("ai chat Smithers run id assigned").pipe(
      Effect.annotateLogs({
        component: "ai_chat",
        jobId: job.id,
        aiRunId: payload.aiRunId,
        smithersRunId,
      }),
    );

    const unloggedOperations =
      options?.operationsFactory?.(config, payload.aiRunId, connectionString) ??
      makeCanonicalOperations(connectionString, payload.aiRunId, config);
    const operations = withAiPhaseLogging(unloggedOperations, {
      logger: localAiPhaseLogger,
      fastModel: RUNTIME_MODEL_ID,
      mainModel: RUNTIME_MODEL_ID,
    });

    const result = yield* Effect.tryPromise({
      try: (effectSignal) =>
        runWithAiChatSmithersProducerFence(connectionString, async () => {
          const workflowAbortController = new AbortController();
          const removeEffectAbortForwarder = forwardAbortSignal(
            effectSignal,
            workflowAbortController,
          );
          const removeExplicitAbortForwarder = forwardAbortSignal(
            options?.signal,
            workflowAbortController,
          );
          const signal = workflowAbortController.signal;
          let api: SmithersStorage<typeof aiChatSchemas> | undefined;
          const ownsStorage = options?.smithersStorage === undefined;
          try {
            throwIfAborted(signal);
            api =
              options?.smithersStorage ??
              (await createSmithersStorage(aiChatSchemas, { connectionString }));
            throwIfAborted(signal);
            const workflow = buildAiChatWorkflow(api, {
              config,
              operations,
            });
            const resume = await smithersRunExists(api, smithersRunId);
            throwIfAborted(signal);

            await runJsonLog(
              Effect.logInfo("ai chat Smithers workflow launching").pipe(
                Effect.annotateLogs({
                  component: "ai_chat",
                  jobId: job.id,
                  aiRunId: payload.aiRunId,
                  smithersRunId,
                  resume,
                }),
              ),
            );
            throwIfAborted(signal);

            const workflowResult = await runSmithersWorkflow(workflow, {
              runId: smithersRunId,
              input: { aiRunId: payload.aiRunId },
              maxConcurrency: aiChatSmithersMaxConcurrency(config),
              logDir: null,
              resume,
              signal,
            });
            throwIfAborted(signal);
            await runJsonLog(
              Effect.logInfo("ai chat Smithers workflow ended").pipe(
                Effect.annotateLogs({
                  component: "ai_chat",
                  jobId: job.id,
                  aiRunId: payload.aiRunId,
                  smithersRunId,
                  status: workflowResult.status,
                }),
              ),
            );

            if (workflowResult.status === "failed" || workflowResult.status === "cancelled") {
              const durableError = await loadSmithersTerminalError(connectionString, smithersRunId);
              return {
                ...workflowResult,
                error: {
                  workflow: workflowResult.error,
                  durable: durableError,
                },
              };
            }
            return workflowResult;
          } finally {
            try {
              if (ownsStorage && api !== undefined) await api.close();
            } finally {
              removeExplicitAbortForwarder();
              removeEffectAbortForwarder();
            }
          }
        }),
      catch: (error) => error,
    }).pipe(
      Effect.catch((error) =>
        isResumeMetadataMismatch(error)
          ? Effect.tryPromise({
              try: () => markRunFailedForResumeMismatch(connectionString, payload.aiRunId),
              catch: (error) => error,
            }).pipe(
              Effect.as({
                status: "finished",
                runId: smithersRunId,
              } as const),
            )
          : Effect.fail(error),
      ),
    );

    const terminalFailureStatus =
      result.status === "failed" ? "failed" : result.status === "cancelled" ? "cancelled" : null;

    if (result.status === "cancelled" && options?.signal?.aborted === true) {
      yield* Effect.logInfo("ai chat Smithers rows retained for crash-safe resume").pipe(
        Effect.annotateLogs({
          component: "ai_chat",
          jobId: job.id,
          aiRunId: payload.aiRunId,
          smithersRunId,
          reason: "worker_aborted",
        }),
      );
      return yield* Effect.fail(new Error(`ai-chat Smithers run aborted: ${smithersRunId}`));
    }

    if (terminalFailureStatus !== null) {
      yield* Effect.tryPromise({
        try: () =>
          markRunFailedForSmithersTerminalStatus(
            connectionString,
            payload.aiRunId,
            smithersRunId,
            terminalFailureStatus,
            runResultError(result),
          ),
        catch: (error) => error,
      });
      yield* Effect.tryPromise({
        try: () =>
          deleteSmithersRowsForRunIfFenced(connectionString, payload.aiRunId, smithersRunId),
        catch: (error) => error,
      });
      yield* Effect.logInfo("ai chat Smithers rows cleaned").pipe(
        Effect.annotateLogs({
          component: "ai_chat",
          jobId: job.id,
          aiRunId: payload.aiRunId,
          smithersRunId,
          reason: terminalFailureStatus,
        }),
      );

      return {
        status: "completed",
        message: `ai chat run failed: ${payload.aiRunId}`,
      } satisfies JobResult;
    }

    if (result.status !== "finished") {
      return yield* Effect.fail(
        new Error(`ai-chat Smithers run ${smithersRunId} ended with status ${result.status}`),
      );
    }

    yield* Effect.tryPromise({
      try: () => deleteSmithersRowsForRunIfFenced(connectionString, payload.aiRunId, smithersRunId),
      catch: (error) => error,
    });
    yield* Effect.logInfo("ai chat Smithers rows cleaned").pipe(
      Effect.annotateLogs({
        component: "ai_chat",
        jobId: job.id,
        aiRunId: payload.aiRunId,
        smithersRunId,
        reason: "finished",
      }),
    );

    return {
      status: "completed",
      message: `ai chat run completed: ${payload.aiRunId}`,
    } satisfies JobResult;
  });
  return execution.pipe(
    Effect.catchCause((cause) => {
      const connectionString = connectionStringForFailure;
      const terminalMetadataReadFailure = Cause.findErrorOption(cause);
      if (
        aiRunIdForFailure === undefined ||
        connectionString === undefined ||
        options?.signal?.aborted === true ||
        Cause.hasInterrupts(cause) ||
        (terminalMetadataReadFailure._tag === "Some" &&
          isAiChatSmithersRunIdMismatch(terminalMetadataReadFailure.value)) ||
        (terminalMetadataReadFailure._tag === "Some" &&
          isSmithersTerminalMetadataReadFailure(terminalMetadataReadFailure.value))
      ) {
        return Effect.failCause(cause);
      }

      return Effect.tryPromise({
        try: () => markRunFailedForUnexpectedError(connectionString, aiRunIdForFailure),
        catch: (error) => error,
      }).pipe(
        Effect.catchCause(() => Effect.void),
        Effect.andThen(Effect.failCause(cause)),
      );
    }),
  );
};

const handlePurgeAiRuntimeJob = (job: JobRecord): Effect.Effect<JobResult, unknown> =>
  Effect.gen(function* () {
    yield* Effect.try({
      try: () => validateEmptyMaintenancePayload(job.payload, "purge_ai_runtime"),
      catch: (error) => error,
    });
    const connectionString = yield* loadDatabaseUrl;
    const result = yield* Effect.tryPromise(() =>
      runAiWorkflowDb(connectionString, purgeAiRuntimeRetention()),
    );

    return {
      status: "completed",
      message: `purged ${result.sweptRuns} Smithers runs and ${result.prunedEvents} AI run events`,
    } satisfies JobResult;
  });

const handlePurgeUserMemoryTombstonesJob = (job: JobRecord): Effect.Effect<JobResult, unknown> =>
  Effect.gen(function* () {
    yield* Effect.try({
      try: () => validateEmptyMaintenancePayload(job.payload, "purge_user_memory_tombstones"),
      catch: (error) => error,
    });
    const connectionString = yield* loadDatabaseUrl;
    const result = yield* Effect.tryPromise(() =>
      runAiWorkflowDb(connectionString, purgeUserMemoryTombstones()),
    );

    return {
      status: "completed",
      message: `purged ${result.hardDeleted} memories, redacted ${result.madeProvenanceOnly}, and deleted ${result.revisionsDeleted} revisions`,
    } satisfies JobResult;
  });

export const handleJob = (
  job: JobRecord,
  options?: HandleJobOptions,
): Effect.Effect<
  JobResult,
  unknown,
  | PublicSourceIngestionRepository
  | PlatformFileStore
  | PdfTextExtractor
  | NotificationEmailService
  | ExportObjectStoreService
> =>
  Effect.gen(function* () {
    if (job.kind === "public_source_ingestion") {
      return yield* handlePublicSourceIngestionJob(job);
    }

    if (job.kind === "ai_chat_run") {
      return yield* handleAiChatRunJob(job, options);
    }

    if (job.kind === "purge_ai_runtime") {
      return yield* handlePurgeAiRuntimeJob(job);
    }

    if (job.kind === "purge_user_memory_tombstones") {
      return yield* handlePurgeUserMemoryTombstonesJob(job);
    }

    if (isPlatformJobKind(job.kind)) {
      return yield* handlePlatformJob(job);
    }

    yield* Effect.logError("unsupported worker job kind").pipe(
      Effect.annotateLogs({
        jobId: job.id,
        jobKind: job.kind,
      }),
    );

    return yield* Effect.fail(new Error(`unsupported worker job kind: ${job.kind}`));
  });
