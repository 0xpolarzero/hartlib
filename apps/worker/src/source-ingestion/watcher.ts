import { publicSourceDefinitions } from "@brief/source-ingestion";
import { Duration, Effect, Schedule } from "effect";
import { JobRepository } from "../jobs/repository";
import type { PublicSourceIngestionMode } from "./types";

export interface PublicSourceWatcherConfig {
  readonly enabled: boolean;
  readonly pollIntervalMs: number;
  readonly startupBackfillDays: number;
  readonly operationTimeoutMs: number;
}

const enqueuePublicSourceIngestionJobs = (
  mode: PublicSourceIngestionMode,
  options: { readonly since?: Date; readonly operationTimeoutMs: number },
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
            operationTimeoutMs: options.operationTimeoutMs,
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

const recentWindowStart = (config: PublicSourceWatcherConfig): Date =>
  new Date(Date.now() - config.startupBackfillDays * 24 * 60 * 60 * 1000);

const runPublicSourcePollTick = (
  config: PublicSourceWatcherConfig,
): Effect.Effect<void, unknown, JobRepository> =>
  enqueuePublicSourceIngestionJobs("poll", {
    since: recentWindowStart(config),
    operationTimeoutMs: config.operationTimeoutMs,
  }).pipe(
    Effect.flatMap((enqueuedCount) =>
      Effect.logInfo("public source poll jobs enqueued").pipe(
        Effect.annotateLogs({
          sourceCount: enqueuedCount,
        }),
      ),
    ),
  );

export const runPublicSourceSafePollTick = (
  config: PublicSourceWatcherConfig,
): Effect.Effect<void, never, JobRepository> =>
  runPublicSourcePollTick(config).pipe(
    Effect.catch(() =>
      Effect.logError("public source poll enqueue failed").pipe(
        Effect.annotateLogs({
          errorCode: "public_source_poll_enqueue_failed",
        }),
      ),
    ),
  );

export const runPublicSourceStartupBackfill = (
  config: PublicSourceWatcherConfig,
): Effect.Effect<void, unknown, JobRepository> =>
  config.enabled
    ? Effect.gen(function* () {
        const since = recentWindowStart(config);
        const enqueuedCount = yield* enqueuePublicSourceIngestionJobs("backfill", {
          since,
          operationTimeoutMs: config.operationTimeoutMs,
        });
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
        yield* runPublicSourceSafePollTick(config).pipe(
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
