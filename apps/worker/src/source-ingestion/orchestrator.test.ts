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
  id: "tresor",
  displayName: "Direction generale du Tresor",
  publisherName: "Direction generale du Tresor",
  description: "Official Government news and explanations.",
  ingestionMethod: "atom_feed",
  discoveryUrl: "https://example.test/atom.xml",
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
}): DiscoveredItem => ({
  sourceId: "tresor",
  externalId: input.id,
  canonicalUrl: input.url ?? `https://example.test/articles/${input.id}`,
  title: `Article ${input.id}`,
  publishedAt: input.publishedAt ? new Date(input.publishedAt) : null,
  ...(input.discoveredAt ? { discoveredAt: new Date(input.discoveredAt) } : {}),
  ...(input.updatedAt ? { updatedAt: new Date(input.updatedAt) } : {}),
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
          sourceId: "tresor",
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
      id: `tresor:${discovered?.externalId}:${options.hashForBody?.(raw.body) ?? raw.body}`,
      sourceId: "tresor",
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
      rawArtifactKey: `tresor/${options.hashForBody?.(raw.body) ?? raw.body}`,
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
    ).rejects.toThrow("public source discovery timed out for tresor after 5ms");

    expect(state.runs[0]).toMatchObject({
      status: "failed",
      error: "public source discovery timed out for tresor after 5ms",
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
    expect(state.items.has("tresor\nhttps://example.test/articles/old")).toBe(false);
    expect(state.candidates.has("tresor\nhttps://example.test/articles/old")).toBe(true);
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
    expect(state.items.has("tresor\nhttps://example.test/articles/old-but-newly-discovered")).toBe(
      false,
    );
    expect(
      state.candidates.has("tresor\nhttps://example.test/articles/old-but-newly-discovered"),
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
              sourceId: "tresor",
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
              sourceId: "tresor",
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
    const key = "tresor\nhttps://example.test/articles/missing-raw";
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
              sourceId: "tresor",
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
    const key = "tresor\nhttps://example.test/articles/rediscovered-missing";
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
              sourceId: "tresor",
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
            sourceId: "tresor",
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
            sourceId: "tresor",
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
              sourceId: "tresor",
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
              sourceId: "tresor",
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
            sourceId: "tresor",
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
    const key = "tresor\nhttps://example.test/articles/recovered";
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
            sourceId: "tresor",
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
                  sourceId: "tresor",
                }),
              )
            : Effect.succeed({
                status: "fetched",
                raw: {
                  sourceId: "tresor",
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

    const failedState = state.items.get("tresor\nhttps://example.test/articles/fail");
    const failedCandidate = state.candidates.get("tresor\nhttps://example.test/articles/fail");
    expect(stats).toMatchObject({
      fetchedCount: 1,
      storedDocumentCount: 1,
      failedCount: 1,
    });
    expect(failedState).toBeUndefined();
    expect(failedCandidate?.failures).toEqual(["transient fetch failed"]);
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
              sourceId: "tresor",
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

    const key = "tresor\nhttps://example.test/articles/too-short";
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
