import { PgClient } from "@effect/sql-pg";
import { Effect, Redacted } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";

import type { Usage } from "@earendil-works/pi-ai";

export type AiRunEvent =
  | { readonly type: "run_started" }
  | {
      readonly type: "preflight_search";
      readonly terms: string;
      readonly resultCount: number;
    }
  | {
      readonly type: "preflight_peek";
      readonly documentId: string;
    }
  | {
      readonly type: "context_window";
      readonly blocks: ReadonlyArray<{
        readonly blockId: string;
        readonly label: string;
        readonly kind: "document" | "memory";
        readonly tokenEstimate: number;
      }>;
    }
  | { readonly type: "answer_started"; readonly attempt: number }
  | { readonly type: "answer_retry"; readonly gap: string }
  | { readonly type: "text_delta"; readonly delta: string }
  | {
      readonly type: "memory_updated";
      readonly created: number;
      readonly updated: number;
      readonly discarded: number;
    }
  | {
      readonly type: "usage";
      readonly agent: "preflight" | "answer" | "memory";
      readonly usage: Usage;
    }
  | { readonly type: "done"; readonly assistantMessageId: string }
  | { readonly type: "error"; readonly code: string; readonly retryable?: boolean };

interface NextSeqRow {
  readonly seq: number;
}

interface ExistingEventRow {
  readonly seq: number;
}

export const withAiRunEventTransaction = <A, E>(
  aiRunId: string,
  effect: Effect.Effect<A, E, PgClient.PgClient>,
): Effect.Effect<A, E | SqlError, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;

    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          select pg_advisory_xact_lock(hashtext(${`brief:ai_run_events:${aiRunId}`}))
        `;
        return yield* effect;
      }),
    );
  });

export const appendAiRunEventInTransaction = (
  aiRunId: string,
  event: AiRunEvent,
  emittedByTask?: string,
): Effect.Effect<number, SqlError, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<NextSeqRow>`
      insert into ai_run_events (run_id, seq, event, emitted_by_task)
      select ${aiRunId}, coalesce(max(seq), 0) + 1, ${sql.json(event)}, ${emittedByTask ?? null}
      from ai_run_events
      where run_id = ${aiRunId}
      returning seq
    `;

    return rows[0]?.seq ?? 1;
  });

export const appendAiRunEvent = (
  aiRunId: string,
  event: AiRunEvent,
): Effect.Effect<number, SqlError, PgClient.PgClient> =>
  withAiRunEventTransaction(aiRunId, appendAiRunEventInTransaction(aiRunId, event));

export const appendAiRunEventForTask = (
  aiRunId: string,
  taskId: string,
  event: AiRunEvent,
): Effect.Effect<number, SqlError, PgClient.PgClient> =>
  withAiRunEventTransaction(aiRunId, appendAiRunEventInTransaction(aiRunId, event, taskId));

export const deleteAiRunEventsForTask = (
  aiRunId: string,
  taskId: string,
): Effect.Effect<void, SqlError, PgClient.PgClient> =>
  withAiRunEventTransaction(
    aiRunId,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      yield* sql`
        delete from ai_run_events
        where run_id = ${aiRunId}
          and emitted_by_task = ${taskId}
      `;
    }),
  );

export const replaceAiRunEventsForTask = (
  aiRunId: string,
  taskId: string,
  events: readonly AiRunEvent[],
): Effect.Effect<void, SqlError, PgClient.PgClient> =>
  withAiRunEventTransaction(
    aiRunId,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      yield* sql`
        delete from ai_run_events
        where run_id = ${aiRunId}
          and emitted_by_task = ${taskId}
      `;

      for (const event of events) {
        yield* appendAiRunEventInTransaction(aiRunId, event, taskId);
      }
    }),
  );

export const appendAiRunEventOnce = (
  aiRunId: string,
  event: AiRunEvent,
): Effect.Effect<number | null, SqlError, PgClient.PgClient> =>
  withAiRunEventTransaction(
    aiRunId,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      const existing = yield* sql<ExistingEventRow>`
        select seq
        from ai_run_events
        where run_id = ${aiRunId}
          and event->>'type' = ${event.type}
        order by seq
        limit 1
      `;

      if (existing[0] !== undefined) {
        return null;
      }

      return yield* appendAiRunEventInTransaction(aiRunId, event);
    }),
  );

export const insertAiObservation = (
  aiRunId: string,
  chatId: string,
  kind: string,
  payload: Record<string, unknown>,
): Effect.Effect<void, SqlError, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;

    yield* sql`
      insert into ai_observations (run_id, chat_id, kind, payload)
      values (${aiRunId}, ${chatId}, ${kind}, ${sql.json(payload)})
    `;
  });

export const runAiWorkflowDb = <A, E>(
  connectionString: string,
  effect: Effect.Effect<A, E, PgClient.PgClient>,
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        PgClient.layer({
          url: Redacted.make(connectionString),
          applicationName: "brief-ai-chat-workflow",
        }),
      ),
    ),
  );
