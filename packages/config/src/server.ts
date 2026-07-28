import { Config, Effect, Redacted, Schema } from "effect";

export const LOCAL_DATABASE_URL = "postgres://brief:brief@localhost:5432/brief";
export const LOCAL_E2E_DATABASE_URL = "postgres://brief:brief@localhost:5432/brief_e2e";
export const LOCAL_APP_BASE_URL = "http://localhost:5173";
export const LOCAL_CORS_ALLOWED_ORIGINS = [
  LOCAL_APP_BASE_URL,
  LOCAL_APP_BASE_URL.replace("localhost", "127.0.0.1"),
] as const;
export const ZAI_CODING_PLAN_BASE_URL = "https://api.z.ai/api/coding/paas/v4";
/** Exact model posture accepted by the live worker configuration. */
export const LIVE_AI_MODEL_ID = "glm-5-turbo" as const;
export const PRODUCTION_DECISIONS_BLOCKER =
  "production startup is blocked because required production decisions remain unresolved; complete docs/production-readiness.spec.md before enabling production";
export const AI_WEB_MAX_DOMAIN_FILTERS_DEFAULT = 8;
export const AI_WEB_MAX_DOMAIN_FILTERS_HARD_MAX = 32;
export const WORKER_JOB_LOCK_TIMEOUT_MS_DEFAULT = 15 * 60 * 1_000;
export const SERVER_NUMERIC_SETTING_HARD_MAXIMA = {
  PORT: 65_535,
  WORKER_JOB_LOCK_TIMEOUT_MS: 3_600_000,
  EXPORT_DOWNLOAD_TTL_MS: 31 * 86_400_000,
  PUBLIC_SOURCE_AUDIT_FETCH_TIMEOUT_MS: 600_000,
} as const;
export const WORKER_NUMERIC_SETTING_HARD_MAXIMA = {
  WORKER_POLL_INTERVAL_MS: 3_600_000,
  WORKER_CONCURRENCY: 64,
  PUBLIC_SOURCE_POLL_INTERVAL_MS: 86_400_000,
  PUBLIC_SOURCE_STARTUP_BACKFILL_DAYS: 3_650,
  PUBLIC_SOURCE_OPERATION_TIMEOUT_MS: 600_000,
  AI_MAIN_INPUT_MAX_TOKENS: 1_000_000,
  AI_MAIN_OUTPUT_MAX_TOKENS: 131_072,
  AI_FAST_INPUT_MAX_TOKENS: 200_000,
  AI_FAST_OUTPUT_MAX_TOKENS: 131_072,
  AI_CONVERSATION_RECENT_TURNS: 200,
  AI_TOPIC_RESEARCH_MAX_CONCURRENCY: 32,
  AI_TOPIC_ANSWER_MAX_CONCURRENCY: 32,
  AI_RETRIEVAL_MAX_TURNS: 16,
  AI_INTERNAL_MAX_SEARCHES: 64,
  AI_INTERNAL_MAX_INSPECTIONS: 64,
  AI_WEB_MAX_SEARCHES: 32,
  AI_WEB_MAX_FETCHES: 64,
  AI_MEMORY_DIRECT_MAX_ITEMS: 10_000,
  AI_MEMORY_TOOL_RESULT_MAX_ITEMS: 500,
  AI_FAST_TASK_TIMEOUT_MS: 1_200_000,
  AI_ANSWER_TIMEOUT_MS: 900_000,
  AI_STREAM_POLL_MS: 10_000,
  AI_STREAM_KEEPALIVE_MS: 300_000,
} as const;

export const NodeEnv = Schema.Literals(["development", "test", "production"]);
export type NodeEnv = Schema.Schema.Type<typeof NodeEnv>;

const StringWithDefault = (value: string) =>
  Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(value)));
const LiveAiModelWithDefault = Schema.Literal(LIVE_AI_MODEL_ID).pipe(
  Schema.withDecodingDefaultKey(Effect.succeed(LIVE_AI_MODEL_ID)),
);
const NumberWithDefault = (value: number) =>
  Schema.Number.pipe(Schema.withDecodingDefaultKey(Effect.succeed(value)));
const BooleanWithDefault = (value: boolean) =>
  Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(value)));

const boundedPositiveInteger = (
  name: string,
  value: number,
  maximum: number,
): Effect.Effect<number, Error> => {
  if (!Number.isFinite(value) || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    return Effect.fail(new Error(`${name} must be an integer between 1 and ${maximum}`));
  }
  return Effect.succeed(value);
};

const nodeEnvField = NodeEnv.pipe(
  Schema.withDecodingDefaultKey(Effect.succeed("development" as const)),
);
const databaseFields = { DATABASE_URL: StringWithDefault("") } as const;
const publisherObjectStorageFields = {
  RAILWAY_BUCKET_ENDPOINT: StringWithDefault(""),
  RAILWAY_BUCKET_NAME: StringWithDefault(""),
  RAILWAY_BUCKET_ACCESS_KEY_ID: StringWithDefault(""),
  RAILWAY_BUCKET_SECRET_ACCESS_KEY: StringWithDefault(""),
} as const;
const exportObjectStorageFields = {
  EXPORT_BUCKET_ENDPOINT: StringWithDefault(""),
  EXPORT_BUCKET_NAME: StringWithDefault(""),
  EXPORT_BUCKET_ACCESS_KEY_ID: StringWithDefault(""),
  EXPORT_BUCKET_SECRET_ACCESS_KEY: StringWithDefault(""),
} as const;

const commaSeparatedUniqueValues = (value: string): readonly string[] => [
  ...new Set(
    value
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  ),
];

const parseExactHttpsUrl = (name: string, value: string): Effect.Effect<URL, Error> =>
  Effect.gen(function* () {
    const url = yield* Effect.try({
      try: () => new URL(value),
      catch: () => new Error(`${name} must be an exact HTTPS URL`),
    });
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.hash !== "" ||
      url.toString() !== value
    ) {
      return yield* Effect.fail(new Error(`${name} must be an exact HTTPS URL`));
    }
    return url;
  });

const parseCredentialFreeHttpsBaseUrl = (
  name: string,
  value: string,
): Effect.Effect<string, Error> =>
  Effect.gen(function* () {
    const url = yield* Effect.try({
      try: () => new URL(value),
      catch: () => new Error(`${name} must be an HTTPS URL without credentials or query data`),
    });
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      return yield* Effect.fail(
        new Error(`${name} must be an HTTPS URL without credentials or query data`),
      );
    }
    return url.href.replace(/\/$/u, "");
  });

const parseObjectStorageEndpoint = (
  name: string,
  value: string,
  nodeEnv: NodeEnv,
): Effect.Effect<string, Error> =>
  Effect.gen(function* () {
    if (value.trim() === "") return "";
    const url = yield* Effect.try({
      try: () => new URL(value),
      catch: () => new Error(`${name} must be an exact object-storage origin`),
    });
    const developmentLoopback =
      nodeEnv !== "production" &&
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
    if (
      (url.protocol !== "https:" && !developmentLoopback) ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== "" ||
      url.origin !== value.replace(/\/$/u, "")
    ) {
      return yield* Effect.fail(
        new Error(
          nodeEnv === "production"
            ? `${name} must be an exact credential-free HTTPS origin in production`
            : `${name} must be an exact credential-free HTTPS origin or a loopback HTTP origin`,
        ),
      );
    }
    return url.origin;
  });

const exactStorageCompleteness = (
  name: string,
  values: readonly string[],
): Effect.Effect<boolean, Error> => {
  const populated = values.map((value) => value.trim() !== "");
  if (populated.some(Boolean) && !populated.every(Boolean)) {
    return Effect.fail(
      new Error(`${name} must be either completely configured or completely empty`),
    );
  }
  return Effect.succeed(populated.every(Boolean));
};

const assertDedicatedExportBucket = (input: {
  readonly publisherConfigured: boolean;
  readonly publisherEndpoint: string;
  readonly publisherBucket: string;
  readonly exportConfigured: boolean;
  readonly exportEndpoint: string;
  readonly exportBucket: string;
}): Effect.Effect<void, Error> =>
  input.publisherConfigured &&
  input.exportConfigured &&
  input.publisherEndpoint === input.exportEndpoint &&
  input.publisherBucket === input.exportBucket
    ? Effect.fail(
        new Error("EXPORT_BUCKET_ENDPOINT and EXPORT_BUCKET_NAME must identify a dedicated bucket"),
      )
    : Effect.void;

const ApiEnvironment = Schema.Struct({
  HOST: StringWithDefault("0.0.0.0"),
  PORT: NumberWithDefault(3000),
  NODE_ENV: nodeEnvField,
  AI_STREAM_POLL_MS: NumberWithDefault(300),
  AI_STREAM_KEEPALIVE_MS: NumberWithDefault(15_000),
  TINYFISH_API_KEY: StringWithDefault(""),
  AI_E2E_FAKE_PROVIDER: BooleanWithDefault(false),
  AI_BASE_URL: StringWithDefault(ZAI_CODING_PLAN_BASE_URL),
  AI_WEB_MAX_DOMAIN_FILTERS: NumberWithDefault(AI_WEB_MAX_DOMAIN_FILTERS_DEFAULT),
  AUTH_MODE: Schema.optional(Schema.String),
  DEMO_PASSWORD: StringWithDefault("demo"),
  DEMO_SESSION_SECRET: StringWithDefault("insecure-dev-demo-session-secret"),
  CLERK_SECRET_KEY: StringWithDefault(""),
  CLERK_PUBLISHABLE_KEY: StringWithDefault(""),
  CLERK_AUTHORIZED_PARTIES: StringWithDefault(""),
  CLERK_WEBHOOK_SIGNING_SECRET: StringWithDefault(""),
  CLERK_INVITATION_REDIRECT_URL: StringWithDefault(""),
  STRIPE_SECRET_KEY: StringWithDefault(""),
  STRIPE_WEBHOOK_SECRET: StringWithDefault(""),
  STRIPE_PRICE_LIGHT: StringWithDefault(""),
  STRIPE_PRICE_TEAM: StringWithDefault(""),
  STRIPE_PRICE_INTENSIVE: StringWithDefault(""),
  STRIPE_PRICE_ADDITIONAL_CREDIT: StringWithDefault(""),
  STRIPE_CHECKOUT_SUCCESS_URL: StringWithDefault(""),
  STRIPE_CHECKOUT_CANCEL_URL: StringWithDefault(""),
  STRIPE_PORTAL_RETURN_URL: StringWithDefault(""),
  CORS_ALLOWED_ORIGINS: Schema.optional(Schema.String),
  ...publisherObjectStorageFields,
  ...exportObjectStorageFields,
  ...databaseFields,
  SENTRY_DSN: StringWithDefault(""),
});

export interface ApiConfig {
  readonly host: string;
  readonly port: number;
  readonly nodeEnv: NodeEnv;
  readonly aiStreamPollMs: number;
  readonly aiStreamKeepAliveMs: number;
  readonly webResearchProvider: "tinyfish" | null;
  readonly aiWebMaxDomainFilters: number;
  readonly aiProviderServiceId:
    | "zai_coding_plan_official"
    | "deterministic_test"
    | "openai_compatible_custom";
  readonly aiProviderEndpointIdentity: string;
  readonly authMode: "demo" | "clerk";
  readonly demoPassword: string;
  readonly demoSessionSecret: string;
  readonly clerkSecretKey: string;
  readonly clerkPublishableKey: string;
  readonly clerkAuthorizedParties: readonly string[];
  readonly clerkWebhookSigningSecret: string;
  readonly clerkInvitationRedirectUrl: string;
  readonly stripeSecretKey: string;
  readonly stripeWebhookSecret: string;
  readonly stripePriceLight: string;
  readonly stripePriceTeam: string;
  readonly stripePriceIntensive: string;
  readonly stripePriceAdditionalCredit: string;
  readonly stripeCheckoutSuccessUrl: string;
  readonly stripeCheckoutCancelUrl: string;
  readonly stripePortalReturnUrl: string;
  readonly corsAllowedOrigins: readonly string[];
  readonly objectStorageConfigured: boolean;
  readonly exportObjectStorageConfigured: boolean;
  readonly sentryDsn: string;
}

export const loadApiConfig: Effect.Effect<ApiConfig, Config.ConfigError | Error> = Effect.gen(
  function* () {
    const raw = yield* Config.schema(ApiEnvironment);
    if (raw.NODE_ENV === "production") {
      return yield* Effect.fail(new Error(PRODUCTION_DECISIONS_BLOCKER));
    }
    yield* boundedPositiveInteger("PORT", raw.PORT, SERVER_NUMERIC_SETTING_HARD_MAXIMA.PORT);
    yield* boundedPositiveInteger(
      "AI_STREAM_POLL_MS",
      raw.AI_STREAM_POLL_MS,
      WORKER_NUMERIC_SETTING_HARD_MAXIMA.AI_STREAM_POLL_MS,
    );
    yield* boundedPositiveInteger(
      "AI_STREAM_KEEPALIVE_MS",
      raw.AI_STREAM_KEEPALIVE_MS,
      WORKER_NUMERIC_SETTING_HARD_MAXIMA.AI_STREAM_KEEPALIVE_MS,
    );
    const aiBaseUrl = yield* parseCredentialFreeHttpsBaseUrl(
      "AI_BASE_URL",
      raw.AI_BASE_URL.trim() === "" ? ZAI_CODING_PLAN_BASE_URL : raw.AI_BASE_URL.trim(),
    );
    const publisherObjectStorageEndpoint = yield* parseObjectStorageEndpoint(
      "RAILWAY_BUCKET_ENDPOINT",
      raw.RAILWAY_BUCKET_ENDPOINT,
      raw.NODE_ENV,
    );
    const exportObjectStorageEndpoint = yield* parseObjectStorageEndpoint(
      "EXPORT_BUCKET_ENDPOINT",
      raw.EXPORT_BUCKET_ENDPOINT,
      raw.NODE_ENV,
    );
    if (
      !Number.isSafeInteger(raw.AI_WEB_MAX_DOMAIN_FILTERS) ||
      raw.AI_WEB_MAX_DOMAIN_FILTERS < 1 ||
      raw.AI_WEB_MAX_DOMAIN_FILTERS > AI_WEB_MAX_DOMAIN_FILTERS_HARD_MAX
    ) {
      return yield* Effect.fail(
        new Error(
          `AI_WEB_MAX_DOMAIN_FILTERS must be an integer between 1 and ${AI_WEB_MAX_DOMAIN_FILTERS_HARD_MAX}`,
        ),
      );
    }

    const authMode = raw.AUTH_MODE ?? "demo";
    if (authMode !== "demo" && authMode !== "clerk") {
      return yield* Effect.fail(new Error("invalid AUTH_MODE"));
    }
    if (
      authMode === "demo" &&
      (raw.DEMO_PASSWORD.trim() === "" || raw.DEMO_SESSION_SECRET.trim() === "")
    ) {
      return yield* Effect.fail(
        new Error("DEMO_PASSWORD and DEMO_SESSION_SECRET are required for demo auth"),
      );
    }
    if (
      authMode === "clerk" &&
      (raw.CLERK_SECRET_KEY.trim() === "" || raw.CLERK_PUBLISHABLE_KEY.trim() === "")
    ) {
      return yield* Effect.fail(
        new Error("CLERK_SECRET_KEY and CLERK_PUBLISHABLE_KEY are required for Clerk auth"),
      );
    }
    const clerkAuthorizedParties = commaSeparatedUniqueValues(raw.CLERK_AUTHORIZED_PARTIES);
    for (const [name, value] of [
      ["STRIPE_CHECKOUT_SUCCESS_URL", raw.STRIPE_CHECKOUT_SUCCESS_URL],
      ["STRIPE_CHECKOUT_CANCEL_URL", raw.STRIPE_CHECKOUT_CANCEL_URL],
      ["STRIPE_PORTAL_RETURN_URL", raw.STRIPE_PORTAL_RETURN_URL],
    ] as const) {
      if (value !== "") {
        yield* parseExactHttpsUrl(name, value);
      }
    }

    const corsAllowedOrigins = commaSeparatedUniqueValues(
      raw.CORS_ALLOWED_ORIGINS ?? LOCAL_CORS_ALLOWED_ORIGINS.join(","),
    );
    if (corsAllowedOrigins.length === 0 || corsAllowedOrigins.includes("*")) {
      return yield* Effect.fail(
        new Error("CORS_ALLOWED_ORIGINS must contain one or more explicit web origins"),
      );
    }
    for (const origin of corsAllowedOrigins) {
      const parsed = yield* Effect.try({
        try: () => new URL(origin),
        catch: () => new Error("CORS_ALLOWED_ORIGINS contains an invalid origin"),
      });
      if (
        parsed.origin !== origin ||
        (parsed.protocol !== "https:" && parsed.protocol !== "http:")
      ) {
        return yield* Effect.fail(new Error("CORS_ALLOWED_ORIGINS must contain exact web origins"));
      }
    }
    if (raw.CLERK_INVITATION_REDIRECT_URL !== "") {
      yield* parseExactHttpsUrl("CLERK_INVITATION_REDIRECT_URL", raw.CLERK_INVITATION_REDIRECT_URL);
    }

    const objectStorageConfigured = [
      publisherObjectStorageEndpoint,
      raw.RAILWAY_BUCKET_NAME,
      raw.RAILWAY_BUCKET_ACCESS_KEY_ID,
      raw.RAILWAY_BUCKET_SECRET_ACCESS_KEY,
    ].every((value) => value.trim() !== "");
    const exportObjectStorageConfigured = yield* exactStorageCompleteness("EXPORT_BUCKET", [
      exportObjectStorageEndpoint,
      raw.EXPORT_BUCKET_NAME,
      raw.EXPORT_BUCKET_ACCESS_KEY_ID,
      raw.EXPORT_BUCKET_SECRET_ACCESS_KEY,
    ]);
    yield* assertDedicatedExportBucket({
      publisherConfigured: objectStorageConfigured,
      publisherEndpoint: publisherObjectStorageEndpoint,
      publisherBucket: raw.RAILWAY_BUCKET_NAME,
      exportConfigured: exportObjectStorageConfigured,
      exportEndpoint: exportObjectStorageEndpoint,
      exportBucket: raw.EXPORT_BUCKET_NAME,
    });
    if (raw.SENTRY_DSN !== "") {
      yield* Effect.try({
        try: () => new URL(raw.SENTRY_DSN),
        catch: () => new Error("SENTRY_DSN is invalid"),
      });
    }

    const aiProviderServiceId = raw.AI_E2E_FAKE_PROVIDER
      ? "deterministic_test"
      : aiBaseUrl === ZAI_CODING_PLAN_BASE_URL
        ? "zai_coding_plan_official"
        : "openai_compatible_custom";
    return {
      host: raw.HOST,
      port: raw.PORT,
      nodeEnv: raw.NODE_ENV,
      aiStreamPollMs: raw.AI_STREAM_POLL_MS,
      aiStreamKeepAliveMs: raw.AI_STREAM_KEEPALIVE_MS,
      webResearchProvider: raw.TINYFISH_API_KEY.trim() === "" ? null : "tinyfish",
      aiWebMaxDomainFilters: raw.AI_WEB_MAX_DOMAIN_FILTERS,
      aiProviderServiceId,
      aiProviderEndpointIdentity: `${aiProviderServiceId}:${aiBaseUrl}`,
      authMode,
      demoPassword: raw.DEMO_PASSWORD,
      demoSessionSecret: raw.DEMO_SESSION_SECRET,
      clerkSecretKey: raw.CLERK_SECRET_KEY,
      clerkPublishableKey: raw.CLERK_PUBLISHABLE_KEY,
      clerkAuthorizedParties,
      clerkWebhookSigningSecret: raw.CLERK_WEBHOOK_SIGNING_SECRET,
      clerkInvitationRedirectUrl: raw.CLERK_INVITATION_REDIRECT_URL,
      stripeSecretKey: raw.STRIPE_SECRET_KEY,
      stripeWebhookSecret: raw.STRIPE_WEBHOOK_SECRET,
      stripePriceLight: raw.STRIPE_PRICE_LIGHT,
      stripePriceTeam: raw.STRIPE_PRICE_TEAM,
      stripePriceIntensive: raw.STRIPE_PRICE_INTENSIVE,
      stripePriceAdditionalCredit: raw.STRIPE_PRICE_ADDITIONAL_CREDIT,
      stripeCheckoutSuccessUrl: raw.STRIPE_CHECKOUT_SUCCESS_URL,
      stripeCheckoutCancelUrl: raw.STRIPE_CHECKOUT_CANCEL_URL,
      stripePortalReturnUrl: raw.STRIPE_PORTAL_RETURN_URL,
      corsAllowedOrigins,
      objectStorageConfigured,
      exportObjectStorageConfigured,
      sentryDsn: raw.SENTRY_DSN,
    } satisfies ApiConfig;
  },
);

const WorkerEnvironment = Schema.Struct({
  WORKER_POLL_INTERVAL_MS: NumberWithDefault(5_000),
  WORKER_CONCURRENCY: NumberWithDefault(2),
  WORKER_RUN_MIGRATIONS_ON_STARTUP: Schema.optional(Schema.Boolean),
  PUBLIC_SOURCE_INGESTION_ENABLED: BooleanWithDefault(true),
  PUBLIC_SOURCE_POLL_INTERVAL_MS: NumberWithDefault(300_000),
  PUBLIC_SOURCE_STARTUP_BACKFILL_DAYS: NumberWithDefault(7),
  PUBLIC_SOURCE_OPERATION_TIMEOUT_MS: NumberWithDefault(60_000),
  ZAI_API_KEY: StringWithDefault(""),
  AI_E2E_FAKE_PROVIDER: BooleanWithDefault(false),
  AI_BASE_URL: StringWithDefault(ZAI_CODING_PLAN_BASE_URL),
  AI_MAIN_MODEL: LiveAiModelWithDefault,
  AI_FAST_MODEL: LiveAiModelWithDefault,
  TINYFISH_API_KEY: StringWithDefault(""),
  ...publisherObjectStorageFields,
  ...exportObjectStorageFields,
  ...databaseFields,
  RESEND_API_KEY: StringWithDefault(""),
  RESEND_FROM_EMAIL: StringWithDefault(""),
  APP_BASE_URL: StringWithDefault(""),
  SENTRY_DSN: StringWithDefault(""),
  AI_MAIN_INPUT_MAX_TOKENS: NumberWithDefault(100_000),
  AI_MAIN_OUTPUT_MAX_TOKENS: NumberWithDefault(16_384),
  AI_FAST_INPUT_MAX_TOKENS: NumberWithDefault(100_000),
  AI_FAST_OUTPUT_MAX_TOKENS: NumberWithDefault(16_384),
  AI_CONVERSATION_RECENT_TURNS: NumberWithDefault(12),
  AI_FANOUT_MAX_TOPICS: Schema.optional(Schema.Number),
  AI_TOPIC_RESEARCH_MAX_CONCURRENCY: NumberWithDefault(6),
  AI_TOPIC_ANSWER_MAX_CONCURRENCY: NumberWithDefault(3),
  AI_RETRIEVAL_MAX_TURNS: NumberWithDefault(8),
  AI_INTERNAL_MAX_SEARCHES: NumberWithDefault(8),
  AI_INTERNAL_MAX_INSPECTIONS: NumberWithDefault(8),
  AI_WEB_MAX_SEARCHES: NumberWithDefault(4),
  AI_WEB_MAX_FETCHES: NumberWithDefault(8),
  AI_WEB_MAX_DOMAIN_FILTERS: NumberWithDefault(AI_WEB_MAX_DOMAIN_FILTERS_DEFAULT),
  AI_CONTEXT_REDUCTION_MAX_ITERATIONS: Schema.optional(Schema.Number),
  AI_MEMORY_DIRECT_MAX_ITEMS: NumberWithDefault(200),
  AI_MEMORY_TOOL_RESULT_MAX_ITEMS: NumberWithDefault(50),
  AI_FAST_TASK_TIMEOUT_MS: NumberWithDefault(1_200_000),
  AI_ANSWER_TIMEOUT_MS: NumberWithDefault(120_000),
  AI_STREAM_POLL_MS: NumberWithDefault(300),
  AI_STREAM_KEEPALIVE_MS: NumberWithDefault(15_000),
  NODE_ENV: nodeEnvField,
});

export interface WorkerConfig {
  readonly jobPollIntervalMs: number;
  readonly workerConcurrency: number;
  readonly runMigrationsOnStartup: boolean;
  readonly publicSourceIngestionEnabled: boolean;
  readonly publicSourcePollIntervalMs: number;
  readonly publicSourceStartupBackfillDays: number;
  readonly publicSourceOperationTimeoutMs: number;
  readonly zaiApiKey: string;
  readonly aiE2eFakeProvider: boolean;
  readonly aiBaseUrl: string;
  readonly aiMainModel: typeof LIVE_AI_MODEL_ID;
  readonly aiFastModel: typeof LIVE_AI_MODEL_ID;
  readonly webResearchProvider: "tinyfish" | "";
  readonly tinyfishApiKey: string;
  readonly objectStorageEndpoint: string;
  readonly objectStorageBucket: string;
  readonly objectStorageAccessKeyId: string;
  readonly objectStorageSecretAccessKey: string;
  readonly exportObjectStorageEndpoint: string;
  readonly exportObjectStorageBucket: string;
  readonly exportObjectStorageAccessKeyId: string;
  readonly exportObjectStorageSecretAccessKey: string;
  readonly exportObjectStorageConfigured: boolean;
  readonly databaseUrl: string;
  readonly resendApiKey: string;
  readonly resendFromEmail: string;
  readonly appBaseUrl: string;
  readonly sentryDsn: string;
  readonly aiMainInputMaxTokens: number;
  readonly aiMainOutputMaxTokens: number;
  readonly aiFastInputMaxTokens: number;
  readonly aiFastOutputMaxTokens: number;
  readonly aiConversationRecentTurns: number;
  readonly aiFanoutMaxTopics: 3;
  readonly aiTopicResearchMaxConcurrency: number;
  readonly aiTopicAnswerMaxConcurrency: number;
  readonly aiRetrievalMaxTurns: number;
  readonly aiInternalMaxSearches: number;
  readonly aiInternalMaxInspections: number;
  readonly aiWebMaxSearches: number;
  readonly aiWebMaxFetches: number;
  readonly aiWebMaxDomainFilters: number;
  readonly aiContextReductionMaxIterations: 2;
  readonly aiMemoryDirectMaxItems: number;
  readonly aiMemoryToolResultMaxItems: number;
  readonly aiFastTaskTimeoutMs: number;
  readonly aiAnswerTimeoutMs: number;
  readonly aiStreamPollMs: number;
  readonly aiStreamKeepaliveMs: number;
  readonly nodeEnv: NodeEnv;
}

export const loadWorkerConfig: Effect.Effect<WorkerConfig, Config.ConfigError | Error> = Effect.gen(
  function* () {
    const raw = yield* Config.schema(WorkerEnvironment);
    const boundedIntegerSettings = [
      ["WORKER_POLL_INTERVAL_MS", raw.WORKER_POLL_INTERVAL_MS],
      ["WORKER_CONCURRENCY", raw.WORKER_CONCURRENCY],
      ["PUBLIC_SOURCE_POLL_INTERVAL_MS", raw.PUBLIC_SOURCE_POLL_INTERVAL_MS],
      ["PUBLIC_SOURCE_STARTUP_BACKFILL_DAYS", raw.PUBLIC_SOURCE_STARTUP_BACKFILL_DAYS],
      ["PUBLIC_SOURCE_OPERATION_TIMEOUT_MS", raw.PUBLIC_SOURCE_OPERATION_TIMEOUT_MS],
      ["AI_MAIN_INPUT_MAX_TOKENS", raw.AI_MAIN_INPUT_MAX_TOKENS],
      ["AI_MAIN_OUTPUT_MAX_TOKENS", raw.AI_MAIN_OUTPUT_MAX_TOKENS],
      ["AI_FAST_INPUT_MAX_TOKENS", raw.AI_FAST_INPUT_MAX_TOKENS],
      ["AI_FAST_OUTPUT_MAX_TOKENS", raw.AI_FAST_OUTPUT_MAX_TOKENS],
      ["AI_CONVERSATION_RECENT_TURNS", raw.AI_CONVERSATION_RECENT_TURNS],
      ["AI_TOPIC_RESEARCH_MAX_CONCURRENCY", raw.AI_TOPIC_RESEARCH_MAX_CONCURRENCY],
      ["AI_TOPIC_ANSWER_MAX_CONCURRENCY", raw.AI_TOPIC_ANSWER_MAX_CONCURRENCY],
      ["AI_RETRIEVAL_MAX_TURNS", raw.AI_RETRIEVAL_MAX_TURNS],
      ["AI_INTERNAL_MAX_SEARCHES", raw.AI_INTERNAL_MAX_SEARCHES],
      ["AI_INTERNAL_MAX_INSPECTIONS", raw.AI_INTERNAL_MAX_INSPECTIONS],
      ["AI_WEB_MAX_SEARCHES", raw.AI_WEB_MAX_SEARCHES],
      ["AI_WEB_MAX_FETCHES", raw.AI_WEB_MAX_FETCHES],
      ["AI_MEMORY_DIRECT_MAX_ITEMS", raw.AI_MEMORY_DIRECT_MAX_ITEMS],
      ["AI_MEMORY_TOOL_RESULT_MAX_ITEMS", raw.AI_MEMORY_TOOL_RESULT_MAX_ITEMS],
      ["AI_FAST_TASK_TIMEOUT_MS", raw.AI_FAST_TASK_TIMEOUT_MS],
      ["AI_ANSWER_TIMEOUT_MS", raw.AI_ANSWER_TIMEOUT_MS],
      ["AI_STREAM_POLL_MS", raw.AI_STREAM_POLL_MS],
      ["AI_STREAM_KEEPALIVE_MS", raw.AI_STREAM_KEEPALIVE_MS],
    ] as const;
    for (const [name, value] of boundedIntegerSettings) {
      const maximum = WORKER_NUMERIC_SETTING_HARD_MAXIMA[name];
      if (!Number.isFinite(value) || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
        return yield* Effect.fail(new Error(`${name} must be an integer between 1 and ${maximum}`));
      }
    }
    const objectStorageEndpoint = yield* parseObjectStorageEndpoint(
      "RAILWAY_BUCKET_ENDPOINT",
      raw.RAILWAY_BUCKET_ENDPOINT,
      raw.NODE_ENV,
    );
    const exportObjectStorageEndpoint = yield* parseObjectStorageEndpoint(
      "EXPORT_BUCKET_ENDPOINT",
      raw.EXPORT_BUCKET_ENDPOINT,
      raw.NODE_ENV,
    );
    const objectStorageConfigured = [
      objectStorageEndpoint,
      raw.RAILWAY_BUCKET_NAME,
      raw.RAILWAY_BUCKET_ACCESS_KEY_ID,
      raw.RAILWAY_BUCKET_SECRET_ACCESS_KEY,
    ].every((value) => value.trim() !== "");
    const exportObjectStorageConfigured = yield* exactStorageCompleteness("EXPORT_BUCKET", [
      exportObjectStorageEndpoint,
      raw.EXPORT_BUCKET_NAME,
      raw.EXPORT_BUCKET_ACCESS_KEY_ID,
      raw.EXPORT_BUCKET_SECRET_ACCESS_KEY,
    ]);
    yield* assertDedicatedExportBucket({
      publisherConfigured: objectStorageConfigured,
      publisherEndpoint: objectStorageEndpoint,
      publisherBucket: raw.RAILWAY_BUCKET_NAME,
      exportConfigured: exportObjectStorageConfigured,
      exportEndpoint: exportObjectStorageEndpoint,
      exportBucket: raw.EXPORT_BUCKET_NAME,
    });
    if (
      !Number.isSafeInteger(raw.AI_WEB_MAX_DOMAIN_FILTERS) ||
      raw.AI_WEB_MAX_DOMAIN_FILTERS < 1 ||
      raw.AI_WEB_MAX_DOMAIN_FILTERS > AI_WEB_MAX_DOMAIN_FILTERS_HARD_MAX
    ) {
      return yield* Effect.fail(
        new Error(
          `AI_WEB_MAX_DOMAIN_FILTERS must be an integer between 1 and ${AI_WEB_MAX_DOMAIN_FILTERS_HARD_MAX}`,
        ),
      );
    }
    if (raw.AI_FANOUT_MAX_TOPICS !== undefined && raw.AI_FANOUT_MAX_TOPICS !== 3) {
      return yield* Effect.fail(new Error("AI_FANOUT_MAX_TOPICS is fixed at 3"));
    }
    if (
      raw.AI_CONTEXT_REDUCTION_MAX_ITERATIONS !== undefined &&
      raw.AI_CONTEXT_REDUCTION_MAX_ITERATIONS !== 2
    ) {
      return yield* Effect.fail(new Error("AI_CONTEXT_REDUCTION_MAX_ITERATIONS is fixed at 2"));
    }
    const rawAiBaseUrl = raw.AI_BASE_URL.trim();
    const aiBaseUrl = yield* parseCredentialFreeHttpsBaseUrl(
      "AI_BASE_URL",
      rawAiBaseUrl === "" ? ZAI_CODING_PLAN_BASE_URL : rawAiBaseUrl,
    );
    return {
      jobPollIntervalMs: raw.WORKER_POLL_INTERVAL_MS,
      workerConcurrency: raw.WORKER_CONCURRENCY,
      runMigrationsOnStartup: raw.WORKER_RUN_MIGRATIONS_ON_STARTUP ?? raw.NODE_ENV !== "production",
      publicSourceIngestionEnabled: raw.PUBLIC_SOURCE_INGESTION_ENABLED,
      publicSourcePollIntervalMs: raw.PUBLIC_SOURCE_POLL_INTERVAL_MS,
      publicSourceStartupBackfillDays: raw.PUBLIC_SOURCE_STARTUP_BACKFILL_DAYS,
      publicSourceOperationTimeoutMs: raw.PUBLIC_SOURCE_OPERATION_TIMEOUT_MS,
      zaiApiKey: raw.ZAI_API_KEY,
      aiE2eFakeProvider: raw.AI_E2E_FAKE_PROVIDER,
      aiBaseUrl,
      aiMainModel: raw.AI_MAIN_MODEL,
      aiFastModel: raw.AI_FAST_MODEL,
      webResearchProvider:
        raw.NODE_ENV !== "production" && raw.TINYFISH_API_KEY.trim() !== "" ? "tinyfish" : "",
      tinyfishApiKey: raw.TINYFISH_API_KEY,
      objectStorageEndpoint,
      objectStorageBucket: raw.RAILWAY_BUCKET_NAME,
      objectStorageAccessKeyId: raw.RAILWAY_BUCKET_ACCESS_KEY_ID,
      objectStorageSecretAccessKey: raw.RAILWAY_BUCKET_SECRET_ACCESS_KEY,
      exportObjectStorageEndpoint,
      exportObjectStorageBucket: raw.EXPORT_BUCKET_NAME,
      exportObjectStorageAccessKeyId: raw.EXPORT_BUCKET_ACCESS_KEY_ID,
      exportObjectStorageSecretAccessKey: raw.EXPORT_BUCKET_SECRET_ACCESS_KEY,
      exportObjectStorageConfigured,
      databaseUrl: raw.DATABASE_URL.trim() === "" ? LOCAL_DATABASE_URL : raw.DATABASE_URL,
      resendApiKey: raw.RESEND_API_KEY,
      resendFromEmail: raw.RESEND_FROM_EMAIL,
      appBaseUrl: raw.APP_BASE_URL,
      sentryDsn: raw.SENTRY_DSN,
      aiMainInputMaxTokens: raw.AI_MAIN_INPUT_MAX_TOKENS,
      aiMainOutputMaxTokens: raw.AI_MAIN_OUTPUT_MAX_TOKENS,
      aiFastInputMaxTokens: raw.AI_FAST_INPUT_MAX_TOKENS,
      aiFastOutputMaxTokens: raw.AI_FAST_OUTPUT_MAX_TOKENS,
      aiConversationRecentTurns: raw.AI_CONVERSATION_RECENT_TURNS,
      aiFanoutMaxTopics: 3,
      aiTopicResearchMaxConcurrency: raw.AI_TOPIC_RESEARCH_MAX_CONCURRENCY,
      aiTopicAnswerMaxConcurrency: raw.AI_TOPIC_ANSWER_MAX_CONCURRENCY,
      aiRetrievalMaxTurns: raw.AI_RETRIEVAL_MAX_TURNS,
      aiInternalMaxSearches: raw.AI_INTERNAL_MAX_SEARCHES,
      aiInternalMaxInspections: raw.AI_INTERNAL_MAX_INSPECTIONS,
      aiWebMaxSearches: raw.AI_WEB_MAX_SEARCHES,
      aiWebMaxFetches: raw.AI_WEB_MAX_FETCHES,
      aiWebMaxDomainFilters: raw.AI_WEB_MAX_DOMAIN_FILTERS,
      aiContextReductionMaxIterations: 2,
      aiMemoryDirectMaxItems: raw.AI_MEMORY_DIRECT_MAX_ITEMS,
      aiMemoryToolResultMaxItems: raw.AI_MEMORY_TOOL_RESULT_MAX_ITEMS,
      aiFastTaskTimeoutMs: raw.AI_FAST_TASK_TIMEOUT_MS,
      aiAnswerTimeoutMs: raw.AI_ANSWER_TIMEOUT_MS,
      aiStreamPollMs: raw.AI_STREAM_POLL_MS,
      aiStreamKeepaliveMs: raw.AI_STREAM_KEEPALIVE_MS,
      nodeEnv: raw.NODE_ENV,
    } satisfies WorkerConfig;
  },
);

export const databaseUrlConfig = Config.string("DATABASE_URL").pipe(
  Config.withDefault(LOCAL_DATABASE_URL),
);
export const databaseUrlRedactedConfig = databaseUrlConfig.pipe(Config.map(Redacted.make));
export const loadDatabaseUrl = databaseUrlConfig;
export const loadE2eDatabaseUrl = Config.string("BRIEF_E2E_DATABASE_URL").pipe(
  Config.withDefault(LOCAL_E2E_DATABASE_URL),
);

const JobRepositoryEnvironment = Schema.Struct({
  WORKER_JOB_LOCK_TIMEOUT_MS: NumberWithDefault(WORKER_JOB_LOCK_TIMEOUT_MS_DEFAULT),
});
export const loadJobRepositoryConfig = Config.schema(JobRepositoryEnvironment).pipe(
  Effect.flatMap((raw) =>
    boundedPositiveInteger(
      "WORKER_JOB_LOCK_TIMEOUT_MS",
      raw.WORKER_JOB_LOCK_TIMEOUT_MS,
      SERVER_NUMERIC_SETTING_HARD_MAXIMA.WORKER_JOB_LOCK_TIMEOUT_MS,
    ).pipe(Effect.map((jobLockTimeoutMs) => ({ jobLockTimeoutMs }))),
  ),
);

const ObjectStorageEnvironment = Schema.Struct({
  ...publisherObjectStorageFields,
  NODE_ENV: nodeEnvField,
});
export interface ObjectStorageConfig {
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly configured: boolean;
}
export const loadObjectStorageConfig: Effect.Effect<
  ObjectStorageConfig,
  Config.ConfigError | Error
> = Config.schema(ObjectStorageEnvironment).pipe(
  Effect.flatMap((raw) =>
    Effect.gen(function* () {
      const endpoint = yield* parseObjectStorageEndpoint(
        "RAILWAY_BUCKET_ENDPOINT",
        raw.RAILWAY_BUCKET_ENDPOINT,
        raw.NODE_ENV,
      );
      const values = [
        endpoint,
        raw.RAILWAY_BUCKET_NAME,
        raw.RAILWAY_BUCKET_ACCESS_KEY_ID,
        raw.RAILWAY_BUCKET_SECRET_ACCESS_KEY,
      ];
      const configured = values.every((value) => value.trim() !== "");
      return {
        endpoint,
        bucket: raw.RAILWAY_BUCKET_NAME,
        accessKeyId: raw.RAILWAY_BUCKET_ACCESS_KEY_ID,
        secretAccessKey: raw.RAILWAY_BUCKET_SECRET_ACCESS_KEY,
        configured,
      };
    }),
  ),
);

const ExportObjectStorageEnvironment = Schema.Struct({
  ...publisherObjectStorageFields,
  ...exportObjectStorageFields,
  NODE_ENV: nodeEnvField,
});
export interface ExportObjectStorageConfig {
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly configured: boolean;
}
export const loadExportObjectStorageConfig: Effect.Effect<
  ExportObjectStorageConfig,
  Config.ConfigError | Error
> = Config.schema(ExportObjectStorageEnvironment).pipe(
  Effect.flatMap((raw) =>
    Effect.gen(function* () {
      const publisherEndpoint = yield* parseObjectStorageEndpoint(
        "RAILWAY_BUCKET_ENDPOINT",
        raw.RAILWAY_BUCKET_ENDPOINT,
        raw.NODE_ENV,
      );
      const endpoint = yield* parseObjectStorageEndpoint(
        "EXPORT_BUCKET_ENDPOINT",
        raw.EXPORT_BUCKET_ENDPOINT,
        raw.NODE_ENV,
      );
      const publisherConfigured = [
        publisherEndpoint,
        raw.RAILWAY_BUCKET_NAME,
        raw.RAILWAY_BUCKET_ACCESS_KEY_ID,
        raw.RAILWAY_BUCKET_SECRET_ACCESS_KEY,
      ].every((value) => value.trim() !== "");
      const configured = yield* exactStorageCompleteness("EXPORT_BUCKET", [
        endpoint,
        raw.EXPORT_BUCKET_NAME,
        raw.EXPORT_BUCKET_ACCESS_KEY_ID,
        raw.EXPORT_BUCKET_SECRET_ACCESS_KEY,
      ]);
      yield* assertDedicatedExportBucket({
        publisherConfigured,
        publisherEndpoint,
        publisherBucket: raw.RAILWAY_BUCKET_NAME,
        exportConfigured: configured,
        exportEndpoint: endpoint,
        exportBucket: raw.EXPORT_BUCKET_NAME,
      });
      return {
        endpoint,
        bucket: raw.EXPORT_BUCKET_NAME,
        accessKeyId: raw.EXPORT_BUCKET_ACCESS_KEY_ID,
        secretAccessKey: raw.EXPORT_BUCKET_SECRET_ACCESS_KEY,
        configured,
      };
    }),
  ),
);

const NotificationEnvironment = Schema.Struct({
  RESEND_API_KEY: StringWithDefault(""),
  RESEND_FROM_EMAIL: StringWithDefault(""),
});
export const loadNotificationConfig = Config.schema(NotificationEnvironment).pipe(
  Effect.map((raw) => ({ apiKey: raw.RESEND_API_KEY, from: raw.RESEND_FROM_EMAIL })),
);

const PlatformJobEnvironment = Schema.Struct({
  APP_BASE_URL: StringWithDefault(LOCAL_APP_BASE_URL),
  EXPORT_DOWNLOAD_TTL_MS: NumberWithDefault(24 * 60 * 60 * 1_000),
});
export const loadPlatformJobConfig = Config.schema(PlatformJobEnvironment).pipe(
  Effect.flatMap((raw) =>
    boundedPositiveInteger(
      "EXPORT_DOWNLOAD_TTL_MS",
      raw.EXPORT_DOWNLOAD_TTL_MS,
      SERVER_NUMERIC_SETTING_HARD_MAXIMA.EXPORT_DOWNLOAD_TTL_MS,
    ).pipe(
      Effect.map((exportDownloadTtlMs) => ({
        appBaseUrl: raw.APP_BASE_URL,
        exportDownloadTtlMs,
      })),
    ),
  ),
);

const PublicSourceAuditEnvironment = Schema.Struct({
  PUBLIC_SOURCE_STARTUP_BACKFILL_DAYS: NumberWithDefault(7),
  PUBLIC_SOURCE_AUDIT_FETCH_MISSING: BooleanWithDefault(false),
  PUBLIC_SOURCE_AUDIT_FETCH_TIMEOUT_MS: NumberWithDefault(15_000),
});
export const loadPublicSourceAuditConfig = Config.schema(PublicSourceAuditEnvironment).pipe(
  Effect.flatMap((raw) =>
    Effect.gen(function* () {
      const backfillDays = yield* boundedPositiveInteger(
        "PUBLIC_SOURCE_STARTUP_BACKFILL_DAYS",
        raw.PUBLIC_SOURCE_STARTUP_BACKFILL_DAYS,
        WORKER_NUMERIC_SETTING_HARD_MAXIMA.PUBLIC_SOURCE_STARTUP_BACKFILL_DAYS,
      );
      const fetchTimeoutMs = yield* boundedPositiveInteger(
        "PUBLIC_SOURCE_AUDIT_FETCH_TIMEOUT_MS",
        raw.PUBLIC_SOURCE_AUDIT_FETCH_TIMEOUT_MS,
        SERVER_NUMERIC_SETTING_HARD_MAXIMA.PUBLIC_SOURCE_AUDIT_FETCH_TIMEOUT_MS,
      );
      return {
        backfillDays,
        fetchMissing: raw.PUBLIC_SOURCE_AUDIT_FETCH_MISSING,
        fetchTimeoutMs,
      };
    }),
  ),
);

const DatabaseResetEnvironment = Schema.Struct({
  NODE_ENV: nodeEnvField,
  BRIEF_ALLOW_DB_RESET: BooleanWithDefault(false),
});
export const loadDatabaseResetConfig = Config.schema(DatabaseResetEnvironment).pipe(
  Effect.map((raw) => ({
    nodeEnv: raw.NODE_ENV,
    allowProductionReset: raw.BRIEF_ALLOW_DB_RESET,
  })),
);
