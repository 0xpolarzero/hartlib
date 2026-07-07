import { BunRuntime } from "@effect/platform-bun";
import { PgClient } from "@effect/sql-pg";
import {
  ingestDiscoveredItem,
  makePublicSourceAdapter,
  publicSourceDefinitions,
  type DiscoveredItem,
  type PublicSourceId,
} from "@brief/source-ingestion";
import { Config, Effect, Redacted } from "effect";

type StoredPublicationRow = {
  readonly source_id: PublicSourceId;
  readonly canonical_url: string;
  readonly title: string;
  readonly published_at: Date | null;
  readonly discovered_at: Date;
  readonly text_char_count: number;
  readonly media_type: string;
};

const backfillDays = Number.parseInt(process.env.PUBLIC_SOURCE_STARTUP_BACKFILL_DAYS ?? "7", 10);
const fetchMissing = process.env.PUBLIC_SOURCE_AUDIT_FETCH_MISSING === "1";
const fetchTimeoutMs = Number.parseInt(
  process.env.PUBLIC_SOURCE_AUDIT_FETCH_TIMEOUT_MS ?? "15000",
  10,
);
const now = new Date();
const since = new Date(now.getTime() - backfillDays * 24 * 60 * 60 * 1000);

const itemDate = (item: DiscoveredItem): Date | undefined =>
  item.publishedAt ?? item.discoveredAt ?? undefined;

const isEligible = (item: DiscoveredItem): boolean => {
  if (item.publishedAt !== null) {
    return item.publishedAt >= since;
  }

  return item.discoveredAt === undefined || item.discoveredAt >= since;
};

const orderedUniqueItems = (items: readonly DiscoveredItem[]): readonly DiscoveredItem[] =>
  [...new Map(items.map((item) => [item.canonicalUrl, item])).values()].sort((left, right) => {
    const leftDate = itemDate(left)?.getTime() ?? 0;
    const rightDate = itemDate(right)?.getTime() ?? 0;
    return rightDate - leftDate || left.canonicalUrl.localeCompare(right.canonicalUrl);
  });

const PgLayer = PgClient.layerConfig({
  url: Config.string("DATABASE_URL").pipe(
    Config.withDefault("postgres://brief:brief@localhost:5432/brief"),
    Config.map(Redacted.make),
  ),
  applicationName: Config.succeed("brief-public-source-completeness-audit"),
});

const storedPublications = (sourceId: PublicSourceId) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<StoredPublicationRow>`
      select
        i.source_id,
        i.canonical_url,
        i.title,
        i.published_at,
        i.discovered_at,
        d.text_char_count,
        r.media_type
      from public_source_items i
      join public_source_documents d
        on d.document_id = i.latest_document_id
       and d.source_id = i.source_id
       and d.canonical_url = i.canonical_url
       and d.content_hash = i.current_content_hash
       and d.raw_artifact_id = i.latest_raw_artifact_id
      join public_source_raw_artifacts r
        on r.id = i.latest_raw_artifact_id
       and r.source_id = i.source_id
       and r.canonical_url = i.canonical_url
      where i.source_id = ${sourceId}
        and coalesce(i.published_at, i.discovered_at) >= ${since}
        and d.text_char_count >= 100
        and (
          lower(r.media_type) like '%html%'
          or lower(r.media_type) like '%pdf%'
        )
      order by coalesce(i.published_at, i.discovered_at) desc, i.title asc
    `;
    return new Map(rows.map((row) => [row.canonical_url, row]));
  });

const auditSource = (sourceId: PublicSourceId) =>
  Effect.gen(function* () {
    const adapter = makePublicSourceAdapter(sourceId);
    const discovery = yield* adapter.discover();
    if (discovery.status !== "fetched") {
      return yield* Effect.fail(new Error(`${sourceId}: discovery returned not_modified`));
    }

    const expected = orderedUniqueItems(discovery.items.filter(isEligible));
    const stored = yield* storedPublications(sourceId);
    const missing = expected.filter((item) => !stored.has(item.canonicalUrl));
    const unexpected = [...stored.keys()].filter(
      (canonicalUrl) => !expected.some((item) => item.canonicalUrl === canonicalUrl),
    );
    const missingFetchResults = fetchMissing
      ? yield* Effect.all(
          missing.map((item) =>
            ingestDiscoveredItem(adapter, item).pipe(
              Effect.timeout(`${fetchTimeoutMs} millis`),
              Effect.map((result) => ({
                item,
                status: result.status,
                detail:
                  result.status === "ingested"
                    ? `${result.raw.mediaType}, ${result.document.textCharCount} chars`
                    : result.status === "failed"
                      ? result.error.message
                      : "not_modified",
              })),
              Effect.catch((error) =>
                Effect.succeed({
                  item,
                  status: "failed" as const,
                  detail: error instanceof Error ? error.message : String(error),
                }),
              ),
            ),
          ),
          { concurrency: 1 },
        )
      : [];

    return {
      sourceId,
      expectedCount: expected.length,
      storedCount: stored.size,
      missing,
      unexpected,
      missingFetchResults,
    };
  });

const program = Effect.gen(function* () {
  const results = yield* Effect.all(
    publicSourceDefinitions.map((definition) => auditSource(definition.id)),
    { concurrency: 1 },
  );

  const failed = results.filter(
    (result) => result.missing.length > 0 || result.unexpected.length > 0,
  );

  console.log(`Public source completeness audit`);
  console.log(`Window: ${since.toISOString()} -> ${now.toISOString()}`);
  for (const result of results) {
    console.log(
      `${result.sourceId}: expected=${result.expectedCount} stored=${result.storedCount} missing=${result.missing.length} unexpected=${result.unexpected.length}`,
    );
    for (const item of result.missing.slice(0, 20)) {
      console.log(
        `  missing ${item.publishedAt?.toISOString() ?? item.discoveredAt?.toISOString() ?? "undated"} ${item.title} ${item.canonicalUrl}`,
      );
    }
    for (const fetchResult of result.missingFetchResults.slice(0, 20)) {
      console.log(
        `  fetch ${fetchResult.status} ${fetchResult.detail} ${fetchResult.item.canonicalUrl}`,
      );
    }
    for (const canonicalUrl of result.unexpected.slice(0, 20)) {
      console.log(`  unexpected ${canonicalUrl}`);
    }
  }

  if (failed.length > 0) {
    return yield* Effect.fail(
      new Error(
        `public source completeness audit failed for ${failed.map((result) => result.sourceId).join(", ")}`,
      ),
    );
  }
});

BunRuntime.runMain(program.pipe(Effect.provide(PgLayer)));
