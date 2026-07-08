import { Config, Effect } from "effect";

export interface WorkerConfig {
  readonly jobPollIntervalMs: number;
  readonly runMigrationsOnStartup: boolean;
  readonly publicSourceIngestionEnabled: boolean;
  readonly publicSourcePollIntervalMs: number;
  readonly publicSourceStartupBackfillDays: number;
  readonly publicSourceOperationTimeoutMs: number;
  readonly aiSearchMaxLimit: number;
  readonly aiSearchRecencyHalfLifeDays: number;
  readonly aiContextBlockBudget: number;
  readonly aiContextBlockHardCap: number;
  readonly aiFullDocMaxChars: number;
  readonly aiHistoryMaxMessages: number;
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
    aiSearchMaxLimit,
    aiSearchRecencyHalfLifeDays,
    aiContextBlockBudget,
    aiContextBlockHardCap,
    aiFullDocMaxChars,
    aiHistoryMaxMessages,
    nodeEnv,
  } satisfies WorkerConfig;
});
