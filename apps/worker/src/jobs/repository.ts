import { Context, Effect, Layer } from "effect"
import { jobSql } from "./sql"
import type { JobRecord } from "./types"

export class JobRepository extends Context.Service<JobRepository, {
  readonly claimNext: Effect.Effect<JobRecord | undefined>
  readonly markCompleted: (job: JobRecord) => Effect.Effect<void>
  readonly markFailed: (job: JobRecord, error: unknown) => Effect.Effect<void>
}>()("brief/worker/JobRepository") {
  static readonly layer = Layer.effect(
    JobRepository,
    Effect.gen(function*() {
      const claimNext: Effect.Effect<JobRecord | undefined> = Effect.gen(function*() {
        yield* Effect.logDebug("claiming next postgres job placeholder").pipe(
          Effect.annotateLogs({
            sqlName: "claimNext",
            sqlPrepared: jobSql.claimNext.length > 0
          })
        )
        return undefined
      })

      const markCompleted = (job: JobRecord) =>
        Effect.logInfo("job completed").pipe(
          Effect.annotateLogs({
            jobId: job.id,
            jobKind: job.kind
          })
        )

      const markFailed = (job: JobRecord, error: unknown) =>
        Effect.logError("job failed").pipe(
          Effect.annotateLogs({
            jobId: job.id,
            jobKind: job.kind,
            error: String(error)
          })
        )

      return {
        claimNext,
        markCompleted,
        markFailed
      }
    })
  )
}

export const JobRepositoryLive: Layer.Layer<JobRepository> = JobRepository.layer
