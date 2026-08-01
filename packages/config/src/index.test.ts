import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  AI_WEB_MAX_DOMAIN_FILTERS_DEFAULT,
  LOCAL_DATABASE_URL,
  PRODUCTION_DECISIONS_BLOCKER,
  RETRIEVAL_NUMERIC_SETTING_HARD_MAXIMA,
  SERVER_NUMERIC_SETTING_HARD_MAXIMA,
  WORKER_NUMERIC_SETTING_HARD_MAXIMA,
  ZAI_CODING_PLAN_BASE_URL,
  loadApiConfigFrom,
  loadDatabaseResetConfig,
  loadDatabaseUrl,
  loadDemoBrowserConfig,
  loadExportObjectStorageConfig,
  loadJobRepositoryConfig,
  loadObjectStorageConfig,
  loadPlatformJobConfig,
  loadPublicSourceAuditConfig,
  loadWebApiConfig,
  loadWebAuthConfig,
  loadWebObservabilityConfig,
  loadWorkerConfigFrom,
  withEnvironment,
} from "./index";

const boundedWorkerNumericSettings = [
  ["WORKER_POLL_INTERVAL_MS", 3_600_000],
  ["WORKER_CONCURRENCY", 64],
  ["PUBLIC_SOURCE_POLL_INTERVAL_MS", 86_400_000],
  ["PUBLIC_SOURCE_STARTUP_BACKFILL_DAYS", 3_650],
  ["PUBLIC_SOURCE_OPERATION_TIMEOUT_MS", 600_000],
  ["AI_MAIN_INPUT_MAX_TOKENS", 1_000_000],
  ["AI_MAIN_OUTPUT_MAX_TOKENS", 131_072],
  ["AI_FAST_INPUT_MAX_TOKENS", 200_000],
  ["AI_FAST_OUTPUT_MAX_TOKENS", 131_072],
  ["AI_CONVERSATION_RECENT_TURNS", 200],
  ["AI_TOPIC_RESEARCH_MAX_CONCURRENCY", 32],
  ["AI_TOPIC_ANSWER_MAX_CONCURRENCY", 32],
  ["AI_WEB_MAX_SEARCHES", 32],
  ["AI_WEB_MAX_FETCHES", 64],
  ["AI_MEMORY_TOOL_RESULT_MAX_ITEMS", 500],
  ["AI_FAST_TASK_TIMEOUT_MS", 1_200_000],
  ["AI_ANSWER_TIMEOUT_MS", 900_000],
  ["AI_STREAM_POLL_MS", 10_000],
  ["AI_STREAM_KEEPALIVE_MS", 300_000],
] as const;

describe("central server configuration", () => {
  it("pins Phase B retrieval defaults and hard bounds", async () => {
    await expect(Effect.runPromise(loadWorkerConfigFrom({}))).resolves.toMatchObject({
      aiRetrievalMaxQueries: 24,
      aiRetrievalMaxBranchRows: 25,
      aiRetrievalMaxCandidates: 64,
      aiRetrievalMaxHydratedBytes: 2_000_000,
      aiRetrievalMaxConcurrency: 4,
      aiRetrievalQueryTimeoutMs: 30_000,
    });
    const cases = [
      ["AI_RETRIEVAL_MAX_QUERIES", RETRIEVAL_NUMERIC_SETTING_HARD_MAXIMA.AI_RETRIEVAL_MAX_QUERIES],
      [
        "AI_RETRIEVAL_MAX_BRANCH_ROWS",
        RETRIEVAL_NUMERIC_SETTING_HARD_MAXIMA.AI_RETRIEVAL_MAX_BRANCH_ROWS,
      ],
      [
        "AI_RETRIEVAL_MAX_CANDIDATES",
        RETRIEVAL_NUMERIC_SETTING_HARD_MAXIMA.AI_RETRIEVAL_MAX_CANDIDATES,
      ],
      [
        "AI_RETRIEVAL_MAX_HYDRATED_BYTES",
        RETRIEVAL_NUMERIC_SETTING_HARD_MAXIMA.AI_RETRIEVAL_MAX_HYDRATED_BYTES,
      ],
      [
        "AI_RETRIEVAL_MAX_CONCURRENCY",
        RETRIEVAL_NUMERIC_SETTING_HARD_MAXIMA.AI_RETRIEVAL_MAX_CONCURRENCY,
      ],
      [
        "AI_RETRIEVAL_QUERY_TIMEOUT_MS",
        RETRIEVAL_NUMERIC_SETTING_HARD_MAXIMA.AI_RETRIEVAL_QUERY_TIMEOUT_MS,
      ],
    ] as const;
    for (const [name, maximum] of cases) {
      await expect(
        Effect.runPromise(loadWorkerConfigFrom({ [name]: String(maximum) })),
      ).resolves.toBeDefined();
      await expect(
        Effect.runPromise(loadWorkerConfigFrom({ [name]: String(maximum + 1) })),
      ).rejects.toThrow(`${name} must be an integer between 1 and ${maximum}`);
    }
  });
  it("requires a complete dedicated export bucket and returns only its credentials", async () => {
    await expect(
      Effect.runPromise(
        withEnvironment(loadExportObjectStorageConfig, {
          EXPORT_BUCKET_ENDPOINT: "http://127.0.0.1:9010",
        }),
      ),
    ).rejects.toThrow("EXPORT_BUCKET must be either completely configured or completely empty");

    await expect(
      Effect.runPromise(
        withEnvironment(loadExportObjectStorageConfig, {
          EXPORT_BUCKET_ENDPOINT: "http://storage.internal:9010",
          EXPORT_BUCKET_NAME: "exports",
          EXPORT_BUCKET_ACCESS_KEY_ID: "export-access",
          EXPORT_BUCKET_SECRET_ACCESS_KEY: "export-secret",
        }),
      ),
    ).rejects.toThrow("exact credential-free HTTPS origin or a loopback HTTP origin");

    const common = {
      RAILWAY_BUCKET_ENDPOINT: "http://127.0.0.1:9010",
      RAILWAY_BUCKET_NAME: "publisher",
      RAILWAY_BUCKET_ACCESS_KEY_ID: "publisher-access",
      RAILWAY_BUCKET_SECRET_ACCESS_KEY: "publisher-secret",
      EXPORT_BUCKET_ENDPOINT: "http://127.0.0.1:9010",
      EXPORT_BUCKET_NAME: "exports",
      EXPORT_BUCKET_ACCESS_KEY_ID: "export-access",
      EXPORT_BUCKET_SECRET_ACCESS_KEY: "export-secret",
    };
    await expect(
      Effect.runPromise(
        withEnvironment(loadExportObjectStorageConfig, {
          ...common,
          EXPORT_BUCKET_NAME: "publisher",
        }),
      ),
    ).rejects.toThrow("must identify a dedicated bucket");
    await expect(
      Effect.runPromise(withEnvironment(loadExportObjectStorageConfig, common)),
    ).resolves.toMatchObject({
      endpoint: "http://127.0.0.1:9010",
      bucket: "exports",
      accessKeyId: "export-access",
      secretAccessKey: "export-secret",
      configured: true,
    });
  });

  it("pins the complete code-owned worker numeric hard-maxima contract", () => {
    expect(WORKER_NUMERIC_SETTING_HARD_MAXIMA).toEqual(
      Object.fromEntries(boundedWorkerNumericSettings),
    );
  });

  it("pins the complete code-owned server and maintenance numeric hard-maxima contract", () => {
    expect(SERVER_NUMERIC_SETTING_HARD_MAXIMA).toEqual({
      PORT: 65_535,
      WORKER_JOB_LOCK_TIMEOUT_MS: 3_600_000,
      EXPORT_DOWNLOAD_TTL_MS: 2_678_400_000,
      PUBLIC_SOURCE_AUDIT_FETCH_TIMEOUT_MS: 600_000,
    });
  });

  it("bounds every API, job, export, and audit numeric setting at startup", async () => {
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly maximum: number;
      readonly load: (value: string) => Effect.Effect<unknown, unknown, never>;
    }> = [
      {
        name: "PORT",
        maximum: SERVER_NUMERIC_SETTING_HARD_MAXIMA.PORT,
        load: (value: string) => loadApiConfigFrom({ PORT: value }),
      },
      {
        name: "AI_STREAM_POLL_MS",
        maximum: WORKER_NUMERIC_SETTING_HARD_MAXIMA.AI_STREAM_POLL_MS,
        load: (value: string) => loadApiConfigFrom({ AI_STREAM_POLL_MS: value }),
      },
      {
        name: "AI_STREAM_KEEPALIVE_MS",
        maximum: WORKER_NUMERIC_SETTING_HARD_MAXIMA.AI_STREAM_KEEPALIVE_MS,
        load: (value: string) => loadApiConfigFrom({ AI_STREAM_KEEPALIVE_MS: value }),
      },
      {
        name: "WORKER_JOB_LOCK_TIMEOUT_MS",
        maximum: SERVER_NUMERIC_SETTING_HARD_MAXIMA.WORKER_JOB_LOCK_TIMEOUT_MS,
        load: (value: string) =>
          withEnvironment(loadJobRepositoryConfig, { WORKER_JOB_LOCK_TIMEOUT_MS: value }),
      },
      {
        name: "EXPORT_DOWNLOAD_TTL_MS",
        maximum: SERVER_NUMERIC_SETTING_HARD_MAXIMA.EXPORT_DOWNLOAD_TTL_MS,
        load: (value: string) =>
          withEnvironment(loadPlatformJobConfig, { EXPORT_DOWNLOAD_TTL_MS: value }),
      },
      {
        name: "PUBLIC_SOURCE_AUDIT_FETCH_TIMEOUT_MS",
        maximum: SERVER_NUMERIC_SETTING_HARD_MAXIMA.PUBLIC_SOURCE_AUDIT_FETCH_TIMEOUT_MS,
        load: (value: string) =>
          withEnvironment(loadPublicSourceAuditConfig, {
            PUBLIC_SOURCE_AUDIT_FETCH_TIMEOUT_MS: value,
          }),
      },
      {
        name: "PUBLIC_SOURCE_STARTUP_BACKFILL_DAYS",
        maximum: WORKER_NUMERIC_SETTING_HARD_MAXIMA.PUBLIC_SOURCE_STARTUP_BACKFILL_DAYS,
        load: (value: string) =>
          withEnvironment(loadPublicSourceAuditConfig, {
            PUBLIC_SOURCE_STARTUP_BACKFILL_DAYS: value,
          }),
      },
    ];

    for (const setting of cases) {
      await expect(Effect.runPromise(setting.load("1"))).resolves.toBeDefined();
      await expect(Effect.runPromise(setting.load(String(setting.maximum)))).resolves.toBeDefined();
      for (const value of ["0", "-1", "1.5", String(setting.maximum + 1)]) {
        await expect(Effect.runPromise(setting.load(value))).rejects.toThrow(
          `${setting.name} must be an integer between 1 and ${setting.maximum}`,
        );
      }
    }
  });

  it("owns the canonical worker defaults", async () => {
    await expect(Effect.runPromise(loadWorkerConfigFrom({}))).resolves.toMatchObject({
      jobPollIntervalMs: 5_000,
      workerConcurrency: 2,
      runMigrationsOnStartup: true,
      publicSourceIngestionEnabled: true,
      publicSourcePollIntervalMs: 300_000,
      publicSourceStartupBackfillDays: 7,
      publicSourceOperationTimeoutMs: 60_000,
      aiBaseUrl: ZAI_CODING_PLAN_BASE_URL,
      aiMainModel: "glm-5-turbo",
      aiFastModel: "glm-5-turbo",
      aiMainInputMaxTokens: 100_000,
      aiMainOutputMaxTokens: 16_384,
      aiFastInputMaxTokens: 100_000,
      aiFastOutputMaxTokens: 16_384,
      aiConversationRecentTurns: 12,
      aiFanoutMaxTopics: 3,
      aiTopicResearchMaxConcurrency: 6,
      aiTopicAnswerMaxConcurrency: 3,
      aiWebMaxSearches: 4,
      aiWebMaxFetches: 8,
      aiWebMaxDomainFilters: AI_WEB_MAX_DOMAIN_FILTERS_DEFAULT,
      aiMemoryToolResultMaxItems: 50,
      aiFastTaskTimeoutMs: 1_200_000,
      aiAnswerTimeoutMs: 120_000,
      aiStreamPollMs: 300,
      aiStreamKeepaliveMs: 15_000,
      databaseUrl: LOCAL_DATABASE_URL,
      nodeEnv: "development",
    });
  });

  it.each(["glm-5.2", "", " glm-5-turbo "])(
    "rejects non-canonical AI model configuration %s",
    async (value) => {
      await expect(
        Effect.runPromise(loadWorkerConfigFrom({ AI_MAIN_MODEL: value })),
      ).rejects.toThrow();
      await expect(
        Effect.runPromise(loadWorkerConfigFrom({ AI_FAST_MODEL: value })),
      ).rejects.toThrow();
    },
  );

  it("owns the canonical API defaults", async () => {
    await expect(Effect.runPromise(loadApiConfigFrom({}))).resolves.toMatchObject({
      host: "0.0.0.0",
      port: 3000,
      nodeEnv: "development",
      aiStreamPollMs: 300,
      aiStreamKeepAliveMs: 15_000,
      webResearchProvider: null,
      aiWebMaxDomainFilters: AI_WEB_MAX_DOMAIN_FILTERS_DEFAULT,
      authMode: "demo",
      corsAllowedOrigins: ["http://localhost:5173", "http://127.0.0.1:5173"],
    });
  });

  it("rejects wildcard CORS configuration", async () => {
    await expect(
      Effect.runPromise(loadApiConfigFrom({ CORS_ALLOWED_ORIGINS: "*" })),
    ).rejects.toThrow("CORS_ALLOWED_ORIGINS must contain one or more explicit web origins");
    await expect(
      Effect.runPromise(loadApiConfigFrom({ CORS_ALLOWED_ORIGINS: "https://brief.example,*" })),
    ).rejects.toThrow("CORS_ALLOWED_ORIGINS must contain one or more explicit web origins");
  });

  it.each(["0", "33", "1.5"])("rejects unsafe web-domain fanout %s", async (value) => {
    await expect(
      Effect.runPromise(loadWorkerConfigFrom({ AI_WEB_MAX_DOMAIN_FILTERS: value })),
    ).rejects.toThrow("AI_WEB_MAX_DOMAIN_FILTERS must be an integer between 1 and 32");
    await expect(
      Effect.runPromise(loadApiConfigFrom({ AI_WEB_MAX_DOMAIN_FILTERS: value })),
    ).rejects.toThrow("AI_WEB_MAX_DOMAIN_FILTERS must be an integer between 1 and 32");
  });

  it("enforces fixed topology bounds instead of exposing runtime switches", async () => {
    await expect(
      Effect.runPromise(loadWorkerConfigFrom({ AI_FANOUT_MAX_TOPICS: "2" })),
    ).rejects.toThrow("AI_FANOUT_MAX_TOPICS is fixed at 3");
  });

  it.each(boundedWorkerNumericSettings)(
    "rejects every non-positive, fractional, or unsafe %s value",
    async (name, maximum) => {
      for (const value of ["0", "-1", "1.5", "9007199254740992", "Infinity"]) {
        await expect(Effect.runPromise(loadWorkerConfigFrom({ [name]: value }))).rejects.toThrow(
          `${name} must be an integer between 1 and ${maximum}`,
        );
      }
    },
  );

  it.each(boundedWorkerNumericSettings)(
    "accepts both bounded %s endpoints and rejects values above its hard maximum",
    async (name, maximum) => {
      await expect(Effect.runPromise(loadWorkerConfigFrom({ [name]: "1" }))).resolves.toBeDefined();
      await expect(
        Effect.runPromise(loadWorkerConfigFrom({ [name]: String(maximum) })),
      ).resolves.toBeDefined();
      await expect(
        Effect.runPromise(loadWorkerConfigFrom({ [name]: String(maximum + 1) })),
      ).rejects.toThrow(`${name} must be an integer between 1 and ${maximum}`);
    },
  );

  it("infers non-production Tinyfish capability from its key without exposing it through API config", async () => {
    const worker = await Effect.runPromise(
      loadWorkerConfigFrom({ TINYFISH_API_KEY: "tinyfish-secret" }),
    );
    expect(worker).toMatchObject({
      webResearchProvider: "tinyfish",
      tinyfishApiKey: "tinyfish-secret",
    });

    const api = await Effect.runPromise(loadApiConfigFrom({ TINYFISH_API_KEY: "tinyfish-secret" }));
    expect(api).toMatchObject({ webResearchProvider: "tinyfish" });
    expect(api).not.toHaveProperty("tinyfishApiKey");
  });

  it("rejects malformed server environments at the shared boundary", async () => {
    await expect(
      Effect.runPromise(loadWorkerConfigFrom({ NODE_ENV: "staging" })),
    ).rejects.toThrow();
    await expect(
      Effect.runPromise(
        loadWorkerConfigFrom({ AI_BASE_URL: "https://api.z.ai/v4?api_key=secret" }),
      ),
    ).rejects.toThrow("AI_BASE_URL must be an HTTPS URL");
    await expect(
      Effect.runPromise(
        loadApiConfigFrom({
          NODE_ENV: "production",
          RAILWAY_BUCKET_ENDPOINT: "http://objects.test",
        }),
      ),
    ).rejects.toThrow(PRODUCTION_DECISIONS_BLOCKER);
    await expect(
      Effect.runPromise(
        loadWorkerConfigFrom({
          NODE_ENV: "production",
          RAILWAY_BUCKET_ENDPOINT: "http://objects.test",
        }),
      ),
    ).rejects.toThrow("RAILWAY_BUCKET_ENDPOINT must be an exact credential-free HTTPS origin");
    await expect(
      Effect.runPromise(
        loadWorkerConfigFrom({
          NODE_ENV: "development",
          RAILWAY_BUCKET_ENDPOINT: "http://127.0.0.1:9000",
        }),
      ),
    ).resolves.toMatchObject({ objectStorageEndpoint: "http://127.0.0.1:9000" });
    await expect(
      Effect.runPromise(
        loadWorkerConfigFrom({
          NODE_ENV: "development",
          RAILWAY_BUCKET_ENDPOINT: "http://objects.test",
        }),
      ),
    ).rejects.toThrow("loopback HTTP origin");
  });

  it("provides reusable fragments without exposing env names to consumers", async () => {
    await expect(Effect.runPromise(withEnvironment(loadDatabaseUrl, {}))).resolves.toBe(
      LOCAL_DATABASE_URL,
    );
    await expect(
      Effect.runPromise(
        withEnvironment(loadObjectStorageConfig, {
          RAILWAY_BUCKET_ENDPOINT: "https://objects.test",
          RAILWAY_BUCKET_NAME: "brief",
          RAILWAY_BUCKET_ACCESS_KEY_ID: "key",
          RAILWAY_BUCKET_SECRET_ACCESS_KEY: "secret",
        }),
      ),
    ).resolves.toMatchObject({ configured: true, bucket: "brief" });
    await expect(
      Effect.runPromise(withEnvironment(loadDatabaseResetConfig, { NODE_ENV: "production" })),
    ).resolves.toEqual({ nodeEnv: "production", allowProductionReset: false });
  });
});

describe("central browser configuration", () => {
  it("parses demo and production web API origins exactly", () => {
    expect(loadDemoBrowserConfig({})).toEqual({ apiBaseUrl: "http://localhost:3000" });
    expect(loadWebApiConfig({})).toEqual({ apiBaseUrl: "http://localhost:3000" });
    expect(loadWebApiConfig({ PROD: true })).toEqual({ apiBaseUrl: "" });
    expect(loadWebApiConfig({ VITE_API_BASE_URL: "https://api.brief.example" })).toEqual({
      apiBaseUrl: "https://api.brief.example",
    });
    expect(() => loadWebApiConfig({ VITE_API_BASE_URL: "https://api.brief.example/path" })).toThrow(
      "exact HTTP(S) origin",
    );
    expect(() => loadWebApiConfig({ VITE_API_BASE_URL: "http://api.brief.example" })).toThrow(
      "exact loopback origin",
    );
    expect(loadWebApiConfig({ VITE_API_BASE_URL: "http://127.0.0.1:43110" })).toEqual({
      apiBaseUrl: "http://127.0.0.1:43110",
    });
    expect(() =>
      loadWebApiConfig({ PROD: true, VITE_API_BASE_URL: "http://localhost:43110" }),
    ).toThrow("HTTPS in production");
    expect(
      loadWebApiConfig({ PROD: true, VITE_API_BASE_URL: "https://api.brief.example" }),
    ).toEqual({ apiBaseUrl: "https://api.brief.example" });
  });

  it("keeps browser production authentication fail-closed", () => {
    expect(() => loadWebAuthConfig({ PROD: true, VITE_AUTH_MODE: "demo" })).toThrow(
      "forbidden in production",
    );
    expect(() =>
      loadWebAuthConfig({ PROD: true, VITE_SECURITY_CONTACT_EMAIL: "security@brief.test" }),
    ).toThrow("VITE_CLERK_PUBLISHABLE_KEY is required");
  });

  it("keeps browser production observability fail-closed", () => {
    expect(() => loadWebObservabilityConfig({ PROD: true })).toThrow(
      "VITE_SENTRY_DSN is required in production",
    );
    expect(
      loadWebObservabilityConfig({
        PROD: true,
        VITE_SENTRY_DSN: "https://public-key@sentry.example/42",
      }),
    ).toEqual({ dsn: "https://public-key@sentry.example/42", environment: "production" });
  });
});
