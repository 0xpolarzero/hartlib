import { Config, Effect } from "effect"

export interface WorkerConfig {
  readonly pollIntervalMs: number
  readonly nodeEnv: string
}

export const loadWorkerConfig = Effect.gen(function*() {
  const pollIntervalMs = yield* Config.integer("WORKER_POLL_INTERVAL_MS").pipe(
    Config.withDefault(5000)
  )
  const nodeEnv = yield* Config.string("NODE_ENV").pipe(Config.withDefault("development"))

  return {
    pollIntervalMs,
    nodeEnv
  } satisfies WorkerConfig
})
