import { Config, ConfigProvider, Effect, Schema } from "effect";

export const NodeEnv = Schema.Literals(["development", "test", "production"]);
export type NodeEnv = Schema.Schema.Type<typeof NodeEnv>;

export const AppEnv = Schema.Struct({
  NODE_ENV: NodeEnv,
  APP_BASE_URL: Schema.URL,
  DATABASE_URL: Schema.String.pipe(Schema.check(Schema.isNonEmpty())),
  CLERK_SECRET_KEY: Schema.String.pipe(Schema.check(Schema.isNonEmpty())),
  CLERK_PUBLISHABLE_KEY: Schema.String.pipe(Schema.check(Schema.isNonEmpty())),
  OPENROUTER_API_KEY: Schema.String.pipe(Schema.check(Schema.isNonEmpty())),
  STRIPE_SECRET_KEY: Schema.String.pipe(Schema.check(Schema.isNonEmpty())),
  STRIPE_WEBHOOK_SECRET: Schema.String.pipe(Schema.check(Schema.isNonEmpty())),
  RESEND_API_KEY: Schema.String.pipe(Schema.check(Schema.isNonEmpty())),
  RAILWAY_BUCKET_ENDPOINT: Schema.String.pipe(Schema.check(Schema.isNonEmpty())),
  RAILWAY_BUCKET_NAME: Schema.String.pipe(Schema.check(Schema.isNonEmpty())),
  RAILWAY_BUCKET_ACCESS_KEY_ID: Schema.String.pipe(Schema.check(Schema.isNonEmpty())),
  RAILWAY_BUCKET_SECRET_ACCESS_KEY: Schema.String.pipe(Schema.check(Schema.isNonEmpty())),
  SENTRY_DSN: Schema.optional(Schema.String),
});

export type AppEnv = Schema.Schema.Type<typeof AppEnv>;

export const AppConfig = Config.schema(AppEnv);

export const decodeAppEnv = Schema.decodeUnknownEffect(AppEnv);

export const loadAppEnv = AppConfig;

export const loadAppEnvFrom = (
  source: Record<string, string | undefined>,
): Effect.Effect<AppEnv, Config.ConfigError> =>
  Effect.provide(
    AppConfig,
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
