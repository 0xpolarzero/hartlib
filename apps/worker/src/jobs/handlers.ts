import {
  makePublicSourceAdapter,
  publicSourceDefinitions,
  type PublicSourceId,
} from "@brief/source-ingestion";
import { PgClient } from "@effect/sql-pg";
import { Config, Effect } from "effect";
import {
  makeAiClient,
  makeEffectRetrievalExecutor,
  type AiClient,
  type RetrievalExecutor,
} from "../ai/llm";
import {
  createSmithersStorage,
  runSmithersWorkflow,
  smithersRunExists,
} from "../ai/smithers-interop";
import { aiChatSchemas, buildAiChatWorkflow } from "../ai/workflow/ai-chat";
import { appendAiRunEvent, runAiWorkflowDb } from "../ai/workflow/events";
import {
  deleteSmithersRowsForRun,
  pruneFinishedAiRunEvents,
  sweepAiChatSmithersRows,
} from "../ai/workflow/smithers-cleanup";
import { loadWorkerConfig } from "../config";
import { JsonLoggerLayer, serviceLogFields } from "../logging";
import { runPublicSourceIngestion } from "../source-ingestion/orchestrator";
import type { PublicSourceIngestionRepository } from "../source-ingestion/repository";
import type { PublicSourceIngestionOptions } from "../source-ingestion/types";
import type { WorkerConfig } from "../config";
import type { JobRecord, JobResult } from "./types";

const publicSourceIds = new Set<string>(publicSourceDefinitions.map((source) => source.id));
const defaultDatabaseUrl = "postgres://brief:brief@localhost:5432/brief";
const resumeMetadataMismatchCode = "RESUME_METADATA_MISMATCH";

type PublicSourceIngestionJobPayload = {
  readonly sourceId: PublicSourceId;
  readonly mode: PublicSourceIngestionOptions["mode"];
  readonly since?: string;
  readonly operationTimeoutMs?: number;
};

const parsePublicSourceIngestionPayload = (payload: unknown): PublicSourceIngestionJobPayload => {
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
  readonly aiClientFactory?:
    | ((config: WorkerConfig, retrieval: RetrievalExecutor) => AiClient)
    | undefined;
}

type PurgeAiRuntimeJobPayload = {
  readonly gracePeriodMs?: number;
};

interface TerminalRunRow {
  readonly terminal: boolean;
  readonly smithersRunId: string | null;
}

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

const parsePurgeAiRuntimePayload = (payload: unknown): PurgeAiRuntimeJobPayload => {
  if (payload === undefined || payload === null) {
    return {};
  }

  if (typeof payload !== "object") {
    throw new Error("purge_ai_runtime payload must be an object");
  }

  const candidate = payload as Record<string, unknown>;
  if (
    "gracePeriodMs" in candidate &&
    (typeof candidate.gracePeriodMs !== "number" ||
      !Number.isFinite(candidate.gracePeriodMs) ||
      candidate.gracePeriodMs < 0)
  ) {
    throw new Error("purge_ai_runtime payload has an invalid gracePeriodMs");
  }

  return typeof candidate.gracePeriodMs === "number"
    ? { gracePeriodMs: candidate.gracePeriodMs }
    : {};
};

export const deriveAiChatSmithersRunId = (aiRunId: string): string => `ai-chat:${aiRunId}`;

const isResumeMetadataMismatch = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { readonly code?: unknown }).code)
      : "";

  return code === resumeMetadataMismatchCode || message.includes(resumeMetadataMismatchCode);
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const runJsonLog = (effect: Effect.Effect<void>): Promise<void> =>
  Effect.runPromise(
    effect.pipe(Effect.provide(JsonLoggerLayer), Effect.annotateLogs(serviceLogFields)),
  );

const runResultError = (result: unknown): unknown =>
  typeof result === "object" && result !== null && "error" in result
    ? (result as { readonly error?: unknown }).error
    : undefined;

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
      yield* sql`
        update ai_runs
        set smithers_run_id = coalesce(smithers_run_id, ${smithersRunId})
        where id = ${aiRunId}
      `;
    }),
  );

const markRunFailedForResumeMismatch = (connectionString: string, aiRunId: string): Promise<void> =>
  runAiWorkflowDb(
    connectionString,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;

      yield* sql`
        update ai_runs
        set failed_at = coalesce(failed_at, now()),
            error = ${resumeMetadataMismatchCode}
        where id = ${aiRunId}
          and finished_at is null
      `;
      yield* appendAiRunEvent(aiRunId, {
        type: "error",
        code: resumeMetadataMismatchCode,
        retryable: true,
      });
    }),
  );

const smithersTerminalFailureCode = (status: string): string => `smithers_run_${status}`;

const markRunFailedForSmithersTerminalStatus = (
  connectionString: string,
  aiRunId: string,
  status: "failed" | "cancelled",
  error: unknown,
): Promise<void> =>
  runAiWorkflowDb(
    connectionString,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      const code = smithersTerminalFailureCode(status);

      yield* sql`
        update ai_runs
        set failed_at = coalesce(failed_at, now()),
            error = ${code}
        where id = ${aiRunId}
          and finished_at is null
      `;
      yield* appendAiRunEvent(aiRunId, {
        type: "error",
        code,
      });
      yield* Effect.logError("ai chat Smithers run ended terminal without finishing").pipe(
        Effect.annotateLogs({
          aiRunId,
          status,
          error: errorMessage(error),
        }),
      );
    }),
  );

const handleAiChatRunJob = (
  job: JobRecord,
  options?: HandleJobOptions,
): Effect.Effect<JobResult, unknown> =>
  Effect.gen(function* () {
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
    const config = yield* loadWorkerConfig;
    const connectionString = yield* Config.string("DATABASE_URL").pipe(
      Config.withDefault(defaultDatabaseUrl),
    );
    const smithersRunId = deriveAiChatSmithersRunId(payload.aiRunId);
    const terminalState = yield* Effect.tryPromise(() =>
      loadRunTerminalState(connectionString, payload.aiRunId),
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
        const smithersRunIdToDelete = terminalState.smithersRunId;
        yield* Effect.tryPromise(() =>
          runAiWorkflowDb(connectionString, deleteSmithersRowsForRun(smithersRunIdToDelete)),
        );
        yield* Effect.logInfo("ai chat Smithers rows cleaned").pipe(
          Effect.annotateLogs({
            component: "ai_chat",
            jobId: job.id,
            aiRunId: payload.aiRunId,
            smithersRunId: smithersRunIdToDelete,
            reason: "already_terminal",
          }),
        );
      }

      return {
        status: "completed",
        message: "ai chat run already terminal",
      } satisfies JobResult;
    }

    yield* Effect.tryPromise(() =>
      setRunSmithersRunId(connectionString, payload.aiRunId, smithersRunId),
    );
    yield* Effect.logInfo("ai chat Smithers run id assigned").pipe(
      Effect.annotateLogs({
        component: "ai_chat",
        jobId: job.id,
        aiRunId: payload.aiRunId,
        smithersRunId,
      }),
    );

    const runRetrievalEffect = <A, E, R>(effect: Effect.Effect<A, E, R>): Promise<A> =>
      runAiWorkflowDb(
        connectionString,
        effect as unknown as Effect.Effect<A, E, PgClient.PgClient>,
      );

    const retrieval = makeEffectRetrievalExecutor(runRetrievalEffect);
    const aiClient =
      options?.aiClientFactory?.(config, retrieval) ?? makeAiClient(config, retrieval);

    const result = yield* Effect.tryPromise({
      try: async () => {
        const api = await createSmithersStorage(aiChatSchemas, { connectionString });

        try {
          const workflow = buildAiChatWorkflow(api, {
            connectionString,
            config,
            aiClient,
          });
          const resume = await smithersRunExists(api, smithersRunId);

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

          const workflowResult = await runSmithersWorkflow(workflow, {
            runId: smithersRunId,
            input: { aiRunId: payload.aiRunId },
            logDir: null,
            resume,
            ...(options?.signal === undefined ? {} : { signal: options.signal }),
          });
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

          return workflowResult;
        } finally {
          await api.close();
        }
      },
      catch: (error) => error,
    }).pipe(
      Effect.catch((error) =>
        isResumeMetadataMismatch(error)
          ? Effect.tryPromise(() =>
              markRunFailedForResumeMismatch(connectionString, payload.aiRunId),
            ).pipe(
              Effect.as({
                status: "finished",
                runId: smithersRunId,
              } as const),
            )
          : options?.signal?.aborted === true
            ? Effect.tryPromise(() =>
                runAiWorkflowDb(connectionString, deleteSmithersRowsForRun(smithersRunId)),
              ).pipe(Effect.flatMap(() => Effect.fail(error)))
            : Effect.fail(error),
      ),
    );

    const terminalFailureStatus =
      result.status === "failed" ? "failed" : result.status === "cancelled" ? "cancelled" : null;

    if (result.status === "cancelled" && options?.signal?.aborted === true) {
      yield* Effect.tryPromise(() =>
        runAiWorkflowDb(connectionString, deleteSmithersRowsForRun(smithersRunId)),
      );
      yield* Effect.logInfo("ai chat Smithers rows cleaned").pipe(
        Effect.annotateLogs({
          component: "ai_chat",
          jobId: job.id,
          aiRunId: payload.aiRunId,
          smithersRunId,
          reason: "aborted",
        }),
      );
      return yield* Effect.fail(new Error(`ai-chat Smithers run aborted: ${smithersRunId}`));
    }

    if (terminalFailureStatus !== null) {
      yield* Effect.tryPromise(() =>
        markRunFailedForSmithersTerminalStatus(
          connectionString,
          payload.aiRunId,
          terminalFailureStatus,
          runResultError(result),
        ),
      );
      yield* Effect.tryPromise(() =>
        runAiWorkflowDb(connectionString, deleteSmithersRowsForRun(smithersRunId)),
      );
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

    yield* Effect.tryPromise(() =>
      runAiWorkflowDb(connectionString, deleteSmithersRowsForRun(smithersRunId)),
    );
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

const handlePurgeAiRuntimeJob = (job: JobRecord): Effect.Effect<JobResult, unknown> =>
  Effect.gen(function* () {
    const payload = yield* Effect.try({
      try: () => parsePurgeAiRuntimePayload(job.payload),
      catch: (error) => error,
    });
    const connectionString = yield* Config.string("DATABASE_URL").pipe(
      Config.withDefault(defaultDatabaseUrl),
    );
    const gracePeriodMs = payload.gracePeriodMs ?? 60 * 60 * 1000;
    const result = yield* Effect.tryPromise(() =>
      runAiWorkflowDb(
        connectionString,
        Effect.gen(function* () {
          const sweptRuns = yield* sweepAiChatSmithersRows();
          const prunedEvents = yield* pruneFinishedAiRunEvents(gracePeriodMs);

          return { sweptRuns, prunedEvents };
        }),
      ),
    );

    return {
      status: "completed",
      message: `purged ${result.sweptRuns} Smithers runs and ${result.prunedEvents} AI run events`,
    } satisfies JobResult;
  });

export const handleJob = (
  job: JobRecord,
  options?: HandleJobOptions,
): Effect.Effect<JobResult, unknown, PublicSourceIngestionRepository> =>
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

    yield* Effect.logInfo("handling job placeholder").pipe(
      Effect.annotateLogs({
        jobId: job.id,
        jobKind: job.kind,
      }),
    );

    return {
      status: "completed",
      message: "placeholder",
    } satisfies JobResult;
  });
