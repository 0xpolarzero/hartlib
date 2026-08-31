import { PgClient } from "@effect/sql-pg";
import { Effect, Redacted } from "effect";
import { describe, expect, it } from "vitest";

import { resetDemoSession } from "./demo-sessions";

const databaseUrl = (
  globalThis as { readonly process?: { readonly env?: Record<string, string | undefined> } }
).process?.env?.WORKER_POSTGRES_TEST_DATABASE_URL;

const runDb = <A, E, R>(effect: Effect.Effect<A, E, R>): Promise<A> => {
  if (databaseUrl === undefined) throw new Error("WORKER_POSTGRES_TEST_DATABASE_URL is required");
  const pgEffect = effect as unknown as Effect.Effect<A, E, PgClient.PgClient>;
  return Effect.runPromise(
    pgEffect.pipe(
      Effect.provide(
        PgClient.layer({
          url: Redacted.make(databaseUrl),
          applicationName: "hartlib-demo-session-integration-test",
        }),
      ),
    ),
  );
};

describe.skipIf(databaseUrl === undefined)("demo session reset lifecycle", () => {
  it("converges concurrent operation ids behind the predecessor lock", async () => {
    const predecessor = crypto.randomUUID();
    const operationIds = [crypto.randomUUID(), crypto.randomUUID()] as const;
    const successorIds = new Set<string>();

    try {
      await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`insert into demo_sessions (visitor_id) values (${predecessor}::uuid)`;
        }),
      );

      const results = await Promise.all(
        operationIds.map((operationId) => runDb(resetDemoSession(operationId, predecessor))),
      );
      for (const result of results) {
        expect(result.kind).toBe("accepted");
        if (result.kind === "accepted") successorIds.add(result.successorVisitorId);
      }
      expect(successorIds.size).toBe(1);

      await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const operations = yield* sql<{
            readonly successor: string;
            readonly predecessor: string | null;
          }>`
            select successor_visitor_id::text as successor,
                   predecessor_visitor_id::text as predecessor
            from demo_reset_operations
            where reset_operation_id in (${operationIds[0]}::uuid, ${operationIds[1]}::uuid)
          `;
          expect(operations).toHaveLength(2);
          expect(new Set(operations.map((operation) => operation.successor))).toEqual(successorIds);
          expect(operations.every((operation) => operation.predecessor === predecessor)).toBe(true);

          const jobs = yield* sql<{ readonly id: string }>`
            select id::text as id
            from jobs
            where unique_key = ${`demo-identity-purge:${predecessor}`}
          `;
          expect(jobs).toHaveLength(1);
        }),
      );
    } finally {
      await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            delete from demo_reset_operations
            where reset_operation_id in (${operationIds[0]}::uuid, ${operationIds[1]}::uuid)
          `;
          yield* sql`delete from jobs where unique_key = ${`demo-identity-purge:${predecessor}`}`;
          yield* sql`delete from demo_sessions where visitor_id = ${predecessor}::uuid`;
          for (const successorId of successorIds) {
            yield* sql`delete from demo_sessions where visitor_id = ${successorId}::uuid`;
          }
        }),
      );
    }
  });

  it("converges competing operation ids and replays after predecessor revocation", async () => {
    const predecessor = crypto.randomUUID();
    const firstOperation = crypto.randomUUID();
    const competingOperation = crypto.randomUUID();
    let successorId: string | undefined;

    try {
      const successor = await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`insert into demo_sessions (visitor_id) values (${predecessor}::uuid)`;

          const first = yield* resetDemoSession(firstOperation, predecessor);
          const competing = yield* resetDemoSession(competingOperation, predecessor);
          expect(first.kind).toBe("accepted");
          expect(competing.kind).toBe("accepted");
          if (first.kind !== "accepted" || competing.kind !== "accepted") {
            return yield* Effect.fail(new Error("reset did not accept"));
          }
          expect(competing.successorVisitorId).toBe(first.successorVisitorId);

          const replay = yield* resetDemoSession(firstOperation, predecessor);
          expect(replay).toEqual({ kind: "replay", successorVisitorId: first.successorVisitorId });

          const jobs = yield* sql<{ readonly id: string; readonly payload: unknown }>`
            select id::text as id, payload
            from jobs
            where unique_key = ${`demo-identity-purge:${predecessor}`}
          `;
          expect(jobs).toHaveLength(1);
          expect(jobs[0]?.payload).toEqual({ visitorId: predecessor });

          const operations = yield* sql<{
            readonly successor: string;
            readonly predecessor: string | null;
          }>`
            select successor_visitor_id::text as successor,
                   predecessor_visitor_id::text as predecessor
            from demo_reset_operations
            where reset_operation_id in (${firstOperation}::uuid, ${competingOperation}::uuid)
            order by reset_operation_id
          `;
          expect(operations).toHaveLength(2);
          expect(new Set(operations.map((operation) => operation.successor))).toEqual(
            new Set([first.successorVisitorId]),
          );
          expect(operations.every((operation) => operation.predecessor === predecessor)).toBe(true);

          const session = yield* sql<{ readonly revoked: Date | null }>`
            select revoked_at as revoked from demo_sessions where visitor_id = ${predecessor}::uuid
          `;
          expect(session[0]?.revoked).not.toBeNull();
          successorId = first.successorVisitorId;
          return first.successorVisitorId;
        }),
      );
      expect(successor).toMatch(/^[0-9a-f-]{36}$/iu);
    } finally {
      await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`delete from demo_reset_operations where reset_operation_id in (${firstOperation}::uuid, ${competingOperation}::uuid)`;
          yield* sql`delete from jobs where unique_key = ${`demo-identity-purge:${predecessor}`}`;
          yield* sql`delete from demo_sessions where visitor_id = ${predecessor}::uuid`;
          if (successorId !== undefined) {
            yield* sql`delete from demo_sessions where visitor_id = ${successorId}::uuid`;
          }
        }),
      );
    }
  });
});
