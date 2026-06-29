import { BunRuntime } from "@effect/platform-bun"
import { Effect } from "effect"
import { loadApiConfig } from "./config"
import { routeRequest } from "./http"
import { JsonLoggerLayer, serviceLogFields } from "./logging"
import { routes } from "./routes"

const program = Effect.gen(function*() {
  const config = yield* loadApiConfig

  yield* Effect.logInfo("starting api").pipe(
    Effect.annotateLogs({
      ...serviceLogFields,
      host: config.host,
      port: config.port,
      nodeEnv: config.nodeEnv
    })
  )

  Bun.serve({
    hostname: config.host,
    port: config.port,
    fetch: (request) =>
      Effect.runPromise(
        routeRequest(routes, request).pipe(
          Effect.provide(JsonLoggerLayer)
        )
      )
  })

  yield* Effect.never
})

BunRuntime.runMain(program.pipe(
  Effect.provide(JsonLoggerLayer),
  Effect.annotateLogs(serviceLogFields)
))
