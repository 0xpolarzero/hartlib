import { Config, Effect } from "effect";

export interface ApiConfig {
  readonly host: string;
  readonly port: number;
  readonly nodeEnv: string;
}

export const loadApiConfig = Effect.gen(function* () {
  const host = yield* Config.string("HOST").pipe(Config.withDefault("0.0.0.0"));
  const port = yield* Config.number("PORT").pipe(Config.withDefault(3000));
  const nodeEnv = yield* Config.string("NODE_ENV").pipe(Config.withDefault("development"));

  return {
    host,
    port,
    nodeEnv,
  } satisfies ApiConfig;
});
