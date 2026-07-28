import { BunRuntime } from "@effect/platform-bun";
import { Effect } from "effect";
import { assertWorkerAiProviderPosture, loadWorkerConfig } from "./config";
import { JsonLoggerLayer, serviceLogFields } from "./logging";
import { setRuntimeCauseSink } from "./diagnostic-cause";
import { JobRepositoryPgLayer } from "./jobs/repository";
import { runWorker } from "./jobs/runner";
import { runMaintenanceScheduler } from "./jobs/maintenance";
import { DatabaseMigrationLayer, runMigrations } from "./db/migrate";
import { PublicSourceIngestionRepositoryPgLayer } from "./source-ingestion/pg-repository";
import { runPublicSourcePolling, runPublicSourceStartupBackfill } from "./source-ingestion/watcher";
import { PlatformFileStoreLive } from "./platform/file-store";
import { PdfTextExtractorLive } from "./platform/pdf-text";
import { ExportObjectStoreServiceLive, NotificationEmailServiceLive } from "./platform/adapters";
import { initializeWorkerTelemetry } from "./telemetry";
import { createAiChatSmithersStorage } from "./ai/smithers-interop";
import { aiChatSchemas } from "./ai/workflow/ai-chat";

const program = Effect.gen(function* () {
  const config = yield* loadWorkerConfig;
  initializeWorkerTelemetry(config.sentryDsn, config.nodeEnv);
  // Local-only diagnostic channel: emits the full cause (name+message+stack+code)
  // of any error before the runtime/provenance boundary normalizes it. The
  // boundary itself is unchanged; this only enriches the local dev console log
  // so failures can be traced from a log dump. Dev-only by design.
  if (config.nodeEnv === "development") {
    setRuntimeCauseSink((record) => {
      void Effect.runPromise(
        Effect.logError("runtime cause").pipe(
          Effect.annotateLogs({ component: "diagnostic", ...record }),
          Effect.provide(JsonLoggerLayer),
          Effect.annotateLogs(serviceLogFields),
        ),
      ).catch(() => undefined);
    });
  }
  yield* Effect.try({
    try: () => assertWorkerAiProviderPosture(config),
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  });
  const aiConfigured =
    config.zaiApiKey.trim().length > 0 || (config.nodeEnv === "test" && config.aiE2eFakeProvider);

  yield* Effect.logInfo("starting worker").pipe(
    Effect.annotateLogs({
      ...serviceLogFields,
      jobPollIntervalMs: config.jobPollIntervalMs,
      workerConcurrency: config.workerConcurrency,
      runMigrationsOnStartup: config.runMigrationsOnStartup,
      publicSourceIngestionEnabled: config.publicSourceIngestionEnabled,
      publicSourcePollIntervalMs: config.publicSourcePollIntervalMs,
      publicSourceStartupBackfillDays: config.publicSourceStartupBackfillDays,
      publicSourceOperationTimeoutMs: config.publicSourceOperationTimeoutMs,
      aiConfigured,
      aiBaseUrl: config.aiBaseUrl,
      aiMainModel: config.aiMainModel,
      aiFastModel: config.aiFastModel,
      nodeEnv: config.nodeEnv,
    }),
  );

  if (!aiConfigured) {
    return yield* Effect.fail(
      new Error("ZAI_API_KEY is required for the worker because AI chat always uses real AI"),
    );
  }

  if (config.runMigrationsOnStartup) {
    yield* runMigrations;
  }

  const publicSourceWatcherConfig = {
    enabled: config.publicSourceIngestionEnabled,
    pollIntervalMs: config.publicSourcePollIntervalMs,
    startupBackfillDays: config.publicSourceStartupBackfillDays,
    operationTimeoutMs: config.publicSourceOperationTimeoutMs,
  };

  yield* runPublicSourceStartupBackfill(publicSourceWatcherConfig);

  // Schema provisioning is the only startup operation that needs the shared
  // fence. Per-workflow producer operations acquire the same fence in their
  // handler, while cleanup and retention take its exclusive side.
  const smithersStorage = yield* Effect.tryPromise({
    try: () => createAiChatSmithersStorage(aiChatSchemas, config.databaseUrl),
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  });

  const workerLoops = Array.from({ length: Math.max(1, config.workerConcurrency) }, () =>
    runWorker(config.jobPollIntervalMs, { smithersStorage }),
  );

  yield* Effect.all(
    [...workerLoops, runPublicSourcePolling(publicSourceWatcherConfig), runMaintenanceScheduler],
    { concurrency: "unbounded" },
  ).pipe(Effect.ensuring(Effect.promise(() => smithersStorage.close())));
});

BunRuntime.runMain(
  program.pipe(
    Effect.provide(JobRepositoryPgLayer),
    Effect.provide(PublicSourceIngestionRepositoryPgLayer),
    Effect.provide(PlatformFileStoreLive),
    Effect.provide(PdfTextExtractorLive),
    Effect.provide(NotificationEmailServiceLive),
    Effect.provide(ExportObjectStoreServiceLive),
    Effect.provide(DatabaseMigrationLayer),
    Effect.provide(JsonLoggerLayer),
    Effect.annotateLogs(serviceLogFields),
  ),
);
