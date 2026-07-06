import { Duration, Effect, Schedule } from "effect";
import { handleJob } from "./handlers";
import { JobRepository, type JobRepositoryShape } from "./repository";
import type { JobRecord } from "./types";

const runJobHeartbeat = (jobs: JobRepositoryShape, job: JobRecord) =>
  Effect.gen(function* () {
    while (true) {
      yield* Effect.sleep(Duration.millis(jobs.lockRenewalIntervalMs));
      yield* jobs.heartbeat(job);
    }
  });

const handleJobWithHeartbeat = (jobs: JobRepositoryShape, job: JobRecord) =>
  Effect.raceFirst(handleJob(job), runJobHeartbeat(jobs, job));

export const runWorkerTick = Effect.gen(function* () {
  const jobs = yield* JobRepository;
  const job = yield* jobs.claimNext;
  if (!job) {
    yield* Effect.logDebug("no job available");
    return;
  }

  const result = yield* handleJobWithHeartbeat(jobs, job).pipe(
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

export const runWorkerSafeTick = runWorkerTick.pipe(
  Effect.catch((error) =>
    Effect.logError("worker job tick failed").pipe(
      Effect.annotateLogs({
        error: error instanceof Error ? error.message : String(error),
      }),
    ),
  ),
);

export const runWorker = (pollIntervalMs: number) =>
  Effect.gen(function* () {
    yield* runWorkerSafeTick.pipe(Effect.repeat(Schedule.spaced(Duration.millis(pollIntervalMs))));
  });
