import { PgClient } from "@effect/sql-pg";
import { Effect, Redacted } from "effect";

import { runMigrations } from "../db/migrate";

const defaultDatabaseUrl = "postgres://brief:brief@localhost:5432/brief_e2e";
const databaseUrl = process.env.BRIEF_E2E_DATABASE_URL ?? defaultDatabaseUrl;
const databaseName = new URL(databaseUrl).pathname.replace(/^\//, "") || "brief_e2e";
const seededAnswerSearchTerms = "solaire raccordements";
const seededAnswerExpectedDocuments = [
  {
    documentId: "e2e-fr-solaire-raccordements",
    title: "France solaire: raccordements acceleres",
    canonicalUrl: "https://e2e.example/fr/solaire-raccordements",
  },
  {
    documentId: "e2e-fr-stockage-reseau",
    title: "Stockage et reseau: priorites publiques",
    canonicalUrl: "https://e2e.example/fr/stockage-reseau",
  },
] as const;

const databaseUrlFor = (name: string): string => {
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
};

const adminDatabaseUrl = databaseUrlFor("postgres");
const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;

const runDb = <A, E>(url: string, effect: Effect.Effect<A, E, PgClient.PgClient>): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        PgClient.layer({
          url: Redacted.make(url),
          applicationName: "brief-playwright-e2e-setup",
        }),
      ),
    ),
  );

const createDatabase = () =>
  runDb(
    adminDatabaseUrl,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      yield* sql`
        select pg_terminate_backend(pid)
        from pg_stat_activity
        where datname = ${databaseName}
          and pid <> pg_backend_pid()
      `;
      yield* sql.unsafe(`drop database if exists ${quoteIdentifier(databaseName)}`);
      yield* sql.unsafe(`create database ${quoteIdentifier(databaseName)}`);
    }),
  );

const dropDatabase = () =>
  runDb(
    adminDatabaseUrl,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      yield* sql`
        select pg_terminate_backend(pid)
        from pg_stat_activity
        where datname = ${databaseName}
          and pid <> pg_backend_pid()
      `;
      yield* sql.unsafe(`drop database if exists ${quoteIdentifier(databaseName)}`);
    }),
  );

const docText = (lead: string): string =>
  `${lead} ` +
  "La note de marche decrit les raccordements, les appels d'offres, le stockage et les contraintes de reseau en France. ".repeat(
    5,
  );

const seedCorpus = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  const [solarDoc, storageDoc] = seededAnswerExpectedDocuments;

  const docs = [
    {
      sourceId: "e2e-fr-energie",
      displayName: "E2E Energie France",
      publisherName: "Observatoire Energie",
      documentId: solarDoc.documentId,
      rawId: "bbbbbbbb-1111-1111-1111-000000000001",
      title: solarDoc.title,
      url: solarDoc.canonicalUrl,
      publishedAt: "2026-07-01T08:00:00.000Z",
      text: docText(
        "Le solaire francais progresse en 2026 grace a des raccordements regionaux plus rapides et a une file d'attente clarifiee.",
      ),
    },
    {
      sourceId: "e2e-fr-reseau",
      displayName: "E2E Reseau Public",
      publisherName: "Agence Reseau",
      documentId: storageDoc.documentId,
      rawId: "bbbbbbbb-1111-1111-1111-000000000002",
      title: storageDoc.title,
      url: storageDoc.canonicalUrl,
      publishedAt: "2026-07-02T08:00:00.000Z",
      text: docText(
        "Les pouvoirs publics francais renforcent le suivi du stockage solaire pour lisser la demande, reduire les congestions du reseau et preparer les raccordements.",
      ),
    },
    {
      sourceId: "e2e-fr-industrie",
      displayName: "E2E Industrie Climat",
      publisherName: "Mission Industrie",
      documentId: "e2e-fr-hydrogene-industrie",
      rawId: "bbbbbbbb-1111-1111-1111-000000000003",
      title: "Hydrogene bas-carbone: calendrier industriel",
      url: "https://e2e.example/fr/hydrogene-industrie",
      publishedAt: "2026-07-03T08:00:00.000Z",
      text: docText(
        "Le calendrier industriel francais maintient les appels d'offres hydrogene et les usages lourds comme priorites de transition.",
      ),
    },
  ] as const;

  yield* sql`
    delete from public_sources
    where ${sql.in(
      "source_id",
      docs.map((doc) => doc.sourceId),
    )}
  `;

  for (const doc of docs) {
    yield* sql`
      insert into public_sources (
        source_id,
        display_name,
        publisher_name,
        description,
        ingestion_method,
        discovery_url,
        average_chars_per_item,
        country,
        language
      )
      values (
        ${doc.sourceId},
        ${doc.displayName},
        ${doc.publisherName},
        'Corpus public Playwright E2E',
        'rss',
        ${`${doc.url}/feed`},
        1200,
        'FR',
        'fr-FR'
      )
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
      values (
        ${doc.rawId},
        ${doc.sourceId},
        ${doc.url},
        now(),
        'text/html',
        ${doc.text},
        ${`e2e-body-${doc.documentId}`}
      )
    `;
    yield* sql`
      insert into public_source_documents (
        document_id,
        source_id,
        raw_artifact_id,
        canonical_url,
        title,
        text,
        language,
        published_at,
        discovered_at,
        fetched_at,
        document_type,
        content_hash,
        text_char_count
      )
      values (
        ${doc.documentId},
        ${doc.sourceId},
        ${doc.rawId},
        ${doc.url},
        ${doc.title},
        ${doc.text},
        'fr-FR',
        ${doc.publishedAt},
        now(),
        now(),
        'article',
        ${`e2e-hash-${doc.documentId}`},
        ${doc.text.length}
      )
    `;
    yield* sql`
      insert into public_source_items (
        source_id,
        canonical_url,
        external_id,
        title,
        published_at,
        discovered_at,
        summary,
        current_content_hash,
        latest_document_id,
        latest_raw_artifact_id,
        last_fetched_at,
        last_successful_fetch_at
      )
      values (
        ${doc.sourceId},
        ${doc.url},
        ${doc.documentId},
        ${doc.title},
        ${doc.publishedAt},
        now(),
        ${doc.text.slice(0, 220)},
        ${`e2e-hash-${doc.documentId}`},
        ${doc.documentId},
        ${doc.rawId},
        now(),
        now()
      )
    `;
  }
});

const assertSeededCorpusSearchable = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  const rows = yield* sql<{ readonly documentId: string }>`
    select d.document_id as "documentId"
    from public_source_documents d
    join public_sources s on s.source_id = d.source_id
    where s.country = 'FR'
      and d.language = 'fr-FR'
      and d.search_vector @@ websearch_to_tsquery('french', ${seededAnswerSearchTerms})
    order by
      ts_rank_cd(d.search_vector, websearch_to_tsquery('french', ${seededAnswerSearchTerms})) desc,
      d.published_at desc nulls last,
      d.document_id asc
    limit ${seededAnswerExpectedDocuments.length}
  `;
  const documentIds = rows.map((row) => row.documentId);
  const expectedDocumentIds = seededAnswerExpectedDocuments.map((doc) => doc.documentId);

  if (documentIds.join("\n") !== expectedDocumentIds.join("\n")) {
    return yield* Effect.fail(
      new Error(
        `E2E seed corpus FTS validation failed for "${seededAnswerSearchTerms}". ` +
          `Expected ${expectedDocumentIds.join(", ")}; returned ${
            documentIds.join(", ") || "<none>"
          }.`,
      ),
    );
  }
});

const resetChatRuntime = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  const smithersTables = yield* sql<{ readonly tableName: string }>`
    select distinct table_name as "tableName"
    from information_schema.columns
    where table_schema = 'public'
      and column_name = 'run_id'
      and (
        table_name like '_smithers_%'
        or table_name = 'input'
        or table_name like 'ai_chat_%'
      )
  `;

  yield* sql`delete from jobs`;
  yield* sql`delete from user_memory_revisions where memory_id in (select id from user_memories where user_id = 'demo-user')`;
  yield* sql`delete from user_memories where user_id = 'demo-user'`;
  yield* sql`delete from chats where user_id = 'demo-user'`;

  for (const table of smithersTables) {
    yield* sql`truncate table ${sql(table.tableName)} cascade`;
  }
}).pipe(Effect.asVoid);

const setup = async (): Promise<void> => {
  await createDatabase();
  await runDb(databaseUrl, runMigrations);
  await runDb(databaseUrl, seedCorpus);
  await runDb(databaseUrl, assertSeededCorpusSearchable);
};

const command = process.argv[2] ?? "setup";

if (command === "setup") {
  await setup();
} else if (command === "teardown") {
  await dropDatabase();
} else if (command === "reset") {
  await runDb(databaseUrl, resetChatRuntime);
} else {
  throw new Error(`Unknown e2e setup command: ${command}`);
}
