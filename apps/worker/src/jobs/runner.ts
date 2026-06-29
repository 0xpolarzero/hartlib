import { Duration, Effect, Schedule } from "effect";
import { JobRepository } from "./repository";
import { handleJob } from "./handlers";

export const runWorker = (pollIntervalMs: number) =>
  Effect.gen(function* () {
    const tick = Effect.gen(function* () {
      const job = yield* JobRepository.use((jobs) => jobs.claimNext);
      if (!job) {
        yield* Effect.logDebug("no job available");
        return;
      }

      const result = yield* handleJob(job).pipe(
        Effect.catch((error) =>
          JobRepository.use((jobs) => jobs.markFailed(job, error)).pipe(
            Effect.as({
              status: "failed",
              message: String(error),
            } as const),
          ),
        ),
      );

      if (result.status === "completed") {
        yield* JobRepository.use((jobs) => jobs.markCompleted(job));
      }
    });

    yield* tick.pipe(Effect.repeat(Schedule.spaced(Duration.millis(pollIntervalMs))));
  });
