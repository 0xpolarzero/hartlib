import { Duration, Effect, Schedule } from "effect";
import { captureCause } from "../diagnostic-cause";
import { handleJob, type HandleJobOptions } from "./handlers";
import { JobRepository, type JobRepositoryShape } from "./repository";
import type { JobRecord } from "./types";
import { captureWorkerOperationalError } from "../telemetry";

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
        Effect.sync(() => {
          captureCause("job_execution", error);
          return captureWorkerOperationalError("job_execution_failed", { jobKind: job.kind });
        }).pipe(
          Effect.andThen(jobs.markFailed(job, error)),
          Effect.as({
            status: "failed",
            message: "job_execution_failed",
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
      Effect.sync(() => {
        captureCause("worker_tick", error);
        return captureWorkerOperationalError("worker_tick_failed");
      }).pipe(
        Effect.andThen(Effect.logError("worker job tick failed")),
        Effect.annotateLogs({
          errorCode: "worker_tick_failed",
        }),
      ),
    ),
  );

export const runWorkerSafeTick = makeWorkerSafeTick();

export const runWorker = (pollIntervalMs: number, options?: HandleJobOptions) =>
  Effect.gen(function* () {
    yield* makeWorkerSafeTick(options).pipe(
      Effect.repeat(Schedule.spaced(Duration.millis(pollIntervalMs))),
    );
  });
