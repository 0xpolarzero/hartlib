import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type {
  DiscoveredItem,
  RawArtifact,
  SourceAdapter,
  SourceFetchOptions,
} from "@brief/source-ingestion";
import { SourceIngestionError } from "@brief/source-ingestion";
import {
  InMemoryPublicSourceIngestionRepositoryLayer,
  makeInMemoryPublicSourceIngestionRepository,
  PublicSourceIngestionRepository,
  type InMemoryPublicSourceIngestionState,
} from "./repository";
import { runPublicSourceIngestion } from "./orchestrator";

const definition = {
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
} as const;

const makeState = (): InMemoryPublicSourceIngestionState => ({
  sources: new Map(),
  candidates: new Map(),
  items: new Map(),
  rawArtifacts: new Map(),
  documents: new Map(),
  runs: [],
});

const item = (input: {
  readonly id: string;
  readonly url?: string;
  readonly publishedAt?: string;
  readonly discoveredAt?: string;
  readonly updatedAt?: string;
  readonly metadata?: Record<string, unknown>;
}): DiscoveredItem => ({
  sourceId: "service_public",
  externalId: input.id,
  canonicalUrl: input.url ?? `https://example.test/articles/${input.id}`,
  title: `Article ${input.id}`,
  publishedAt: input.publishedAt ? new Date(input.publishedAt) : null,
  ...(input.discoveredAt ? { discoveredAt: new Date(input.discoveredAt) } : {}),
  ...(input.updatedAt ? { updatedAt: new Date(input.updatedAt) } : {}),
  ...(input.metadata ? { metadata: input.metadata } : {}),
});

const readableBody = (label: string): string =>
  `<main>${label} with enough readable official content to satisfy the public source publication invariant and prove that a complete stored artifact backs the visible publication.</main>`;

const adapterWith = (options: {
  readonly items: readonly DiscoveredItem[];
  readonly discoveryStatus?: "fetched" | "not_modified";
  readonly fetch?: (
    item: DiscoveredItem,
    options?: SourceFetchOptions,
  ) => ReturnType<SourceAdapter["fetch"]>;
  readonly discover?: SourceAdapter["discover"];
  readonly hashForBody?: (body: string) => string;
}): SourceAdapter => ({
  definition,
  discover:
    options.discover ??
    ((discoveryOptions) =>
      Effect.succeed(
        options.discoveryStatus === "not_modified"
          ? {
              status: "not_modified",
              sourceId: definition.id,
              discoveredAt: new Date("2026-07-06T10:00:00.000Z"),
              metadata: [
                {
                  url: definition.discoveryUrl,
                  status: 304,
                  etag: discoveryOptions?.requests?.[0]?.validators?.etag ?? '"feed-a"',
                },
              ],
            }
          : {
              status: "fetched",
              discoveredAt: new Date("2026-07-06T10:00:00.000Z"),
              metadata: [
                {
                  url: definition.discoveryUrl,
                  status: 200,
                  etag: discoveryOptions?.requests?.[0]?.validators?.etag ? '"feed-b"' : '"feed-a"',
                  bodyHash: "feed-body",
                },
              ],
              items: options.items,
            },
      )),
  fetch:
    options.fetch ??
    ((discovered) =>
      Effect.succeed({
        status: "fetched",
        raw: {
          sourceId: "service_public",
          canonicalUrl: discovered.canonicalUrl,
          fetchedAt: new Date("2026-07-06T10:01:00.000Z"),
          mediaType: "text/html",
          body: readableBody(discovered.title),
          metadata: {
            externalId: discovered.externalId,
            etag: `"${discovered.externalId}-etag"`,
          },
        },
      })),
  normalize: (raw: RawArtifact, discovered) =>
    Effect.succeed({
      id: `service_public:${discovered?.externalId}:${options.hashForBody?.(raw.body) ?? raw.body}`,
      sourceId: "service_public",
      ...(discovered?.externalId ? { externalId: discovered.externalId } : {}),
      canonicalUrl: raw.canonicalUrl,
      title: discovered?.title ?? raw.canonicalUrl,
      publishedAt: discovered?.publishedAt ?? null,
      discoveredAt: discovered?.discoveredAt ?? raw.fetchedAt,
      fetchedAt: raw.fetchedAt,
      language: "fr",
      documentType: "article",
      text: raw.body,
      textCharCount: raw.body.length,
      contentHash: options.hashForBody?.(raw.body) ?? raw.body,
      rawArtifactKey: `service_public/${options.hashForBody?.(raw.body) ?? raw.body}`,
      sourceMetadata: raw.metadata ?? {},
    }),
});

const runWithState = (
  adapter: SourceAdapter,
  state: InMemoryPublicSourceIngestionState,
  options: Parameters<typeof runPublicSourceIngestion>[1],
) =>
  Effect.runPromise(
    runPublicSourceIngestion(adapter, options).pipe(
      Effect.provide(InMemoryPublicSourceIngestionRepositoryLayer(state)),
    ),
  );

describe("public source ingestion orchestration", () => {
  it("marks the durable run failed when source discovery times out", async () => {
    const state = makeState();

    await expect(
      Effect.runPromise(
        runPublicSourceIngestion(
          adapterWith({
            items: [],
            discover: () => Effect.never,
          }),
          {
            mode: "poll",
            operationTimeoutMs: 5,
          },
        ).pipe(Effect.provide(InMemoryPublicSourceIngestionRepositoryLayer(state))),
      ),
    ).rejects.toThrow("public source discovery timed out for service_public after 5ms");

    expect(state.runs[0]).toMatchObject({
      status: "failed",
      error: "public source discovery timed out for service_public after 5ms",
    });
  });

  it("rejects unsafe discovery provenance before candidate persistence or item fetch", async () => {
    const state = makeState();
    let fetched = false;

    await expect(
      runWithState(
        adapterWith({
          items: [item({ id: "unsafe", url: "https://127.0.0.1/latest/meta-data" })],
          fetch: () => {
            fetched = true;
            return Effect.die(new Error("unsafe item must not be fetched"));
          },
        }),
        state,
        { mode: "poll" },
      ),
    ).rejects.toThrow("invalid provenance URL");

    expect(fetched).toBe(false);
    expect(state.candidates.size).toBe(0);
    expect(state.items.size).toBe(0);
    expect(state.runs[0]).toMatchObject({
      status: "failed",
      error: "public source discovery returned an invalid provenance URL",
    });
  });

  it("startup backfill stores only recently published items from the current source response", async () => {
    const state = makeState();
    const stats = await runWithState(
      adapterWith({
        items: [
          item({ id: "recent", publishedAt: "2026-07-05T00:00:00.000Z" }),
          item({ id: "old", publishedAt: "2026-06-20T00:00:00.000Z" }),
        ],
      }),
      state,
      {
        mode: "backfill",
        since: new Date("2026-06-29T00:00:00.000Z"),
        now: () => new Date("2026-07-06T10:00:00.000Z"),
      },
    );

    expect(stats).toMatchObject({
      discoveredCount: 1,
      fetchedCount: 1,
      storedDocumentCount: 1,
      failedCount: 0,
    });
    expect([...state.documents.keys()]).toHaveLength(1);
    expect([...state.documents.keys()].some((key) => key.includes("recent"))).toBe(true);
    expect([...state.documents.keys()].some((key) => key.includes("old"))).toBe(false);
    expect(state.items.has("service_public\nhttps://example.test/articles/old")).toBe(false);
    expect(state.candidates.has("service_public\nhttps://example.test/articles/old")).toBe(true);
  });

  it("startup backfill excludes old published items even when they were discovered recently", async () => {
    const state = makeState();
    const stats = await runWithState(
      adapterWith({
        items: [
          item({
            id: "old-but-newly-discovered",
            publishedAt: "2026-06-20T00:00:00.000Z",
            discoveredAt: "2026-07-05T00:00:00.000Z",
          }),
        ],
      }),
      state,
      {
        mode: "backfill",
        since: new Date("2026-06-29T00:00:00.000Z"),
        now: () => new Date("2026-07-06T10:00:00.000Z"),
      },
    );

    expect(stats).toMatchObject({
      discoveredCount: 0,
      fetchedCount: 0,
      storedDocumentCount: 0,
      failedCount: 0,
    });
    expect([...state.documents.keys()]).toHaveLength(0);
    expect(
      state.items.has("service_public\nhttps://example.test/articles/old-but-newly-discovered"),
    ).toBe(false);
    expect(
      state.candidates.has(
        "service_public\nhttps://example.test/articles/old-but-newly-discovered",
      ),
    ).toBe(true);
  });

  it("polling does not import old backlog items already seen during startup backfill", async () => {
    const state = makeState();
    await runWithState(
      adapterWith({
        items: [item({ id: "old-backlog", publishedAt: "2026-06-20T00:00:00.000Z" })],
      }),
      state,
      {
        mode: "backfill",
        since: new Date("2026-06-29T00:00:00.000Z"),
        now: () => new Date("2026-07-06T10:00:00.000Z"),
      },
    );

    const stats = await runWithState(
      adapterWith({
        items: [item({ id: "old-backlog", publishedAt: "2026-06-20T00:00:00.000Z" })],
      }),
      state,
      {
        mode: "poll",
        since: new Date("2026-06-29T00:00:00.000Z"),
        now: () => new Date("2026-07-06T10:05:00.000Z"),
      },
    );

    expect(stats).toMatchObject({
      discoveredCount: 0,
      fetchedCount: 0,
      storedDocumentCount: 0,
      failedCount: 0,
    });
    expect([...state.documents.keys()]).toHaveLength(0);
  });

  it("polling stores genuinely new items after startup even when their publication date is old", async () => {
    const state = makeState();
    await runWithState(
      adapterWith({
        items: [item({ id: "old-baseline", publishedAt: "2026-06-20T00:00:00.000Z" })],
      }),
      state,
      {
        mode: "backfill",
        since: new Date("2026-06-29T00:00:00.000Z"),
        now: () => new Date("2026-07-06T10:00:00.000Z"),
      },
    );

    const stats = await runWithState(
      adapterWith({
        items: [
          item({ id: "old-baseline", publishedAt: "2026-06-20T00:00:00.000Z" }),
          item({ id: "new-after-baseline", publishedAt: "2026-06-21T00:00:00.000Z" }),
        ],
      }),
      state,
      {
        mode: "poll",
        since: new Date("2026-06-29T00:00:00.000Z"),
        now: () => new Date("2026-07-06T10:05:00.000Z"),
      },
    );

    expect(stats).toMatchObject({
      discoveredCount: 1,
      fetchedCount: 1,
      storedDocumentCount: 1,
      failedCount: 0,
    });
    expect([...state.documents.keys()][0]).toContain("new-after-baseline");
  });

  it("startup backfill includes recently discovered undated items", async () => {
    const state = makeState();
    const stats = await runWithState(
      adapterWith({
        items: [
          item({
            id: "undated-but-newly-discovered",
            discoveredAt: "2026-07-05T00:00:00.000Z",
          }),
        ],
      }),
      state,
      {
        mode: "backfill",
        since: new Date("2026-06-29T00:00:00.000Z"),
        now: () => new Date("2026-07-06T10:00:00.000Z"),
      },
    );

    expect(stats).toMatchObject({
      discoveredCount: 1,
      fetchedCount: 1,
      storedDocumentCount: 1,
      failedCount: 0,
    });
    expect([...state.documents.keys()][0]).toContain("undated-but-newly-discovered");
  });

  it("startup backfill fetches recent incomplete items even when discovery is unchanged", async () => {
    const state = makeState();
    await runWithState(
      adapterWith({
        items: [item({ id: "missing", publishedAt: "2026-07-05T00:00:00.000Z" })],
        fetch: () =>
          Effect.fail(
            new SourceIngestionError("temporary fetch failure", {
              sourceId: "service_public",
            }),
          ),
      }),
      state,
      {
        mode: "backfill",
        since: new Date("2026-06-29T00:00:00.000Z"),
        now: () => new Date("2026-07-06T10:00:00.000Z"),
      },
    );

    const stats = await runWithState(
      adapterWith({
        discoveryStatus: "not_modified",
        items: [],
      }),
      state,
      {
        mode: "backfill",
        since: new Date("2026-06-29T00:00:00.000Z"),
        now: () => new Date("2026-07-06T10:05:00.000Z"),
      },
    );

    expect(stats).toMatchObject({
      discoveredCount: 1,
      fetchedCount: 1,
      storedDocumentCount: 1,
      failedCount: 0,
    });
    expect([...state.documents.keys()][0]).toContain("missing");
  });

  it("startup backfill includes incomplete undated items when discovery is unchanged", async () => {
    const state = makeState();
    await runWithState(
      adapterWith({
        items: [item({ id: "undated" })],
        fetch: () =>
          Effect.fail(
            new SourceIngestionError("temporary fetch failure", {
              sourceId: "service_public",
            }),
          ),
      }),
      state,
      {
        mode: "backfill",
        since: new Date("2026-06-29T00:00:00.000Z"),
        now: () => new Date("2026-07-06T10:00:00.000Z"),
      },
    );

    const stats = await runWithState(
      adapterWith({
        discoveryStatus: "not_modified",
        items: [],
      }),
      state,
      {
        mode: "backfill",
        since: new Date("2026-06-29T00:00:00.000Z"),
        now: () => new Date("2026-07-06T10:05:00.000Z"),
      },
    );

    expect(stats).toMatchObject({
      discoveredCount: 1,
      fetchedCount: 1,
      storedDocumentCount: 1,
      failedCount: 0,
    });
    expect([...state.documents.keys()][0]).toContain("undated");
  });

  it("startup backfill refetches recent items missing a raw artifact even when discovery is unchanged", async () => {
    const state = makeState();
    const calls: Array<SourceFetchOptions | undefined> = [];
    await runWithState(
      adapterWith({
        items: [item({ id: "missing-raw", publishedAt: "2026-07-05T00:00:00.000Z" })],
      }),
      state,
      {
        mode: "backfill",
        since: new Date("2026-06-29T00:00:00.000Z"),
        now: () => new Date("2026-07-06T10:00:00.000Z"),
      },
    );
    const key = "service_public\nhttps://example.test/articles/missing-raw";
    const existing = state.items.get(key);
    if (!existing) {
      throw new Error("expected seeded item state");
    }
    state.candidates.set(key, { ...existing, latestRawArtifactId: undefined });
    state.items.delete(key);

    const stats = await runWithState(
      adapterWith({
        discoveryStatus: "not_modified",
        items: [],
        fetch: (discovered, options) => {
          calls.push(options);
          return Effect.succeed({
            status: "fetched",
            raw: {
              sourceId: "service_public",
              canonicalUrl: discovered.canonicalUrl,
              fetchedAt: new Date("2026-07-06T10:06:00.000Z"),
              mediaType: "text/html",
              body: readableBody(discovered.title),
              metadata: {
                externalId: discovered.externalId,
                etag: `"${discovered.externalId}-etag"`,
              },
            },
          });
        },
      }),
      state,
      {
        mode: "backfill",
        since: new Date("2026-06-29T00:00:00.000Z"),
        now: () => new Date("2026-07-06T10:05:00.000Z"),
      },
    );

    expect(stats).toMatchObject({
      discoveredCount: 1,
      fetchedCount: 1,
      storedDocumentCount: 0,
      failedCount: 0,
    });
    expect(calls[0]?.validators).toBeUndefined();
  });

  it("backfill skips complete metadata-unchanged publications", async () => {
    const state = makeState();
    let fetchCount = 0;
    const adapter = adapterWith({
      items: [item({ id: "backfill-stable", publishedAt: "2026-07-05T00:00:00.000Z" })],
      fetch: (discovered) => {
        fetchCount += 1;
        return Effect.succeed({
          status: "fetched",
          raw: {
            sourceId: "service_public",
            canonicalUrl: discovered.canonicalUrl,
            fetchedAt: new Date("2026-07-06T10:01:00.000Z"),
            mediaType: "text/html",
            body: readableBody("stable backfill body"),
          },
        });
      },
      hashForBody: () => "stable-backfill-hash",
    });
    const options = {
      mode: "backfill" as const,
      since: new Date("2026-06-29T00:00:00.000Z"),
      now: () => new Date("2026-07-06T10:00:00.000Z"),
    };

    await runWithState(adapter, state, options);
    const second = await runWithState(adapter, state, options);

    expect(fetchCount).toBe(1);
    expect(second).toMatchObject({ fetchedCount: 0, unchangedCount: 0, storedDocumentCount: 0 });
  });

  it("startup backfill bypasses validators for known incomplete items even when rediscovered", async () => {
    const state = makeState();
    const calls: Array<SourceFetchOptions | undefined> = [];
    await runWithState(
      adapterWith({
        items: [item({ id: "rediscovered-missing", publishedAt: "2026-07-05T00:00:00.000Z" })],
      }),
      state,
      {
        mode: "backfill",
        since: new Date("2026-06-29T00:00:00.000Z"),
        now: () => new Date("2026-07-06T10:00:00.000Z"),
      },
    );
    const key = "service_public\nhttps://example.test/articles/rediscovered-missing";
    const existing = state.items.get(key);
    if (!existing) {
      throw new Error("expected seeded item state");
    }
    state.candidates.set(key, { ...existing, latestRawArtifactId: undefined });
    state.items.delete(key);

    const stats = await runWithState(
      adapterWith({
        items: [item({ id: "rediscovered-missing", publishedAt: "2026-07-05T00:00:00.000Z" })],
        fetch: (discovered, options) => {
          calls.push(options);
          return Effect.succeed({
            status: "fetched",
            raw: {
              sourceId: "service_public",
              canonicalUrl: discovered.canonicalUrl,
              fetchedAt: new Date("2026-07-06T10:06:00.000Z"),
              mediaType: "text/html",
              body: readableBody(discovered.title),
              metadata: {
                externalId: discovered.externalId,
                etag: `"${discovered.externalId}-etag-2"`,
              },
            },
          });
        },
      }),
      state,
      {
        mode: "backfill",
        since: new Date("2026-06-29T00:00:00.000Z"),
        now: () => new Date("2026-07-06T10:05:00.000Z"),
      },
    );

    expect(stats).toMatchObject({
      discoveredCount: 1,
      fetchedCount: 1,
      storedDocumentCount: 0,
      failedCount: 0,
    });
    expect(calls[0]?.validators).toBeUndefined();
  });

  it("recurring polling stores newly discovered items", async () => {
    const state = makeState();
    await runWithState(
      adapterWith({ items: [item({ id: "first", publishedAt: "2026-07-05T00:00:00.000Z" })] }),
      state,
      { mode: "poll" },
    );
    const stats = await runWithState(
      adapterWith({
        items: [
          item({ id: "first", publishedAt: "2026-07-05T00:00:00.000Z" }),
          item({ id: "second", publishedAt: "2026-07-06T00:00:00.000Z" }),
        ],
      }),
      state,
      { mode: "poll" },
    );

    expect(stats.discoveredCount).toBe(2);
    expect(stats.unchangedCount).toBe(1);
    expect(stats.storedDocumentCount).toBe(1);
    expect([...state.documents.keys()].some((key) => key.includes("second"))).toBe(true);
  });

  it("skips page fetches for unchanged complete poll items", async () => {
    const state = makeState();
    let fetchCount = 0;
    const adapter = adapterWith({
      items: [item({ id: "same", publishedAt: "2026-07-05T00:00:00.000Z" })],
      fetch: (discovered) => {
        fetchCount += 1;
        return Effect.succeed({
          status: "fetched",
          raw: {
            sourceId: "service_public",
            canonicalUrl: discovered.canonicalUrl,
            fetchedAt: new Date("2026-07-06T10:01:00.000Z"),
            mediaType: "text/html",
            body: readableBody("stable body"),
          },
        });
      },
      hashForBody: () => "stable-hash",
    });

    await runWithState(adapter, state, { mode: "poll" });
    const stats = await runWithState(adapter, state, { mode: "poll" });

    expect(stats.fetchedCount).toBe(0);
    expect(stats.unchangedCount).toBe(1);
    expect(stats.storedDocumentCount).toBe(0);
    expect(fetchCount).toBe(1);
    expect(state.documents.size).toBe(1);
    expect(state.rawArtifacts.size).toBe(1);
  });

  it("treats the transient Service-Public XML body as unchanged durable metadata", async () => {
    const state = makeState();
    let fetchCount = 0;
    const discovered = item({
      id: "embedded-xml",
      publishedAt: "2026-07-05T00:00:00.000Z",
      metadata: {
        audience: "part",
        xmlUrl: "https://example.test/xml/actualites/embedded-xml.xml",
        xmlBody: "<publication><title>Stable official body</title></publication>",
      },
    });
    const adapter = adapterWith({
      items: [discovered],
      fetch: (item) => {
        fetchCount += 1;
        return Effect.succeed({
          status: "fetched",
          raw: {
            sourceId: "service_public",
            canonicalUrl: item.canonicalUrl,
            fetchedAt: new Date("2026-07-06T10:01:00.000Z"),
            mediaType: "text/html",
            body: readableBody("stable embedded XML"),
          },
        });
      },
      hashForBody: () => "stable-xml-hash",
    });

    await runWithState(adapter, state, { mode: "poll" });
    const stats = await runWithState(adapter, state, { mode: "poll" });

    expect(stats).toMatchObject({ fetchedCount: 0, unchangedCount: 1, storedDocumentCount: 0 });
    expect(fetchCount).toBe(1);
    expect(
      state.items.get("service_public\nhttps://example.test/articles/embedded-xml")?.item.metadata,
    ).toEqual({
      audience: "part",
      xmlUrl: "https://example.test/xml/actualites/embedded-xml.xml",
    });
  });

  it("treats stored undated items as complete when they have artifacts and content", async () => {
    const state = makeState();
    let fetchCount = 0;
    const adapter = adapterWith({
      items: [item({ id: "missing-date" })],
      fetch: (discovered) => {
        fetchCount += 1;
        return Effect.succeed({
          status: "fetched",
          raw: {
            sourceId: "service_public",
            canonicalUrl: discovered.canonicalUrl,
            fetchedAt: new Date("2026-07-06T10:01:00.000Z"),
            mediaType: "text/html",
            body: readableBody("stable body"),
          },
        });
      },
      hashForBody: () => "stable-hash",
    });

    await runWithState(adapter, state, { mode: "poll" });
    const stats = await runWithState(adapter, state, { mode: "poll" });

    expect(stats.fetchedCount).toBe(0);
    expect(stats.unchangedCount).toBe(1);
    expect(stats.storedDocumentCount).toBe(0);
    expect(fetchCount).toBe(1);
  });

  it("preserves a new document version when the same canonical URL changes", async () => {
    const state = makeState();
    const sameUrl = "https://example.test/articles/versioned";
    await runWithState(
      adapterWith({
        items: [
          item({
            id: "versioned",
            url: sameUrl,
            updatedAt: "2026-07-06T10:02:00.000Z",
          }),
        ],
        fetch: (discovered) =>
          Effect.succeed({
            status: "fetched",
            raw: {
              sourceId: "service_public",
              canonicalUrl: discovered.canonicalUrl,
              fetchedAt: new Date("2026-07-06T10:01:00.000Z"),
              mediaType: "text/html",
              body: readableBody("first body"),
            },
          }),
      }),
      state,
      { mode: "poll" },
    );
    const stats = await runWithState(
      adapterWith({
        items: [item({ id: "versioned", url: sameUrl })],
        fetch: (discovered) =>
          Effect.succeed({
            status: "fetched",
            raw: {
              sourceId: "service_public",
              canonicalUrl: discovered.canonicalUrl,
              fetchedAt: new Date("2026-07-06T10:02:00.000Z"),
              mediaType: "text/html",
              body: readableBody("changed body"),
            },
          }),
      }),
      state,
      { mode: "poll" },
    );

    expect(stats.storedDocumentCount).toBe(1);
    expect(state.documents.size).toBe(2);
  });

  it("passes validators when changed feed metadata requires a conditional fetch", async () => {
    const state = makeState();
    const calls: Array<SourceFetchOptions | undefined> = [];
    await runWithState(adapterWith({ items: [item({ id: "cached" })] }), state, { mode: "poll" });

    const stats = await runWithState(
      adapterWith({
        items: [item({ id: "cached", updatedAt: "2026-07-06T10:02:00.000Z" })],
        fetch: (discovered, options) => {
          calls.push(options);
          return Effect.succeed({
            status: "not_modified",
            sourceId: "service_public",
            canonicalUrl: discovered.canonicalUrl,
            fetchedAt: new Date("2026-07-06T10:02:00.000Z"),
            metadata: {
              etag: options?.validators?.etag,
            },
          });
        },
      }),
      state,
      { mode: "poll" },
    );

    expect(calls[0]?.validators?.etag).toBe('"cached-etag"');
    expect(stats).toMatchObject({
      unchangedCount: 1,
      storedDocumentCount: 0,
      failedCount: 0,
    });
  });

  it("clears prior item failure state when a conditional item fetch returns 304", async () => {
    const state = makeState();
    await runWithState(adapterWith({ items: [item({ id: "recovered" })] }), state, {
      mode: "poll",
    });
    const key = "service_public\nhttps://example.test/articles/recovered";
    const existing = state.items.get(key);
    if (!existing) {
      throw new Error("expected seeded item state");
    }
    state.items.set(key, { ...existing, failures: ["previous failure"] });

    const stats = await runWithState(
      adapterWith({
        items: [item({ id: "recovered", updatedAt: "2026-07-06T10:02:00.000Z" })],
        fetch: (discovered, options) =>
          Effect.succeed({
            status: "not_modified",
            sourceId: "service_public",
            canonicalUrl: discovered.canonicalUrl,
            fetchedAt: new Date("2026-07-06T10:02:00.000Z"),
            metadata: {
              etag: options?.validators?.etag,
            },
          }),
      }),
      state,
      { mode: "poll" },
    );

    expect(stats).toMatchObject({
      unchangedCount: 1,
      failedCount: 0,
    });
    expect(state.items.get(key)?.failures).toEqual([]);
  });

  it("records item retry/failure state without failing the whole source run", async () => {
    const state = makeState();
    const stats = await runWithState(
      adapterWith({
        items: [item({ id: "ok" }), item({ id: "fail" })],
        fetch: (discovered) =>
          discovered.externalId === "fail"
            ? Effect.fail(
                new SourceIngestionError("transient fetch failed", {
                  sourceId: "service_public",
                }),
              )
            : Effect.succeed({
                status: "fetched",
                raw: {
                  sourceId: "service_public",
                  canonicalUrl: discovered.canonicalUrl,
                  fetchedAt: new Date("2026-07-06T10:01:00.000Z"),
                  mediaType: "text/html",
                  body: readableBody("ok body"),
                },
              }),
      }),
      state,
      { mode: "poll" },
    );

    const failedState = state.items.get("service_public\nhttps://example.test/articles/fail");
    const failedCandidate = state.candidates.get(
      "service_public\nhttps://example.test/articles/fail",
    );
    expect(stats).toMatchObject({
      fetchedCount: 1,
      storedDocumentCount: 1,
      failedCount: 1,
    });
    expect(failedState).toBeUndefined();
    expect(failedCandidate?.failures).toEqual(["transient fetch failed"]);
  });

  it("retries a failed candidate on a later poll after bounded backoff and stores once", async () => {
    const state = makeState();
    const firstPoll = new Date("2026-07-06T10:00:00.000Z");
    const secondPollTooSoon = new Date("2026-07-06T10:00:30.000Z");
    const secondPollReady = new Date("2026-07-06T10:01:00.000Z");
    let attempts = 0;
    const adapter = adapterWith({
      items: [item({ id: "recoverable" })],
      fetch: (discovered) => {
        attempts += 1;
        return attempts === 1
          ? Effect.fail(
              new SourceIngestionError("temporary upstream failure", {
                sourceId: "service_public",
              }),
            )
          : Effect.succeed({
              status: "fetched",
              raw: {
                sourceId: "service_public",
                canonicalUrl: discovered.canonicalUrl,
                fetchedAt: secondPollReady,
                mediaType: "text/html",
                body: readableBody("recovered body"),
              },
            });
      },
      hashForBody: () => "recovered-hash",
    });

    await expect(
      runWithState(adapter, state, { mode: "poll", now: () => firstPoll }),
    ).resolves.toMatchObject({ failedCount: 1, fetchedCount: 0 });
    await expect(
      runWithState(adapter, state, { mode: "poll", now: () => secondPollTooSoon }),
    ).resolves.toMatchObject({ failedCount: 0, fetchedCount: 0, unchangedCount: 0 });
    expect(attempts).toBe(1);
    await expect(
      runWithState(adapter, state, { mode: "poll", now: () => secondPollReady }),
    ).resolves.toMatchObject({ failedCount: 0, fetchedCount: 1, storedDocumentCount: 1 });
    expect(attempts).toBe(2);
    expect(state.documents.size).toBe(1);

    // A successful candidate becomes a complete item and a repeated poll is
    // metadata-unchanged; it never creates a duplicate document.
    await expect(
      runWithState(adapter, state, { mode: "poll", now: () => new Date("2026-07-06T10:02:00Z") }),
    ).resolves.toMatchObject({ fetchedCount: 0, unchangedCount: 1 });
    expect(attempts).toBe(2);
    expect(state.documents.size).toBe(1);
  });

  it("loads retry-eligible candidates when poll discovery is not modified", async () => {
    const state = makeState();
    const firstPoll = new Date("2026-07-06T10:00:00.000Z");
    const retryPoll = new Date("2026-07-06T10:01:00.000Z");
    let attempts = 0;
    await expect(
      runWithState(
        adapterWith({
          items: [item({ id: "304-recovery" })],
          fetch: () => {
            attempts += 1;
            return Effect.fail(
              new SourceIngestionError("temporary source outage", { sourceId: "service_public" }),
            );
          },
        }),
        state,
        { mode: "poll", now: () => firstPoll },
      ),
    ).resolves.toMatchObject({ failedCount: 1 });

    const stats = await runWithState(
      adapterWith({
        discoveryStatus: "not_modified",
        items: [],
        fetch: (discovered) => {
          attempts += 1;
          return Effect.succeed({
            status: "fetched",
            raw: {
              sourceId: "service_public",
              canonicalUrl: discovered.canonicalUrl,
              fetchedAt: retryPoll,
              mediaType: "text/html",
              body: readableBody("304 recovery body"),
            },
          });
        },
      }),
      state,
      { mode: "poll", now: () => retryPoll },
    );

    expect(attempts).toBe(2);
    expect(stats).toMatchObject({ discoveredCount: 1, fetchedCount: 1, storedDocumentCount: 1 });
  });

  it("recovers an unattempted durable candidate after a crash and later discovery 304", async () => {
    const state = makeState();
    const crashedCandidate = item({ id: "crash-window" });
    await Effect.runPromise(
      makeInMemoryPublicSourceIngestionRepository(state).recordDiscoveredItem(
        crashedCandidate,
        true,
      ),
    );
    let attempts = 0;

    const stats = await runWithState(
      adapterWith({
        discoveryStatus: "not_modified",
        items: [],
        fetch: (discovered) => {
          attempts += 1;
          return Effect.succeed({
            status: "fetched",
            raw: {
              sourceId: "service_public",
              canonicalUrl: discovered.canonicalUrl,
              fetchedAt: new Date("2026-07-06T10:01:00.000Z"),
              mediaType: "text/html",
              body: readableBody("crash recovery body"),
            },
          });
        },
      }),
      state,
      { mode: "poll", now: () => new Date("2026-07-06T10:01:00.000Z") },
    );

    expect(attempts).toBe(1);
    expect(stats).toMatchObject({ discoveredCount: 1, fetchedCount: 1, storedDocumentCount: 1 });
  });

  it("keeps every atomically committed discovery candidate available after a later 304", async () => {
    const state = makeState();
    const first = item({ id: "atomic-first" });
    const second = item({ id: "atomic-second" });
    const repository = makeInMemoryPublicSourceIngestionRepository(state);
    await Effect.runPromise(
      repository.recordDiscoveryResult(
        definition,
        {
          status: "fetched",
          discoveredAt: new Date("2026-07-06T10:00:00.000Z"),
          metadata: [{ url: definition.discoveryUrl, status: 200, etag: '"feed-a"' }],
          items: [first, second],
        },
        { items: [first, second], pollEligible: true },
      ),
    );

    const fetched: string[] = [];
    const stats = await runWithState(
      adapterWith({
        discoveryStatus: "not_modified",
        items: [],
        fetch: (discovered) => {
          fetched.push(discovered.externalId);
          return Effect.succeed({
            status: "fetched",
            raw: {
              sourceId: "service_public",
              canonicalUrl: discovered.canonicalUrl,
              fetchedAt: new Date("2026-07-06T10:01:00.000Z"),
              mediaType: "text/html",
              body: readableBody(discovered.externalId),
            },
          });
        },
      }),
      state,
      { mode: "poll", now: () => new Date("2026-07-06T10:01:00.000Z") },
    );

    expect(fetched).toEqual(["atomic-first", "atomic-second"]);
    expect(stats).toMatchObject({ discoveredCount: 2, fetchedCount: 2, storedDocumentCount: 2 });
  });

  it("uses bounded exponential candidate retry delays", async () => {
    const state = makeState();
    const key = "service_public\nhttps://example.test/articles/backoff";
    const candidate = item({ id: "backoff" });
    await runWithState(
      adapterWith({
        items: [candidate],
        fetch: () =>
          Effect.fail(new SourceIngestionError("initial outage", { sourceId: "service_public" })),
      }),
      state,
      {
        mode: "poll",
        now: () => new Date("2026-07-06T10:00:00.000Z"),
      },
    );
    state.candidates.set(key, {
      ...state.candidates.get(key)!,
      failures: ["1", "2", "3", "4", "5", "6", "7"],
      lastFetchedAt: new Date("2026-07-06T10:00:00.000Z"),
    });
    let attempts = 0;
    const adapter = adapterWith({
      items: [candidate],
      fetch: () => {
        attempts += 1;
        return Effect.fail(
          new SourceIngestionError("still unavailable", { sourceId: "service_public" }),
        );
      },
    });
    await runWithState(adapter, state, {
      mode: "poll",
      now: () => new Date("2026-07-06T10:59:59.999Z"),
    });
    expect(attempts).toBe(0);
    await runWithState(adapter, state, {
      mode: "poll",
      now: () => new Date("2026-07-06T11:00:00.000Z"),
    });
    expect(attempts).toBe(1);
  });

  it("rejects short unreadable artifacts instead of creating a public item", async () => {
    const state = makeState();
    const stats = await runWithState(
      adapterWith({
        items: [item({ id: "too-short" })],
        fetch: (discovered) =>
          Effect.succeed({
            status: "fetched",
            raw: {
              sourceId: "service_public",
              canonicalUrl: discovered.canonicalUrl,
              fetchedAt: new Date("2026-07-06T10:01:00.000Z"),
              mediaType: "text/html",
              body: "<main>short</main>",
            },
          }),
      }),
      state,
      { mode: "poll" },
    );

    const key = "service_public\nhttps://example.test/articles/too-short";
    expect(stats).toMatchObject({
      fetchedCount: 0,
      storedDocumentCount: 0,
      failedCount: 1,
    });
    expect(state.items.get(key)).toBeUndefined();
    expect(state.candidates.get(key)?.failures[0]).toContain("too short");
  });

  it("marks the durable run failed when persistence fails after discovery", async () => {
    const state = makeState();
    const repository = makeInMemoryPublicSourceIngestionRepository(state);
    const failingRepository = PublicSourceIngestionRepository.of({
      ...repository,
      storeIngestedItem: () => Effect.fail(new Error("database write failed")),
    });

    await expect(
      Effect.runPromise(
        runPublicSourceIngestion(adapterWith({ items: [item({ id: "write-fails" })] }), {
          mode: "poll",
        }).pipe(Effect.provideService(PublicSourceIngestionRepository, failingRepository)),
      ),
    ).rejects.toThrow("database write failed");

    expect(state.runs[0]).toMatchObject({
      status: "failed",
      error: "database write failed",
    });
  });
});
