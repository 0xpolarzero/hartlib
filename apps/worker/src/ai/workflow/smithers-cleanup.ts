import { PgClient } from "@effect/sql-pg";
import { Effect } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";

export const AI_CHAT_OUTPUT_SCHEMA_KEYS = [
  "aiChatLoadTurn",
  "aiChatPreflight",
  "aiChatHydrate",
  "aiChatAnswer",
  "aiChatPreflight2",
  "aiChatHydrate2",
  "aiChatAnswer2",
  "aiChatMemory",
  "aiChatFinalize",
] as const;

export const AI_CHAT_OUTPUT_TABLES = [
  "ai_chat_load_turn",
  "ai_chat_preflight",
  "ai_chat_hydrate",
  "ai_chat_answer",
  "ai_chat_preflight2",
  "ai_chat_hydrate2",
  "ai_chat_answer2",
  "ai_chat_memory",
  "ai_chat_finalize",
] as const;

const smithersOwnedTables = new Set<string>(["input", ...AI_CHAT_OUTPUT_TABLES]);

interface RunIdTableRow {
  readonly tableName: string;
}

interface SmithersRunIdRow {
  readonly smithersRunId: string;
}

const loadSmithersRunIdTables = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  const rows = yield* sql<RunIdTableRow>`
    select distinct table_name as "tableName"
    from information_schema.columns
    where table_schema = 'public'
      and column_name = 'run_id'
  `;

  return rows
    .map((row) => row.tableName)
    .filter(
      (tableName) => tableName.startsWith("_smithers_") || smithersOwnedTables.has(tableName),
    );
});

export const deleteSmithersRowsForRun = (
  smithersRunId: string,
): Effect.Effect<void, SqlError, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const tableNames = yield* loadSmithersRunIdTables;

    for (const tableName of tableNames) {
      yield* sql`
        delete from ${sql(tableName)}
        where run_id = ${smithersRunId}
      `;
    }
  });

export const sweepAiChatSmithersRows = (): Effect.Effect<number, SqlError, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const tableNames = yield* loadSmithersRunIdTables;
    const smithersRunIds = new Set<string>();

    for (const tableName of tableNames) {
      const rows = yield* sql<SmithersRunIdRow>`
        select distinct run_id as "smithersRunId"
        from ${sql(tableName)}
        where run_id like 'ai-chat:%'
      `;

      for (const row of rows) {
        smithersRunIds.add(row.smithersRunId);
      }
    }

    let deletedRuns = 0;
    for (const smithersRunId of smithersRunIds) {
      const rows = yield* sql<SmithersRunIdRow>`
        select smithers_run_id as "smithersRunId"
        from ai_runs
        where smithers_run_id = ${smithersRunId}
          and (finished_at is not null or failed_at is not null)
      `;
      const absentRows = yield* sql<SmithersRunIdRow>`
        select ${smithersRunId}::text as "smithersRunId"
        where not exists (
          select 1
          from ai_runs
          where smithers_run_id = ${smithersRunId}
        )
      `;

      if (rows.length === 0 && absentRows.length === 0) {
        continue;
      }

      yield* deleteSmithersRowsForRun(smithersRunId);
      deletedRuns += 1;
    }

    return deletedRuns;
  });

export const pruneFinishedAiRunEvents = (
  gracePeriodMs: number,
): Effect.Effect<number, SqlError, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<{ readonly id: string }>`
      delete from ai_run_events events
      using ai_runs runs
      where events.run_id = runs.id
        and coalesce(runs.finished_at, runs.failed_at) is not null
        and coalesce(runs.finished_at, runs.failed_at) < now() - (${gracePeriodMs} * interval '1 millisecond')
      returning events.id::text as id
    `;

    return rows.length;
  });
