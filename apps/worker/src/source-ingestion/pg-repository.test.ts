import { PgClient } from "@effect/sql-pg";
import { Effect, Redacted } from "effect";
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { IngestedSourceItem, PublicSourceDefinition } from "@brief/source-ingestion";
import { makePgPublicSourceIngestionRepository } from "./pg-repository";

const databaseUrl = process.env.WORKER_POSTGRES_TEST_DATABASE_URL;
const migrationsUrl = new URL("../../../../db/migrations/", import.meta.url);

const source = {
  id: "tresor",
  displayName: "Direction generale du Tresor",
  publisherName: "Direction generale du Tresor",
  description: "Treasury publications.",
  country: "FR",
  language: "fr-FR",
  ingestionMethod: "atom_feed",
  discoveryUrl: "https://example.test/feed",
  contentFormats: ["html", "text"],
  averageCharsPerItem: 1000,
} as const satisfies PublicSourceDefinition;

const runDb = <A, E>(effect: Effect.Effect<A, E, PgClient.PgClient>): Promise<A> => {
  if (!databaseUrl) {
    throw new Error("WORKER_POSTGRES_TEST_DATABASE_URL is required for Postgres tests");
  }

  return Effect.runPromise(
    effect.pipe(
      Effect.provide(
        PgClient.layer({
          url: Redacted.make(databaseUrl),
          applicationName: "brief-public-source-pg-repository-test",
        }),
      ),
    ),
  );
};

const resetDatabase = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  const files = readdirSync(migrationsUrl.pathname)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  yield* sql`
      create table if not exists schema_migrations (
        name text primary key,
        applied_at timestamptz not null default now()
      )
    `;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`select pg_advisory_xact_lock(hashtext('brief:schema_migrations'))`;
      const appliedRows = yield* sql<{ readonly name: string }>`
          select name from schema_migrations
        `;
      const applied = new Set(appliedRows.map((row) => row.name));

      for (const file of files) {
        if (applied.has(file)) {
          continue;
        }

        const body = readFileSync(new URL(file, migrationsUrl), "utf8");
        yield* sql.unsafe(body).raw;
        yield* sql`
            insert into schema_migrations (name)
            values (${file})
          `;
      }
    }),
  );
  yield* sql`
      truncate table
        public_source_ingestion_runs,
        public_source_items,
        public_source_candidates,
        public_source_documents,
        public_source_raw_artifacts,
        public_source_discovery_requests,
        public_sources
      cascade
    `;
});

const ingested = (body: string, fetchedAt: Date): IngestedSourceItem => {
  const item = {
    sourceId: "tresor",
    externalId: "stable",
    canonicalUrl: "https://example.test/articles/stable",
    title: "Stable document",
    publishedAt: new Date("2026-07-07T10:00:00.000Z"),
    discoveredAt: new Date("2026-07-07T10:00:00.000Z"),
  } as const;
  const readableText =
    "Stable readable public source document text with enough content to satisfy the publication storage invariant.";
  const contentHash = "a".repeat(64);

  return {
    status: "ingested",
    item,
    raw: {
      sourceId: "tresor",
      canonicalUrl: item.canonicalUrl,
      fetchedAt,
      mediaType: "text/html",
      body,
    },
    document: {
      id: "tresor:https%3A%2F%2Fexample.test%2Farticles%2Fstable:aaaaaaaaaaaaaaaa",
      sourceId: "tresor",
      externalId: item.externalId,
      canonicalUrl: item.canonicalUrl,
      title: item.title,
      publishedAt: item.publishedAt,
      discoveredAt: item.discoveredAt,
      fetchedAt,
      language: "fr",
      documentType: "article",
      text: readableText,
      textCharCount: readableText.length,
      contentHash,
      rawArtifactKey: item.canonicalUrl,
      sourceMetadata: {},
    },
  };
};

describe.skipIf(!databaseUrl)("postgres public source repository", () => {
  it("keeps latest item/document/raw pointers coherent when the raw artifact changes but canonical text does not", async () => {
    await runDb(
      Effect.gen(function* () {
        yield* resetDatabase;
        const sql = yield* PgClient.PgClient;
        const repository = yield* makePgPublicSourceIngestionRepository();

        yield* repository.startRun(source, { mode: "poll" });
        yield* repository.storeIngestedItem(
          ingested(
            "<article>first wrapper around stable text</article>",
            new Date("2026-07-07T10:01:00.000Z"),
          ),
        );
        yield* repository.storeIngestedItem(
          ingested(
            "<article>second wrapper around stable text</article>",
            new Date("2026-07-07T10:02:00.000Z"),
          ),
        );

        const rows = yield* sql<{
          readonly latest_raw_artifact_id: string;
          readonly document_raw_artifact_id: string;
          readonly current_content_hash: string;
          readonly content_hash: string;
          readonly body: string;
        }>`
            select
              i.latest_raw_artifact_id::text,
              d.raw_artifact_id::text as document_raw_artifact_id,
              i.current_content_hash,
              d.content_hash,
              r.body
            from public_source_items i
            join public_source_documents d on d.document_id = i.latest_document_id
            join public_source_raw_artifacts r on r.id = i.latest_raw_artifact_id
            where i.source_id = 'tresor'
              and i.canonical_url = 'https://example.test/articles/stable'
          `;

        expect(rows).toHaveLength(1);
        expect(rows[0]?.latest_raw_artifact_id).toBe(rows[0]?.document_raw_artifact_id);
        expect(rows[0]?.current_content_hash).toBe(rows[0]?.content_hash);
        expect(rows[0]?.body).toBe("<article>second wrapper around stable text</article>");
      }),
    );
  });
});
