import { PgClient } from "@effect/sql-pg";
import { Effect } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { camelToSnake } from "smithers-orchestrator";

import { AI_RUN_EVENT_RETENTION_MS } from "../product-state/events";
import { SMITHERS_TERMINAL_ORPHAN_RETENTION_MS } from "../product-state/retention";
import { AI_CHAT_SMITHERS_SCHEMA_FENCE } from "../smithers-interop";
import { aiEvaluationGeneralPlannerSchemas } from "../evaluation/general-planner-workflow";
import { aiChatSchemas } from "./ai-chat";

/**
 * Derive cleanup ownership from the exact workflow schemas registered at
 * startup. An output added or removed in either retained workflow therefore
 * changes GC in the same deploy and cannot leave a stale compatibility inventory.
 */
export const AI_CHAT_OUTPUT_SCHEMA_KEYS = Object.freeze(
  Object.keys(aiChatSchemas).filter((schemaKey) => schemaKey !== "input"),
);

export const AI_CHAT_OUTPUT_TABLES = Object.freeze(AI_CHAT_OUTPUT_SCHEMA_KEYS.map(camelToSnake));

export const AI_EVALUATION_GENERAL_PLANNER_OUTPUT_SCHEMA_KEYS = Object.freeze(
  Object.keys(aiEvaluationGeneralPlannerSchemas).filter((schemaKey) => schemaKey !== "input"),
);

export const AI_EVALUATION_GENERAL_PLANNER_OUTPUT_TABLES = Object.freeze(
  AI_EVALUATION_GENERAL_PLANNER_OUTPUT_SCHEMA_KEYS.map(camelToSnake),
);

/** Output tables owned by every Hartlib AI Smithers workflow retained by this sweep. */
export const AI_RUNTIME_OUTPUT_TABLES = Object.freeze([
  ...AI_CHAT_OUTPUT_TABLES,
  ...AI_EVALUATION_GENERAL_PLANNER_OUTPUT_TABLES,
]);

const smithersOwnedTables = new Set<string>(["input", ...AI_RUNTIME_OUTPUT_TABLES]);

interface RunIdTableRow {
  readonly tableName: string;
}

interface SmithersRunIdRow {
  readonly smithersRunId: string;
}

export const AI_RUNTIME_RETENTION_CANDIDATE_LIMIT = 500;

/** Smithers run IDs owned by Hartlib's AI runtime retention sweep. */
export const AI_RUNTIME_SMITHERS_RUN_PREFIXES = Object.freeze([
  "ai-chat:",
  "ai-evaluation-general-planner:",
]);

export interface SmithersSweepResult {
  readonly deletedRuns: number;
  readonly selectedCandidates: number;
}

export interface AiRunEventPruneResult {
  readonly deletedEvents: number;
  readonly selectedCandidates: number;
}

export interface AiRuntimeRetentionResult {
  readonly sweptRuns: number;
  readonly prunedEvents: number;
  readonly selectedCandidates: number;
}

const boundedRetentionCandidateLimit = (requested: number): number =>
  Number.isSafeInteger(requested)
    ? Math.min(AI_RUNTIME_RETENTION_CANDIDATE_LIMIT, Math.max(0, requested))
    : 0;

const loadSmithersRunIdTablesFor = (additionalOwnedTables: ReadonlySet<string> = new Set()) =>
  Effect.gen(function* () {
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
        (tableName) =>
          tableName.startsWith("_smithers_") ||
          smithersOwnedTables.has(tableName) ||
          additionalOwnedTables.has(tableName),
      );
  });

const loadSmithersRunIdTables = loadSmithersRunIdTablesFor();

const deleteSmithersRowsForRunInTables = (
  tableNames: readonly string[],
  smithersRunId: string,
): Effect.Effect<void, SqlError, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;

    // Smithers producers hold the shared side of this fence for the complete
    // workflow operation. Keep the ownership check and every delete in one
    // transaction-level exclusive fence so a producer cannot resume or write
    // the run between the heartbeat check and cleanup.
    yield* sql`
      select pg_advisory_xact_lock(
        hashtextextended(${AI_CHAT_SMITHERS_SCHEMA_FENCE}, 0)
      )
    `;

    for (const tableName of tableNames) {
      yield* sql`
        delete from ${sql(tableName)}
        where run_id = ${smithersRunId}
      `;
    }

    yield* sql`
      delete from ai_smithers_orphan_candidates
      where smithers_run_id = ${smithersRunId}
    `;
  });

export const deleteSmithersRowsForRun = (
  smithersRunId: string,
): Effect.Effect<void, SqlError, PgClient.PgClient> =>
  Effect.gen(function* () {
    const tableNames = yield* loadSmithersRunIdTables;
    yield* deleteSmithersRowsForRunInTables(tableNames, smithersRunId);
  });

/** Delete one run using the exact output tables registered by its workflow. */
export const deleteSmithersRowsForRunWithSchemas = (
  schemas: Readonly<Record<string, unknown>>,
  smithersRunId: string,
): Effect.Effect<void, SqlError, PgClient.PgClient> =>
  Effect.gen(function* () {
    const ownedTables = new Set(Object.keys(schemas).map(camelToSnake));
    const tableNames = yield* loadSmithersRunIdTablesFor(ownedTables);
    yield* deleteSmithersRowsForRunInTables(tableNames, smithersRunId);
  });

const smithersRunExistsInTables = (
  tableNames: readonly string[],
  smithersRunId: string,
): Effect.Effect<boolean, SqlError, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    for (const tableName of tableNames) {
      const rows = yield* sql<{ readonly present: boolean }>`
        select exists (
          select 1 from ${sql(tableName)} where run_id = ${smithersRunId}
        ) as present
      `;
      if (rows[0]?.present === true) return true;
    }
    return false;
  });

const smithersRunIsActivelyOwned = (
  tableNames: readonly string[],
  smithersRunId: string,
): Effect.Effect<boolean, SqlError, PgClient.PgClient> =>
  Effect.gen(function* () {
    if (!tableNames.includes("_smithers_runs")) return false;
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<{ readonly active: boolean }>`
      select exists (
        select 1
        from _smithers_runs runs
        where runs.run_id = ${smithersRunId}
          and runs.status = 'running'
          and runs.heartbeat_at_ms is not null
          and runs.heartbeat_at_ms >=
            extract(epoch from clock_timestamp()) * 1000 - 30000
      ) as active
    `;
    return rows[0]?.active === true;
  });

export const sweepAiChatSmithersRows = (
  candidateLimit = AI_RUNTIME_RETENTION_CANDIDATE_LIMIT,
): Effect.Effect<SmithersSweepResult, SqlError, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        // The fence must cover candidate discovery, heartbeat ownership
        // checks, orphan maturation, and deletion as one atomic decision.
        yield* sql`
          select pg_advisory_xact_lock(
            hashtextextended(${AI_CHAT_SMITHERS_SCHEMA_FENCE}, 0)
          )
        `;
        const tableNames = [...(yield* loadSmithersRunIdTables)].sort();
        const smithersRunIds = new Set<string>();
        const limit = boundedRetentionCandidateLimit(candidateLimit);

        if (limit === 0) return { deletedRuns: 0, selectedCandidates: 0 };

        for (const tableName of tableNames) {
          const remaining = limit - smithersRunIds.size;
          if (remaining === 0) break;
          const alreadySelected = [...smithersRunIds];
          const rows = yield* sql<SmithersRunIdRow>`
        select distinct state.run_id as "smithersRunId"
        from ${sql(tableName)} state
        where (
            state.run_id like 'ai-chat:%'
            or state.run_id like 'ai-evaluation-general-planner:%'
          )
          ${
            alreadySelected.length === 0
              ? sql``
              : sql`and not (${sql.in("state.run_id", alreadySelected)})`
          }
          and (
            exists (
              select 1
              from ai_runs runs
              where runs.smithers_run_id = state.run_id
                and (
                  runs.finished_at is not null
                  or runs.failed_at is not null
                  or runs.stopped_at is not null
                  or runs.superseded_at is not null
                )
                and coalesce(runs.finished_at, runs.failed_at, runs.stopped_at, runs.superseded_at) <
                  now() - (${SMITHERS_TERMINAL_ORPHAN_RETENTION_MS} * interval '1 millisecond')
            )
            or not exists (
              select 1 from ai_runs runs where runs.smithers_run_id = state.run_id
            )
          )
        order by state.run_id
        limit ${remaining}
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
          and (
            finished_at is not null
            or failed_at is not null
            or stopped_at is not null
            or superseded_at is not null
          )
          and coalesce(finished_at, failed_at, stopped_at, superseded_at) <
            now() - (${SMITHERS_TERMINAL_ORPHAN_RETENTION_MS} * interval '1 millisecond')
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
            yield* sql`
          delete from ai_smithers_orphan_candidates
          where smithers_run_id = ${smithersRunId}
        `;
            continue;
          }

          // A terminal product row is not enough to prove that Smithers is safe
          // to remove. A live Smithers owner wins this race; the next sweep can
          // reconsider it after the heartbeat disappears.
          if (yield* smithersRunIsActivelyOwned(tableNames, smithersRunId)) continue;

          if (absentRows.length > 0) {
            yield* sql`
          insert into ai_smithers_orphan_candidates (smithers_run_id)
          values (${smithersRunId})
          on conflict (smithers_run_id) do nothing
        `;
            const mature = yield* sql<SmithersRunIdRow>`
          select smithers_run_id as "smithersRunId"
          from ai_smithers_orphan_candidates
          where smithers_run_id = ${smithersRunId}
            and first_seen_at <
              now() - (${SMITHERS_TERMINAL_ORPHAN_RETENTION_MS} * interval '1 millisecond')
        `;
            if (mature.length === 0) continue;
          }

          yield* deleteSmithersRowsForRunInTables(tableNames, smithersRunId);
          deletedRuns += 1;
        }

        const remaining = limit - smithersRunIds.size;
        const selectedIds = [...smithersRunIds];
        const candidates =
          remaining === 0
            ? []
            : yield* sql<SmithersRunIdRow>`
      select smithers_run_id as "smithersRunId"
      from ai_smithers_orphan_candidates
      ${
        selectedIds.length === 0
          ? sql`where (
              smithers_run_id like 'ai-chat:%'
              or smithers_run_id like 'ai-evaluation-general-planner:%'
            )`
          : sql`where (
              smithers_run_id like 'ai-chat:%'
              or smithers_run_id like 'ai-evaluation-general-planner:%'
            ) and not (${sql.in("smithers_run_id", selectedIds)})`
      }
      order by first_seen_at, smithers_run_id
      limit ${remaining}
    `;
        for (const candidate of candidates) {
          smithersRunIds.add(candidate.smithersRunId);
          if (yield* smithersRunIsActivelyOwned(tableNames, candidate.smithersRunId)) continue;
          const presentInSmithers = yield* smithersRunExistsInTables(
            tableNames,
            candidate.smithersRunId,
          );
          const runs = yield* sql<{ readonly present: boolean }>`
        select exists (
          select 1 from ai_runs where smithers_run_id = ${candidate.smithersRunId}
        ) as present
      `;
          if (!presentInSmithers || runs[0]?.present === true) {
            yield* sql`
          delete from ai_smithers_orphan_candidates
          where smithers_run_id = ${candidate.smithersRunId}
        `;
          }
        }

        return { deletedRuns, selectedCandidates: smithersRunIds.size };
      }),
    );
  });

export const pruneFinishedAiRunEvents = (
  candidateLimit = AI_RUNTIME_RETENTION_CANDIDATE_LIMIT,
): Effect.Effect<AiRunEventPruneResult, SqlError, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const limit = boundedRetentionCandidateLimit(candidateLimit);
    if (limit === 0) return { deletedEvents: 0, selectedCandidates: 0 };
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const candidates = yield* sql<{ readonly runId: string }>`
          select terminal.run_id::text as "runId"
          from ai_run_events terminal
          where terminal.emission_key = 'terminal'
            and terminal.created_at <
              now() - (${AI_RUN_EVENT_RETENTION_MS} * interval '1 millisecond')
            and not exists (
              select 1
              from ai_evaluation_case_runs evaluation_runs
              join ai_evaluation_sessions evaluation_sessions
                on evaluation_sessions.id = evaluation_runs.session_id
              where evaluation_runs.ai_run_id = terminal.run_id
                and (
                  evaluation_sessions.status <> 'failed'
                  or evaluation_runs.run_evidence_sha256_hex is not null
                  or exists (
                    select 1
                    from ai_evaluation_annotations annotations
                    where annotations.session_id = evaluation_runs.session_id
                      and annotations.case_id = evaluation_runs.case_id
                      and annotations.topology = evaluation_runs.topology
                  )
                )
            )
          order by terminal.created_at, terminal.run_id
          limit ${limit}
          for update of terminal skip locked
        `;
        if (candidates.length === 0) return { deletedEvents: 0, selectedCandidates: 0 };
        const rows = yield* sql<{ readonly id: string }>`
          delete from ai_run_events events
          where ${sql.in(
            "events.run_id",
            candidates.map((candidate) => candidate.runId),
          )}
          returning events.id::text as id
        `;

        return { deletedEvents: rows.length, selectedCandidates: candidates.length };
      }),
    );
  });

export const purgeAiRuntimeRetention = (): Effect.Effect<
  AiRuntimeRetentionResult,
  SqlError,
  PgClient.PgClient
> =>
  Effect.gen(function* () {
    const smithers = yield* sweepAiChatSmithersRows(AI_RUNTIME_RETENTION_CANDIDATE_LIMIT);
    const events = yield* pruneFinishedAiRunEvents(
      AI_RUNTIME_RETENTION_CANDIDATE_LIMIT - smithers.selectedCandidates,
    );
    return {
      sweptRuns: smithers.deletedRuns,
      prunedEvents: events.deletedEvents,
      selectedCandidates: smithers.selectedCandidates + events.selectedCandidates,
    };
  });
