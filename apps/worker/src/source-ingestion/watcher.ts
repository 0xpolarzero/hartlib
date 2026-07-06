import { publicSourceDefinitions } from "@brief/source-ingestion";
import { Duration, Effect, Schedule } from "effect";
import { JobRepository } from "../jobs/repository";
import type { PublicSourceIngestionMode } from "./types";

export interface PublicSourceWatcherConfig {
  readonly enabled: boolean;
  readonly pollIntervalMs: number;
  readonly startupBackfillDays: number;
}

const enqueuePublicSourceIngestionJobs = (
  mode: PublicSourceIngestionMode,
  options: { readonly since?: Date } = {},
) =>
  Effect.gen(function* () {
    const jobs = yield* JobRepository;
    const enqueued = yield* Effect.all(
      publicSourceDefinitions.map((source) =>
        jobs.enqueue({
          kind: "public_source_ingestion",
          payload: {
            sourceId: source.id,
            mode,
            ...(options.since ? { since: options.since.toISOString() } : {}),
          },
          uniqueKey: `public_source_ingestion:${source.id}:${mode}`,
          priority: mode === "backfill" ? 10 : 0,
          maxAttempts: 5,
        }),
      ),
      { concurrency: 2 },
    );
    return enqueued.length;
  });

const runPublicSourcePollTick: Effect.Effect<void, unknown, JobRepository> =
  enqueuePublicSourceIngestionJobs("poll").pipe(
    Effect.flatMap((enqueuedCount) =>
      Effect.logInfo("public source poll jobs enqueued").pipe(
        Effect.annotateLogs({
          sourceCount: enqueuedCount,
        }),
      ),
    ),
  );

export const runPublicSourceSafePollTick: Effect.Effect<void, never, JobRepository> =
  runPublicSourcePollTick.pipe(
    Effect.catch((error) =>
      Effect.logError("public source poll enqueue failed").pipe(
        Effect.annotateLogs({
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
    ),
  );

export const runPublicSourceStartupBackfill = (
  config: PublicSourceWatcherConfig,
): Effect.Effect<void, unknown, JobRepository> =>
  config.enabled
    ? Effect.gen(function* () {
        const since = new Date(Date.now() - config.startupBackfillDays * 24 * 60 * 60 * 1000);
        const enqueuedCount = yield* enqueuePublicSourceIngestionJobs("backfill", { since });
        yield* Effect.logInfo("public source startup backfill completed").pipe(
          Effect.annotateLogs({
            sourceCount: enqueuedCount,
            since: since.toISOString(),
          }),
        );
      })
    : Effect.logInfo("public source ingestion disabled");

export const runPublicSourcePolling = (
  config: PublicSourceWatcherConfig,
): Effect.Effect<void, unknown, JobRepository> =>
  config.enabled
    ? Effect.gen(function* () {
        yield* runPublicSourceSafePollTick.pipe(
          Effect.repeat(Schedule.spaced(Duration.millis(config.pollIntervalMs))),
        );
      })
    : Effect.void;

export const runPublicSourceWatcher = (
  config: PublicSourceWatcherConfig,
): Effect.Effect<void, unknown, JobRepository> =>
  Effect.gen(function* () {
    yield* runPublicSourceStartupBackfill(config);
    yield* runPublicSourcePolling(config);
  });
