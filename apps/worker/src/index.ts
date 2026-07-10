import { BunRuntime } from "@effect/platform-bun";
import { Effect } from "effect";
import { loadWorkerConfig } from "./config";
import { JsonLoggerLayer, serviceLogFields } from "./logging";
import { JobRepositoryPgLayer } from "./jobs/repository";
import { runWorker } from "./jobs/runner";
import { DatabaseMigrationLayer, runMigrations } from "./db/migrate";
import { PublicSourceIngestionRepositoryPgLayer } from "./source-ingestion/pg-repository";
import { runPublicSourcePolling, runPublicSourceStartupBackfill } from "./source-ingestion/watcher";

const program = Effect.gen(function* () {
  const config = yield* loadWorkerConfig;
  const aiConfigured = config.zaiApiKey.trim().length > 0;

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

  const workerLoops = Array.from({ length: Math.max(1, config.workerConcurrency) }, () =>
    runWorker(config.jobPollIntervalMs),
  );

  yield* Effect.all([...workerLoops, runPublicSourcePolling(publicSourceWatcherConfig)], {
    concurrency: "unbounded",
  });
});

BunRuntime.runMain(
  program.pipe(
    Effect.provide(JobRepositoryPgLayer),
    Effect.provide(PublicSourceIngestionRepositoryPgLayer),
    Effect.provide(DatabaseMigrationLayer),
    Effect.provide(JsonLoggerLayer),
    Effect.annotateLogs(serviceLogFields),
  ),
);
