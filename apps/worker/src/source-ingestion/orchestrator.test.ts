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
  id: "info_gouv",
  displayName: "Info.gouv.fr",
  publisherName: "Gouvernement francais",
  description: "Official Government news and explanations.",
  ingestionMethod: "rss",
  discoveryUrl: "https://example.test/rss.xml",
  expectedCadence: "daily",
  averageCharsPerItem: 1000,
} as const;

const makeState = (): InMemoryPublicSourceIngestionState => ({
  sources: new Map(),
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
}): DiscoveredItem => ({
  sourceId: "info_gouv",
  externalId: input.id,
  canonicalUrl: input.url ?? `https://example.test/articles/${input.id}`,
  title: `Article ${input.id}`,
  publishedAt: input.publishedAt ? new Date(input.publishedAt) : null,
  ...(input.discoveredAt ? { discoveredAt: new Date(input.discoveredAt) } : {}),
  ...(input.updatedAt ? { updatedAt: new Date(input.updatedAt) } : {}),
});

const adapterWith = (options: {
  readonly items: readonly DiscoveredItem[];
  readonly discoveryStatus?: "fetched" | "not_modified";
  readonly fetch?: (
    item: DiscoveredItem,
    options?: SourceFetchOptions,
  ) => ReturnType<SourceAdapter["fetch"]>;
  readonly hashForBody?: (body: string) => string;
}): SourceAdapter => ({
  definition,
  discover: (discoveryOptions) =>
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
    ),
  fetch:
    options.fetch ??
    ((discovered) =>
      Effect.succeed({
        status: "fetched",
        raw: {
          sourceId: "info_gouv",
          canonicalUrl: discovered.canonicalUrl,
          fetchedAt: new Date("2026-07-06T10:01:00.000Z"),
          mediaType: "text/html",
          body: `<main>${discovered.title} body</main>`,
          metadata: {
            externalId: discovered.externalId,
            etag: `"${discovered.externalId}-etag"`,
          },
        },
      })),
  normalize: (raw: RawArtifact, discovered) =>
    Effect.succeed({
      id: `info_gouv:${discovered?.externalId}:${options.hashForBody?.(raw.body) ?? raw.body}`,
      sourceId: "info_gouv",
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
      rawArtifactKey: `info_gouv/${options.hashForBody?.(raw.body) ?? raw.body}`,
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
  it("startup backfill stores items discovered in the current source response", async () => {
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
      discoveredCount: 2,
      fetchedCount: 2,
      storedDocumentCount: 2,
      failedCount: 0,
    });
    expect([...state.documents.keys()]).toHaveLength(2);
    expect([...state.documents.keys()].some((key) => key.includes("recent"))).toBe(true);
    expect([...state.documents.keys()].some((key) => key.includes("old"))).toBe(true);
  });

  it("startup backfill includes items discovered recently even when they were published earlier", async () => {
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
      discoveredCount: 1,
      fetchedCount: 1,
      storedDocumentCount: 1,
      failedCount: 0,
    });
    expect([...state.documents.keys()][0]).toContain("old-but-newly-discovered");
  });

  it("startup backfill fetches recent incomplete items even when discovery is unchanged", async () => {
    const state = makeState();
    await runWithState(
      adapterWith({
        items: [item({ id: "missing", publishedAt: "2026-07-05T00:00:00.000Z" })],
        fetch: () =>
          Effect.fail(
            new SourceIngestionError("temporary fetch failure", {
              sourceId: "info_gouv",
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
              sourceId: "info_gouv",
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
    const key = "info_gouv\nhttps://example.test/articles/missing-raw";
    const existing = state.items.get(key);
    if (!existing) {
      throw new Error("expected seeded item state");
    }
    state.items.set(key, { ...existing, latestRawArtifactId: undefined });

    const stats = await runWithState(
      adapterWith({
        discoveryStatus: "not_modified",
        items: [],
        fetch: (discovered, options) => {
          calls.push(options);
          return Effect.succeed({
            status: "fetched",
            raw: {
              sourceId: "info_gouv",
              canonicalUrl: discovered.canonicalUrl,
              fetchedAt: new Date("2026-07-06T10:06:00.000Z"),
              mediaType: "text/html",
              body: `<main>${discovered.title} body</main>`,
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
    const key = "info_gouv\nhttps://example.test/articles/rediscovered-missing";
    const existing = state.items.get(key);
    if (!existing) {
      throw new Error("expected seeded item state");
    }
    state.items.set(key, { ...existing, latestRawArtifactId: undefined });

    const stats = await runWithState(
      adapterWith({
        items: [item({ id: "rediscovered-missing", publishedAt: "2026-07-05T00:00:00.000Z" })],
        fetch: (discovered, options) => {
          calls.push(options);
          return Effect.succeed({
            status: "fetched",
            raw: {
              sourceId: "info_gouv",
              canonicalUrl: discovered.canonicalUrl,
              fetchedAt: new Date("2026-07-06T10:06:00.000Z"),
              mediaType: "text/html",
              body: `<main>${discovered.title} body</main>`,
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
    await runWithState(adapterWith({ items: [item({ id: "first" })] }), state, { mode: "poll" });
    const stats = await runWithState(
      adapterWith({ items: [item({ id: "first" }), item({ id: "second" })] }),
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
      items: [item({ id: "same" })],
      fetch: (discovered) => {
        fetchCount += 1;
        return Effect.succeed({
          status: "fetched",
          raw: {
            sourceId: "info_gouv",
            canonicalUrl: discovered.canonicalUrl,
            fetchedAt: new Date("2026-07-06T10:01:00.000Z"),
            mediaType: "text/html",
            body: "stable body",
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
              sourceId: "info_gouv",
              canonicalUrl: discovered.canonicalUrl,
              fetchedAt: new Date("2026-07-06T10:01:00.000Z"),
              mediaType: "text/html",
              body: "first body",
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
              sourceId: "info_gouv",
              canonicalUrl: discovered.canonicalUrl,
              fetchedAt: new Date("2026-07-06T10:02:00.000Z"),
              mediaType: "text/html",
              body: "changed body",
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
            sourceId: "info_gouv",
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
    const key = "info_gouv\nhttps://example.test/articles/recovered";
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
            sourceId: "info_gouv",
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
                  sourceId: "info_gouv",
                }),
              )
            : Effect.succeed({
                status: "fetched",
                raw: {
                  sourceId: "info_gouv",
                  canonicalUrl: discovered.canonicalUrl,
                  fetchedAt: new Date("2026-07-06T10:01:00.000Z"),
                  mediaType: "text/html",
                  body: "ok body",
                },
              }),
      }),
      state,
      { mode: "poll" },
    );

    const failedState = state.items.get("info_gouv\nhttps://example.test/articles/fail");
    expect(stats).toMatchObject({
      fetchedCount: 1,
      storedDocumentCount: 1,
      failedCount: 1,
    });
    expect(failedState?.failures).toEqual(["transient fetch failed"]);
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
