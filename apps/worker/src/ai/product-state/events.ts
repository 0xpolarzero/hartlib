import type { AiRunEvent as SharedAiRunEvent } from "@hartlib/shared";
import { PgClient } from "@effect/sql-pg";
import { Effect } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";

export const AI_RUN_EVENT_RETENTION_MS = 24 * 60 * 60 * 1_000;

export type AiRunEvent = SharedAiRunEvent;

export interface AppendAiRunEventInput {
  readonly runId: string;
  readonly emissionKey: string;
  readonly event: AiRunEvent;
  readonly emittedByTask?: string | undefined;
}

export interface AppendedAiRunEvent {
  readonly seq: number;
  readonly event: AiRunEvent;
  readonly emittedByTask: string | null;
  readonly inserted: boolean;
}

interface RunSequenceRow {
  readonly nextEventSeq: number;
  readonly terminal: boolean;
}

interface EventRow {
  readonly seq: number;
  readonly event: AiRunEvent;
  readonly emittedByTask: string | null;
}

/**
 * Acquire the parent run row before inserting any row that references it.
 *
 * PostgreSQL's foreign-key check takes a KEY SHARE lock on the parent while a
 * child row is inserted.  A transaction that inserts a usage or external-tool
 * usage row and
 * then appends an event would otherwise hold that KEY SHARE lock while trying
 * to upgrade to FOR UPDATE in `appendAiRunEventInTransaction`; two such
 * transactions can deadlock while each waits for the other's upgrade.  All
 * transactions that both mutate an ai_runs child and append an event must call
 * this helper first so the run-row lock order is uniform.
 */
export const lockAiRunForMutationInTransaction = (
  runId: string,
): Effect.Effect<void, SqlError | Error, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<{ readonly id: string }>`
      select id::text
      from ai_runs
      where id = ${runId}
      for update
    `;
    if (rows.length !== 1) {
      return yield* Effect.fail(new Error(`ai run not found: ${runId}`));
    }
  });

/**
 * Allocates a public event sequence only after the run row is locked and only
 * when the deterministic emission key is new. Callers that already own a
 * product transaction use this form so terminal state and terminal events
 * commit atomically.
 */
export const appendAiRunEventInTransaction = (
  input: AppendAiRunEventInput,
): Effect.Effect<AppendedAiRunEvent, SqlError | Error, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const runs = yield* sql<RunSequenceRow>`
      select
        next_event_seq as "nextEventSeq",
        (finished_at is not null or failed_at is not null or stopped_at is not null or superseded_at is not null) as terminal
      from ai_runs
      where id = ${input.runId}
      for update
    `;
    const run = runs[0];

    if (run === undefined) {
      return yield* Effect.fail(new Error(`ai run not found: ${input.runId}`));
    }

    const existing = yield* sql<EventRow>`
      select seq, event, emitted_by_task as "emittedByTask"
      from ai_run_events
      where run_id = ${input.runId}
        and emission_key = ${input.emissionKey}
      limit 1
    `;
    const prior = existing[0];

    if (prior !== undefined) {
      return { ...prior, inserted: false };
    }

    if (run.terminal && input.emissionKey !== "terminal") {
      return yield* Effect.fail(
        new Error(`cannot append event after terminal run: ${input.runId}`),
      );
    }

    const rows = yield* sql<EventRow>`
      insert into ai_run_events (
        run_id,
        seq,
        emission_key,
        event,
        emitted_by_task
      )
      values (
        ${input.runId},
        ${run.nextEventSeq},
        ${input.emissionKey},
        ${sql.json(input.event)},
        ${input.emittedByTask ?? null}
      )
      returning seq, event, emitted_by_task as "emittedByTask"
    `;

    yield* sql`
      update ai_runs
      set next_event_seq = ${run.nextEventSeq + 1},
          started_at = case
            when ${input.emissionKey} = 'run_started' then coalesce(started_at, now())
            else started_at
          end
      where id = ${input.runId}
    `;

    const appended = rows[0];
    if (appended === undefined) {
      return yield* Effect.fail(new Error("event insert returned no row"));
    }

    return { ...appended, inserted: true };
  });

export const appendAiRunEvent = (
  input: AppendAiRunEventInput,
): Effect.Effect<AppendedAiRunEvent, SqlError | Error, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(appendAiRunEventInTransaction(input));
  });

export const markAiRunStarted = (
  runId: string,
): Effect.Effect<AppendedAiRunEvent, SqlError | Error, PgClient.PgClient> =>
  appendAiRunEvent({ runId, emissionKey: "run_started", event: { type: "run_started" } });
