import { Duration, Effect, Schedule } from "effect";
import { handleJob, type HandleJobOptions } from "./handlers";
import { JobRepository, type JobRepositoryShape } from "./repository";
import type { JobRecord } from "./types";

const aiRunIdFromPayload = (payload: unknown): string | null =>
  typeof payload === "object" &&
  payload !== null &&
  "aiRunId" in payload &&
  typeof (payload as { readonly aiRunId?: unknown }).aiRunId === "string"
    ? (payload as { readonly aiRunId: string }).aiRunId
    : null;

const runJobHeartbeat = (jobs: JobRepositoryShape, job: JobRecord) =>
  Effect.gen(function* () {
    while (true) {
      yield* Effect.sleep(Duration.millis(jobs.lockRenewalIntervalMs));
      yield* jobs.heartbeat(job);
    }
  });

const handleJobWithHeartbeat = (
  jobs: JobRepositoryShape,
  job: JobRecord,
  options?: HandleJobOptions,
) => Effect.raceFirst(handleJob(job, options), runJobHeartbeat(jobs, job));

export const makeWorkerTick = (options?: HandleJobOptions) =>
  Effect.gen(function* () {
    const jobs = yield* JobRepository;
    const job = yield* jobs.claimNext;
    if (!job) {
      yield* Effect.logDebug("no job available");
      return;
    }

    yield* Effect.logInfo("worker job claimed").pipe(
      Effect.annotateLogs({
        jobId: job.id,
        jobKind: job.kind,
        attempts: job.attempts,
        lockedBy: job.lockedBy,
        aiRunId: aiRunIdFromPayload(job.payload),
      }),
    );

    const result = yield* handleJobWithHeartbeat(jobs, job, options).pipe(
      Effect.catch((error) =>
        jobs.markFailed(job, error).pipe(
          Effect.as({
            status: "failed",
            message: String(error),
          } as const),
        ),
      ),
    );

    if (result.status === "completed") {
      yield* jobs.markCompleted(job);
    }
  });

export const runWorkerTick = makeWorkerTick();

export const makeWorkerSafeTick = (options?: HandleJobOptions) =>
  makeWorkerTick(options).pipe(
    Effect.catch((error) =>
      Effect.logError("worker job tick failed").pipe(
        Effect.annotateLogs({
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
    ),
  );

export const runWorkerSafeTick = makeWorkerSafeTick();

export const runWorker = (pollIntervalMs: number) =>
  Effect.gen(function* () {
    yield* runWorkerSafeTick.pipe(Effect.repeat(Schedule.spaced(Duration.millis(pollIntervalMs))));
  });
