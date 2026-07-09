import { Config, Effect } from "effect";

export interface ApiConfig {
  readonly host: string;
  readonly port: number;
  readonly nodeEnv: string;
  readonly aiStreamPollMs: number;
  readonly aiStreamKeepAliveMs: number;
}

export const loadApiConfig = Effect.gen(function* () {
  const host = yield* Config.string("HOST").pipe(Config.withDefault("0.0.0.0"));
  const port = yield* Config.number("PORT").pipe(Config.withDefault(3000));
  const nodeEnv = yield* Config.string("NODE_ENV").pipe(Config.withDefault("development"));
  const aiStreamPollMs = yield* Config.number("AI_STREAM_POLL_MS").pipe(Config.withDefault(300));
  const aiStreamKeepAliveMs = yield* Config.number("AI_STREAM_KEEPALIVE_MS").pipe(
    Config.withDefault(15_000),
  );

  return {
    host,
    port,
    nodeEnv,
    aiStreamPollMs,
    aiStreamKeepAliveMs,
  } satisfies ApiConfig;
});
