import { createHash } from "node:crypto";
import { PgClient } from "@effect/sql-pg";
import { Effect, Redacted } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "./migrate";

const isBun = typeof process.versions.bun === "string";
const databaseUrl = process.env.WORKER_POSTGRES_TEST_DATABASE_URL;
const migrationsUrl = new URL("../../../../db/migrations/", import.meta.url);
const isolatedDatabaseName = `brief_migrations_test_${process.pid}_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;

type RelationRow = {
  client_companies: string | null;
  client_company_memberships: string | null;
  client_company_ai_settings: string | null;
  chats: string | null;
  chat_messages: string | null;
  ai_runs: string | null;
  ai_run_events: string | null;
  ai_smithers_orphan_candidates: string | null;
  chat_context_blocks: string | null;
  ai_observations: string | null;
  ai_source_exposures: string | null;
  ai_run_usage: string | null;
  ai_external_tool_usage: string | null;
  assistant_message_sources: string | null;
  assistant_message_source_uses: string | null;
  user_memories: string | null;
  user_memory_revisions: string | null;
};

type RegconfigRow = {
  fr: string;
  fr_full: string;
  en: string;
  en_full: string;
  de: string;
  de_full: string;
};

type NamedRow = {
  name: string;
};

type CountRow = {
  count: number;
};

type IndexRow = {
  indexname: string;
};

type ColumnRow = {
  column_name: string;
};

type DocumentRow = {
  document_id: string;
};

type ConstraintRow = {
  confdeltype: string;
};

type RevisionRow = {
  run_id: string | null;
};

type ChatRow = {
  id: string;
  companyId: string;
};

function sourceDatabaseUrl(): string {
  if (!databaseUrl) {
    throw new Error("WORKER_POSTGRES_TEST_DATABASE_URL is required");
  }

  return databaseUrl;
}

function adminDatabaseUrl(): string {
  const url = new URL(sourceDatabaseUrl());
  url.pathname = "/postgres";
  return url.toString();
}

function isolatedDatabaseUrl(): string {
  return databaseUrlForName(isolatedDatabaseName);
}

function databaseUrlForName(databaseName: string): string {
  const url = new URL(sourceDatabaseUrl());
  url.pathname = `/${databaseName}`;

  return url.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function runDb<A, E>(url: string, effect: Effect.Effect<A, E, PgClient.PgClient>): Promise<A> {
  return Effect.runPromise(
    effect.pipe(
      Effect.provide(
        PgClient.layer({
          url: Redacted.make(url),
          applicationName: "brief-worker-migrations-test",
        }),
      ),
    ),
  );
}

function runDbAs<A, E>(
  url: string,
  applicationName: string,
  effect: Effect.Effect<A, E, PgClient.PgClient>,
): Promise<A> {
  return Effect.runPromise(
    effect.pipe(
      Effect.provide(
        PgClient.layer({
          url: Redacted.make(url),
          applicationName,
        }),
      ),
    ),
  );
}

const provisionClientUser = (userId: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const companyId = crypto.randomUUID();
    yield* sql`
      insert into client_companies (id, name)
      values (${companyId}, 'Migration test company')
    `;
    yield* sql`
      insert into client_company_memberships (company_id, user_id, role)
      values (${companyId}, ${userId}, 'admin')
    `;
    yield* sql`
      insert into client_company_ai_settings (company_id)
      values (${companyId})
    `;
    return companyId;
  });

const testAcceptanceScope = (args: {
  readonly userId: string;
  readonly chatId: string;
  readonly companyId: string;
  readonly memoryMode?: "private_owner" | "disabled";
}) => ({
  userId: args.userId,
  chatId: args.chatId,
  companyId: args.companyId,
  subscriptionIds: [],
  accessIds: [],
  publicSourceIds: [],
  memoryMode: args.memoryMode ?? "disabled",
  memoryRevisionIds: [],
  webRequested: false,
  webEnabled: false,
  provider: "zai_coding_plan_official",
  fastModelId: "glm-5-turbo",
  mainModelId: "glm-5-turbo",
  webTransportProvider: null,
  allowedDomains: null,
});

function applyMigrationsThrough(lastMigration: string) {
  return Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const files = [...new Bun.Glob("*.sql").scanSync({ cwd: migrationsUrl.pathname })]
      .sort()
      .filter((file) => file <= lastMigration);

    yield* sql`
      create table if not exists schema_migrations (
        name text primary key,
        applied_at timestamptz not null default now()
      )
    `;

    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`select pg_advisory_xact_lock(hashtext('brief:schema_migrations'))`;

        for (const file of files) {
          const body = yield* Effect.promise(() => Bun.file(new URL(file, migrationsUrl)).text());
          yield* sql.unsafe(body).raw;
          yield* sql`
            insert into schema_migrations (name)
            values (${file})
          `;
        }
      }),
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function causeOf(value: unknown): unknown {
  return isRecord(value) ? (value as { cause?: unknown }).cause : undefined;
}

function messageOf(value: unknown): string | undefined {
  const message = isRecord(value) ? value.message : undefined;

  return typeof message === "string" ? message : undefined;
}

function errorText(error: unknown): string {
  const parts = [String(error)];
  const cause = causeOf(error);

  if (cause !== undefined) {
    parts.push(String(cause));

    const causeMessage = messageOf(cause);

    if (causeMessage) {
      parts.push(causeMessage);
    }

    const nestedCause = causeOf(cause);

    if (nestedCause !== undefined) {
      parts.push(String(nestedCause));

      const nestedCauseMessage = messageOf(nestedCause);

      if (nestedCauseMessage) {
        parts.push(nestedCauseMessage);
      }
    }
  }

  return parts.join("\n");
}

describe.skipIf(!isBun || !databaseUrl)("ai chat runtime migrations", () => {
  beforeAll(async () => {
    const sourceUrl = adminDatabaseUrl();
    const testUrl = isolatedDatabaseUrl();

    await runDb(
      sourceUrl,
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const existing = yield* sql<NamedRow>`
          select datname as name
          from pg_database
          where datname = ${isolatedDatabaseName}
        `;

        if (existing.length === 0) {
          yield* sql.unsafe(`create database ${quoteIdentifier(isolatedDatabaseName)}`);
        }
      }),
    );

    await runDb(
      testUrl,
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;

        yield* sql.unsafe("drop schema if exists public cascade");
        yield* sql.unsafe("create schema public");
      }),
    );

    await runDb(testUrl, runMigrations);
  }, 60_000);

  afterAll(async () => {
    await runDb(
      adminDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          select pg_terminate_backend(pid)
          from pg_stat_activity
          where datname = ${isolatedDatabaseName}
            and pid <> pg_backend_pid()
        `;
        yield* sql.unsafe(`drop database if exists ${quoteIdentifier(isolatedDatabaseName)}`);
      }),
    );
  }, 60_000);

  it(
    "applies every migration from scratch and re-applies idempotently",
    { timeout: 60_000 },
    async () => {
      const testUrl = isolatedDatabaseUrl();
      const expectedMigrations = [
        ...new Bun.Glob("*.sql").scanSync({ cwd: migrationsUrl.pathname }),
      ].sort();
      const result = await runDb(
        testUrl,
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const [relations] = yield* sql<RelationRow>`
            select
              to_regclass('public.client_companies')::text as client_companies,
              to_regclass('public.client_company_memberships')::text as client_company_memberships,
              to_regclass('public.client_company_ai_settings')::text as client_company_ai_settings,
              to_regclass('public.chats')::text as chats,
              to_regclass('public.chat_messages')::text as chat_messages,
              to_regclass('public.ai_runs')::text as ai_runs,
              to_regclass('public.ai_run_events')::text as ai_run_events,
              to_regclass('public.ai_smithers_orphan_candidates')::text as ai_smithers_orphan_candidates,
              to_regclass('public.chat_context_blocks')::text as chat_context_blocks,
              to_regclass('public.ai_observations')::text as ai_observations,
              to_regclass('public.ai_source_exposures')::text as ai_source_exposures,
              to_regclass('public.ai_run_usage')::text as ai_run_usage,
              to_regclass('public.ai_external_tool_usage')::text as ai_external_tool_usage,
              to_regclass('public.assistant_message_sources')::text as assistant_message_sources,
              to_regclass('public.assistant_message_source_uses')::text as assistant_message_source_uses,
              to_regclass('public.user_memories')::text as user_memories,
              to_regclass('public.user_memory_revisions')::text as user_memory_revisions
          `;
          const [extension] = yield* sql<CountRow>`
            select count(*)::int as count
            from pg_extension
            where extname = 'pg_trgm'
          `;
          const indexes = yield* sql<IndexRow>`
            select indexname
            from pg_indexes
            where tablename = 'public_source_documents'
            order by indexname
          `;
          const chatIndexes = yield* sql<IndexRow>`
            select indexname
            from pg_indexes
            where schemaname = 'public' and tablename = 'chats'
            order by indexname
          `;
          const searchVectorColumns = yield* sql<ColumnRow>`
            select column_name
            from information_schema.columns
            where table_schema = 'public'
              and table_name = 'public_source_documents'
              and column_name = 'search_vector'
          `;
          const initialMemoryEvidenceColumns = yield* sql<ColumnRow>`
            select column_name
            from information_schema.columns
            where table_schema = 'public'
              and table_name = 'user_memories'
              and column_name = 'evidence_quote'
          `;
          const migrationsBefore = yield* sql<NamedRow>`
            select name
            from schema_migrations
            order by name
          `;

          yield* runMigrations;

          const memoryEvidenceColumnsAfter = yield* sql<ColumnRow>`
            select column_name
            from information_schema.columns
            where table_schema = 'public'
              and table_name = 'user_memories'
              and column_name = 'evidence_quote'
          `;

          const migrationsAfter = yield* sql<NamedRow>`
            select name
            from schema_migrations
            order by name
          `;

          return {
            relations,
            extensionCount: extension?.count,
            indexNames: indexes.map((index) => index.indexname),
            chatIndexNames: chatIndexes.map((index) => index.indexname),
            searchVectorColumnCount: searchVectorColumns.length,
            initialMemoryEvidenceColumnCount: initialMemoryEvidenceColumns.length,
            memoryEvidenceColumnCountAfter: memoryEvidenceColumnsAfter.length,
            migrationsBefore: migrationsBefore.map((migration) => migration.name),
            migrationsAfter: migrationsAfter.map((migration) => migration.name),
          };
        }),
      );

      expect(result.relations).toBeDefined();

      if (!result.relations) {
        throw new Error("missing relation assertion row");
      }

      expect(result.relations.chat_context_blocks).toBeNull();
      expect(
        Object.entries(result.relations)
          .filter(([name]) => name !== "chat_context_blocks")
          .every(([, relation]) => relation !== null),
      ).toBe(true);
      expect(result.extensionCount).toBe(1);
      expect(result.indexNames).toContain("public_source_documents_search_vector_idx");
      expect(result.indexNames).toContain("public_source_documents_title_trgm_idx");
      expect(result.chatIndexNames).toContain("chats_user_idx");
      expect(result.chatIndexNames).not.toContain("chats_user_key");
      expect(result.searchVectorColumnCount).toBe(1);
      expect(result.initialMemoryEvidenceColumnCount).toBe(0);
      expect(result.memoryEvidenceColumnCountAfter).toBe(0);
      expect(result.migrationsBefore).toEqual(expectedMigrations);
      expect(result.migrationsBefore).toContain("0008_ai_chat_runtime.sql");
      expect(result.migrationsBefore).toContain("0009_document_search.sql");
      expect(result.migrationsBefore).toContain("0010_user_memory_revision_run_set_null.sql");
      expect(result.migrationsBefore).toContain("0014_simplify_user_memories.sql");
      expect(result.migrationsBefore).toContain("0015_canonical_ai_runtime_product_state.sql");
      expect(result.migrationsAfter).toEqual(expectedMigrations);
    },
  );

  it("executes the final AI chat cutover body twice on the same clean schema", async () => {
    const body = await Bun.file(
      new URL("../../../../db/migrations/0064_ai_chat_runtime_cutover.sql", import.meta.url),
    ).text();
    const result = await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql.unsafe(body).raw;
        yield* sql.unsafe(body).raw;
        return yield* sql<{ readonly count: number }>`
          select count(*)::int as count
          from pg_constraint constraints
          join pg_class relations on relations.oid = constraints.conrelid
          where constraints.connamespace = 'public'::regnamespace
            and not constraints.convalidated
            and relations.relname in (
              'ai_runs',
              'ai_observations',
              'ai_run_usage',
              'ai_source_exposures',
              'assistant_message_sources',
              'assistant_message_source_uses',
              'brief_document_versions',
              'public_source_documents'
            )
        `;
      }),
    );
    expect(result[0]?.count).toBe(0);
  }, 60_000);

  it("freezes only proven delivery recipients and rejects later changes", async () => {
    const result = await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const suffix = crypto.randomUUID();
        const publisherCompanyId = crypto.randomUUID();
        const subscriptionId = crypto.randomUUID();
        const clientCompanyId = crypto.randomUUID();
        const issueId = crypto.randomUUID();
        const accessId = crypto.randomUUID();
        const deliveryAt = new Date(Date.now() - 60_000);
        const validUserId = `delivery-valid-${suffix}`;
        const neverEntitledUserId = `delivery-never-${suffix}`;
        const futureGrantUserId = `delivery-future-${suffix}`;
        const revokedBeforeUserId = `delivery-revoked-before-${suffix}`;
        const revokedAfterUserId = `delivery-revoked-after-${suffix}`;
        const allUsers = [
          validUserId,
          neverEntitledUserId,
          futureGrantUserId,
          revokedBeforeUserId,
          revokedAfterUserId,
        ];

        yield* sql`
          insert into publisher_companies (id, name)
          values (${publisherCompanyId}, ${`Delivery publisher ${suffix}`})
        `;
        yield* sql`
          insert into publisher_subscriptions (id, publisher_company_id, name, created_by_user_id)
          values (${subscriptionId}, ${publisherCompanyId}, 'Delivery subscription', 'delivery-publisher')
        `;
        yield* sql`
          insert into client_companies (id, name)
          values (${clientCompanyId}, ${`Delivery client ${suffix}`})
        `;
        for (const userId of allUsers) {
          yield* sql`
            insert into client_company_memberships (
              company_id, user_id, role, created_at
            ) values (
              ${clientCompanyId}, ${userId}, 'member', ${new Date(deliveryAt.getTime() - 3_600_000)}
            )
          `;
        }
        yield* sql`
          insert into client_subscription_accesses (
            id, subscription_id, client_company_id, state, first_admin_email,
            accepted_at, subscribed_at, created_by_user_id
          ) values (
            ${accessId}, ${subscriptionId}, ${clientCompanyId}, 'active', 'delivery@example.test',
            ${new Date(deliveryAt.getTime() - 7_200_000)},
            ${new Date(deliveryAt.getTime() - 7_200_000)},
            'delivery-publisher'
          )
        `;
        yield* sql`
          insert into publisher_issues (
            id, subscription_id, title, status, publication_at, published_at, created_by_user_id
          ) values (
            ${issueId}, ${subscriptionId}, 'Delivery issue', 'published',
            ${new Date(deliveryAt.getTime() - 7_200_000)},
            ${new Date(deliveryAt.getTime() - 3_600_000)},
            'delivery-publisher'
          )
        `;
        yield* sql`
          insert into issue_deliveries (
            id, issue_id, subscription_id, access_id, client_company_id,
            delivered_at, historical
          ) values (
            ${crypto.randomUUID()}, ${issueId}, ${subscriptionId}, ${accessId},
            ${clientCompanyId}, ${deliveryAt}, false
          )
        `;
        yield* sql`
          insert into client_employee_subscription_grants (
            access_id, client_company_id, user_id, granted_by_user_id, granted_at
          ) values (
            ${accessId}, ${clientCompanyId}, ${validUserId}, 'delivery-publisher',
            ${new Date(deliveryAt.getTime() - 1_800_000)}
          )
        `;
        yield* sql`
          insert into client_employee_subscription_grants (
            access_id, client_company_id, user_id, granted_by_user_id, granted_at
          ) values (
            ${accessId}, ${clientCompanyId}, ${futureGrantUserId}, 'delivery-publisher',
            ${new Date(deliveryAt.getTime() + 1_800_000)}
          )
        `;
        yield* sql`
          insert into client_employee_subscription_grants (
            access_id, client_company_id, user_id, granted_by_user_id,
            granted_at, revoked_at, revoked_by_user_id
          ) values (
            ${accessId}, ${clientCompanyId}, ${revokedBeforeUserId}, 'delivery-publisher',
            ${new Date(deliveryAt.getTime() - 1_800_000)},
            ${new Date(deliveryAt.getTime() - 600_000)}, 'delivery-publisher'
          )
        `;
        yield* sql`
          insert into client_employee_subscription_grants (
            access_id, client_company_id, user_id, granted_by_user_id,
            granted_at, revoked_at, revoked_by_user_id
          ) values (
            ${accessId}, ${clientCompanyId}, ${revokedAfterUserId}, 'delivery-publisher',
            ${new Date(deliveryAt.getTime() - 1_800_000)},
            ${new Date(deliveryAt.getTime() + 1_800_000)}, 'delivery-publisher'
          )
        `;

        yield* sql`
          insert into issue_delivery_recipients (
            issue_id, client_company_id, user_id, delivered_at
          ) values (${issueId}, ${clientCompanyId}, ${validUserId}, ${deliveryAt})
        `;
        yield* sql`
          insert into issue_delivery_recipients (
            issue_id, client_company_id, user_id, delivered_at
          ) values (${issueId}, ${clientCompanyId}, ${revokedAfterUserId}, ${deliveryAt})
        `;
        const neverEntitled = yield* Effect.flip(sql`
          insert into issue_delivery_recipients (
            issue_id, client_company_id, user_id, delivered_at
          ) values (${issueId}, ${clientCompanyId}, ${neverEntitledUserId}, ${deliveryAt})
        `);
        const futureGrant = yield* Effect.flip(sql`
          insert into issue_delivery_recipients (
            issue_id, client_company_id, user_id, delivered_at
          ) values (${issueId}, ${clientCompanyId}, ${futureGrantUserId}, ${deliveryAt})
        `);
        const revokedBefore = yield* Effect.flip(sql`
          insert into issue_delivery_recipients (
            issue_id, client_company_id, user_id, delivered_at
          ) values (${issueId}, ${clientCompanyId}, ${revokedBeforeUserId}, ${deliveryAt})
        `);
        const wrongTimestamp = yield* Effect.flip(sql`
          insert into issue_delivery_recipients (
            issue_id, client_company_id, user_id, delivered_at
          ) values (
            ${issueId}, ${clientCompanyId}, ${validUserId}, ${new Date(deliveryAt.getTime() + 1_000)}
          )
        `);
        const updateFailure = yield* Effect.flip(sql`
          update issue_delivery_recipients
          set delivered_at = ${new Date(deliveryAt.getTime() + 1_000)}
          where issue_id = ${issueId}
            and client_company_id = ${clientCompanyId}
            and user_id = ${validUserId}
        `);
        const deleteFailure = yield* Effect.flip(sql`
          delete from issue_delivery_recipients
          where issue_id = ${issueId}
            and client_company_id = ${clientCompanyId}
            and user_id = ${validUserId}
        `);
        const recipients = yield* sql<{ readonly userId: string }>`
          select user_id as "userId"
          from issue_delivery_recipients
          where issue_id = ${issueId}
          order by user_id
        `;
        return {
          neverEntitled,
          futureGrant,
          revokedBefore,
          wrongTimestamp,
          updateFailure,
          deleteFailure,
          validUserId,
          revokedAfterUserId,
          recipients: recipients.map((row) => row.userId),
        };
      }),
    );

    for (const failure of [
      result.neverEntitled,
      result.futureGrant,
      result.revokedBefore,
      result.wrongTimestamp,
      result.updateFailure,
      result.deleteFailure,
    ]) {
      expect(errorText(failure)).toMatch(/delivery|immutable|entitled/i);
    }
    expect(result.recipients).toEqual([result.revokedAfterUserId, result.validUserId].sort());
  });

  it("stores one strict immutable acceptance scope and never reauthorizes run updates", async () => {
    const userId = `scope-contract-${crypto.randomUUID()}`;
    const companyId = await runDb(isolatedDatabaseUrl(), provisionClientUser(userId));
    const chatId = crypto.randomUUID();
    const messageId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const otherChatId = crypto.randomUUID();
    const scope = testAcceptanceScope({ userId, chatId, companyId });

    const result = await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          insert into chats (id, company_id, user_id, memory_mode)
          values
            (${chatId}, ${companyId}, ${userId}, 'disabled'),
            (${otherChatId}, ${companyId}, ${userId}, 'disabled')
        `;
        yield* sql`
          insert into chat_messages (id, chat_id, author, content)
          values (${messageId}, ${chatId}, 'user', 'scope contract')
        `;
        const malformed = yield* Effect.all([
          Effect.exit(sql`
            insert into ai_runs (id, chat_id, user_message_id, locale, market, acceptance_scope)
            values (
              ${crypto.randomUUID()}, ${chatId}, ${messageId}, 'en-US', 'US',
              ${sql.json({ ...scope, unknown: true })}
            )
          `),
          Effect.exit(sql`
            insert into ai_runs (id, chat_id, user_message_id, locale, market, acceptance_scope)
            values (
              ${crypto.randomUUID()}, ${chatId}, ${messageId}, 'en-US', 'US',
              ${sql.json({ ...scope, webTransportProvider: "none" })}
            )
          `),
          Effect.exit(sql`
            insert into ai_runs (id, chat_id, user_message_id, locale, market, acceptance_scope)
            values (
              ${crypto.randomUUID()}, ${chatId}, ${messageId}, 'en-US', 'US',
              ${sql.json({ ...scope, accessIds: [1] })}
            )
          `),
        ]);
        yield* sql`
          insert into ai_runs (id, chat_id, user_message_id, locale, market, acceptance_scope)
          values (${runId}, ${chatId}, ${messageId}, 'en-US', 'US', ${sql.json(scope)})
        `;
        yield* sql`
          update client_company_ai_settings
          set web_search_enabled = true, web_domain_allowlist = array['changed.example']::text[]
          where company_id = ${companyId}
        `;
        const lifecycleUpdate = yield* Effect.exit(
          sql`update ai_runs set started_at = now() where id = ${runId}`,
        );
        const scopeUpdate = yield* Effect.exit(
          sql`update ai_runs set acceptance_scope = ${sql.json({ ...scope, webRequested: true })} where id = ${runId}`,
        );
        const bindingUpdate = yield* Effect.exit(
          sql`update ai_runs set chat_id = ${otherChatId} where id = ${runId}`,
        );
        const columns = yield* sql<{ readonly name: string }>`
          select column_name as name
          from information_schema.columns
          where table_schema = 'public' and table_name = 'ai_runs'
            and column_name in ('web_search_enabled', 'effective_web_policy')
        `;
        return { malformed, lifecycleUpdate, scopeUpdate, bindingUpdate, columns };
      }),
    );

    expect(result.malformed.every((exit) => exit._tag === "Failure")).toBe(true);
    expect(result.lifecycleUpdate._tag).toBe("Success");
    expect(result.scopeUpdate._tag).toBe("Failure");
    expect(result.bindingUpdate._tag).toBe("Failure");
    expect(result.columns).toEqual([]);
  });

  it("requires the exact mounted selector manifest set for single and fanout routes", async () => {
    const migration = await Bun.file(
      new URL("../../../../db/migrations/0064_ai_chat_runtime_cutover.sql", import.meta.url),
    ).text();
    const firstCatalogWrite = migration.indexOf("create or replace function");
    expect(firstCatalogWrite).toBeGreaterThan(0);
    const preflight = migration.slice(0, firstCatalogWrite);
    for (const [owner, role] of [
      ["single-retrieve-internal", "internal"],
      ["single-select-memories", "memory"],
      ["single-retrieve-web", "web"],
      ["topic-t1-retrieve-internal", "internal"],
      ["topic-t1-select-memories", "memory"],
      ["topic-t1-retrieve-web", "web"],
      ["topic-t2-retrieve-internal", "internal"],
      ["topic-t2-select-memories", "memory"],
      ["topic-t2-retrieve-web", "web"],
      ["topic-t3-retrieve-internal", "internal"],
      ["topic-t3-select-memories", "memory"],
      ["topic-t3-retrieve-web", "web"],
    ] as const) {
      expect(preflight).toContain(`'${owner}'`);
      expect(preflight).toContain(`'${role}'`);
    }
    for (const blocker of [
      "successful run is missing terminal retrieval manifest",
      "successful run has duplicate terminal retrieval manifest",
      "retrieval manifest owner is outside selected route",
      "retrieval manifest selector role does not match its owner",
      "answer source use is not bound to its exact selector manifest",
      "terminal selector reference lacks its exact selector-owned exposure and provider proof coordinate",
      "memory write is not bound to its immediate prior revision and current live head",
      "terminal request usage is not ordered after run_started and before usage:run",
      "failed terminal error event is not last",
      "successful run terminal events are incomplete",
    ]) {
      expect(preflight).toContain(blocker);
    }
    expect(preflight).toContain("noCallReason");
    expect(preflight).toContain("mode' = 'fanout'");
    expect(preflight).toContain("candidate_rejected");
    expect(preflight).toContain("single-assemble");
    expect(preflight).toContain("then substring(manifests.emitting_task from '^topic-t[123]')");
    expect(preflight).toContain("retry_measurements");
    expect(preflight).toContain("exposures.document_ranges is not distinct from uses.ranges");
    expect(preflight).toContain("source-use union does not equal its locator union");
    expect(preflight).toContain("exposures.task_id = manifests.emitting_task");
  });

  it(
    "requires failed runs to retain one ordered usage and error terminal pair before cutover writes",
    { timeout: 120_000 },
    async () => {
      const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
      const databaseName = `brief_migrations_failed_ledger_${process.pid}_${suffix}`;
      const databaseUrl = databaseUrlForName(databaseName);
      const ids = {
        user: `failed-ledger-user-${suffix}`,
        company: crypto.randomUUID(),
        chat: crypto.randomUUID(),
        userMessage: crypto.randomUUID(),
        run: crypto.randomUUID(),
        assistantMessage: crypto.randomUUID(),
      };
      const nonce = Buffer.from(`failed-${suffix}`).subarray(0, 16);
      const migration = await Bun.file(
        new URL("../../../../db/migrations/0064_ai_chat_runtime_cutover.sql", import.meta.url),
      ).text();

      try {
        await runDb(
          adminDatabaseUrl(),
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql.unsafe(`create database ${quoteIdentifier(databaseName)}`);
          }),
        );
        await runDb(
          databaseUrl,
          applyMigrationsThrough("0063_immutable_document_exposure_evidence.sql"),
        );
        await runDb(
          databaseUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
              insert into platform_users (id, primary_email, display_name, clerk_user_id)
              values (${ids.user}, ${`${ids.user}@example.test`}, 'Failed ledger user', ${`clerk-${ids.user}`})
            `;
            yield* sql`
              insert into client_companies (id, name) values (${ids.company}, 'Failed ledger company')
            `;
            yield* sql`
              insert into client_company_memberships (company_id, user_id, role)
              values (${ids.company}, ${ids.user}, 'admin')
            `;
            yield* sql`
              insert into chats (id, user_id, company_id, memory_mode)
              values (${ids.chat}, ${ids.user}, ${ids.company}, 'disabled')
            `;
            yield* sql`
              insert into chat_messages (id, chat_id, author, content)
              values (${ids.userMessage}, ${ids.chat}, 'user', 'Failed ledger fixture')
            `;
            yield* sql`
              insert into ai_runs (
                id, chat_id, initiating_user_id, user_message_id, locale, market,
                citation_nonce, effective_web_policy, failed_at, error_code, retryable
              ) values (
                ${ids.run}, ${ids.chat}, ${ids.user}, ${ids.userMessage}, 'en-US', 'US',
                decode(${nonce.toString("base64")}, 'base64'),
                ${sql.json({ enabled: false, reason: "company_disabled", allowlistActive: false })},
                now(), 'failed_fixture', true
              )
            `;
            yield* sql`
              insert into ai_run_events (run_id, seq, event, emitted_by_task, emission_key)
              values
                (${ids.run}, 1, ${sql.json({ type: "run_started" })}, null, 'run_started'),
                (${ids.run}, 2, ${sql.json({
                  type: "usage",
                  scope: "run",
                  model: {
                    inputTokens: 0,
                    outputTokens: 0,
                    cachedTokens: 0,
                    reasoningTokens: 0,
                    totalTokens: 0,
                    requestCount: 0,
                  },
                  web: { searchCount: 0, fetchCount: 0, responseBytes: 0, billedUnits: 0 },
                })}, 'failure-handler', 'usage:run')
            `;
          }),
        );

        const missingError = await runDb(
          databaseUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            return yield* Effect.exit(sql.unsafe(migration).raw);
          }),
        );
        expect(missingError._tag).toBe("Failure");
        expect(errorText(missingError)).toContain(`ai_runs/${ids.run}`);
        expect(errorText(missingError)).toContain("failed terminal event ledger is incomplete");
        const unchanged = await runDb(
          databaseUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            return yield* sql<{ readonly helpers: number; readonly finalColumn: number }>`
              select
                (select count(*)::int from pg_proc where pronamespace = 'public'::regnamespace and proname = 'brief_ai_safe_bigint') as helpers,
                (select count(*)::int from information_schema.columns where table_schema = 'public' and table_name = 'ai_runs' and column_name = 'citation_namespace') as "finalColumn"
            `;
          }),
        );
        expect(unchanged).toEqual([{ helpers: 0, finalColumn: 0 }]);

        await runDb(
          databaseUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
              insert into chat_messages (id, chat_id, author, content, assistant_ai_run_id)
              values (${ids.assistantMessage}, ${ids.chat}, 'assistant', 'failed draft', ${ids.run})
            `;
            yield* sql`update ai_runs set assistant_message_id = ${ids.assistantMessage} where id = ${ids.run}`;
            yield* sql`update ai_runs set assistant_message_id = null where id = ${ids.run}`;
            yield* sql`
              insert into ai_run_events (run_id, seq, event, emitted_by_task, emission_key)
              values (${ids.run}, 3, ${sql.json({ type: "error", code: "failed_fixture", retryable: true })}, 'failure-handler', 'terminal')
            `;
          }),
        );
        const failedDraftWithoutSource = await runDb(
          databaseUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            return yield* Effect.exit(sql.unsafe(migration).raw);
          }),
        );
        expect(failedDraftWithoutSource._tag).toBe("Failure");
        expect(errorText(failedDraftWithoutSource)).toContain(`ai_runs/${ids.run}`);
        expect(errorText(failedDraftWithoutSource)).toContain(
          "failed run retains an assistant message or source row",
        );
        const failedDraftWithoutSourceFence = await runDb(
          databaseUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            return yield* sql<{ readonly helpers: number; readonly finalColumn: number }>`
              select
                (select count(*)::int from pg_proc where pronamespace = 'public'::regnamespace and proname = 'brief_ai_safe_bigint') as helpers,
                (select count(*)::int from information_schema.columns where table_schema = 'public' and table_name = 'ai_runs' and column_name = 'citation_namespace') as "finalColumn"
            `;
          }),
        );
        expect(failedDraftWithoutSourceFence).toEqual([{ helpers: 0, finalColumn: 0 }]);
        const sourceKey = `k_${nonce.toString("base64url")}_1`;
        await runDb(
          databaseUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`update ai_runs set assistant_message_id = ${ids.assistantMessage} where id = ${ids.run}`;
            yield* sql`
              insert into assistant_message_sources (
                assistant_message_id, source_key, kind, locator, message_id,
                display_label, public_provenance
              ) values (
                ${ids.assistantMessage}, ${sourceKey}, 'chat_message',
                ${sql.json({ kind: "chat_message", messageId: ids.userMessage })},
                ${ids.userMessage}, 'failed source', '{}'::jsonb
              )
            `;
            yield* sql`
              insert into assistant_message_source_uses (
                assistant_message_id, source_key, consumer_task_id, topic_id,
                rendered_token_count, context_order, ranges
              ) values (
                ${ids.assistantMessage}, ${sourceKey}, 'single-answer', null,
                0, 0, '[]'::jsonb
              )
            `;
          }),
        );
        const failedDraft = await runDb(
          databaseUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            return yield* Effect.exit(sql.unsafe(migration).raw);
          }),
        );
        expect(failedDraft._tag).toBe("Failure");
        expect(errorText(failedDraft)).toContain(`ai_runs/${ids.run}`);
        expect(errorText(failedDraft)).toContain(
          "failed run retains an assistant message or source row",
        );
        const failedDraftUnchanged = await runDb(
          databaseUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            return yield* sql<{ readonly helpers: number; readonly finalColumn: number }>`
              select
                (select count(*)::int from pg_proc where pronamespace = 'public'::regnamespace and proname = 'brief_ai_safe_bigint') as helpers,
                (select count(*)::int from information_schema.columns where table_schema = 'public' and table_name = 'ai_runs' and column_name = 'citation_namespace') as "finalColumn"
            `;
          }),
        );
        expect(failedDraftUnchanged).toEqual([{ helpers: 0, finalColumn: 0 }]);
        await runDb(
          databaseUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`update ai_runs set assistant_message_id = null where id = ${ids.run}`;
            yield* sql`alter table assistant_message_source_uses disable trigger user`;
            yield* sql`delete from assistant_message_source_uses where assistant_message_id = ${ids.assistantMessage}`;
            yield* sql`alter table assistant_message_source_uses enable trigger user`;
            yield* sql`alter table assistant_message_sources disable trigger user`;
            yield* sql`delete from assistant_message_sources where assistant_message_id = ${ids.assistantMessage}`;
            yield* sql`alter table assistant_message_sources enable trigger user`;
            yield* sql`delete from chat_messages where id = ${ids.assistantMessage}`;
            yield* sql`delete from ai_run_events where run_id = ${ids.run} and emission_key = 'terminal'`;
          }),
        );

        await runDb(
          databaseUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
              insert into ai_run_events (run_id, seq, event, emitted_by_task, emission_key)
              values (${ids.run}, 3, ${sql.json({ type: "error", code: "failed_fixture", retryable: true })}, 'failure-handler', 'terminal')
            `;
            yield* sql`
              insert into ai_observations (
                run_id, chat_id, emitting_task, loop_iteration, attempt,
                observation_key, kind, payload
              ) values (
                ${ids.run}, ${ids.chat}, 'finalize', 0, 0,
                'finalize:0:0:memory_application:result', 'memory_application',
                ${sql.json({
                  extractionTaskId: "memory-extract",
                  extractionLoopIteration: 0,
                  extractionAttempt: 0,
                  extractionObservationKey: "memory-extract:0:0:memory_extraction_result:result",
                  extractionSha256Hex: "a".repeat(64),
                  proposalCount: 0,
                  discardedCount: 0,
                })}
              )
            `;
          }),
        );
        const fatalMemoryArtifact = await runDb(
          databaseUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            return yield* Effect.exit(sql.unsafe(migration).raw);
          }),
        );
        expect(fatalMemoryArtifact._tag).toBe("Failure");
        expect(errorText(fatalMemoryArtifact)).toContain(`ai_runs/${ids.run}`);
        expect(errorText(fatalMemoryArtifact)).toContain(
          "failed terminal event ledger is incomplete",
        );
        const stillUnchanged = await runDb(
          databaseUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            return yield* sql<{ readonly helpers: number; readonly finalColumn: number }>`
              select
                (select count(*)::int from pg_proc where pronamespace = 'public'::regnamespace and proname = 'brief_ai_safe_bigint') as helpers,
                (select count(*)::int from information_schema.columns where table_schema = 'public' and table_name = 'ai_runs' and column_name = 'citation_namespace') as "finalColumn"
            `;
          }),
        );
        expect(stillUnchanged).toEqual([{ helpers: 0, finalColumn: 0 }]);
        await runDb(
          databaseUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
              insert into ai_observations (
                run_id, chat_id, emitting_task, loop_iteration, attempt,
                observation_key, kind, payload
              ) values (
                ${ids.run}, ${ids.chat}, 'memory-extract', 0, 0,
                'memory-extract:0:0:memory_extraction_result:fatal', 'memory_extraction_result',
                ${sql.json({ proposalCount: 0, discardedCount: 0, extractionSha256Hex: "c".repeat(64) })}
              )
            `;
          }),
        );
        const fatalExtractionArtifact = await runDb(
          databaseUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            return yield* Effect.exit(sql.unsafe(migration).raw);
          }),
        );
        expect(fatalExtractionArtifact._tag).toBe("Failure");
        expect(errorText(fatalExtractionArtifact)).toContain(`ai_runs/${ids.run}`);
        expect(errorText(fatalExtractionArtifact)).toContain(
          "failed terminal event ledger is incomplete",
        );
        const extractionUnchanged = await runDb(
          databaseUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            return yield* sql<{ readonly helpers: number; readonly finalColumn: number }>`
              select
                (select count(*)::int from pg_proc where pronamespace = 'public'::regnamespace and proname = 'brief_ai_safe_bigint') as helpers,
                (select count(*)::int from information_schema.columns where table_schema = 'public' and table_name = 'ai_runs' and column_name = 'citation_namespace') as "finalColumn"
            `;
          }),
        );
        expect(extractionUnchanged).toEqual([{ helpers: 0, finalColumn: 0 }]);
        await runDb(
          databaseUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`delete from ai_observations where run_id = ${ids.run} and kind in ('memory_application', 'memory_extraction_result')`;
            yield* sql`delete from ai_run_events where run_id = ${ids.run}`;
            yield* sql`
              insert into ai_observations (
                run_id, chat_id, emitting_task, loop_iteration, attempt,
                observation_key, kind, payload
              ) values
                (
                  ${ids.run}, ${ids.chat}, 'memory-extract', 0, 0,
                  'memory-extract:0:0:memory_extraction_result:result', 'memory_extraction_result',
                  ${sql.json({ proposalCount: 0, discardedCount: 0, extractionSha256Hex: "b".repeat(64) })}
                ), (
                  ${ids.run}, ${ids.chat}, 'finalize', 0, 0,
                  'finalize:0:0:memory_application:result', 'memory_application',
                  ${sql.json({
                    extractionTaskId: "memory-extract",
                    extractionLoopIteration: 0,
                    extractionAttempt: 0,
                    extractionObservationKey: "memory-extract:0:0:memory_extraction_result:result",
                    extractionSha256Hex: "b".repeat(64),
                    proposalCount: 0,
                    discardedCount: 0,
                  })}
                )
            `;
            yield* sql`
              insert into ai_run_events (run_id, seq, event, emitted_by_task, emission_key)
              values
                (${ids.run}, 1, ${sql.json({ type: "run_started" })}, null, 'run_started'),
                (${ids.run}, 2, ${sql.json({ type: "memory_updated", created: 1, updated: 0, discarded: 0 })}, 'finalize', 'memory_updated'),
                (${ids.run}, 3, ${sql.json({
                  type: "usage",
                  scope: "run",
                  model: {
                    inputTokens: 1,
                    outputTokens: 1,
                    cachedTokens: 0,
                    reasoningTokens: 0,
                    totalTokens: 2,
                    requestCount: 1,
                  },
                  web: { searchCount: 0, fetchCount: 0, responseBytes: 0, billedUnits: 0 },
                })}, 'finalize', 'usage:run'),
                (${ids.run}, 4, ${sql.json({ type: "error", code: "failed_fixture", retryable: true })}, 'finalize', 'terminal')
            `;
          }),
        );
        const controlledMismatch = await runDb(
          databaseUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            return yield* Effect.exit(sql.unsafe(migration).raw);
          }),
        );
        expect(controlledMismatch._tag).toBe("Failure");
        expect(errorText(controlledMismatch)).toContain(`ai_runs/${ids.run}`);
        expect(errorText(controlledMismatch)).toContain(
          "failed terminal event ledger is incomplete",
        );
        const controlledUnchanged = await runDb(
          databaseUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            return yield* sql<{ readonly helpers: number; readonly finalColumn: number }>`
              select
                (select count(*)::int from pg_proc where pronamespace = 'public'::regnamespace and proname = 'brief_ai_safe_bigint') as helpers,
                (select count(*)::int from information_schema.columns where table_schema = 'public' and table_name = 'ai_runs' and column_name = 'citation_namespace') as "finalColumn"
            `;
          }),
        );
        expect(controlledUnchanged).toEqual([{ helpers: 0, finalColumn: 0 }]);
        await runDb(
          databaseUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
              insert into ai_observations (
                run_id, chat_id, emitting_task, loop_iteration, attempt,
                observation_key, kind, payload
              ) values (
                ${ids.run}, ${ids.chat}, 'memory-extract', 0, 0,
                'provider_request_measurement:memory-extract:0:0:0',
                'provider_request_measurement',
                ${sql.json({
                  agentRole: "memory_extractor",
                  modelId: "glm-5-turbo",
                  requestSha256Hex: "d".repeat(64),
                  sourceExposureProofSha256Hexes: [],
                  providerRequestIndex: 0,
                  inputTokens: 1,
                  requestedOutputTokens: 1,
                  usableInputTokens: 1,
                  contextWindow: 100,
                  passed: true,
                })}
              )
            `;
            yield* sql`
              insert into ai_run_usage (
                run_id, task_id, loop_iteration, attempt, provider_request_index,
                agent_role, model_id, provider_service_id, input_tokens, output_tokens,
                cached_tokens, reasoning_tokens, total_tokens, stop_reason
              ) values (
                ${ids.run}, 'memory-extract', 0, 0, 0,
                'memory_extractor', 'glm-5-turbo', 'deterministic_test', 1, 1, 0, 0, 2, 'stop'
              )
            `;
            yield* sql`
              update ai_run_events
              set seq = seq + 100
              where run_id = ${ids.run}
            `;
            yield* sql`
              update ai_run_events
              set seq = case event->>'type'
                when 'run_started' then 1
                when 'memory_updated' then 3
                when 'usage' then 4
                when 'error' then 5
                else seq end,
                  event = case when event->>'type' = 'memory_updated'
                    then ${sql.json({ type: "memory_updated", created: 0, updated: 0, discarded: 0 })}
                    else event end
              where run_id = ${ids.run}
            `;
            yield* sql`
              insert into ai_run_events (run_id, seq, event, emitted_by_task, emission_key)
              values (${ids.run}, 6, ${sql.json({
                type: "usage",
                scope: "request",
                kind: "model",
                role: "memory_extractor",
                attempt: 0,
                inputTokens: 1,
                outputTokens: 1,
                cachedTokens: 0,
                reasoningTokens: 0,
                totalTokens: 2,
              })}, 'memory-extract', 'usage:request:model:memory-extract:0:0:0')
            `;
            const [failedModelRequest] = yield* sql<{ readonly id: string }>`
              select id::text as id
              from ai_run_events
              where run_id = ${ids.run}
                and emission_key = 'usage:request:model:memory-extract:0:0:0'
            `;
            const lateRequest = yield* Effect.exit(sql.unsafe(migration).raw);
            expect(errorText(lateRequest)).toContain(`ai_run_events/${failedModelRequest?.id}`);
            expect(errorText(lateRequest)).toContain(
              "terminal request usage is not ordered after run_started and before usage:run",
            );
            const lateRequestFence = yield* sql<{
              readonly helpers: number;
              readonly finalColumn: number;
            }>`
              select
                (select count(*)::int from pg_proc where pronamespace = 'public'::regnamespace and proname = 'brief_ai_safe_bigint') as helpers,
                (select count(*)::int from information_schema.columns where table_schema = 'public' and table_name = 'ai_runs' and column_name = 'citation_namespace') as "finalColumn"
            `;
            expect(lateRequestFence).toEqual([{ helpers: 0, finalColumn: 0 }]);
            yield* sql`
              update ai_run_events
              set seq = 0
              where id = ${failedModelRequest?.id}::bigint
            `;
            const earlyFailedRequest = yield* Effect.exit(sql.unsafe(migration).raw);
            expect(errorText(earlyFailedRequest)).toContain(
              `ai_run_events/${failedModelRequest?.id}`,
            );
            expect(errorText(earlyFailedRequest)).toContain(
              "terminal request usage is not ordered after run_started and before usage:run",
            );
            yield* sql`
              update ai_run_events
              set seq = 2
              where id = ${failedModelRequest?.id}::bigint
            `;
            yield* sql`
              insert into ai_external_tool_usage (
                run_id, task_id, loop_iteration, attempt, tool_request_index,
                provider_service_id, operation, status, result_count,
                response_bytes, billed_units, duration_ms
              ) values (
                ${ids.run}, 'single-retrieve-web', 0, 0, 0,
                'deterministic_test', 'web_search', 'ok', 1, 10, 0, 1
              )
            `;
            yield* sql`
              insert into ai_run_events (
                run_id, seq, event, emitted_by_task, emission_key
              ) values (
                ${ids.run}, 6, ${sql.json({
                  type: "usage",
                  scope: "request",
                  kind: "web_search",
                  attempt: 0,
                  status: "ok",
                  resultCount: 1,
                  responseBytes: 10,
                  billedUnits: 0,
                  durationMs: 1,
                })}, 'single-retrieve-web',
                'usage:request:web_search:single-retrieve-web:0:0:0'
              )
            `;
            const [failedExternalRequest] = yield* sql<{ readonly id: string }>`
              select id::text as id
              from ai_run_events
              where run_id = ${ids.run}
                and emission_key = 'usage:request:web_search:single-retrieve-web:0:0:0'
            `;
            const lateFailedExternal = yield* Effect.exit(sql.unsafe(migration).raw);
            expect(errorText(lateFailedExternal)).toContain(
              `ai_run_events/${failedExternalRequest?.id}`,
            );
            expect(errorText(lateFailedExternal)).toContain(
              "terminal request usage is not ordered after run_started and before usage:run",
            );
            yield* sql`
              update ai_run_events
              set seq = 0
              where id = ${failedExternalRequest?.id}::bigint
            `;
            const earlyFailedExternal = yield* Effect.exit(sql.unsafe(migration).raw);
            expect(errorText(earlyFailedExternal)).toContain(
              `ai_run_events/${failedExternalRequest?.id}`,
            );
            expect(errorText(earlyFailedExternal)).toContain(
              "terminal request usage is not ordered after run_started and before usage:run",
            );
            yield* sql`
              update ai_run_events
              set seq = seq + 100
              where run_id = ${ids.run}
            `;
            yield* sql`
              update ai_run_events set seq = 1
              where run_id = ${ids.run} and event->>'type' = 'run_started'
            `;
            yield* sql`
              update ai_run_events set seq = 2
              where id = ${failedModelRequest?.id}::bigint
            `;
            yield* sql`
              update ai_run_events set seq = 3
              where id = ${failedExternalRequest?.id}::bigint
            `;
            yield* sql`
              update ai_run_events set seq = 4
              where run_id = ${ids.run} and event->>'type' = 'memory_updated'
            `;
            yield* sql`
              update ai_run_events
              set seq = 5,
                  event = jsonb_set(
                    jsonb_set(event, '{web,searchCount}', '1'::jsonb, true),
                    '{web,responseBytes}',
                    '10'::jsonb,
                    true
                  )
              where run_id = ${ids.run}
                and event->>'type' = 'usage'
                and event->>'scope' = 'run'
            `;
            yield* sql`
              update ai_run_events set seq = 6
              where run_id = ${ids.run}
                and event->>'type' = 'error'
            `;
            yield* sql.unsafe(migration).raw;
          }),
        );
        const final = await runDb(
          databaseUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            return yield* sql<{ readonly count: number }>`
              select count(*)::int as count
              from information_schema.columns
              where table_schema = 'public' and table_name = 'ai_runs' and column_name = 'citation_namespace'
            `;
          }),
        );
        expect(final[0]?.count).toBe(1);
      } finally {
        await runDb(
          adminDatabaseUrl(),
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`select pg_terminate_backend(pid) from pg_stat_activity where datname = ${databaseName}`;
            yield* sql.unsafe(`drop database if exists ${quoteIdentifier(databaseName)}`);
          }),
        );
      }
    },
  );

  it(
    "checks astral document sources and uses against the immutable UTF-16 text before cutover writes",
    { timeout: 120_000 },
    async () => {
      const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
      const databaseName = `brief_migrations_astral_ranges_${process.pid}_${suffix}`;
      const databaseUrl = databaseUrlForName(databaseName);
      const ids = {
        user: `astral-ranges-user-${suffix}`,
        company: crypto.randomUUID(),
        chat: crypto.randomUUID(),
        userMessage: crypto.randomUUID(),
        assistantMessage: crypto.randomUUID(),
        run: crypto.randomUUID(),
        publicSource: `astral-ranges-source-${suffix}`,
        publicDocument: `astral-ranges-document-${suffix}`,
        rawArtifact: crypto.randomUUID(),
      };
      const legacyNamespaceBytes = Buffer.from(`astral-${suffix}`).subarray(0, 16);
      const sourceKey = `k_${legacyNamespaceBytes.toString("base64url")}_1`;
      const publicUrl = "https://example.test/astral-ranges";
      const text = "A😀B".repeat(40);
      const utf16Length = text.length;
      const migration = await Bun.file(
        new URL("../../../../db/migrations/0064_ai_chat_runtime_cutover.sql", import.meta.url),
      ).text();

      try {
        await runDb(
          adminDatabaseUrl(),
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql.unsafe(`create database ${quoteIdentifier(databaseName)}`);
          }),
        );
        await runDb(
          databaseUrl,
          applyMigrationsThrough("0063_immutable_document_exposure_evidence.sql"),
        );
        await runDb(
          databaseUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
              insert into platform_users (id, primary_email, display_name, clerk_user_id)
              values (${ids.user}, ${`${ids.user}@example.test`}, 'Astral ranges user', ${`clerk-${ids.user}`})
            `;
            yield* sql`insert into client_companies (id, name) values (${ids.company}, 'Astral ranges company')`;
            yield* sql`
              insert into client_company_memberships (company_id, user_id, role)
              values (${ids.company}, ${ids.user}, 'admin')
            `;
            yield* sql`
              insert into chats (id, user_id, company_id, memory_mode)
              values (${ids.chat}, ${ids.user}, ${ids.company}, 'disabled')
            `;
            yield* sql`
              insert into chat_messages (id, chat_id, author, content)
              values (${ids.userMessage}, ${ids.chat}, 'user', 'Astral range fixture')
            `;
            yield* sql`
              insert into ai_runs (
                id, chat_id, initiating_user_id, user_message_id,
                locale, market, citation_nonce, effective_web_policy
              ) values (
                ${ids.run}, ${ids.chat}, ${ids.user}, ${ids.userMessage},
                'en-US', 'US', decode(${legacyNamespaceBytes.toString("base64")}, 'base64'),
                ${sql.json({ enabled: false, reason: "company_disabled", allowlistActive: false })}
              )
            `;
            yield* sql`
              insert into chat_messages (id, chat_id, author, content, assistant_ai_run_id)
              values (${ids.assistantMessage}, ${ids.chat}, 'assistant', 'Astral fixture', ${ids.run})
            `;
            yield* sql`update ai_runs set assistant_message_id = ${ids.assistantMessage} where id = ${ids.run}`;
            yield* sql`
              insert into ai_run_events (run_id, seq, event, emitted_by_task, emission_key)
              values
                (${ids.run}, 1, ${sql.json({ type: "run_started" })}, null, 'run_started'),
                (${ids.run}, 2, ${sql.json({
                  type: "usage",
                  scope: "run",
                  model: {
                    inputTokens: 0,
                    outputTokens: 0,
                    cachedTokens: 0,
                    reasoningTokens: 0,
                    totalTokens: 0,
                    requestCount: 0,
                  },
                  web: { searchCount: 0, fetchCount: 0, responseBytes: 0, billedUnits: 0 },
                })}, 'failure-handler', 'usage:run'),
                (${ids.run}, 3, ${sql.json({ type: "error", code: "astral_fixture", retryable: true })}, 'failure-handler', 'terminal')
            `;
            yield* sql`
              insert into public_sources (
                source_id, display_name, publisher_name, description,
                ingestion_method, discovery_url, average_chars_per_item
              ) values (
                ${ids.publicSource}, 'Astral source', 'Astral publisher',
                'Astral range fixture', 'rss', ${publicUrl}, 1000
              )
            `;
            yield* sql`
              insert into public_source_raw_artifacts (
                id, source_id, canonical_url, fetched_at, media_type, body, body_hash
              ) values (
                ${ids.rawArtifact}, ${ids.publicSource}, ${publicUrl}, now(), 'text/html',
                ${`<main>${text}</main>`},
                encode(digest(convert_to(${`<main>${text}</main>`}, 'UTF8'), 'sha256'), 'hex')
              )
            `;
            yield* sql`
              insert into public_source_documents (
                document_id, source_id, canonical_url, title, discovered_at, fetched_at,
                language, document_type, text, text_char_count, content_hash, raw_artifact_id
              ) values (
                ${ids.publicDocument}, ${ids.publicSource}, ${publicUrl}, 'Astral document',
                now(), now(), 'en', 'html', ${text}, ${utf16Length},
                encode(digest(convert_to(${text}, 'UTF8'), 'sha256'), 'hex'), ${ids.rawArtifact}
              )
            `;
            yield* sql`
              insert into assistant_message_sources (
                assistant_message_id, source_key, kind, locator,
                document_version_id, message_id, memory_revision_id,
                display_label, public_provenance
              ) values (
                ${ids.assistantMessage}, ${sourceKey}, 'document',
                ${sql.json({
                  kind: "document",
                  sourceId: `public:${ids.publicSource}`,
                  documentId: ids.publicDocument,
                  versionId: ids.publicDocument,
                  contentHash: createHash("sha256").update(text).digest("hex"),
                  ranges: [{ charStart: 0, charEnd: utf16Length + 1 }],
                })},
                ${ids.publicDocument}, null, null, 'Astral document',
                ${sql.json({ documentTitle: "Astral document", citationUrl: publicUrl })}
              )
            `;
            yield* sql`
              insert into assistant_message_source_uses (
                assistant_message_id, source_key, consumer_task_id, topic_id,
                rendered_token_count, context_order, ranges
              ) values (
                ${ids.assistantMessage}, ${sourceKey}, 'single-answer', null, 0, 0,
                ${JSON.stringify([{ charStart: 0, charEnd: utf16Length + 1 }])}::jsonb
              )
            `;
          }),
        );

        const sourceFailure = await runDb(
          databaseUrl,
          Effect.exit(
            Effect.gen(function* () {
              const sql = yield* PgClient.PgClient;
              return yield* sql.unsafe(migration).raw;
            }),
          ),
        );
        expect(sourceFailure._tag).toBe("Failure");
        expect(errorText(sourceFailure)).toContain(
          `assistant_message_sources/${ids.assistantMessage}/${sourceKey}`,
        );
        expect(errorText(sourceFailure)).toContain(
          "document range exceeds immutable UTF-16 text length",
        );

        const sourceUseFailure = await runDb(
          databaseUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`alter table assistant_message_sources disable trigger user`;
            yield* sql`
              update assistant_message_sources
              set locator = ${sql.json({
                kind: "document",
                sourceId: `public:${ids.publicSource}`,
                documentId: ids.publicDocument,
                versionId: ids.publicDocument,
                contentHash: createHash("sha256").update(text).digest("hex"),
                ranges: [{ charStart: 0, charEnd: utf16Length }],
              })},
              source_identity_digest = assistant_message_source_identity_digest(
                assistant_message_id, source_key, kind, ${sql.json({
                  kind: "document",
                  sourceId: `public:${ids.publicSource}`,
                  documentId: ids.publicDocument,
                  versionId: ids.publicDocument,
                  contentHash: createHash("sha256").update(text).digest("hex"),
                  ranges: [{ charStart: 0, charEnd: utf16Length }],
                })}, document_version_id, publisher_document_version_id,
                message_id, memory_revision_id, display_label, public_provenance
              )
              where assistant_message_id = ${ids.assistantMessage} and source_key = ${sourceKey}
            `;
            yield* sql`alter table assistant_message_sources enable trigger user`;
            yield* sql`alter table assistant_message_source_uses disable trigger user`;
            yield* sql`
              update assistant_message_source_uses
              set ranges = ${JSON.stringify([{ charStart: 0, charEnd: utf16Length + 1 }])}::jsonb,
                  source_use_identity_digest = assistant_message_source_use_identity_digest(
                    assistant_message_id, source_key, consumer_task_id, topic_id,
                    rendered_token_count, context_order,
                    ${JSON.stringify([{ charStart: 0, charEnd: utf16Length + 1 }])}::jsonb
                  )
              where assistant_message_id = ${ids.assistantMessage} and source_key = ${sourceKey}
            `;
            yield* sql`alter table assistant_message_source_uses enable trigger user`;
            return yield* Effect.exit(sql.unsafe(migration).raw);
          }),
        );
        expect(sourceUseFailure._tag).toBe("Failure");
        expect(errorText(sourceUseFailure)).toContain(
          `assistant_message_source_uses/${ids.assistantMessage}/${sourceKey}/single-answer/-`,
        );
        expect(errorText(sourceUseFailure)).toContain(
          "source-use range exceeds immutable UTF-16 text length",
        );

        const unchanged = await runDb(
          databaseUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            return yield* sql<{ readonly helpers: number; readonly finalColumn: number }>`
              select
                (select count(*)::int from pg_proc where pronamespace = 'public'::regnamespace
                  and proname = 'brief_ai_safe_bigint') as helpers,
                (select count(*)::int from information_schema.columns
                  where table_schema = 'public' and table_name = 'assistant_message_sources'
                    and column_name = 'version_id') as "finalColumn"
            `;
          }),
        );
        expect(unchanged[0]).toEqual({ helpers: 0, finalColumn: 0 });
      } finally {
        await runDb(
          adminDatabaseUrl(),
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`select pg_terminate_backend(pid) from pg_stat_activity where datname = ${databaseName}`;
            yield* sql.unsafe(`drop database if exists ${quoteIdentifier(databaseName)}`);
          }),
        );
      }
    },
  );

  it(
    "blocks duplicate terminal manifests before the cutover writes",
    { timeout: 120_000 },
    async () => {
      const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
      const databaseName = `brief_migrations_duplicate_manifest_${process.pid}_${suffix}`;
      const databaseUrl = databaseUrlForName(databaseName);
      const ids = {
        user: `duplicate-manifest-user-${suffix}`,
        company: crypto.randomUUID(),
        chat: crypto.randomUUID(),
        userMessage: crypto.randomUUID(),
        assistantMessage: crypto.randomUUID(),
        run: crypto.randomUUID(),
      };
      const nonce = Buffer.from(`duplicate-${suffix}`).subarray(0, 16);
      const migration = await Bun.file(
        new URL("../../../../db/migrations/0064_ai_chat_runtime_cutover.sql", import.meta.url),
      ).text();
      const usage = [
        ["plan-turn", "plan_turn"],
        ["memory-extract", "memory_extractor"],
        ["single-retrieve-internal", "internal_retrieval"],
        ["single-answer", "direct_answer"],
      ] as const;

      try {
        await runDb(
          adminDatabaseUrl(),
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql.unsafe(`create database ${quoteIdentifier(databaseName)}`);
          }),
        );
        await runDb(
          databaseUrl,
          applyMigrationsThrough("0063_immutable_document_exposure_evidence.sql"),
        );
        await runDb(
          databaseUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
              insert into platform_users (id, primary_email, display_name, clerk_user_id)
              values (${ids.user}, ${`${ids.user}@example.test`}, 'Duplicate manifest user', ${`clerk-${ids.user}`})
            `;
            yield* sql`
              insert into client_companies (id, name) values (${ids.company}, 'Duplicate manifest company')
            `;
            yield* sql`
              insert into client_company_memberships (company_id, user_id, role)
              values (${ids.company}, ${ids.user}, 'admin')
            `;
            yield* sql`
              insert into chats (id, user_id, company_id, memory_mode)
              values (${ids.chat}, ${ids.user}, ${ids.company}, 'disabled')
            `;
            yield* sql`
              insert into chat_messages (id, chat_id, author, content)
              values (${ids.userMessage}, ${ids.chat}, 'user', 'Duplicate manifest fixture')
            `;
            yield* sql`
              insert into ai_runs (
                id, chat_id, initiating_user_id, user_message_id, locale, market,
                citation_nonce, effective_web_policy, finished_at
              ) values (
                ${ids.run}, ${ids.chat}, ${ids.user}, ${ids.userMessage}, 'en-US', 'US',
                decode(${nonce.toString("base64")}, 'base64'),
                ${sql.json({ enabled: false, reason: "company_disabled", allowlistActive: false })},
                now()
              )
            `;
            yield* sql`
              insert into chat_messages (id, chat_id, author, content, assistant_ai_run_id)
              values (${ids.assistantMessage}, ${ids.chat}, 'assistant', 'Saved answer', ${ids.run})
            `;
            yield* sql`
              update ai_runs set assistant_message_id = ${ids.assistantMessage} where id = ${ids.run}
            `;
            yield* sql`
              insert into ai_observations (
                run_id, chat_id, emitting_task, loop_iteration, attempt,
                observation_key, kind, payload
              ) values (
                ${ids.run}, ${ids.chat}, 'plan-turn', 0, 0,
                'plan-turn:0:0:turn_plan', 'turn_plan',
                ${sql.json({ mode: "single", question: "Duplicate manifest fixture", relevantTurnIds: [] })}
              ), (
                ${ids.run}, ${ids.chat}, 'single-retrieve-internal', 0, 0,
                'single-retrieve-internal:0:0:retrieval_manifest:result', 'retrieval_manifest',
                ${sql.json({ selectorRole: "internal", references: [] })}
              ), (
                ${ids.run}, ${ids.chat}, 'single-select-memories', 0, 0,
                'single-select-memories:0:0:retrieval_manifest:result', 'retrieval_manifest',
                ${sql.json({ selectorRole: "memory", references: [], noCallReason: "memory_mode_disabled" })}
              ), (
                ${ids.run}, ${ids.chat}, 'single-retrieve-web', 0, 0,
                'single-retrieve-web:0:0:retrieval_manifest:result', 'retrieval_manifest',
                ${sql.json({ selectorRole: "web", references: [], noCallReason: "web_policy_disabled" })}
              ), (
                ${ids.run}, ${ids.chat}, 'finalize', 0, 0,
                'retrieval_no_call_seal:single-select-memories:0:0', 'retrieval_no_call_seal',
                ${sql.json({
                  selectorTaskId: "single-select-memories",
                  selectorLoopIteration: 0,
                  selectorAttempt: 0,
                  selectorObservationKey: "single-select-memories:0:0:retrieval_manifest:result",
                  noCallReason: "memory_mode_disabled",
                })}
              ), (
                ${ids.run}, ${ids.chat}, 'finalize', 0, 0,
                'retrieval_no_call_seal:single-retrieve-web:0:0', 'retrieval_no_call_seal',
                ${sql.json({
                  selectorTaskId: "single-retrieve-web",
                  selectorLoopIteration: 0,
                  selectorAttempt: 0,
                  selectorObservationKey: "single-retrieve-web:0:0:retrieval_manifest:result",
                  noCallReason: "web_policy_disabled",
                })}
              )
            `;
            for (const [index, [taskId, agentRole]] of usage.entries()) {
              yield* sql`
                insert into ai_observations (
                  run_id, chat_id, emitting_task, loop_iteration, attempt,
                  observation_key, kind, payload
                ) values (
                  ${ids.run}, ${ids.chat}, ${taskId}, 0, 0,
                  ${`provider_request_measurement:${taskId}:0:0:0`}, 'provider_request_measurement',
                  ${sql.json({
                    agentRole,
                    modelId: "glm-5-turbo",
                    requestSha256Hex: String.fromCharCode(97 + index).repeat(64),
                    sourceExposureProofSha256Hexes: [],
                    providerRequestIndex: 0,
                    inputTokens: 1,
                    requestedOutputTokens: 1,
                    usableInputTokens: 1,
                    contextWindow: 100,
                    passed: true,
                  })}
                )
              `;
              yield* sql`
                insert into ai_run_usage (
                  run_id, task_id, loop_iteration, attempt, provider_request_index,
                  agent_role, model_id, provider_service_id, input_tokens, output_tokens,
                  cached_tokens, reasoning_tokens, total_tokens, stop_reason
                ) values (
                  ${ids.run}, ${taskId}, 0, 0, 0, ${agentRole}, 'glm-5-turbo',
                  'deterministic_test', 1, 1, 0, 0, 2, 'stop'
                )
              `;
              yield* sql`
                insert into ai_run_events (run_id, seq, event, emitted_by_task, emission_key)
                values (
                  ${ids.run}, ${index + 2},
                  ${sql.json({
                    type: "usage",
                    scope: "request",
                    kind: "model",
                    role: agentRole,
                    attempt: 0,
                    inputTokens: 1,
                    outputTokens: 1,
                    cachedTokens: 0,
                    reasoningTokens: 0,
                    totalTokens: 2,
                  })},
                  ${taskId}, ${`usage:request:model:${taskId}:0:0:0`}
                )
              `;
            }
            yield* sql`
              insert into ai_observations (
                run_id, chat_id, emitting_task, loop_iteration, attempt,
                observation_key, kind, payload
              ) values
                (${ids.run}, ${ids.chat}, 'memory-extract', 0, 0,
                 'memory-extract:0:0:memory_extraction_result:result', 'memory_extraction_result',
                 ${sql.json({ proposalCount: 0, discardedCount: 0, extractionSha256Hex: "b".repeat(64) })}),
                (${ids.run}, ${ids.chat}, 'finalize', 0, 0,
                 'finalize:0:0:memory_application:result', 'memory_application',
                 ${sql.json({
                   extractionTaskId: "memory-extract",
                   extractionLoopIteration: 0,
                   extractionAttempt: 0,
                   extractionObservationKey: "memory-extract:0:0:memory_extraction_result:result",
                   extractionSha256Hex: "b".repeat(64),
                   proposalCount: 0,
                   discardedCount: 0,
                 })}),
                (${ids.run}, ${ids.chat}, 'single-answer', 0, 0,
                 'answer:started', 'answer_started',
                 ${sql.json({ mode: "single", attempt: 0 })}),
                (${ids.run}, ${ids.chat}, 'single-answer', 0, 0,
                 'answer:delta', 'answer_delta',
                 ${sql.json({ delta: "Saved answer" })}),
                (${ids.run}, ${ids.chat}, 'single-answer', 0, 0,
                 'answer:completed', 'answer_completed',
                 ${sql.json({ mode: "single", attempt: 0 })}),
                (${ids.run}, ${ids.chat}, 'single-answer', 0, 0,
                 'context:measure', 'context_measurement',
                 ${sql.json({
                   consumerTaskId: "single-answer",
                   mandatoryInputTokens: 0,
                   discretionaryInputTokens: 0,
                   totalInputTokens: 0,
                   requestedOutputTokens: 1,
                   usableInputTokens: 1,
                   contextWindow: 100,
                   status: "ready",
                   reductionRan: false,
                   reductionFeedback: [],
                   restrictedContextLedger: {
                     requestKind: "direct",
                     modelId: "glm-5-turbo",
                     requestSha256Hex: "d".repeat(64),
                     inputTokens: 0,
                     usableInputTokens: 1,
                     requestedOutputTokens: 1,
                     selectedConversation: [],
                     question: "Duplicate manifest fixture",
                     gaps: [],
                     sources: [],
                   },
                 })}),
                (${ids.run}, ${ids.chat}, 'single-answer', 0, 0,
                 'context:serialized', 'context_serialized',
                 ${sql.json({
                   consumerTaskId: "single-answer",
                   sourceKeys: [],
                   restrictedContextLedger: {
                     requestKind: "direct",
                     modelId: "glm-5-turbo",
                     requestSha256Hex: "d".repeat(64),
                     inputTokens: 0,
                     usableInputTokens: 1,
                     requestedOutputTokens: 1,
                     selectedConversation: [],
                     question: "Duplicate manifest fixture",
                     gaps: [],
                     sources: [],
                   },
                   terminalUsageCoordinate: {
                     taskId: "single-answer",
                     loopIteration: 0,
                     attempt: 0,
                     providerRequestIndex: 0,
                   },
                 })})
            `;
            yield* sql`
              insert into ai_run_events (run_id, seq, event, emitted_by_task, emission_key)
              values
                (${ids.run}, 1, ${sql.json({ type: "run_started" })}, null, 'run_started'),
                (${ids.run}, 6, ${sql.json({
                  type: "context_ready",
                  mode: "single",
                  reductionRan: false,
                  sourcesRead: [],
                  consumers: [
                    {
                      consumer: "direct",
                      inputTokens: 0,
                      requestedOutputTokens: 1,
                      usableInputTokens: 1,
                    },
                  ],
                })}, 'single-answer', 'context_ready'),
                (${ids.run}, 7, ${sql.json({ type: "answer_started", mode: "single", attempt: 0 })}, 'single-answer', 'answer_started:single-answer:0'),
                (${ids.run}, 8, ${sql.json({ type: "text_delta", delta: "Saved answer" })}, 'single-answer', 'text_delta:single-answer:0:0'),
                (${ids.run}, 9, ${sql.json({ type: "memory_updated", created: 0, updated: 0, discarded: 0 })}, 'finalize', 'memory_updated'),
                (${ids.run}, 10, ${sql.json({
                  type: "usage",
                  scope: "run",
                  model: {
                    inputTokens: 4,
                    outputTokens: 4,
                    cachedTokens: 0,
                    reasoningTokens: 0,
                    totalTokens: 8,
                    requestCount: 4,
                  },
                  web: { searchCount: 0, fetchCount: 0, responseBytes: 0, billedUnits: 0 },
                })}, 'finalize', 'usage:run'),
                (${ids.run}, 11, ${sql.json({ type: "done", assistantMessageId: ids.assistantMessage })}, 'finalize', 'terminal')
            `;

            // A direct duplicate key is impossible: the parent unique index
            // rejects it, while the strict key check at migration lines
            // 1868-1874 rejects a different key. Inheritance keeps the parent
            // constraint intact while giving the migration a valid child row
            // at the same terminal coordinate.
            yield* sql`
              create table ai_observations_terminal_manifest_duplicate ()
              inherits (ai_observations)
            `;
            yield* sql`
              alter table ai_observations_terminal_manifest_duplicate
                add constraint ai_observations_terminal_manifest_duplicate_pk primary key (id)
            `;
            yield* sql`
              alter table ai_observations_terminal_manifest_duplicate
                add constraint ai_observations_terminal_manifest_duplicate_run_fk
                foreign key (run_id) references ai_runs (id) on delete cascade
            `;
            yield* sql`
              alter table ai_observations_terminal_manifest_duplicate
                add constraint ai_observations_terminal_manifest_duplicate_chat_fk
                foreign key (chat_id) references chats (id) on delete cascade
            `;
            yield* sql`
              alter table ai_observations_terminal_manifest_duplicate
                add constraint ai_observations_terminal_manifest_duplicate_coordinates
                check (loop_iteration >= 0 and attempt >= 0)
            `;
            yield* sql`
              create unique index ai_observations_terminal_manifest_duplicate_key
                on ai_observations_terminal_manifest_duplicate (run_id, observation_key)
            `;
            yield* sql`
              insert into ai_observations_terminal_manifest_duplicate (
                id, run_id, chat_id, kind, payload, created_at,
                emitting_task, loop_iteration, attempt, observation_key
              )
              select
                gen_random_uuid(), run_id, chat_id, kind, payload, created_at,
                emitting_task, loop_iteration, attempt, observation_key
              from ai_observations
              where run_id = ${ids.run}
                and kind = 'retrieval_manifest'
                and emitting_task = 'single-retrieve-internal'
                and loop_iteration = 0
                and attempt = 0
            `;
            const duplicateTerminalManifest = yield* Effect.exit(sql.unsafe(migration).raw);
            expect(errorText(duplicateTerminalManifest)).toContain(
              `AI chat schema cutover preflight row ai_runs/${ids.run}/single-retrieve-internal: successful run has duplicate terminal retrieval manifest`,
            );
            const duplicateFence = yield* sql<{
              readonly helperCount: number;
              readonly finalColumnCount: number;
              readonly finalIndexCount: number;
            }>`
              select
                (
                  select count(*)::int
                  from pg_proc
                  where pronamespace = 'public'::regnamespace
                    and (
                      proname like 'brief_ai_%'
                      or proname in ('ai_chat_rewrite_citations', 'ai_chat_rewrite_source_keys')
                    )
                ) as "helperCount",
                (
                  select count(*)::int
                  from information_schema.columns
                  where table_schema = 'public'
                    and table_name = 'ai_runs'
                    and column_name = 'citation_namespace'
                ) as "finalColumnCount",
                (
                  select count(*)::int
                  from pg_indexes
                  where schemaname = 'public'
                    and tablename = 'ai_runs'
                    and indexname = 'ai_runs_citation_namespace_key'
                ) as "finalIndexCount"
            `;
            expect(duplicateFence).toEqual([
              { helperCount: 0, finalColumnCount: 0, finalIndexCount: 0 },
            ]);
            yield* sql`drop table ai_observations_terminal_manifest_duplicate`;
            const successfulCutover = yield* Effect.exit(sql.unsafe(migration).raw);
            expect(successfulCutover._tag).toBe("Success");
            const finalCitationColumns = yield* sql<ColumnRow>`
              select column_name
              from information_schema.columns
              where table_schema = 'public'
                and table_name = 'ai_runs'
                and column_name = 'citation_namespace'
            `;
            expect(finalCitationColumns).toHaveLength(1);
          }),
        );
      } finally {
        await runDb(
          adminDatabaseUrl(),
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
              select pg_terminate_backend(pid)
              from pg_stat_activity
              where datname = ${databaseName} and pid <> pg_backend_pid()
            `;
            yield* sql.unsafe(`drop database if exists ${quoteIdentifier(databaseName)}`);
          }),
        );
      }
    },
  );

  it(
    "blocks populated two-topic fanout manifest cardinality, ownership, and role mutations",
    { timeout: 120_000 },
    async () => {
      const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
      const databaseName = `brief_migrations_fanout_${process.pid}_${suffix}`;
      const databaseUrl = databaseUrlForName(databaseName);
      const ids = {
        user: `fanout-user-${suffix}`,
        company: crypto.randomUUID(),
        chat: crypto.randomUUID(),
        userMessage: crypto.randomUUID(),
        run: crypto.randomUUID(),
      };
      const nonce = Buffer.from(`fanout-${suffix}`).subarray(0, 16);
      const migration = await Bun.file(
        new URL("../../../../db/migrations/0064_ai_chat_runtime_cutover.sql", import.meta.url),
      ).text();
      const mounted = [
        ["topic-t1-retrieve-internal", "internal"],
        ["topic-t1-select-memories", "memory"],
        ["topic-t1-retrieve-web", "web"],
        ["topic-t2-retrieve-internal", "internal"],
        ["topic-t2-select-memories", "memory"],
        ["topic-t2-retrieve-web", "web"],
      ] as const;
      const usage = [
        ["plan-turn", "plan_turn"],
        ["memory-extract", "memory_extractor"],
        ["topic-t1-retrieve-internal", "internal_retrieval"],
        ["topic-t2-retrieve-internal", "internal_retrieval"],
      ] as const;

      const runAndReadError = (mutate: Effect.Effect<void, unknown, PgClient.PgClient>) =>
        runDb(
          databaseUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* mutate;
            const result = yield* Effect.exit(sql.unsafe(migration).raw);
            return errorText(result);
          }),
        );

      try {
        await runDb(
          adminDatabaseUrl(),
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql.unsafe(`create database ${quoteIdentifier(databaseName)}`);
          }),
        );
        await runDb(
          databaseUrl,
          applyMigrationsThrough("0063_immutable_document_exposure_evidence.sql"),
        );
        await runDb(
          databaseUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
              insert into platform_users (id, primary_email, display_name, clerk_user_id)
              values (${ids.user}, ${`${ids.user}@example.test`}, 'Fanout user', ${`clerk-${ids.user}`})
            `;
            yield* sql`
              insert into client_companies (id, name) values (${ids.company}, 'Fanout company')
            `;
            yield* sql`
              insert into client_company_memberships (company_id, user_id, role)
              values (${ids.company}, ${ids.user}, 'admin')
            `;
            yield* sql`
              insert into chats (id, user_id, company_id, memory_mode)
              values (${ids.chat}, ${ids.user}, ${ids.company}, 'disabled')
            `;
            yield* sql`
              insert into chat_messages (id, chat_id, author, content)
              values (${ids.userMessage}, ${ids.chat}, 'user', 'Fanout fixture')
            `;
            yield* sql`
              insert into ai_runs (
                id, chat_id, user_message_id, locale, market, citation_nonce,
                effective_web_policy, finished_at
              ) values (
                ${ids.run}, ${ids.chat}, ${ids.userMessage}, 'en-US', 'US',
                decode(${nonce.toString("base64")}, 'base64'),
                ${sql.json({ enabled: false, reason: "company_disabled", allowlistActive: false })}, now()
              )
            `;
            yield* sql`
              insert into ai_observations (
                run_id, chat_id, emitting_task, loop_iteration, attempt,
                observation_key, kind, payload
              ) values (
                ${ids.run}, ${ids.chat}, 'plan-turn', 0, 0,
                'plan-turn:0:0:turn_plan', 'turn_plan',
                ${sql.json({
                  mode: "fanout",
                  question: "Fanout fixture",
                  topics: [
                    { topicId: "t1", question: "Topic one", relevantTurnIds: [] },
                    { topicId: "t2", question: "Topic two", relevantTurnIds: [] },
                  ],
                })}
              )
            `;
            for (const [owner, selectorRole] of mounted) {
              yield* sql`
                insert into ai_observations (
                  run_id, chat_id, emitting_task, loop_iteration, attempt,
                  observation_key, kind, payload
                ) values (
                  ${ids.run}, ${ids.chat}, ${owner}, 0, 0,
                  ${`${owner}:0:0:retrieval_manifest:result`}, 'retrieval_manifest',
                  ${sql.json({
                    selectorRole,
                    references: [],
                    ...(selectorRole === "memory"
                      ? { noCallReason: "memory_mode_disabled" }
                      : selectorRole === "web"
                        ? { noCallReason: "web_policy_disabled" }
                        : {}),
                  })}
                )
              `;
            }
            for (const [owner, selectorRole] of mounted) {
              if (selectorRole === "internal") continue;
              const noCallReason =
                selectorRole === "memory" ? "memory_mode_disabled" : "web_policy_disabled";
              yield* sql`
                insert into ai_observations (
                  run_id, chat_id, emitting_task, loop_iteration, attempt,
                  observation_key, kind, payload
                ) values (
                  ${ids.run}, ${ids.chat}, 'finalize', 0, 0,
                  ${`retrieval_no_call_seal:${owner}:0:0`}, 'retrieval_no_call_seal',
                  ${sql.json({
                    selectorTaskId: owner,
                    selectorLoopIteration: 0,
                    selectorAttempt: 0,
                    selectorObservationKey: `${owner}:0:0:retrieval_manifest:result`,
                    noCallReason,
                  })}
                )
              `;
            }
            for (const [index, [taskId, agentRole]] of usage.entries()) {
              yield* sql`
                insert into ai_observations (
                  run_id, chat_id, emitting_task, loop_iteration, attempt,
                  observation_key, kind, payload
                ) values (
                  ${ids.run}, ${ids.chat}, ${taskId}, 0, 0,
                  ${`provider_request_measurement:${taskId}:0:0:0`}, 'provider_request_measurement',
                  ${sql.json({
                    agentRole,
                    modelId: "glm-5-turbo",
                    requestSha256Hex: "a".repeat(64),
                    sourceExposureProofSha256Hexes: [],
                    providerRequestIndex: 0,
                    inputTokens: 1,
                    requestedOutputTokens: 1,
                    usableInputTokens: 1,
                    contextWindow: 100,
                    passed: true,
                  })}
                )
              `;
              yield* sql`
                insert into ai_run_usage (
                  run_id, task_id, loop_iteration, attempt, provider_request_index,
                  agent_role, model_id, provider_service_id, input_tokens, output_tokens,
                  cached_tokens, reasoning_tokens, total_tokens, stop_reason
                ) values (
                  ${ids.run}, ${taskId}, 0, 0, 0, ${agentRole}, 'glm-5-turbo',
                  'deterministic_test', 1, 1, 0, 0, 2, 'stop'
                )
              `;
              yield* sql`
                insert into ai_run_events (run_id, seq, event, emitted_by_task, emission_key)
                values (
                  ${ids.run}, ${index + 1},
                  ${sql.json({
                    type: "usage",
                    scope: "request",
                    kind: "model",
                    role: agentRole,
                    attempt: 0,
                    inputTokens: 1,
                    outputTokens: 1,
                    cachedTokens: 0,
                    reasoningTokens: 0,
                    totalTokens: 2,
                  })},
                  ${taskId}, ${`usage:request:model:${taskId}:0:0:0`}
                )
              `;
            }
          }),
        );

        const fanoutTopics = await runDb(
          databaseUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            return yield* sql<{ readonly count: number }>`
              select count(*)::int as count
              from ai_observations plans
              cross join lateral jsonb_array_elements(plans.payload->'topics') topic(value)
              where plans.run_id = ${ids.run}
                and plans.kind = 'turn_plan'
                and plans.emitting_task = 'plan-turn'
                and plans.payload->>'mode' = 'fanout'
            `;
          }),
        );
        expect(fanoutTopics).toEqual([{ count: 2 }]);
        const missingTopicLedgerError = await runAndReadError(Effect.succeed(undefined));
        expect(missingTopicLedgerError).toContain(`ai_runs/${ids.run}/topic-t1-answer`);
        expect(missingTopicLedgerError).toContain("fanout topic packet ledger is incomplete");
        const unchangedAfterTopicLedgerBlock = await runDb(
          databaseUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            return yield* sql<{ readonly helpers: number; readonly finalColumn: number }>`
              select
                (select count(*)::int from pg_proc
                 where pronamespace = 'public'::regnamespace
                   and proname = 'brief_ai_safe_bigint') as helpers,
                (select count(*)::int from information_schema.columns
                 where table_schema = 'public'
                   and table_name = 'ai_runs'
                   and column_name = 'citation_namespace') as "finalColumn"
            `;
          }),
        );
        expect(unchangedAfterTopicLedgerBlock).toEqual([{ helpers: 0, finalColumn: 0 }]);

        await runDb(
          databaseUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
              insert into ai_observations (
                run_id, chat_id, emitting_task, loop_iteration, attempt,
                observation_key, kind, payload
              ) values
                (
                  ${ids.run}, ${ids.chat}, 'topic-t1-answer', 1, 0,
                  'topic-t1-answer:1:0:topic_packet', 'topic_packet',
                  ${sql.json({
                    topicId: "t1",
                    status: "partial",
                    sourceKeys: [],
                    claimCount: 0,
                    gapCount: 1,
                    packetSha256Hex: "a".repeat(64),
                  })}
                ),
                (
                  ${ids.run}, ${ids.chat}, 'topic-t1-answer', 0, 0,
                  'provider_request_measurement:topic-t1-answer:0:0:0',
                  'provider_request_measurement',
                  ${sql.json({
                    agentRole: "topic_answer",
                    modelId: "glm-5-turbo",
                    requestSha256Hex: "b".repeat(64),
                    sourceExposureProofSha256Hexes: [],
                    providerRequestIndex: 0,
                    inputTokens: 1,
                    requestedOutputTokens: 1,
                    usableInputTokens: 1,
                    contextWindow: 100,
                    passed: true,
                  })}
                )
            `;
            yield* sql`
              insert into ai_run_usage (
                run_id, task_id, loop_iteration, attempt, provider_request_index,
                agent_role, model_id, provider_service_id, input_tokens, output_tokens,
                cached_tokens, reasoning_tokens, total_tokens, stop_reason
              ) values (
                ${ids.run}, 'topic-t1-answer', 0, 0, 0,
                'topic_answer', 'glm-5-turbo', 'deterministic_test',
                1, 1, 0, 0, 2, 'stop'
              )
            `;
            yield* sql`
              insert into ai_run_events (run_id, seq, event, emitted_by_task, emission_key)
              values (
                ${ids.run}, 20,
                ${sql.json({
                  type: "usage",
                  scope: "request",
                  kind: "model",
                  role: "topic_answer",
                  attempt: 0,
                  inputTokens: 1,
                  outputTokens: 1,
                  cachedTokens: 0,
                  reasoningTokens: 0,
                  totalTokens: 2,
                })},
                'topic-t1-answer', 'usage:request:model:topic-t1-answer:0:0:0'
              )
            `;
          }),
        );
        const mismatchedTopicCoordinateError = await runAndReadError(Effect.succeed(undefined));
        expect(mismatchedTopicCoordinateError).toContain(`ai_runs/${ids.run}/topic-t1-answer`);
        expect(mismatchedTopicCoordinateError).toContain(
          "fanout topic packet has no matching provider coordinate",
        );

        const missingManifestError = await runAndReadError(
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
              delete from ai_observations
              where run_id = ${ids.run} and emitting_task = 'topic-t2-retrieve-web'
            `;
          }),
        );
        expect(missingManifestError).toContain(`ai_runs/${ids.run}/topic-t2-retrieve-web`);
        expect(missingManifestError).toContain(
          "successful run is missing terminal retrieval manifest",
        );
        await runDb(
          databaseUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
              insert into ai_observations (
                run_id, chat_id, emitting_task, loop_iteration, attempt,
                observation_key, kind, payload
              ) values (
                ${ids.run}, ${ids.chat}, 'topic-t2-retrieve-web', 0, 0,
                'topic-t2-retrieve-web:0:0:retrieval_manifest:result', 'retrieval_manifest',
                ${sql.json({ selectorRole: "web", references: [], noCallReason: "web_policy_disabled" })}
              )
            `;
          }),
        );

        const missingMemoryManifestError = await runAndReadError(
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
              delete from ai_observations
              where run_id = ${ids.run} and emitting_task = 'topic-t1-select-memories'
            `;
          }),
        );
        expect(missingMemoryManifestError).toContain(`ai_runs/${ids.run}/topic-t1-select-memories`);
        expect(missingMemoryManifestError).toContain(
          "successful run is missing terminal retrieval manifest",
        );
        await runDb(
          databaseUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
              insert into ai_observations (
                run_id, chat_id, emitting_task, loop_iteration, attempt,
                observation_key, kind, payload
              ) values (
                ${ids.run}, ${ids.chat}, 'topic-t1-select-memories', 0, 0,
                'topic-t1-select-memories:0:0:retrieval_manifest:result', 'retrieval_manifest',
                ${sql.json({ selectorRole: "memory", references: [], noCallReason: "memory_mode_disabled" })}
              )
            `;
          }),
        );

        const wrongTopicRouteError = await runAndReadError(
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
              update ai_observations
              set payload = ${sql.json({
                mode: "fanout",
                question: "Fanout fixture",
                topics: [
                  { topicId: "t2", question: "Topic two", relevantTurnIds: [] },
                  { topicId: "t1", question: "Topic one", relevantTurnIds: [] },
                ],
              })}
              where run_id = ${ids.run} and kind = 'turn_plan'
            `;
          }),
        );
        expect(wrongTopicRouteError).toContain(`ai_observations/`);
        expect(wrongTopicRouteError).toContain("turn plan payload is not strict");
        await runDb(
          databaseUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
              update ai_observations
              set payload = ${sql.json({
                mode: "fanout",
                question: "Fanout fixture",
                topics: [
                  { topicId: "t1", question: "Topic one", relevantTurnIds: [] },
                  { topicId: "t2", question: "Topic two", relevantTurnIds: [] },
                ],
              })}
              where run_id = ${ids.run} and kind = 'turn_plan'
            `;
          }),
        );

        const wrongOwnerError = await runAndReadError(
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
              insert into ai_observations (
                run_id, chat_id, emitting_task, loop_iteration, attempt,
                observation_key, kind, payload
              ) values (
                ${ids.run}, ${ids.chat}, 'topic-t3-retrieve-internal', 0, 0,
                'topic-t3-retrieve-internal:0:0:retrieval_manifest:result', 'retrieval_manifest',
                ${sql.json({ selectorRole: "internal", references: [] })}
              )
            `;
          }),
        );
        expect(wrongOwnerError).toContain(`ai_runs/${ids.run}/topic-t3-retrieve-internal`);
        expect(wrongOwnerError).toContain("retrieval manifest owner is outside selected route");
        await runDb(
          databaseUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
              delete from ai_observations
              where run_id = ${ids.run}
                and observation_key = 'topic-t3-retrieve-internal:0:0:retrieval_manifest:result'
            `;
          }),
        );

        const wrongWebOwnerError = await runAndReadError(
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
              insert into ai_observations (
                run_id, chat_id, emitting_task, loop_iteration, attempt,
                observation_key, kind, payload
              ) values (
                ${ids.run}, ${ids.chat}, 'topic-t3-retrieve-web', 0, 0,
                'topic-t3-retrieve-web:0:0:retrieval_manifest:result', 'retrieval_manifest',
                ${sql.json({ selectorRole: "web", references: [] })}
              )
            `;
          }),
        );
        expect(wrongWebOwnerError).toContain(`ai_runs/${ids.run}/topic-t3-retrieve-web`);
        expect(wrongWebOwnerError).toContain("retrieval manifest owner is outside selected route");
        await runDb(
          databaseUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
              delete from ai_observations
              where run_id = ${ids.run}
                and observation_key = 'topic-t3-retrieve-web:0:0:retrieval_manifest:result'
            `;
          }),
        );

        const wrongRoleError = await runAndReadError(
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
              update ai_observations
              set payload = jsonb_set(payload - 'noCallReason', '{selectorRole}', '"web"'::jsonb)
              where run_id = ${ids.run}
                and emitting_task = 'topic-t2-select-memories'
            `;
          }),
        );
        expect(wrongRoleError).toContain(`ai_runs/${ids.run}/topic-t2-select-memories`);
        expect(wrongRoleError).toContain(
          "retrieval manifest selector role does not match its owner",
        );
        await runDb(
          databaseUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
              update ai_observations
              set payload = ${sql.json({
                selectorRole: "memory",
                references: [],
                noCallReason: "memory_mode_disabled",
              })}
              where run_id = ${ids.run}
                and emitting_task = 'topic-t2-select-memories'
            `;
          }),
        );
        const wrongWebRoleError = await runAndReadError(
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
              update ai_observations
              set payload = jsonb_set(payload - 'noCallReason', '{selectorRole}', '"memory"'::jsonb)
              where run_id = ${ids.run}
                and emitting_task = 'topic-t1-retrieve-web'
            `;
          }),
        );
        expect(wrongWebRoleError).toContain(`ai_runs/${ids.run}/topic-t1-retrieve-web`);
        expect(wrongWebRoleError).toContain(
          "retrieval manifest selector role does not match its owner",
        );
        await runDb(
          databaseUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
              update ai_observations
              set payload = ${sql.json({
                selectorRole: "web",
                references: [],
                noCallReason: "web_policy_disabled",
              })}
              where run_id = ${ids.run}
                and emitting_task = 'topic-t1-retrieve-web'
            `;
          }),
        );

        const missingInternalManifestError = await runAndReadError(
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
              delete from ai_observations
              where run_id = ${ids.run}
                and emitting_task = 'topic-t1-retrieve-internal'
                and kind = 'retrieval_manifest'
            `;
          }),
        );
        expect(missingInternalManifestError).toContain(
          `ai_runs/${ids.run}/topic-t1-retrieve-internal`,
        );
        expect(missingInternalManifestError).toContain(
          "successful run is missing terminal retrieval manifest",
        );
        await runDb(
          databaseUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
              insert into ai_observations (
                run_id, chat_id, emitting_task, loop_iteration, attempt,
                observation_key, kind, payload
              ) values (
                ${ids.run}, ${ids.chat}, 'topic-t1-retrieve-internal', 0, 0,
                'topic-t1-retrieve-internal:0:0:retrieval_manifest:result', 'retrieval_manifest',
                ${sql.json({ selectorRole: "internal", references: [] })}
              )
            `;
          }),
        );

        const wrongInternalRoleError = await runAndReadError(
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
              update ai_observations
              set payload = jsonb_set(payload, '{selectorRole}', '"memory"'::jsonb)
              where run_id = ${ids.run}
                and emitting_task = 'topic-t2-retrieve-internal'
                and kind = 'retrieval_manifest'
            `;
          }),
        );
        expect(wrongInternalRoleError).toContain(`ai_runs/${ids.run}/topic-t2-retrieve-internal`);
        expect(wrongInternalRoleError).toContain(
          "retrieval manifest selector role does not match its owner",
        );
        await runDb(
          databaseUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
              update ai_observations
              set payload = jsonb_set(payload, '{selectorRole}', '"internal"'::jsonb)
              where run_id = ${ids.run}
                and emitting_task = 'topic-t2-retrieve-internal'
                and kind = 'retrieval_manifest'
            `;
          }),
        );

        const foreignPlanOwnerError = await runAndReadError(
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
              update ai_observations
              set emitting_task = 'single-answer'
              where run_id = ${ids.run} and kind = 'turn_plan'
            `;
          }),
        );
        expect(foreignPlanOwnerError).toContain(`ai_runs/${ids.run}`);
        expect(foreignPlanOwnerError).toContain("successful turn plan has a foreign owner");
        await runDb(
          databaseUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
              update ai_observations
              set emitting_task = 'plan-turn'
              where run_id = ${ids.run} and kind = 'turn_plan'
            `;
          }),
        );

        const evaluationFanoutError = await runAndReadError(
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
              update ai_observations
              set emitting_task = 'evaluation-general-planner'
              where run_id = ${ids.run} and kind = 'turn_plan'
            `;
          }),
        );
        expect(evaluationFanoutError).toContain(`ai_runs/${ids.run}/evaluation-general-planner`);
        expect(evaluationFanoutError).toContain(
          "successful run is missing terminal retrieval manifest",
        );
        await runDb(
          databaseUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
              update ai_observations
              set emitting_task = 'plan-turn'
              where run_id = ${ids.run} and kind = 'turn_plan'
            `;
          }),
        );

        const missingSealError = await runAndReadError(
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
              delete from ai_observations
              where run_id = ${ids.run}
                and kind = 'retrieval_no_call_seal'
                and payload->>'selectorTaskId' = 'topic-t1-select-memories'
            `;
          }),
        );
        expect(missingSealError).toContain(`ai_runs/${ids.run}/topic-t1-select-memories`);
        expect(missingSealError).toContain(
          "terminal no-call retrieval manifest lacks its exact finalization seal",
        );
        await runDb(
          databaseUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
              insert into ai_observations (
                run_id, chat_id, emitting_task, loop_iteration, attempt,
                observation_key, kind, payload
              ) values (
                ${ids.run}, ${ids.chat}, 'finalize', 0, 0,
                'retrieval_no_call_seal:topic-t1-select-memories:0:0', 'retrieval_no_call_seal',
                ${sql.json({
                  selectorTaskId: "topic-t1-select-memories",
                  selectorLoopIteration: 0,
                  selectorAttempt: 0,
                  selectorObservationKey: "topic-t1-select-memories:0:0:retrieval_manifest:result",
                  noCallReason: "memory_mode_disabled",
                })}
              )
            `;
          }),
        );

        const forbiddenNoCallUsageError = await runAndReadError(
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
              insert into ai_run_usage (
                run_id, task_id, loop_iteration, attempt, provider_request_index,
                agent_role, model_id, provider_service_id, input_tokens, output_tokens,
                cached_tokens, reasoning_tokens, total_tokens, stop_reason
              ) values (
                ${ids.run}, 'topic-t1-select-memories', 0, 0, 0,
                'memory_selector', 'glm-5-turbo', 'deterministic_test',
                1, 1, 0, 0, 2, 'stop'
              )
            `;
            yield* sql`
              insert into ai_run_events (run_id, seq, event, emitted_by_task, emission_key)
              values (
                ${ids.run}, 10,
                ${sql.json({
                  type: "usage",
                  scope: "request",
                  kind: "model",
                  role: "memory_selector",
                  attempt: 0,
                  inputTokens: 1,
                  outputTokens: 1,
                  cachedTokens: 0,
                  reasoningTokens: 0,
                  totalTokens: 2,
                })},
                'topic-t1-select-memories',
                'usage:request:model:topic-t1-select-memories:0:0:0'
              )
            `;
          }),
        );
        expect(forbiddenNoCallUsageError).toContain(`ai_runs/${ids.run}/topic-t1-select-memories`);
        expect(forbiddenNoCallUsageError).toContain(
          "terminal no-call retrieval manifest lacks its exact finalization seal",
        );
        await runDb(
          databaseUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
              delete from ai_run_usage
              where run_id = ${ids.run} and task_id = 'topic-t1-select-memories'
            `;
            yield* sql`
              delete from ai_run_events
              where run_id = ${ids.run}
                and emission_key = 'usage:request:model:topic-t1-select-memories:0:0:0'
            `;
          }),
        );
      } finally {
        await runDb(
          adminDatabaseUrl(),
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`select pg_terminate_backend(pid) from pg_stat_activity where datname = ${databaseName}`;
            yield* sql.unsafe(`drop database if exists ${quoteIdentifier(databaseName)}`);
          }),
        );
      }
    },
  );

  it("upgrades a populated 0063 publisher tuple through the final cutover", async () => {
    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    const databaseName = `brief_migrations_0063_${process.pid}_${suffix}`;
    const databaseUrl = databaseUrlForName(databaseName);
    const documentId = crypto.randomUUID();
    const issueId = crypto.randomUUID();
    const subscriptionId = crypto.randomUUID();
    const publisherCompanyId = crypto.randomUUID();
    const jobId = crypto.randomUUID();
    const extractionId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    const upgradeUserId = `upgrade-user-${suffix}`;
    const upgradeCompanyId = crypto.randomUUID();
    const upgradeChatId = crypto.randomUUID();
    const upgradeUserMessageId = crypto.randomUUID();
    const upgradeRunId = crypto.randomUUID();
    const upgradeAssistantMessageId = crypto.randomUUID();
    const upgradeNonce = Buffer.from("publisher-0063-key").subarray(0, 16);
    const upgradeSourceKey = `k_${upgradeNonce.toString("base64url")}_1`;
    const sourceWithoutUseKey = `k_${upgradeNonce.toString("base64url")}_2`;
    const pdfHash = "a".repeat(64);
    const canonicalText = "A retained publisher page with exact immutable text.";
    const internalManifestPayload = {
      selectorRole: "internal",
      references: [
        {
          kind: "document",
          documentId,
          versionId,
          source: {
            kind: "publisher",
            sourceId: `publisher:${subscriptionId}`,
            issueId,
            documentId,
          },
          publisherExtractionId: extractionId,
          ranges: [{ charStart: 0, charEnd: canonicalText.length }],
          purpose: "grounding",
        },
      ],
    };
    const pages = JSON.stringify([{ pageNumber: 1, text: canonicalText }]);
    const contentHash = createHash("sha256").update(canonicalText).digest("hex");
    const splitPoint = Math.floor(canonicalText.length / 2);
    const initialRanges = [{ charStart: 0, charEnd: canonicalText.length }];
    const reducedRanges = [{ charStart: 0, charEnd: splitPoint }];
    const exposureTask = "single-retrieve-internal";
    const exposureLogicalIdentity = `publisher:${subscriptionId}:${documentId}:${versionId}`;
    const exposureContentItemIdentity = `${exposureLogicalIdentity}:${versionId}:${createHash(
      "sha256",
    )
      .update(JSON.stringify(initialRanges))
      .digest("base64url")}`;
    const exposureStage = "internal_search_preview";
    const exposureVisibleTokenCount = 8;
    const exposureProviderRequestHash = "d".repeat(64);
    const exposureBinding = {
      messageIndex: 0,
      orderedSourceDescriptor: `publisher:${subscriptionId}:${documentId}`,
      serializedField: "messages[0].content",
      sourceOrdinal: 0,
    };
    const exposureProof = createHash("sha256")
      .update(
        JSON.stringify({
          binding: exposureBinding,
          contentItemIdentity: exposureContentItemIdentity,
          exposureStage,
          logicalSourceIdentity: exposureLogicalIdentity,
          sourceKind: "document",
          visibleTokenCount: exposureVisibleTokenCount,
        }),
      )
      .digest("hex");
    const exposureReconstruction = JSON.stringify({
      contentHash,
      documentId,
      ranges: [{ charEnd: canonicalText.length, charStart: 0 }],
      sourceId: `publisher:${subscriptionId}`,
      versionId,
    });
    const answerExposureReconstruction = JSON.stringify({
      contentHash,
      documentId,
      ranges: [{ charEnd: splitPoint, charStart: 0 }],
      sourceId: `publisher:${subscriptionId}`,
      versionId,
    });
    const answerExposureContentItemIdentity = `${exposureLogicalIdentity}:${versionId}:${createHash(
      "sha256",
    )
      .update(JSON.stringify(reducedRanges))
      .digest("base64url")}`;
    const exposureAttestationKey = `source_exposure_attestation:${exposureTask}:0:0:0:${createHash(
      "sha256",
    )
      .update(
        JSON.stringify([
          "document",
          exposureLogicalIdentity,
          exposureContentItemIdentity,
          exposureStage,
          exposureVisibleTokenCount,
          exposureProviderRequestHash,
          exposureBinding,
          JSON.parse(exposureReconstruction),
        ]),
      )
      .digest("hex")}`;
    const exposureMeasurementKey = "provider_request_measurement:single-retrieve-internal:0:0:0";
    const answerExposureTask = "single-answer";
    const answerExposureStage = "answer_serialized";
    const answerExposureProviderRequestHash = "a".repeat(64);
    const answerExposureBinding = {
      ...exposureBinding,
      serializedField: "messages[0].content",
    };
    const answerExposureProof = createHash("sha256")
      .update(
        JSON.stringify({
          binding: answerExposureBinding,
          contentItemIdentity: answerExposureContentItemIdentity,
          exposureStage: answerExposureStage,
          logicalSourceIdentity: exposureLogicalIdentity,
          sourceKind: "document",
          visibleTokenCount: exposureVisibleTokenCount,
        }),
      )
      .digest("hex");
    const answerExposureAttestationKey = `source_exposure_attestation:${answerExposureTask}:0:0:1:${createHash(
      "sha256",
    )
      .update(
        JSON.stringify([
          "document",
          exposureLogicalIdentity,
          answerExposureContentItemIdentity,
          answerExposureStage,
          exposureVisibleTokenCount,
          answerExposureProviderRequestHash,
          answerExposureBinding,
          JSON.parse(answerExposureReconstruction),
        ]),
      )
      .digest("hex")}`;

    try {
      await runDb(
        adminDatabaseUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql.unsafe(`create database ${quoteIdentifier(databaseName)}`);
        }),
      );
      await runDb(
        databaseUrl,
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql.unsafe("drop schema if exists public cascade");
          yield* sql.unsafe("create schema public");
        }),
      );
      await runDb(
        databaseUrl,
        applyMigrationsThrough("0063_immutable_document_exposure_evidence.sql"),
      );
      await runDb(
        databaseUrl,
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            insert into publisher_companies (id, name)
            values (${publisherCompanyId}, ${`Upgrade publisher ${suffix}`})
          `;
          yield* sql`
            insert into publisher_subscriptions (id, publisher_company_id, name, created_by_user_id)
            values (${subscriptionId}, ${publisherCompanyId}, ${`Upgrade subscription ${suffix}`}, ${upgradeUserId})
          `;
          yield* sql`
            insert into publisher_issues (id, subscription_id, title, status, created_by_user_id)
            values (${issueId}, ${subscriptionId}, '0063 retained issue', 'draft', ${upgradeUserId})
          `;
          yield* sql`
            insert into jobs (id, kind, payload)
            values (${jobId}, 'extract_pdf_text', '{}'::jsonb)
          `;
          yield* sql`
            insert into brief_documents (
              id, issue_id, title, original_file_name, object_key, media_type,
              byte_size, sha256_hex, upload_completed_at, language, created_by_user_id
            ) values (
              ${documentId}, ${issueId}, '0063 retained document', 'retained.pdf',
              ${`upgrade/${documentId}.pdf`}, 'application/pdf', 128, ${pdfHash}, now(),
              'en-US', ${upgradeUserId}
            )
          `;
          yield* sql`
            insert into brief_document_extractions (
              id, brief_document_id, input_sha256_hex, pages,
              extracted_char_count, created_by_job_id
            ) values (
              ${extractionId}, ${documentId}, ${pdfHash}, ${pages}::jsonb,
              ${canonicalText.length}, ${jobId}
            )
          `;
          yield* sql`
            insert into brief_document_versions (
              id, brief_document_id, content_hash, language, canonical_text,
              text_char_count, page_ranges, created_by_job_id
            ) values (
              ${versionId}, ${documentId}, ${contentHash}, 'en-US', ${canonicalText},
              ${canonicalText.length},
              ${JSON.stringify([{ pageNumber: 1, charStart: 0, charEnd: canonicalText.length }])}::jsonb,
              ${jobId}
            )
          `;
          yield* sql`
            insert into platform_users (id, primary_email, display_name, clerk_user_id)
            values (${upgradeUserId}, ${`${upgradeUserId}@example.test`}, 'Upgrade user', ${`clerk-${upgradeUserId}`})
          `;
          yield* sql`
            insert into client_companies (id, name)
            values (${upgradeCompanyId}, 'Upgrade client company')
          `;
          yield* sql`
            insert into client_company_memberships (company_id, user_id, role)
            values (${upgradeCompanyId}, ${upgradeUserId}, 'admin')
          `;
          yield* sql`
            insert into chats (id, user_id, company_id, memory_mode)
            values (${upgradeChatId}, ${upgradeUserId}, ${upgradeCompanyId}, 'disabled')
          `;
          yield* sql`
            insert into chat_messages (id, chat_id, author, content)
            values (${upgradeUserMessageId}, ${upgradeChatId}, 'user', 'retained publisher answer')
          `;
          yield* sql`
            insert into ai_runs (
              id, chat_id, initiating_user_id, user_message_id, locale, market,
              citation_nonce, effective_web_policy, finished_at
            ) values (
              ${upgradeRunId}, ${upgradeChatId}, ${upgradeUserId}, ${upgradeUserMessageId},
              'en-US', 'US', decode(${upgradeNonce.toString("base64")}, 'base64'),
              ${sql.json({ enabled: false, reason: "company_disabled", allowlistActive: false })}, now()
            )
          `;
          yield* sql`
            insert into chat_messages (id, chat_id, author, content, assistant_ai_run_id)
            values (
              ${upgradeAssistantMessageId}, ${upgradeChatId}, 'assistant',
              ${`Retained [[cite:${upgradeSourceKey}]]`}, ${upgradeRunId}
            )
          `;
          yield* sql`
            update ai_runs
            set assistant_message_id = ${upgradeAssistantMessageId}
            where id = ${upgradeRunId}
          `;
          yield* sql`
            insert into assistant_message_sources (
              assistant_message_id, source_key, kind, locator,
              document_version_id, publisher_document_version_id, display_label, public_provenance
            ) values (
              ${upgradeAssistantMessageId}, ${upgradeSourceKey}, 'document',
              ${sql.json({
                kind: "document",
                sourceId: `publisher:${subscriptionId}`,
                documentId,
                versionId: versionId,
                contentHash,
                ranges: reducedRanges,
                publisherIssueId: issueId,
                publisherDocumentId: documentId,
              })}, ${versionId}, ${versionId}, 'Retained publisher document', ${sql.json({
                sourceName: "Upgrade publisher",
                issueTitle: "0063 retained issue",
                documentTitle: "0063 retained document",
                citationUrl: `/v1/issues/${issueId}/documents/${documentId}/content`,
                publishedAt: "2026-07-01T00:00:00.000Z",
              })}
            )
          `;
          yield* sql`
            insert into assistant_message_source_uses (
              assistant_message_id, source_key, consumer_task_id,
              rendered_token_count, context_order, ranges
            ) values (
              ${upgradeAssistantMessageId}, ${upgradeSourceKey}, 'single-answer',
              1, 0, ${JSON.stringify(reducedRanges)}::jsonb
            )
          `;
          const migration = yield* Effect.promise(() =>
            Bun.file(
              new URL(
                "../../../../db/migrations/0064_ai_chat_runtime_cutover.sql",
                import.meta.url,
              ),
            ).text(),
          );
          const firstCatalogWrite = migration.indexOf("create or replace function");
          expect(firstCatalogWrite).toBeGreaterThan(0);
          expect(migration.indexOf("AI chat schema cutover preflight row", firstCatalogWrite)).toBe(
            -1,
          );
          for (const blocker of [
            "stored source identity digest",
            "source-use identity digest",
            "source-use union does not equal",
            "document locator is not a closed canonical record",
            "memory locator is not a closed canonical record",
            "exposure has no exact attestation row",
            "provider measurement proof set has no exact attestation binding",
            "provider measurement has no matching usage row",
            "canonical publisher locator is not bound",
            "public provenance is not a closed canonical record",
          ]) {
            expect(migration.indexOf(blocker)).toBeGreaterThanOrEqual(0);
            expect(migration.indexOf(blocker)).toBeLessThan(firstCatalogWrite);
          }
          yield* sql`
            insert into ai_source_exposures (
              run_id, task_id, loop_iteration, attempt, provider_request_index,
              source_kind, logical_source_identity, publisher_issue_id,
              publisher_document_id, content_item_identity, exposure_stage,
              visible_token_count, document_source_id, document_id, document_version_id,
              document_content_hash, document_ranges
            ) values (
              ${upgradeRunId}, ${exposureTask}, 0, 0, 0, 'document',
              ${exposureLogicalIdentity}, ${issueId},
              ${documentId}, ${exposureContentItemIdentity},
              ${exposureStage}, ${exposureVisibleTokenCount}, ${`publisher:${subscriptionId}`},
              ${documentId}, ${versionId}, ${contentHash},
              ${JSON.stringify([{ charStart: 0, charEnd: canonicalText.length }])}::jsonb
            ), (
              ${upgradeRunId}, ${answerExposureTask}, 0, 0, 1, 'document',
              ${exposureLogicalIdentity}, ${issueId},
              ${documentId}, ${answerExposureContentItemIdentity},
              ${answerExposureStage}, ${exposureVisibleTokenCount}, ${`publisher:${subscriptionId}`},
              ${documentId}, ${versionId}, ${contentHash},
              ${JSON.stringify(reducedRanges)}::jsonb
            )
          `;
          yield* sql`
            insert into ai_observations (
              run_id, chat_id, emitting_task, loop_iteration, attempt,
              observation_key, kind, payload
            ) values (
              ${upgradeRunId}, ${upgradeChatId}, ${exposureTask}, 0, 0,
              ${exposureMeasurementKey}, 'provider_request_measurement',
              ${sql.json({
                agentRole: "internal_retrieval",
                modelId: "glm-5-turbo",
                requestSha256Hex: exposureProviderRequestHash,
                sourceExposureProofSha256Hexes: [exposureProof],
                sourceExposureProofBindings: [
                  {
                    providerSerializationProofSha256Hex: exposureProof,
                    providerSerializationProofBinding: exposureBinding,
                  },
                ],
                providerRequestIndex: 0,
                inputTokens: 1,
                requestedOutputTokens: 1,
                usableInputTokens: 1,
                contextWindow: 100,
                passed: true,
              })}
            )
          `;
          yield* sql`
            insert into ai_observations (
              run_id, chat_id, emitting_task, loop_iteration, attempt,
              observation_key, kind, payload
            ) values (
              ${upgradeRunId}, ${upgradeChatId}, ${exposureTask}, 0, 0,
              ${exposureAttestationKey}, 'source_exposure_attestation',
              ${sql.json({
                providerRequestIndex: 0,
                providerRequestSha256Hex: exposureProviderRequestHash,
                sourceKind: "document",
                logicalSourceIdentity: exposureLogicalIdentity,
                contentItemIdentity: exposureContentItemIdentity,
                exposureStage,
                visibleTokenCount: exposureVisibleTokenCount,
                providerSerializationProofSha256Hex: exposureProof,
                providerSerializationProofBinding: exposureBinding,
                documentSourceId: `publisher:${subscriptionId}`,
                documentId,
                versionId,
                documentContentHash: contentHash,
                documentRanges: initialRanges,
              })}
            )
          `;
          yield* sql`
            insert into ai_observations (
              run_id, chat_id, emitting_task, loop_iteration, attempt,
              observation_key, kind, payload
            ) values (
              ${upgradeRunId}, ${upgradeChatId}, ${answerExposureTask}, 0, 0,
              ${answerExposureAttestationKey}, 'source_exposure_attestation',
              ${sql.json({
                providerRequestIndex: 1,
                providerRequestSha256Hex: answerExposureProviderRequestHash,
                sourceKind: "document",
                logicalSourceIdentity: exposureLogicalIdentity,
                contentItemIdentity: answerExposureContentItemIdentity,
                exposureStage: answerExposureStage,
                visibleTokenCount: exposureVisibleTokenCount,
                providerSerializationProofSha256Hex: answerExposureProof,
                providerSerializationProofBinding: answerExposureBinding,
                documentSourceId: `publisher:${subscriptionId}`,
                documentId,
                versionId,
                documentContentHash: contentHash,
                documentRanges: reducedRanges,
              })}
            )
          `;
          yield* sql`
            insert into ai_run_usage (
              run_id, task_id, loop_iteration, attempt, provider_request_index,
              agent_role, model_id, provider_service_id, input_tokens, output_tokens,
              cached_tokens, reasoning_tokens, total_tokens, stop_reason
            ) values
              (${upgradeRunId}, ${exposureTask}, 0, 0, 0, 'internal_retrieval', 'glm-5-turbo',
               'deterministic_test', 1, 1, 0, 0, 2, 'stop'),
              (${upgradeRunId}, 'single-answer', 0, 0, 1, 'direct_answer', 'glm-5-turbo',
               'deterministic_test', 1, 1, 0, 0, 2, 'stop'),
              (${upgradeRunId}, 'plan-turn', 0, 0, 0, 'plan_turn', 'glm-5-turbo',
               'deterministic_test', 1, 1, 1, 0, 3, 'stop'),
              (${upgradeRunId}, 'memory-extract', 0, 0, 0, 'memory_extractor', 'glm-5-turbo',
               'deterministic_test', 1, 1, 0, 0, 2, 'stop')
          `;
          yield* sql`
            insert into ai_observations (
              run_id, chat_id, emitting_task, loop_iteration, attempt,
              observation_key, kind, payload
            ) values
              (${upgradeRunId}, ${upgradeChatId}, 'plan-turn', 0, 0,
               'plan-turn:0:0:turn_plan', 'turn_plan',
               ${sql.json({ mode: "single", question: "retained publisher answer", relevantTurnIds: [] })}),
              (${upgradeRunId}, ${upgradeChatId}, 'single-retrieve-internal', 0, 0,
               'single-retrieve-internal:0:0:retrieval_manifest:result', 'retrieval_manifest',
              ${sql.json(internalManifestPayload)}),
              (${upgradeRunId}, ${upgradeChatId}, 'single-select-memories', 0, 0,
               'single-select-memories:0:0:retrieval_manifest:result', 'retrieval_manifest',
               ${sql.json({ selectorRole: "memory", references: [], noCallReason: "memory_mode_disabled" })}),
              (${upgradeRunId}, ${upgradeChatId}, 'single-retrieve-web', 0, 0,
               'single-retrieve-web:0:0:retrieval_manifest:result', 'retrieval_manifest',
               ${sql.json({ selectorRole: "web", references: [], noCallReason: "web_policy_disabled" })}),
              (${upgradeRunId}, ${upgradeChatId}, 'finalize', 0, 0,
               'retrieval_no_call_seal:single-select-memories:0:0', 'retrieval_no_call_seal',
               ${sql.json({
                 selectorTaskId: "single-select-memories",
                 selectorLoopIteration: 0,
                 selectorAttempt: 0,
                 selectorObservationKey: "single-select-memories:0:0:retrieval_manifest:result",
                 noCallReason: "memory_mode_disabled",
               })}),
              (${upgradeRunId}, ${upgradeChatId}, 'finalize', 0, 0,
               'retrieval_no_call_seal:single-retrieve-web:0:0', 'retrieval_no_call_seal',
               ${sql.json({
                 selectorTaskId: "single-retrieve-web",
                 selectorLoopIteration: 0,
                 selectorAttempt: 0,
                 selectorObservationKey: "single-retrieve-web:0:0:retrieval_manifest:result",
                 noCallReason: "web_policy_disabled",
               })}),
              (${upgradeRunId}, ${upgradeChatId}, 'single-measure', 0, 0,
               'context:measure:initial', 'context_measurement',
               ${sql.json({
                 consumerTaskId: "single-answer",
                 mandatoryInputTokens: 1,
                 discretionaryInputTokens: 0,
                 totalInputTokens: 1,
                 requestedOutputTokens: 1,
                 usableInputTokens: 1,
                 contextWindow: 100,
                 status: "ready",
                 reductionRan: false,
                 reductionFeedback: [],
                 restrictedContextLedger: {
                   requestKind: "direct",
                   modelId: "glm-5-turbo",
                   requestSha256Hex: "a".repeat(64),
                   inputTokens: 1,
                   usableInputTokens: 1,
                   requestedOutputTokens: 1,
                   selectedConversation: [],
                   question: "retained publisher answer",
                   gaps: [],
                   sources: [
                     {
                       candidateId: documentId,
                       sourceKey: upgradeSourceKey,
                       kind: "document",
                       purpose: "grounding",
                       label: "Retained publisher document",
                       ranges: initialRanges,
                     },
                   ],
                 },
               })}),
              (${upgradeRunId}, ${upgradeChatId}, 'single-answer', 0, 0,
               'context:measure', 'context_measurement',
               ${sql.json({
                 consumerTaskId: "single-answer",
                 mandatoryInputTokens: 1,
                 discretionaryInputTokens: 0,
                 totalInputTokens: 1,
                 requestedOutputTokens: 1,
                 usableInputTokens: 1,
                 contextWindow: 100,
                 status: "ready",
                 reductionRan: false,
                 reductionFeedback: [],
                 restrictedContextLedger: {
                   requestKind: "direct",
                   modelId: "glm-5-turbo",
                   requestSha256Hex: "a".repeat(64),
                   inputTokens: 1,
                   usableInputTokens: 1,
                   requestedOutputTokens: 1,
                   selectedConversation: [],
                   question: "retained publisher answer",
                   gaps: [],
                   sources: [
                     {
                       candidateId: documentId,
                       sourceKey: upgradeSourceKey,
                       kind: "document",
                       purpose: "grounding",
                       label: "Retained publisher document",
                       ranges: reducedRanges,
                     },
                   ],
                 },
               })}),
              (${upgradeRunId}, ${upgradeChatId}, 'single-reduce-measure', 1, 0,
               'context:decision', 'context_decision',
               ${sql.json({
                 valid: true,
                 decisions: [
                   {
                     id: documentId,
                     action: "range",
                     ranges: reducedRanges,
                     reason: "kept the relevant passage",
                   },
                 ],
                 feedback: [],
               })}),
              (${upgradeRunId}, ${upgradeChatId}, 'single-answer', 0, 0,
               'context:serialized', 'context_serialized',
               ${sql.json({
                 consumerTaskId: "single-answer",
                 sourceKeys: [upgradeSourceKey],
                 restrictedContextLedger: {
                   requestKind: "direct",
                   modelId: "glm-5-turbo",
                   requestSha256Hex: "a".repeat(64),
                   inputTokens: 1,
                   usableInputTokens: 1,
                   requestedOutputTokens: 1,
                   selectedConversation: [],
                   question: "retained publisher answer",
                   gaps: [],
                   sources: [
                     {
                       candidateId: documentId,
                       sourceKey: upgradeSourceKey,
                       kind: "document",
                       purpose: "grounding",
                       label: "Retained publisher document",
                       ranges: reducedRanges,
                     },
                   ],
                 },
                 terminalUsageCoordinate: {
                   taskId: "single-answer",
                   loopIteration: 0,
                   attempt: 0,
                   providerRequestIndex: 1,
                 },
               })}),
              (${upgradeRunId}, ${upgradeChatId}, 'single-answer', 0, 0,
               'provider_request_measurement:single-answer:0:0:1', 'provider_request_measurement',
               ${sql.json({
                 agentRole: "direct_answer",
                 modelId: "glm-5-turbo",
                 requestSha256Hex: "a".repeat(64),
                 sourceExposureProofSha256Hexes: [answerExposureProof],
                 sourceExposureProofBindings: [
                   {
                     providerSerializationProofSha256Hex: answerExposureProof,
                     providerSerializationProofBinding: answerExposureBinding,
                   },
                 ],
                 providerRequestIndex: 1,
                 inputTokens: 1,
                 requestedOutputTokens: 1,
                 usableInputTokens: 1,
                 contextWindow: 100,
                 passed: true,
               })})
          `;
          yield* sql`
            insert into ai_observations (
              run_id, chat_id, emitting_task, loop_iteration, attempt,
              observation_key, kind, payload
            ) values
              (${upgradeRunId}, ${upgradeChatId}, 'plan-turn', 0, 0,
               'provider_request_measurement:plan-turn:0:0:0', 'provider_request_measurement',
               ${sql.json({
                 agentRole: "plan_turn",
                 modelId: "glm-5-turbo",
                 requestSha256Hex: "b".repeat(64),
                 sourceExposureProofSha256Hexes: [],
                 providerRequestIndex: 0,
                 inputTokens: 2,
                 requestedOutputTokens: 1,
                 usableInputTokens: 2,
                 contextWindow: 100,
                 passed: true,
               })}),
              (${upgradeRunId}, ${upgradeChatId}, 'memory-extract', 0, 0,
               'provider_request_measurement:memory-extract:0:0:0', 'provider_request_measurement',
               ${sql.json({
                 agentRole: "memory_extractor",
                 modelId: "glm-5-turbo",
                 requestSha256Hex: "c".repeat(64),
                 sourceExposureProofSha256Hexes: [],
                 providerRequestIndex: 0,
                 inputTokens: 1,
                 requestedOutputTokens: 1,
                 usableInputTokens: 1,
                 contextWindow: 100,
                 passed: true,
               })})
          `;
          yield* sql`
            insert into ai_observations (
              run_id, chat_id, emitting_task, loop_iteration, attempt,
              observation_key, kind, payload
            ) values
              (${upgradeRunId}, ${upgradeChatId}, 'memory-extract', 0, 0,
               'memory-extract:0:0:memory_extraction_result:result', 'memory_extraction_result',
               ${sql.json({ proposalCount: 0, discardedCount: 0, extractionSha256Hex: "d".repeat(64) })}),
              (${upgradeRunId}, ${upgradeChatId}, 'finalize', 0, 0,
               'finalize:0:0:memory_application:result', 'memory_application',
               ${sql.json({
                 extractionTaskId: "memory-extract",
                 extractionLoopIteration: 0,
                 extractionAttempt: 0,
                 extractionObservationKey: "memory-extract:0:0:memory_extraction_result:result",
                 extractionSha256Hex: "d".repeat(64),
                 proposalCount: 0,
                 discardedCount: 0,
               })}),
              (${upgradeRunId}, ${upgradeChatId}, 'single-answer', 0, 0,
               'answer:completed', 'answer_completed',
               ${sql.json({ mode: "single", attempt: 0 })})
          `;
          yield* sql`
            insert into ai_run_events (run_id, seq, event, emitted_by_task, emission_key)
            values
              (${upgradeRunId}, 1, ${sql.json({ type: "run_started" })}, null, 'run_started'),
              (${upgradeRunId}, 2, ${sql.json({
                type: "context_ready",
                mode: "single",
                reductionRan: true,
                sourcesRead: [
                  {
                    sourceKey: upgradeSourceKey,
                    label: "Retained publisher document",
                    tokenCount: 1,
                    topicIds: [],
                    kind: "document",
                    sourceName: "Upgrade publisher",
                    issueTitle: "0063 retained issue",
                    documentTitle: "0063 retained document",
                    url: `/v1/issues/${issueId}/documents/${documentId}/content`,
                    publishedAt: "2026-07-01T00:00:00.000Z",
                    ranges: reducedRanges,
                  },
                ],
                consumers: [
                  {
                    consumer: "direct",
                    inputTokens: 1,
                    requestedOutputTokens: 1,
                    usableInputTokens: 1,
                  },
                ],
              })}, 'single-answer', 'context_ready'),
              (${upgradeRunId}, 3, ${sql.json({ type: "answer_started", mode: "single", attempt: 0 })}, 'single-answer', 'answer_started:single-answer:0'),
              (${upgradeRunId}, 4, ${sql.json({ type: "text_delta", delta: `Retained [[cite:${upgradeSourceKey}]]` })}, 'single-answer', 'text_delta:single-answer:0:0'),
              (${upgradeRunId}, 6, ${sql.json({ type: "usage", scope: "request", kind: "model", role: "internal_retrieval", attempt: 0, inputTokens: 1, outputTokens: 1, cachedTokens: 0, reasoningTokens: 0, totalTokens: 2 })}, ${exposureTask}, 'usage:request:model:single-retrieve-internal:0:0:0'),
              (${upgradeRunId}, 7, ${sql.json({ type: "usage", scope: "request", kind: "model", role: "direct_answer", attempt: 0, inputTokens: 1, outputTokens: 1, cachedTokens: 0, reasoningTokens: 0, totalTokens: 2 })}, 'single-answer', 'usage:request:model:single-answer:0:0:1'),
              (${upgradeRunId}, 8, ${sql.json({ type: "usage", scope: "request", kind: "model", role: "plan_turn", attempt: 0, inputTokens: 1, outputTokens: 1, cachedTokens: 1, reasoningTokens: 0, totalTokens: 3 })}, 'plan-turn', 'usage:request:model:plan-turn:0:0:0'),
              (${upgradeRunId}, 9, ${sql.json({ type: "usage", scope: "request", kind: "model", role: "memory_extractor", attempt: 0, inputTokens: 1, outputTokens: 1, cachedTokens: 0, reasoningTokens: 0, totalTokens: 2 })}, 'memory-extract', 'usage:request:model:memory-extract:0:0:0'),
              (${upgradeRunId}, 10, ${sql.json({ type: "memory_updated", created: 0, updated: 0, discarded: 0 })}, 'finalize', 'memory_updated'),
              (${upgradeRunId}, 11, ${sql.json({ type: "usage", scope: "run", model: { inputTokens: 4, outputTokens: 4, cachedTokens: 1, reasoningTokens: 0, totalTokens: 9, requestCount: 4 }, web: { searchCount: 0, fetchCount: 0, responseBytes: 0, billedUnits: 0 } })}, 'finalize', 'usage:run'),
              (${upgradeRunId}, 12, ${sql.json({ type: "done", assistantMessageId: upgradeAssistantMessageId })}, 'finalize', 'terminal')
          `;
          yield* sql`
            delete from ai_observations
            where run_id = ${upgradeRunId}
              and (emitting_task = 'memory-extract' or kind = 'memory_application')
          `;
          yield* sql`
            delete from ai_run_usage
            where run_id = ${upgradeRunId} and task_id = 'plan-turn'
          `;
          yield* sql`
            delete from ai_run_events
            where run_id = ${upgradeRunId}
              and emission_key = 'usage:request:model:plan-turn:0:0:0'
          `;
          const routeBlock = yield* Effect.exit(sql.unsafe(migration).raw);
          expect(routeBlock._tag).toBe("Failure");
          expect(errorText(routeBlock)).toContain(`ai_runs/${upgradeRunId}`);
          expect(errorText(routeBlock)).toContain(
            "successful run has no coherent plan and memory route",
          );
          const helpersAfterRouteBlock = yield* sql<{ readonly count: number }>`
            select count(*)::int as count
            from pg_proc
            where pronamespace = 'public'::regnamespace
              and proname in (
                'brief_ai_safe_bigint', 'brief_ai_utf16_length', 'brief_ai_legacy_json_key',
                'brief_ai_valid_restricted_context_ledger', 'brief_ai_valid_terminal_usage_coordinate',
                'brief_ai_normalize_ranges'
              )
          `;
          expect(helpersAfterRouteBlock[0]?.count).toBe(0);
          yield* sql`
            delete from ai_run_usage
            where run_id = ${upgradeRunId} and task_id = 'memory-extract'
          `;
          yield* sql`
            delete from ai_run_events
            where run_id = ${upgradeRunId}
              and emission_key = 'usage:request:model:memory-extract:0:0:0'
          `;
          yield* sql`
            insert into ai_run_usage (
              run_id, task_id, loop_iteration, attempt, provider_request_index,
              agent_role, model_id, provider_service_id, input_tokens, output_tokens,
              cached_tokens, reasoning_tokens, total_tokens, stop_reason
            ) values
            (
              ${upgradeRunId}, 'plan-turn', 0, 0, 0, 'plan_turn', 'glm-5-turbo',
              'deterministic_test', 1, 1, 1, 0, 3, 'stop'
            ), (
              ${upgradeRunId}, 'memory-extract', 0, 0, 0, 'memory_extractor', 'glm-5-turbo',
              'deterministic_test', 1, 1, 0, 0, 2, 'stop'
            )
          `;
          yield* sql`
            insert into ai_observations (
              run_id, chat_id, emitting_task, loop_iteration, attempt,
              observation_key, kind, payload
            ) values
              (${upgradeRunId}, ${upgradeChatId}, 'memory-extract', 0, 0,
               'provider_request_measurement:memory-extract:0:0:0', 'provider_request_measurement',
               ${sql.json({
                 agentRole: "memory_extractor",
                 modelId: "glm-5-turbo",
                 requestSha256Hex: "c".repeat(64),
                 sourceExposureProofSha256Hexes: [],
                 providerRequestIndex: 0,
                 inputTokens: 1,
                 requestedOutputTokens: 1,
                 usableInputTokens: 1,
                 contextWindow: 100,
                 passed: true,
               })}),
              (${upgradeRunId}, ${upgradeChatId}, 'memory-extract', 0, 0,
               'memory-extract:0:0:memory_extraction_result:result', 'memory_extraction_result',
               ${sql.json({ proposalCount: 0, discardedCount: 0, extractionSha256Hex: "d".repeat(64) })}),
              (${upgradeRunId}, ${upgradeChatId}, 'finalize', 0, 0,
               'finalize:0:0:memory_application:result', 'memory_application',
               ${sql.json({
                 extractionTaskId: "memory-extract",
                 extractionLoopIteration: 0,
                 extractionAttempt: 0,
                 extractionObservationKey: "memory-extract:0:0:memory_extraction_result:result",
                 extractionSha256Hex: "d".repeat(64),
                 proposalCount: 0,
                 discardedCount: 0,
               })})
          `;
          yield* sql`
            insert into ai_run_events (run_id, seq, event, emitted_by_task, emission_key)
            values
            (
              ${upgradeRunId}, 8,
              ${sql.json({ type: "usage", scope: "request", kind: "model", role: "plan_turn", attempt: 0, inputTokens: 1, outputTokens: 1, cachedTokens: 1, reasoningTokens: 0, totalTokens: 3 })},
              'plan-turn', 'usage:request:model:plan-turn:0:0:0'
            ), (
              ${upgradeRunId}, 9,
              ${sql.json({ type: "usage", scope: "request", kind: "model", role: "memory_extractor", attempt: 0, inputTokens: 1, outputTokens: 1, cachedTokens: 0, reasoningTokens: 0, totalTokens: 2 })},
              'memory-extract', 'usage:request:model:memory-extract:0:0:0'
            )
          `;
          yield* sql`
            insert into assistant_message_sources (
              assistant_message_id, source_key, kind, locator,
              document_version_id, publisher_document_version_id, display_label, public_provenance
            ) values (
              ${upgradeAssistantMessageId}, ${sourceWithoutUseKey}, 'document',
              ${sql.json({
                kind: "document",
                sourceId: `publisher:${subscriptionId}`,
                documentId,
                versionId: versionId,
                contentHash,
                ranges: [{ charStart: 0, charEnd: canonicalText.length }],
                publisherIssueId: issueId,
                publisherDocumentId: documentId,
              })}, ${versionId}, ${versionId}, 'Unreferenced publisher document', ${sql.json({
                sourceName: "Upgrade publisher",
                issueTitle: "0063 retained issue",
                documentTitle: "0063 retained document",
                citationUrl: `/v1/issues/${issueId}/documents/${documentId}/content`,
                publishedAt: "2026-07-01T00:00:00.000Z",
              })}
            )
          `;
          const sourceUseBlock = yield* Effect.exit(sql.unsafe(migration).raw);
          expect(sourceUseBlock._tag).toBe("Failure");
          expect(errorText(sourceUseBlock)).toContain(
            `assistant_message_sources/${upgradeAssistantMessageId}/${sourceWithoutUseKey}`,
          );
          expect(errorText(sourceUseBlock)).toContain("source has no canonical answer use");
          const helpersAfterSourceUseBlock = yield* sql<{
            readonly count: number;
            readonly finalColumns: number;
          }>`
            select
              (
                  select count(*)::int
                  from pg_proc
                  where pronamespace = 'public'::regnamespace
                  and proname = 'brief_ai_safe_bigint'
              ) as count,
              (
                select count(*)::int
                from information_schema.columns
                where table_schema = 'public'
                  and table_name = 'assistant_message_sources'
                  and column_name = 'version_id'
              ) as "finalColumns"
          `;
          expect(helpersAfterSourceUseBlock[0]?.count).toBe(0);
          expect(helpersAfterSourceUseBlock[0]?.finalColumns).toBe(0);
          yield* sql`alter table assistant_message_sources disable trigger user`;
          yield* sql`
            delete from assistant_message_sources
            where assistant_message_id = ${upgradeAssistantMessageId}
              and source_key = ${sourceWithoutUseKey}
          `;
          yield* sql`alter table assistant_message_sources enable trigger user`;
          yield* sql`
            update ai_observations
            set kind = 'candidate_rejected',
                payload = ${sql.json({ candidateId: "publisher:missing", reason: "missing" })}
            where run_id = ${upgradeRunId}
              and emitting_task = 'single-retrieve-internal'
              and observation_key = 'single-retrieve-internal:0:0:retrieval_manifest:result'
          `;
          const missingManifestBlock = yield* Effect.exit(sql.unsafe(migration).raw);
          expect(errorText(missingManifestBlock)).toContain(`ai_runs/${upgradeRunId}`);
          expect(errorText(missingManifestBlock)).toContain(
            "successful run is missing terminal retrieval manifest",
          );
          yield* sql`
            update ai_observations
            set kind = 'retrieval_manifest', payload = ${sql.json(internalManifestPayload)}
            where run_id = ${upgradeRunId}
              and emitting_task = 'single-retrieve-internal'
              and observation_key = 'single-retrieve-internal:0:0:retrieval_manifest:result'
          `;
          yield* sql`
            insert into ai_observations (
              run_id, chat_id, emitting_task, loop_iteration, attempt,
              observation_key, kind, payload
            )
            select run_id, chat_id, 'single-answer', 0, 0,
                   'single-answer:0:0:retrieval_manifest:result', kind, payload
            from ai_observations
            where run_id = ${upgradeRunId}
              and observation_key = 'single-retrieve-internal:0:0:retrieval_manifest:result'
          `;
          const wrongOwnerManifestBlock = yield* Effect.exit(sql.unsafe(migration).raw);
          expect(errorText(wrongOwnerManifestBlock)).toContain(`ai_runs/${upgradeRunId}`);
          expect(errorText(wrongOwnerManifestBlock)).toContain(
            "retrieval manifest owner is outside selected route",
          );
          yield* sql`
            delete from ai_observations
            where run_id = ${upgradeRunId}
              and observation_key = 'single-answer:0:0:retrieval_manifest:result'
          `;
          yield* sql`
            update ai_observations
            set payload = jsonb_set(payload, '{selectorRole}', '"memory"'::jsonb)
            where run_id = ${upgradeRunId}
              and observation_key = 'single-retrieve-internal:0:0:retrieval_manifest:result'
          `;
          const wrongRoleManifestBlock = yield* Effect.exit(sql.unsafe(migration).raw);
          expect(errorText(wrongRoleManifestBlock)).toContain(`ai_runs/${upgradeRunId}`);
          expect(errorText(wrongRoleManifestBlock)).toContain(
            "retrieval manifest selector role does not match its owner",
          );
          yield* sql`
            update ai_observations
            set payload = ${sql.json(internalManifestPayload)}
            where run_id = ${upgradeRunId}
              and observation_key = 'single-retrieve-internal:0:0:retrieval_manifest:result'
          `;
          const [internalManifest] = yield* sql<{ readonly id: string }>`
            select id::text as id
            from ai_observations
            where run_id = ${upgradeRunId}
              and observation_key = 'single-retrieve-internal:0:0:retrieval_manifest:result'
          `;
          yield* sql`
            update ai_observations
            set payload = jsonb_set(
              payload,
              '{references,0,publisherExtractionId}',
              to_jsonb(${crypto.randomUUID()}::text),
              true
            )
            where id = ${internalManifest?.id}::uuid
          `;
          const wrongSelectorExtraction = yield* Effect.exit(sql.unsafe(migration).raw);
          expect(errorText(wrongSelectorExtraction)).toContain(
            `ai_observations/${internalManifest?.id}/1`,
          );
          expect(errorText(wrongSelectorExtraction)).toContain(
            "terminal selector reference lacks its exact selector-owned exposure and provider proof coordinate",
          );
          const selectorExtractionFence = yield* sql<{
            readonly helpers: number;
            readonly finalColumns: number;
          }>`
            select
              (select count(*)::int from pg_proc where pronamespace = 'public'::regnamespace and proname = 'brief_ai_safe_bigint') as helpers,
              (select count(*)::int from information_schema.columns where table_schema = 'public' and table_name = 'assistant_message_sources' and column_name = 'version_id') as "finalColumns"
          `;
          expect(selectorExtractionFence).toEqual([{ helpers: 0, finalColumns: 0 }]);
          yield* sql`
            update ai_observations
            set payload = ${sql.json(internalManifestPayload)}
            where id = ${internalManifest?.id}::uuid
          `;
          yield* sql`
            delete from ai_run_events
            where run_id = ${upgradeRunId} and emission_key = 'context_ready'
          `;
          const terminalEventsBlock = yield* Effect.exit(sql.unsafe(migration).raw);
          expect(errorText(terminalEventsBlock)).toContain(`ai_runs/${upgradeRunId}`);
          expect(errorText(terminalEventsBlock)).toContain(
            "successful terminal event order or cardinality is incomplete",
          );
          yield* sql`
            insert into ai_run_events (run_id, seq, event, emitted_by_task, emission_key)
            values (
              ${upgradeRunId}, 2, ${sql.json({
                type: "context_ready",
                mode: "single",
                reductionRan: true,
                sourcesRead: [
                  {
                    sourceKey: upgradeSourceKey,
                    label: "Retained publisher document",
                    tokenCount: 1,
                    topicIds: [],
                    kind: "document",
                    sourceName: "Upgrade publisher",
                    issueTitle: "0063 retained issue",
                    documentTitle: "0063 retained document",
                    url: `/v1/issues/${issueId}/documents/${documentId}/content`,
                    publishedAt: "2026-07-01T00:00:00.000Z",
                    ranges: reducedRanges,
                  },
                ],
                consumers: [
                  {
                    consumer: "direct",
                    inputTokens: 1,
                    requestedOutputTokens: 1,
                    usableInputTokens: 1,
                  },
                ],
              })}, 'single-answer', 'context_ready')
          `;
          yield* sql`
            update ai_run_events
            set seq = -1
            where run_id = ${upgradeRunId}
              and emission_key = 'terminal'
          `;
          const outOfOrderTerminal = yield* Effect.exit(sql.unsafe(migration).raw);
          expect(errorText(outOfOrderTerminal)).toContain(`ai_runs/${upgradeRunId}`);
          expect(errorText(outOfOrderTerminal)).toContain(
            "successful terminal event order or cardinality is incomplete",
          );
          yield* sql`
            update ai_run_events
            set seq = 12
            where run_id = ${upgradeRunId}
              and emission_key = 'terminal'
          `;
          yield* sql`
            delete from ai_run_usage
            where run_id = ${upgradeRunId} and task_id = 'single-answer'
          `;
          const measurementUsageBlock = yield* Effect.exit(sql.unsafe(migration).raw);
          expect(errorText(measurementUsageBlock)).toContain(`ai_runs/${upgradeRunId}`);
          expect(errorText(measurementUsageBlock)).toContain(
            "request usage event has no exact provider usage owner",
          );
          yield* sql`
            insert into ai_run_usage (
              run_id, task_id, loop_iteration, attempt, provider_request_index,
              agent_role, model_id, provider_service_id, input_tokens, output_tokens,
              cached_tokens, reasoning_tokens, total_tokens, stop_reason
            ) values (
              ${upgradeRunId}, 'single-answer', 0, 0, 1, 'direct_answer', 'glm-5-turbo',
              'deterministic_test', 1, 1, 0, 0, 2, 'stop'
            )
          `;
          const invalidProvenance = {};
          yield* sql`alter table assistant_message_sources disable trigger user`;
          yield* sql`
            update assistant_message_sources
            set public_provenance = ${sql.json(invalidProvenance)},
                source_identity_digest = assistant_message_source_identity_digest(
                  assistant_message_id, source_key, kind, locator,
                  document_version_id, publisher_document_version_id,
                  message_id, memory_revision_id, display_label, ${sql.json(invalidProvenance)}
                )
            where assistant_message_id = ${upgradeAssistantMessageId}
              and source_key = ${upgradeSourceKey}
          `;
          yield* sql`alter table assistant_message_sources enable trigger user`;
          const provenanceBlock = yield* Effect.exit(sql.unsafe(migration).raw);
          expect(provenanceBlock._tag).toBe("Failure");
          expect(errorText(provenanceBlock)).toContain(
            `assistant_message_sources/${upgradeAssistantMessageId}/${upgradeSourceKey}`,
          );
          expect(errorText(provenanceBlock)).toContain(
            "public provenance is not a closed canonical record",
          );
          const helpersAfterProvenanceBlock = yield* sql<{
            readonly count: number;
            readonly finalColumns: number;
          }>`
            select
              (
                select count(*)::int
                from pg_proc
                where pronamespace = 'public'::regnamespace
                  and proname in (
                    'brief_ai_safe_bigint', 'brief_ai_utf16_length', 'brief_ai_legacy_json_key',
                    'brief_ai_valid_restricted_context_ledger', 'brief_ai_valid_terminal_usage_coordinate',
                    'brief_ai_normalize_ranges'
                  )
              ) as count,
              (
                select count(*)::int
                from information_schema.columns
                where table_schema = 'public'
                  and table_name = 'assistant_message_sources'
                  and column_name = 'version_id'
              ) as "finalColumns"
          `;
          expect(helpersAfterProvenanceBlock[0]?.count).toBe(0);
          expect(helpersAfterProvenanceBlock[0]?.finalColumns).toBe(0);
          const validProvenance = {
            sourceName: "Upgrade publisher",
            issueTitle: "0063 retained issue",
            documentTitle: "0063 retained document",
            citationUrl: `/v1/issues/${issueId}/documents/${documentId}/content`,
            publishedAt: "2026-07-01T00:00:00.000Z",
          };
          yield* sql`alter table assistant_message_sources disable trigger user`;
          yield* sql`
            update assistant_message_sources
            set public_provenance = ${sql.json(validProvenance)},
                source_identity_digest = assistant_message_source_identity_digest(
                  assistant_message_id, source_key, kind, locator,
                  document_version_id, publisher_document_version_id,
                  message_id, memory_revision_id, display_label, ${sql.json(validProvenance)}
                )
            where assistant_message_id = ${upgradeAssistantMessageId}
              and source_key = ${upgradeSourceKey}
          `;
          yield* sql`alter table assistant_message_sources enable trigger user`;
          // The second run sees only canonical version_id/content_hash
          // exposure columns and must still accept the populated ledger.
          yield* sql.unsafe(migration).raw;
        }),
      );
      const binding = await runDb(
        databaseUrl,
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return yield* sql<{
            readonly extractionId: string;
            readonly versionId: string;
            readonly sourceKey: string;
            readonly locatorExtractionId: string;
          }>`
            select
              versions.publisher_extraction_id::text as "extractionId",
              versions.id::text as "versionId",
              sources.source_key as "sourceKey",
              sources.locator->>'publisherExtractionId' as "locatorExtractionId"
            from brief_document_versions versions
            join assistant_message_sources sources
              on sources.version_id = versions.id::text
            where versions.id = ${versionId}
          `;
        }),
      );
      expect(binding).toEqual([
        {
          extractionId,
          versionId,
          sourceKey: `k_cn_${upgradeNonce.toString("base64url")}_1`,
          locatorExtractionId: extractionId,
        },
      ]);
    } finally {
      await runDb(
        adminDatabaseUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`select pg_terminate_backend(pid) from pg_stat_activity where datname = ${databaseName}`;
          yield* sql.unsafe(`drop database if exists ${quoteIdentifier(databaseName)}`);
        }),
      );
    }
  }, 120_000);

  it(
    "accepts canonical provenance for every retained source kind and blocks one-field mutations",
    { timeout: 120_000 },
    async () => {
      const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
      const databaseName = `brief_migrations_provenance_${process.pid}_${suffix}`;
      const databaseUrl = databaseUrlForName(databaseName);
      const ids = {
        user: `provenance-user-${suffix}`,
        company: crypto.randomUUID(),
        chat: crypto.randomUUID(),
        userMessage: crypto.randomUUID(),
        assistantMessage: crypto.randomUUID(),
        run: crypto.randomUUID(),
        memory: crypto.randomUUID(),
        memoryRevision: crypto.randomUUID(),
        publicSource: `provenance-source-${suffix}`,
        publicDocument: `provenance-document-${suffix}`,
        rawArtifact: crypto.randomUUID(),
      };
      const legacyNamespaceBytes = Buffer.from(`provenance-${suffix}`).subarray(0, 16);
      const citationNamespace = legacyNamespaceBytes.toString("base64url");
      const sourceKeys = {
        chat: `k_${citationNamespace}_1`,
        memory: `k_${citationNamespace}_2`,
        web: `k_${citationNamespace}_3`,
        document: `k_${citationNamespace}_4`,
      };
      const publicUrl = "https://example.test/provenance-document";
      const webUrl = "https://example.test/provenance-web";
      const publicText = "A public document retained for provenance checks. ".repeat(3);
      const webQuote = "A web quotation retained for provenance checks.";
      const webQuoteHash = createHash("sha256").update(webQuote).digest("base64url");
      const validWebLocator = {
        kind: "web",
        url: webUrl,
        title: "Provenance web page",
        domain: "example.test",
        quote: webQuote,
        quoteHash: webQuoteHash,
        capturedAt: "2026-07-01T00:00:00.000Z",
      } as const;
      const validProvenance = {
        chat: {},
        memory: {},
        web: { citationUrl: webUrl },
        document: { documentTitle: "Public provenance document", citationUrl: publicUrl },
      } as const;
      const nonCanonicalWebUrl = "https://example.test";
      const invalidWebLocator = { ...validWebLocator, url: nonCanonicalWebUrl };
      const invalidWebProvenance = { citationUrl: nonCanonicalWebUrl };
      const nonCanonicalPublicUrl = "https://example.test";
      const invalidPublicProvenance = {
        documentTitle: "Public provenance document",
        citationUrl: nonCanonicalPublicUrl,
      };

      await runDb(
        adminDatabaseUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql.unsafe(`create database ${quoteIdentifier(databaseName)}`);
        }),
      );

      try {
        await runDb(
          databaseUrl,
          applyMigrationsThrough("0063_immutable_document_exposure_evidence.sql"),
        );
        await runDb(
          databaseUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
              insert into platform_users (id, primary_email, display_name, clerk_user_id)
              values (${ids.user}, ${`${ids.user}@example.test`}, 'Provenance user', ${`clerk-${ids.user}`})
            `;
            yield* sql`
              insert into client_companies (id, name) values (${ids.company}, 'Provenance company')
            `;
            yield* sql`
              insert into client_company_memberships (company_id, user_id, role)
              values (${ids.company}, ${ids.user}, 'admin')
            `;
            yield* sql`
              insert into chats (id, user_id, company_id, memory_mode)
              values (${ids.chat}, ${ids.user}, ${ids.company}, 'disabled')
            `;
            yield* sql`
              insert into chat_messages (id, chat_id, author, content)
              values (${ids.userMessage}, ${ids.chat}, 'user', 'Provenance fixture')
            `;
            yield* sql`
              insert into ai_runs (
                id, chat_id, initiating_user_id, user_message_id, locale, market,
                citation_nonce, effective_web_policy
              ) values (
                ${ids.run}, ${ids.chat}, ${ids.user}, ${ids.userMessage}, 'en-US', 'US',
                decode(${legacyNamespaceBytes.toString("base64")}, 'base64'),
                ${sql.json({ enabled: true, reason: null, allowlistActive: false })}
              )
            `;
            yield* sql`
              insert into ai_run_events (run_id, seq, event, emitted_by_task, emission_key)
              values
                (${ids.run}, 1, ${sql.json({ type: "run_started" })}, null, 'run_started'),
                (${ids.run}, 2, ${sql.json({
                  type: "usage",
                  scope: "run",
                  model: {
                    inputTokens: 0,
                    outputTokens: 0,
                    cachedTokens: 0,
                    reasoningTokens: 0,
                    totalTokens: 0,
                    requestCount: 0,
                  },
                  web: { searchCount: 0, fetchCount: 0, responseBytes: 0, billedUnits: 0 },
                })}, 'failure-handler', 'usage:run'),
                (${ids.run}, 3, ${sql.json({ type: "error", code: "fixture_failure", retryable: false })}, 'failure-handler', 'terminal')
            `;
            yield* sql`
              insert into chat_messages (id, chat_id, author, content, assistant_ai_run_id)
              values (
                ${ids.assistantMessage}, ${ids.chat}, 'assistant',
                ${`Answer [[cite:${sourceKeys.chat}]] [[cite:${sourceKeys.memory}]] [[cite:${sourceKeys.web}]] [[cite:${sourceKeys.document}]]`},
                ${ids.run}
              )
            `;
            yield* sql`update ai_runs set assistant_message_id = ${ids.assistantMessage} where id = ${ids.run}`;
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`
                  insert into user_memories (id, user_id, kind, content, head_revision_id)
                  values (
                    ${ids.memory}, ${ids.user}, 'preference', 'Retain this provenance fixture', ${ids.memoryRevision}
                  )
                `;
                yield* sql`
                  insert into user_memory_revisions (
                    id, memory_id, action, state_before, state_after, run_id
                  ) values (
                    ${ids.memoryRevision}, ${ids.memory}, 'create', null,
                    ${sql.json({ kind: "preference", content: "Retain this provenance fixture", deleted: false })},
                    null
                  )
                `;
              }),
            );
            yield* sql`
              insert into public_sources (
                source_id, display_name, publisher_name, description,
                ingestion_method, discovery_url, average_chars_per_item
              ) values (
                ${ids.publicSource}, 'Provenance source', 'Provenance publisher',
                'Migration provenance fixture', 'rss', ${publicUrl}, 1000
              )
            `;
            yield* sql`
              insert into public_source_raw_artifacts (
                id, source_id, canonical_url, fetched_at, media_type, body, body_hash
              ) values (
                ${ids.rawArtifact}, ${ids.publicSource}, ${publicUrl}, now(), 'text/html',
                ${`<main>${publicText}</main>`},
                encode(digest(convert_to(${`<main>${publicText}</main>`}, 'UTF8'), 'sha256'), 'hex')
              )
            `;
            yield* sql`
              insert into public_source_documents (
                document_id, source_id, canonical_url, title, discovered_at, fetched_at,
                language, document_type, text, text_char_count, content_hash, raw_artifact_id
              ) values (
                ${ids.publicDocument}, ${ids.publicSource}, ${publicUrl}, 'Public provenance document',
                now(), now(), 'en', 'html', ${publicText}, ${publicText.length},
                encode(digest(convert_to(${publicText}, 'UTF8'), 'sha256'), 'hex'), ${ids.rawArtifact}
              )
            `;
            yield* sql`
              insert into assistant_message_sources (
                assistant_message_id, source_key, kind, locator,
                document_version_id, message_id, memory_revision_id, display_label, public_provenance
              ) values
                (
                  ${ids.assistantMessage}, ${sourceKeys.chat}, 'chat_message',
                  ${sql.json({ kind: "chat_message", messageId: ids.userMessage })},
                  null, ${ids.userMessage}, null, 'Chat provenance', ${sql.json(validProvenance.chat)}
                ),
                (
                  ${ids.assistantMessage}, ${sourceKeys.memory}, 'memory',
                  ${sql.json({ kind: "memory", memoryId: ids.memory, memoryRevisionId: ids.memoryRevision })},
                  null, null, ${ids.memoryRevision}, 'Memory provenance', ${sql.json(validProvenance.memory)}
                ),
                (
                  ${ids.assistantMessage}, ${sourceKeys.web}, 'web',
                  ${sql.json(validWebLocator)},
                  null, null, null, 'Web provenance', ${sql.json(validProvenance.web)}
                ),
                (
                  ${ids.assistantMessage}, ${sourceKeys.document}, 'document',
                  ${sql.json({
                    kind: "document",
                    sourceId: `public:${ids.publicSource}`,
                    documentId: ids.publicDocument,
                    versionId: ids.publicDocument,
                    contentHash: createHash("sha256").update(publicText).digest("hex"),
                    ranges: [{ charStart: 0, charEnd: publicText.length }],
                  })},
                  ${ids.publicDocument}, null, null, 'Public provenance document', ${sql.json(validProvenance.document)}
                )
            `;
            yield* sql`
            insert into assistant_message_source_uses (
                assistant_message_id, source_key, consumer_task_id, topic_id,
                rendered_token_count, context_order, ranges
              ) values
                (${ids.assistantMessage}, ${sourceKeys.chat}, 'topic-t1-answer', 't1', 0, 0, '[]'::jsonb),
                (${ids.assistantMessage}, ${sourceKeys.memory}, 'topic-t1-answer', 't1', 0, 1, '[]'::jsonb),
                (${ids.assistantMessage}, ${sourceKeys.web}, 'topic-t1-answer', 't1', 0, 2, '[]'::jsonb),
                (${ids.assistantMessage}, ${sourceKeys.document}, 'topic-t1-answer', 't1', 0, 3,
                  ${JSON.stringify([{ charStart: 0, charEnd: publicText.length }])}::jsonb)
            `;
          }),
        );

        const migration = await Bun.file(
          new URL("../../../../db/migrations/0064_ai_chat_runtime_cutover.sql", import.meta.url),
        ).text();
        const invalidCases = [
          { sourceKey: sourceKeys.chat, provenance: { documentTitle: "forbidden" } },
          {
            sourceKey: sourceKeys.memory,
            provenance: { citationUrl: "https://example.test/forbidden" },
          },
          {
            sourceKey: sourceKeys.web,
            provenance: { citationUrl: "https://example.test/forbidden" },
          },
          {
            sourceKey: sourceKeys.web,
            provenance: { citationUrl: webUrl, documentTitle: "forbidden" },
          },
          {
            sourceKey: sourceKeys.document,
            provenance: {
              documentTitle: "Public provenance document",
              citationUrl: "https://example.test/forbidden",
            },
          },
          {
            sourceKey: sourceKeys.document,
            provenance: {
              documentTitle: "Public provenance document",
              citationUrl: publicUrl,
              unknownField: "forbidden",
            },
          },
        ];
        const validBySourceKey = new Map<string, object>([
          [sourceKeys.chat, validProvenance.chat],
          [sourceKeys.memory, validProvenance.memory],
          [sourceKeys.web, validProvenance.web],
          [sourceKeys.document, validProvenance.document],
        ]);
        const sourceKinds = await runDb(
          databaseUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            return yield* sql<{ readonly sourceKey: string; readonly kind: string }>`
              select source_key as "sourceKey", kind
              from assistant_message_sources
              where assistant_message_id = ${ids.assistantMessage}
              order by source_key
            `;
          }),
        );
        expect(sourceKinds).toEqual(
          [
            { sourceKey: sourceKeys.chat, kind: "chat_message" },
            { sourceKey: sourceKeys.memory, kind: "memory" },
            { sourceKey: sourceKeys.web, kind: "web" },
            { sourceKey: sourceKeys.document, kind: "document" },
          ].sort((left, right) => left.sourceKey.localeCompare(right.sourceKey)),
        );
        const sourceUseRows = [
          { sourceKey: sourceKeys.chat, contextOrder: 0, ranges: [] },
          { sourceKey: sourceKeys.memory, contextOrder: 1, ranges: [] },
          { sourceKey: sourceKeys.web, contextOrder: 2, ranges: [] },
          {
            sourceKey: sourceKeys.document,
            contextOrder: 3,
            ranges: [{ charStart: 0, charEnd: publicText.length }],
          },
        ] as const;
        for (const sourceUse of sourceUseRows) {
          await runDb(
            databaseUrl,
            Effect.gen(function* () {
              const sql = yield* PgClient.PgClient;
              yield* sql`alter table assistant_message_source_uses disable trigger user`;
              yield* sql`
                delete from assistant_message_source_uses
                where assistant_message_id = ${ids.assistantMessage}
                  and source_key = ${sourceUse.sourceKey}
              `;
              yield* sql`alter table assistant_message_source_uses enable trigger user`;
            }),
          );
          const blocked = await runDb(
            databaseUrl,
            Effect.exit(
              Effect.gen(function* () {
                const sql = yield* PgClient.PgClient;
                return yield* sql.unsafe(migration).raw;
              }),
            ),
          );
          expect(blocked._tag).toBe("Failure");
          expect(errorText(blocked)).toContain(
            `assistant_message_sources/${ids.assistantMessage}/${sourceUse.sourceKey}`,
          );
          expect(errorText(blocked)).toContain("source has no canonical answer use");
          const fenced = await runDb(
            databaseUrl,
            Effect.gen(function* () {
              const sql = yield* PgClient.PgClient;
              return yield* sql<{ readonly helpers: number; readonly finalColumn: number }>`
                select
                  (select count(*)::int from pg_proc where pronamespace = 'public'::regnamespace
                    and proname = 'brief_ai_safe_bigint') as helpers,
                  (select count(*)::int from information_schema.columns
                    where table_schema = 'public' and table_name = 'assistant_message_sources'
                      and column_name = 'version_id') as "finalColumn"
              `;
            }),
          );
          expect(fenced[0]).toEqual({ helpers: 0, finalColumn: 0 });
          await runDb(
            databaseUrl,
            Effect.gen(function* () {
              const sql = yield* PgClient.PgClient;
              yield* sql`
                insert into assistant_message_source_uses (
                  assistant_message_id, source_key, consumer_task_id, topic_id,
                  rendered_token_count, context_order, ranges
                ) values (
                  ${ids.assistantMessage}, ${sourceUse.sourceKey}, 'topic-t1-answer', 't1',
                  0, ${sourceUse.contextOrder}, ${JSON.stringify(sourceUse.ranges)}::jsonb
                )
              `;
            }),
          );
        }
        for (const invalidCase of invalidCases) {
          await runDb(
            databaseUrl,
            Effect.gen(function* () {
              const sql = yield* PgClient.PgClient;
              yield* sql`alter table assistant_message_sources disable trigger user`;
              yield* sql`
                update assistant_message_sources
                set public_provenance = ${sql.json(invalidCase.provenance)},
                    source_identity_digest = assistant_message_source_identity_digest(
                      assistant_message_id, source_key, kind, locator,
                      document_version_id, publisher_document_version_id,
                      message_id, memory_revision_id, display_label, ${sql.json(invalidCase.provenance)}
                    )
                where assistant_message_id = ${ids.assistantMessage} and source_key = ${invalidCase.sourceKey}
              `;
              yield* sql`alter table assistant_message_sources enable trigger user`;
            }),
          );
          const blocked = await runDb(
            databaseUrl,
            Effect.exit(
              Effect.gen(function* () {
                const sql = yield* PgClient.PgClient;
                return yield* sql.unsafe(migration).raw;
              }),
            ),
          );
          expect(blocked._tag).toBe("Failure");
          expect(errorText(blocked)).toContain(
            `assistant_message_sources/${ids.assistantMessage}/${invalidCase.sourceKey}`,
          );
          expect(errorText(blocked)).toContain("public provenance");
          const fenced = await runDb(
            databaseUrl,
            Effect.gen(function* () {
              const sql = yield* PgClient.PgClient;
              return yield* sql<{
                readonly helperCount: number;
                readonly finalColumnCount: number;
              }>`
                select
                  (select count(*)::int from pg_proc where pronamespace = 'public'::regnamespace
                    and proname = 'brief_ai_safe_bigint') as "helperCount",
                  (select count(*)::int from information_schema.columns
                    where table_schema = 'public' and table_name = 'assistant_message_sources'
                      and column_name = 'version_id') as "finalColumnCount"
              `;
            }),
          );
          expect(fenced[0]).toEqual({ helperCount: 0, finalColumnCount: 0 });
          await runDb(
            databaseUrl,
            Effect.gen(function* () {
              const sql = yield* PgClient.PgClient;
              yield* sql`alter table assistant_message_sources disable trigger user`;
              for (const [sourceKey, provenance] of validBySourceKey) {
                yield* sql`
                  update assistant_message_sources
                  set public_provenance = ${sql.json(provenance)},
                      source_identity_digest = assistant_message_source_identity_digest(
                        assistant_message_id, source_key, kind, locator,
                        document_version_id, publisher_document_version_id,
                        message_id, memory_revision_id, display_label, ${sql.json(provenance)}
                      )
                  where assistant_message_id = ${ids.assistantMessage} and source_key = ${sourceKey}
                `;
              }
              yield* sql`alter table assistant_message_sources enable trigger user`;
            }),
          );
          const restoredState = await runDb(
            databaseUrl,
            Effect.gen(function* () {
              const sql = yield* PgClient.PgClient;
              return yield* sql<{ readonly webProvenance: unknown }>`
                select public_provenance as "webProvenance"
                from assistant_message_sources
                where assistant_message_id = ${ids.assistantMessage} and source_key = ${sourceKeys.web}
              `;
            }),
          );
          expect(restoredState[0]?.webProvenance).toEqual(validProvenance.web);
        }
        await runDb(
          databaseUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`alter table assistant_message_sources disable trigger user`;
            yield* sql`
              update assistant_message_sources
              set locator = ${sql.json(invalidWebLocator)},
                  public_provenance = ${sql.json(invalidWebProvenance)},
                  source_identity_digest = assistant_message_source_identity_digest(
                    assistant_message_id, source_key, kind, ${sql.json(invalidWebLocator)},
                    document_version_id, publisher_document_version_id,
                    message_id, memory_revision_id, display_label, ${sql.json(invalidWebProvenance)}
                  )
              where assistant_message_id = ${ids.assistantMessage} and source_key = ${sourceKeys.web}
            `;
            yield* sql`alter table assistant_message_sources enable trigger user`;
          }),
        );
        const nonCanonicalUrlBlocked = await runDb(
          databaseUrl,
          Effect.exit(
            Effect.gen(function* () {
              const sql = yield* PgClient.PgClient;
              return yield* sql.unsafe(migration).raw;
            }),
          ),
        );
        expect(nonCanonicalUrlBlocked._tag).toBe("Failure");
        expect(errorText(nonCanonicalUrlBlocked)).toContain(
          `assistant_message_sources/${ids.assistantMessage}/${sourceKeys.web}`,
        );
        expect(errorText(nonCanonicalUrlBlocked)).toContain("public provenance");
        const nonCanonicalFenced = await runDb(
          databaseUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            return yield* sql<{
              readonly helperCount: number;
              readonly finalColumnCount: number;
            }>`
              select
                (select count(*)::int from pg_proc where pronamespace = 'public'::regnamespace
                  and proname = 'brief_ai_safe_bigint') as "helperCount",
                (select count(*)::int from information_schema.columns
                  where table_schema = 'public' and table_name = 'assistant_message_sources'
                    and column_name = 'version_id') as "finalColumnCount"
            `;
          }),
        );
        expect(nonCanonicalFenced[0]).toEqual({ helperCount: 0, finalColumnCount: 0 });
        await runDb(
          databaseUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`alter table assistant_message_sources disable trigger user`;
            yield* sql`
              update assistant_message_sources
              set locator = ${sql.json(validWebLocator)},
                  public_provenance = ${sql.json(validProvenance.web)},
                  source_identity_digest = assistant_message_source_identity_digest(
                    assistant_message_id, source_key, kind, ${sql.json(validWebLocator)},
                    document_version_id, publisher_document_version_id,
                    message_id, memory_revision_id, display_label, ${sql.json(validProvenance.web)}
                  )
              where assistant_message_id = ${ids.assistantMessage} and source_key = ${sourceKeys.web}
            `;
            yield* sql`alter table assistant_message_sources enable trigger user`;
          }),
        );
        await runDb(
          databaseUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`alter table public_source_documents disable trigger user`;
            yield* sql`alter table public_source_raw_artifacts disable trigger user`;
            yield* sql`
              alter table public_source_documents
              drop constraint public_source_documents_raw_source_url_fkey
            `;
            yield* sql`
              update public_source_documents
              set canonical_url = ${nonCanonicalPublicUrl}
              where document_id = ${ids.publicDocument}
            `;
            yield* sql`
              update public_source_raw_artifacts
              set canonical_url = ${nonCanonicalPublicUrl}
              where id = ${ids.rawArtifact}
            `;
            yield* sql`
              alter table public_source_documents
              add constraint public_source_documents_raw_source_url_fkey
              foreign key (raw_artifact_id, source_id, canonical_url)
              references public_source_raw_artifacts (id, source_id, canonical_url)
            `;
            yield* sql`alter table assistant_message_sources disable trigger user`;
            yield* sql`
              update assistant_message_sources
              set public_provenance = ${sql.json(invalidPublicProvenance)},
                  source_identity_digest = assistant_message_source_identity_digest(
                    assistant_message_id, source_key, kind, locator,
                    document_version_id, publisher_document_version_id,
                    message_id, memory_revision_id, display_label, ${sql.json(invalidPublicProvenance)}
                  )
              where assistant_message_id = ${ids.assistantMessage} and source_key = ${sourceKeys.document}
            `;
            yield* sql`alter table assistant_message_sources enable trigger user`;
            yield* sql`alter table public_source_raw_artifacts enable trigger user`;
            yield* sql`alter table public_source_documents enable trigger user`;
          }),
        );
        const nonCanonicalPublicBlocked = await runDb(
          databaseUrl,
          Effect.exit(
            Effect.gen(function* () {
              const sql = yield* PgClient.PgClient;
              return yield* sql.unsafe(migration).raw;
            }),
          ),
        );
        expect(nonCanonicalPublicBlocked._tag).toBe("Failure");
        expect(errorText(nonCanonicalPublicBlocked)).toContain(
          `assistant_message_sources/${ids.assistantMessage}/${sourceKeys.document}`,
        );
        expect(errorText(nonCanonicalPublicBlocked)).toContain("public provenance");
        const nonCanonicalPublicFenced = await runDb(
          databaseUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            return yield* sql<{
              readonly helperCount: number;
              readonly finalColumnCount: number;
            }>`
              select
                (select count(*)::int from pg_proc where pronamespace = 'public'::regnamespace
                  and proname = 'brief_ai_safe_bigint') as "helperCount",
                (select count(*)::int from information_schema.columns
                  where table_schema = 'public' and table_name = 'assistant_message_sources'
                    and column_name = 'version_id') as "finalColumnCount"
            `;
          }),
        );
        expect(nonCanonicalPublicFenced[0]).toEqual({ helperCount: 0, finalColumnCount: 0 });
        await runDb(
          databaseUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`alter table public_source_documents disable trigger user`;
            yield* sql`alter table public_source_raw_artifacts disable trigger user`;
            yield* sql`
              alter table public_source_documents
              drop constraint public_source_documents_raw_source_url_fkey
            `;
            yield* sql`
              update public_source_raw_artifacts
              set canonical_url = ${publicUrl}
              where id = ${ids.rawArtifact}
            `;
            yield* sql`
              update public_source_documents
              set canonical_url = ${publicUrl}
              where document_id = ${ids.publicDocument}
            `;
            yield* sql`
              alter table public_source_documents
              add constraint public_source_documents_raw_source_url_fkey
              foreign key (raw_artifact_id, source_id, canonical_url)
              references public_source_raw_artifacts (id, source_id, canonical_url)
            `;
            yield* sql`alter table assistant_message_sources disable trigger user`;
            yield* sql`
              update assistant_message_sources
              set public_provenance = ${sql.json(validProvenance.document)},
                  source_identity_digest = assistant_message_source_identity_digest(
                    assistant_message_id, source_key, kind, locator,
                    document_version_id, publisher_document_version_id,
                    message_id, memory_revision_id, display_label, ${sql.json(validProvenance.document)}
                  )
              where assistant_message_id = ${ids.assistantMessage} and source_key = ${sourceKeys.document}
            `;
            yield* sql`alter table assistant_message_sources enable trigger user`;
            yield* sql`alter table public_source_raw_artifacts enable trigger user`;
            yield* sql`alter table public_source_documents enable trigger user`;
            yield* sql`
              update ai_runs
              set failed_at = now(), error_code = 'failed_fixture', retryable = true
              where id = ${ids.run}
            `;
          }),
        );
        const failedRetention = await runDb(
          databaseUrl,
          Effect.exit(
            Effect.gen(function* () {
              const sql = yield* PgClient.PgClient;
              yield* sql.unsafe(migration).raw;
            }),
          ),
        );
        expect(failedRetention._tag).toBe("Failure");
        expect(errorText(failedRetention)).toContain(`ai_runs/${ids.run}`);
        expect(errorText(failedRetention)).toContain(
          "failed run retains an assistant message or source row",
        );
        const failedRetentionFence = await runDb(
          databaseUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            return yield* sql<{ readonly helpers: number; readonly finalColumn: number }>`
              select
                (select count(*)::int from pg_proc where pronamespace = 'public'::regnamespace and proname = 'brief_ai_safe_bigint') as helpers,
                (select count(*)::int from information_schema.columns where table_schema = 'public' and table_name = 'ai_runs' and column_name = 'citation_namespace') as "finalColumn"
            `;
          }),
        );
        expect(failedRetentionFence).toEqual([{ helpers: 0, finalColumn: 0 }]);
      } finally {
        await runDb(
          adminDatabaseUrl(),
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
              select pg_terminate_backend(pid)
              from pg_stat_activity
              where datname = ${databaseName} and pid <> pg_backend_pid()
            `;
            yield* sql.unsafe(`drop database if exists ${quoteIdentifier(databaseName)}`);
          }),
        );
      }
    },
  );

  it("converts a terminal 0063 answer with sparse ordinals and exact legacy text handling", async () => {
    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    const databaseName = `brief_migrations_terminal_0063_${process.pid}_${suffix}`;
    const databaseUrl = databaseUrlForName(databaseName);
    const ids = {
      user: `terminal-0063-user-${suffix}`,
      company: crypto.randomUUID(),
      chat: crypto.randomUUID(),
      userMessage: crypto.randomUUID(),
      run: crypto.randomUUID(),
      assistantMessage: crypto.randomUUID(),
      memory: crypto.randomUUID(),
      revision: crypto.randomUUID(),
      memory2: crypto.randomUUID(),
      revision2: crypto.randomUUID(),
      memory3: crypto.randomUUID(),
      revision3: crypto.randomUUID(),
      olderRevision: crypto.randomUUID(),
      writeRevision: crypto.randomUUID(),
      writeRevision2: crypto.randomUUID(),
    };
    const nonce = Buffer.from("terminal-0063-citation", "utf8").subarray(0, 16);
    const webUrl = "https://example.test/terminal-web";
    const webPageText = "A complete fetched page with a selected quotation and more context.";
    const webQuote = "a selected quotation";
    const webQuoteHash = createHash("sha256").update(webQuote).digest("base64url");
    const webContentItemIdentity = `${webUrl}:${createHash("sha256")
      .update(webPageText)
      .digest("base64url")}`;
    const webExposureStage = "web_fetch";
    const webExposureBinding = {
      messageIndex: 0,
      orderedSourceDescriptor: webUrl,
      serializedField: "messages[0].content",
      sourceOrdinal: 0,
    };
    const webExposureProof = createHash("sha256")
      .update(
        JSON.stringify({
          binding: webExposureBinding,
          contentItemIdentity: webContentItemIdentity,
          exposureStage: webExposureStage,
          logicalSourceIdentity: webUrl,
          sourceKind: "web",
          visibleTokenCount: 2,
        }),
      )
      .digest("hex");
    const wrongWebContentItemIdentity = `${webUrl}:not-a-full-page-hash`;
    const wrongWebExposureBinding = {
      ...webExposureBinding,
      orderedSourceDescriptor: `${webUrl}:wrong-page`,
    };
    const wrongWebExposureProof = createHash("sha256")
      .update(
        JSON.stringify({
          binding: wrongWebExposureBinding,
          contentItemIdentity: wrongWebContentItemIdentity,
          exposureStage: webExposureStage,
          logicalSourceIdentity: webUrl,
          sourceKind: "web",
          visibleTokenCount: 2,
        }),
      )
      .digest("hex");
    const webAttestationKey = `source_exposure_attestation:single-retrieve-web:0:0:0:${createHash(
      "sha256",
    )
      .update(
        JSON.stringify([
          "web",
          webUrl,
          webContentItemIdentity,
          webExposureStage,
          2,
          "d".repeat(64),
          webExposureBinding,
          null,
        ]),
      )
      .digest("hex")}`;
    const webReference = {
      url: webUrl,
      title: "Terminal fetched page",
      domain: "example.test",
      quote: webQuote,
      publishedAt: "2026-07-01T00:00:00.000Z",
      capturedAt: "2026-07-01T00:00:00.000Z",
      purpose: "grounding",
    };
    const webCandidateId = `web:${webUrl}:${webQuoteHash}`;
    const legacyNamespace = nonce.toString("base64url");
    const oldKey1 = `k_${legacyNamespace}_1`;
    const oldKey3 = `k_${legacyNamespace}_3`;
    const unknownKey = `k_${legacyNamespace}_9`;
    const exposureStage = "memory_selection";
    const selectorExposureStage = "memory_tool_result";
    const exposureBinding = {
      messageIndex: 0,
      orderedSourceDescriptor: `memory:${ids.memory}`,
      serializedField: "messages[0].content",
      sourceOrdinal: 0,
    };
    const exposureProof = createHash("sha256")
      .update(
        JSON.stringify({
          binding: exposureBinding,
          contentItemIdentity: ids.revision,
          exposureStage,
          logicalSourceIdentity: `memory:${ids.memory}`,
          sourceKind: "memory",
          visibleTokenCount: 2,
        }),
      )
      .digest("hex");
    const exposureProof2 = createHash("sha256")
      .update(
        JSON.stringify({
          binding: {
            ...exposureBinding,
            sourceOrdinal: 1,
            orderedSourceDescriptor: `memory:${ids.memory2}`,
          },
          contentItemIdentity: ids.revision2,
          exposureStage,
          logicalSourceIdentity: `memory:${ids.memory2}`,
          sourceKind: "memory",
          visibleTokenCount: 2,
        }),
      )
      .digest("hex");
    const selectorExposureBinding = {
      messageIndex: 0,
      orderedSourceDescriptor: `memory:${ids.memory}`,
      serializedField: "messages[0].content",
      sourceOrdinal: 0,
    };
    const selectorExposureBinding2 = {
      ...selectorExposureBinding,
      orderedSourceDescriptor: `memory:${ids.memory2}`,
      sourceOrdinal: 1,
    };
    const selectorExposureBinding3 = {
      ...selectorExposureBinding,
      orderedSourceDescriptor: `memory:${ids.memory3}`,
      sourceOrdinal: 2,
    };
    const selectorExposureProof = createHash("sha256")
      .update(
        JSON.stringify({
          binding: selectorExposureBinding,
          contentItemIdentity: ids.revision,
          exposureStage: selectorExposureStage,
          logicalSourceIdentity: `memory:${ids.memory}`,
          sourceKind: "memory",
          visibleTokenCount: 2,
        }),
      )
      .digest("hex");
    const selectorExposureProof2 = createHash("sha256")
      .update(
        JSON.stringify({
          binding: selectorExposureBinding2,
          contentItemIdentity: ids.revision2,
          exposureStage: selectorExposureStage,
          logicalSourceIdentity: `memory:${ids.memory2}`,
          sourceKind: "memory",
          visibleTokenCount: 2,
        }),
      )
      .digest("hex");
    const selectorExposureProof3 = createHash("sha256")
      .update(
        JSON.stringify({
          binding: selectorExposureBinding3,
          contentItemIdentity: ids.revision3,
          exposureStage: selectorExposureStage,
          logicalSourceIdentity: `memory:${ids.memory3}`,
          sourceKind: "memory",
          visibleTokenCount: 2,
        }),
      )
      .digest("hex");
    const selectorAttestationKey = `source_exposure_attestation:single-select-memories:0:0:0:${createHash(
      "sha256",
    )
      .update(
        JSON.stringify([
          "memory",
          `memory:${ids.memory}`,
          ids.revision,
          selectorExposureStage,
          2,
          "e".repeat(64),
          selectorExposureBinding,
          null,
        ]),
      )
      .digest("hex")}`;
    const selectorAttestationKey2 = `source_exposure_attestation:single-select-memories:0:0:0:${createHash(
      "sha256",
    )
      .update(
        JSON.stringify([
          "memory",
          `memory:${ids.memory2}`,
          ids.revision2,
          selectorExposureStage,
          2,
          "e".repeat(64),
          selectorExposureBinding2,
          null,
        ]),
      )
      .digest("hex")}`;
    const wrongOwnerSelectorAttestationKey2 = `source_exposure_attestation:single-answer:0:0:0:${createHash(
      "sha256",
    )
      .update(
        JSON.stringify([
          "memory",
          `memory:${ids.memory2}`,
          ids.revision2,
          selectorExposureStage,
          2,
          "a".repeat(64),
          selectorExposureBinding2,
          null,
        ]),
      )
      .digest("hex")}`;
    const selectorAttestationKey3 = `source_exposure_attestation:single-select-memories:0:0:0:${createHash(
      "sha256",
    )
      .update(
        JSON.stringify([
          "memory",
          `memory:${ids.memory3}`,
          ids.revision3,
          selectorExposureStage,
          2,
          "e".repeat(64),
          selectorExposureBinding3,
          null,
        ]),
      )
      .digest("hex")}`;
    const attestationKey = `source_exposure_attestation:single-answer:0:0:0:${createHash("sha256")
      .update(
        JSON.stringify([
          "memory",
          `memory:${ids.memory}`,
          ids.revision,
          exposureStage,
          2,
          "a".repeat(64),
          exposureBinding,
          null,
        ]),
      )
      .digest("hex")}`;
    const attestationKey2 = `source_exposure_attestation:single-answer:0:0:0:${createHash("sha256")
      .update(
        JSON.stringify([
          "memory",
          `memory:${ids.memory2}`,
          ids.revision2,
          exposureStage,
          2,
          "a".repeat(64),
          {
            ...exposureBinding,
            sourceOrdinal: 1,
            orderedSourceDescriptor: `memory:${ids.memory2}`,
          },
          null,
        ]),
      )
      .digest("hex")}`;
    const content = [
      `Mapped [[cite:${oldKey1}]] and [[cite:${oldKey3}]].`,
      `Unknown [[cite:${unknownKey}]]; prose ${oldKey1}; partial [[cite:${oldKey1}. then valid [[cite:${oldKey3}]]`,
      `Mixed [[cite:${oldKey1},${unknownKey}]] and malformed [[cite:${oldKey1},]]`,
      `Code:\n\`\`\`text\n[[cite:${oldKey1}]]\n\`\`\``,
      `Tilde:\n~~~text\n[[cite:${oldKey3}]]\n~~~`,
      `Indented:\n    [[cite:${oldKey1}]]`,
      `HTML: <code>[[cite:${oldKey3}]]</code> <pre>[[cite:${oldKey1}]]</pre>`,
      `Inline: \`code [[cite:${oldKey1}]]\`[[cite:${oldKey3}]]`,
      `Adjacent \`code\`[[cite:${oldKey1}]]`,
      `Multi: \`\`code [[cite:${oldKey1}]]\`\`[[cite:${oldKey3}]]`,
      `Closing backslash: \`code\\\`[[cite:${oldKey1}]]\`[[cite:${oldKey3}]]`,
      "Escaped: \\`literal [[cite:" + oldKey1 + "]] and [[cite:" + oldKey3 + "]]",
      `Unmatched multi: \`\`literal [[cite:${oldKey1}]] then [[cite:${oldKey3}]]`,
      `After code [[cite:${oldKey1}]]`,
      `Unmatched single at end \`literal [[cite:${oldKey1}]] then [[cite:${oldKey3}]]`,
    ].join("\n");

    try {
      await runDb(
        adminDatabaseUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql.unsafe(`create database ${quoteIdentifier(databaseName)}`);
        }),
      );
      await runDb(
        databaseUrl,
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql.unsafe("drop schema if exists public cascade");
          yield* sql.unsafe("create schema public");
        }),
      );
      await runDb(
        databaseUrl,
        applyMigrationsThrough("0063_immutable_document_exposure_evidence.sql"),
      );
      await runDb(
        databaseUrl,
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            insert into platform_users (id, primary_email, display_name, clerk_user_id)
            values (${ids.user}, ${`${ids.user}@example.test`}, 'Terminal 0063 user', ${`clerk-${ids.user}`})
          `;
          yield* sql`
            insert into client_companies (id, name) values (${ids.company}, 'Terminal 0063 company')
          `;
          yield* sql`
            insert into client_company_memberships (company_id, user_id, role)
            values (${ids.company}, ${ids.user}, 'admin')
          `;
          yield* sql`
            insert into chats (id, user_id, company_id, memory_mode)
            values (${ids.chat}, ${ids.user}, ${ids.company}, 'private_owner')
          `;
          yield* sql`
            insert into chat_messages (id, chat_id, author, content)
            values (${ids.userMessage}, ${ids.chat}, 'user', 'What was the saved fact?')
          `;
          yield* sql`
            insert into ai_runs (
              id, chat_id, initiating_user_id, user_message_id, locale, market,
              citation_nonce, effective_web_policy, finished_at
            ) values (
              ${ids.run}, ${ids.chat}, ${ids.user}, ${ids.userMessage}, 'en-US', 'US',
              decode(${nonce.toString("base64")}, 'base64'),
              ${sql.json({ enabled: false, reason: "company_disabled", allowlistActive: false })},
              now()
            )
          `;
          yield* sql`
            insert into chat_messages (id, chat_id, author, content, assistant_ai_run_id)
            values (${ids.assistantMessage}, ${ids.chat}, 'assistant', ${content}, ${ids.run})
          `;
          yield* sql`
            update ai_runs set assistant_message_id = ${ids.assistantMessage} where id = ${ids.run}
          `;
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`
                insert into user_memories (
                  id, user_id, kind, content, head_revision_id, deleted_at, provenance_only_at
                ) values (${ids.memory}, ${ids.user}, 'fact', 'A saved fact', ${ids.revision}, null, null)
              `;
              yield* sql`
                insert into user_memory_revisions (
                  id, memory_id, action, state_before, state_after, run_id, created_at
                ) values (
                  ${ids.olderRevision}, ${ids.memory}, 'create', null,
                  ${sql.json({ kind: "fact", content: "An older saved fact", deleted: false })},
                  null, now() - interval '2 minutes'
                )
              `;
              yield* sql`
                insert into user_memory_revisions (
                  id, memory_id, action, state_before, state_after, run_id, created_at
                ) values (
                  ${ids.revision}, ${ids.memory}, 'create', null,
                  ${sql.json({ kind: "fact", content: "A saved fact", deleted: false })},
                  null, now() - interval '1 minute'
                )
              `;
            }),
          );
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`
                insert into user_memories (
                  id, user_id, kind, content, head_revision_id, deleted_at, provenance_only_at
                ) values (${ids.memory2}, ${ids.user}, 'fact', 'A second saved fact', ${ids.revision2}, null, null)
              `;
              yield* sql`
                insert into user_memory_revisions (
                  id, memory_id, action, state_before, state_after, run_id, created_at
                ) values (
                  ${ids.revision2}, ${ids.memory2}, 'create', null,
                  ${sql.json({ kind: "fact", content: "A second saved fact", deleted: false })},
                  null, now() - interval '1 minute'
                )
              `;
            }),
          );
          yield* sql`
            insert into user_memory_revisions (
              id, memory_id, action, state_before, state_after, run_id, created_at
            ) values (
              ${ids.writeRevision}, ${ids.memory}, 'update',
              ${sql.json({ kind: "fact", content: "A saved fact", deleted: false })},
              ${sql.json({ kind: "fact", content: "A saved fact updated", deleted: false })},
              ${ids.run}, now()
            )
          `;
          yield* sql`
            update user_memories
            set content = 'A saved fact updated',
                head_revision_id = ${ids.writeRevision},
                source_message_id = ${ids.userMessage}
            where id = ${ids.memory}
          `;
          yield* sql`
            insert into user_memory_revisions (
              id, memory_id, action, state_before, state_after, run_id, created_at
            ) values (
              ${ids.writeRevision2}, ${ids.memory2}, 'update',
              ${sql.json({ kind: "fact", content: "A second saved fact", deleted: false })},
              ${sql.json({ kind: "fact", content: "A second saved fact updated", deleted: false })},
              ${ids.run}, now()
            )
          `;
          yield* sql`
            update user_memories
            set content = 'A second saved fact updated',
                head_revision_id = ${ids.writeRevision2},
                source_message_id = ${ids.userMessage}
            where id = ${ids.memory2}
          `;
          for (const [sourceKey, ordinal] of [
            [oldKey1, 1, ids.memory, ids.revision],
            [oldKey3, 3, ids.memory2, ids.revision2],
          ] as const) {
            yield* sql`
              insert into assistant_message_sources (
                assistant_message_id, source_key, kind, locator, memory_revision_id,
                display_label, public_provenance
              ) values (
                ${ids.assistantMessage}, ${sourceKey}, 'memory',
                ${sql.json({
                  kind: "memory",
                  memoryId: ordinal === 1 ? ids.memory : ids.memory2,
                  memoryRevisionId: ordinal === 1 ? ids.revision : ids.revision2,
                })}, ${ordinal === 1 ? ids.revision : ids.revision2}, 'Saved fact', '{}'::jsonb
              )
            `;
            yield* sql`
              insert into assistant_message_source_uses (
                assistant_message_id, source_key, consumer_task_id,
                rendered_token_count, context_order, ranges
              ) values (${ids.assistantMessage}, ${sourceKey}, 'single-answer', 1, ${ordinal === 1 ? 0 : 1}, '[]'::jsonb)
            `;
          }
          yield* sql`
            insert into ai_observations (
              run_id, chat_id, emitting_task, loop_iteration, attempt,
              observation_key, kind, payload
            ) values (
              ${ids.run}, ${ids.chat}, 'single-answer', 0, 0,
              'provider_request_measurement:single-answer:0:0:0',
              'provider_request_measurement',
              ${sql.json({
                agentRole: "direct_answer",
                modelId: "glm-5-turbo",
                requestSha256Hex: "a".repeat(64),
                sourceExposureProofSha256Hexes: [exposureProof, exposureProof2].sort(),
                sourceExposureProofBindings: [
                  {
                    providerSerializationProofSha256Hex: exposureProof,
                    providerSerializationProofBinding: exposureBinding,
                  },
                  {
                    providerSerializationProofSha256Hex: exposureProof2,
                    providerSerializationProofBinding: {
                      ...exposureBinding,
                      sourceOrdinal: 1,
                      orderedSourceDescriptor: `memory:${ids.memory2}`,
                    },
                  },
                ].sort((left, right) =>
                  left.providerSerializationProofSha256Hex.localeCompare(
                    right.providerSerializationProofSha256Hex,
                  ),
                ),
                providerRequestIndex: 0,
                inputTokens: 2,
                requestedOutputTokens: 1,
                usableInputTokens: 2,
                contextWindow: 100,
                passed: true,
              })}
            )
          `;
          yield* sql`
            insert into ai_observations (
              run_id, chat_id, emitting_task, loop_iteration, attempt,
              observation_key, kind, payload
            ) values
              (
                ${ids.run}, ${ids.chat}, 'plan-turn', 0, 0,
                'provider_request_measurement:plan-turn:0:0:0',
                'provider_request_measurement',
                ${sql.json({
                  agentRole: "plan_turn",
                  modelId: "glm-5-turbo",
                  requestSha256Hex: "b".repeat(64),
                  sourceExposureProofSha256Hexes: [],
                  providerRequestIndex: 0,
                  inputTokens: 1,
                  requestedOutputTokens: 1,
                  usableInputTokens: 1,
                  contextWindow: 100,
                  passed: true,
                })}
              ),
              (
                ${ids.run}, ${ids.chat}, 'single-select-memories', 0, 0,
                'provider_request_measurement:single-select-memories:0:0:0',
                'provider_request_measurement',
                ${sql.json({
                  agentRole: "memory_selector",
                  modelId: "glm-5-turbo",
                  requestSha256Hex: "e".repeat(64),
                  sourceExposureProofSha256Hexes: [
                    selectorExposureProof,
                    selectorExposureProof2,
                    selectorExposureProof3,
                  ].sort(),
                  sourceExposureProofBindings: [
                    {
                      providerSerializationProofSha256Hex: selectorExposureProof,
                      providerSerializationProofBinding: selectorExposureBinding,
                    },
                    {
                      providerSerializationProofSha256Hex: selectorExposureProof2,
                      providerSerializationProofBinding: selectorExposureBinding2,
                    },
                    {
                      providerSerializationProofSha256Hex: selectorExposureProof3,
                      providerSerializationProofBinding: selectorExposureBinding3,
                    },
                  ].sort((left, right) =>
                    left.providerSerializationProofSha256Hex.localeCompare(
                      right.providerSerializationProofSha256Hex,
                    ),
                  ),
                  providerRequestIndex: 0,
                  inputTokens: 1,
                  requestedOutputTokens: 1,
                  usableInputTokens: 1,
                  contextWindow: 100,
                  passed: true,
                })}
              ),
              (
                ${ids.run}, ${ids.chat}, 'memory-extract', 0, 0,
                'provider_request_measurement:memory-extract:0:0:0',
                'provider_request_measurement',
                ${sql.json({
                  agentRole: "memory_extractor",
                  modelId: "glm-5-turbo",
                  requestSha256Hex: "c".repeat(64),
                  sourceExposureProofSha256Hexes: [],
                  providerRequestIndex: 0,
                  inputTokens: 1,
                  requestedOutputTokens: 1,
                  usableInputTokens: 1,
                  contextWindow: 100,
                  passed: true,
                })}
              ),
              (
                ${ids.run}, ${ids.chat}, 'single-retrieve-internal', 0, 0,
                'provider_request_measurement:single-retrieve-internal:0:0:0',
                'provider_request_measurement',
                ${sql.json({
                  agentRole: "internal_retrieval",
                  modelId: "glm-5-turbo",
                  requestSha256Hex: "f".repeat(64),
                  sourceExposureProofSha256Hexes: [],
                  providerRequestIndex: 0,
                  inputTokens: 1,
                  requestedOutputTokens: 1,
                  usableInputTokens: 1,
                  contextWindow: 100,
                  passed: true,
                })}
              )
          `;
          yield* sql`
            insert into ai_observations (
              run_id, chat_id, emitting_task, loop_iteration, attempt,
              observation_key, kind, payload
            ) values (
              ${ids.run}, ${ids.chat}, 'single-retrieve-internal', 0, 0,
              'candidate_rejected:single-retrieve-internal:0:0:0:0', 'candidate_rejected',
              ${sql.json({ candidateId: oldKey1, reason: "missing" })}
            )
          `;
          yield* sql`
            insert into ai_run_usage (
              run_id, task_id, loop_iteration, attempt, provider_request_index,
              agent_role, model_id, provider_service_id, input_tokens, output_tokens,
              cached_tokens, reasoning_tokens, total_tokens, stop_reason
            ) values (
              ${ids.run}, 'single-answer', 0, 0, 0,
              'direct_answer', 'glm-5-turbo', 'deterministic_test', 2, 1, 0, 0, 3, 'stop'
            ), (
              ${ids.run}, 'single-select-memories', 0, 0, 0,
              'memory_selector', 'glm-5-turbo', 'deterministic_test', 1, 1, 0, 0, 2, 'stop'
            ), (
              ${ids.run}, 'plan-turn', 0, 0, 0,
              'plan_turn', 'glm-5-turbo', 'deterministic_test', 1, 1, 0, 0, 2, 'stop'
            ), (
              ${ids.run}, 'memory-extract', 0, 0, 0,
              'memory_extractor', 'glm-5-turbo', 'deterministic_test', 1, 1, 0, 0, 2, 'stop'
            ), (
              ${ids.run}, 'single-retrieve-internal', 0, 0, 0,
              'internal_retrieval', 'glm-5-turbo', 'deterministic_test', 1, 1, 0, 0, 2, 'stop'
            )
          `;
          yield* sql`
            insert into ai_source_exposures (
              run_id, task_id, loop_iteration, attempt, provider_request_index,
              source_kind, logical_source_identity, content_item_identity,
              exposure_stage, visible_token_count
            ) values (
              ${ids.run}, 'single-select-memories', 0, 0, 0, 'memory',
              ${`memory:${ids.memory}`}, ${ids.revision}, ${selectorExposureStage}, 2
            ), (
              ${ids.run}, 'single-select-memories', 0, 0, 0, 'memory',
              ${`memory:${ids.memory2}`}, ${ids.revision2}, ${selectorExposureStage}, 2
            ), (
              ${ids.run}, 'single-select-memories', 0, 0, 0, 'memory',
              ${`memory:${ids.memory3}`}, ${ids.revision3}, ${selectorExposureStage}, 2
            ), (
              ${ids.run}, 'single-answer', 0, 0, 0, 'memory',
              ${`memory:${ids.memory}`}, ${ids.revision}, ${exposureStage}, 2
            ), (
              ${ids.run}, 'single-answer', 0, 0, 0, 'memory',
              ${`memory:${ids.memory2}`}, ${ids.revision2}, ${exposureStage}, 2
            )
          `;
          yield* sql`
            insert into ai_observations (
              run_id, chat_id, emitting_task, loop_iteration, attempt,
              observation_key, kind, payload
            ) values (
              ${ids.run}, ${ids.chat}, 'single-select-memories', 0, 0,
              ${selectorAttestationKey}, 'source_exposure_attestation',
              ${sql.json({
                providerRequestIndex: 0,
                providerRequestSha256Hex: "e".repeat(64),
                sourceKind: "memory",
                logicalSourceIdentity: `memory:${ids.memory}`,
                contentItemIdentity: ids.revision,
                exposureStage: selectorExposureStage,
                visibleTokenCount: 2,
                providerSerializationProofSha256Hex: selectorExposureProof,
                providerSerializationProofBinding: selectorExposureBinding,
              })}
            ), (
              ${ids.run}, ${ids.chat}, 'single-select-memories', 0, 0,
              ${selectorAttestationKey2}, 'source_exposure_attestation',
              ${sql.json({
                providerRequestIndex: 0,
                providerRequestSha256Hex: "e".repeat(64),
                sourceKind: "memory",
                logicalSourceIdentity: `memory:${ids.memory2}`,
                contentItemIdentity: ids.revision2,
                exposureStage: selectorExposureStage,
                visibleTokenCount: 2,
                providerSerializationProofSha256Hex: selectorExposureProof2,
                providerSerializationProofBinding: selectorExposureBinding2,
              })}
            ), (
              ${ids.run}, ${ids.chat}, 'single-select-memories', 0, 0,
              ${selectorAttestationKey3}, 'source_exposure_attestation',
              ${sql.json({
                providerRequestIndex: 0,
                providerRequestSha256Hex: "e".repeat(64),
                sourceKind: "memory",
                logicalSourceIdentity: `memory:${ids.memory3}`,
                contentItemIdentity: ids.revision3,
                exposureStage: selectorExposureStage,
                visibleTokenCount: 2,
                providerSerializationProofSha256Hex: selectorExposureProof3,
                providerSerializationProofBinding: selectorExposureBinding3,
              })}
            ), (
              ${ids.run}, ${ids.chat}, 'single-answer', 0, 0,
              ${attestationKey}, 'source_exposure_attestation',
              ${sql.json({
                providerRequestIndex: 0,
                providerRequestSha256Hex: "a".repeat(64),
                sourceKind: "memory",
                logicalSourceIdentity: `memory:${ids.memory}`,
                contentItemIdentity: ids.revision,
                exposureStage,
                visibleTokenCount: 2,
                providerSerializationProofSha256Hex: exposureProof,
                providerSerializationProofBinding: exposureBinding,
              })}
            )
            , (
              ${ids.run}, ${ids.chat}, 'single-answer', 0, 0,
              ${attestationKey2}, 'source_exposure_attestation',
              ${sql.json({
                providerRequestIndex: 0,
                providerRequestSha256Hex: "a".repeat(64),
                sourceKind: "memory",
                logicalSourceIdentity: `memory:${ids.memory2}`,
                contentItemIdentity: ids.revision2,
                exposureStage,
                visibleTokenCount: 2,
                providerSerializationProofSha256Hex: exposureProof2,
                providerSerializationProofBinding: {
                  ...exposureBinding,
                  sourceOrdinal: 1,
                  orderedSourceDescriptor: `memory:${ids.memory2}`,
                },
              })}
            )
          `;
          yield* sql`
            insert into ai_observations (
              run_id, chat_id, emitting_task, loop_iteration, attempt,
              observation_key, kind, payload
            ) values (
              ${ids.run}, ${ids.chat}, 'finalize', 0, 0,
              'citation:0:0', 'citation',
              ${sql.json({ assistantMessageId: ids.assistantMessage, sourceKey: oldKey1 })}
            )
          `;
          const restrictedLedger = {
            requestKind: "direct",
            modelId: "glm-5-turbo",
            requestSha256Hex: "a".repeat(64),
            inputTokens: 2,
            usableInputTokens: 2,
            requestedOutputTokens: 1,
            selectedConversation: [],
            question: "retained answer",
            gaps: [],
            sources: [
              {
                candidateId: ids.memory,
                sourceKey: oldKey1,
                kind: "memory",
                purpose: "grounding",
                label: "Saved fact",
                ranges: [],
              },
              {
                candidateId: ids.memory2,
                sourceKey: oldKey3,
                kind: "memory",
                purpose: "grounding",
                label: "Saved fact",
                ranges: [],
              },
              {
                candidateId: ids.memory3,
                sourceKey: unknownKey,
                kind: "memory",
                purpose: "grounding",
                label: "Omitted fact",
                ranges: [],
              },
              {
                candidateId: webCandidateId,
                sourceKey: `k_${legacyNamespace}_4`,
                kind: "web",
                purpose: "grounding",
                label: webReference.title,
                ranges: [],
              },
            ],
          };
          const serializedLedger = {
            ...restrictedLedger,
            sources: restrictedLedger.sources.slice(0, 2),
          };
          yield* sql`
            insert into ai_observations (
              run_id, chat_id, emitting_task, loop_iteration, attempt,
              observation_key, kind, payload
            ) values
              (${ids.run}, ${ids.chat}, 'plan-turn', 0, 0, 'plan-turn:0:0:turn_plan', 'turn_plan',
                ${sql.json({ mode: "single", question: "retained answer", relevantTurnIds: [] })}),
              (${ids.run}, ${ids.chat}, 'single-retrieve-internal', 0, 0, 'single-retrieve-internal:0:0:retrieval_manifest:result', 'retrieval_manifest',
                ${sql.json({ selectorRole: "internal", references: [] })}),
              (${ids.run}, ${ids.chat}, 'single-select-memories', 0, 0, 'single-select-memories:0:0:retrieval_manifest:result', 'retrieval_manifest',
                ${sql.json({
                  selectorRole: "memory",
                  references: [
                    { memoryId: ids.memory, memoryRevisionId: ids.revision },
                    { memoryId: ids.memory2, memoryRevisionId: ids.revision2 },
                    { memoryId: ids.memory3, memoryRevisionId: ids.revision3 },
                  ],
                })}),
              (${ids.run}, ${ids.chat}, 'single-retrieve-web', 0, 0, 'single-retrieve-web:0:0:retrieval_manifest:result', 'retrieval_manifest',
                ${sql.json({ selectorRole: "web", references: [], noCallReason: "web_policy_disabled" })}),
              (${ids.run}, ${ids.chat}, 'finalize', 0, 0,
                'retrieval_no_call_seal:single-retrieve-web:0:0', 'retrieval_no_call_seal',
                ${sql.json({
                  selectorTaskId: "single-retrieve-web",
                  selectorLoopIteration: 0,
                  selectorAttempt: 0,
                  selectorObservationKey: "single-retrieve-web:0:0:retrieval_manifest:result",
                  noCallReason: "web_policy_disabled",
                })}),
              (${ids.run}, ${ids.chat}, 'single-measure', 0, 0, 'context:measure:initial', 'context_measurement',
                ${sql.json({
                  consumerTaskId: "single-answer",
                  mandatoryInputTokens: 2,
                  discretionaryInputTokens: 0,
                  totalInputTokens: 2,
                  requestedOutputTokens: 1,
                  usableInputTokens: 2,
                  contextWindow: 100,
                  status: "ready",
                  reductionRan: false,
                  reductionFeedback: [],
                  restrictedContextLedger: restrictedLedger,
                })}),
              (${ids.run}, ${ids.chat}, 'single-answer', 0, 0, 'context:measure', 'context_measurement',
                ${sql.json({
                  consumerTaskId: "single-answer",
                  mandatoryInputTokens: 2,
                  discretionaryInputTokens: 0,
                  totalInputTokens: 2,
                  requestedOutputTokens: 1,
                  usableInputTokens: 2,
                  contextWindow: 100,
                  status: "ready",
                  reductionRan: false,
                  reductionFeedback: [],
                  restrictedContextLedger: restrictedLedger,
                })}),
              (${ids.run}, ${ids.chat}, 'single-reduce-measure', 1, 0, 'context:decision', 'context_decision',
                ${sql.json({
                  valid: true,
                  decisions: [
                    { id: ids.memory, action: "keep", reason: "retained" },
                    { id: ids.memory2, action: "keep", reason: "retained" },
                    { id: ids.memory3, action: "omit", reason: "not needed" },
                    { id: webCandidateId, action: "omit", reason: "not needed" },
                  ],
                  feedback: ["ownerId role versionId"],
                })}),
              (${ids.run}, ${ids.chat}, 'single-answer', 0, 0, 'context:serialized', 'context_serialized',
                ${sql.json({
                  consumerTaskId: "single-answer",
                  sourceKeys: [oldKey1, oldKey3],
                  restrictedContextLedger: serializedLedger,
                  terminalUsageCoordinate: {
                    taskId: "single-answer",
                    loopIteration: 0,
                    attempt: 0,
                    providerRequestIndex: 0,
                  },
                })}),
              (${ids.run}, ${ids.chat}, 'memory-extract', 0, 0, 'memory-extract:0:0:memory_extraction_result:result', 'memory_extraction_result',
                ${sql.json({ proposalCount: 2, discardedCount: 0, extractionSha256Hex: "b".repeat(64) })}),
              (${ids.run}, ${ids.chat}, 'finalize', 0, 0, 'finalize:0:0:memory_application:result', 'memory_application',
                ${sql.json({
                  extractionTaskId: "memory-extract",
                  extractionLoopIteration: 0,
                  extractionAttempt: 0,
                  extractionObservationKey: "memory-extract:0:0:memory_extraction_result:result",
                  extractionSha256Hex: "b".repeat(64),
                  proposalCount: 2,
                  discardedCount: 0,
                })}),
              (${ids.run}, ${ids.chat}, 'finalize', 0, 0, 'memory_written:0', 'memory_written',
              ${sql.json({
                ordinal: 0,
                memoryId: ids.memory,
                revisionId: ids.writeRevision,
                previousRevisionId: ids.revision,
                action: "update",
              })}),
              (${ids.run}, ${ids.chat}, 'finalize', 0, 0, 'memory_written:1', 'memory_written',
              ${sql.json({
                ordinal: 1,
                memoryId: ids.memory2,
                revisionId: ids.writeRevision2,
                previousRevisionId: ids.revision2,
                action: "update",
              })}),
              (${ids.run}, ${ids.chat}, 'single-answer', 0, 0, 'answer:started', 'answer_started',
                ${sql.json({ mode: "single", attempt: 0 })}),
              (${ids.run}, ${ids.chat}, 'single-answer', 0, 0, 'answer:delta', 'answer_delta',
                ${sql.json({ delta: content })}),
              (${ids.run}, ${ids.chat}, 'single-answer', 0, 0, 'answer:completed', 'answer_completed',
                ${sql.json({ mode: "single", attempt: 0 })})
          `;
          yield* sql`
            insert into ai_run_events (run_id, seq, event, emitted_by_task, emission_key)
            values
              (${ids.run}, 1, ${sql.json({ type: "run_started" })}, null, 'run_started')
          `;
          yield* sql`
            insert into ai_run_events (run_id, seq, event, emitted_by_task, emission_key)
            values
              (${ids.run}, 2, ${sql.json({
                type: "context_ready",
                mode: "single",
                reductionRan: false,
                sourcesRead: [
                  {
                    sourceKey: oldKey1,
                    label: "Saved fact",
                    tokenCount: 1,
                    topicIds: [],
                    kind: "memory",
                    memoryId: ids.memory,
                    memoryRevisionId: ids.revision,
                    ranges: [],
                  },
                  {
                    sourceKey: oldKey3,
                    label: "Saved fact",
                    tokenCount: 1,
                    topicIds: [],
                    kind: "memory",
                    memoryId: ids.memory2,
                    memoryRevisionId: ids.revision2,
                    ranges: [],
                  },
                ],
                consumers: [
                  {
                    consumer: "direct",
                    inputTokens: 2,
                    requestedOutputTokens: 1,
                    usableInputTokens: 2,
                  },
                ],
              })}, 'single-answer', 'context_ready'),
              (${ids.run}, 3, ${sql.json({ type: "answer_started", mode: "single", attempt: 0 })}, 'single-answer', 'answer_started:single-answer:0'),
              (${ids.run}, 4, ${sql.json({ type: "text_delta", delta: content })}, 'single-answer', 'text_delta:single-answer:0:0'),
              (${ids.run}, 5, ${sql.json({
                type: "usage",
                scope: "request",
                kind: "model",
                role: "internal_retrieval",
                attempt: 0,
                inputTokens: 1,
                outputTokens: 1,
                cachedTokens: 0,
                reasoningTokens: 0,
                totalTokens: 2,
              })}, 'single-retrieve-internal', 'usage:request:model:single-retrieve-internal:0:0:0'),
              (${ids.run}, 6, ${sql.json({
                type: "usage",
                scope: "request",
                kind: "model",
                role: "direct_answer",
                attempt: 0,
                inputTokens: 2,
                outputTokens: 1,
                cachedTokens: 0,
                reasoningTokens: 0,
                totalTokens: 3,
              })}, 'single-answer', 'usage:request:model:single-answer:0:0:0'),
              (${ids.run}, 7, ${sql.json({
                type: "usage",
                scope: "request",
                kind: "model",
                role: "memory_selector",
                attempt: 0,
                inputTokens: 1,
                outputTokens: 1,
                cachedTokens: 0,
                reasoningTokens: 0,
                totalTokens: 2,
              })}, 'single-select-memories', 'usage:request:model:single-select-memories:0:0:0'),
              (${ids.run}, 8, ${sql.json({
                type: "usage",
                scope: "request",
                kind: "model",
                role: "plan_turn",
                attempt: 0,
                inputTokens: 1,
                outputTokens: 1,
                cachedTokens: 0,
                reasoningTokens: 0,
                totalTokens: 2,
              })}, 'plan-turn', 'usage:request:model:plan-turn:0:0:0'),
              (${ids.run}, 9, ${sql.json({
                type: "usage",
                scope: "request",
                kind: "model",
                role: "memory_extractor",
                attempt: 0,
                inputTokens: 1,
                outputTokens: 1,
                cachedTokens: 0,
                reasoningTokens: 0,
                totalTokens: 2,
              })}, 'memory-extract', 'usage:request:model:memory-extract:0:0:0'),
              (${ids.run}, 10, ${sql.json({ type: "memory_updated", created: 0, updated: 2, discarded: 0 })}, 'finalize', 'memory_updated'),
              (${ids.run}, 14, ${sql.json({
                type: "usage",
                scope: "run",
                model: {
                  inputTokens: 6,
                  outputTokens: 5,
                  cachedTokens: 0,
                  reasoningTokens: 0,
                  totalTokens: 11,
                  requestCount: 5,
                },
                web: { searchCount: 0, fetchCount: 0, responseBytes: 0, billedUnits: 0 },
              })}, 'finalize', 'usage:run'),
              (${ids.run}, 16, ${sql.json({ type: "done", assistantMessageId: ids.assistantMessage })}, 'finalize', 'terminal')
          `;
          const migration = yield* Effect.promise(() =>
            Bun.file(
              new URL(
                "../../../../db/migrations/0064_ai_chat_runtime_cutover.sql",
                import.meta.url,
              ),
            ).text(),
          );
          const [successfulRequestEvent] = yield* sql<{ readonly id: string }>`
            select id::text as id
            from ai_run_events
            where run_id = ${ids.run}
              and emission_key = 'usage:request:model:single-answer:0:0:0'
          `;
          expect(successfulRequestEvent).toBeDefined();
          yield* sql`
            update ai_run_events
            set seq = 15
            where id = ${successfulRequestEvent?.id}
          `;
          const lateSuccessfulRequest = yield* Effect.exit(sql.unsafe(migration).raw);
          expect(errorText(lateSuccessfulRequest)).toContain(
            `ai_run_events/${successfulRequestEvent?.id}`,
          );
          expect(errorText(lateSuccessfulRequest)).toContain(
            "terminal request usage is not ordered after run_started and before usage:run",
          );
          const lateSuccessfulRequestFence = yield* sql<{
            readonly helpers: number;
            readonly finalColumns: number;
          }>`
            select
              (select count(*)::int from pg_proc where pronamespace = 'public'::regnamespace and proname = 'brief_ai_safe_bigint') as helpers,
              (select count(*)::int from information_schema.columns where table_schema = 'public' and table_name = 'ai_runs' and column_name = 'citation_namespace') as "finalColumns"
          `;
          expect(lateSuccessfulRequestFence).toEqual([{ helpers: 0, finalColumns: 0 }]);
          yield* sql`
            update ai_run_events
            set seq = -1
            where id = ${successfulRequestEvent?.id}
          `;
          const earlySuccessfulRequest = yield* Effect.exit(sql.unsafe(migration).raw);
          expect(errorText(earlySuccessfulRequest)).toContain(
            `ai_run_events/${successfulRequestEvent?.id}`,
          );
          expect(errorText(earlySuccessfulRequest)).toContain(
            "terminal request usage is not ordered after run_started and before usage:run",
          );
          const earlySuccessfulRequestFence = yield* sql<{
            readonly helpers: number;
            readonly finalColumns: number;
          }>`
            select
              (select count(*)::int from pg_proc where pronamespace = 'public'::regnamespace and proname = 'brief_ai_safe_bigint') as helpers,
              (select count(*)::int from information_schema.columns where table_schema = 'public' and table_name = 'ai_runs' and column_name = 'citation_namespace') as "finalColumns"
          `;
          expect(earlySuccessfulRequestFence).toEqual([{ helpers: 0, finalColumns: 0 }]);
          yield* sql`
            update ai_run_events
            set seq = 6
            where id = ${successfulRequestEvent?.id}
          `;
          yield* sql`alter table assistant_message_sources disable trigger user`;
          yield* sql`
            update assistant_message_sources
            set source_identity_digest = ${"0".repeat(64)}
            where assistant_message_id = ${ids.assistantMessage}
              and source_key = ${oldKey1}
          `;
          yield* sql`alter table assistant_message_sources enable trigger user`;
          const tamperedSource = yield* Effect.exit(sql.unsafe(migration).raw);
          expect(errorText(tamperedSource)).toContain(
            `assistant_message_sources/${ids.assistantMessage}/${oldKey1}`,
          );
          expect(errorText(tamperedSource)).toContain(
            "stored source identity digest does not match retained fields",
          );
          yield* sql`alter table assistant_message_sources disable trigger user`;
          yield* sql`
            update assistant_message_sources
            set source_identity_digest = assistant_message_source_identity_digest(
              assistant_message_id, source_key, kind, locator, document_version_id,
              publisher_document_version_id, message_id, memory_revision_id,
              display_label, public_provenance
            )
            where assistant_message_id = ${ids.assistantMessage}
              and source_key = ${oldKey1}
          `;
          yield* sql`alter table assistant_message_sources enable trigger user`;
          const setContextOrder = (contextOrder: number) =>
            sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`alter table assistant_message_source_uses disable trigger user`;
                yield* sql`
                  update assistant_message_source_uses
                  set context_order = ${contextOrder},
                      source_use_identity_digest = assistant_message_source_use_identity_digest(
                        assistant_message_id, source_key, consumer_task_id, topic_id,
                        rendered_token_count, ${contextOrder}, ranges
                      )
                  where assistant_message_id = ${ids.assistantMessage}
                    and source_key = ${oldKey3}
                `;
                yield* sql`alter table assistant_message_source_uses enable trigger user`;
              }),
            );
          yield* setContextOrder(2);
          const gappedContext = yield* Effect.exit(sql.unsafe(migration).raw);
          expect(errorText(gappedContext)).toContain(
            `assistant_message_source_uses/${ids.assistantMessage}/${oldKey3}/single-answer/-`,
          );
          expect(errorText(gappedContext)).toContain(
            "context orders must be unique and contiguous from zero",
          );
          const unchangedAfterLateBlocker = yield* sql<{
            readonly helpers: number;
            readonly finalColumns: number;
          }>`
            select
              (
                select count(*)::int
                from pg_proc
                where pronamespace = 'public'::regnamespace
                  and proname in (
                    'brief_ai_safe_bigint', 'brief_ai_utf16_length', 'brief_ai_legacy_json_key',
                    'brief_ai_valid_restricted_context_ledger', 'brief_ai_valid_terminal_usage_coordinate',
                    'brief_ai_normalize_ranges'
                  )
              ) as helpers,
              (
                select count(*)::int
                from information_schema.columns
                where table_schema = 'public'
                  and table_name = 'ai_runs'
                  and column_name = 'citation_namespace'
              ) as "finalColumns"
          `;
          expect(unchangedAfterLateBlocker).toEqual([{ helpers: 0, finalColumns: 0 }]);
          yield* setContextOrder(0);
          const duplicateContext = yield* Effect.exit(sql.unsafe(migration).raw);
          expect(errorText(duplicateContext)).toContain(
            `assistant_message_source_uses/${ids.assistantMessage}/${oldKey3}/single-answer/-`,
          );
          expect(errorText(duplicateContext)).toContain(
            "context orders must be unique and contiguous from zero",
          );
          yield* setContextOrder(1);
          yield* sql`
            update ai_observations
            set payload = jsonb_set(
              payload,
              '{restrictedContextLedger,sources}',
              (payload->'restrictedContextLedger'->'sources') || jsonb_build_array(
                jsonb_build_object(
                  'candidateId', ${ids.memory3}::text,
                  'sourceKey', ${unknownKey}::text,
                  'kind', 'memory',
                  'purpose', 'grounding',
                  'label', 'Omitted fact',
                  'ranges', '[]'::jsonb
                )
              ),
              true
            )
            where run_id = ${ids.run}
              and kind = 'context_serialized'
          `;
          const extraOmittedContext = yield* Effect.exit(sql.unsafe(migration).raw);
          expect(errorText(extraOmittedContext)).toContain(`ai_observations/${ids.run}/`);
          expect(errorText(extraOmittedContext)).toContain(
            "context decision does not project the exact serialized context",
          );
          const unchangedAfterContextProjection = yield* sql<{
            readonly helpers: number;
            readonly finalColumns: number;
          }>`
            select
              (
                select count(*)::int
                from pg_proc
                where pronamespace = 'public'::regnamespace
                  and proname in (
                    'brief_ai_safe_bigint', 'brief_ai_utf16_length', 'brief_ai_legacy_json_key',
                    'brief_ai_valid_restricted_context_ledger', 'brief_ai_valid_terminal_usage_coordinate',
                    'brief_ai_normalize_ranges'
                  )
              ) as helpers,
              (
                select count(*)::int
                from information_schema.columns
                where table_schema = 'public'
                  and table_name = 'ai_runs'
                  and column_name = 'citation_namespace'
              ) as "finalColumns"
          `;
          expect(unchangedAfterContextProjection).toEqual([{ helpers: 0, finalColumns: 0 }]);
          yield* sql`
            update ai_observations
            set payload = jsonb_set(
              payload,
              '{restrictedContextLedger,sources}',
              (payload->'restrictedContextLedger'->'sources') - 2,
              true
            )
            where run_id = ${ids.run}
              and kind = 'context_serialized'
          `;
          const [selectorManifest] = yield* sql<{ readonly id: string }>`
            select id::text as id
            from ai_observations
            where run_id = ${ids.run}
              and observation_key = 'single-select-memories:0:0:retrieval_manifest:result'
          `;
          yield* sql`alter table ai_source_exposures disable trigger user`;
          yield* sql`
            update ai_source_exposures
            set task_id = 'single-answer'
            where run_id = ${ids.run}
              and task_id = 'single-select-memories'
              and content_item_identity = ${ids.revision2}
          `;
          yield* sql`alter table ai_source_exposures enable trigger user`;
          yield* sql`
            update ai_observations
            set emitting_task = 'single-answer',
                observation_key = ${wrongOwnerSelectorAttestationKey2},
                payload = jsonb_set(
                  payload,
                  '{providerRequestSha256Hex}',
                  to_jsonb(${"a".repeat(64)}::text),
                  true
                )
            where run_id = ${ids.run}
              and kind = 'source_exposure_attestation'
              and emitting_task = 'single-select-memories'
              and payload->>'contentItemIdentity' = ${ids.revision2}
          `;
          yield* sql`
            update ai_observations
            set payload = jsonb_set(
              jsonb_set(
                payload,
                '{sourceExposureProofSha256Hexes}',
                (${sql.json({
                  value: [selectorExposureProof, selectorExposureProof3].sort(),
                })}::jsonb->'value'),
                true
              ),
              '{sourceExposureProofBindings}',
              (${sql.json({
                value: [
                  {
                    providerSerializationProofSha256Hex: selectorExposureProof,
                    providerSerializationProofBinding: selectorExposureBinding,
                  },
                  {
                    providerSerializationProofSha256Hex: selectorExposureProof3,
                    providerSerializationProofBinding: selectorExposureBinding3,
                  },
                ].sort((left, right) =>
                  left.providerSerializationProofSha256Hex.localeCompare(
                    right.providerSerializationProofSha256Hex,
                  ),
                ),
              })}::jsonb->'value'),
              true
            )
            where run_id = ${ids.run}
              and observation_key = 'provider_request_measurement:single-select-memories:0:0:0'
          `;
          yield* sql`
            update ai_observations
            set payload = jsonb_set(
              jsonb_set(
                payload,
                '{sourceExposureProofSha256Hexes}',
                (${sql.json({
                  value: [exposureProof, exposureProof2, selectorExposureProof2].sort(),
                })}::jsonb->'value'),
                true
              ),
              '{sourceExposureProofBindings}',
              (${sql.json({
                value: [
                  {
                    providerSerializationProofSha256Hex: exposureProof,
                    providerSerializationProofBinding: exposureBinding,
                  },
                  {
                    providerSerializationProofSha256Hex: exposureProof2,
                    providerSerializationProofBinding: {
                      ...exposureBinding,
                      sourceOrdinal: 1,
                      orderedSourceDescriptor: `memory:${ids.memory2}`,
                    },
                  },
                  {
                    providerSerializationProofSha256Hex: selectorExposureProof2,
                    providerSerializationProofBinding: selectorExposureBinding2,
                  },
                ].sort((left, right) =>
                  left.providerSerializationProofSha256Hex.localeCompare(
                    right.providerSerializationProofSha256Hex,
                  ),
                ),
              })}::jsonb->'value'),
              true
            )
            where run_id = ${ids.run}
              and observation_key = 'provider_request_measurement:single-answer:0:0:0'
          `;
          const wrongSelectorOwner = yield* Effect.exit(sql.unsafe(migration).raw);
          expect(errorText(wrongSelectorOwner)).toContain(
            `ai_observations/${selectorManifest?.id}/2`,
          );
          expect(errorText(wrongSelectorOwner)).toContain(
            "terminal selector reference lacks its exact selector-owned exposure and provider proof coordinate",
          );
          const selectorOwnerFence = yield* sql<{
            readonly helpers: number;
            readonly finalColumns: number;
          }>`
            select
              (select count(*)::int from pg_proc where pronamespace = 'public'::regnamespace and proname = 'brief_ai_safe_bigint') as helpers,
              (select count(*)::int from information_schema.columns where table_schema = 'public' and table_name = 'ai_runs' and column_name = 'citation_namespace') as "finalColumns"
          `;
          expect(selectorOwnerFence).toEqual([{ helpers: 0, finalColumns: 0 }]);
          yield* sql`alter table ai_source_exposures disable trigger user`;
          yield* sql`
            update ai_source_exposures
            set task_id = 'single-select-memories'
            where run_id = ${ids.run}
              and task_id = 'single-answer'
              and exposure_stage = ${selectorExposureStage}
              and content_item_identity = ${ids.revision2}
          `;
          yield* sql`alter table ai_source_exposures enable trigger user`;
          yield* sql`
            update ai_observations
            set emitting_task = 'single-select-memories',
                observation_key = ${selectorAttestationKey2},
                payload = jsonb_set(
                  payload,
                  '{providerRequestSha256Hex}',
                  to_jsonb(${"e".repeat(64)}::text),
                  true
                )
            where run_id = ${ids.run}
              and kind = 'source_exposure_attestation'
              and emitting_task = 'single-answer'
              and observation_key = ${wrongOwnerSelectorAttestationKey2}
              and payload->>'contentItemIdentity' = ${ids.revision2}
          `;
          yield* sql`
            update ai_observations
            set payload = jsonb_set(
              jsonb_set(
                payload,
                '{sourceExposureProofSha256Hexes}',
                (${sql.json({
                  value: [
                    selectorExposureProof,
                    selectorExposureProof2,
                    selectorExposureProof3,
                  ].sort(),
                })}::jsonb->'value'),
                true
              ),
              '{sourceExposureProofBindings}',
              (${sql.json({
                value: [
                  {
                    providerSerializationProofSha256Hex: selectorExposureProof,
                    providerSerializationProofBinding: selectorExposureBinding,
                  },
                  {
                    providerSerializationProofSha256Hex: selectorExposureProof2,
                    providerSerializationProofBinding: selectorExposureBinding2,
                  },
                  {
                    providerSerializationProofSha256Hex: selectorExposureProof3,
                    providerSerializationProofBinding: selectorExposureBinding3,
                  },
                ].sort((left, right) =>
                  left.providerSerializationProofSha256Hex.localeCompare(
                    right.providerSerializationProofSha256Hex,
                  ),
                ),
              })}::jsonb->'value'),
              true
            )
            where run_id = ${ids.run}
              and observation_key = 'provider_request_measurement:single-select-memories:0:0:0'
          `;
          yield* sql`
            update ai_observations
            set payload = jsonb_set(
              jsonb_set(
                payload,
                '{sourceExposureProofSha256Hexes}',
                (${sql.json({ value: [exposureProof, exposureProof2].sort() })}::jsonb->'value'),
                true
              ),
              '{sourceExposureProofBindings}',
              (${sql.json({
                value: [
                  {
                    providerSerializationProofSha256Hex: exposureProof,
                    providerSerializationProofBinding: exposureBinding,
                  },
                  {
                    providerSerializationProofSha256Hex: exposureProof2,
                    providerSerializationProofBinding: {
                      ...exposureBinding,
                      sourceOrdinal: 1,
                      orderedSourceDescriptor: `memory:${ids.memory2}`,
                    },
                  },
                ].sort((left, right) =>
                  left.providerSerializationProofSha256Hex.localeCompare(
                    right.providerSerializationProofSha256Hex,
                  ),
                ),
              })}::jsonb->'value'),
              true
            )
            where run_id = ${ids.run}
              and observation_key = 'provider_request_measurement:single-answer:0:0:0'
          `;
          yield* sql`alter table ai_source_exposures disable trigger user`;
          yield* sql`
            delete from ai_source_exposures
            where run_id = ${ids.run}
              and task_id = 'single-select-memories'
              and content_item_identity = ${ids.revision2}
          `;
          yield* sql`alter table ai_source_exposures enable trigger user`;
          yield* sql`
            delete from ai_observations
            where run_id = ${ids.run}
              and kind = 'source_exposure_attestation'
              and emitting_task = 'single-select-memories'
              and payload->>'contentItemIdentity' = ${ids.revision2}
          `;
          yield* sql`
            update ai_observations
            set payload = jsonb_set(
              jsonb_set(
                payload,
                '{sourceExposureProofSha256Hexes}',
                (${sql.json({
                  value: [selectorExposureProof, selectorExposureProof3].sort(),
                })}::jsonb->'value'),
                true
              ),
              '{sourceExposureProofBindings}',
              (${sql.json({
                value: [
                  {
                    providerSerializationProofSha256Hex: selectorExposureProof,
                    providerSerializationProofBinding: selectorExposureBinding,
                  },
                  {
                    providerSerializationProofSha256Hex: selectorExposureProof3,
                    providerSerializationProofBinding: selectorExposureBinding3,
                  },
                ].sort((left, right) =>
                  left.providerSerializationProofSha256Hex.localeCompare(
                    right.providerSerializationProofSha256Hex,
                  ),
                ),
              })}::jsonb->'value'),
              true
            )
            where run_id = ${ids.run}
              and observation_key = 'provider_request_measurement:single-select-memories:0:0:0'
          `;
          const missingSelectorExposure = yield* Effect.exit(sql.unsafe(migration).raw);
          expect(errorText(missingSelectorExposure)).toContain(
            `ai_observations/${selectorManifest?.id}/2`,
          );
          expect(errorText(missingSelectorExposure)).toContain(
            "terminal selector reference lacks its exact selector-owned exposure and provider proof coordinate",
          );
          const missingSelectorFence = yield* sql<{
            readonly helpers: number;
            readonly finalColumns: number;
          }>`
            select
              (select count(*)::int from pg_proc where pronamespace = 'public'::regnamespace and proname = 'brief_ai_safe_bigint') as helpers,
              (select count(*)::int from information_schema.columns where table_schema = 'public' and table_name = 'ai_runs' and column_name = 'citation_namespace') as "finalColumns"
          `;
          expect(missingSelectorFence).toEqual([{ helpers: 0, finalColumns: 0 }]);
          yield* sql`
            insert into ai_source_exposures (
              run_id, task_id, loop_iteration, attempt, provider_request_index,
              source_kind, logical_source_identity, content_item_identity,
              exposure_stage, visible_token_count
            ) values (
              ${ids.run}, 'single-select-memories', 0, 0, 0, 'memory',
              ${`memory:${ids.memory2}`}, ${ids.revision2}, ${selectorExposureStage}, 2
            )
          `;
          yield* sql`
            insert into ai_observations (
              run_id, chat_id, emitting_task, loop_iteration, attempt,
              observation_key, kind, payload
            ) values (
              ${ids.run}, ${ids.chat}, 'single-select-memories', 0, 0,
              ${selectorAttestationKey2}, 'source_exposure_attestation',
              ${sql.json({
                providerRequestIndex: 0,
                providerRequestSha256Hex: "e".repeat(64),
                sourceKind: "memory",
                logicalSourceIdentity: `memory:${ids.memory2}`,
                contentItemIdentity: ids.revision2,
                exposureStage: selectorExposureStage,
                visibleTokenCount: 2,
                providerSerializationProofSha256Hex: selectorExposureProof2,
                providerSerializationProofBinding: selectorExposureBinding2,
              })}
            )
          `;
          yield* sql`
            update ai_observations
            set payload = jsonb_set(
              jsonb_set(
                payload,
                '{sourceExposureProofSha256Hexes}',
                (${sql.json({
                  value: [
                    selectorExposureProof,
                    selectorExposureProof2,
                    selectorExposureProof3,
                  ].sort(),
                })}::jsonb->'value'),
                true
              ),
              '{sourceExposureProofBindings}',
              (${sql.json({
                value: [
                  {
                    providerSerializationProofSha256Hex: selectorExposureProof,
                    providerSerializationProofBinding: selectorExposureBinding,
                  },
                  {
                    providerSerializationProofSha256Hex: selectorExposureProof2,
                    providerSerializationProofBinding: selectorExposureBinding2,
                  },
                  {
                    providerSerializationProofSha256Hex: selectorExposureProof3,
                    providerSerializationProofBinding: selectorExposureBinding3,
                  },
                ].sort((left, right) =>
                  left.providerSerializationProofSha256Hex.localeCompare(
                    right.providerSerializationProofSha256Hex,
                  ),
                ),
              })}::jsonb->'value'),
              true
            )
            where run_id = ${ids.run}
              and observation_key = 'provider_request_measurement:single-select-memories:0:0:0'
          `;

          const [memoryWrite] = yield* sql<{ readonly id: string }>`
            select id::text as id
            from ai_observations
            where run_id = ${ids.run}
              and kind = 'memory_written'
              and payload->>'memoryId' = ${ids.memory}
          `;
          yield* sql`
            update ai_observations
            set payload = jsonb_set(
              payload,
              '{previousRevisionId}',
              to_jsonb(${ids.olderRevision}::text),
              true
            )
            where id = ${memoryWrite?.id}::uuid
          `;
          const wrongPreviousRevision = yield* Effect.exit(sql.unsafe(migration).raw);
          expect(errorText(wrongPreviousRevision)).toContain(`ai_observations/${memoryWrite?.id}`);
          expect(errorText(wrongPreviousRevision)).toContain(
            "memory write is not bound to its immediate prior revision and current live head",
          );
          const previousRevisionFence = yield* sql<{
            readonly helpers: number;
            readonly finalColumns: number;
          }>`
            select
              (select count(*)::int from pg_proc where pronamespace = 'public'::regnamespace and proname = 'brief_ai_safe_bigint') as helpers,
              (select count(*)::int from information_schema.columns where table_schema = 'public' and table_name = 'ai_runs' and column_name = 'citation_namespace') as "finalColumns"
          `;
          expect(previousRevisionFence).toEqual([{ helpers: 0, finalColumns: 0 }]);
          yield* sql`
            update ai_observations
            set payload = jsonb_set(
              payload,
              '{previousRevisionId}',
              to_jsonb(${ids.revision}::text),
              true
            )
            where id = ${memoryWrite?.id}::uuid
          `;

          yield* sql`
            update user_memories
            set head_revision_id = ${ids.revision}
            where id = ${ids.memory}
          `;
          const staleMemoryHead = yield* Effect.exit(sql.unsafe(migration).raw);
          expect(errorText(staleMemoryHead)).toContain(`ai_observations/${memoryWrite?.id}`);
          expect(errorText(staleMemoryHead)).toContain(
            "memory write is not bound to its immediate prior revision and current live head",
          );
          const staleHeadFence = yield* sql<{
            readonly helpers: number;
            readonly finalColumns: number;
          }>`
            select
              (select count(*)::int from pg_proc where pronamespace = 'public'::regnamespace and proname = 'brief_ai_safe_bigint') as helpers,
              (select count(*)::int from information_schema.columns where table_schema = 'public' and table_name = 'ai_runs' and column_name = 'citation_namespace') as "finalColumns"
          `;
          expect(staleHeadFence).toEqual([{ helpers: 0, finalColumns: 0 }]);
          yield* sql`
            update user_memories
            set head_revision_id = ${ids.writeRevision}
            where id = ${ids.memory}
          `;
          yield* sql`
            update user_memories
            set source_message_id = null
            where id = ${ids.memory}
          `;
          const wrongMemoryProvenance = yield* Effect.exit(sql.unsafe(migration).raw);
          expect(errorText(wrongMemoryProvenance)).toContain(`ai_observations/${memoryWrite?.id}`);
          expect(errorText(wrongMemoryProvenance)).toContain(
            "memory write is not bound to its immediate prior revision and current live head",
          );
          const memoryProvenanceFence = yield* sql<{
            readonly helpers: number;
            readonly finalColumns: number;
          }>`
            select
              (select count(*)::int from pg_proc where pronamespace = 'public'::regnamespace and proname = 'brief_ai_safe_bigint') as helpers,
              (select count(*)::int from information_schema.columns where table_schema = 'public' and table_name = 'ai_runs' and column_name = 'citation_namespace') as "finalColumns"
          `;
          expect(memoryProvenanceFence).toEqual([{ helpers: 0, finalColumns: 0 }]);
          yield* sql`
            update user_memories
            set source_message_id = ${ids.userMessage}
            where id = ${ids.memory}
          `;
          yield* sql`update ai_runs set web_search_enabled = true, effective_web_policy = ${sql.json({ enabled: true, reason: null, allowlistActive: false })} where id = ${ids.run}`;
          yield* sql`
            update ai_observations
            set payload = ${sql.json({
              selectorRole: "web",
              references: [webReference],
            })}
            where run_id = ${ids.run}
              and emitting_task = 'single-retrieve-web'
              and kind = 'retrieval_manifest'
          `;
          yield* sql`
            delete from ai_observations
            where run_id = ${ids.run}
              and observation_key = 'retrieval_no_call_seal:single-retrieve-web:0:0'
          `;
          yield* sql`
            insert into ai_observations (
              run_id, chat_id, emitting_task, loop_iteration, attempt,
              observation_key, kind, payload
            ) values (
              ${ids.run}, ${ids.chat}, 'single-retrieve-web', 0, 0,
              'provider_request_measurement:single-retrieve-web:0:0:0',
              'provider_request_measurement',
              ${sql.json({
                agentRole: "web_research",
                modelId: "glm-5-turbo",
                requestSha256Hex: "d".repeat(64),
                sourceExposureProofSha256Hexes: [webExposureProof],
                sourceExposureProofBindings: [
                  {
                    providerSerializationProofSha256Hex: webExposureProof,
                    providerSerializationProofBinding: webExposureBinding,
                  },
                ],
                providerRequestIndex: 0,
                inputTokens: 1,
                requestedOutputTokens: 1,
                usableInputTokens: 1,
                contextWindow: 100,
                passed: true,
              })}
            )
          `;
          yield* sql`
            insert into ai_run_usage (
              run_id, task_id, loop_iteration, attempt, provider_request_index,
              agent_role, model_id, provider_service_id, input_tokens, output_tokens,
              cached_tokens, reasoning_tokens, total_tokens, stop_reason
            ) values (
              ${ids.run}, 'single-retrieve-web', 0, 0, 0,
              'web_research', 'glm-5-turbo', 'deterministic_test', 1, 1, 0, 0, 2, 'stop'
            )
          `;
          yield* sql`
            insert into ai_external_tool_usage (
              run_id, task_id, loop_iteration, attempt, tool_request_index,
              provider_service_id, operation, status, result_count,
              response_bytes, billed_units, duration_ms
            ) values (
              ${ids.run}, 'single-retrieve-web', 0, 0, 0,
              'deterministic_test', 'web_fetch', 'ok', 1, 100, 0, 1
            )
          `;
          yield* sql`
            insert into ai_source_exposures (
              run_id, task_id, loop_iteration, attempt, provider_request_index,
              source_kind, logical_source_identity, content_item_identity,
              exposure_stage, visible_token_count
            ) values (
              ${ids.run}, 'single-retrieve-web', 0, 0, 0, 'web',
              ${webUrl}, ${webContentItemIdentity}, ${webExposureStage}, 2
            )
          `;
          yield* sql`
            insert into ai_observations (
              run_id, chat_id, emitting_task, loop_iteration, attempt,
              observation_key, kind, payload
            ) values (
              ${ids.run}, ${ids.chat}, 'single-retrieve-web', 0, 0,
              ${webAttestationKey}, 'source_exposure_attestation',
              ${sql.json({
                providerRequestIndex: 0,
                providerRequestSha256Hex: "d".repeat(64),
                sourceKind: "web",
                logicalSourceIdentity: webUrl,
                contentItemIdentity: webContentItemIdentity,
                exposureStage: webExposureStage,
                visibleTokenCount: 2,
                providerSerializationProofSha256Hex: webExposureProof,
                providerSerializationProofBinding: webExposureBinding,
              })}
            )
          `;
          yield* sql`
            update ai_run_events
            set event = jsonb_set(
              jsonb_set(
                jsonb_set(
                  jsonb_set(
                    jsonb_set(event, '{model,inputTokens}', '7'::jsonb),
                    '{model,outputTokens}', '6'::jsonb
                  ),
                  '{model,totalTokens}', '13'::jsonb
                ),
                '{model,requestCount}', '6'::jsonb
              ),
              '{web,fetchCount}', '1'::jsonb
            )
            where run_id = ${ids.run} and emission_key = 'usage:run'
          `;
          yield* sql`
            update ai_run_events
            set event = jsonb_set(
              jsonb_set(event, '{web,responseBytes}', '100'::jsonb),
              '{web,billedUnits}', '0'::jsonb
            )
            where run_id = ${ids.run} and emission_key = 'usage:run'
          `;
          yield* sql`
            insert into ai_run_events (run_id, seq, event, emitted_by_task, emission_key)
            values (
              ${ids.run}, 11, ${sql.json({
                type: "usage",
                scope: "request",
                kind: "model",
                role: "web_research",
                attempt: 0,
                inputTokens: 1,
                outputTokens: 1,
                cachedTokens: 0,
                reasoningTokens: 0,
                totalTokens: 2,
              })}, 'single-retrieve-web',
              'usage:request:model:single-retrieve-web:0:0:0'
            ), (
              ${ids.run}, 12, ${sql.json({
                type: "usage",
                scope: "request",
                kind: "web_fetch",
                attempt: 0,
                status: "ok",
                resultCount: 1,
                responseBytes: 100,
                billedUnits: 0,
                durationMs: 1,
              })}, 'single-retrieve-web',
              'usage:request:web_fetch:single-retrieve-web:0:0:0'
            )
          `;
          const [webManifest] = yield* sql<{ readonly id: string }>`
            select id::text as id
            from ai_observations
            where run_id = ${ids.run}
              and emitting_task = 'single-retrieve-web'
              and kind = 'retrieval_manifest'
          `;
          const [webExposure] = yield* sql<{ readonly id: string }>`
            select id::text as id
            from ai_source_exposures
            where run_id = ${ids.run}
              and task_id = 'single-retrieve-web'
              and provider_request_index = 0
          `;
          yield* sql`alter table ai_source_exposures disable trigger user`;
          yield* sql`
            update ai_source_exposures
            set content_item_identity = ${wrongWebContentItemIdentity}
            where id::text = ${webExposure?.id}
          `;
          yield* sql`alter table ai_source_exposures enable trigger user`;
          yield* sql`
            update ai_observations
            set payload = jsonb_set(
              jsonb_set(
                jsonb_set(
                  payload,
                  '{contentItemIdentity}',
                  to_jsonb(${wrongWebContentItemIdentity}::text),
                  true
                ),
                '{providerSerializationProofSha256Hex}',
                to_jsonb(${wrongWebExposureProof}::text),
                true
              ),
              '{providerSerializationProofBinding}',
              (${sql.json(wrongWebExposureBinding)}::jsonb),
              true
            )
            where run_id = ${ids.run}
              and emitting_task = 'single-retrieve-web'
              and kind = 'source_exposure_attestation'
          `;
          yield* sql`
            update ai_observations
            set payload = jsonb_set(
              jsonb_set(
                payload,
                '{sourceExposureProofSha256Hexes}',
                (${sql.json({ value: [wrongWebExposureProof] })}::jsonb->'value'),
                true
              ),
              '{sourceExposureProofBindings}',
              (${sql.json({
                value: [
                  {
                    providerSerializationProofSha256Hex: wrongWebExposureProof,
                    providerSerializationProofBinding: wrongWebExposureBinding,
                  },
                ],
              })}::jsonb->'value'),
              true
            )
            where run_id = ${ids.run}
              and observation_key = 'provider_request_measurement:single-retrieve-web:0:0:0'
          `;
          const wrongWebContentItem = yield* Effect.exit(sql.unsafe(migration).raw);
          expect(errorText(wrongWebContentItem)).toContain(`ai_observations/${webManifest?.id}/1`);
          expect(errorText(wrongWebContentItem)).toContain(
            "terminal selector reference lacks its exact selector-owned exposure and provider proof coordinate",
          );
          const wrongWebContentItemFence = yield* sql<{
            readonly helpers: number;
            readonly finalColumns: number;
          }>`
            select
              (select count(*)::int from pg_proc where pronamespace = 'public'::regnamespace and proname = 'brief_ai_safe_bigint') as helpers,
              (select count(*)::int from information_schema.columns where table_schema = 'public' and table_name = 'ai_runs' and column_name = 'citation_namespace') as "finalColumns"
          `;
          expect(wrongWebContentItemFence).toEqual([{ helpers: 0, finalColumns: 0 }]);
          yield* sql`alter table ai_source_exposures disable trigger user`;
          yield* sql`
            update ai_source_exposures
            set content_item_identity = ${webContentItemIdentity}
            where id::text = ${webExposure?.id}
          `;
          yield* sql`alter table ai_source_exposures enable trigger user`;
          yield* sql`
            update ai_observations
            set payload = jsonb_set(
              jsonb_set(
                jsonb_set(
                  payload,
                  '{contentItemIdentity}',
                  to_jsonb(${webContentItemIdentity}::text),
                  true
                ),
                '{providerSerializationProofSha256Hex}',
                to_jsonb(${webExposureProof}::text),
                true
              ),
              '{providerSerializationProofBinding}',
              (${sql.json(webExposureBinding)}::jsonb),
              true
            )
            where run_id = ${ids.run}
              and emitting_task = 'single-retrieve-web'
              and kind = 'source_exposure_attestation'
          `;
          yield* sql`
            update ai_observations
            set payload = jsonb_set(
              jsonb_set(
                payload,
                '{sourceExposureProofSha256Hexes}',
                (${sql.json({ value: [webExposureProof] })}::jsonb->'value'),
                true
              ),
              '{sourceExposureProofBindings}',
              (${sql.json({
                value: [
                  {
                    providerSerializationProofSha256Hex: webExposureProof,
                    providerSerializationProofBinding: webExposureBinding,
                  },
                ],
              })}::jsonb->'value'),
              true
            )
            where run_id = ${ids.run}
              and observation_key = 'provider_request_measurement:single-retrieve-web:0:0:0'
          `;
          yield* sql`alter table ai_source_exposures disable trigger user`;
          yield* sql`
            update ai_source_exposures
            set task_id = 'single-answer'
            where id::text = ${webExposure?.id}
          `;
          yield* sql`alter table ai_source_exposures enable trigger user`;
          const wrongWebOwner = yield* Effect.exit(sql.unsafe(migration).raw);
          expect(errorText(wrongWebOwner)).toContain(`ai_source_exposures/${webExposure?.id}`);
          expect(errorText(wrongWebOwner)).toContain("exposure has no exact attestation row");
          const wrongWebOwnerFence = yield* sql<{
            readonly helpers: number;
            readonly finalColumns: number;
          }>`
            select
              (select count(*)::int from pg_proc where pronamespace = 'public'::regnamespace and proname = 'brief_ai_safe_bigint') as helpers,
              (select count(*)::int from information_schema.columns where table_schema = 'public' and table_name = 'ai_runs' and column_name = 'citation_namespace') as "finalColumns"
          `;
          expect(wrongWebOwnerFence).toEqual([{ helpers: 0, finalColumns: 0 }]);
          yield* sql`alter table ai_source_exposures disable trigger user`;
          yield* sql`
            update ai_source_exposures
            set task_id = 'single-retrieve-web'
            where id::text = ${webExposure?.id}
          `;
          yield* sql`alter table ai_source_exposures enable trigger user`;
          yield* sql`
            update ai_run_events
            set event = jsonb_set(
              jsonb_set(
                jsonb_set(event, '{web,searchCount}', '1'::jsonb),
                '{web,responseBytes}', '110'::jsonb
              ),
              '{web,billedUnits}', '0'::jsonb
            )
            where run_id = ${ids.run} and emission_key = 'usage:run'
          `;
          yield* sql`
            insert into ai_external_tool_usage (
              run_id, task_id, loop_iteration, attempt, tool_request_index,
              provider_service_id, operation, status, result_count,
              response_bytes, billed_units, duration_ms
            ) values (
              ${ids.run}, 'evaluation-general-planner', 0, 0, 0,
              'deterministic_test', 'web_search', 'ok', 1, 10, 0, 1
            )
          `;
          yield* sql`
            insert into ai_run_events (run_id, seq, event, emitted_by_task, emission_key)
            values (
              ${ids.run}, 0, ${sql.json({
                type: "usage",
                scope: "request",
                kind: "web_search",
                attempt: 0,
                status: "ok",
                resultCount: 1,
                responseBytes: 10,
                billedUnits: 0,
                durationMs: 1,
              })}, 'evaluation-general-planner',
              'usage:request:web_search:evaluation-general-planner:0:0:0'
            )
          `;
          const [successfulExternalRequestEvent] = yield* sql<{ readonly id: string }>`
            select id::text as id
            from ai_run_events
            where run_id = ${ids.run}
              and emission_key = 'usage:request:web_search:evaluation-general-planner:0:0:0'
          `;
          expect(successfulExternalRequestEvent).toBeDefined();
          yield* sql`
            update ai_run_events
            set seq = 15
            where id = ${successfulExternalRequestEvent?.id}
          `;
          const lateSuccessfulExternalRequest = yield* Effect.exit(sql.unsafe(migration).raw);
          expect(errorText(lateSuccessfulExternalRequest)).toContain(
            `ai_run_events/${successfulExternalRequestEvent?.id}`,
          );
          expect(errorText(lateSuccessfulExternalRequest)).toContain(
            "terminal request usage is not ordered after run_started and before usage:run",
          );
          const lateSuccessfulExternalRequestFence = yield* sql<{
            readonly helpers: number;
            readonly finalColumns: number;
          }>`
            select
              (select count(*)::int from pg_proc where pronamespace = 'public'::regnamespace and proname = 'brief_ai_safe_bigint') as helpers,
              (select count(*)::int from information_schema.columns where table_schema = 'public' and table_name = 'ai_runs' and column_name = 'citation_namespace') as "finalColumns"
          `;
          expect(lateSuccessfulExternalRequestFence).toEqual([{ helpers: 0, finalColumns: 0 }]);
          yield* sql`
            update ai_run_events
            set seq = -1
            where id = ${successfulExternalRequestEvent?.id}
          `;
          const earlySuccessfulExternalRequest = yield* Effect.exit(sql.unsafe(migration).raw);
          expect(errorText(earlySuccessfulExternalRequest)).toContain(
            `ai_run_events/${successfulExternalRequestEvent?.id}`,
          );
          expect(errorText(earlySuccessfulExternalRequest)).toContain(
            "terminal request usage is not ordered after run_started and before usage:run",
          );
          const earlySuccessfulExternalRequestFence = yield* sql<{
            readonly helpers: number;
            readonly finalColumns: number;
          }>`
            select
              (select count(*)::int from pg_proc where pronamespace = 'public'::regnamespace and proname = 'brief_ai_safe_bigint') as helpers,
              (select count(*)::int from information_schema.columns where table_schema = 'public' and table_name = 'ai_runs' and column_name = 'citation_namespace') as "finalColumns"
          `;
          expect(earlySuccessfulExternalRequestFence).toEqual([{ helpers: 0, finalColumns: 0 }]);
          yield* sql`
            update ai_run_events
            set seq = 13
            where id = ${successfulExternalRequestEvent?.id}
          `;
          yield* sql.unsafe(migration).raw;
          yield* sql.unsafe(migration).raw;
        }),
      );

      const result = await runDb(
        databaseUrl,
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const [message] = yield* sql<{ readonly content: string }>`
            select content from chat_messages where id = ${ids.assistantMessage}
          `;
          const sources = yield* sql<{ readonly sourceKey: string; readonly ordinal: number }>`
            select source_key as "sourceKey",
              substring(source_key from '_([1-9][0-9]*)$')::int as ordinal
            from assistant_message_sources
            where assistant_message_id = ${ids.assistantMessage}
            order by ordinal
          `;
          const memory = yield* sql<{
            readonly deletedAt: string | null;
            readonly provenanceOnlyAt: string | null;
          }>`
            select deleted_at as "deletedAt", provenance_only_at as "provenanceOnlyAt"
            from user_memories where id = ${ids.memory}
          `;
          const acceptedRevisions = yield* sql<{
            readonly id: string;
            readonly runId: string | null;
          }>`
            select id::text as id, run_id::text as "runId"
            from user_memory_revisions
            where id in (${ids.writeRevision}, ${ids.writeRevision2})
            order by id
          `;
          const memoryHeads = yield* sql<{
            readonly id: string;
            readonly headRevisionId: string | null;
          }>`
            select id::text as id, head_revision_id::text as "headRevisionId"
            from user_memories
            where id in (${ids.memory}, ${ids.memory2})
            order by id
          `;
          const retainedSourceRevisions = yield* sql<{ readonly revisionId: string }>`
            select locator->>'memoryRevisionId' as "revisionId"
            from assistant_message_sources
            where assistant_message_id = ${ids.assistantMessage}
            order by source_key
          `;
          const citation = yield* sql<{ readonly sourceKey: string }>`
            select payload->>'sourceKey' as "sourceKey"
            from ai_observations
            where run_id = ${ids.run} and kind = 'citation'
            order by id limit 1
          `;
          const rejected = yield* sql<{ readonly candidateId: string }>`
            select payload->>'candidateId' as "candidateId"
            from ai_observations
            where run_id = ${ids.run} and kind = 'candidate_rejected'
            order by id limit 1
          `;
          const delta = yield* sql<{ readonly delta: string }>`
            select payload->>'delta' as delta
            from ai_observations
            where run_id = ${ids.run} and kind = 'answer_delta'
            order by id limit 1
          `;
          const contextReady = yield* sql<{
            readonly sourcesRead: readonly Record<string, unknown>[];
          }>`
            select event->'sourcesRead' as "sourcesRead"
            from ai_run_events
            where run_id = ${ids.run} and event->>'type' = 'context_ready'
            order by seq limit 1
          `;
          return {
            content: message?.content,
            sources,
            memory,
            acceptedRevisions,
            memoryHeads,
            retainedSourceRevisions,
            citation,
            rejected,
            delta,
            contextReady,
          };
        }),
      );
      expect(result.content).toBe(
        [
          `Mapped [[cite:k_cn_${legacyNamespace}_1]] and [[cite:k_cn_${legacyNamespace}_3]].`,
          `Unknown [[cite:${unknownKey}]]; prose ${oldKey1}; partial [[cite:${oldKey1}. then valid [[cite:k_cn_${legacyNamespace}_3]]`,
          `Mixed [[cite:${oldKey1},${unknownKey}]] and malformed [[cite:${oldKey1},]]`,
          `Code:\n\`\`\`text\n[[cite:${oldKey1}]]\n\`\`\``,
          `Tilde:\n~~~text\n[[cite:${oldKey3}]]\n~~~`,
          `Indented:\n    [[cite:${oldKey1}]]`,
          `HTML: <code>[[cite:${oldKey3}]]</code> <pre>[[cite:${oldKey1}]]</pre>`,
          `Inline: \`code [[cite:${oldKey1}]]\`[[cite:k_cn_${legacyNamespace}_3]]`,
          `Adjacent \`code\`[[cite:k_cn_${legacyNamespace}_1]]`,
          `Multi: \`\`code [[cite:${oldKey1}]]\`\`[[cite:k_cn_${legacyNamespace}_3]]`,
          `Closing backslash: \`code\\\`[[cite:k_cn_${legacyNamespace}_1]]\`[[cite:${oldKey3}]]`,
          "Escaped: \\`literal [[cite:k_cn_" +
            legacyNamespace +
            "_1]] and [[cite:k_cn_" +
            legacyNamespace +
            "_3]]",
          `Unmatched multi: \`\`literal [[cite:k_cn_${legacyNamespace}_1]] then [[cite:k_cn_${legacyNamespace}_3]]`,
          `After code [[cite:k_cn_${legacyNamespace}_1]]`,
          `Unmatched single at end \`literal [[cite:k_cn_${legacyNamespace}_1]] then [[cite:k_cn_${legacyNamespace}_3]]`,
        ].join("\n"),
      );
      expect(result.sources).toEqual([
        { sourceKey: `k_cn_${legacyNamespace}_1`, ordinal: 1 },
        { sourceKey: `k_cn_${legacyNamespace}_3`, ordinal: 3 },
      ]);
      expect(result.citation).toEqual([{ sourceKey: `k_cn_${legacyNamespace}_1` }]);
      expect(result.rejected).toEqual([{ candidateId: oldKey1 }]);
      expect(result.delta).toEqual([{ delta: result.content }]);
      expect(result.contextReady).toEqual([
        {
          sourcesRead: [
            {
              sourceKey: `k_cn_${legacyNamespace}_1`,
              label: "Saved fact",
              tokenCount: 1,
              topicIds: [],
              kind: "memory",
              memoryId: ids.memory,
              memoryRevisionId: ids.revision,
              ranges: [],
            },
            {
              sourceKey: `k_cn_${legacyNamespace}_3`,
              label: "Saved fact",
              tokenCount: 1,
              topicIds: [],
              kind: "memory",
              memoryId: ids.memory2,
              memoryRevisionId: ids.revision2,
              ranges: [],
            },
          ],
        },
      ]);
      expect(result.memory[0]?.deletedAt).toBeNull();
      expect(result.memory[0]?.provenanceOnlyAt).toBeNull();
      expect(result.acceptedRevisions).toEqual(
        [ids.writeRevision, ids.writeRevision2].sort().map((id) => ({ id, runId: ids.run })),
      );
      expect(result.memoryHeads).toEqual(
        [
          { id: ids.memory, headRevisionId: ids.writeRevision },
          { id: ids.memory2, headRevisionId: ids.writeRevision2 },
        ].sort((left, right) => left.id.localeCompare(right.id)),
      );
      expect(result.retainedSourceRevisions).toEqual([
        { revisionId: ids.revision },
        { revisionId: ids.revision2 },
      ]);
    } finally {
      await runDb(
        adminDatabaseUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`select pg_terminate_backend(pid) from pg_stat_activity where datname = ${databaseName}`;
          yield* sql.unsafe(`drop database if exists ${quoteIdentifier(databaseName)}`);
        }),
      );
    }
  }, 120_000);

  it("rejects every legacy terminal 0063 ledger row before the cutover writes", async () => {
    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    const databaseName = `brief_migrations_terminal_0063_legacy_${process.pid}_${suffix}`;
    const databaseUrl = databaseUrlForName(databaseName);
    const ids = {
      user: `terminal-0063-legacy-user-${suffix}`,
      company: crypto.randomUUID(),
      chat: crypto.randomUUID(),
      userMessage: crypto.randomUUID(),
      run: crypto.randomUUID(),
      assistantMessage: crypto.randomUUID(),
      memory: crypto.randomUUID(),
      revision: crypto.randomUUID(),
      legacyObservation: "00000000-0000-4000-8000-000000000001",
      legacyExecutionPlan: "00000000-0000-4000-8000-000000000002",
      legacyAttestation: "00000000-0000-4000-8000-000000000003",
      legacyCitation: "00000000-0000-4000-8000-000000000004",
      legacyMeasurement: "00000000-0000-4000-8000-000000000010",
      nestedOwner: "00000000-0000-4000-8000-000000000006",
      nestedRole: "00000000-0000-4000-8000-000000000007",
      nestedDocumentVersion: "00000000-0000-4000-8000-000000000008",
      malformedArrayElement: "00000000-0000-4000-8000-000000000009",
      malformedRootPayload: "00000000-0000-4000-8000-000000000011",
      invalidContextTerminal: "00000000-0000-4000-8000-000000000012",
      invalidProviderMeasurement: "00000000-0000-4000-8000-000000000013",
      oversizedSource: "00000000-0000-4000-8000-000000000014",
      invalidProviderPassed: "00000000-0000-4000-8000-000000000015",
      invalidProviderProofElement: "00000000-0000-4000-8000-000000000016",
      invalidProviderBinding: "00000000-0000-4000-8000-000000000017",
      invalidRestrictedLedger: "00000000-0000-4000-8000-000000000018",
    };
    const nonce = Buffer.from("terminal-0063-legacy", "utf8").subarray(0, 16);
    const oldKey = `k_${nonce.toString("base64url")}_1`;

    try {
      await runDb(
        adminDatabaseUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql.unsafe(`create database ${quoteIdentifier(databaseName)}`);
        }),
      );
      await runDb(
        databaseUrl,
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql.unsafe("drop schema if exists public cascade");
          yield* sql.unsafe("create schema public");
        }),
      );
      await runDb(
        databaseUrl,
        applyMigrationsThrough("0063_immutable_document_exposure_evidence.sql"),
      );
      const migration = await Bun.file(
        new URL("../../../../db/migrations/0064_ai_chat_runtime_cutover.sql", import.meta.url),
      ).text();
      await runDb(
        databaseUrl,
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            insert into platform_users (id, primary_email, display_name, clerk_user_id)
            values (${ids.user}, ${`${ids.user}@example.test`}, 'Terminal legacy user', ${`clerk-${ids.user}`})
          `;
          yield* sql`insert into client_companies (id, name) values (${ids.company}, 'Terminal legacy company')`;
          yield* sql`
            insert into client_company_memberships (company_id, user_id, role)
            values (${ids.company}, ${ids.user}, 'admin')
          `;
          yield* sql`
            insert into chats (id, user_id, company_id, memory_mode)
            values (${ids.chat}, ${ids.user}, ${ids.company}, 'private_owner')
          `;
          yield* sql`
            insert into chat_messages (id, chat_id, author, content)
            values (${ids.userMessage}, ${ids.chat}, 'user', 'What survived?')
          `;
          yield* sql`
            insert into ai_runs (
              id, chat_id, initiating_user_id, user_message_id, locale, market,
              citation_nonce, effective_web_policy, finished_at
            ) values (
              ${ids.run}, ${ids.chat}, ${ids.user}, ${ids.userMessage}, 'en-US', 'US',
              decode(${nonce.toString("base64")}, 'base64'),
              ${sql.json({ enabled: false, reason: "company_disabled", allowlistActive: false })}, now()
            )
          `;
          yield* sql`
            insert into chat_messages (id, chat_id, author, content, assistant_ai_run_id)
            values (${ids.assistantMessage}, ${ids.chat}, 'assistant', ${`Answer [[cite:${oldKey}]]`}, ${ids.run})
          `;
          yield* sql`update ai_runs set assistant_message_id = ${ids.assistantMessage} where id = ${ids.run}`;
          yield* sql`
            insert into user_memories (
              id, user_id, kind, content, head_revision_id, deleted_at, provenance_only_at
            ) values (${ids.memory}, ${ids.user}, null, null, null, now(), now())
          `;
          yield* sql`
            insert into user_memory_revisions (id, memory_id, action, state_before, state_after)
            values (
              ${ids.revision}, ${ids.memory}, 'create', null,
              ${sql.json({ kind: "fact", content: "A retained fact", deleted: false })}
            )
          `;
          yield* sql`
            insert into assistant_message_sources (
              assistant_message_id, source_key, kind, locator, memory_revision_id,
              display_label, public_provenance
            ) values (
              ${ids.assistantMessage}, ${oldKey}, 'memory',
              ${sql.json({ kind: "memory", memoryId: ids.memory, memoryRevisionId: ids.revision })},
              ${ids.revision}, 'Retained fact', '{}'::jsonb
            )
          `;
          yield* sql`
            insert into assistant_message_source_uses (
              assistant_message_id, source_key, consumer_task_id,
              rendered_token_count, context_order, ranges
            ) values (${ids.assistantMessage}, ${oldKey}, 'single-answer', 2, 0, '[]'::jsonb)
          `;
          const insertLegacyObservation = (
            id: string,
            kind: string,
            payload: Record<string, unknown>,
          ) => sql`
            insert into ai_observations (
              id, run_id, chat_id, emitting_task, loop_iteration, attempt,
              observation_key, kind, payload
            ) values (
              ${id}, ${ids.run}, ${ids.chat}, 'finalize', 0, 0,
              ${`legacy:${kind}`}, ${kind}, ${sql.json(payload)}
            )
          `;
          yield* insertLegacyObservation(ids.legacyObservation, "conversation_resolution", {
            nested: [{ ownerId: ids.user }],
          });
          yield* sql`
            insert into ai_run_events (run_id, seq, event, emitted_by_task, emission_key)
            values
              (${ids.run}, 1, ${sql.json({ type: "run_started" })}, null, 'run_started'),
              (${ids.run}, 2, ${sql.json({ type: "done", assistantMessageId: ids.assistantMessage })}, 'finalize', 'terminal')
          `;
          const exit = yield* Effect.exit(sql.unsafe(migration).raw);
          expect(exit._tag).toBe("Failure");
          expect(errorText(exit)).toContain(`ai_observations/${ids.legacyObservation}`);
          expect(errorText(exit)).toContain("legacy observation kind conversation_resolution");
        }),
      );
      const unchanged = await runDb(
        databaseUrl,
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return yield* sql<{
            readonly legacyNamespaceBytes: number;
            readonly citationNamespace: number;
            readonly oldSource: number;
            readonly legacyKinds: number;
            readonly terminalEvents: number;
            readonly cutoverHelpers: number;
          }>`
            select
              (select count(*) from information_schema.columns where table_name = 'ai_runs' and column_name = 'citation_nonce')::int as "legacyNamespaceBytes",
              (select count(*) from information_schema.columns where table_name = 'ai_runs' and column_name = 'citation_namespace')::int as "citationNamespace",
              (select count(*) from assistant_message_sources where source_key = ${oldKey})::int as "oldSource",
              (select count(*) from ai_observations where kind in ('conversation_resolution', 'execution_plan', 'provider_request_attestation'))::int as "legacyKinds",
              (select count(*) from ai_run_events where run_id = ${ids.run})::int as "terminalEvents",
              (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname in (
                'brief_ai_safe_bigint', 'brief_ai_utf16_length', 'brief_ai_legacy_json_key',
                'brief_ai_valid_restricted_context_ledger', 'brief_ai_valid_terminal_usage_coordinate',
                'brief_ai_normalize_ranges'
              ))::int as "cutoverHelpers"
          `;
        }),
      );
      expect(unchanged).toEqual([
        {
          legacyNamespaceBytes: 1,
          citationNamespace: 0,
          oldSource: 1,
          legacyKinds: 1,
          terminalEvents: 2,
          cutoverHelpers: 0,
        },
      ]);

      const expectLegacyObservationBlocker = async (
        id: string,
        kind: string,
        payload: unknown,
        reason: string,
        options: { readonly emittingTask?: string; readonly observationKey?: string } = {},
      ) => {
        await runDb(
          databaseUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
              insert into ai_observations (
                id, run_id, chat_id, emitting_task, loop_iteration, attempt,
                observation_key, kind, payload
              ) values (
                ${id}, ${ids.run}, ${ids.chat},
                ${options.emittingTask ?? (kind === "execution_plan" || kind === "provider_request_attestation" ? "finalize" : "single-retrieve-internal")},
                0, 0, ${options.observationKey ?? `legacy:${kind}`}, ${kind}, ${JSON.stringify(payload)}::jsonb
              )
            `;
            const blocked = yield* Effect.exit(sql.unsafe(migration).raw);
            expect(blocked._tag).toBe("Failure");
            expect(errorText(blocked)).toContain(`ai_observations/${id}`);
            expect(errorText(blocked)).toContain(reason);
            const helpers = yield* sql<{ readonly count: number }>`
              select count(*)::int as count
              from pg_proc
              where pronamespace = 'public'::regnamespace
                and proname in (
                  'brief_ai_safe_bigint', 'brief_ai_utf16_length', 'brief_ai_legacy_json_key',
                  'brief_ai_valid_restricted_context_ledger', 'brief_ai_valid_terminal_usage_coordinate',
                  'brief_ai_normalize_ranges'
                )
            `;
            expect(helpers[0]?.count).toBe(0);
            yield* sql`delete from ai_observations where id = ${id}`;
          }),
        );
      };
      await runDb(
        databaseUrl,
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`delete from ai_observations where id = ${ids.legacyObservation}`;
        }),
      );
      await expectLegacyObservationBlocker(
        ids.legacyExecutionPlan,
        "execution_plan",
        { nested: [{ role: "direct_answer" }] },
        "legacy observation kind execution_plan",
      );
      await expectLegacyObservationBlocker(
        ids.legacyAttestation,
        "provider_request_attestation",
        { nested: [{ versionId: "legacy" }] },
        "legacy observation kind provider_request_attestation",
      );
      await expectLegacyObservationBlocker(
        ids.nestedOwner,
        "candidate_rejected",
        { candidateId: oldKey, reason: "missing", nested: [{ ownerId: ids.user }] },
        "legacy payload field ownerId",
      );
      await expectLegacyObservationBlocker(
        ids.nestedRole,
        "candidate_rejected",
        { candidateId: oldKey, reason: "missing", nested: [{ role: "direct_answer" }] },
        "legacy payload field role",
      );
      await expectLegacyObservationBlocker(
        ids.nestedDocumentVersion,
        "candidate_rejected",
        { candidateId: oldKey, reason: "missing", nested: [{ versionId: "legacy" }] },
        "legacy payload field versionId",
      );
      await expectLegacyObservationBlocker(
        ids.legacyCitation,
        "citation",
        { sourceKey: oldKey },
        "citation payload is not bound to its answer source",
      );
      await expectLegacyObservationBlocker(
        "00000000-0000-4000-8000-000000000005",
        "candidate_rejected",
        { candidateId: [oldKey], reason: "missing" },
        "candidate rejection payload is not strict",
      );
      await expectLegacyObservationBlocker(
        ids.malformedArrayElement,
        "context_decision",
        { valid: true, decisions: [], feedback: ["ok", 1] },
        "context decision feedback is not an array of strings",
      );
      await expectLegacyObservationBlocker(
        ids.malformedRootPayload,
        "candidate_rejected",
        ["not-an-object"],
        "payload must be a JSON object",
      );
      await expectLegacyObservationBlocker(
        ids.invalidContextTerminal,
        "context_reducer_terminal",
        {
          terminalUsageCoordinate: {
            taskId: "single-reduce-plan",
            loopIteration: 0,
            attempt: 0,
            providerRequestIndex: 0,
          },
          modelId: "glm-5-turbo",
          requestSha256Hex: "a".repeat(64),
          providerInputTokens: 1,
          totalTokens: 2,
          stopReason: "unknown",
        },
        "context reducer terminal payload is not strict",
        { emittingTask: "single-reduce-plan" },
      );
      await expectLegacyObservationBlocker(
        ids.invalidProviderMeasurement,
        "provider_request_measurement",
        {
          agentRole: "direct_answer",
          modelId: "glm-5-turbo",
          requestSha256Hex: "a".repeat(64),
          sourceExposureProofSha256Hexes: [],
          providerRequestIndex: 0,
          inputTokens: 1,
          requestedOutputTokens: 0,
          usableInputTokens: 1,
          contextWindow: 100,
          passed: true,
        },
        "provider measurement payload is not strict",
        {
          emittingTask: "single-answer",
          observationKey: "provider_request_measurement:single-answer:0:0:0",
        },
      );
      const validProviderPayload = {
        agentRole: "direct_answer",
        modelId: "glm-5-turbo",
        requestSha256Hex: "a".repeat(64),
        sourceExposureProofSha256Hexes: [],
        providerRequestIndex: 0,
        inputTokens: 1,
        requestedOutputTokens: 1,
        usableInputTokens: 1,
        contextWindow: 100,
        passed: true,
      };
      await expectLegacyObservationBlocker(
        ids.invalidProviderPassed,
        "provider_request_measurement",
        { ...validProviderPayload, passed: false },
        "provider measurement payload is not strict or passed",
        {
          emittingTask: "single-answer",
          observationKey: "provider_request_measurement:single-answer:0:0:0",
        },
      );
      await expectLegacyObservationBlocker(
        ids.invalidProviderProofElement,
        "provider_request_measurement",
        { ...validProviderPayload, sourceExposureProofSha256Hexes: [{}] },
        "provider measurement payload is not strict or passed",
        {
          emittingTask: "single-answer",
          observationKey: "provider_request_measurement:single-answer:0:0:0",
        },
      );
      await expectLegacyObservationBlocker(
        ids.invalidProviderBinding,
        "provider_request_measurement",
        {
          ...validProviderPayload,
          sourceExposureProofSha256Hexes: ["a".repeat(64)],
          sourceExposureProofBindings: [{}],
        },
        "provider measurement payload is not strict or passed",
        {
          emittingTask: "single-answer",
          observationKey: "provider_request_measurement:single-answer:0:0:0",
        },
      );
      await expectLegacyObservationBlocker(
        ids.invalidRestrictedLedger,
        "context_serialized",
        {
          consumerTaskId: "single-answer",
          sourceKeys: [],
          restrictedContextLedger: {
            requestKind: "direct",
            modelId: "glm-5-turbo",
            requestSha256Hex: "a".repeat(64),
            inputTokens: 1,
            usableInputTokens: 1,
            requestedOutputTokens: 0,
            selectedConversation: [],
            question: "retained question",
            gaps: [],
            sources: [],
          },
          terminalUsageCoordinate: {
            taskId: "single-answer",
            loopIteration: 0,
            attempt: 0,
            providerRequestIndex: 0,
          },
        },
        "restricted context ledger is not strict",
        { emittingTask: "single-answer" },
      );
      await runDb(
        databaseUrl,
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const oversizedKey = `k_${nonce.toString("base64url")}_9223372036854775808`;
          yield* sql`alter table assistant_message_sources disable trigger user`;
          yield* sql`
            insert into assistant_message_sources (
              assistant_message_id, source_key, kind, locator,
              document_version_id, publisher_document_version_id,
              message_id, memory_revision_id, display_label, public_provenance,
              source_identity_digest
            ) values (
              ${ids.assistantMessage}, ${oversizedKey}, 'memory',
              ${sql.json({ kind: "memory", memoryId: ids.memory, memoryRevisionId: ids.revision })},
              null, null, null, ${ids.revision}, 'Retained fact', '{}'::jsonb,
              assistant_message_source_identity_digest(
                ${ids.assistantMessage}, ${oversizedKey}, 'memory',
                ${sql.json({ kind: "memory", memoryId: ids.memory, memoryRevisionId: ids.revision })},
                null, null, null, ${ids.revision}, 'Retained fact', '{}'::jsonb
              )
            )
          `;
          yield* sql`alter table assistant_message_sources enable trigger user`;
          const blocked = yield* Effect.exit(sql.unsafe(migration).raw);
          expect(blocked._tag).toBe("Failure");
          expect(errorText(blocked)).toContain(
            `assistant_message_sources/${ids.assistantMessage}/${oversizedKey}`,
          );
          expect(errorText(blocked)).toContain("citation ordinal exceeds final integer bound");
          const helpers = yield* sql<{ readonly count: number }>`
            select count(*)::int as count
            from pg_proc
            where pronamespace = 'public'::regnamespace
              and proname in (
                'brief_ai_safe_bigint', 'brief_ai_utf16_length', 'brief_ai_legacy_json_key',
                'brief_ai_valid_restricted_context_ledger', 'brief_ai_valid_terminal_usage_coordinate',
                'brief_ai_normalize_ranges'
              )
          `;
          expect(helpers[0]?.count).toBe(0);
          yield* sql`alter table assistant_message_sources disable trigger user`;
          yield* sql`
            delete from assistant_message_sources
            where assistant_message_id = ${ids.assistantMessage}
              and source_key = ${oversizedKey}
          `;
          yield* sql`alter table assistant_message_sources enable trigger user`;
        }),
      );
      await runDb(
        databaseUrl,
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const legacyLocator = {
            kind: "memory",
            memoryId: ids.memory,
            memoryRevisionId: ids.revision,
            versionId: "legacy-version",
          };
          yield* sql`alter table assistant_message_sources disable trigger user`;
          yield* sql`
            update assistant_message_sources
            set locator = ${sql.json(legacyLocator)},
                source_identity_digest = assistant_message_source_identity_digest(
                  assistant_message_id, source_key, kind, ${sql.json(legacyLocator)},
                  document_version_id, publisher_document_version_id,
                  message_id, memory_revision_id, display_label, public_provenance
                )
            where assistant_message_id = ${ids.assistantMessage}
              and source_key = ${oldKey}
          `;
          yield* sql`alter table assistant_message_sources enable trigger user`;
          const blocked = yield* Effect.exit(sql.unsafe(migration).raw);
          expect(blocked._tag).toBe("Failure");
          expect(errorText(blocked)).toContain(
            `assistant_message_sources/${ids.assistantMessage}/${oldKey}`,
          );
          expect(errorText(blocked)).toContain(
            "non-document locator carries a legacy document version field",
          );
          yield* sql`alter table assistant_message_sources disable trigger user`;
          yield* sql`
            update assistant_message_sources
            set locator = ${sql.json({ kind: "memory", memoryId: ids.memory, memoryRevisionId: ids.revision })},
                source_identity_digest = assistant_message_source_identity_digest(
                  assistant_message_id, source_key, kind, ${sql.json({ kind: "memory", memoryId: ids.memory, memoryRevisionId: ids.revision })},
                  document_version_id, publisher_document_version_id,
                  message_id, memory_revision_id, display_label, public_provenance
                )
            where assistant_message_id = ${ids.assistantMessage}
              and source_key = ${oldKey}
          `;
          yield* sql`alter table assistant_message_sources enable trigger user`;
        }),
      );
    } finally {
      await runDb(
        adminDatabaseUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`select pg_terminate_backend(pid) from pg_stat_activity where datname = ${databaseName}`;
          yield* sql.unsafe(`drop database if exists ${quoteIdentifier(databaseName)}`);
        }),
      );
    }
  }, 120_000);

  it("immutably binds assistant source and source-use tuples after citation persistence", async () => {
    const testUrl = isolatedDatabaseUrl();
    const ids = {
      user: `source-identity-${crypto.randomUUID()}`,
      company: crypto.randomUUID(),
      chat: crypto.randomUUID(),
      message: crypto.randomUUID(),
      run: crypto.randomUUID(),
      assistant: crypto.randomUUID(),
      memory: crypto.randomUUID(),
      memoryRevision: crypto.randomUUID(),
    };
    const sourceKey = `k_${"cn_" + "A".repeat(22)}_1`;
    const assistantContent = `Answer [[cite:${sourceKey}]]`;

    await runDb(
      testUrl,
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          insert into platform_users (id, primary_email, display_name, clerk_user_id)
          values (${ids.user}, ${`${ids.user}@example.test`}, 'Source identity user', ${`clerk-${ids.user}`})
        `;
        yield* sql`
          insert into client_companies (id, name) values (${ids.company}, 'Source identity company')
        `;
        yield* sql`
          insert into client_company_memberships (company_id, user_id, role)
          values (${ids.company}, ${ids.user}, 'admin')
        `;
        yield* sql`
          insert into chats (id, user_id, company_id, memory_mode)
          values (${ids.chat}, ${ids.user}, ${ids.company}, 'disabled')
        `;
        yield* sql`
          insert into chat_messages (id, chat_id, author, content)
          values (${ids.message}, ${ids.chat}, 'user', 'Source identity test')
        `;
        yield* sql`
          insert into ai_runs (
            id, chat_id, initiating_user_id, user_message_id, locale, market, citation_namespace,
            acceptance_scope
          ) values (
            ${ids.run}, ${ids.chat}, ${ids.user}, ${ids.message}, 'en-US', 'US', ${"cn_" + "A".repeat(22)},
            ${sql.json({
              userId: ids.user,
              chatId: ids.chat,
              companyId: ids.company,
              subscriptionIds: [],
              accessIds: [],
              publicSourceIds: [],
              memoryMode: "disabled",
              memoryRevisionIds: [],
              webRequested: false,
              webEnabled: false,
              provider: "zai_coding_plan_official",
              fastModelId: "glm-5-turbo",
              mainModelId: "glm-5-turbo",
              webTransportProvider: null,
              allowedDomains: null,
            })}
          )
        `;
        yield* sql`
          insert into chat_messages (id, chat_id, author, content, assistant_ai_run_id)
          values (${ids.assistant}, ${ids.chat}, 'assistant', ${assistantContent}, ${ids.run})
        `;
        yield* sql`update ai_runs set assistant_message_id = ${ids.assistant} where id = ${ids.run}`;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              insert into user_memories (id, user_id, kind, content, head_revision_id)
              values (${ids.memory}, ${ids.user}, 'fact', 'Source identity memory', ${ids.memoryRevision})
            `;
            yield* sql`
              insert into user_memory_revisions (id, memory_id, action, state_before, state_after, run_id)
              values (
                ${ids.memoryRevision}, ${ids.memory}, 'create', null,
                ${sql.json({ kind: "fact", content: "Source identity memory", deleted: false })}, null
              )
            `;
          }),
        );
        yield* sql`
          insert into assistant_message_sources (
            assistant_message_id, source_key, kind, locator, display_label, public_provenance
          ) values (
            ${ids.assistant}, ${sourceKey}, 'web',
            ${sql.json({
              kind: "web",
              url: "https://example.test/evidence",
              title: "Evidence",
              domain: "example.test",
              quote: "Evidence",
              quoteHash: createHash("sha256").update("Evidence").digest("base64url"),
              capturedAt: "2026-01-01T00:00:00.000Z",
            })},
            'Evidence', ${sql.json({ citationUrl: "https://example.test/evidence" })}
          )
        `;
        yield* sql`
          insert into assistant_message_source_uses (
            assistant_message_id, source_key, consumer_task_id, rendered_token_count, context_order
          ) values (${ids.assistant}, ${sourceKey}, 'single-answer', 3, 0)
        `;
        yield* sql`
          insert into ai_observations (
            run_id, chat_id, emitting_task, loop_iteration, attempt,
            observation_key, kind, payload
          ) values (
            ${ids.run}, ${ids.chat}, 'finalize', 0, 0, 'citation:0:0', 'citation',
            ${sql.json({ assistantMessageId: ids.assistant, sourceKey })}
          )
        `;
      }),
    );

    const expectDbFailure = async <A, E>(
      effect: Effect.Effect<A, E, PgClient.PgClient>,
      fragment: string,
    ): Promise<void> => {
      let failure: unknown;
      try {
        await runDb(testUrl, effect);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeDefined();
      expect(errorText(failure)).toContain(fragment);
    };
    await expectDbFailure(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          insert into assistant_message_sources (
            assistant_message_id, source_key, kind, locator, message_id,
            display_label, public_provenance
          ) values (
            ${ids.assistant}, ${`${sourceKey.slice(0, -1)}2`}, 'chat_message',
            ${sql.json({ kind: "chat_message", messageId: ids.assistant })},
            ${ids.message}, 'Chat', ${sql.json({})}
          )
        `;
      }),
      "chat locator must bind messageId",
    );
    await expectDbFailure(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          insert into assistant_message_sources (
            assistant_message_id, source_key, kind, locator,
            display_label, public_provenance
          ) values (
            ${ids.assistant}, ${`${sourceKey.slice(0, -1)}3`}, 'memory',
            ${sql.json({ kind: "memory", memoryId: crypto.randomUUID(), memoryRevisionId: crypto.randomUUID() })},
            'Memory', ${sql.json({})}
          )
        `;
      }),
      "memory locator must bind memoryRevisionId",
    );
    await expectDbFailure(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          insert into assistant_message_sources (
            assistant_message_id, source_key, kind, locator, message_id,
            display_label, public_provenance
          ) values (
            ${ids.assistant}, ${`${sourceKey.slice(0, -1)}10`}, 'chat_message',
            ${sql.json({ kind: "chat_message", messageId: ids.message })},
            ${ids.message}, 'Chat', ${sql.json({ forbidden: true })}
          )
        `;
      }),
      "chat locator must bind messageId",
    );
    await expectDbFailure(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          insert into assistant_message_sources (
            assistant_message_id, source_key, kind, locator, memory_revision_id,
            display_label, public_provenance
          ) values (
            ${ids.assistant}, ${`${sourceKey.slice(0, -1)}11`}, 'memory',
            ${sql.json({ kind: "memory", memoryId: ids.memory, memoryRevisionId: ids.memoryRevision })},
            ${ids.memoryRevision}, 'Memory', ${sql.json({ forbidden: true })}
          )
        `;
      }),
      "memory locator must bind memoryRevisionId",
    );
    await expectDbFailure(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          insert into assistant_message_sources (
            assistant_message_id, source_key, kind, locator,
            display_label, public_provenance
          ) values (
            ${ids.assistant}, ${`${sourceKey.slice(0, -1)}4`}, 'web',
            ${sql.json({
              kind: "web",
              url: "https://example.test/evidence",
              title: "Evidence",
              domain: "example.test",
              quote: "Evidence",
              quoteHash: "hash",
              capturedAt: "2026-01-01T00:00:00.000Z",
            })},
            'Web', ${sql.json({})}
          )
        `;
      }),
      "web locator must use the strict URL, quote, and hash form",
    );
    await expectDbFailure(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          insert into assistant_message_sources (
            assistant_message_id, source_key, kind, locator,
            display_label, public_provenance
          ) values (
            ${ids.assistant}, ${`${sourceKey.slice(0, -1)}9`}, 'web',
            ${sql.json({
              kind: "web",
              url: "https://example.test",
              title: "Evidence",
              domain: "example.test",
              quote: "Evidence",
              quoteHash: createHash("sha256").update("Evidence").digest("base64url"),
              capturedAt: "2026-01-01T00:00:00.000Z",
            })},
            'Web', ${sql.json({ citationUrl: "https://example.test" })}
          )
        `;
      }),
      "web locator must use the strict URL, quote, and hash form",
    );
    await expectDbFailure(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          insert into assistant_message_sources (
            assistant_message_id, source_key, kind, locator,
            display_label, public_provenance
          ) values (
            ${ids.assistant}, ${`${sourceKey.slice(0, -1)}8`}, 'web',
            ${sql.json({
              kind: "web",
              url: "https://example.test/a/../b",
              title: "Evidence",
              domain: "example.test",
              quote: "Evidence",
              quoteHash: createHash("sha256").update("Evidence").digest("base64url"),
              capturedAt: "2026-01-01T00:00:00.000Z",
            })},
            'Web', ${sql.json({ citationUrl: "https://example.test/a/../b" })}
          )
        `;
      }),
      "web locator must use the strict URL, quote, and hash form",
    );
    await expectDbFailure(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          insert into assistant_message_sources (
            assistant_message_id, source_key, kind, locator,
            display_label, public_provenance
          ) values (
            ${ids.assistant}, ${`${sourceKey.slice(0, -1)}5`}, 'web',
            ${sql.json({
              kind: "web",
              url: "https://Example.test/evidence",
              title: "Evidence",
              domain: "Example.test",
              quote: "Evidence",
              quoteHash: createHash("sha256").update("Evidence").digest("base64url"),
              capturedAt: "2026-01-01T00:00:00.000Z",
            })},
            'Web', ${sql.json({ citationUrl: "https://Example.test/evidence" })}
          )
        `;
      }),
      "web locator must use the strict URL, quote, and hash form",
    );
    await expectDbFailure(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          insert into assistant_message_sources (
            assistant_message_id, source_key, kind, locator,
            display_label, public_provenance
          ) values (
            ${ids.assistant}, ${`${sourceKey.slice(0, -1)}6`}, 'web',
            ${sql.json({
              kind: "web",
              url: "https://example.test/evidence",
              title: "Evidence",
              domain: "example.test",
              quote: "Evidence",
              quoteHash: createHash("sha256").update("Evidence").digest("base64url"),
              capturedAt: "2026-02-31T00:00:00.000Z",
            })},
            'Web', ${sql.json({ citationUrl: "https://example.test/evidence" })}
          )
        `;
      }),
      "web locator must use the strict URL, quote, and hash form",
    );
    await expectDbFailure(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          insert into assistant_message_sources (
            assistant_message_id, source_key, kind, locator,
            display_label, public_provenance
          ) values (
            ${ids.assistant}, ${`${sourceKey.slice(0, -1)}7`}, 'web',
            ${sql.json({
              kind: "web",
              url: "https://example.test/evidence",
              title: "Evidence",
              domain: "example.test",
              quote: "Evidence",
              quoteHash: createHash("sha256").update("Evidence").digest("base64url"),
              capturedAt: "2026-01-01T00:00:00.000Z",
            })},
            'Web', ${sql.json({})}
          )
        `;
      }),
      "web locator must use the strict URL, quote, and hash form",
    );
    await expectDbFailure(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update assistant_message_sources
          set public_provenance = ${sql.json({ citationUrl: "https://example.test/forged" })}
          where assistant_message_id = ${ids.assistant} and source_key = ${sourceKey}
        `;
      }),
      "source identity is immutable",
    );
    await expectDbFailure(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update assistant_message_sources
          set created_at = created_at + interval '1 second'
          where assistant_message_id = ${ids.assistant} and source_key = ${sourceKey}
        `;
      }),
      "source identity is immutable",
    );
    await expectDbFailure(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update assistant_message_source_uses
          set rendered_token_count = 99
          where assistant_message_id = ${ids.assistant} and source_key = ${sourceKey}
        `;
      }),
      "source use identity is immutable",
    );
    await expectDbFailure(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update assistant_message_source_uses
          set created_at = created_at + interval '1 second'
          where assistant_message_id = ${ids.assistant} and source_key = ${sourceKey}
        `;
      }),
      "source use identity is immutable",
    );
    await expectDbFailure(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          delete from assistant_message_sources
          where assistant_message_id = ${ids.assistant} and source_key = ${sourceKey}
        `;
      }),
      "sources cannot be deleted independently",
    );
    await expectDbFailure(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          delete from assistant_message_source_uses
          where assistant_message_id = ${ids.assistant} and source_key = ${sourceKey}
        `;
      }),
      "source uses cannot be deleted independently",
    );

    const malformedIdentityRows = [
      {
        kind: "document",
        locator: {
          kind: "document",
          sourceId: "public:missing",
          documentId: "missing",
          versionId: "missing",
          contentHash: "a".repeat(64),
          ranges: [{ charStart: 0, charEnd: 1 }],
        },
        documentSourceId: null,
        documentId: "missing",
        contentHash: "a".repeat(64),
        versionId: "missing",
        publisherExtractionId: null,
        messageId: null,
        memoryRevisionId: null,
      },
      {
        kind: "document",
        locator: {
          kind: "document",
          sourceId: "public:missing",
          documentId: "missing",
          versionId: "missing",
          contentHash: "a".repeat(64),
          ranges: [{ charStart: 0, charEnd: 1 }],
        },
        documentSourceId: "public:missing",
        documentId: null,
        contentHash: "a".repeat(64),
        versionId: "missing",
        publisherExtractionId: null,
        messageId: null,
        memoryRevisionId: null,
      },
      {
        kind: "document",
        locator: {
          kind: "document",
          sourceId: "public:missing",
          documentId: "missing",
          versionId: "missing",
          contentHash: "a".repeat(64),
          ranges: [{ charStart: 0, charEnd: 1 }],
        },
        documentSourceId: "public:missing",
        documentId: "missing",
        contentHash: null,
        versionId: "missing",
        publisherExtractionId: null,
        messageId: null,
        memoryRevisionId: null,
      },
      {
        kind: "document",
        locator: {
          kind: "document",
          sourceId: "public:missing",
          documentId: "missing",
          versionId: "missing",
          contentHash: "a".repeat(64),
          ranges: [{ charStart: 0, charEnd: 1 }],
        },
        documentSourceId: "public:missing",
        documentId: "missing",
        contentHash: "a".repeat(64),
        versionId: null,
        publisherExtractionId: null,
        messageId: null,
        memoryRevisionId: null,
      },
      ...(["chat_message", "memory", "web"] as const).flatMap((kind) =>
        (
          [
            "documentSourceId",
            "documentId",
            "contentHash",
            "versionId",
            "publisherExtractionId",
          ] as const
        ).map((forbiddenColumn) => ({
          kind,
          locator:
            kind === "chat_message"
              ? { kind, messageId: ids.message }
              : kind === "memory"
                ? { kind, memoryId: crypto.randomUUID(), memoryRevisionId: crypto.randomUUID() }
                : {
                    kind,
                    url: "https://example.test",
                    title: "Example",
                    domain: "example.test",
                    quote: "q",
                    quoteHash: "a".repeat(43),
                    capturedAt: "2026-01-01T00:00:00.000Z",
                  },
          documentSourceId: forbiddenColumn === "documentSourceId" ? "public:malformed" : null,
          documentId: forbiddenColumn === "documentId" ? "malformed" : null,
          contentHash: forbiddenColumn === "contentHash" ? "a".repeat(64) : null,
          versionId: forbiddenColumn === "versionId" ? "malformed" : null,
          publisherExtractionId:
            forbiddenColumn === "publisherExtractionId" ? crypto.randomUUID() : null,
          messageId: kind === "chat_message" ? ids.message : null,
          memoryRevisionId: kind === "memory" ? crypto.randomUUID() : null,
        })),
      ),
    ];
    await runDb(
      testUrl,
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`alter table assistant_message_sources disable trigger user`;
        for (const [index, row] of malformedIdentityRows.entries()) {
          const failure = yield* Effect.flip(sql`
            insert into assistant_message_sources (
              assistant_message_id, source_key, kind, locator,
              version_id, publisher_extraction_id, document_source_id, document_id,
              content_hash, message_id, memory_revision_id, source_identity_digest
            ) values (
              ${ids.assistant}, ${`k_cn_${"M".repeat(22)}_${index + 100}`}, ${row.kind},
              ${sql.json(row.locator)}, ${row.versionId}, ${row.publisherExtractionId},
              ${row.documentSourceId}, ${row.documentId}, ${row.contentHash},
              ${row.messageId}, ${row.memoryRevisionId}, ${"0".repeat(64)}
            )
          `);
          expect(errorText(failure)).toContain("assistant_message_sources_");
        }
        yield* sql`alter table assistant_message_sources enable trigger user`;
      }),
    );

    await runDb(
      testUrl,
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`update ai_runs set assistant_message_id = null where id = ${ids.run}`;
        yield* sql`delete from chat_messages where id = ${ids.assistant}`;
      }),
    );
  });

  it(
    "preserves a pre-Tinyfish evaluation identity during the forward migration",
    { timeout: 60_000 },
    async () => {
      const upgradeDatabaseName = `brief_eval_identity_upgrade_${process.pid}_${crypto
        .randomUUID()
        .replaceAll("-", "")
        .slice(0, 8)}`;
      const upgradeUrl = databaseUrlForName(upgradeDatabaseName);
      const legacyIdentity = "zai_coding_plan_official:https://api.z.ai/api/coding/paas/v4";
      const tinyfishIdentity = "tinyfish_search_official:https://api.search.tinyfish.ai";

      await runDb(
        adminDatabaseUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql.unsafe(`create database ${quoteIdentifier(upgradeDatabaseName)}`);
        }),
      );

      try {
        await runDb(
          upgradeUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`select 1`;
            yield* applyMigrationsThrough("0051_immutable_evaluation_runtime_evidence.sql");
            yield* sql`
              insert into ai_evaluation_sessions (
                id, artifact_version, golden_set_version, fixture_sha256_hex,
                execution_config_sha256_hex, provider_endpoint_identity, status
              ) values (
                ${crypto.randomUUID()}, 2, 2, ${"a".repeat(64)}, ${"b".repeat(64)},
                ${legacyIdentity}, 'running'
              )
            `;
          }),
        );

        const identities = await runDb(
          upgradeUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            const migration = yield* Effect.promise(() =>
              Bun.file(new URL("0052_tinyfish_evaluation_web_identity.sql", migrationsUrl)).text(),
            );
            yield* sql.unsafe(migration).raw;
            yield* sql`
              insert into ai_evaluation_sessions (
                id, artifact_version, golden_set_version, fixture_sha256_hex,
                execution_config_sha256_hex, provider_endpoint_identity, status
              ) values (
                ${crypto.randomUUID()}, 2, 2, ${"c".repeat(64)}, ${"d".repeat(64)},
                ${tinyfishIdentity}, 'running'
              )
            `;
            const rows = yield* sql<{ readonly identity: string }>`
              select provider_endpoint_identity as identity
              from ai_evaluation_sessions
              order by provider_endpoint_identity
            `;
            return rows.map((row) => row.identity);
          }),
        );

        expect(identities).toEqual([tinyfishIdentity, legacyIdentity]);
      } finally {
        await runDb(
          adminDatabaseUrl(),
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
              select pg_terminate_backend(pid)
              from pg_stat_activity
              where datname = ${upgradeDatabaseName}
                and pid <> pg_backend_pid()
            `;
            yield* sql.unsafe(`drop database if exists ${quoteIdentifier(upgradeDatabaseName)}`);
          }),
        );
      }
    },
  );

  it(
    "installs the provider usage arithmetic check without rewriting historical rows",
    { timeout: 60_000 },
    async () => {
      const result = await runDb(
        isolatedDatabaseUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const rows = yield* sql<{
            readonly constraintName: string;
            readonly definition: string;
            readonly validated: boolean;
          }>`
            select conname as "constraintName",
                   pg_get_constraintdef(oid) as definition,
                   convalidated as validated
            from pg_constraint
            where conrelid = 'ai_run_usage'::regclass
              and conname = 'ai_run_usage_accounting_consistent'
          `;
          return rows[0];
        }),
      );

      expect(result?.constraintName).toBe("ai_run_usage_accounting_consistent");
      expect(result?.definition).toContain("total_tokens");
      expect(result?.definition).toContain("reasoning_tokens <= output_tokens");
      expect(result?.validated).toBe(true);
    },
  );

  it(
    "fails closed when pre-migration accounting is already inconsistent",
    { timeout: 60_000 },
    async () => {
      const corruptDatabaseName = `brief_usage_invariant_corrupt_${process.pid}_${crypto
        .randomUUID()
        .replaceAll("-", "")
        .slice(0, 8)}`;
      const corruptUrl = databaseUrlForName(corruptDatabaseName);

      await runDb(
        adminDatabaseUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql.unsafe(`create database ${quoteIdentifier(corruptDatabaseName)}`);
        }),
      );

      try {
        await runDb(
          corruptUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* applyMigrationsThrough("0052_tinyfish_evaluation_web_identity.sql");
            const userId = `usage-corrupt-user-${crypto.randomUUID()}`;
            const companyId = crypto.randomUUID();
            const chatId = crypto.randomUUID();
            const messageId = crypto.randomUUID();
            const runId = crypto.randomUUID();
            yield* sql`
              insert into client_companies (id, name)
              values (${companyId}, 'Corrupt usage migration company')
            `;
            yield* sql`
              insert into client_company_memberships (company_id, user_id, role)
              values (${companyId}, ${userId}, 'admin')
            `;
            yield* sql`
              insert into client_company_ai_settings (company_id)
              values (${companyId})
            `;
            yield* sql`
              insert into chats (id, company_id, user_id, memory_mode)
              values (${chatId}, ${companyId}, ${userId}, 'disabled')
            `;
            yield* sql`
              insert into chat_messages (id, chat_id, author, content)
              values (${messageId}, ${chatId}, 'user', 'corrupt usage')
            `;
            yield* sql`
              insert into ai_runs (id, chat_id, user_message_id, locale, market, finished_at)
              values (${runId}, ${chatId}, ${messageId}, 'en-US', 'US', now())
            `;
            yield* sql`
              insert into ai_run_usage (
                run_id, task_id, loop_iteration, attempt, provider_request_index,
                agent_role, model_id, provider_service_id, input_tokens, output_tokens,
                cached_tokens, reasoning_tokens, total_tokens, stop_reason
              ) values (
                ${runId}, 'corrupt-usage', 0, 0, 0,
                'direct_answer', 'glm-5-turbo', 'deterministic_test',
                10, 4, 2, 0, 99, 'stop'
              )
            `;
            // Simulate an interrupted predecessor that created the exact
            // constraint name without validating historical rows.  Replay
            // must reach VALIDATE and fail closed on this corrupt row.
            yield* sql`
              alter table ai_run_usage
                add constraint ai_run_usage_accounting_consistent
                check (
                  total_tokens = input_tokens::bigint
                    + cached_tokens::bigint
                    + output_tokens::bigint
                  and reasoning_tokens <= output_tokens
                ) not valid
            `;
            const migration = yield* Effect.promise(() =>
              Bun.file(new URL("0053_ai_usage_accounting_invariants.sql", migrationsUrl)).text(),
            );
            const migrationExit = yield* Effect.exit(sql.unsafe(migration).raw);
            expect(migrationExit._tag).toBe("Failure");
          }),
        );
      } finally {
        await runDb(
          adminDatabaseUrl(),
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
              select pg_terminate_backend(pid)
              from pg_stat_activity
              where datname = ${corruptDatabaseName}
                and pid <> pg_backend_pid()
            `;
            yield* sql.unsafe(`drop database if exists ${quoteIdentifier(corruptDatabaseName)}`);
          }),
        );
      }
    },
  );

  it("accepts only exact HTML and PDF public-source base media types", async () => {
    const result = await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          insert into public_sources (
            source_id, display_name, publisher_name, description,
            ingestion_method, discovery_url, average_chars_per_item
          ) values (
            'exact-media-migration-source', 'Exact media source', 'Official publisher',
            'Verifies exact public source media types', 'rss',
            'https://example.test/exact-media-feed', 1000
          ) on conflict (source_id) do nothing
        `;
        yield* sql`
          insert into public_source_raw_artifacts (
            id, source_id, canonical_url, fetched_at, media_type, body, body_hash
          ) values (
            '45000000-0000-4000-8000-000000000001',
            'exact-media-migration-source', 'https://example.test/exact.html', now(),
            ' Text/HTML ; charset=UTF-8', '<main>Exact HTML</main>',
            encode(digest('<main>Exact HTML</main>', 'sha256'), 'hex')
          ) on conflict (id) do nothing
        `;
        const ambiguous = [] as string[];
        for (const [index, mediaType] of [
          "text/htmlish",
          "application/notpdf",
          "image/pdf-preview",
        ].entries()) {
          const exit = yield* Effect.exit(sql`
            insert into public_source_raw_artifacts (
              id, source_id, canonical_url, fetched_at, media_type, body, body_hash
            ) values (
              ${`45000000-0000-4000-8000-${String(index + 2).padStart(12, "0")}`},
              'exact-media-migration-source',
              ${`https://example.test/ambiguous-${index}`}, now(),
              ${mediaType}, '<main>Ambiguous</main>',
              encode(digest('<main>Ambiguous</main>', 'sha256'), 'hex')
            )
          `);
          ambiguous.push(exit._tag);
        }
        const stored = yield* sql<{ readonly mediaType: string }>`
          select media_type as "mediaType"
          from public_source_raw_artifacts
          where id = '45000000-0000-4000-8000-000000000001'
        `;
        return { ambiguous, stored: stored[0]?.mediaType };
      }),
    );

    expect(result).toEqual({
      ambiguous: ["Failure", "Failure", "Failure"],
      stored: " Text/HTML ; charset=UTF-8",
    });
  });

  it("enforces canonical credential-free HTTPS URLs for every public-source tuple", async () => {
    const result = await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const policy = yield* sql<{ readonly url: string; readonly allowed: boolean }>`
          select value as url, brief_public_source_https_url_allowed(value) as allowed
          from unnest(${[
            "https://www.service-public.fr/actualites/1",
            "http://www.service-public.fr/actualites/1",
            "https://user@www.service-public.fr/actualites/1",
            "https://127.0.0.1/latest/meta-data",
            "https://metadata.internal/latest",
            "javascript:alert(1)",
          ]}::text[]) value
        `;
        const constraints = yield* sql<NamedRow>`
          select conname as name
          from pg_constraint
          where conname in (
            'public_source_candidates_https_canonical_url',
            'public_source_items_https_canonical_url',
            'public_source_documents_https_canonical_url',
            'public_source_raw_artifacts_https_canonical_url'
          )
          order by conname
        `;
        yield* sql`
          insert into public_sources (
            source_id, display_name, publisher_name, description,
            ingestion_method, discovery_url, average_chars_per_item
          ) values (
            'https-policy-source', 'HTTPS policy source', 'Official publisher',
            'Verifies canonical public-source URL policy', 'rss',
            'https://example.test/feed', 1000
          ) on conflict (source_id) do nothing
        `;
        const invalidInsert = yield* Effect.exit(sql`
          insert into public_source_candidates (
            source_id, canonical_url, title, discovered_at
          ) values (
            'https-policy-source', 'https://127.0.0.1/latest/meta-data',
            'Unsafe target', now()
          )
        `);
        yield* sql`
          insert into public_source_candidates (
            source_id, canonical_url, title, discovered_at
          ) values (
            'https-policy-source', 'https://example.test/official',
            'Safe target', now()
          )
        `;
        return {
          policy: Object.fromEntries(policy.map((row) => [row.url, row.allowed])),
          constraints: constraints.map((row) => row.name),
          invalidInsert: invalidInsert._tag,
        };
      }),
    );

    expect(result).toEqual({
      policy: {
        "https://www.service-public.fr/actualites/1": true,
        "http://www.service-public.fr/actualites/1": false,
        "https://user@www.service-public.fr/actualites/1": false,
        "https://127.0.0.1/latest/meta-data": false,
        "https://metadata.internal/latest": false,
        "javascript:alert(1)": false,
      },
      constraints: [
        "public_source_candidates_https_canonical_url",
        "public_source_documents_https_canonical_url",
        "public_source_items_https_canonical_url",
        "public_source_raw_artifacts_https_canonical_url",
      ],
      invalidInsert: "Failure",
    });
  });

  it(
    "refuses undrained legacy Smithers outputs and recreates the canonical schema boundary",
    { timeout: 60_000 },
    async () => {
      const smithersDatabaseName = `${isolatedDatabaseName}_smithers_${crypto
        .randomUUID()
        .replaceAll("-", "")
        .slice(0, 8)}`;
      const smithersUrl = databaseUrlForName(smithersDatabaseName);

      await runDb(
        adminDatabaseUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql.unsafe(`create database ${quoteIdentifier(smithersDatabaseName)}`);
        }),
      );

      try {
        await runDb(smithersUrl, applyMigrationsThrough("0030_ai_plan_change_idempotency.sql"));
        await runDb(
          smithersUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql.unsafe(`
              create table _smithers_runs (run_id text primary key);
              create table ai_chat_load_turn (run_id text primary key);
              create table ai_chat_preflight (run_id text primary key);
              create table ai_chat_hydrate (run_id text primary key);
              create table ai_chat_answer (run_id text primary key);
              create table ai_chat_preflight2 (run_id text primary key);
              create table ai_chat_hydrate2 (run_id text primary key);
              create table ai_chat_answer2 (run_id text primary key);
              create table ai_chat_memory (run_id text primary key);
              create table ai_chat_finalize (run_id text primary key);
              insert into ai_chat_answer (run_id) values ('ai-chat:undrained');
            `).raw;
          }),
        );

        const blocked = await runDb(smithersUrl, Effect.exit(runMigrations));
        expect(blocked._tag).toBe("Failure");
        expect(errorText(blocked)).toContain(
          "canonical AI chat migration requires drained Smithers output table ai_chat_answer",
        );

        await runDb(
          smithersUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`delete from ai_chat_answer`;
            yield* sql`insert into _smithers_runs (run_id) values ('ai-chat:undrained-run')`;
          }),
        );

        const blockedRun = await runDb(smithersUrl, Effect.exit(runMigrations));
        expect(blockedRun._tag).toBe("Failure");
        expect(errorText(blockedRun)).toContain(
          "canonical AI chat migration requires all prior Smithers runs to be drained",
        );

        await runDb(
          smithersUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`delete from _smithers_runs`;
            yield* runMigrations;
          }),
        );

        const result = await runDb(
          smithersUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            const tables = yield* sql<NamedRow>`
              select table_name as name
              from information_schema.tables
              where table_schema = 'public'
                and table_name in (
                  'ai_chat_load_turn',
                  'ai_chat_preflight',
                  'ai_chat_hydrate',
                  'ai_chat_answer',
                  'ai_chat_preflight2',
                  'ai_chat_hydrate2',
                  'ai_chat_answer2',
                  'ai_chat_memory',
                  'ai_chat_finalize'
                )
            `;
            const migration = yield* sql<NamedRow>`
              select name
              from schema_migrations
              where name = '0031_recreate_canonical_ai_chat_smithers_outputs.sql'
            `;
            return { tables, migration };
          }),
        );

        expect(result.tables).toEqual([]);
        expect(result.migration.map((row) => row.name)).toEqual([
          "0031_recreate_canonical_ai_chat_smithers_outputs.sql",
        ]);
      } finally {
        await runDb(
          adminDatabaseUrl(),
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
              select pg_terminate_backend(pid)
              from pg_stat_activity
              where datname = ${smithersDatabaseName}
                and pid <> pg_backend_pid()
            `;
            yield* sql.unsafe(`drop database if exists ${quoteIdentifier(smithersDatabaseName)}`);
          }),
        );
      }
    },
  );

  it(
    "refuses unresolved legacy exports instead of inferring late chat content during 0047",
    { timeout: 60_000 },
    async () => {
      const exportDatabaseName = `${isolatedDatabaseName}_export_snapshot_${crypto
        .randomUUID()
        .replaceAll("-", "")
        .slice(0, 8)}`;
      const exportUrl = databaseUrlForName(exportDatabaseName);
      await runDb(
        adminDatabaseUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql.unsafe(`create database ${quoteIdentifier(exportDatabaseName)}`);
        }),
      );

      try {
        await runDb(exportUrl, applyMigrationsThrough("0046_public_source_https_url_policy.sql"));
        const fixture = await runDb(
          exportUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            const companyId = crypto.randomUUID();
            const chatId = crypto.randomUUID();
            const exportId = crypto.randomUUID();
            const malformedActiveId = crypto.randomUUID();
            const malformedObjectId = crypto.randomUUID();
            const malformedTerminalId = crypto.randomUUID();
            const malformedOtherArrayId = crypto.randomUUID();
            const identityMismatchId = crypto.randomUUID();
            const authorizedAt = new Date().toISOString();
            yield* sql`
              insert into platform_users (id, primary_email, display_name, clerk_user_id)
              values (
                'legacy-export-user', 'legacy-export@example.test',
                'Legacy export user', 'clerk-legacy-export-user'
              )
            `;
            yield* sql`
              insert into client_companies (id, name)
              values (${companyId}, 'Legacy export company')
            `;
            yield* sql`
              insert into client_company_memberships (company_id, user_id, role)
              values (${companyId}, 'legacy-export-user', 'admin')
            `;
            yield* sql`
              insert into client_company_ai_settings (company_id)
              values (${companyId})
            `;
            yield* sql`
              insert into chats (id, company_id, user_id)
              values (${chatId}, ${companyId}, 'legacy-export-user')
            `;
            const [acceptedMessage] = yield* sql<{ readonly id: string }>`
              insert into chat_messages (chat_id, author, content)
              values (${chatId}, 'user', 'Present when the legacy export was accepted')
              returning id::text
            `;
            yield* sql`
              insert into export_requests (
                id, requester_user_id, scope_kind, scope_id,
                authorization_snapshot, idempotency_key
              ) values (
                ${exportId}, 'legacy-export-user', 'user_chats', 'me',
                ${sql.json({
                  version: 1,
                  authorizedAt,
                  requesterUserId: "legacy-export-user",
                  scopeKind: "user_chats",
                  scopeId: "me",
                  role: "self",
                  clientCompanyIds: [companyId],
                  accessIds: [],
                  issueIds: [],
                  documentIds: [],
                  chatIds: [chatId],
                })},
                ${`legacy-export-${exportId}`}
              )
            `;
            const exactBaseSnapshot = {
              version: 1,
              authorizedAt,
              requesterUserId: "legacy-export-user",
              scopeKind: "user_chats",
              scopeId: "me",
              role: "self",
              clientCompanyIds: [companyId],
              accessIds: [],
              issueIds: [],
              documentIds: [],
              chatIds: [chatId],
              chatMessageIds: [],
            };
            const malformedMessageSnapshot = {
              ...exactBaseSnapshot,
              chatMessageIds: [1, null, { coerced: "not-an-identity" }],
            };
            yield* sql`
              insert into export_requests (
                id, requester_user_id, scope_kind, scope_id, status,
                authorization_snapshot, idempotency_key,
                object_key, object_purge_after, completed_at, error_code
              ) values
                (
                  ${malformedActiveId}, 'legacy-export-user', 'user_chats', 'me', 'queued',
                  ${sql.json(malformedMessageSnapshot)},
                  ${`legacy-export-malformed-active-${malformedActiveId}`},
                  null, null, null, null
                ),
                (
                  ${malformedObjectId}, 'legacy-export-user', 'user_chats', 'me', 'failed',
                  ${sql.json(malformedMessageSnapshot)},
                  ${`legacy-export-malformed-object-${malformedObjectId}`},
                  ${`exports/${malformedObjectId}.tar`}, now() - interval '1 day', now(),
                  'legacy_export_failed'
                ),
                (
                  ${malformedTerminalId}, 'legacy-export-user', 'user_chats', 'me', 'failed',
                  ${sql.json(malformedMessageSnapshot)},
                  ${`legacy-export-malformed-terminal-${malformedTerminalId}`},
                  null, null, now(), 'legacy_export_failed'
                ),
                (
                  ${malformedOtherArrayId}, 'legacy-export-user', 'user_chats', 'me', 'failed',
                  ${sql.json({ ...exactBaseSnapshot, accessIds: [null] })},
                  ${`legacy-export-malformed-array-${malformedOtherArrayId}`},
                  null, null, now(), 'legacy_export_failed'
                ),
                (
                  ${identityMismatchId}, 'legacy-export-user', 'user_chats', 'me', 'failed',
                  ${sql.json({ ...exactBaseSnapshot, requesterUserId: "wrong-user" })},
                  ${`legacy-export-identity-mismatch-${identityMismatchId}`},
                  null, null, now(), 'legacy_export_failed'
                )
            `;
            const [lateMessage] = yield* sql<{ readonly id: string }>`
              insert into chat_messages (chat_id, author, content)
              values (${chatId}, 'assistant', 'Committed after legacy export acceptance')
              returning id::text
            `;
            yield* sql`
              insert into assistant_message_sources (
                assistant_message_id, source_key, kind, locator,
                display_label, public_provenance
              ) values (
                ${lateMessage!.id}, 'LATE', 'web',
                ${sql.json({
                  kind: "web",
                  url: "https://late.example.test/source",
                  title: "Late source",
                  domain: "late.example.test",
                  quote: "Late source content",
                  quoteHash: "e".repeat(64),
                  publishedAt: null,
                  capturedAt: new Date().toISOString(),
                })},
                'Late source',
                ${sql.json({
                  citationUrl: "https://late.example.test/source",
                  documentTitle: "Late source",
                })}
              )
            `;
            return {
              exportId,
              malformedActiveId,
              malformedObjectId,
              malformedTerminalId,
              malformedOtherArrayId,
              identityMismatchId,
              acceptedMessageId: acceptedMessage!.id,
              lateMessageId: lateMessage!.id,
            };
          }),
        );

        const blocked = await runDb(exportUrl, Effect.exit(runMigrations));
        expect(blocked._tag).toBe("Failure");
        expect(errorText(blocked)).toContain(
          "export message-snapshot migration requires legacy exports to be terminal and every legacy object to be physically deleted",
        );
        const unchanged = await runDb(
          exportUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            const [request] = yield* sql<{
              readonly hasMessageSnapshot: boolean;
              readonly status: string;
            }>`
              select authorization_snapshot ? 'chatMessageIds' as "hasMessageSnapshot", status
              from export_requests where id = ${fixture.exportId}
            `;
            const migration = yield* sql<NamedRow>`
              select name from schema_migrations
              where name = '0047_export_request_legal_hold_scopes.sql'
            `;
            return { request: request!, migration };
          }),
        );
        expect(unchanged.request).toEqual({ hasMessageSnapshot: false, status: "queued" });
        expect(unchanged.migration).toEqual([]);

        const malformedMessageBlocked = await runDb(
          exportUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
              update export_requests
              set status = 'failed', completed_at = now(), error_code = 'legacy_export_drained'
              where id = ${fixture.exportId}
            `;
            return yield* Effect.exit(runMigrations);
          }),
        );
        expect(malformedMessageBlocked._tag).toBe("Failure");
        expect(errorText(malformedMessageBlocked)).toContain(
          "export message-snapshot migration requires legacy exports to be terminal and every legacy object to be physically deleted",
        );

        const malformedArrayBlocked = await runDb(
          exportUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
              update export_requests
              set status = 'failed', completed_at = now(), error_code = 'legacy_export_drained'
              where id = ${fixture.malformedActiveId}
            `;
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`select set_config('brief.allow_export_object_purge', 'on', true)`;
                yield* sql`
                  update export_requests
                  set object_deleted_at = now()
                  where id = ${fixture.malformedObjectId}
                `;
              }),
            );
            return yield* Effect.exit(runMigrations);
          }),
        );
        expect(malformedArrayBlocked._tag).toBe("Failure");
        expect(errorText(malformedArrayBlocked)).toContain(
          "export authorization-snapshot migration requires every existing identity array to contain only nonempty strings",
        );

        const identityBlocked = await runDb(
          exportUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
              update export_requests
              set authorization_snapshot = jsonb_set(
                authorization_snapshot,
                '{accessIds}',
                '[]'::jsonb,
                false
              )
              where id = ${fixture.malformedOtherArrayId}
            `;
            return yield* Effect.exit(runMigrations);
          }),
        );
        expect(identityBlocked._tag).toBe("Failure");
        expect(errorText(identityBlocked)).toContain(
          "export authorization-snapshot migration requires every existing snapshot identity to match its request",
        );

        const migrated = await runDb(
          exportUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
              update export_requests
              set authorization_snapshot = jsonb_set(
                authorization_snapshot,
                '{requesterUserId}',
                to_jsonb('legacy-export-user'::text),
                false
              )
              where id = ${fixture.identityMismatchId}
            `;
            const migrationBody = yield* Effect.promise(() =>
              Bun.file(new URL("0047_export_request_legal_hold_scopes.sql", migrationsUrl)).text(),
            );
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql.unsafe(migrationBody).raw;
                yield* sql`
                  insert into schema_migrations (name)
                  values ('0047_export_request_legal_hold_scopes.sql')
                `;
              }),
            );
            return (yield* sql<{
              readonly chatMessageIds: string[];
              readonly holdIssueIds: string[];
              readonly malformedSnapshotsNormalized: boolean;
            }>`
              select
                array(
                  select jsonb_array_elements_text(
                    authorization_snapshot->'chatMessageIds'
                  )
                ) as "chatMessageIds",
                array(
                  select jsonb_array_elements_text(
                    authorization_snapshot->'holdIssueIds'
                  )
                ) as "holdIssueIds",
                (
                  select bool_and(
                    malformed.authorization_snapshot->'chatMessageIds' = '[]'::jsonb
                  )
                  from export_requests malformed
                  where malformed.id in (
                    ${fixture.malformedActiveId},
                    ${fixture.malformedObjectId},
                    ${fixture.malformedTerminalId}
                  )
                ) as "malformedSnapshotsNormalized"
              from export_requests where id = ${fixture.exportId}
            `)[0]!;
          }),
        );
        expect(migrated).toEqual({
          chatMessageIds: [],
          holdIssueIds: [],
          malformedSnapshotsNormalized: true,
        });
        expect(migrated.chatMessageIds).not.toContain(fixture.acceptedMessageId);
        expect(migrated.chatMessageIds).not.toContain(fixture.lateMessageId);
      } finally {
        await runDb(
          adminDatabaseUrl(),
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
              select pg_terminate_backend(pid)
              from pg_stat_activity
              where datname = ${exportDatabaseName}
                and pid <> pg_backend_pid()
            `;
            yield* sql.unsafe(`drop database if exists ${quoteIdentifier(exportDatabaseName)}`);
          }),
        );
      }
    },
  );

  it(
    "converts physically deleted completed and failed 0046 export pointers without inventing payload evidence",
    { timeout: 60_000 },
    async () => {
      const legacyDatabaseName = `${isolatedDatabaseName}_export_generation_${crypto
        .randomUUID()
        .replaceAll("-", "")
        .slice(0, 8)}`;
      const legacyUrl = databaseUrlForName(legacyDatabaseName);
      await runDb(
        adminDatabaseUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql.unsafe(`create database ${quoteIdentifier(legacyDatabaseName)}`);
        }),
      );

      try {
        await runDb(legacyUrl, applyMigrationsThrough("0046_public_source_https_url_policy.sql"));
        const ids = await runDb(
          legacyUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            const completedId = crypto.randomUUID();
            const failedId = crypto.randomUUID();
            const snapshot = () => ({
              version: 1,
              authorizedAt: "2026-07-01T00:00:00.000Z",
              requesterUserId: "legacy-generation-user",
              scopeKind: "user_chats",
              scopeId: "me",
              role: "self",
              clientCompanyIds: [],
              accessIds: [],
              issueIds: [],
              documentIds: [],
              chatIds: [],
              chatMessageIds: [],
            });
            yield* sql`
              insert into export_requests (
                id, requester_user_id, scope_kind, scope_id,
                authorization_snapshot, idempotency_key, status, object_key,
                object_purge_after, object_deleted_at, completed_at, expires_at,
                error_code
              ) values
                (
                  ${completedId}, 'legacy-generation-user', 'user_chats', 'me',
                  ${sql.json(snapshot())}, ${`legacy-completed-${completedId}`},
                  'completed', ${`exports/${completedId}.tar`},
                  now() - interval '2 days', now() - interval '1 day',
                  now() - interval '3 days', now() - interval '2 days', null
                ),
                (
                  ${failedId}, 'legacy-generation-user', 'user_chats', 'me',
                  ${sql.json(snapshot())}, ${`legacy-failed-${failedId}`},
                  'failed', ${`exports/${failedId}.tar`},
                  now() - interval '2 days', now() - interval '1 day',
                  now() - interval '3 days', null, 'legacy_export_failed'
                )
            `;
            return { completedId, failedId };
          }),
        );

        await runDb(legacyUrl, runMigrations);
        const state = await runDb(
          legacyUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            return (yield* sql<{
              readonly completedObjectKey: string;
              readonly completedWriterState: string;
              readonly completedLegacy: boolean;
              readonly completedExpectedSha256: string | null;
              readonly completedByteSize: string | null;
              readonly completedDeleted: boolean;
              readonly failedObjectKey: string | null;
              readonly failedObjectPurgeAfter: Date | null;
              readonly failedObjectDeletedAt: Date | null;
              readonly failedWriterState: string;
              readonly failedLegacy: boolean;
              readonly failedExpectedSha256: string | null;
              readonly failedByteSize: string | null;
              readonly failedFenced: boolean;
              readonly failedDeleted: boolean;
              readonly failedProbeDue: boolean;
            }>`
              select completed.object_key as "completedObjectKey",
                     completed_generation.writer_state as "completedWriterState",
                     completed_generation.legacy_unverifiable as "completedLegacy",
                     completed_generation.expected_sha256 as "completedExpectedSha256",
                     completed_generation.byte_size::text as "completedByteSize",
                     completed_generation.deleted_at is not null as "completedDeleted",
                     failed.object_key as "failedObjectKey",
                     failed.object_purge_after as "failedObjectPurgeAfter",
                     failed.object_deleted_at as "failedObjectDeletedAt",
                     failed_generation.writer_state as "failedWriterState",
                     failed_generation.legacy_unverifiable as "failedLegacy",
                     failed_generation.expected_sha256 as "failedExpectedSha256",
                     failed_generation.byte_size::text as "failedByteSize",
                     failed_generation.delete_fenced_at is not null as "failedFenced",
                     failed_generation.deleted_at is not null as "failedDeleted",
                     failed_generation.next_delete_attempt_at <= now() as "failedProbeDue"
              from export_requests completed
              join export_object_generations completed_generation
                on completed_generation.export_request_id = completed.id
               and completed_generation.generation = 0
              cross join export_requests failed
              join export_object_generations failed_generation
                on failed_generation.export_request_id = failed.id
               and failed_generation.generation = 0
              where completed.id = ${ids.completedId} and failed.id = ${ids.failedId}
            `)[0]!;
          }),
        );
        expect(state).toEqual({
          completedObjectKey: `exports/${ids.completedId}.tar`,
          completedWriterState: "succeeded",
          completedLegacy: true,
          completedExpectedSha256: null,
          completedByteSize: null,
          completedDeleted: true,
          failedObjectKey: null,
          failedObjectPurgeAfter: null,
          failedObjectDeletedAt: null,
          failedWriterState: "unknown",
          failedLegacy: true,
          failedExpectedSha256: null,
          failedByteSize: null,
          failedFenced: true,
          failedDeleted: false,
          failedProbeDue: true,
        });
      } finally {
        await runDb(
          adminDatabaseUrl(),
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
              select pg_terminate_backend(pid)
              from pg_stat_activity
              where datname = ${legacyDatabaseName}
                and pid <> pg_backend_pid()
            `;
            yield* sql.unsafe(`drop database if exists ${quoteIdentifier(legacyDatabaseName)}`);
          }),
        );
      }
    },
  );

  it(
    "refuses undrained pre-split context outputs before enforcing canonical node ownership",
    { timeout: 60_000 },
    async () => {
      const ownershipDatabaseName = `${isolatedDatabaseName}_node_ownership_${crypto
        .randomUUID()
        .replaceAll("-", "")
        .slice(0, 8)}`;
      const ownershipUrl = databaseUrlForName(ownershipDatabaseName);
      await runDb(
        adminDatabaseUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql.unsafe(`create database ${quoteIdentifier(ownershipDatabaseName)}`);
        }),
      );

      try {
        await runDb(
          ownershipUrl,
          applyMigrationsThrough("0047_export_request_legal_hold_scopes.sql"),
        );
        await runDb(
          ownershipUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql.unsafe(`
              create table _smithers_runs (run_id text primary key);
              create table ai_chat_selectors (run_id text primary key);
              create table ai_chat_fanout_contexts (run_id text primary key);
              insert into ai_chat_selectors (run_id) values ('ai-chat:undrained-output');
            `).raw;
          }),
        );

        const blockedOutput = await runDb(ownershipUrl, Effect.exit(runMigrations));
        expect(blockedOutput._tag).toBe("Failure");
        expect(errorText(blockedOutput)).toContain(
          "AI chat node-ownership migration requires drained Smithers output table ai_chat_selectors",
        );

        await runDb(
          ownershipUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`delete from ai_chat_selectors`;
            yield* sql`insert into _smithers_runs (run_id) values ('ai-chat:undrained-run')`;
          }),
        );
        const blockedRun = await runDb(ownershipUrl, Effect.exit(runMigrations));
        expect(blockedRun._tag).toBe("Failure");
        expect(errorText(blockedRun)).toContain(
          "AI chat node-ownership migration requires all prior Smithers runs to be drained",
        );

        const result = await runDb(
          ownershipUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`delete from _smithers_runs`;
            yield* runMigrations;
            const tables = yield* sql<NamedRow>`
              select table_name as name
              from information_schema.tables
              where table_schema = 'public'
                and table_name in ('ai_chat_selectors', 'ai_chat_fanout_contexts')
            `;
            const migration = yield* sql<NamedRow>`
              select name
              from schema_migrations
              where name = '0048_canonical_ai_chat_node_ownership.sql'
            `;
            return { tables, migration };
          }),
        );
        expect(result.tables).toEqual([]);
        expect(result.migration.map((row) => row.name)).toEqual([
          "0048_canonical_ai_chat_node_ownership.sql",
        ]);
      } finally {
        await runDb(
          adminDatabaseUrl(),
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
              select pg_terminate_backend(pid)
              from pg_stat_activity
              where datname = ${ownershipDatabaseName}
                and pid <> pg_backend_pid()
            `;
            yield* sql.unsafe(`drop database if exists ${quoteIdentifier(ownershipDatabaseName)}`);
          }),
        );
      }
    },
  );

  it(
    "refuses retained memory/web outputs before recreating their strict payload schemas",
    { timeout: 60_000 },
    async () => {
      const payloadDatabaseName = `${isolatedDatabaseName}_memory_web_payload_${crypto
        .randomUUID()
        .replaceAll("-", "")
        .slice(0, 8)}`;
      const payloadUrl = databaseUrlForName(payloadDatabaseName);

      await runDb(
        adminDatabaseUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql.unsafe(`create database ${quoteIdentifier(payloadDatabaseName)}`);
        }),
      );

      try {
        await runDb(
          payloadUrl,
          applyMigrationsThrough("0059_immutable_assistant_message_source_identity.sql"),
        );
        await runDb(
          payloadUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql.unsafe(`
              create table _smithers_runs (run_id text primary key);
              create table ai_chat_memories (run_id text primary key);
              create table ai_chat_web (run_id text primary key);
              insert into ai_chat_memories (run_id) values ('ai-chat:retained-memory');
              insert into ai_chat_web (run_id) values ('ai-chat:retained-web');
            `).raw;
          }),
        );

        const blockedMemory = await runDb(payloadUrl, Effect.exit(runMigrations));
        expect(blockedMemory._tag).toBe("Failure");
        expect(errorText(blockedMemory)).toContain(
          "AI chat memory/web payload migration requires drained Smithers output table ai_chat_memories",
        );

        await runDb(
          payloadUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`delete from ai_chat_memories`;
          }),
        );
        const blockedWeb = await runDb(payloadUrl, Effect.exit(runMigrations));
        expect(blockedWeb._tag).toBe("Failure");
        expect(errorText(blockedWeb)).toContain(
          "AI chat memory/web payload migration requires drained Smithers output table ai_chat_web",
        );

        await runDb(
          payloadUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`delete from ai_chat_web`;
            yield* sql`insert into _smithers_runs (run_id) values ('ai-chat:undrained-run')`;
          }),
        );
        const blockedRun = await runDb(payloadUrl, Effect.exit(runMigrations));
        expect(blockedRun._tag).toBe("Failure");
        expect(errorText(blockedRun)).toContain(
          "AI chat memory/web payload migration requires all prior Smithers runs to be drained",
        );

        const result = await runDb(
          payloadUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`delete from _smithers_runs`;
            yield* runMigrations;
            const tables = yield* sql<NamedRow>`
              select table_name as name
              from information_schema.tables
              where table_schema = 'public'
                and table_name in ('ai_chat_memories', 'ai_chat_web')
            `;
            const migration = yield* sql<NamedRow>`
              select name
              from schema_migrations
              where name = '0060_recreate_ai_chat_memory_web_outputs.sql'
            `;
            return { tables, migration };
          }),
        );
        expect(result.tables).toEqual([]);
        expect(result.migration.map((row) => row.name)).toEqual([
          "0060_recreate_ai_chat_memory_web_outputs.sql",
        ]);
      } finally {
        await runDb(
          adminDatabaseUrl(),
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
              select pg_terminate_backend(pid)
              from pg_stat_activity
              where datname = ${payloadDatabaseName}
                and pid <> pg_backend_pid()
            `;
            yield* sql.unsafe(`drop database if exists ${quoteIdentifier(payloadDatabaseName)}`);
          }),
        );
      }
    },
  );

  it(
    "quarantines unprovable text-era PDFs and accepts only exact post-migration PDF bytes",
    { timeout: 60_000 },
    async () => {
      const pdfDatabaseName = `${isolatedDatabaseName}_pdf_${crypto
        .randomUUID()
        .replaceAll("-", "")
        .slice(0, 8)}`;
      const pdfUrl = databaseUrlForName(pdfDatabaseName);
      const legacyPdfText = "legacy pdf text ".repeat(10);
      const currentHtmlText = "current html text ".repeat(10);
      const legacyPdfContentHash = createHash("sha256").update(legacyPdfText).digest("hex");
      const currentHtmlContentHash = createHash("sha256").update(currentHtmlText).digest("hex");
      await runDb(
        adminDatabaseUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql.unsafe(`create database ${quoteIdentifier(pdfDatabaseName)}`);
        }),
      );

      try {
        await runDb(pdfUrl, applyMigrationsThrough("0026_publisher_onboarding_idempotency.sql"));
        await runDb(
          pdfUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
              insert into public_sources (
                source_id, display_name, publisher_name, description,
                ingestion_method, discovery_url, average_chars_per_item
              ) values (
                'binary-migration-source', 'Binary migration source', 'Official publisher',
                'Verifies exact raw artifact migration', 'rss',
                'https://example.test/feed', 1000
              )
            `;
            yield* sql`
              insert into public_source_candidates (
                source_id, canonical_url, title, discovered_at
              ) values
                (
                  'binary-migration-source', 'https://example.test/legacy.pdf',
                  'Legacy PDF', now()
                ),
                (
                  'binary-migration-source', 'https://example.test/current.html',
                  'Current HTML', now()
                )
            `;
            yield* sql`
              insert into public_source_raw_artifacts (
                id, source_id, canonical_url, fetched_at, media_type, body, body_hash
              ) values
                (
                  '27000000-0000-4000-8000-000000000001',
                  'binary-migration-source', 'https://example.test/legacy.pdf', now(),
                  'application/pdf', 'JVBERi0xLjQKlegacy-transcoded-text', 'legacy-pdf-hash'
                ),
                (
                  '27000000-0000-4000-8000-000000000002',
                  'binary-migration-source', 'https://example.test/current.html', now(),
                  'text/html', '<html><body>Official source</body></html>', 'html-hash'
                )
            `;
            yield* sql`
              insert into public_source_documents (
                document_id, source_id, canonical_url, title, discovered_at, fetched_at,
                language, document_type, text, text_char_count, content_hash, raw_artifact_id
              ) values
                (
                  'legacy-pdf-document', 'binary-migration-source',
                  'https://example.test/legacy.pdf', 'Legacy PDF', now(), now(),
                  'en-US', 'report', ${legacyPdfText}, 160,
                  ${legacyPdfContentHash}, '27000000-0000-4000-8000-000000000001'
                ),
                (
                  'current-html-document', 'binary-migration-source',
                  'https://example.test/current.html', 'Current HTML', now(), now(),
                  'en-US', 'article', ${currentHtmlText}, 180,
                  ${currentHtmlContentHash}, '27000000-0000-4000-8000-000000000002'
                )
            `;
            yield* sql`
              insert into public_source_items (
                source_id, canonical_url, title, discovered_at, current_content_hash,
                latest_document_id, latest_raw_artifact_id
              ) values
                (
                  'binary-migration-source', 'https://example.test/legacy.pdf',
                  'Legacy PDF', now(), ${legacyPdfContentHash}, 'legacy-pdf-document',
                  '27000000-0000-4000-8000-000000000001'
                ),
                (
                  'binary-migration-source', 'https://example.test/current.html',
                  'Current HTML', now(), ${currentHtmlContentHash}, 'current-html-document',
                  '27000000-0000-4000-8000-000000000002'
                )
            `;
          }),
        );

        await runDb(pdfUrl, runMigrations);
        const result = await runDb(
          pdfUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            const counts = yield* sql<{
              readonly pdfArtifacts: number;
              readonly pdfDocuments: number;
              readonly pdfItems: number;
              readonly htmlArtifacts: number;
              readonly htmlDocuments: number;
              readonly htmlItems: number;
              readonly failures: number;
              readonly lastError: string | null;
            }>`
              select
                (select count(*)::int from public_source_raw_artifacts where canonical_url = 'https://example.test/legacy.pdf') as "pdfArtifacts",
                (select count(*)::int from public_source_documents where canonical_url = 'https://example.test/legacy.pdf') as "pdfDocuments",
                (select count(*)::int from public_source_items where canonical_url = 'https://example.test/legacy.pdf') as "pdfItems",
                (select count(*)::int from public_source_raw_artifacts where canonical_url = 'https://example.test/current.html') as "htmlArtifacts",
                (select count(*)::int from public_source_documents where canonical_url = 'https://example.test/current.html') as "htmlDocuments",
                (select count(*)::int from public_source_items where canonical_url = 'https://example.test/current.html') as "htmlItems",
                candidates.consecutive_failures::int as failures,
                candidates.last_error as "lastError"
              from public_source_candidates candidates
              where candidates.source_id = 'binary-migration-source'
                and candidates.canonical_url = 'https://example.test/legacy.pdf'
            `;
            const validPdfBytes = "255044462d312e340a2520454f460a";
            yield* sql`
              insert into public_source_raw_artifacts (
                id, source_id, canonical_url, fetched_at, media_type, body,
                body_bytes, body_hash
              ) values (
                '27000000-0000-4000-8000-000000000003',
                'binary-migration-source', 'https://example.test/exact.pdf', now(),
                'application/pdf', '', decode(${validPdfBytes}, 'hex'),
                encode(digest(decode(${validPdfBytes}, 'hex'), 'sha256'), 'hex')
              )
            `;
            const exact = yield* sql<{ readonly bytesHex: string; readonly hashMatches: boolean }>`
              select encode(body_bytes, 'hex') as "bytesHex",
                     body_hash = encode(digest(body_bytes, 'sha256'), 'hex') as "hashMatches"
              from public_source_raw_artifacts
              where id = '27000000-0000-4000-8000-000000000003'
            `;
            const invalid = yield* Effect.exit(sql`
              insert into public_source_raw_artifacts (
                id, source_id, canonical_url, fetched_at, media_type, body, body_hash
              ) values (
                '27000000-0000-4000-8000-000000000004',
                'binary-migration-source', 'https://example.test/fabricated.pdf', now(),
                'application/pdf', 'JVBERi0xLjQKfabricated', 'fabricated'
              )
            `);
            return { counts: counts[0], exact: exact[0], invalid: invalid._tag };
          }),
        );

        expect(result.counts).toEqual({
          pdfArtifacts: 0,
          pdfDocuments: 0,
          pdfItems: 0,
          htmlArtifacts: 1,
          htmlDocuments: 1,
          htmlItems: 1,
          failures: 1,
          lastError: "binary_pdf_refetch_required",
        });
        expect(result.exact).toEqual({
          bytesHex: "255044462d312e340a2520454f460a",
          hashMatches: true,
        });
        expect(result.invalid).toBe("Failure");
      } finally {
        await runDb(
          adminDatabaseUrl(),
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
              select pg_terminate_backend(pid)
              from pg_stat_activity
              where datname = ${pdfDatabaseName}
                and pid <> pg_backend_pid()
            `;
            yield* sql.unsafe(`drop database if exists ${quoteIdentifier(pdfDatabaseName)}`);
          }),
        );
      }
    },
  );

  it(
    "serializes migration 0060 with producers across existing and absent output tables",
    { timeout: 60_000 },
    async () => {
      const fenceDatabaseName = `${isolatedDatabaseName}_memory_web_fence_${crypto
        .randomUUID()
        .replaceAll("-", "")
        .slice(0, 8)}`;
      const fenceUrl = databaseUrlForName(fenceDatabaseName);
      const fenceKey = "brief:ai-chat:smithers-schema";
      await runDb(
        adminDatabaseUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql.unsafe(`create database ${quoteIdentifier(fenceDatabaseName)}`);
        }),
      );

      const waitForMigrationLock = async (): Promise<void> => {
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const waiting = await runDbAs(
            fenceUrl,
            "brief-migration-fence-observer",
            Effect.gen(function* () {
              const sql = yield* PgClient.PgClient;
              return (yield* sql<{ readonly waiting: boolean }>`
                  select exists (
                    select 1
                    from pg_stat_activity
                    where datname = current_database()
                      and application_name = 'brief-migration-fence-runner'
                      and wait_event_type = 'Lock'
                  ) as waiting
                `)[0]!.waiting;
            }),
          );
          if (waiting) return;
          await Bun.sleep(5);
        }
        throw new Error("migration did not wait on the producer fence");
      };

      const runProducerHoldingSharedFence = async (
        createMissingTable: boolean,
        rowId: string,
      ): Promise<() => Promise<void>> => {
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        let ready!: () => void;
        const readyPromise = new Promise<void>((resolve) => {
          ready = resolve;
        });
        const producer = runDbAs(
          fenceUrl,
          "brief-migration-fence-producer",
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`
                  select pg_advisory_xact_lock_shared(
                    hashtextextended(${fenceKey}::text, 0)
                  )
                `;
                if (createMissingTable) {
                  yield* sql`create table ai_chat_memories (run_id text primary key)`;
                }
                yield* sql`
                  insert into ai_chat_memories (run_id)
                  values (${rowId})
                `;
                ready();
                yield* Effect.promise(() => held);
              }),
            );
          }),
        );
        await readyPromise;
        return async () => {
          release();
          await producer;
        };
      };

      try {
        await runDb(
          fenceUrl,
          applyMigrationsThrough("0059_immutable_assistant_message_source_identity.sql"),
        );
        await runDb(
          fenceUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql.unsafe(`
              create table _smithers_runs (run_id text primary key);
              create table ai_chat_memories (run_id text primary key);
              create table ai_chat_web (run_id text primary key);
            `).raw;
          }),
        );

        const releaseExisting = await runProducerHoldingSharedFence(
          false,
          "ai-chat:producer-existing",
        );
        let migrationSettled = false;
        const migrationExisting = runDbAs(
          fenceUrl,
          "brief-migration-fence-runner",
          Effect.exit(runMigrations),
        ).finally(() => {
          migrationSettled = true;
        });
        await waitForMigrationLock();
        expect(migrationSettled).toBe(false);
        await releaseExisting();
        const blockedExisting = await migrationExisting;
        expect(blockedExisting._tag).toBe("Failure");
        expect(errorText(blockedExisting)).toContain(
          "AI chat memory/web payload migration requires drained Smithers output table ai_chat_memories",
        );
        const existingRow = await runDb(
          fenceUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            return yield* sql<{ readonly runId: string }>`
              select run_id as "runId" from ai_chat_memories
            `;
          }),
        );
        expect(existingRow).toEqual([{ runId: "ai-chat:producer-existing" }]);

        await runDb(
          fenceUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`drop table ai_chat_memories, ai_chat_web, _smithers_runs`;
          }),
        );

        const releaseAbsent = await runProducerHoldingSharedFence(true, "ai-chat:producer-absent");
        migrationSettled = false;
        const migrationAbsent = runDbAs(
          fenceUrl,
          "brief-migration-fence-runner",
          Effect.exit(runMigrations),
        ).finally(() => {
          migrationSettled = true;
        });
        await waitForMigrationLock();
        expect(migrationSettled).toBe(false);
        await releaseAbsent();
        const blockedAbsent = await migrationAbsent;
        expect(blockedAbsent._tag).toBe("Failure");
        expect(errorText(blockedAbsent)).toContain(
          "AI chat memory/web payload migration requires drained Smithers output table ai_chat_memories",
        );
        const absentRow = await runDb(
          fenceUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            return yield* sql<{ readonly runId: string }>`
              select run_id as "runId" from ai_chat_memories
            `;
          }),
        );
        expect(absentRow).toEqual([{ runId: "ai-chat:producer-absent" }]);

        await runDb(
          fenceUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`drop table ai_chat_memories`;
          }),
        );
        await runDb(fenceUrl, runMigrations);
        await runDb(
          fenceUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`
                  select pg_advisory_xact_lock_shared(
                    hashtextextended(${fenceKey}::text, 0)
                  )
                `;
                yield* sql`create table ai_chat_memories (run_id text primary key)`;
                yield* sql`
                  insert into ai_chat_memories (run_id)
                  values ('ai-chat:producer-after-migration')
                `;
              }),
            );
          }),
        );
        const recreatedRow = await runDb(
          fenceUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            return yield* sql<{ readonly runId: string }>`
              select run_id as "runId" from ai_chat_memories
            `;
          }),
        );
        expect(recreatedRow).toEqual([{ runId: "ai-chat:producer-after-migration" }]);
      } finally {
        await runDb(
          adminDatabaseUrl(),
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
              select pg_terminate_backend(pid)
              from pg_stat_activity
              where datname = ${fenceDatabaseName}
                and pid <> pg_backend_pid()
            `;
            yield* sql.unsafe(`drop database if exists ${quoteIdentifier(fenceDatabaseName)}`);
          }),
        );
      }
    },
  );

  it(
    "forwards the historical one-chat schema without rewriting migration history",
    { timeout: 60_000 },
    async () => {
      const duplicateDatabaseName = `${isolatedDatabaseName}_dupe_${crypto
        .randomUUID()
        .replaceAll("-", "")
        .slice(0, 8)}`;
      const duplicateUrl = databaseUrlForName(duplicateDatabaseName);
      const chatId = "eeeeeeee-0000-0000-0000-000000000001";
      const messageId = "eeeeeeee-0000-0000-0000-000000000002";
      const runId = "eeeeeeee-0000-0000-0000-000000000003";
      const memoryId = "eeeeeeee-0000-0000-0000-000000000005";

      await runDb(
        adminDatabaseUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql.unsafe(`create database ${quoteIdentifier(duplicateDatabaseName)}`);
        }),
      );

      try {
        await runDb(
          duplicateUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql.unsafe("drop schema if exists public cascade");
            yield* sql.unsafe("create schema public");
          }),
        );
        await runDb(duplicateUrl, applyMigrationsThrough("0012_ai_run_events_emitted_by_task.sql"));
        await runDb(
          duplicateUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
              insert into chats (id, user_id, created_at, updated_at)
              values (${chatId}, 'demo-user', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00')
            `;
            yield* sql`
              insert into chat_messages (id, chat_id, author, content)
              values (${messageId}, ${chatId}, 'user', 'surviving chat message')
            `;
            yield* sql`
            insert into ai_runs (id, chat_id, user_message_id, locale, market, failed_at, error)
              values (${runId}, ${chatId}, ${messageId}, 'fr-FR', 'FR', now(), 'historical_failure')
            `;
            yield* sql`
              alter table ai_run_events add column if not exists emission_key text
            `;
            yield* sql`
              insert into ai_run_events (run_id, seq, event, emitted_by_task, emission_key)
              values
                (${runId}, 1, ${sql.json({ type: "run_started" })}, null, 'run_started'),
                (${runId}, 2, ${sql.json({
                  type: "usage",
                  scope: "run",
                  model: {
                    inputTokens: 0,
                    outputTokens: 0,
                    cachedTokens: 0,
                    reasoningTokens: 0,
                    totalTokens: 0,
                    requestCount: 0,
                  },
                  web: { searchCount: 0, fetchCount: 0, responseBytes: 0, billedUnits: 0 },
                })}, 'failure-handler', 'usage:run'),
                (${runId}, 3, ${sql.json({ type: "error", code: "historical_failure", retryable: false })}, 'failure-handler', 'terminal')
            `;
            yield* sql`
              insert into user_memories (id, user_id, kind, content)
              values (${memoryId}, 'demo-user', 'fact', 'surviving memory')
            `;
            yield* sql`
              insert into user_memory_revisions (memory_id, action, content_after, run_id)
              values (${memoryId}, 'created', 'surviving memory', null)
            `;
          }),
        );

        await runDb(
          duplicateUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            const body = yield* Effect.promise(() =>
              Bun.file(new URL("0013_chats_unique_user.sql", migrationsUrl)).text(),
            );
            yield* sql.unsafe(body).raw;
            yield* sql`
              insert into schema_migrations (name)
              values ('0013_chats_unique_user.sql')
            `;
          }),
        );
        const beforeForward = await runDb(
          duplicateUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            const [index] = yield* sql<CountRow>`
              select count(*)::int as count
              from pg_indexes
              where schemaname = 'public' and tablename = 'chats' and indexname = 'chats_user_key'
            `;
            const insertExit = yield* Effect.exit(sql`
              insert into chats (id, user_id)
              values ('eeeeeeee-0000-0000-0000-000000000006', 'demo-user')
            `);
            return { indexCount: index?.count ?? 0, insertExit };
          }),
        );
        expect(beforeForward.indexCount).toBe(1);
        expect(beforeForward.insertExit._tag).toBe("Failure");

        await runDb(duplicateUrl, runMigrations);
        const result = await runDb(
          duplicateUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            const [index] = yield* sql<CountRow>`
              select count(*)::int as count
              from pg_indexes
              where schemaname = 'public' and tablename = 'chats' and indexname = 'chats_user_key'
            `;
            const chats = yield* sql<ChatRow>`
              select id, company_id as "companyId"
              from chats
              where user_id = 'demo-user'
              order by id
            `;
            const [surviving] = yield* sql<CountRow>`
              select count(distinct runs.id)::int as count
              from chats surviving_chats
              join chat_messages messages on messages.chat_id = surviving_chats.id
              join ai_runs runs on runs.chat_id = messages.chat_id
              join ai_run_events events on events.run_id = runs.id
              join user_memories memories on memories.id = ${memoryId}
              join user_memory_revisions revisions on revisions.memory_id = memories.id
              where surviving_chats.id = ${chatId}
                and messages.id = ${messageId}
                and runs.id = ${runId}
                and runs.assistant_message_id is null
                and events.run_id = ${runId}
            `;
            const survivingCompanyId = chats[0]?.companyId;
            if (!survivingCompanyId) {
              return yield* Effect.fail(new Error("surviving chat company is missing"));
            }
            yield* sql`
              insert into chats (id, user_id, company_id, memory_mode)
              values (
                'eeeeeeee-0000-0000-0000-000000000007',
                'demo-user',
                ${survivingCompanyId},
                'private_owner'
              )
            `;
            const migrations = yield* sql<NamedRow>`
              select name from schema_migrations
              where name in ('0013_chats_unique_user.sql', '0061_allow_multiple_chats.sql')
              order by name
            `;
            return {
              indexCount: index?.count ?? 0,
              chatIds: chats.map((chat) => chat.id),
              survivingCount: surviving?.count ?? 0,
              migrations: migrations.map((migration) => migration.name),
            };
          }),
        );
        expect(result.indexCount).toBe(0);
        expect(result.chatIds).toEqual([chatId]);
        expect(result.survivingCount).toBe(1);
        expect(result.migrations).toEqual([
          "0013_chats_unique_user.sql",
          "0061_allow_multiple_chats.sql",
        ]);

        const chatCount = await runDb(
          duplicateUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            const [row] = yield* sql<CountRow>`
              select count(*)::int as count from chats where user_id = 'demo-user'
            `;
            return row?.count ?? 0;
          }),
        );
        expect(chatCount).toBe(2);
      } finally {
        await runDb(
          adminDatabaseUrl(),
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
              select pg_terminate_backend(pid)
              from pg_stat_activity
              where datname = ${duplicateDatabaseName}
                and pid <> pg_backend_pid()
            `;
            yield* sql.unsafe(`drop database if exists ${quoteIdentifier(duplicateDatabaseName)}`);
          }),
        );
      }
    },
  );

  it("maps language codes to regconfigs by primary subtag", { timeout: 60_000 }, async () => {
    const testUrl = isolatedDatabaseUrl();
    const [configs] = await runDb(
      testUrl,
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;

        return yield* sql<RegconfigRow>`
            select
              language_to_regconfig('fr')::text as fr,
              language_to_regconfig('fr-FR')::text as fr_full,
              language_to_regconfig('en')::text as en,
              language_to_regconfig('en-US')::text as en_full,
              language_to_regconfig('de')::text as de,
              language_to_regconfig('de-DE')::text as de_full
          `;
      }),
    );

    expect(configs).toEqual({
      fr: "french",
      fr_full: "french",
      en: "english",
      en_full: "english",
      de: "simple",
      de_full: "simple",
    });
  });

  it(
    "indexes documents per language config with weighted title ranking",
    { timeout: 60_000 },
    async () => {
      const testUrl = isolatedDatabaseUrl();
      const result = await runDb(
        testUrl,
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;

          yield* sql`
            insert into public_sources (
              source_id,
              display_name,
              publisher_name,
              description,
              ingestion_method,
              discovery_url,
              average_chars_per_item
            )
            values (
              'fts-src',
              'FTS Source',
              'FTS Publisher',
              'fts fixtures',
              'rss',
              'https://fts.example',
              1000
            )
            on conflict (source_id) do nothing
          `;
          yield* sql`
            insert into public_source_raw_artifacts (
              id,
              source_id,
              canonical_url,
              fetched_at,
              media_type,
              body,
              body_hash
            )
            values
              (
                'aaaaaaaa-0000-0000-0000-000000000001',
                'fts-src',
                'https://fts.example/fr-title',
                now(),
                'text/html',
                'body',
                'fts-h1'
              ),
              (
                'aaaaaaaa-0000-0000-0000-000000000002',
                'fts-src',
                'https://fts.example/fr-body',
                now(),
                'text/html',
                'body',
                'fts-h2'
              ),
              (
                'aaaaaaaa-0000-0000-0000-000000000003',
                'fts-src',
                'https://fts.example/en',
                now(),
                'text/html',
                'body',
                'fts-h3'
              ),
              (
                'aaaaaaaa-0000-0000-0000-000000000004',
                'fts-src',
                'https://fts.example/de',
                now(),
                'text/html',
                'body',
                'fts-h4'
              )
            on conflict (id) do nothing
          `;
          yield* sql`
            insert into public_source_documents (
              document_id,
              source_id,
              canonical_url,
              title,
              published_at,
              discovered_at,
              fetched_at,
              language,
              document_type,
              text,
              text_char_count,
              content_hash,
              raw_artifact_id
            )
            values
              (
                'fts-doc-fr-title',
                'fts-src',
                'https://fts.example/fr-title',
                'Réformes économiques en France',
                now(),
                now(),
                now(),
                'fr',
                'article',
                repeat('contexte budgétaire ', 10),
                200,
                encode(digest(convert_to(repeat('contexte budgétaire ', 10), 'UTF8'), 'sha256'), 'hex'),
                'aaaaaaaa-0000-0000-0000-000000000001'
              ),
              (
                'fts-doc-fr-body',
                'fts-src',
                'https://fts.example/fr-body',
                'Note de conjoncture',
                now(),
                now(),
                now(),
                'fr-FR',
                'article',
                'Les réformes économiques annoncées par le gouvernement ' || repeat('remplissage ', 20),
                295,
                encode(digest(convert_to('Les réformes économiques annoncées par le gouvernement ' || repeat('remplissage ', 20), 'UTF8'), 'sha256'), 'hex'),
                'aaaaaaaa-0000-0000-0000-000000000002'
              ),
              (
                'fts-doc-en',
                'fts-src',
                'https://fts.example/en',
                'Committee report',
                now(),
                now(),
                now(),
                'en-US',
                'article',
                'The committee is running new stress tests this quarter ' || repeat('filler ', 20),
                195,
                encode(digest(convert_to('The committee is running new stress tests this quarter ' || repeat('filler ', 20), 'UTF8'), 'sha256'), 'hex'),
                'aaaaaaaa-0000-0000-0000-000000000003'
              ),
              (
                'fts-doc-de',
                'fts-src',
                'https://fts.example/de',
                'Wirtschaftsbericht',
                now(),
                now(),
                now(),
                'de',
                'article',
                'Wirtschaftsberichte und laufende Analysen ' || repeat('inhalt ', 20),
                182,
                encode(digest(convert_to('Wirtschaftsberichte und laufende Analysen ' || repeat('inhalt ', 20), 'UTF8'), 'sha256'), 'hex'),
                'aaaaaaaa-0000-0000-0000-000000000004'
              )
            on conflict (document_id) do update
            set
              title = excluded.title,
              language = excluded.language,
              text = excluded.text,
              text_char_count = excluded.text_char_count,
              content_hash = excluded.content_hash,
              raw_artifact_id = excluded.raw_artifact_id
          `;

          const french = yield* sql<DocumentRow>`
            select document_id
            from public_source_documents
            where search_vector @@ websearch_to_tsquery('french', 'réforme économique')
            order by document_id
          `;
          const english = yield* sql<DocumentRow>`
            select document_id
            from public_source_documents
            where search_vector @@ websearch_to_tsquery('english', 'run')
            order by document_id
          `;
          const simpleExact = yield* sql<DocumentRow>`
            select document_id
            from public_source_documents
            where search_vector @@ websearch_to_tsquery('simple', 'wirtschaftsberichte')
            order by document_id
          `;
          const simpleStemmed = yield* sql<DocumentRow>`
            select document_id
            from public_source_documents
            where search_vector @@ websearch_to_tsquery('simple', 'wirtschaftsberichten')
            order by document_id
          `;
          const ranked = yield* sql<DocumentRow>`
            select document_id
            from public_source_documents
            where search_vector @@ websearch_to_tsquery('french', 'réforme économique')
            order by ts_rank_cd(
              search_vector,
              websearch_to_tsquery('french', 'réforme économique')
            ) desc
          `;

          return {
            french: french.map((row) => row.document_id),
            english: english.map((row) => row.document_id),
            simpleExact: simpleExact.map((row) => row.document_id),
            simpleStemmed: simpleStemmed.map((row) => row.document_id),
            ranked: ranked.map((row) => row.document_id),
          };
        }),
      );

      expect(result.french).toEqual(["fts-doc-fr-body", "fts-doc-fr-title"]);
      expect(result.english).toEqual(["fts-doc-en"]);
      expect(result.simpleExact).toEqual(["fts-doc-de"]);
      expect(result.simpleStemmed).toEqual([]);
      expect(result.ranked[0]).toBe("fts-doc-fr-title");
    },
  );

  it("binds public and publisher document hashes to immutable UTF-8 text", async () => {
    const result = await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const suffix = crypto.randomUUID();
        const publicSourceId = `hash-source-${suffix}`;
        const publicDocumentId = `hash-public-document-${suffix}`;
        const publicInvalidDocumentId = `hash-public-invalid-${suffix}`;
        const publicArtifactId = crypto.randomUUID();
        const publisherCompanyId = crypto.randomUUID();
        const subscriptionId = crypto.randomUUID();
        const issueId = crypto.randomUUID();
        const publisherDocumentId = crypto.randomUUID();
        const publisherVersionId = crypto.randomUUID();
        const publisherInvalidVersionId = crypto.randomUUID();
        const publisherExtractionId = crypto.randomUUID();
        const publisherExtractionJobId = crypto.randomUUID();
        const publicText = "Données publiques 😀 ".repeat(10);
        const publisherText = "Version publiée 😀";

        yield* sql`
          insert into public_sources (
            source_id, display_name, publisher_name, description,
            ingestion_method, discovery_url, average_chars_per_item
          ) values (
            ${publicSourceId}, 'Hash source', 'Hash publisher', 'Hash fixture',
            'manual', ${`https://hash.example/${suffix}`}, 100
          )
        `;
        yield* sql`
          insert into public_source_raw_artifacts (
            id, source_id, canonical_url, fetched_at, media_type, body, body_hash
          ) values (
            ${publicArtifactId}, ${publicSourceId}, ${`https://hash.example/${suffix}`},
            now(), 'text/html', ${publicText}, 'hash-artifact'
          )
        `;
        const publicHashFailure = yield* Effect.flip(sql`
          insert into public_source_documents (
            document_id, source_id, raw_artifact_id, canonical_url, title, text,
            language, discovered_at, fetched_at, document_type, content_hash, text_char_count
          ) values (
            ${publicInvalidDocumentId}, ${publicSourceId}, ${publicArtifactId},
            ${`https://hash.example/${suffix}`}, 'Invalid hash', ${publicText}, 'en-US',
            now(), now(), 'article', ${"a".repeat(64)}, ${publicText.length}
          )
        `);
        yield* sql`
          insert into public_source_documents (
            document_id, source_id, raw_artifact_id, canonical_url, title, text,
            language, discovered_at, fetched_at, document_type, content_hash, text_char_count
          ) values (
            ${publicDocumentId}, ${publicSourceId}, ${publicArtifactId},
            ${`https://hash.example/${suffix}`}, 'Valid hash', ${publicText}, 'en-US',
            now(), now(), 'article',
            encode(digest(convert_to(${publicText}, 'UTF8'), 'sha256'), 'hex'),
            ${publicText.length}
          )
        `;
        const publicTextUpdateFailure = yield* Effect.flip(sql`
          update public_source_documents
          set text = ${"Réécriture interdite ❌ ".repeat(10)}
          where document_id = ${publicDocumentId}
        `);
        yield* sql`
          update public_source_documents
          set source_metadata = '{"reviewed":true}'::jsonb
          where document_id = ${publicDocumentId}
        `;

        yield* sql`
          insert into publisher_companies (id, name)
          values (${publisherCompanyId}, 'Hash publisher')
        `;
        yield* sql`
          insert into publisher_subscriptions (id, publisher_company_id, name, created_by_user_id)
          values (${subscriptionId}, ${publisherCompanyId}, 'Hash subscription', 'hash-user')
        `;
        yield* sql`
          insert into publisher_issues (
            id, subscription_id, title, status, created_by_user_id
          ) values (
            ${issueId}, ${subscriptionId}, 'Hash issue', 'draft', 'hash-user'
          )
        `;
        yield* sql`
          insert into brief_documents (
            id, issue_id, title, original_file_name, object_key, media_type,
            byte_size, sha256_hex, upload_completed_at, language, created_by_user_id
          ) values (
            ${publisherDocumentId}, ${issueId}, 'Hash document', 'hash.pdf',
            ${`hash/${publisherDocumentId}.pdf`}, 'application/pdf', 1,
            ${"b".repeat(64)}, now(), 'en-US', 'hash-user'
          )
        `;
        yield* sql`
          insert into jobs (id, kind, payload)
          values (${publisherExtractionJobId}, 'extract_pdf_text', '{}'::jsonb)
        `;
        yield* sql`
          insert into brief_document_extractions (
            id, brief_document_id, input_sha256_hex, pages,
            extracted_char_count, created_by_job_id
          ) values (
            ${publisherExtractionId}, ${publisherDocumentId}, ${"b".repeat(64)},
            ${JSON.stringify([{ pageNumber: 1, text: publisherText }])}::jsonb,
            ${publisherText.length}, ${publisherExtractionJobId}
          )
        `;
        const publisherHashFailure = yield* Effect.flip(sql`
          insert into brief_document_versions (
            id, brief_document_id, publisher_extraction_id, content_hash, language, canonical_text,
            text_char_count, page_ranges
          ) values (
            ${publisherInvalidVersionId}, ${publisherDocumentId}, ${publisherExtractionId}, ${"b".repeat(64)},
            'en-US', ${publisherText}, ${publisherText.length},
            ${JSON.stringify([{ pageNumber: 1, charStart: 0, charEnd: publisherText.length }])}::jsonb
          )
        `);
        yield* sql`
          insert into brief_document_versions (
            id, brief_document_id, publisher_extraction_id, content_hash, language, canonical_text,
            text_char_count, page_ranges
          ) values (
            ${publisherVersionId}, ${publisherDocumentId}, ${publisherExtractionId},
            encode(digest(convert_to(${publisherText}, 'UTF8'), 'sha256'), 'hex'),
            'en-US', ${publisherText}, ${publisherText.length},
            ${JSON.stringify([{ pageNumber: 1, charStart: 0, charEnd: publisherText.length }])}::jsonb
          )
        `;
        const publisherTextUpdateFailure = yield* Effect.flip(sql`
          update brief_document_versions
          set canonical_text = 'Réécriture interdite ❌'
          where id = ${publisherVersionId}
        `);

        return {
          publicHashFailure,
          publicTextUpdateFailure,
          publisherHashFailure,
          publisherTextUpdateFailure,
        };
      }),
    );

    expect(errorText(result.publicHashFailure)).toContain(
      "public source document content hash must match exact UTF-8 text",
    );
    expect(errorText(result.publicTextUpdateFailure)).toContain(
      "public source document content hash must match exact UTF-8 text",
    );
    expect(errorText(result.publisherHashFailure)).toContain(
      "publisher document version content hash must match exact UTF-8 text",
    );
    expect(errorText(result.publisherTextUpdateFailure)).toContain(
      "brief document versions are immutable",
    );
  });

  it("enforces one unterminated run per chat", { timeout: 60_000 }, async () => {
    const testUrl = isolatedDatabaseUrl();
    const result = await runDb(
      testUrl,
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const userId = "migration-active-run-user";
        const companyId = yield* provisionClientUser(userId);

        yield* sql`
            insert into chats (id, company_id, user_id, memory_mode)
            values ('bbbbbbbb-0000-0000-0000-000000000001', ${companyId}, ${userId}, 'disabled')
            on conflict (id) do nothing
          `;
        yield* sql`
            insert into chat_messages (id, chat_id, author, content)
            values
              (
                'bbbbbbbb-0000-0000-0000-000000000002',
                'bbbbbbbb-0000-0000-0000-000000000001',
                'user',
                'Migration invariant test one'
              ),
              (
                'bbbbbbbb-0000-0000-0000-000000000005',
                'bbbbbbbb-0000-0000-0000-000000000001',
                'user',
                'Migration invariant test two'
              )
            on conflict (id) do nothing
          `;
        yield* sql`
            insert into ai_runs (id, chat_id, user_message_id, locale, market, acceptance_scope)
            values (
              'bbbbbbbb-0000-0000-0000-000000000003',
              'bbbbbbbb-0000-0000-0000-000000000001',
              'bbbbbbbb-0000-0000-0000-000000000002',
              'fr-FR',
              'FR',
              ${sql.json(
                testAcceptanceScope({
                  userId,
                  chatId: "bbbbbbbb-0000-0000-0000-000000000001",
                  companyId,
                }),
              )}
            )
            on conflict (id) do nothing
          `;

        const failure = yield* Effect.flip(sql`
            insert into ai_runs (id, chat_id, user_message_id, locale, market, acceptance_scope)
            values (
              'bbbbbbbb-0000-0000-0000-000000000004',
              'bbbbbbbb-0000-0000-0000-000000000001',
              'bbbbbbbb-0000-0000-0000-000000000005',
              'fr-FR',
              'FR',
              ${sql.json(
                testAcceptanceScope({
                  userId,
                  chatId: "bbbbbbbb-0000-0000-0000-000000000001",
                  companyId,
                }),
              )}
            )
          `);

        yield* sql`
            update ai_runs
            set finished_at = now()
            where id = 'bbbbbbbb-0000-0000-0000-000000000003'
          `;
        yield* sql`
            insert into ai_runs (id, chat_id, user_message_id, locale, market, acceptance_scope)
            values (
              'bbbbbbbb-0000-0000-0000-000000000004',
              'bbbbbbbb-0000-0000-0000-000000000001',
              'bbbbbbbb-0000-0000-0000-000000000005',
              'fr-FR',
              'FR',
              ${sql.json(
                testAcceptanceScope({
                  userId,
                  chatId: "bbbbbbbb-0000-0000-0000-000000000001",
                  companyId,
                }),
              )}
            )
          `;

        const [count] = yield* sql<CountRow>`
            select count(*)::int as count
            from ai_runs
            where chat_id = 'bbbbbbbb-0000-0000-0000-000000000001'
          `;

        return {
          failure,
          count: count?.count,
        };
      }),
    );

    expect(errorText(result.failure)).toContain("ai_runs_active_chat_key");
    expect(result.count).toBe(2);
  });

  it(
    "enforces one unterminated run per initiating user across chats",
    { timeout: 60_000 },
    async () => {
      const result = await runDb(
        isolatedDatabaseUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const initiatingUserId = `initiating-user-${crypto.randomUUID()}`;
          const otherUserId = `other-user-${crypto.randomUUID()}`;
          const initiatingCompanyId = yield* provisionClientUser(initiatingUserId);
          const otherCompanyId = yield* provisionClientUser(otherUserId);
          const firstChatId = crypto.randomUUID();
          const secondChatId = crypto.randomUUID();
          yield* sql`
          insert into chats (id, company_id, user_id, memory_mode)
          values
            (${firstChatId}, ${initiatingCompanyId}, ${initiatingUserId}, 'disabled'),
            (${secondChatId}, ${otherCompanyId}, ${otherUserId}, 'disabled')
        `;
          const messages = yield* sql<{ readonly id: string }>`
          insert into chat_messages (chat_id, author, content)
          values
            (${firstChatId}, 'user', 'first'),
            (${secondChatId}, 'user', 'second')
          returning id::text
        `;
          const firstMessageId = messages[0]!.id;
          const secondMessageId = messages[1]!.id;
          const [firstRun] = yield* sql<{ readonly id: string }>`
          insert into ai_runs (
            chat_id, initiating_user_id, user_message_id, locale, market, acceptance_scope
          )
          values (
            ${firstChatId}, ${initiatingUserId}, ${firstMessageId}, 'en-US', 'US',
            ${sql.json(
              testAcceptanceScope({
                userId: initiatingUserId,
                chatId: firstChatId,
                companyId: initiatingCompanyId,
              }),
            )}
          )
          returning id::text
        `;
          const failure = yield* Effect.flip(sql`
          insert into ai_runs (
            chat_id, initiating_user_id, user_message_id, locale, market, acceptance_scope
          )
          values (
            ${secondChatId}, ${initiatingUserId}, ${secondMessageId}, 'en-US', 'US',
            ${sql.json(
              testAcceptanceScope({
                userId: initiatingUserId,
                chatId: secondChatId,
                companyId: otherCompanyId,
              }),
            )}
          )
        `);
          yield* sql`
          update ai_runs
          set failed_at = now(), error_code = 'answer_failed', retryable = true
          where id = ${firstRun!.id}
        `;
          yield* sql`
          insert into ai_runs (
            chat_id, initiating_user_id, user_message_id, locale, market, acceptance_scope
          )
          values (
            ${secondChatId}, ${initiatingUserId}, ${secondMessageId}, 'en-US', 'US',
            ${sql.json(
              testAcceptanceScope({
                userId: initiatingUserId,
                chatId: secondChatId,
                companyId: otherCompanyId,
              }),
            )}
          )
        `;
          return failure;
        }),
      );

      expect(errorText(result)).toContain("ai_runs_active_initiating_user_key");
    },
  );

  it(
    "keeps company ownership and private-owner memory semantics immutable",
    { timeout: 60_000 },
    async () => {
      const result = await runDb(
        isolatedDatabaseUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const userId = `immutable-chat-${crypto.randomUUID()}`;
          const companyId = yield* provisionClientUser(userId);
          const otherCompanyId = crypto.randomUUID();
          const chatId = crypto.randomUUID();
          yield* sql`
          insert into client_companies (id, name)
          values (${otherCompanyId}, 'Other company')
        `;
          yield* sql`
          insert into client_company_memberships (company_id, user_id, role)
          values (${otherCompanyId}, ${userId}, 'admin')
        `;
          yield* sql`
          insert into client_company_ai_settings (company_id)
          values (${otherCompanyId})
        `;
          yield* sql`
          insert into chats (id, company_id, user_id, memory_mode)
          values (${chatId}, ${companyId}, ${userId}, 'private_owner')
        `;
          const memoryModeFailure = yield* Effect.flip(sql`
          update chats set memory_mode = 'disabled' where id = ${chatId}
        `);
          const companyFailure = yield* Effect.flip(sql`
          update chats set company_id = ${otherCompanyId} where id = ${chatId}
        `);
          return { memoryModeFailure, companyFailure };
        }),
      );

      expect(errorText(result.memoryModeFailure)).toContain(
        "a private-owner chat can never become shareable",
      );
      expect(errorText(result.companyFailure)).toContain("chat company ownership is immutable");
    },
  );

  it("removes the legacy chat-global context block table", { timeout: 60_000 }, async () => {
    const [row] = await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql<{ readonly relation: string | null }>`
          select to_regclass('public.chat_context_blocks')::text as relation
        `;
      }),
    );

    expect(row?.relation).toBeNull();
  });
  it(
    "deleting a chat preserves memory revisions and nulls their run id",
    { timeout: 60_000 },
    async () => {
      const result = await runDb(
        isolatedDatabaseUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const userId = "migration-memory-delete-user";
          const companyId = yield* provisionClientUser(userId);
          const memoryId = "dddddddd-0000-0000-0000-000000000004";
          const revisionId = "dddddddd-0000-0000-0000-000000000005";

          yield* sql`
          insert into chats (id, company_id, user_id, memory_mode)
          values ('dddddddd-0000-0000-0000-000000000001', ${companyId}, ${userId}, 'disabled')
        `;
          yield* sql`
          insert into chat_messages (id, chat_id, author, content)
          values ('dddddddd-0000-0000-0000-000000000002', 'dddddddd-0000-0000-0000-000000000001', 'user', 'Memory revision cascade test')
        `;
          yield* sql`
          insert into ai_runs (id, chat_id, user_message_id, locale, market, acceptance_scope, finished_at)
          values (
            'dddddddd-0000-0000-0000-000000000003',
            'dddddddd-0000-0000-0000-000000000001',
            'dddddddd-0000-0000-0000-000000000002',
            'fr-FR', 'FR',
            ${sql.json(
              testAcceptanceScope({
                userId,
                chatId: "dddddddd-0000-0000-0000-000000000001",
                companyId,
              }),
            )},
            now()
          )
        `;
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`
              insert into user_memories (
                id, user_id, kind, content, head_revision_id, source_message_id
              )
              values (${memoryId}, ${userId}, 'fact', 'Prefers concise briefs', ${revisionId}, 'dddddddd-0000-0000-0000-000000000002')
            `;
              yield* sql`
              insert into user_memory_revisions (
                id, memory_id, action, state_before, state_after, run_id
              )
              values (
                ${revisionId},
                ${memoryId},
                'create',
                null,
                ${sql.json({ kind: "fact", content: "Prefers concise briefs", deleted: false })},
                'dddddddd-0000-0000-0000-000000000003'
              )
            `;
            }),
          );
          const [constraint] = yield* sql<ConstraintRow>`
          select confdeltype::text as confdeltype
          from pg_constraint
          where conname = 'user_memory_revisions_run_id_fkey'
        `;
          yield* sql`
          delete from chats where id = 'dddddddd-0000-0000-0000-000000000001'
        `;
          const revisions = yield* sql<RevisionRow>`
          select run_id
          from user_memory_revisions
          where memory_id = ${memoryId}
        `;
          const [memories] = yield* sql<CountRow>`
          select count(*)::int as count
          from user_memories
          where id = ${memoryId}
        `;

          return {
            confdeltype: constraint?.confdeltype,
            revisionRunIds: revisions.map((revision) => revision.run_id),
            memoryCount: memories?.count,
          };
        }),
      );

      expect(result.confdeltype).toBe("n");
      expect(result.revisionRunIds).toEqual([null]);
      expect(result.memoryCount).toBe(1);
    },
  );

  it("enforces durable monthly plan-change snapshots, serialization, and pending-schedule shape", async () => {
    const result = await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const companyId = crypto.randomUUID();
        yield* sql`insert into client_companies (id, name) values (${companyId}, 'Billing invariant')`;
        const pendingShapeFailure = yield* Effect.flip(sql`
          insert into client_ai_billing_accounts (
            client_company_id, plan_tier, status, current_period_start, current_period_end,
            pending_downgrade_tier
          ) values (${companyId}, 'team', 'active', '2026-07-01', '2026-08-01', 'light')
        `);
        yield* sql`
          insert into client_ai_billing_accounts (
            client_company_id, plan_tier, stripe_subscription_id, stripe_price_id,
            status, current_period_start, current_period_end,
            pending_downgrade_tier, pending_downgrade_schedule_id
          ) values (
            ${companyId}, 'team', 'sub_migration_plan', 'price_team', 'active',
            '2026-07-01', '2026-08-01', 'light', 'sub_sched_migration_plan'
          )
        `;
        const missingSnapshotFailure = yield* Effect.flip(sql`
          insert into client_ai_plan_change_requests (
            client_company_id, idempotency_key, requested_by_user_id,
            authorization_request_id, authorization_session_id,
            previous_tier, target_tier, status
          ) values (
            ${companyId}, 'missing-snapshot-0001', 'billing-user',
            '90000000-0000-4000-8000-000000000011', 'migration-session',
            'team', 'intensive', 'processing'
          )
        `);
        yield* sql`
          insert into client_ai_plan_change_requests (
            client_company_id, idempotency_key, requested_by_user_id,
            authorization_request_id, authorization_session_id,
            previous_tier, target_tier, stripe_customer_id, stripe_subscription_id,
            previous_price_id, target_price_id, current_period_end, status
          ) values (
            ${companyId}, 'valid-snapshot-0001', 'billing-user',
            '90000000-0000-4000-8000-000000000012', 'migration-session', 'team', 'intensive',
            'cus_migration_plan', 'sub_migration_plan', 'price_team', 'price_intensive',
            '2026-08-01', 'processing'
          )
        `;
        const concurrentFailure = yield* Effect.flip(sql`
          insert into client_ai_plan_change_requests (
            client_company_id, idempotency_key, requested_by_user_id,
            authorization_request_id, authorization_session_id,
            previous_tier, target_tier, stripe_customer_id, stripe_subscription_id,
            previous_price_id, target_price_id, current_period_end, status
          ) values (
            ${companyId}, 'valid-snapshot-0002', 'billing-user',
            '90000000-0000-4000-8000-000000000013', 'migration-session', 'team', 'light',
            'cus_migration_plan', 'sub_migration_plan', 'price_team', 'price_light',
            '2026-08-01', 'processing'
          )
        `);
        const identityFailure = yield* Effect.flip(sql`
          update client_ai_plan_change_requests
          set previous_price_id = 'price_tampered'
          where client_company_id = ${companyId} and idempotency_key = 'valid-snapshot-0001'
        `);
        const unpaidShapeFailure = yield* Effect.flip(sql`
          update client_ai_plan_change_requests
          set status = 'succeeded', outcome = 'upgraded', effective_at = now()
          where client_company_id = ${companyId} and idempotency_key = 'valid-snapshot-0001'
        `);
        yield* sql`
          update client_ai_plan_change_requests
          set status = 'succeeded', outcome = 'upgraded', effective_at = now(),
              external_operation_id = 'in_migration_plan'
          where client_company_id = ${companyId} and idempotency_key = 'valid-snapshot-0001'
        `;
        const retentionFailure = yield* Effect.flip(sql`
          delete from client_ai_plan_change_requests
          where client_company_id = ${companyId} and idempotency_key = 'valid-snapshot-0001'
        `);
        return {
          pendingShapeFailure,
          missingSnapshotFailure,
          concurrentFailure,
          identityFailure,
          unpaidShapeFailure,
          retentionFailure,
        };
      }),
    );
    expect(errorText(result.pendingShapeFailure)).toContain(
      "client_ai_billing_accounts_pending_plan_shape",
    );
    expect(errorText(result.missingSnapshotFailure)).toContain(
      "client_ai_plan_change_requests_gateway_snapshot",
    );
    expect(errorText(result.concurrentFailure)).toContain(
      "client_ai_plan_change_requests_one_processing_company",
    );
    expect(errorText(result.identityFailure)).toContain(
      "AI plan-change request identity is immutable",
    );
    expect(errorText(result.unpaidShapeFailure)).toContain("client_ai_plan_change_requests_shape");
    expect(errorText(result.retentionFailure)).toContain(
      "billing/accounting records are retained for ten years",
    );
  });

  it("enforces durable Checkout identity, terminal replay, and accounting retention", async () => {
    const result = await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const companyId = crypto.randomUUID();
        yield* sql`insert into client_companies (id, name) values (${companyId}, 'Checkout invariant')`;
        const key = `checkout-migration-${crypto.randomUUID().slice(0, 8)}`;
        yield* sql`
          insert into client_ai_checkout_requests (
            client_company_id, idempotency_key, requested_by_user_id,
            authorization_request_id, authorization_session_id,
            authorization_mode, authorization_mfa_verified, kind, credits,
            stripe_customer_id, stripe_price_id, success_url, cancel_url,
            stripe_operation_key
          ) values (
            ${companyId}, ${key}, 'checkout-user',
            '92000000-0000-4000-8000-000000000001', 'checkout-session',
            'clerk', true, 'additional', 25,
            'cus_checkout_migration', 'price_additional',
            'https://brief.test/success', 'https://brief.test/cancel',
            ${`brief-checkout:${companyId}:${key}:session`}
          )
        `;
        yield* sql`
          update client_ai_checkout_requests
          set status = 'succeeded', stripe_checkout_session_id = 'cs_checkout_migration',
              checkout_url = 'https://checkout.stripe.test/session'
          where client_company_id = ${companyId} and idempotency_key = ${key}
        `;
        const outputFailure = yield* Effect.flip(sql`
          update client_ai_checkout_requests
          set checkout_url = 'https://checkout.stripe.test/tampered'
          where client_company_id = ${companyId} and idempotency_key = ${key}
        `);
        const identityFailure = yield* Effect.flip(sql`
          update client_ai_checkout_requests
          set credits = 30
          where client_company_id = ${companyId} and idempotency_key = ${key}
        `);
        const leaseFailure = yield* Effect.flip(sql`
          update client_ai_checkout_requests
          set attempts = attempts + 1, lease_token = gen_random_uuid()
          where client_company_id = ${companyId} and idempotency_key = ${key}
        `);
        const retentionFailure = yield* Effect.flip(sql`
          delete from client_ai_checkout_requests
          where client_company_id = ${companyId} and idempotency_key = ${key}
        `);
        return { outputFailure, identityFailure, leaseFailure, retentionFailure };
      }),
    );
    expect(errorText(result.outputFailure)).toContain(
      "succeeded AI Checkout requests are terminal",
    );
    expect(errorText(result.identityFailure)).toContain(
      "AI Checkout request identity is immutable",
    );
    expect(errorText(result.leaseFailure)).toContain("succeeded AI Checkout requests are terminal");
    expect(errorText(result.retentionFailure)).toContain(
      "billing/accounting records are retained for ten years",
    );
  });

  it("enforces exact authorization-audit outcome and denial-reason shape", async () => {
    const result = await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const deniedWithoutReason = yield* Effect.flip(sql`
          insert into platform_authorization_audit_log (
            actor_user_id, session_id, request_id, action, scope_kind, scope_id,
            outcome, reason_code
          ) values (
            'audit-user', 'audit-session', '91000000-0000-4000-8000-000000000001',
            'audit.test.denied', 'client_company', 'scope-1', 'denied', null
          )
        `);
        const successWithReason = yield* Effect.flip(sql`
          insert into platform_authorization_audit_log (
            actor_user_id, session_id, request_id, action, scope_kind, scope_id,
            outcome, reason_code
          ) values (
            'audit-user', 'audit-session', '91000000-0000-4000-8000-000000000002',
            'audit.test.succeeded', 'client_company', 'scope-1', 'succeeded', 'unexpected_reason'
          )
        `);
        yield* sql`
          insert into platform_authorization_audit_log (
            actor_user_id, session_id, request_id, action, scope_kind, scope_id,
            outcome, reason_code
          ) values
            (
              'audit-user', 'audit-session', '91000000-0000-4000-8000-000000000003',
              'audit.test.succeeded', 'client_company', 'scope-1', 'succeeded', null
            ),
            (
              'audit-user', 'audit-session', '91000000-0000-4000-8000-000000000004',
              'audit.test.denied', 'client_company', 'scope-1', 'denied', 'mfa_required'
            )
        `;
        const count = (yield* sql<CountRow>`
            select count(*)::int as count
            from platform_authorization_audit_log
            where request_id in (
              '91000000-0000-4000-8000-000000000003',
              '91000000-0000-4000-8000-000000000004'
            )
          `)[0]!.count;
        return { deniedWithoutReason, successWithReason, count };
      }),
    );
    expect(errorText(result.deniedWithoutReason)).toContain(
      "platform_authorization_audit_outcome_reason_shape",
    );
    expect(errorText(result.successWithReason)).toContain(
      "platform_authorization_audit_outcome_reason_shape",
    );
    expect(result.count).toBe(2);
  });

  it("makes every publisher-authored field of published issues and documents immutable", async () => {
    const result = await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const publisherCompanyId = crypto.randomUUID();
        const subscriptionId = crypto.randomUUID();
        const otherSubscriptionId = crypto.randomUUID();
        const issueId = crypto.randomUUID();
        const otherIssueId = crypto.randomUUID();
        const documentId = crypto.randomUUID();
        yield* sql`
          insert into publisher_companies (id, name)
          values (${publisherCompanyId}, 'Published immutability publisher')
        `;
        yield* sql`
          insert into publisher_subscriptions (
            id, publisher_company_id, name, created_by_user_id
          ) values
            (${subscriptionId}, ${publisherCompanyId}, 'Immutable subscription', 'publisher-user'),
            (${otherSubscriptionId}, ${publisherCompanyId}, 'Other subscription', 'publisher-user')
        `;
        yield* sql`
          insert into publisher_issues (
            id, subscription_id, title, status, publication_at, published_at,
            historical, created_by_user_id
          ) values
            (
              ${issueId}, ${subscriptionId}, 'Immutable issue', 'draft',
              now() - interval '1 day', null, false, 'publisher-user'
            ),
            (
              ${otherIssueId}, ${otherSubscriptionId}, 'Other issue', 'draft',
              now() - interval '2 days', null, false, 'publisher-user'
            )
        `;
        yield* sql`
          insert into brief_documents (
            id, issue_id, title, original_file_name, object_key, media_type,
            byte_size, sha256_hex, upload_completed_at, language, created_by_user_id
          ) values (
            ${documentId}, ${issueId}, 'Immutable document', 'immutable.pdf',
            'publisher/immutable.pdf', 'application/pdf', 128,
            ${"a".repeat(64)}, now() - interval '1 day', 'fr-FR', 'publisher-user'
          )
        `;
        yield* sql`
          update publisher_issues set status = 'published' where id = ${issueId}
        `;

        const issueFailures = [
          yield* Effect.flip(
            sql`update publisher_issues set subscription_id = ${otherSubscriptionId} where id = ${issueId}`,
          ),
          yield* Effect.flip(
            sql`update publisher_issues set title = 'Rewritten issue' where id = ${issueId}`,
          ),
          yield* Effect.flip(
            sql`update publisher_issues set status = 'draft' where id = ${issueId}`,
          ),
          yield* Effect.flip(
            sql`update publisher_issues set publication_at = publication_at - interval '1 day' where id = ${issueId}`,
          ),
          yield* Effect.flip(
            sql`update publisher_issues set published_at = published_at - interval '1 day' where id = ${issueId}`,
          ),
          yield* Effect.flip(
            sql`update publisher_issues set historical = true where id = ${issueId}`,
          ),
          yield* Effect.flip(
            sql`update publisher_issues set created_by_user_id = 'rewritten-user' where id = ${issueId}`,
          ),
          yield* Effect.flip(
            sql`update publisher_issues set created_at = created_at - interval '1 day' where id = ${issueId}`,
          ),
          yield* Effect.flip(sql`delete from publisher_issues where id = ${issueId}`),
        ];

        const documentFailures = [
          yield* Effect.flip(
            sql`update brief_documents set issue_id = ${otherIssueId} where id = ${documentId}`,
          ),
          yield* Effect.flip(
            sql`update brief_documents set title = 'Rewritten document' where id = ${documentId}`,
          ),
          yield* Effect.flip(
            sql`update brief_documents set original_file_name = 'rewritten.pdf' where id = ${documentId}`,
          ),
          yield* Effect.flip(
            sql`update brief_documents set object_key = 'publisher/rewritten.pdf' where id = ${documentId}`,
          ),
          yield* Effect.flip(
            sql`update brief_documents set media_type = 'text/plain' where id = ${documentId}`,
          ),
          yield* Effect.flip(
            sql`update brief_documents set byte_size = 256 where id = ${documentId}`,
          ),
          yield* Effect.flip(
            sql`update brief_documents set sha256_hex = ${"b".repeat(64)} where id = ${documentId}`,
          ),
          yield* Effect.flip(
            sql`update brief_documents set upload_completed_at = upload_completed_at + interval '1 second' where id = ${documentId}`,
          ),
          yield* Effect.flip(
            sql`update brief_documents set language = 'en-US' where id = ${documentId}`,
          ),
          yield* Effect.flip(
            sql`update brief_documents set deleted_at = now() where id = ${documentId}`,
          ),
          yield* Effect.flip(
            sql`update brief_documents set deleted_by_user_id = 'rewritten-user' where id = ${documentId}`,
          ),
          yield* Effect.flip(
            sql`update brief_documents set purge_after = now() + interval '30 days' where id = ${documentId}`,
          ),
          yield* Effect.flip(
            sql`update brief_documents set created_by_user_id = 'rewritten-user' where id = ${documentId}`,
          ),
          yield* Effect.flip(
            sql`update brief_documents set created_at = created_at - interval '1 day' where id = ${documentId}`,
          ),
          yield* Effect.flip(sql`delete from brief_documents where id = ${documentId}`),
        ];

        yield* sql`
          update publisher_issues
          set indexing_status = 'failed', indexing_error_code = 'extract_failed',
              restricted_at = now(), restricted_by_user_id = 'security-user',
              restricted_reason = 'security review', updated_at = now()
          where id = ${issueId}
        `;
        yield* sql`
          update brief_documents
          set indexing_error_code = 'extract_failed', legal_hold = true, updated_at = now()
          where id = ${documentId}
        `;
        const operational = (yield* sql<{
          readonly issueFailed: boolean;
          readonly issueRestricted: boolean;
          readonly documentFailed: boolean;
          readonly documentHeld: boolean;
        }>`
            select
              (select indexing_status = 'failed' from publisher_issues where id = ${issueId})
                as "issueFailed",
              (select restricted_at is not null from publisher_issues where id = ${issueId})
                as "issueRestricted",
              (select indexing_error_code = 'extract_failed' from brief_documents where id = ${documentId})
                as "documentFailed",
              (select legal_hold from brief_documents where id = ${documentId})
                as "documentHeld"
          `)[0]!;
        return { issueFailures, documentFailures, operational };
      }),
    );
    expect(result.issueFailures).toHaveLength(9);
    for (const failure of result.issueFailures) {
      expect(errorText(failure)).toMatch(/published issues (are immutable|cannot be deleted)/);
    }
    expect(result.documentFailures).toHaveLength(15);
    for (const failure of result.documentFailures) {
      expect(errorText(failure)).toContain("published brief documents are immutable");
    }
    expect(result.operational).toEqual({
      issueFailed: true,
      issueRestricted: true,
      documentFailed: true,
      documentHeld: true,
    });
  });

  it("rejects every malformed required export identity-array shape", async () => {
    const requesterUserId = "malformed-export-snapshot-user";
    const baseSnapshot: Record<string, unknown> = {
      version: 1,
      authorizedAt: new Date().toISOString(),
      requesterUserId,
      scopeKind: "user_chats",
      scopeId: "me",
      role: "self",
      clientCompanyIds: [],
      accessIds: [],
      issueIds: [],
      documentIds: [],
      chatIds: [],
      chatMessageIds: [],
    };
    const { chatMessageIds: _omitted, ...missingChatMessageIds } = baseSnapshot;
    const malformedSnapshots: readonly Record<string, unknown>[] = [
      missingChatMessageIds,
      { ...baseSnapshot, clientCompanyIds: "not-an-array" },
      { ...baseSnapshot, accessIds: [1] },
      { ...baseSnapshot, issueIds: [null] },
      { ...baseSnapshot, documentIds: [{ id: crypto.randomUUID() }] },
      { ...baseSnapshot, chatIds: [""] },
      { ...baseSnapshot, chatMessageIds: ["   "] },
    ];

    for (const snapshot of malformedSnapshots) {
      const failure = await runDb(
        isolatedDatabaseUrl(),
        Effect.flip(
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            const exportId = crypto.randomUUID();
            yield* sql`
              insert into export_requests (
                id, requester_user_id, scope_kind, scope_id,
                authorization_snapshot, idempotency_key
              ) values (
                ${exportId}, ${requesterUserId}, 'user_chats', 'me',
                ${sql.json(snapshot)}, ${`malformed-export-snapshot-${exportId}`}
              )
            `;
          }),
        ),
      );
      expect(errorText(failure)).toContain(
        "export authorization snapshot requires explicit identity arrays containing only nonempty strings",
      );
    }
  });

  it("rejects every missing or malformed export snapshot envelope identity", async () => {
    const requesterUserId = "malformed-export-envelope-user";
    const baseSnapshot: Record<string, unknown> = {
      version: 1,
      authorizedAt: new Date().toISOString(),
      requesterUserId,
      scopeKind: "user_chats",
      scopeId: "me",
      role: "self",
      clientCompanyIds: [],
      accessIds: [],
      issueIds: [],
      documentIds: [],
      chatIds: [],
      chatMessageIds: [],
    };
    const without = (key: string): Record<string, unknown> => {
      const snapshot = { ...baseSnapshot };
      delete snapshot[key];
      return snapshot;
    };
    const malformedSnapshots: readonly {
      readonly snapshot: Record<string, unknown>;
      readonly expectedError: string;
    }[] = [
      {
        snapshot: without("version"),
        expectedError:
          "export authorization snapshot requires version 1, a valid authorization time, and a nonempty role",
      },
      {
        snapshot: { ...baseSnapshot, version: "1" },
        expectedError:
          "export authorization snapshot requires version 1, a valid authorization time, and a nonempty role",
      },
      {
        snapshot: without("authorizedAt"),
        expectedError:
          "export authorization snapshot requires version 1, a valid authorization time, and a nonempty role",
      },
      {
        snapshot: { ...baseSnapshot, authorizedAt: "not-a-timestamp" },
        expectedError:
          "export authorization snapshot requires version 1, a valid authorization time, and a nonempty role",
      },
      {
        snapshot: without("role"),
        expectedError:
          "export authorization snapshot requires version 1, a valid authorization time, and a nonempty role",
      },
      {
        snapshot: { ...baseSnapshot, role: "   " },
        expectedError:
          "export authorization snapshot requires version 1, a valid authorization time, and a nonempty role",
      },
      {
        snapshot: without("requesterUserId"),
        expectedError: "export authorization snapshot identity does not match request",
      },
      {
        snapshot: { ...baseSnapshot, requesterUserId: { id: requesterUserId } },
        expectedError: "export authorization snapshot identity does not match request",
      },
      {
        snapshot: without("scopeKind"),
        expectedError: "export authorization snapshot identity does not match request",
      },
      {
        snapshot: { ...baseSnapshot, scopeKind: ["user_chats"] },
        expectedError: "export authorization snapshot identity does not match request",
      },
      {
        snapshot: without("scopeId"),
        expectedError: "export authorization snapshot identity does not match request",
      },
      {
        snapshot: { ...baseSnapshot, scopeId: { value: "me" } },
        expectedError: "export authorization snapshot identity does not match request",
      },
    ];

    for (const malformed of malformedSnapshots) {
      const failure = await runDb(
        isolatedDatabaseUrl(),
        Effect.flip(
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            const exportId = crypto.randomUUID();
            yield* sql`
              insert into export_requests (
                id, requester_user_id, scope_kind, scope_id,
                authorization_snapshot, idempotency_key
              ) values (
                ${exportId}, ${requesterUserId}, 'user_chats', 'me',
                ${sql.json(malformed.snapshot)},
                ${`malformed-export-envelope-${exportId}`}
              )
            `;
          }),
        ),
      );
      expect(errorText(failure)).toContain(malformed.expectedError);
    }
  });

  it("keeps every attempted export object discoverable until certified physical deletion", async () => {
    const result = await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const exportId = crypto.randomUUID();
        const objectKey = `exports/${exportId}/attempt-1.tar`;
        const clientCompanyId = crypto.randomUUID();
        const issueId = crypto.randomUUID();
        const chatId = crypto.randomUUID();
        const snapshot = {
          version: 1,
          authorizedAt: new Date().toISOString(),
          requesterUserId: "export-intent-user",
          scopeKind: "user_chats",
          scopeId: "me",
          role: "self",
          clientCompanyIds: [clientCompanyId],
          accessIds: [],
          issueIds: [issueId],
          documentIds: [],
          chatIds: [chatId],
          chatMessageIds: [],
        };
        yield* sql`
          insert into export_requests (
            id, requester_user_id, scope_kind, scope_id,
            authorization_snapshot, idempotency_key
          ) values (
            ${exportId}, 'export-intent-user', 'user_chats', 'me',
            ${sql.json(snapshot)}, ${`export-intent-${exportId}`}
          )
        `;
        const scopeRewriteFailure = yield* Effect.exit(sql`
          update export_requests
          set authorization_snapshot = ${sql.json({ ...snapshot, chatIds: [] })}
          where id = ${exportId}
        `);
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              insert into export_object_generations (
                export_request_id, generation, object_key, purge_after,
                next_delete_attempt_at
              ) values (
                ${exportId}, 1, ${objectKey}, now() + interval '1 hour',
                now() + interval '1 hour'
              )
            `;
            yield* sql`
              update export_requests
              set status = 'running', object_generation = 1
              where id = ${exportId}
            `;
          }),
        );
        const rewriteFailure = yield* Effect.exit(sql`
          update export_object_generations
          set object_key = 'exports/rewritten.tar'
          where export_request_id = ${exportId} and generation = 1
        `);
        const missingGenerationFailure = yield* Effect.exit(sql`
          update export_requests set object_generation = 2 where id = ${exportId}
        `);
        yield* sql`
          update export_object_generations
          set writer_state = 'in_flight', expected_sha256 = ${"a".repeat(64)},
              byte_size = 10, writer_started_at = now()
          where export_request_id = ${exportId} and generation = 1
        `;
        yield* sql`
          update export_object_generations
          set writer_state = 'unknown', purge_after = now() - interval '1 second',
              next_delete_attempt_at = now() - interval '1 second'
          where export_request_id = ${exportId} and generation = 1
        `;
        yield* sql`
          update export_requests
          set status = 'failed', completed_at = now(),
              error_code = 'export_generation_failed'
          where id = ${exportId}
        `;
        const earlyDeletionFailure = yield* Effect.exit(sql`
          update export_object_generations set delete_fenced_at = now()
          where export_request_id = ${exportId} and generation = 1
        `);
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`select set_config('brief.allow_export_object_purge', 'on', true)`;
            yield* sql`
              update export_object_generations set delete_fenced_at = now()
              where export_request_id = ${exportId} and generation = 1
            `;
          }),
        );
        const ambiguousDeletionFailure = yield* Effect.exit(
          sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`select set_config('brief.allow_export_object_purge', 'on', true)`;
              yield* sql`
              update export_object_generations set deleted_at = now()
              where export_request_id = ${exportId} and generation = 1
              `;
            }),
          ),
        );
        const historyDeletionFailure = yield* Effect.exit(sql`
          delete from export_object_generations
          where export_request_id = ${exportId} and generation = 1
        `);
        const state = (yield* sql<{
          readonly status: string;
          readonly requestObjectKey: string | null;
          readonly generationObjectKey: string;
          readonly writerState: string;
          readonly fenced: boolean;
          readonly deleted: boolean;
          readonly holdScopeKeys: string[];
          readonly chatMessageIds: string[];
        }>`
            select requests.status, requests.object_key as "requestObjectKey",
                   generation.object_key as "generationObjectKey",
                   generation.writer_state as "writerState",
                   generation.delete_fenced_at is not null as fenced,
                   generation.deleted_at is not null as deleted,
                   requests.hold_scope_keys as "holdScopeKeys",
                   array(
                     select jsonb_array_elements_text(
                       requests.authorization_snapshot->'chatMessageIds'
                     )
                   ) as "chatMessageIds"
            from export_requests requests
            join export_object_generations generation
              on generation.export_request_id = requests.id
             and generation.generation = requests.object_generation
            where requests.id = ${exportId}
          `)[0]!;
        return {
          scopeRewriteFailure,
          rewriteFailure,
          missingGenerationFailure,
          earlyDeletionFailure,
          ambiguousDeletionFailure,
          historyDeletionFailure,
          state,
          expectedHoldScopeKeys: [
            `chat:${chatId}`,
            `client_company:${clientCompanyId}`,
            `issue:${issueId}`,
            "user:export-intent-user",
          ].sort(),
        };
      }),
    ).catch((error) => {
      throw new Error(errorText(error));
    });
    expect(errorText(result.scopeRewriteFailure)).toContain(
      "export request authorization identity and hold scopes are immutable",
    );
    expect(errorText(result.rewriteFailure)).toContain(
      "export object generation identity is immutable",
    );
    expect(errorText(result.missingGenerationFailure)).toContain(
      "export request object generation must reference durable history",
    );
    expect(errorText(result.earlyDeletionFailure)).toContain(
      "export object delete fence requires expired GC context",
    );
    expect(errorText(result.ambiguousDeletionFailure)).toContain(
      "ambiguous export object writer cannot be certified deleted",
    );
    expect(errorText(result.historyDeletionFailure)).toContain(
      "export object generation history is append-only",
    );
    expect(result.state).toMatchObject({
      status: "failed",
      requestObjectKey: null,
      writerState: "unknown",
      fenced: true,
      deleted: false,
      chatMessageIds: [],
    });
    expect(result.state.generationObjectKey).toMatch(/^exports\/[0-9a-f-]{36}\/attempt-1\.tar$/u);
    expect(result.state.holdScopeKeys).toEqual(result.expectedHoldScopeKeys);
  });

  it("rejects forged export generations, atomic authority shortcuts, and false GC evidence", async () => {
    const ids = await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const insertId = crypto.randomUUID();
        const legacyId = crypto.randomUUID();
        const atomicId = crypto.randomUUID();
        const deletionId = crypto.randomUUID();
        const snapshot = {
          version: 1,
          authorizedAt: new Date().toISOString(),
          requesterUserId: "export-forgery-user",
          scopeKind: "user_chats",
          scopeId: "me",
          role: "self",
          clientCompanyIds: [],
          accessIds: [],
          issueIds: [],
          documentIds: [],
          chatIds: [],
          chatMessageIds: [],
        };
        yield* sql`
          insert into export_requests (
            id, requester_user_id, scope_kind, scope_id,
            authorization_snapshot, idempotency_key
          ) values
            (${insertId}, 'export-forgery-user', 'user_chats', 'me', ${sql.json(snapshot)}, ${`export-forgery-insert-${insertId}`}),
            (${legacyId}, 'export-forgery-user', 'user_chats', 'me', ${sql.json(snapshot)}, ${`export-forgery-legacy-${legacyId}`}),
            (${atomicId}, 'export-forgery-user', 'user_chats', 'me', ${sql.json(snapshot)}, ${`export-forgery-atomic-${atomicId}`}),
            (${deletionId}, 'export-forgery-user', 'user_chats', 'me', ${sql.json(snapshot)}, ${`export-forgery-deletion-${deletionId}`})
        `;

        const terminalInsert = yield* Effect.exit(sql`
          insert into export_object_generations (
            export_request_id, generation, object_key, writer_state,
            expected_sha256, byte_size, writer_started_at, writer_succeeded_at,
            delete_fenced_at, deleted_at, delete_attempts, purge_after,
            next_delete_attempt_at
          ) values (
            ${insertId}, 1, ${`exports/${insertId}/attempt-1.tar`}, 'succeeded',
            ${"a".repeat(64)}, 1, now(), now(), now(), now(), 1,
            now() + interval '1 hour', now() + interval '1 hour'
          )
        `);
        const generationZeroInsert = yield* Effect.exit(sql`
          insert into export_object_generations (
            export_request_id, generation, object_key, writer_state,
            expected_sha256, byte_size, writer_started_at, writer_succeeded_at,
            promoted_at, purge_after, next_delete_attempt_at
          ) values (
            ${legacyId}, 0, ${`exports/${legacyId}.tar`}, 'succeeded',
            ${"b".repeat(64)}, 1, now(), now(), now(),
            now() + interval '1 hour', now() + interval '1 hour'
          )
        `);

        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              insert into export_object_generations (
                export_request_id, generation, object_key, purge_after,
                next_delete_attempt_at
              ) values (
                ${atomicId}, 1, ${`exports/${atomicId}/attempt-1.tar`},
                now() + interval '1 hour', now() + interval '1 hour'
              )
            `;
            yield* sql`
              update export_requests set status = 'running', object_generation = 1
              where id = ${atomicId}
            `;
          }),
        );
        yield* sql`
          update export_object_generations
          set writer_state = 'in_flight', expected_sha256 = ${"c".repeat(64)},
              byte_size = 1, writer_started_at = now(),
              purge_after = now() - interval '1 second',
              next_delete_attempt_at = now() - interval '1 second'
          where export_request_id = ${atomicId} and generation = 1
        `;
        const atomicAuthority = yield* Effect.exit(
          sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`select set_config('brief.allow_export_object_purge', 'on', true)`;
              yield* sql`
                update export_object_generations
                set writer_state = 'succeeded', writer_succeeded_at = now(),
                    promoted_at = now(), delete_fenced_at = now()
                where export_request_id = ${atomicId} and generation = 1
              `;
            }),
          ),
        );
        yield* sql`
          update export_object_generations set writer_state = 'unknown'
          where export_request_id = ${atomicId} and generation = 1
        `;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`select set_config('brief.allow_export_object_purge', 'on', true)`;
            yield* sql`
              update export_object_generations set delete_fenced_at = now()
              where export_request_id = ${atomicId} and generation = 1
            `;
          }),
        );
        const forgedRetry = yield* Effect.exit(
          sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`select set_config('brief.allow_export_object_purge', 'on', true)`;
              yield* sql`
                update export_object_generations
                set delete_attempts = delete_attempts + 1,
                    next_delete_attempt_at = now() + interval '1 year'
                where export_request_id = ${atomicId} and generation = 1
              `;
            }),
          ),
        );

        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              insert into export_object_generations (
                export_request_id, generation, object_key, purge_after,
                next_delete_attempt_at
              ) values (
                ${deletionId}, 1, ${`exports/${deletionId}/attempt-1.tar`},
                now() + interval '1 millisecond', now() + interval '1 millisecond'
              )
            `;
            yield* sql`
              update export_requests set status = 'running', object_generation = 1
              where id = ${deletionId}
            `;
            yield* sql`
              update export_object_generations
              set writer_state = 'in_flight', expected_sha256 = ${"d".repeat(64)},
                  byte_size = 1, writer_started_at = now()
              where export_request_id = ${deletionId} and generation = 1
            `;
            yield* sql`
              update export_object_generations
              set writer_state = 'succeeded', writer_succeeded_at = now()
              where export_request_id = ${deletionId} and generation = 1
            `;
            yield* sql`
              update export_object_generations set promoted_at = now()
              where export_request_id = ${deletionId} and generation = 1
            `;
            yield* sql`
              update export_requests
              set status = 'completed', object_key = ${`exports/${deletionId}/attempt-1.tar`},
                  completed_at = now(), expires_at = now() + interval '1 millisecond',
                  object_purge_after = now() + interval '1 millisecond'
              where id = ${deletionId}
            `;
          }),
        );
        return {
          deletionId,
          terminalInsert,
          generationZeroInsert,
          atomicAuthority,
          forgedRetry,
        };
      }),
    );
    for (const failure of [
      ids.terminalInsert,
      ids.generationZeroInsert,
      ids.atomicAuthority,
      ids.forgedRetry,
    ]) {
      expect(failure._tag).toBe("Failure");
    }

    await Bun.sleep(5);
    const certification = await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`select set_config('brief.allow_export_object_purge', 'on', true)`;
            yield* sql`
              update export_object_generations set delete_fenced_at = now()
              where export_request_id = ${ids.deletionId} and generation = 1
            `;
          }),
        );
        const falseDeletion = yield* Effect.exit(
          sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`select set_config('brief.allow_export_object_purge', 'on', true)`;
              yield* sql`
                update export_requests set object_deleted_at = now()
                where id = ${ids.deletionId}
              `;
            }),
          ),
        );
        const deadlineRewrite = yield* Effect.exit(sql`
          update export_requests
          set expires_at = expires_at + interval '1 day',
              object_purge_after = object_purge_after + interval '1 day'
          where id = ${ids.deletionId}
        `);
        return { falseDeletion, deadlineRewrite };
      }),
    );
    expect(certification.falseDeletion._tag).toBe("Failure");
    expect(certification.deadlineRewrite._tag).toBe("Failure");
  });

  it("counts only live identities for client and publisher last-admin invariants", async () => {
    const result = await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const activeUserId = `live-admin-${crypto.randomUUID()}`;
        const deletedUserId = `deleted-admin-${crypto.randomUUID()}`;
        const clientCompanyId = crypto.randomUUID();
        const publisherCompanyId = crypto.randomUUID();
        yield* sql`
          insert into platform_users (
            id, primary_email, display_name, clerk_user_id,
            recovery_deleted_at, purge_after
          ) values
            (
              ${activeUserId}, ${`${activeUserId}@example.test`}, 'Live Admin',
              ${`clerk-${activeUserId}`}, null, null
            ),
            (
              ${deletedUserId}, ${`${deletedUserId}@example.test`}, 'Deleted Admin',
              ${`clerk-${deletedUserId}`}, now() - interval '181 days', now()
            )
        `;
        yield* sql`insert into client_companies (id, name) values (${clientCompanyId}, 'Live admin client')`;
        yield* sql`insert into publisher_companies (id, name) values (${publisherCompanyId}, 'Live admin publisher')`;
        yield* sql`
          insert into client_company_memberships (company_id, user_id, role)
          values
            (${clientCompanyId}, ${activeUserId}, 'admin'),
            (${clientCompanyId}, ${deletedUserId}, 'admin')
        `;
        yield* sql`
          insert into publisher_company_memberships (
            publisher_company_id, user_id, role, accepted_at
          ) values
            (${publisherCompanyId}, ${activeUserId}, 'admin', now()),
            (${publisherCompanyId}, ${deletedUserId}, 'admin', now())
        `;
        const clientFailure = yield* Effect.flip(sql`
          update client_company_memberships
          set revoked_at = now(), revoked_by_user_id = ${deletedUserId}
          where company_id = ${clientCompanyId} and user_id = ${activeUserId}
        `);
        const publisherFailure = yield* Effect.flip(sql`
          delete from publisher_company_memberships
          where publisher_company_id = ${publisherCompanyId} and user_id = ${activeUserId}
        `);
        yield* sql`
          update platform_users
          set recovery_deleted_at = null, purge_after = null
          where id = ${deletedUserId}
        `;
        yield* sql`
          update client_company_memberships
          set revoked_at = now(), revoked_by_user_id = ${deletedUserId}
          where company_id = ${clientCompanyId} and user_id = ${activeUserId}
        `;
        const retainedDeleteFailure = yield* Effect.flip(sql`
          delete from client_company_memberships
          where company_id = ${clientCompanyId} and user_id = ${activeUserId}
        `);
        yield* sql`
          delete from publisher_company_memberships
          where publisher_company_id = ${publisherCompanyId} and user_id = ${activeUserId}
        `;
        const counts = (yield* sql<{
          readonly clientActive: number;
          readonly clientRetained: number;
          readonly publisher: number;
        }>`
            select
              (select count(*)::int from client_company_memberships
                where company_id = ${clientCompanyId} and revoked_at is null) "clientActive",
              (select count(*)::int from client_company_memberships
                where company_id = ${clientCompanyId}) "clientRetained",
              (select count(*)::int from publisher_company_memberships
                where publisher_company_id = ${publisherCompanyId}) publisher
          `)[0]!;
        return { clientFailure, publisherFailure, retainedDeleteFailure, counts };
      }),
    );
    expect(errorText(result.clientFailure)).toContain(
      "each client company must retain at least one live admin",
    );
    expect(errorText(result.publisherFailure)).toContain(
      "each publisher company must retain at least one live admin",
    );
    expect(errorText(result.retainedDeleteFailure)).toContain(
      "client membership identity is retained; revoke it instead",
    );
    expect(result.counts).toEqual({ clientActive: 1, clientRetained: 2, publisher: 1 });
  });

  it(
    "keeps evaluation runtime evidence append-only while ordinary evidence remains mutable",
    { timeout: 60_000 },
    async () => {
      const result = await runDb(
        isolatedDatabaseUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const evaluationUserId = `evaluation-evidence-${crypto.randomUUID()}`;
          const ordinaryUserId = `ordinary-evidence-${crypto.randomUUID()}`;
          const evaluationCompanyId = yield* provisionClientUser(evaluationUserId);
          const ordinaryCompanyId = yield* provisionClientUser(ordinaryUserId);
          const evaluationChatId = crypto.randomUUID();
          const ordinaryChatId = crypto.randomUUID();
          const evaluationMessageId = crypto.randomUUID();
          const ordinaryMessageId = crypto.randomUUID();
          const evaluationRunId = crypto.randomUUID();
          const ordinaryRunId = crypto.randomUUID();
          const evaluationSessionId = crypto.randomUUID();
          const publicSourceId = `evaluation-evidence-source-${crypto.randomUUID()}`;
          const publicDocumentId = `evaluation-evidence-document-${crypto.randomUUID()}`;
          const publicArtifactId = crypto.randomUUID();
          const publicText = "Exact evaluation 😀 evidence. ".repeat(10);
          const publicHash = createHash("sha256").update(publicText).digest("hex");

          yield* sql`
            insert into chats (id, company_id, user_id, memory_mode)
            values
              (${evaluationChatId}, ${evaluationCompanyId}, ${evaluationUserId}, 'disabled'),
              (${ordinaryChatId}, ${ordinaryCompanyId}, ${ordinaryUserId}, 'disabled')
          `;
          yield* sql`
            insert into chat_messages (id, chat_id, author, content)
            values
              (${evaluationMessageId}, ${evaluationChatId}, 'user', 'evaluation evidence'),
              (${ordinaryMessageId}, ${ordinaryChatId}, 'user', 'ordinary evidence')
          `;
          yield* sql`
            insert into ai_runs (
              id, chat_id, user_message_id, locale, market, acceptance_scope, finished_at
            )
            values
              (
                ${evaluationRunId}, ${evaluationChatId}, ${evaluationMessageId}, 'en-US', 'US',
                ${sql.json(
                  testAcceptanceScope({
                    userId: evaluationUserId,
                    chatId: evaluationChatId,
                    companyId: evaluationCompanyId,
                  }),
                )}, now()
              ),
              (
                ${ordinaryRunId}, ${ordinaryChatId}, ${ordinaryMessageId}, 'en-US', 'US',
                ${sql.json(
                  testAcceptanceScope({
                    userId: ordinaryUserId,
                    chatId: ordinaryChatId,
                    companyId: ordinaryCompanyId,
                  }),
                )}, now()
              )
          `;
          yield* sql`
            insert into ai_evaluation_sessions (
              id, artifact_version, golden_set_version, fixture_sha256_hex, status
            ) values (${evaluationSessionId}, 3, 3, ${"a".repeat(64)}, 'preparing')
          `;
          yield* sql`
            insert into ai_evaluation_case_runs (
              session_id, case_id, topology, ai_run_id, seed_manifest, status
            ) values (
              ${evaluationSessionId}, 'append-only-case', 'specialized',
              ${evaluationRunId}, '{}'::jsonb, 'seeded'
            )
          `;
          yield* sql`
            insert into public_sources (
              source_id, display_name, publisher_name, description,
              ingestion_method, discovery_url, average_chars_per_item
            ) values (
              ${publicSourceId}, 'Evaluation evidence source', 'Evaluation publisher',
              'Exact document exposure fixture', 'manual',
              ${`https://evaluation-evidence.example/${publicDocumentId}`}, 100
            )
          `;
          yield* sql`
            insert into public_source_raw_artifacts (
              id, source_id, canonical_url, fetched_at, media_type, body, body_hash
            ) values (
              ${publicArtifactId}, ${publicSourceId},
              ${`https://evaluation-evidence.example/${publicDocumentId}`},
              now(), 'text/html', ${publicText}, ${publicHash}
            )
          `;
          yield* sql`
            insert into public_source_documents (
              document_id, source_id, raw_artifact_id, canonical_url, title, text,
              language, discovered_at, fetched_at, document_type, content_hash, text_char_count
            ) values (
              ${publicDocumentId}, ${publicSourceId}, ${publicArtifactId},
              ${`https://evaluation-evidence.example/${publicDocumentId}`},
              'Evaluation evidence', ${publicText}, 'en-US', now(), now(), 'article',
              ${publicHash}, ${publicText.length}
            )
          `;

          for (const [runId, chatId, suffix] of [
            [evaluationRunId, evaluationChatId, "evaluation"],
            [ordinaryRunId, ordinaryChatId, "ordinary"],
          ] as const) {
            yield* sql`
              insert into ai_observations (
                run_id, chat_id, emitting_task, loop_iteration, attempt,
                observation_key, kind, payload
              ) values (
                ${runId}, ${chatId}, 'evidence-task', 0, 0,
                ${`evidence:${suffix}`}, 'citation', '{}'::jsonb
              )
            `;
            yield* sql`
              insert into ai_source_exposures (
                run_id, task_id, loop_iteration, attempt, provider_request_index,
                source_kind, logical_source_identity, content_item_identity,
                exposure_stage, visible_token_count
              ) values (
                ${runId}, 'evidence-task', 0, 0, 0,
                'memory', 'memory:doc-1', 'revision-1',
                'memory_tool_result', 1
              )
            `;
            yield* sql`
              insert into ai_run_usage (
                run_id, task_id, loop_iteration, attempt, provider_request_index,
                agent_role, model_id, provider_service_id, input_tokens, output_tokens,
                cached_tokens, reasoning_tokens, total_tokens, stop_reason
              ) values (
                ${runId}, 'evidence-task', 0, 0, 0,
                'internal_retrieval', 'glm-5-turbo', 'deterministic_test',
                1, 1, 0, 0, 2, 'toolUse'
              )
            `;
            yield* sql`
              insert into ai_external_tool_usage (
                run_id, task_id, loop_iteration, attempt, tool_request_index,
                provider_service_id, operation, status, result_count,
                response_bytes, duration_ms
              ) values (
                ${runId}, 'evidence-task', 0, 0, 0,
                'deterministic_test', 'web_search', 'ok', 1, 10, 1
              )
            `;
          }

          yield* sql`
            insert into ai_source_exposures (
              run_id, task_id, loop_iteration, attempt, provider_request_index,
              source_kind, logical_source_identity, content_item_identity,
              exposure_stage, visible_token_count,
              document_source_id, document_id, version_id,
              content_hash, document_ranges
            ) values (
              ${evaluationRunId}, 'reconstructable-inspection', 0, 0, 0,
              'document', ${`public:${publicSourceId}`},
              ${`${publicDocumentId}:range-a`},
              'internal_inspection', 3,
              ${`public:${publicSourceId}`}, ${publicDocumentId}, ${publicDocumentId}, ${publicHash},
              ${JSON.stringify([{ charStart: 0, charEnd: publicText.length }])}::jsonb
            )
          `;
          const reconstructionFailures = [
            yield* Effect.flip(sql`
              insert into ai_source_exposures (
                run_id, task_id, loop_iteration, attempt, provider_request_index,
                source_kind, logical_source_identity, content_item_identity,
                exposure_stage, visible_token_count
              ) values (
                ${evaluationRunId}, 'missing-reconstruction', 0, 0, 0,
                'document', ${`public:${publicSourceId}`}, 'missing', 'internal_inspection', 1
              )
            `),
            yield* Effect.flip(sql`
              insert into ai_source_exposures (
                run_id, task_id, loop_iteration, attempt, provider_request_index,
                source_kind, logical_source_identity, content_item_identity,
                exposure_stage, visible_token_count,
                document_source_id, document_id, version_id,
                content_hash, document_ranges
              ) values (
                ${evaluationRunId}, 'overlapping-reconstruction', 0, 0, 0,
                'document', ${`public:${publicSourceId}`}, 'overlapping', 'context_candidate_inspection', 1,
                ${`public:${publicSourceId}`}, ${publicDocumentId}, ${publicDocumentId}, ${publicHash},
                ${JSON.stringify([
                  { charStart: 0, charEnd: 3 },
                  { charStart: 2, charEnd: 4 },
                ])}::jsonb
              )
            `),
            yield* Effect.flip(sql`
              insert into ai_source_exposures (
                run_id, task_id, loop_iteration, attempt, provider_request_index,
                source_kind, logical_source_identity, content_item_identity,
                exposure_stage, visible_token_count,
                document_source_id, document_id, version_id,
                content_hash, document_ranges
              ) values (
                ${evaluationRunId}, 'unscoped-reconstruction', 0, 0, 0,
                'document', 'document:source-1', 'unscoped', 'internal_inspection', 1,
                'document:source-1', ${publicDocumentId}, ${publicDocumentId}, ${publicHash},
                ${JSON.stringify([{ charStart: 0, charEnd: 3 }])}::jsonb
              )
            `),
            yield* Effect.flip(sql`
              insert into ai_source_exposures (
                run_id, task_id, loop_iteration, attempt, provider_request_index,
                source_kind, logical_source_identity, content_item_identity,
                exposure_stage, visible_token_count,
                document_source_id, document_id, version_id,
                content_hash, document_ranges
              ) values (
                ${evaluationRunId}, 'too-long-reconstruction', 0, 0, 0,
                'document', ${`public:${publicSourceId}`}, 'too-long', 'internal_inspection', 1,
                ${`public:${publicSourceId}`}, ${publicDocumentId}, ${publicDocumentId}, ${publicHash},
                ${JSON.stringify([{ charStart: 0, charEnd: publicText.length + 1 }])}::jsonb
              )
            `),
            yield* Effect.flip(sql`
              insert into ai_source_exposures (
                run_id, task_id, loop_iteration, attempt, provider_request_index,
                source_kind, logical_source_identity, content_item_identity,
                exposure_stage, visible_token_count,
                document_source_id, document_id, version_id,
                content_hash
              ) values (
                ${evaluationRunId}, 'partial-reconstruction', 0, 0, 0,
                'document', ${`public:${publicSourceId}`}, 'partial', 'answer_serialized', 1,
                ${`public:${publicSourceId}`}, ${publicDocumentId}, ${publicDocumentId}, ${publicHash}
              )
            `),
            yield* Effect.flip(sql`
              insert into ai_source_exposures (
                run_id, task_id, loop_iteration, attempt, provider_request_index,
                source_kind, logical_source_identity, content_item_identity,
                exposure_stage, visible_token_count,
                document_source_id
              ) values (
                ${evaluationRunId}, 'partial-non-document', 0, 0, 0,
                'memory', 'memory:source-1', 'partial', 'memory_tool_result', 1,
                'public:source-1'
              )
            `),
          ];
          const sourceIdFailures = [];
          for (const sourceId of [
            "public:source:double-prefix",
            "public:\u00a0source",
            "public:\u2003source",
            "public:\u2028source",
            "public:\ufeffsource",
          ]) {
            sourceIdFailures.push(
              yield* Effect.flip(sql`
                insert into ai_source_exposures (
                  run_id, task_id, loop_iteration, attempt, provider_request_index,
                  source_kind, logical_source_identity, content_item_identity,
                  exposure_stage, visible_token_count,
                  document_source_id, document_id, version_id,
                  content_hash, document_ranges
                ) values (
                  ${evaluationRunId}, 'invalid-source-id', 0, 0, 0,
                  'document', ${sourceId}, 'invalid-source-id', 'internal_inspection', 1,
                  ${sourceId}, ${publicDocumentId}, ${publicDocumentId}, ${publicHash},
                  ${JSON.stringify([{ charStart: 0, charEnd: 3 }])}::jsonb
                )
              `),
            );
          }

          yield* sql`
            insert into ai_observations (
              run_id, chat_id, emitting_task, loop_iteration, attempt,
              observation_key, kind, payload
            ) values (
              ${evaluationRunId}, ${evaluationChatId}, 'evidence-task', 0, 0,
              'evidence:evaluation', 'citation', '{}'::jsonb
            ) on conflict do nothing
          `;
          yield* sql`
            insert into ai_source_exposures (
              run_id, task_id, loop_iteration, attempt, provider_request_index,
              source_kind, logical_source_identity, content_item_identity,
              exposure_stage, visible_token_count
            ) values (
              ${evaluationRunId}, 'evidence-task', 0, 0, 0,
              'memory', 'memory:doc-1', 'revision-1',
              'memory_tool_result', 1
            ) on conflict do nothing
          `;
          yield* sql`
            insert into ai_run_usage (
              run_id, task_id, loop_iteration, attempt, provider_request_index,
              agent_role, model_id, provider_service_id, input_tokens, output_tokens,
              cached_tokens, reasoning_tokens, total_tokens, stop_reason
            ) values (
              ${evaluationRunId}, 'evidence-task', 0, 0, 0,
              'internal_retrieval', 'glm-5-turbo', 'deterministic_test',
              1, 1, 0, 0, 2, 'toolUse'
            ) on conflict do nothing
          `;
          yield* sql`
            insert into ai_external_tool_usage (
              run_id, task_id, loop_iteration, attempt, tool_request_index,
              provider_service_id, operation, status, result_count,
              response_bytes, duration_ms
            ) values (
              ${evaluationRunId}, 'evidence-task', 0, 0, 0,
              'deterministic_test', 'web_search', 'ok', 1, 10, 1
            ) on conflict do nothing
          `;

          const updateFailures = [
            yield* Effect.flip(sql`
              update ai_observations set payload = '{"forged":true}'::jsonb
              where run_id = ${evaluationRunId}
            `),
            yield* Effect.flip(sql`
              update ai_source_exposures set visible_token_count = 2
              where run_id = ${evaluationRunId}
            `),
            yield* Effect.flip(sql`
              update ai_run_usage set input_tokens = 2
              where run_id = ${evaluationRunId}
            `),
            yield* Effect.flip(sql`
              update ai_external_tool_usage set response_bytes = 11
              where run_id = ${evaluationRunId}
            `),
          ];
          const deleteFailures = [
            yield* Effect.flip(sql`delete from ai_observations where run_id = ${evaluationRunId}`),
            yield* Effect.flip(
              sql`delete from ai_source_exposures where run_id = ${evaluationRunId}`,
            ),
            yield* Effect.flip(sql`delete from ai_run_usage where run_id = ${evaluationRunId}`),
            yield* Effect.flip(
              sql`delete from ai_external_tool_usage where run_id = ${evaluationRunId}`,
            ),
          ];

          yield* sql`
            update ai_observations set payload = '{"ordinary":true}'::jsonb
            where run_id = ${ordinaryRunId}
          `;
          yield* sql`
            update ai_source_exposures set visible_token_count = 2
            where run_id = ${ordinaryRunId}
          `;
          yield* sql`
            update ai_run_usage set input_tokens = 2, total_tokens = 3
            where run_id = ${ordinaryRunId}
          `;
          yield* sql`
            update ai_external_tool_usage set response_bytes = 11
            where run_id = ${ordinaryRunId}
          `;
          yield* sql`delete from ai_observations where run_id = ${ordinaryRunId}`;
          yield* sql`delete from ai_source_exposures where run_id = ${ordinaryRunId}`;
          yield* sql`delete from ai_run_usage where run_id = ${ordinaryRunId}`;
          yield* sql`delete from ai_external_tool_usage where run_id = ${ordinaryRunId}`;

          const [counts] = yield* sql<{
            readonly evaluationObservations: number;
            readonly evaluationExposures: number;
            readonly evaluationUsage: number;
            readonly evaluationExternalUsage: number;
            readonly ordinaryEvidence: number;
          }>`
            select
              (select count(*)::int from ai_observations
                where run_id = ${evaluationRunId}) as "evaluationObservations",
              (select count(*)::int from ai_source_exposures
                where run_id = ${evaluationRunId}) as "evaluationExposures",
              (select count(*)::int from ai_run_usage
                where run_id = ${evaluationRunId}) as "evaluationUsage",
              (select count(*)::int from ai_external_tool_usage
                where run_id = ${evaluationRunId}) as "evaluationExternalUsage",
              (
                (select count(*) from ai_observations where run_id = ${ordinaryRunId}) +
                (select count(*) from ai_source_exposures where run_id = ${ordinaryRunId}) +
                (select count(*) from ai_run_usage where run_id = ${ordinaryRunId}) +
                (select count(*) from ai_external_tool_usage where run_id = ${ordinaryRunId})
              )::int as "ordinaryEvidence"
          `;
          return {
            updateFailures,
            deleteFailures,
            reconstructionFailures,
            sourceIdFailures,
            counts,
          };
        }),
      );

      for (const failure of [...result.updateFailures, ...result.deleteFailures]) {
        expect(errorText(failure)).toContain(
          "canonical AI evaluation runtime evidence is append-only",
        );
      }
      for (const failure of result.reconstructionFailures) {
        expect(errorText(failure)).toMatch(
          /document exposure|ai_source_exposures_final_document_identity/,
        );
      }
      for (const failure of result.sourceIdFailures) {
        expect(errorText(failure)).toContain("document exposure source identity is not canonical");
      }
      expect(result.counts).toEqual({
        evaluationObservations: 1,
        evaluationExposures: 2,
        evaluationUsage: 1,
        evaluationExternalUsage: 1,
        ordinaryEvidence: 0,
      });
    },
  );
});
