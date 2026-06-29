import { Duration, Effect, Schedule } from "effect"
import { JobRepository } from "./repository"
import { handleJob } from "./handlers"

export const runWorker = (pollIntervalMs: number) =>
  Effect.gen(function*() {
    const jobs = yield* JobRepository

    const tick = Effect.gen(function*() {
      const job = yield* jobs.claimNext
      if (!job) {
        yield* Effect.logDebug("no job available")
        return
      }

      const result = yield* handleJob(job).pipe(
        Effect.catchAll((error) =>
          jobs.markFailed(job, error).pipe(
            Effect.as({
              status: "failed",
              message: String(error)
            } as const)
          )
        )
      )

      if (result.status === "completed") {
        yield* jobs.markCompleted(job)
      }
    })

    yield* tick.pipe(
      Effect.repeat(Schedule.spaced(Duration.millis(pollIntervalMs)))
    )
  })
