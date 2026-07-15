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

  it("immutably binds assistant source and source-use tuples after citation persistence", async () => {
    const testUrl = isolatedDatabaseUrl();
    const ids = {
      user: `source-identity-${crypto.randomUUID()}`,
      company: crypto.randomUUID(),
      chat: crypto.randomUUID(),
      message: crypto.randomUUID(),
      run: crypto.randomUUID(),
      assistant: crypto.randomUUID(),
    };
    const sourceKey = `k_${"A".repeat(22)}_1`;
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
            id, chat_id, initiating_user_id, user_message_id, locale, market,
            effective_web_policy
          ) values (
            ${ids.run}, ${ids.chat}, ${ids.user}, ${ids.message}, 'en-US', 'US',
            ${sql.json({ enabled: false, reason: "company_disabled", allowlistActive: false })}
          )
        `;
        yield* sql`
          insert into chat_messages (id, chat_id, author, content, assistant_ai_run_id)
          values (${ids.assistant}, ${ids.chat}, 'assistant', ${assistantContent}, ${ids.run})
        `;
        yield* sql`update ai_runs set assistant_message_id = ${ids.assistant} where id = ${ids.run}`;
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
              quoteHash: "hash",
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
                  'en-US', 'report', repeat('legacy pdf text ', 10), 160,
                  'legacy-pdf-content', '27000000-0000-4000-8000-000000000001'
                ),
                (
                  'current-html-document', 'binary-migration-source',
                  'https://example.test/current.html', 'Current HTML', now(), now(),
                  'en-US', 'article', repeat('current html text ', 10), 180,
                  'current-html-content', '27000000-0000-4000-8000-000000000002'
                )
            `;
            yield* sql`
              insert into public_source_items (
                source_id, canonical_url, title, discovered_at, current_content_hash,
                latest_document_id, latest_raw_artifact_id
              ) values
                (
                  'binary-migration-source', 'https://example.test/legacy.pdf',
                  'Legacy PDF', now(), 'legacy-pdf-content', 'legacy-pdf-document',
                  '27000000-0000-4000-8000-000000000001'
                ),
                (
                  'binary-migration-source', 'https://example.test/current.html',
                  'Current HTML', now(), 'current-html-content', 'current-html-document',
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
      const assistantMessageId = "eeeeeeee-0000-0000-0000-000000000004";
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
              insert into ai_runs (id, chat_id, user_message_id, locale, market, finished_at)
              values (${runId}, ${chatId}, ${messageId}, 'fr-FR', 'FR', now())
            `;
            yield* sql`
              insert into chat_messages (id, chat_id, author, content, ai_run_id)
              values (${assistantMessageId}, ${chatId}, 'assistant', 'surviving assistant', ${runId})
            `;
            yield* sql`
              update ai_runs
              set assistant_message_id = ${assistantMessageId}
              where id = ${runId}
            `;
            yield* sql`
              insert into ai_run_events (run_id, seq, event, emitted_by_task)
              values (${runId}, 1, '{}'::jsonb, 'test-task')
            `;
            yield* sql`
              insert into ai_observations (id, run_id, chat_id, kind, payload)
              values (${crypto.randomUUID()}, ${runId}, ${chatId}, 'citation', '{}'::jsonb)
            `;
            yield* sql`
              insert into user_memories (id, user_id, kind, content)
              values (${memoryId}, 'demo-user', 'fact', 'surviving memory')
            `;
            yield* sql`
              insert into user_memory_revisions (memory_id, action, content_after, run_id)
              values (${memoryId}, 'created', 'surviving memory', ${runId})
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
              select count(*)::int as count
              from chats surviving_chats
              join chat_messages messages on messages.chat_id = surviving_chats.id
              join ai_runs runs on runs.chat_id = messages.chat_id
              join chat_messages assistants
                on assistants.id = runs.assistant_message_id
              join ai_run_events events on events.run_id = runs.id
              join ai_observations observations on observations.run_id = runs.id
              join user_memories memories on memories.id = ${memoryId}
              join user_memory_revisions revisions on revisions.memory_id = memories.id
              where surviving_chats.id = ${chatId}
                and messages.id = ${messageId}
                and runs.id = ${runId}
                and assistants.id = ${assistantMessageId}
                and events.run_id = ${runId}
                and observations.run_id = ${runId}
                and revisions.run_id = ${runId}
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
                'fts-c1',
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
                200,
                'fts-c2',
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
                200,
                'fts-c3',
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
                200,
                'fts-c4',
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

  it("enforces one unterminated run per chat", { timeout: 60_000 }, async () => {
    const testUrl = isolatedDatabaseUrl();
    const result = await runDb(
      testUrl,
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const userId = "migration-active-run-user";
        const companyId = yield* provisionClientUser(userId);

        yield* sql`
            insert into chats (id, company_id, user_id)
            values ('bbbbbbbb-0000-0000-0000-000000000001', ${companyId}, ${userId})
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
            insert into ai_runs (id, chat_id, user_message_id, locale, market)
            values (
              'bbbbbbbb-0000-0000-0000-000000000003',
              'bbbbbbbb-0000-0000-0000-000000000001',
              'bbbbbbbb-0000-0000-0000-000000000002',
              'fr-FR',
              'FR'
            )
            on conflict (id) do nothing
          `;

        const failure = yield* Effect.flip(sql`
            insert into ai_runs (id, chat_id, user_message_id, locale, market)
            values (
              'bbbbbbbb-0000-0000-0000-000000000004',
              'bbbbbbbb-0000-0000-0000-000000000001',
              'bbbbbbbb-0000-0000-0000-000000000005',
              'fr-FR',
              'FR'
            )
          `);

        yield* sql`
            update ai_runs
            set finished_at = now()
            where id = 'bbbbbbbb-0000-0000-0000-000000000003'
          `;
        yield* sql`
            insert into ai_runs (id, chat_id, user_message_id, locale, market)
            values (
              'bbbbbbbb-0000-0000-0000-000000000004',
              'bbbbbbbb-0000-0000-0000-000000000001',
              'bbbbbbbb-0000-0000-0000-000000000005',
              'fr-FR',
              'FR'
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
          insert into chats (id, company_id, user_id)
          values
            (${firstChatId}, ${initiatingCompanyId}, ${initiatingUserId}),
            (${secondChatId}, ${otherCompanyId}, ${otherUserId})
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
            chat_id, initiating_user_id, user_message_id, locale, market
          )
          values (${firstChatId}, ${initiatingUserId}, ${firstMessageId}, 'en-US', 'US')
          returning id::text
        `;
          const failure = yield* Effect.flip(sql`
          insert into ai_runs (
            chat_id, initiating_user_id, user_message_id, locale, market
          )
          values (${secondChatId}, ${initiatingUserId}, ${secondMessageId}, 'en-US', 'US')
        `);
          yield* sql`
          update ai_runs
          set failed_at = now(), error_code = 'answer_failed', retryable = true
          where id = ${firstRun!.id}
        `;
          yield* sql`
          insert into ai_runs (
            chat_id, initiating_user_id, user_message_id, locale, market
          )
          values (${secondChatId}, ${initiatingUserId}, ${secondMessageId}, 'en-US', 'US')
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
          insert into chats (id, company_id, user_id)
          values ('dddddddd-0000-0000-0000-000000000001', ${companyId}, ${userId})
        `;
          yield* sql`
          insert into chat_messages (id, chat_id, author, content)
          values ('dddddddd-0000-0000-0000-000000000002', 'dddddddd-0000-0000-0000-000000000001', 'user', 'Memory revision cascade test')
        `;
          yield* sql`
          insert into ai_runs (id, chat_id, user_message_id, locale, market, finished_at)
          values ('dddddddd-0000-0000-0000-000000000003', 'dddddddd-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-000000000002', 'fr-FR', 'FR', now())
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
            insert into ai_runs (id, chat_id, user_message_id, locale, market, finished_at)
            values
              (${evaluationRunId}, ${evaluationChatId}, ${evaluationMessageId}, 'en-US', 'US', now()),
              (${ordinaryRunId}, ${ordinaryChatId}, ${ordinaryMessageId}, 'en-US', 'US', now())
          `;
          yield* sql`
            insert into ai_evaluation_sessions (
              id, artifact_version, golden_set_version, fixture_sha256_hex, status
            ) values (${evaluationSessionId}, 2, 2, ${"a".repeat(64)}, 'preparing')
          `;
          yield* sql`
            insert into ai_evaluation_case_runs (
              session_id, case_id, topology, ai_run_id, seed_manifest, status
            ) values (
              ${evaluationSessionId}, 'append-only-case', 'specialized',
              ${evaluationRunId}, '{}'::jsonb, 'seeded'
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
                'document', 'document:doc-1', 'version-1:content',
                'internal_search_preview', 1
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
              document_source_id, document_id, document_version_id,
              document_content_hash, document_ranges
            ) values (
              ${evaluationRunId}, 'reconstructable-inspection', 0, 0, 0,
              'document', 'public:source-1',
              'public:source-1:document-1:version-1:range-a',
              'internal_inspection', 3,
              'public:source-1', 'document-1', 'version-1', ${"a".repeat(64)},
              ${JSON.stringify([{ charStart: 0, charEnd: 3 }])}::jsonb
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
                'document', 'public:source-1', 'missing', 'internal_inspection', 1
              )
            `),
            yield* Effect.flip(sql`
              insert into ai_source_exposures (
                run_id, task_id, loop_iteration, attempt, provider_request_index,
                source_kind, logical_source_identity, content_item_identity,
                exposure_stage, visible_token_count,
                document_source_id, document_id, document_version_id,
                document_content_hash, document_ranges
              ) values (
                ${evaluationRunId}, 'overlapping-reconstruction', 0, 0, 0,
                'document', 'public:source-1', 'overlapping', 'context_candidate_inspection', 1,
                'public:source-1', 'document-1', 'version-1', ${"a".repeat(64)},
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
                document_source_id, document_id, document_version_id,
                document_content_hash, document_ranges
              ) values (
                ${evaluationRunId}, 'unscoped-reconstruction', 0, 0, 0,
                'document', 'document:source-1', 'unscoped', 'internal_inspection', 1,
                'document:source-1', 'document-1', 'version-1', ${"a".repeat(64)},
                ${JSON.stringify([{ charStart: 0, charEnd: 3 }])}::jsonb
              )
            `),
          ];

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
              'document', 'document:doc-1', 'version-1:content',
              'internal_search_preview', 1
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
          return { updateFailures, deleteFailures, reconstructionFailures, counts };
        }),
      );

      for (const failure of [...result.updateFailures, ...result.deleteFailures]) {
        expect(errorText(failure)).toContain(
          "canonical AI evaluation runtime evidence is append-only",
        );
      }
      for (const failure of result.reconstructionFailures) {
        expect(errorText(failure)).toContain("ai_source_exposures_document_reconstruction");
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
