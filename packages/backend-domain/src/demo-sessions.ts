import { PgClient } from "@effect/sql-pg";
import { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";

export interface DemoSessionRecord {
  readonly visitorId: string;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  readonly revokedAt: Date | null;
}

export type ResetDemoSessionResult =
  | { readonly kind: "unauthorized" }
  | { readonly kind: "accepted" | "replay"; readonly successorVisitorId: string };

const isUuid = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);

export const findDemoSession = (visitorId: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    if (!isUuid(visitorId)) return null;
    const rows = yield* sql<DemoSessionRecord>`
      select visitor_id::text as "visitorId", created_at as "createdAt",
             last_seen_at as "lastSeenAt", revoked_at as "revokedAt"
      from demo_sessions where visitor_id = ${visitorId}::uuid limit 1
    `;
    return rows[0] ?? null;
  });

export const hasActiveDemoSession = (visitorId: string) =>
  Effect.gen(function* () {
    const session = yield* findDemoSession(visitorId);
    return session !== null && session.revokedAt === null;
  });

export const persistDemoSession = (visitorId: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    if (!isUuid(visitorId)) return yield* Effect.fail(new Error("invalid_demo_visitor_id"));
    yield* sql`
      insert into demo_sessions (visitor_id)
      values (${visitorId}::uuid)
      on conflict (visitor_id) do update set
        last_seen_at = now()
    `;
    return visitorId;
  });

const resetInTransaction = (resetOperationId: string, predecessorVisitorId: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    if (!isUuid(resetOperationId) || !isUuid(predecessorVisitorId)) {
      return yield* Effect.fail(new Error("invalid_reset_identity"));
    }

    // Replay lookup must precede predecessor authentication.  This lets a
    // response-loss retry succeed after revocation and after purge has begun.
    const replayRows = yield* sql<{ readonly successorVisitorId: string }>`
      select successor_visitor_id::text as "successorVisitorId"
      from demo_reset_operations
      where reset_operation_id = ${resetOperationId}::uuid
      limit 1
    `;
    if (replayRows[0] !== undefined) {
      return { kind: "replay", successorVisitorId: replayRows[0].successorVisitorId } as const;
    }

    const predecessorRows = yield* sql<{
      readonly visitorId: string;
      readonly revokedAt: Date | null;
    }>`
      select visitor_id::text as "visitorId", revoked_at as "revokedAt"
      from demo_sessions
      where visitor_id = ${predecessorVisitorId}::uuid
      for update
    `;
    const predecessor = predecessorRows[0];
    if (predecessor === undefined) return { kind: "unauthorized" } as const;

    // A second operation id for the same locked predecessor shares the first
    // successor and purge job.  It still gets its own replay row.
    const predecessorOperation = yield* sql<{
      readonly successorVisitorId: string;
      readonly purgeJobId: string | null;
    }>`
      select successor_visitor_id::text as "successorVisitorId",
             purge_job_id::text as "purgeJobId"
      from demo_reset_operations
      where predecessor_visitor_id = ${predecessorVisitorId}::uuid
      order by created_at, reset_operation_id
      limit 1
    `;
    if (predecessorOperation[0] !== undefined) {
      yield* sql`
        insert into demo_reset_operations (
          reset_operation_id, predecessor_visitor_id, successor_visitor_id, purge_job_id
        ) values (
          ${resetOperationId}::uuid, ${predecessorVisitorId}::uuid,
          ${predecessorOperation[0].successorVisitorId}::uuid,
          ${predecessorOperation[0].purgeJobId}::uuid
        )
        on conflict (reset_operation_id) do nothing
      `;
      return {
        kind: "accepted",
        successorVisitorId: predecessorOperation[0].successorVisitorId,
      } as const;
    }
    if (predecessor.revokedAt !== null) return { kind: "unauthorized" } as const;

    const successorVisitorId = crypto.randomUUID();
    yield* sql`insert into demo_sessions (visitor_id) values (${successorVisitorId}::uuid)`;
    yield* sql`
      update demo_sessions set revoked_at = coalesce(revoked_at, now()), last_seen_at = now()
      where visitor_id = ${predecessorVisitorId}::uuid
    `;
    const jobRows = yield* sql<{ readonly id: string }>`
      insert into jobs (kind, payload, unique_key, priority, max_attempts)
      values (
        'demo_identity_purge',
        ${sql.json({ visitorId: predecessorVisitorId })},
        ${`demo-identity-purge:${predecessorVisitorId}`},
        200,
        2147483647
      )
      on conflict (unique_key) where unique_key is not null do update set
        payload = excluded.payload,
        status = case when jobs.status in ('completed', 'failed') then 'queued' else jobs.status end,
        completed_at = case when jobs.status in ('completed', 'failed') then null else jobs.completed_at end,
        locked_at = case when jobs.status in ('completed', 'failed') then null else jobs.locked_at end,
        locked_by = case when jobs.status in ('completed', 'failed') then null else jobs.locked_by end,
        last_error = case when jobs.status in ('completed', 'failed') then null else jobs.last_error end,
        attempts = case when jobs.status in ('completed', 'failed') then 0 else jobs.attempts end,
        max_attempts = 2147483647,
        updated_at = now()
      returning id::text
    `;
    const purgeJobId = jobRows[0]?.id;
    if (purgeJobId === undefined) return yield* Effect.fail(new Error("purge_job_not_created"));
    yield* sql`
      insert into demo_reset_operations (
        reset_operation_id, predecessor_visitor_id, successor_visitor_id, purge_job_id
      ) values (
        ${resetOperationId}::uuid, ${predecessorVisitorId}::uuid,
        ${successorVisitorId}::uuid, ${purgeJobId}::uuid
      )
    `;
    return { kind: "accepted", successorVisitorId } as const;
  });

/** Atomically revoke a predecessor and bind exactly one purge job. */
export const resetDemoSession = (
  resetOperationId: string,
  predecessorVisitorId: string,
): Effect.Effect<ResetDemoSessionResult, unknown, PgClient.PgClient | SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(resetInTransaction(resetOperationId, predecessorVisitorId));
  });
