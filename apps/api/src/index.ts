import { BunRuntime } from "@effect/platform-bun";
import { Effect } from "effect";
import { loadApiConfig } from "./config";
import { makeApiWebHandler } from "./http";
import { JsonLoggerLayer, serviceLogFields } from "./logging";
import { routes } from "./routes";
import { shouldDisableRequestIdleTimeout } from "./server-timeout";
import { initializeApiTelemetry } from "./telemetry";

const program = Effect.gen(function* () {
  const config = yield* loadApiConfig;
  initializeApiTelemetry(config.sentryDsn, config.nodeEnv);

  yield* Effect.logInfo("starting api").pipe(
    Effect.annotateLogs({
      ...serviceLogFields,
      host: config.host,
      port: config.port,
      nodeEnv: config.nodeEnv,
    }),
  );

  const api = makeApiWebHandler(routes);
  const server = yield* Effect.acquireRelease(
    Effect.sync(() =>
      Bun.serve({
        hostname: config.host,
        port: config.port,
        idleTimeout: 255,
        fetch: (request, server) => {
          if (shouldDisableRequestIdleTimeout(request)) server.timeout(request, 0);
          return api.handler(request);
        },
      }),
    ),
    (server) =>
      Effect.promise(async () => {
        server.stop(true);
        await api.dispose();
      }),
  );

  yield* Effect.logDebug("api listener ready").pipe(
    Effect.annotateLogs({
      hostname: server.hostname ?? config.host,
      port: server.port ?? config.port,
    }),
  );
  return yield* Effect.never;
});

BunRuntime.runMain(
  program.pipe(
    Effect.scoped,
    Effect.provide(JsonLoggerLayer),
    Effect.annotateLogs(serviceLogFields),
  ),
);
