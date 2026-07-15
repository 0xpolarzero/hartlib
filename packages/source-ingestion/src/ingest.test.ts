import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { discoverSource, discoverSourceItems, ingestDiscoveredItem, ingestSource } from "./ingest";
import { SourceIngestionError, type SourceAdapter } from "./types";

const adapter = {
  definition: {
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
  },
  discover: () =>
    Effect.succeed({
      status: "fetched",
      discoveredAt: new Date("2026-07-06T08:00:00Z"),
      metadata: [
        {
          url: "https://example.test/service-public.xml",
          status: 200,
          etag: '"feed-cache"',
        },
      ],
      items: [
        {
          sourceId: "service_public",
          externalId: "article-1",
          canonicalUrl: "https://example.test/articles/1",
          title: "Government update",
          publishedAt: null,
        },
      ],
    }),
  fetch: (item, options) =>
    Effect.succeed({
      status: "fetched",
      raw: {
        sourceId: "service_public",
        canonicalUrl: item.canonicalUrl,
        fetchedAt: new Date("2026-07-06T10:00:00Z"),
        mediaType: "text/html",
        body: "<main>Useful public text.</main>",
        metadata: {
          externalId: item.externalId,
          requestedEtag: options?.validators?.etag,
        },
      },
    }),
  normalize: (raw, item) =>
    Effect.succeed({
      id: "service_public:version",
      sourceId: "service_public",
      ...(item?.externalId ? { externalId: item.externalId } : {}),
      canonicalUrl: raw.canonicalUrl,
      title: item?.title ?? raw.canonicalUrl,
      publishedAt: item?.publishedAt ?? null,
      discoveredAt: item?.discoveredAt ?? raw.fetchedAt,
      fetchedAt: raw.fetchedAt,
      language: "fr",
      documentType: "article",
      text: "Useful public text.",
      textCharCount: 19,
      contentHash: "hash",
      rawArtifactKey: "service_public/hash",
      sourceMetadata: raw.metadata ?? {},
    }),
} satisfies SourceAdapter;

describe("source ingestion helpers", () => {
  it("returns typed discovery metadata", async () => {
    const discoveredAt = new Date("2026-07-06T09:00:00Z");
    const discovery = await Effect.runPromise(discoverSource(adapter, { now: () => discoveredAt }));

    expect(discovery).toMatchObject({
      status: "fetched",
      discoveredAt,
      metadata: [
        {
          url: "https://example.test/service-public.xml",
          status: 200,
          etag: '"feed-cache"',
        },
      ],
    });
    if (discovery.status !== "fetched") {
      throw new Error("expected fetched discovery");
    }
    expect(discovery.items[0]?.discoveredAt).toBe(discoveredAt);
  });

  it("stamps discovered items once per discovery run", async () => {
    const discoveredAt = new Date("2026-07-06T09:00:00Z");
    const items = await Effect.runPromise(discoverSourceItems(adapter, () => discoveredAt));

    expect(items[0]?.discoveredAt).toBe(discoveredAt);
  });

  it("fetches and normalizes one discovered item", async () => {
    const [item] = await Effect.runPromise(discoverSourceItems(adapter));
    const result = await Effect.runPromise(
      ingestDiscoveredItem(adapter, item!, { validators: { etag: '"abc123"' } }),
    );

    expect(result.status).toBe("ingested");
    if (result.status !== "ingested") {
      throw new Error("expected ingested result");
    }
    expect(result.raw.metadata).toMatchObject({ requestedEtag: '"abc123"' });
    expect(result.document).toMatchObject({
      sourceId: "service_public",
      canonicalUrl: "https://example.test/articles/1",
      text: "Useful public text.",
    });
  });

  it("composes discovery, fetch, and normalization for a source", async () => {
    const results = await Effect.runPromise(ingestSource(adapter));

    expect(results).toHaveLength(1);
    expect(results[0]?.item.externalId).toBe("article-1");
    expect(results[0]?.status).toBe("ingested");
    if (results[0]?.status !== "ingested") {
      throw new Error("expected ingested result");
    }
    expect(results[0].document.rawArtifactKey).toBe("service_public/hash");
  });

  it("does not fetch items when discovery reports unchanged", async () => {
    const unchangedDiscoveryAdapter = {
      ...adapter,
      discover: () =>
        Effect.succeed({
          status: "not_modified",
          sourceId: "service_public",
          discoveredAt: new Date("2026-07-06T08:00:00Z"),
          metadata: [
            {
              url: "https://example.test/service-public.xml",
              status: 304,
              etag: '"feed-cache"',
            },
          ],
        }),
      fetch: () => Effect.fail(new Error("fetch should not run")),
    } satisfies SourceAdapter;

    const results = await Effect.runPromise(ingestSource(unchangedDiscoveryAdapter));

    expect(results).toEqual([]);
  });

  it("isolates item failures when ingesting a source", async () => {
    const partiallyFailingAdapter = {
      ...adapter,
      discover: () =>
        Effect.succeed({
          status: "fetched",
          discoveredAt: new Date("2026-07-06T08:00:00Z"),
          metadata: [{ url: "https://example.test/service-public.xml", status: 200 }],
          items: [
            {
              sourceId: "service_public",
              externalId: "article-1",
              canonicalUrl: "https://example.test/articles/1",
              title: "Government update",
              publishedAt: null,
            },
            {
              sourceId: "service_public",
              externalId: "article-404",
              canonicalUrl: "https://example.test/articles/404",
              title: "Missing update",
              publishedAt: null,
            },
          ],
        }),
      fetch: (item) =>
        item.externalId === "article-404"
          ? Effect.fail(
              new SourceIngestionError("Item fetch failed with HTTP 404", {
                sourceId: "service_public",
              }),
            )
          : adapter.fetch(item, undefined),
    } satisfies SourceAdapter;

    const results = await Effect.runPromise(ingestSource(partiallyFailingAdapter));

    expect(results).toHaveLength(2);
    expect(results.map((result) => result.status)).toEqual(["ingested", "failed"]);
    expect(results[1]).toMatchObject({
      status: "failed",
      item: {
        externalId: "article-404",
      },
    });
  });

  it("skips normalization when fetch reports an unchanged item", async () => {
    const unchangedAdapter = {
      ...adapter,
      fetch: (item) =>
        Effect.succeed({
          status: "not_modified",
          sourceId: "service_public",
          canonicalUrl: item.canonicalUrl,
          fetchedAt: new Date("2026-07-06T10:00:00Z"),
          metadata: { externalId: item.externalId },
        }),
      normalize: () => Effect.fail(new Error("normalize should not run")),
    } satisfies SourceAdapter;
    const [item] = await Effect.runPromise(discoverSourceItems(unchangedAdapter));
    const result = await Effect.runPromise(ingestDiscoveredItem(unchangedAdapter, item!));

    expect(result).toMatchObject({
      status: "not_modified",
      item: {
        externalId: "article-1",
      },
      result: {
        canonicalUrl: "https://example.test/articles/1",
      },
    });
  });
});
