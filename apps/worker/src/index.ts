import { BunRuntime } from "@effect/platform-bun"
import { Effect } from "effect"
import { loadWorkerConfig } from "./config"
import { JsonLoggerLayer, serviceLogFields } from "./logging"
import { JobRepositoryLive } from "./jobs/repository"
import { runWorker } from "./jobs/runner"

const program = Effect.gen(function*() {
  const config = yield* loadWorkerConfig

  yield* Effect.logInfo("starting worker").pipe(
    Effect.annotateLogs({
      ...serviceLogFields,
      pollIntervalMs: config.pollIntervalMs,
      nodeEnv: config.nodeEnv
    })
  )

  yield* runWorker(config.pollIntervalMs)
})

BunRuntime.runMain(program.pipe(
  Effect.provide(JobRepositoryLive),
  Effect.provide(JsonLoggerLayer),
  Effect.annotateLogs(serviceLogFields)
))
