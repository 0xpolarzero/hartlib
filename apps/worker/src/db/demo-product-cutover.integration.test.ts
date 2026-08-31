import { readFile, readdir } from "node:fs/promises";

import { PgClient } from "@effect/sql-pg";
import { Effect, Redacted } from "effect";
import { describe, expect, it } from "vitest";

import { makeRunAcceptanceScope } from "../../../../packages/shared/src/chat";

const databaseUrl = process.env.WORKER_POSTGRES_TEST_DATABASE_URL;
const migrationsDirectory = new URL("../../../../db/migrations/", import.meta.url);
const upgradeDatabaseName = `hartlib_demo_cutover_upgrade_${process.pid}_${crypto
  .randomUUID()
  .replaceAll("-", "")
  .slice(0, 8)}`;

const databaseUrlFor = (name: string): string => {
  if (databaseUrl === undefined) throw new Error("WORKER_POSTGRES_TEST_DATABASE_URL is required");
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
};

const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;

const runDb = <A, E>(effect: Effect.Effect<A, E, PgClient.PgClient>): Promise<A> => {
  return runDbAt(databaseUrl!, effect);
};

const runDbAt = <A, E>(
  targetDatabaseUrl: string,
  effect: Effect.Effect<A, E, PgClient.PgClient>,
): Promise<A> => {
  return Effect.runPromise(
    effect.pipe(
      Effect.provide(
        PgClient.layer({
          url: Redacted.make(targetDatabaseUrl),
          applicationName: "hartlib-demo-product-cutover-test",
        }),
      ),
    ),
  );
};

describe.skipIf(databaseUrl === undefined)("demo product cutover schema", () => {
  it("upgrades a representative pre-cutover database destructively", async () => {
    const upgradeUrl = databaseUrlFor(upgradeDatabaseName);
    const preCutoverFiles = (await readdir(migrationsDirectory, "utf8"))
      .filter((file) => /^\d{4}_.+\.sql$/u.test(file) && file < "0074_")
      .sort();
    const preCutoverBodies = await Promise.all(
      preCutoverFiles.map(async (file) => ({
        file,
        body: await readFile(new URL(file, migrationsDirectory), "utf8"),
      })),
    );
    const legacyUserId = "legacy-upgrade-user";
    const legacyCompanyId = crypto.randomUUID();
    const firstChatId = crypto.randomUUID();
    const secondChatId = crypto.randomUUID();

    try {
      await runDbAt(
        databaseUrlFor("postgres"),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql.unsafe(`create database ${quoteIdentifier(upgradeDatabaseName)}`).raw;
        }),
      );

      await runDbAt(
        upgradeUrl,
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql.withTransaction(
            Effect.gen(function* () {
              for (const migration of preCutoverBodies) {
                yield* sql.unsafe(migration.body).raw;
              }
            }),
          );
          yield* sql`
            insert into platform_users (id, clerk_user_id, primary_email, display_name)
            values (${legacyUserId}, 'legacy-upgrade-clerk', 'legacy-upgrade@example.test', 'Legacy upgrade')
          `;
          yield* sql`
            insert into client_companies (id, name)
            values (${legacyCompanyId}::uuid, 'Legacy upgrade company')
          `;
          yield* sql`
            insert into client_company_memberships (company_id, user_id, role)
            values (${legacyCompanyId}::uuid, ${legacyUserId}, 'admin')
          `;
          yield* sql`
            insert into chats (id, user_id, company_id, memory_mode, shared_at)
            values
              (${firstChatId}::uuid, ${legacyUserId}, ${legacyCompanyId}::uuid, 'private_owner', null),
              (${secondChatId}::uuid, ${legacyUserId}, ${legacyCompanyId}::uuid, 'disabled', now())
          `;
          yield* sql`
            insert into workspace_invitations (
              workspace_kind, client_company_id, normalized_email, role, invited_by_user_id
            ) values (
              'client', ${legacyCompanyId}::uuid, 'old-invitation@example.test', 'member', ${legacyUserId}
            )
          `;
          yield* sql`
            insert into jobs (kind, payload, unique_key)
            values ('process_stripe_webhook', '{}'::jsonb, 'legacy-upgrade-job')
          `;
        }),
      );

      const cutoverSql = await readFile(
        new URL("0074_demo_product_cutover.sql", migrationsDirectory),
        "utf8",
      );
      await runDbAt(
        upgradeUrl,
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql.unsafe(cutoverSql).raw;
        }),
      );

      const result = await runDbAt(
        upgradeUrl,
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const oldChatRows = yield* sql<{ readonly count: number }>`
            select count(*)::int as count from chats
            where user_id = ${legacyUserId}
          `;
          const retainedUser = yield* sql<{ readonly id: string; readonly email: string }>`
            select id, primary_email as email from platform_users where id = ${legacyUserId}
          `;
          const retainedCompany = yield* sql<{ readonly id: string }>`
            select id::text as id from client_companies where id = ${legacyCompanyId}::uuid
          `;
          const obsoleteObjects = yield* sql<{ readonly name: string }>`
            select name
            from (values ('workspace_invitations'), ('stripe_webhook_events')) expected(name)
            where to_regclass('public.' || name) is not null
          `;
          const obsoleteJobs = yield* sql<{ readonly count: number }>`
            select count(*)::int as count from jobs where unique_key = 'legacy-upgrade-job'
          `;
          const finalChatColumns = yield* sql<{ readonly name: string }>`
            select column_name as name
            from information_schema.columns
            where table_schema = 'public' and table_name = 'chats'
            order by ordinal_position
          `;
          const sessionRows = yield* sql<{ readonly count: number }>`
            select count(*)::int as count from demo_sessions
          `;
          return {
            oldChatRows: oldChatRows[0]?.count ?? -1,
            retainedUser,
            retainedCompany,
            obsoleteObjects,
            obsoleteJobs: obsoleteJobs[0]?.count ?? -1,
            finalChatColumns: finalChatColumns.map((row) => row.name),
            sessionRows: sessionRows[0]?.count ?? -1,
          };
        }),
      );

      expect(result.oldChatRows).toBe(0);
      expect(result.retainedUser).toEqual([
        { id: legacyUserId, email: "legacy-upgrade@example.test" },
      ]);
      expect(result.retainedCompany).toEqual([{ id: legacyCompanyId }]);
      expect(result.obsoleteObjects).toEqual([]);
      expect(result.obsoleteJobs).toBe(0);
      expect(result.finalChatColumns).toEqual([
        "id",
        "user_id",
        "company_id",
        "memory_mode",
        "created_at",
        "updated_at",
      ]);
      expect(result.sessionRows).toBe(0);
    } finally {
      await runDbAt(
        databaseUrlFor("postgres"),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            select pg_terminate_backend(pid)
            from pg_stat_activity
            where datname = ${upgradeDatabaseName} and pid <> pg_backend_pid()
          `;
          yield* sql.unsafe(`drop database if exists ${quoteIdentifier(upgradeDatabaseName)}`).raw;
        }),
      );
    }
  }, 180_000);

  it("exposes the singular chat, run-owned evidence, and reset graph only", async () => {
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const chatColumns = yield* sql<{ readonly columnName: string }>`
          select column_name as "columnName"
          from information_schema.columns
          where table_schema = 'public' and table_name = 'chats'
          order by ordinal_position
        `;
        expect(chatColumns.map((row) => row.columnName)).toEqual([
          "id",
          "user_id",
          "company_id",
          "memory_mode",
          "created_at",
          "updated_at",
        ]);

        const runColumns = yield* sql<{ readonly columnName: string }>`
          select column_name as "columnName"
          from information_schema.columns
          where table_schema = 'public' and table_name = 'ai_runs'
        `;
        expect(runColumns.map((row) => row.columnName)).toEqual(
          expect.arrayContaining(["stop_requested_at", "stopped_at", "superseded_at"]),
        );

        const sourceKeys = yield* sql<{ readonly constraintName: string }>`
          select constraint_name as "constraintName"
          from information_schema.table_constraints
          where table_schema = 'public'
            and table_name = 'assistant_message_sources'
            and constraint_type = 'PRIMARY KEY'
        `;
        expect(sourceKeys.map((row) => row.constraintName)).toHaveLength(1);
        const sourceKeyColumns = yield* sql<{ readonly columnName: string }>`
          select column_name as "columnName"
          from information_schema.key_column_usage
          where table_schema = 'public'
            and table_name = 'assistant_message_sources'
            and constraint_name = ${sourceKeys[0]?.constraintName ?? ""}
          order by ordinal_position
        `;
        expect(sourceKeyColumns.map((row) => row.columnName)).toEqual(["run_id", "source_key"]);

        const exposureColumns = yield* sql<{
          readonly columnName: string;
          readonly isNullable: string;
        }>`
          select column_name as "columnName", is_nullable as "isNullable"
          from information_schema.columns
          where table_schema = 'public'
            and table_name = 'ai_source_exposures'
            and column_name in ('run_id', 'assistant_message_id')
          order by ordinal_position
        `;
        expect(exposureColumns).toEqual([{ columnName: "run_id", isNullable: "NO" }]);

        const obsoleteExposureColumns = yield* sql<{ readonly columnName: string }>`
          select column_name as "columnName"
          from information_schema.columns
          where table_schema = 'public'
            and table_name = 'ai_source_exposures'
            and column_name in ('publisher_issue_id', 'publisher_document_id', 'publisher_extraction_id')
        `;
        expect(obsoleteExposureColumns).toEqual([]);
        const obsoleteSourceColumns = yield* sql<{ readonly columnName: string }>`
          select column_name as "columnName"
          from information_schema.columns
          where table_schema = 'public'
            and table_name = 'assistant_message_sources'
            and column_name in ('publisher_issue_id', 'publisher_document_id', 'publisher_extraction_id')
        `;
        expect(obsoleteSourceColumns).toEqual([]);

        const sourceUseKey = yield* sql<{ readonly columnName: string }>`
          select usage.column_name as "columnName"
          from information_schema.key_column_usage usage
          join information_schema.table_constraints constraint_row
            on constraint_row.constraint_name = usage.constraint_name
           and constraint_row.table_schema = usage.table_schema
          where usage.table_schema = 'public'
            and usage.table_name = 'assistant_message_source_uses'
            and constraint_row.constraint_type = 'PRIMARY KEY'
          order by usage.ordinal_position
        `;
        expect(sourceUseKey.map((row) => row.columnName)).toEqual([
          "run_id",
          "source_key",
          "consumer_task_id",
        ]);

        const deadObjects = yield* sql<{ readonly name: string }>`
          select name
          from (values
            ('chat_subscription_' || 'sources'),
            ('deleted_chat_tombstones'),
            ('workspace_invitations'),
            ('stripe_webhook_events')
          ) expected(name)
          where to_regclass('public.' || name) is not null
        `;
        expect(deadObjects).toEqual([]);

        const jobConstraint = yield* sql<{ readonly definition: string }>`
          select pg_get_constraintdef(oid) as definition
          from pg_constraint
          where conrelid = 'jobs'::regclass and conname = 'demo_identity_purge_payload_shape'
        `;
        expect(jobConstraint[0]?.definition).toContain("demo_identity_purge");
        const uniqueKeyConstraint = yield* sql<{ readonly definition: string }>`
          select pg_get_constraintdef(oid) as definition
          from pg_constraint
          where conrelid = 'jobs'::regclass and conname = 'demo_identity_purge_unique_key_shape'
        `;
        expect(uniqueKeyConstraint[0]?.definition).toContain("demo-identity-purge:");
        const attemptConstraint = yield* sql<{ readonly definition: string }>`
          select pg_get_constraintdef(oid) as definition
          from pg_constraint
          where conrelid = 'jobs'::regclass and conname = 'demo_identity_purge_unbounded_attempts'
        `;
        expect(attemptConstraint[0]?.definition).toContain("2147483647");
      }),
    );
  });

  it("cascades run-owned source uses without a foreign-key race", async () => {
    const userId = crypto.randomUUID();
    const companyId = crypto.randomUUID();
    const chatId = crypto.randomUUID();
    const userMessageId = crypto.randomUUID();
    const assistantMessageId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const citationNamespace = "cn_0123456789abcdef012345";
    const sourceKey = `k_${citationNamespace}_1`;
    const webLocator = {
      kind: "web",
      url: "https://example.com/article",
      title: "Article",
      domain: "example.com",
      quote: "Quote",
      quoteHash: "60zevYK_EZRK8EDTD4qmiPv0yDb0bdjEFUrfQNwoasY",
      capturedAt: "2026-01-01T00:00:00Z",
    };

    try {
      await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`insert into platform_users (id, primary_email, display_name) values (${userId}, ${`${userId}@example.test`}, 'Cascade test')`;
          yield* sql`insert into client_companies (id, name) values (${companyId}::uuid, 'Cascade test company')`;
          yield* sql`insert into client_company_memberships (company_id, user_id, role) values (${companyId}::uuid, ${userId}, 'admin')`;
          yield* sql`insert into chats (id, user_id, company_id, memory_mode) values (${chatId}::uuid, ${userId}, ${companyId}::uuid, 'private_owner')`;
          yield* sql`insert into chat_messages (id, chat_id, author, content) values (${userMessageId}::uuid, ${chatId}::uuid, 'user', 'Question')`;
          yield* sql`insert into ai_runs (id, chat_id, initiating_user_id, user_message_id, locale, market, citation_namespace, acceptance_scope) values (${runId}::uuid, ${chatId}::uuid, ${userId}, ${userMessageId}::uuid, 'en-US', 'US', ${citationNamespace}, ${sql.json(makeRunAcceptanceScope({ userId, chatId, companyId, provider: "deterministic_test", providerEndpointIdentity: "deterministic_test:deterministic" }))})`;
          yield* sql`insert into chat_messages (id, chat_id, author, content, assistant_ai_run_id) values (${assistantMessageId}::uuid, ${chatId}::uuid, 'assistant', ${`Answer [[cite:${sourceKey}]]`}, ${runId}::uuid)`;
          yield* sql`insert into assistant_message_sources (run_id, source_key, assistant_message_id, kind, locator, public_provenance, citation_namespace) values (${runId}::uuid, ${sourceKey}, ${assistantMessageId}::uuid, 'web', ${sql.json(webLocator)}, ${sql.json({ citationUrl: webLocator.url })}, ${citationNamespace})`;
          yield* sql`insert into assistant_message_source_uses (run_id, source_key, assistant_message_id, consumer_task_id, rendered_token_count, context_order, ranges) values (${runId}::uuid, ${sourceKey}, ${assistantMessageId}::uuid, 'single-answer', 1, 0, '[]'::jsonb)`;
          yield* sql`delete from chats where id = ${chatId}::uuid`;
          expect(
            yield* sql`select 1 from assistant_message_sources where run_id = ${runId}::uuid`,
          ).toHaveLength(0);
          expect(
            yield* sql`select 1 from assistant_message_source_uses where run_id = ${runId}::uuid`,
          ).toHaveLength(0);
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
            }),
          );
        }),
      );
    }
  });
});
