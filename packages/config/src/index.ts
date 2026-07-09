import { Config, ConfigProvider, Effect, Schema } from "effect";

export const NodeEnv = Schema.Literals(["development", "test", "production"]);
export type NodeEnv = Schema.Schema.Type<typeof NodeEnv>;

const StringWithDefault = (value: string) =>
  Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(value)));

export const AppEnv = Schema.Struct({
  NODE_ENV: NodeEnv,
  APP_BASE_URL: Schema.URLFromString,
  DATABASE_URL: Schema.String.pipe(Schema.check(Schema.isNonEmpty())),
  CLERK_SECRET_KEY: Schema.optional(Schema.String),
  CLERK_PUBLISHABLE_KEY: Schema.optional(Schema.String),
  OPENROUTER_API_KEY: Schema.optional(Schema.String),
  STRIPE_SECRET_KEY: Schema.optional(Schema.String),
  STRIPE_WEBHOOK_SECRET: Schema.optional(Schema.String),
  RESEND_API_KEY: Schema.optional(Schema.String),
  RAILWAY_BUCKET_ENDPOINT: Schema.optional(Schema.String),
  RAILWAY_BUCKET_NAME: Schema.optional(Schema.String),
  RAILWAY_BUCKET_ACCESS_KEY_ID: Schema.optional(Schema.String),
  RAILWAY_BUCKET_SECRET_ACCESS_KEY: Schema.optional(Schema.String),
  ZAI_API_KEY: StringWithDefault(""),
  AI_BASE_URL: StringWithDefault("https://api.z.ai/api/coding/paas/v4"),
  AI_MAIN_MODEL: StringWithDefault("glm-5.2"),
  AI_FAST_MODEL: StringWithDefault("glm-5-turbo"),
  AI_FAKE: StringWithDefault("false"),
  AI_CONTEXT_BLOCK_BUDGET: StringWithDefault("60000"),
  AI_CONTEXT_BLOCK_HARD_CAP: StringWithDefault("100000"),
  AI_FULL_DOC_MAX_CHARS: StringWithDefault("12000"),
  AI_HISTORY_MAX_MESSAGES: StringWithDefault("30"),
  AI_PREFLIGHT_HISTORY_MESSAGES: StringWithDefault("6"),
  AI_PREFLIGHT_MAX_TURNS: StringWithDefault("4"),
  AI_PREFLIGHT_MAX_SEARCHES: StringWithDefault("8"),
  AI_PREFLIGHT_MAX_PEEKS: StringWithDefault("4"),
  AI_PREFLIGHT_TIMEOUT_MS: StringWithDefault("30000"),
  AI_ANSWER_TIMEOUT_MS: StringWithDefault("120000"),
  AI_SEARCH_MAX_LIMIT: StringWithDefault("20"),
  AI_SEARCH_RECENCY_HALF_LIFE_DAYS: StringWithDefault("14"),
  AI_STREAM_POLL_MS: StringWithDefault("300"),
  AI_STREAM_KEEPALIVE_MS: StringWithDefault("15000"),
  AI_MEMORY_MAX_WRITES_PER_TURN: StringWithDefault("5"),
  AI_MEMORY_INJECT_ALL_MAX_TOKENS: StringWithDefault("1500"),
  AI_PLANNER_BASELINE: StringWithDefault("false"),
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
