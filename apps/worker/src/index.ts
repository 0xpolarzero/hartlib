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

  yield* Effect.logInfo("starting worker").pipe(
    Effect.annotateLogs({
      ...serviceLogFields,
      jobPollIntervalMs: config.jobPollIntervalMs,
      runMigrationsOnStartup: config.runMigrationsOnStartup,
      publicSourceIngestionEnabled: config.publicSourceIngestionEnabled,
      publicSourcePollIntervalMs: config.publicSourcePollIntervalMs,
      publicSourceStartupBackfillDays: config.publicSourceStartupBackfillDays,
      publicSourceOperationTimeoutMs: config.publicSourceOperationTimeoutMs,
      nodeEnv: config.nodeEnv,
    }),
  );

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

  yield* Effect.all(
    [runWorker(config.jobPollIntervalMs), runPublicSourcePolling(publicSourceWatcherConfig)],
    { concurrency: "unbounded" },
  );
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
