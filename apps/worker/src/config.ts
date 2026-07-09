import { Config, Effect } from "effect";

import { ZAI_CODING_PLAN_BASE_URL } from "./ai/llm/models";

export interface WorkerConfig {
  readonly jobPollIntervalMs: number;
  readonly runMigrationsOnStartup: boolean;
  readonly publicSourceIngestionEnabled: boolean;
  readonly publicSourcePollIntervalMs: number;
  readonly publicSourceStartupBackfillDays: number;
  readonly publicSourceOperationTimeoutMs: number;
  readonly zaiApiKey: string;
  readonly aiBaseUrl: string;
  readonly aiMainModel: string;
  readonly aiFastModel: string;
  readonly aiSearchMaxLimit: number;
  readonly aiSearchRecencyHalfLifeDays: number;
  readonly aiContextBlockBudget: number;
  readonly aiContextBlockHardCap: number;
  readonly aiFullDocMaxChars: number;
  readonly aiHistoryMaxMessages: number;
  readonly aiPreflightHistoryMessages: number;
  readonly aiPreflightMaxTurns: number;
  readonly aiPreflightMaxSearches: number;
  readonly aiPreflightMaxPeeks: number;
  readonly aiPreflightTimeoutMs: number;
  readonly aiAnswerTimeoutMs: number;
  readonly aiStreamPollMs: number;
  readonly aiMemoryMaxWritesPerTurn: number;
  readonly aiMemoryInjectAllMaxTokens: number;
  readonly aiPlannerBaseline: boolean;
  readonly aiFake: boolean;
  readonly aiFakeDelayMs: number;
  readonly nodeEnv: string;
}

export const loadWorkerConfig = Effect.gen(function* () {
  const jobPollIntervalMs = yield* Config.number("WORKER_POLL_INTERVAL_MS").pipe(
    Config.withDefault(5000),
  );
  const publicSourceIngestionEnabled = yield* Config.boolean(
    "PUBLIC_SOURCE_INGESTION_ENABLED",
  ).pipe(Config.withDefault(true));
  const publicSourcePollIntervalMs = yield* Config.number("PUBLIC_SOURCE_POLL_INTERVAL_MS").pipe(
    Config.withDefault(300_000),
  );
  const publicSourceStartupBackfillDays = yield* Config.number(
    "PUBLIC_SOURCE_STARTUP_BACKFILL_DAYS",
  ).pipe(Config.withDefault(7));
  const publicSourceOperationTimeoutMs = yield* Config.number(
    "PUBLIC_SOURCE_OPERATION_TIMEOUT_MS",
  ).pipe(Config.withDefault(60_000));
  const zaiApiKey = yield* Config.string("ZAI_API_KEY").pipe(Config.withDefault(""));
  const rawAiBaseUrl = yield* Config.string("AI_BASE_URL").pipe(
    Config.withDefault(ZAI_CODING_PLAN_BASE_URL),
  );
  const aiBaseUrl = rawAiBaseUrl.trim() === "" ? ZAI_CODING_PLAN_BASE_URL : rawAiBaseUrl;
  const aiMainModel = yield* Config.string("AI_MAIN_MODEL").pipe(Config.withDefault("glm-5.2"));
  const aiFastModel = yield* Config.string("AI_FAST_MODEL").pipe(Config.withDefault("glm-5-turbo"));
  const aiSearchMaxLimit = yield* Config.number("AI_SEARCH_MAX_LIMIT").pipe(Config.withDefault(20));
  const aiSearchRecencyHalfLifeDays = yield* Config.number("AI_SEARCH_RECENCY_HALF_LIFE_DAYS").pipe(
    Config.withDefault(14),
  );
  const aiContextBlockBudget = yield* Config.number("AI_CONTEXT_BLOCK_BUDGET").pipe(
    Config.withDefault(60_000),
  );
  const aiContextBlockHardCap = yield* Config.number("AI_CONTEXT_BLOCK_HARD_CAP").pipe(
    Config.withDefault(100_000),
  );
  const aiFullDocMaxChars = yield* Config.number("AI_FULL_DOC_MAX_CHARS").pipe(
    Config.withDefault(12_000),
  );
  const aiHistoryMaxMessages = yield* Config.number("AI_HISTORY_MAX_MESSAGES").pipe(
    Config.withDefault(30),
  );
  const aiPreflightHistoryMessages = yield* Config.number("AI_PREFLIGHT_HISTORY_MESSAGES").pipe(
    Config.withDefault(6),
  );
  const aiPreflightMaxTurns = yield* Config.number("AI_PREFLIGHT_MAX_TURNS").pipe(
    Config.withDefault(4),
  );
  const aiPreflightMaxSearches = yield* Config.number("AI_PREFLIGHT_MAX_SEARCHES").pipe(
    Config.withDefault(8),
  );
  const aiPreflightMaxPeeks = yield* Config.number("AI_PREFLIGHT_MAX_PEEKS").pipe(
    Config.withDefault(4),
  );
  const aiPreflightTimeoutMs = yield* Config.number("AI_PREFLIGHT_TIMEOUT_MS").pipe(
    Config.withDefault(30_000),
  );
  const aiAnswerTimeoutMs = yield* Config.number("AI_ANSWER_TIMEOUT_MS").pipe(
    Config.withDefault(120_000),
  );
  const aiStreamPollMs = yield* Config.number("AI_STREAM_POLL_MS").pipe(Config.withDefault(300));
  const aiMemoryMaxWritesPerTurn = yield* Config.number("AI_MEMORY_MAX_WRITES_PER_TURN").pipe(
    Config.withDefault(5),
  );
  const aiMemoryInjectAllMaxTokens = yield* Config.number("AI_MEMORY_INJECT_ALL_MAX_TOKENS").pipe(
    Config.withDefault(1500),
  );
  const aiPlannerBaseline = yield* Config.boolean("AI_PLANNER_BASELINE").pipe(
    Config.withDefault(false),
  );
  const aiFake = yield* Config.boolean("AI_FAKE").pipe(Config.withDefault(false));
  const aiFakeDelayMs = yield* Config.number("AI_FAKE_DELAY_MS").pipe(Config.withDefault(0));
  const nodeEnv = yield* Config.string("NODE_ENV").pipe(Config.withDefault("development"));
  const runMigrationsOnStartup = yield* Config.boolean("WORKER_RUN_MIGRATIONS_ON_STARTUP").pipe(
    Config.withDefault(nodeEnv !== "production"),
  );

  return {
    jobPollIntervalMs,
    runMigrationsOnStartup,
    publicSourceIngestionEnabled,
    publicSourcePollIntervalMs,
    publicSourceStartupBackfillDays,
    publicSourceOperationTimeoutMs,
    zaiApiKey,
    aiBaseUrl,
    aiMainModel,
    aiFastModel,
    aiSearchMaxLimit,
    aiSearchRecencyHalfLifeDays,
    aiContextBlockBudget,
    aiContextBlockHardCap,
    aiFullDocMaxChars,
    aiHistoryMaxMessages,
    aiPreflightHistoryMessages,
    aiPreflightMaxTurns,
    aiPreflightMaxSearches,
    aiPreflightMaxPeeks,
    aiPreflightTimeoutMs,
    aiAnswerTimeoutMs,
    aiStreamPollMs,
    aiMemoryMaxWritesPerTurn,
    aiMemoryInjectAllMaxTokens,
    aiPlannerBaseline,
    aiFake,
    aiFakeDelayMs,
    nodeEnv,
  } satisfies WorkerConfig;
});
