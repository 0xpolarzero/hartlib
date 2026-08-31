import { PgClient } from "@effect/sql-pg";
import { Effect, Redacted } from "effect";
import { describe, expect, it } from "vitest";

import { updateDemoPublicSource } from "./demo-public-sources";

const databaseUrl = process.env.WORKER_POSTGRES_TEST_DATABASE_URL;

const runDb = <A, E, R>(effect: Effect.Effect<A, E, R>): Promise<A> => {
  if (databaseUrl === undefined) throw new Error("WORKER_POSTGRES_TEST_DATABASE_URL is required");
  const pgEffect = effect as unknown as Effect.Effect<A, E, PgClient.PgClient>;
  return Effect.runPromise(
    pgEffect.pipe(
      Effect.provide(
        PgClient.layer({
          url: Redacted.make(databaseUrl),
          applicationName: "hartlib-demo-public-source-test",
        }),
      ),
    ),
  );
};

describe.skipIf(databaseUrl === undefined)("demo public-source mutation", () => {
  it("authorizes and persists one strict enabled toggle", async () => {
    const userId = `public-source-test-${crypto.randomUUID()}`;
    const companyId = crypto.randomUUID();
    const requestId = crypto.randomUUID();
    const sourceId = `source_test_${crypto.randomUUID()}`;
    const identity = {
      userId,
      sessionId: userId,
    };

    try {
      await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`insert into platform_users (id, primary_email, display_name) values (${userId}, ${`${userId}@example.test`}, 'Source test')`;
          yield* sql`insert into client_companies (id, name) values (${companyId}::uuid, 'Source company')`;
          yield* sql`insert into client_company_memberships (company_id, user_id, role) values (${companyId}::uuid, ${userId}, 'admin')`;
          yield* sql`
            insert into public_sources (
              source_id, display_name, publisher_name, description,
              ingestion_method, discovery_url, average_chars_per_item
            ) values (
              ${sourceId}, 'Assemblee nationale', 'Assemblee nationale',
              'Source test', 'rss', 'https://example.test/source', 100
            )
            on conflict (source_id) do nothing
          `;

          const setting = yield* updateDemoPublicSource({
            identity,
            companyId,
            sourceId,
            enabled: false,
            requestId,
          });
          expect(setting).toEqual({ sourceId, enabled: false });

          const rows = yield* sql<{ readonly enabled: boolean }>`
            select enabled
            from client_company_public_source_settings
            where client_company_id = ${companyId}::uuid and source_id = ${sourceId}
          `;
          expect(rows).toEqual([{ enabled: false }]);
        }),
      );
    } finally {
      await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`set local hartlib.allow_account_purge = 'on'`;
              yield* sql`delete from client_companies where id = ${companyId}::uuid`;
              yield* sql`delete from platform_users where id = ${userId}`;
              yield* sql`delete from public_sources where source_id = ${sourceId}`;
            }),
          );
        }),
      );
    }
  });
});
