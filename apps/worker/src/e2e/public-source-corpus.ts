import { Effect } from "effect";
import { createHash } from "node:crypto";
import type {
  CanonicalDocument,
  DiscoveredItem,
  PublicSourceDefinition,
  PublicSourceId,
  SourceAdapter,
  SourceDiscoveryResult,
  SourceFetchResult,
} from "@brief/source-ingestion";

/**
 * The Playwright corpus is a local connector, not a second persistence path.
 * It has the same adapter boundary as production connectors but never performs
 * network I/O.  Keeping it here makes the E2E stack deterministic while the
 * worker orchestrator and Postgres repository remain the code that discovers,
 * fetches, normalizes, and stores public-source content.
 */
export type E2ePublicSourceCorpusItem = {
  readonly sourceId: string;
  readonly displayName: string;
  readonly publisherName: string;
  readonly documentId: string;
  readonly title: string;
  readonly canonicalUrl: string;
  readonly publishedAt: string;
  readonly text: string;
};

const asPublicSourceId = (sourceId: string): PublicSourceId => sourceId as PublicSourceId;

const asPublicSourceDefinition = (item: E2ePublicSourceCorpusItem): PublicSourceDefinition => ({
  id: asPublicSourceId(item.sourceId),
  displayName: item.displayName,
  publisherName: item.publisherName,
  description: "Corpus public Playwright E2E",
  country: "FR",
  language: "fr-FR",
  ingestionMethod: "official_document",
  discoveryUrl: `${item.canonicalUrl}/feed`,
  canonicalUrlOrigins: ["https://e2e.example"],
  fetchOrigins: ["https://e2e.example"],
  contentFormats: ["html", "text"],
  averageCharsPerItem: 1200,
});

const asDiscoveredItem = (item: E2ePublicSourceCorpusItem, discoveredAt: Date): DiscoveredItem => ({
  sourceId: asPublicSourceId(item.sourceId),
  externalId: item.documentId,
  canonicalUrl: item.canonicalUrl,
  title: item.title,
  publishedAt: new Date(item.publishedAt),
  discoveredAt,
  summary: item.text.slice(0, 220),
});

const normalize = (
  item: E2ePublicSourceCorpusItem,
  discoveredItem: DiscoveredItem,
  fetchedAt: Date,
): CanonicalDocument => ({
  id: item.documentId,
  sourceId: asPublicSourceId(item.sourceId),
  externalId: item.documentId,
  canonicalUrl: item.canonicalUrl,
  title: item.title,
  publishedAt: new Date(item.publishedAt),
  discoveredAt: discoveredItem.discoveredAt ?? fetchedAt,
  fetchedAt,
  language: "fr",
  documentType: "article",
  text: item.text,
  textCharCount: item.text.length,
  contentHash: createHash("sha256").update(item.text).digest("hex"),
  rawArtifactKey: `e2e-local/${item.documentId}`,
  sourceMetadata: { connector: "e2e-local", discoveryUrl: `${item.canonicalUrl}/feed` },
});

const makeAdapter = (item: E2ePublicSourceCorpusItem, now: Date): SourceAdapter => {
  const definition = asPublicSourceDefinition(item);
  const discoveredItem = asDiscoveredItem(item, now);

  return {
    definition,
    discover: (): Effect.Effect<SourceDiscoveryResult> =>
      Effect.succeed({
        status: "fetched",
        items: [discoveredItem],
        discoveredAt: now,
        metadata: [
          {
            url: definition.discoveryUrl,
            status: 200,
            bodyHash: `e2e-discovery-${item.documentId}`,
          },
        ],
      }),
    fetch: (candidate): Effect.Effect<SourceFetchResult> =>
      Effect.succeed({
        status: "fetched",
        raw: {
          sourceId: candidate.sourceId,
          canonicalUrl: candidate.canonicalUrl,
          fetchedAt: now,
          mediaType: "text/html",
          body: item.text,
          metadata: { connector: "e2e-local" },
        },
      }),
    normalize: (_raw, candidate): Effect.Effect<CanonicalDocument> =>
      Effect.succeed(normalize(item, candidate ?? discoveredItem, now)),
  };
};

export const makeE2ePublicSourceAdapters = (
  corpus: readonly E2ePublicSourceCorpusItem[],
  now: Date,
): readonly SourceAdapter[] => corpus.map((item) => makeAdapter(item, now));
