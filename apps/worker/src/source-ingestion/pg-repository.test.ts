import { PgClient } from "@effect/sql-pg";
import { Effect, Redacted } from "effect";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  sha256Hex,
  type IngestedSourceItem,
  type PublicSourceDefinition,
} from "@brief/source-ingestion";
import { makePgPublicSourceIngestionRepository } from "./pg-repository";

const databaseUrl = process.env.WORKER_POSTGRES_TEST_DATABASE_URL;
const migrationsUrl = new URL("../../../../db/migrations/", import.meta.url);

const source = {
  id: "service_public",
  displayName: "Service-Public",
  publisherName: "Direction de l'information legale et administrative",
  description: "Official Government news and explanations.",
  country: "FR",
  language: "fr-FR",
  ingestionMethod: "xml_dataset",
  discoveryUrl: "https://example.test/service-public.xml",
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
    sourceId: "service_public",
    externalId: "stable",
    canonicalUrl: "https://example.test/articles/stable",
    title: "Stable document",
    publishedAt: new Date("2026-07-07T10:00:00.000Z"),
    discoveredAt: new Date("2026-07-07T10:00:00.000Z"),
  } as const;
  const readableText =
    "Stable readable public source document text with enough content to satisfy the publication storage invariant.";
  const contentHash = createHash("sha256").update(readableText, "utf8").digest("hex");

  return {
    status: "ingested",
    item,
    raw: {
      sourceId: "service_public",
      canonicalUrl: item.canonicalUrl,
      fetchedAt,
      mediaType: "text/html",
      body,
    },
    document: {
      id: `service_public:https%3A%2F%2Fexample.test%2Farticles%2Fstable:${contentHash.slice(0, 16)}`,
      sourceId: "service_public",
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
  it("persists Service-Public discovery metadata without the transient XML payload", async () => {
    await runDb(
      Effect.gen(function* () {
        yield* resetDatabase;
        const repository = yield* makePgPublicSourceIngestionRepository();
        const result = ingested(
          "<article>stable Service-Public wrapper</article>",
          new Date("2026-07-07T10:01:00.000Z"),
        );
        const withEmbeddedXml = {
          ...result,
          item: {
            ...result.item,
            metadata: {
              audience: "part",
              xmlUrl: "https://example.test/xml/actualites/stable.xml",
              xmlBody: "<publication><title>Stable official body</title></publication>",
            },
          },
        } as const satisfies IngestedSourceItem;

        yield* repository.startRun(source, { mode: "poll" });
        yield* repository.storeIngestedItem(withEmbeddedXml);
        const stored = yield* repository.getItemState(
          withEmbeddedXml.item.sourceId,
          withEmbeddedXml.item.canonicalUrl,
        );

        expect(stored?.metadata).toEqual({
          audience: "part",
          xmlUrl: "https://example.test/xml/actualites/stable.xml",
        });
      }),
    );
  });

  it("rolls back validators, health, and every candidate when one candidate upsert fails", async () => {
    await runDb(
      Effect.gen(function* () {
        yield* resetDatabase;
        const sql = yield* PgClient.PgClient;
        const repository = yield* makePgPublicSourceIngestionRepository();
        yield* repository.startRun(source, { mode: "poll" });
        yield* sql.unsafe(`
          create or replace function brief_test_fail_public_source_candidate()
          returns trigger
          language plpgsql
          as $$
          begin
            if new.canonical_url = 'https://example.test/articles/atomic-second' then
              raise exception 'injected candidate upsert failure';
            end if;
            return new;
          end
          $$;
          drop trigger if exists brief_test_fail_public_source_candidate
            on public_source_candidates;
          create trigger brief_test_fail_public_source_candidate
            before insert on public_source_candidates
            for each row execute function brief_test_fail_public_source_candidate();
        `).raw;

        const discoveredAt = new Date("2026-07-07T10:00:00.000Z");
        const first = {
          sourceId: source.id,
          externalId: "atomic-first",
          canonicalUrl: "https://example.test/articles/atomic-first",
          title: "Atomic first",
          publishedAt: null,
          discoveredAt,
        } as const;
        const second = {
          ...first,
          externalId: "atomic-second",
          canonicalUrl: "https://example.test/articles/atomic-second",
          title: "Atomic second",
        } as const;
        const discovery = {
          status: "fetched",
          items: [first, second],
          discoveredAt,
          metadata: [{ url: source.discoveryUrl, status: 200, etag: '"atomic"' }],
        } as const;
        try {
          const outcome = yield* Effect.exit(
            repository.recordDiscoveryResult(source, discovery, {
              items: discovery.items,
              pollEligible: true,
            }),
          );
          expect(outcome._tag).toBe("Failure");
          if (outcome._tag === "Success") {
            throw new Error("expected candidate upsert failure");
          }
        } finally {
          yield* sql.unsafe(`
            drop trigger if exists brief_test_fail_public_source_candidate
              on public_source_candidates;
            drop function if exists brief_test_fail_public_source_candidate();
          `).raw;
        }

        const discoveryRows = yield* sql`
          select url from public_source_discovery_requests where source_id = ${source.id}
        `;
        const candidateRows = yield* sql`
          select canonical_url from public_source_candidates where source_id = ${source.id}
        `;
        const healthRows = yield* sql<{ readonly health_status: string }>`
          select health_status from public_sources where source_id = ${source.id}
        `;
        expect(discoveryRows).toHaveLength(0);
        expect(candidateRows).toHaveLength(0);
        expect(healthRows[0]?.health_status).toBe("unknown");
      }),
    );
  });

  it("stores exact PDF bytes and hashes the binary representation", async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, 0xff, 0x01]);
    const expectedHash = await sha256Hex(bytes);
    await runDb(
      Effect.gen(function* () {
        yield* resetDatabase;
        const sql = yield* PgClient.PgClient;
        const repository = yield* makePgPublicSourceIngestionRepository();
        const result = ingested("", new Date("2026-07-07T10:01:00.000Z"));

        yield* repository.startRun(source, { mode: "poll" });
        yield* repository.storeIngestedItem({
          ...result,
          raw: {
            ...result.raw,
            mediaType: "application/pdf",
            body: "",
            bodyBytes: bytes,
          },
        });

        const rows = yield* sql<{
          readonly body: string;
          readonly body_bytes: Uint8Array;
          readonly body_hash: string;
        }>`
          select body, body_bytes, body_hash
          from public_source_raw_artifacts
          where source_id = 'service_public'
        `;
        expect(rows).toHaveLength(1);
        expect(rows[0]?.body).toBe("");
        expect(Uint8Array.from(rows[0]!.body_bytes)).toEqual(bytes);
        expect(rows[0]?.body_hash).toBe(expectedHash);
      }),
    );
  });

  it("rejects PDF artifacts without exact binary bytes", async () => {
    await runDb(
      Effect.gen(function* () {
        yield* resetDatabase;
        const repository = yield* makePgPublicSourceIngestionRepository();
        const result = ingested("legacy text", new Date("2026-07-07T10:01:00.000Z"));

        yield* repository.startRun(source, { mode: "poll" });
        const exit = yield* Effect.exit(
          repository.storeIngestedItem({
            ...result,
            raw: { ...result.raw, mediaType: "application/pdf" },
          }),
        );
        expect(exit._tag).toBe("Failure");
      }),
    );
  });

  it("rejects media-type substrings that are not exact HTML or PDF base types", async () => {
    await runDb(
      Effect.gen(function* () {
        yield* resetDatabase;
        const repository = yield* makePgPublicSourceIngestionRepository();
        const result = ingested(
          "<article>ambiguous media type</article>",
          new Date("2026-07-07T10:01:00.000Z"),
        );

        yield* repository.startRun(source, { mode: "poll" });
        for (const mediaType of ["text/htmlish", "application/notpdf", "image/pdf-preview"]) {
          const exit = yield* Effect.exit(
            repository.storeIngestedItem({
              ...result,
              raw: { ...result.raw, mediaType },
            }),
          );
          expect(exit._tag).toBe("Failure");
        }
      }),
    );
  });

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
            where i.source_id = 'service_public'
              and i.canonical_url = 'https://example.test/articles/stable'
          `;

        expect(rows).toHaveLength(1);
        expect(rows[0]?.latest_raw_artifact_id).toBe(rows[0]?.document_raw_artifact_id);
        expect(rows[0]?.current_content_hash).toBe(rows[0]?.content_hash);
        expect(rows[0]?.body).toBe("<article>second wrapper around stable text</article>");
      }),
    );
  });

  it("rejects same-ID canonical text and hash drift while keeping the original version", async () => {
    await runDb(
      Effect.gen(function* () {
        yield* resetDatabase;
        const sql = yield* PgClient.PgClient;
        const repository = yield* makePgPublicSourceIngestionRepository();
        const initial = ingested("stable body", new Date("2026-07-07T10:01:00.000Z"));

        yield* repository.startRun(source, { mode: "poll" });
        yield* repository.storeIngestedItem(initial);

        const divergentText =
          "A divergent canonical document body must never reuse its ID. ".repeat(3);
        const divergent = {
          ...initial,
          raw: {
            ...initial.raw,
            body: "<article>divergent raw artifact</article>",
            fetchedAt: new Date("2026-07-07T10:02:00.000Z"),
          },
          document: {
            ...initial.document,
            fetchedAt: new Date("2026-07-07T10:02:00.000Z"),
            text: divergentText,
            textCharCount: divergentText.length,
            contentHash: createHash("sha256").update(divergentText, "utf8").digest("hex"),
          },
        } as const;

        const result = yield* Effect.exit(repository.storeIngestedItem(divergent));
        expect(result._tag).toBe("Failure");

        const rows = yield* sql<{
          readonly text: string;
          readonly content_hash: string;
        }>`
          select text, content_hash
          from public_source_documents
          where document_id = ${initial.document.id}
        `;
        expect(rows).toEqual([
          { text: initial.document.text, content_hash: initial.document.contentHash },
        ]);
      }),
    );
  });

  it("persists backfill poll exclusion and DB-clock retry attempts across repository restart", async () => {
    await runDb(
      Effect.gen(function* () {
        yield* resetDatabase;
        const sql = yield* PgClient.PgClient;
        const item = ingested("candidate", new Date("2026-07-07T10:01:00.000Z")).item;
        const firstRepository = yield* makePgPublicSourceIngestionRepository();
        yield* firstRepository.startRun(source, { mode: "poll" });
        yield* firstRepository.recordDiscoveredItem(item, false);
        const first = yield* firstRepository.getItemState(item.sourceId, item.canonicalUrl);
        expect(first).toMatchObject({ stored: false, pollEligible: false, consecutiveFailures: 0 });

        yield* firstRepository.recordItemFailure(
          {
            status: "failed",
            item,
            error: new Error("temporary upstream outage"),
          },
          new Date("2000-01-01T00:00:00.000Z"),
        );
        const restartedRepository = yield* makePgPublicSourceIngestionRepository();
        const restarted = yield* restartedRepository.getItemState(item.sourceId, item.canonicalUrl);
        expect(restarted).toMatchObject({
          stored: false,
          pollEligible: false,
          consecutiveFailures: 1,
          retryEligible: false,
          lastSuccessfulFetchAt: undefined,
        });
        expect(restarted?.lastFetchedAt?.getTime()).toBeGreaterThan(Date.parse("2026-01-01"));

        const pollItem = {
          ...item,
          canonicalUrl: "https://example.test/articles/poll-candidate",
        };
        yield* restartedRepository.recordDiscoveredItem(pollItem, true);
        yield* restartedRepository.recordItemFailure(
          {
            status: "failed",
            item: pollItem,
            error: new Error("poll outage"),
          },
          new Date("2000-01-01T00:00:00.000Z"),
        );
        const afterPollFailure = yield* firstRepository.getItemState(
          pollItem.sourceId,
          pollItem.canonicalUrl,
        );
        expect(afterPollFailure).toMatchObject({
          pollEligible: true,
          consecutiveFailures: 1,
          retryEligible: false,
        });
        yield* sql`
          update public_source_candidates
          set last_fetched_at = now() - interval '2 minutes'
          where source_id = ${pollItem.sourceId}
            and canonical_url = ${pollItem.canonicalUrl}
        `;
        const retryItems = yield* restartedRepository.getRetryEligibleItems(source);
        expect(retryItems.map((candidate) => candidate.canonicalUrl)).toContain(
          pollItem.canonicalUrl,
        );
      }),
    );
  });

  it("returns a poll candidate left unattempted by a crash", async () => {
    await runDb(
      Effect.gen(function* () {
        yield* resetDatabase;
        const repository = yield* makePgPublicSourceIngestionRepository();
        const candidate = {
          ...ingested("candidate", new Date("2026-07-07T10:01:00.000Z")).item,
          canonicalUrl: "https://example.test/articles/crash-window",
        };

        yield* repository.startRun(source, { mode: "poll" });
        yield* repository.recordDiscoveredItem(candidate, true);

        const retryItems = yield* repository.getRetryEligibleItems(source);
        expect(retryItems.map((item) => item.canonicalUrl)).toContain(candidate.canonicalUrl);
      }),
    );
  });

  it("persists discovery metadata on a 304 while retaining immutable document pointers", async () => {
    await runDb(
      Effect.gen(function* () {
        yield* resetDatabase;
        const sql = yield* PgClient.PgClient;
        const repository = yield* makePgPublicSourceIngestionRepository();
        const initial = ingested("stable body", new Date("2026-07-07T10:01:00.000Z"));

        yield* repository.startRun(source, { mode: "poll" });
        yield* repository.storeIngestedItem(initial);
        const changedItem = {
          ...initial.item,
          title: "Updated title from discovery",
          publishedAt: new Date("2026-07-08T10:00:00.000Z"),
          updatedAt: new Date("2026-07-08T10:00:00.000Z"),
          summary: "Updated summary",
          metadata: { feedVersion: 2 },
        };
        yield* repository.recordUnchangedItem({
          status: "not_modified",
          item: changedItem,
          result: {
            status: "not_modified",
            sourceId: initial.item.sourceId,
            canonicalUrl: initial.item.canonicalUrl,
            fetchedAt: new Date("2026-07-08T10:01:00.000Z"),
            metadata: { etag: '"new-etag"' },
          },
        });

        const itemState = yield* repository.getItemState(
          initial.item.sourceId,
          initial.item.canonicalUrl,
        );
        expect(itemState).toMatchObject({
          title: "Updated title from discovery",
          publishedAt: changedItem.publishedAt,
          updatedAt: changedItem.updatedAt,
          summary: "Updated summary",
          metadata: { feedVersion: 2 },
          validators: { etag: '"new-etag"' },
        });

        const pointers = yield* sql<{
          readonly current_content_hash: string;
          readonly latest_document_id: string;
          readonly latest_raw_artifact_id: string;
        }>`
          select current_content_hash, latest_document_id::text, latest_raw_artifact_id::text
          from public_source_items
          where source_id = 'service_public'
            and canonical_url = 'https://example.test/articles/stable'
        `;
        expect(pointers).toHaveLength(1);
        expect(pointers[0]?.current_content_hash).toBe(initial.document.contentHash);
        expect(pointers[0]?.latest_document_id).toBe(initial.document.id);
        expect(pointers[0]?.latest_raw_artifact_id).toBeTruthy();
      }),
    );
  });
});
