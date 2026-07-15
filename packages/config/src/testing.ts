import { ConfigProvider, Effect } from "effect";

import { loadApiConfig, loadWorkerConfig } from "./server";

export type EnvironmentSource = Readonly<Record<string, string | undefined>>;

export const withEnvironment = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  source: EnvironmentSource,
): Effect.Effect<A, E, R> =>
  Effect.provide(
    effect,
    ConfigProvider.layer(
      ConfigProvider.fromEnv({
        env: Object.fromEntries(
          Object.entries(source).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        ),
      }),
    ),
  );

export const loadApiConfigFrom = (source: EnvironmentSource) =>
  withEnvironment(loadApiConfig, source);

export const loadWorkerConfigFrom = (source: EnvironmentSource) =>
  withEnvironment(loadWorkerConfig, source);
