import { PgClient } from "@effect/sql-pg";
import { Effect, Redacted } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "./migrate";

const isBun = typeof process.versions.bun === "string";
const databaseUrl = process.env.WORKER_POSTGRES_TEST_DATABASE_URL;
const migrationsUrl = new URL("../../../../db/migrations/", import.meta.url);
const isolatedDatabaseName = `brief_migrations_test_${process.pid}_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;

type RelationRow = {
  chats: string | null;
  chat_messages: string | null;
  ai_runs: string | null;
  ai_run_events: string | null;
  chat_context_blocks: string | null;
  ai_observations: string | null;
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
  const url = new URL(sourceDatabaseUrl());
  url.pathname = `/${isolatedDatabaseName}`;

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
              to_regclass('public.chats')::text as chats,
              to_regclass('public.chat_messages')::text as chat_messages,
              to_regclass('public.ai_runs')::text as ai_runs,
              to_regclass('public.ai_run_events')::text as ai_run_events,
              to_regclass('public.chat_context_blocks')::text as chat_context_blocks,
              to_regclass('public.ai_observations')::text as ai_observations,
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
          const searchVectorColumns = yield* sql<ColumnRow>`
            select column_name
            from information_schema.columns
            where table_schema = 'public'
              and table_name = 'public_source_documents'
              and column_name = 'search_vector'
          `;
          const migrationsBefore = yield* sql<NamedRow>`
            select name
            from schema_migrations
            order by name
          `;

          yield* sql`delete from schema_migrations`;
          yield* runMigrations;

          const migrationsAfter = yield* sql<NamedRow>`
            select name
            from schema_migrations
            order by name
          `;

          return {
            relations,
            extensionCount: extension?.count,
            indexNames: indexes.map((index) => index.indexname),
            searchVectorColumnCount: searchVectorColumns.length,
            migrationsBefore: migrationsBefore.map((migration) => migration.name),
            migrationsAfter: migrationsAfter.map((migration) => migration.name),
          };
        }),
      );

      expect(result.relations).toBeDefined();

      if (!result.relations) {
        throw new Error("missing relation assertion row");
      }

      expect(Object.values(result.relations).every((relation) => relation !== null)).toBe(true);
      expect(result.extensionCount).toBe(1);
      expect(result.indexNames).toContain("public_source_documents_search_vector_idx");
      expect(result.indexNames).toContain("public_source_documents_title_trgm_idx");
      expect(result.searchVectorColumnCount).toBe(1);
      expect(result.migrationsBefore).toEqual(expectedMigrations);
      expect(result.migrationsBefore).toContain("0008_ai_chat_runtime.sql");
      expect(result.migrationsBefore).toContain("0009_document_search.sql");
      expect(result.migrationsBefore).toContain("0010_user_memory_revision_run_set_null.sql");
      expect(result.migrationsAfter).toEqual(expectedMigrations);
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

        yield* sql`
            insert into chats (id, user_id)
            values ('bbbbbbbb-0000-0000-0000-000000000001', 'demo-user')
            on conflict (id) do nothing
          `;
        yield* sql`
            insert into chat_messages (id, chat_id, author, content)
            values (
              'bbbbbbbb-0000-0000-0000-000000000002',
              'bbbbbbbb-0000-0000-0000-000000000001',
              'user',
              'Migration invariant test'
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
              'bbbbbbbb-0000-0000-0000-000000000002',
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
              'bbbbbbbb-0000-0000-0000-000000000002',
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
    "prevents duplicate active blocks for the same document and range",
    { timeout: 60_000 },
    async () => {
      const testUrl = isolatedDatabaseUrl();
      const result = await runDb(
        testUrl,
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;

          yield* sql`
            insert into chats (id, user_id)
            values ('cccccccc-0000-0000-0000-000000000001', 'demo-user')
            on conflict (id) do nothing
          `;
          yield* sql`
            insert into chat_messages (id, chat_id, author, content)
            values (
              'cccccccc-0000-0000-0000-000000000002',
              'cccccccc-0000-0000-0000-000000000001',
              'user',
              'Migration context block invariant test'
            )
            on conflict (id) do nothing
          `;
          yield* sql`
            insert into ai_runs (id, chat_id, user_message_id, locale, market)
            values (
              'cccccccc-0000-0000-0000-000000000003',
              'cccccccc-0000-0000-0000-000000000001',
              'cccccccc-0000-0000-0000-000000000002',
              'fr-FR',
              'FR'
            )
            on conflict (id) do nothing
          `;
          yield* sql`
            insert into chat_context_blocks (
              block_id,
              chat_id,
              kind,
              content,
              token_estimate,
              document_id,
              char_start,
              char_end,
              created_by_run_id
            )
            values (
              'b1',
              'cccccccc-0000-0000-0000-000000000001',
              'document',
              'x',
              10,
              'fts-doc-fr-title',
              null,
              null,
              'cccccccc-0000-0000-0000-000000000003'
            )
          `;

          const nullRangeFailure = yield* Effect.flip(sql`
            insert into chat_context_blocks (
              block_id,
              chat_id,
              kind,
              content,
              token_estimate,
              document_id,
              char_start,
              char_end,
              created_by_run_id
            )
            values (
              'b2',
              'cccccccc-0000-0000-0000-000000000001',
              'document',
              'x',
              10,
              'fts-doc-fr-title',
              null,
              null,
              'cccccccc-0000-0000-0000-000000000003'
            )
          `);

          yield* sql`
            update chat_context_blocks
            set evicted_at = now()
            where chat_id = 'cccccccc-0000-0000-0000-000000000001'
              and block_id = 'b1'
          `;
          yield* sql`
            insert into chat_context_blocks (
              block_id,
              chat_id,
              kind,
              content,
              token_estimate,
              document_id,
              char_start,
              char_end,
              created_by_run_id
            )
            values (
              'b3',
              'cccccccc-0000-0000-0000-000000000001',
              'document',
              'x',
              10,
              'fts-doc-fr-title',
              null,
              null,
              'cccccccc-0000-0000-0000-000000000003'
            )
          `;
          yield* sql`
            insert into chat_context_blocks (
              block_id,
              chat_id,
              kind,
              content,
              token_estimate,
              document_id,
              char_start,
              char_end,
              created_by_run_id
            )
            values (
              'b4',
              'cccccccc-0000-0000-0000-000000000001',
              'document',
              'x',
              10,
              'fts-doc-fr-title',
              0,
              100,
              'cccccccc-0000-0000-0000-000000000003'
            )
          `;

          const rangeFailure = yield* Effect.flip(sql`
            insert into chat_context_blocks (
              block_id,
              chat_id,
              kind,
              content,
              token_estimate,
              document_id,
              char_start,
              char_end,
              created_by_run_id
            )
            values (
              'b5',
              'cccccccc-0000-0000-0000-000000000001',
              'document',
              'x',
              10,
              'fts-doc-fr-title',
              0,
              100,
              'cccccccc-0000-0000-0000-000000000003'
            )
          `);

          return {
            nullRangeFailure,
            rangeFailure,
          };
        }),
      );

      expect(errorText(result.nullRangeFailure)).toContain(
        "chat_context_blocks_active_document_range_key",
      );
      expect(errorText(result.rangeFailure)).toContain(
        "chat_context_blocks_active_document_range_key",
      );
    },
  );

  it(
    "deleting a chat preserves memory revisions and nulls their run id",
    { timeout: 60_000 },
    async () => {
      const testUrl = isolatedDatabaseUrl();
      const result = await runDb(
        testUrl,
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;

          yield* sql`
          insert into chats (id, user_id)
          values ('dddddddd-0000-0000-0000-000000000001', 'demo-user')
          on conflict (id) do nothing
        `;
          yield* sql`
          insert into chat_messages (id, chat_id, author, content)
          values ('dddddddd-0000-0000-0000-000000000002', 'dddddddd-0000-0000-0000-000000000001', 'user', 'Memory revision cascade test')
          on conflict (id) do nothing
        `;
          yield* sql`
          insert into ai_runs (id, chat_id, user_message_id, locale, market, finished_at)
          values ('dddddddd-0000-0000-0000-000000000003', 'dddddddd-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-000000000002', 'fr-FR', 'FR', now())
          on conflict (id) do nothing
        `;
          yield* sql`
          insert into user_memories (id, user_id, kind, content, evidence_quote, source_message_id)
          values ('dddddddd-0000-0000-0000-000000000004', 'demo-user', 'fact', 'Prefers concise briefs', 'Prefers concise briefs', 'dddddddd-0000-0000-0000-000000000002')
          on conflict (id) do nothing
        `;
          yield* sql`
          insert into user_memory_revisions (memory_id, action, content_after, run_id)
          values ('dddddddd-0000-0000-0000-000000000004', 'created', 'Prefers concise briefs', 'dddddddd-0000-0000-0000-000000000003')
        `;
          const [constraint] = yield* sql<ConstraintRow>`
          select confdeltype::text as confdeltype
          from pg_constraint
          where conname = 'user_memory_revisions_run_id_fkey'
        `;
          yield* sql`
          delete from chats
          where id = 'dddddddd-0000-0000-0000-000000000001'
        `;
          const revisions = yield* sql<RevisionRow>`
          select run_id
          from user_memory_revisions
          where memory_id = 'dddddddd-0000-0000-0000-000000000004'
        `;
          const [memories] = yield* sql<CountRow>`
          select count(*)::int as count
          from user_memories
          where id = 'dddddddd-0000-0000-0000-000000000004'
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
});
