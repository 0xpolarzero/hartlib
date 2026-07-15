import { BunRuntime } from "@effect/platform-bun";
import { Effect } from "effect";
import { assertWorkerAiProviderPosture, loadWorkerConfig } from "./config";
import { JsonLoggerLayer, serviceLogFields } from "./logging";
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
import {
  createSmithersStorage,
  withAiChatSmithersProducerFenceEffect,
} from "./ai/smithers-interop";
import { aiChatSchemas } from "./ai/workflow/ai-chat";

const program = Effect.gen(function* () {
  const config = yield* loadWorkerConfig;
  initializeWorkerTelemetry(config.sentryDsn, config.nodeEnv);
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

  yield* withAiChatSmithersProducerFenceEffect(
    config.databaseUrl,
    Effect.gen(function* () {
      const smithersStorage = yield* Effect.tryPromise({
        try: () => createSmithersStorage(aiChatSchemas, { connectionString: config.databaseUrl }),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      });

      const workerLoops = Array.from({ length: Math.max(1, config.workerConcurrency) }, () =>
        runWorker(config.jobPollIntervalMs, { smithersStorage }),
      );

      yield* Effect.all(
        [
          ...workerLoops,
          runPublicSourcePolling(publicSourceWatcherConfig),
          runMaintenanceScheduler,
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.ensuring(Effect.promise(() => smithersStorage.close())));
    }),
  );
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
