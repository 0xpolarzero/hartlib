import { PgClient } from "@effect/sql-pg";
import { Effect, Redacted } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { estimateTokens, type SourceAccess } from "../retrieval/query-spec";
import { runMigrations } from "../../db/migrate";
import { renderMemoryBody, type MemoryItem } from "./blocks";
import {
  hydrateWindow,
  loadActiveContextBlocks,
  markBlocksCited,
  type HydrateRunContext,
} from "./hydrate";
import type { WindowBudget } from "./plan-window";

const isBun = typeof process.versions.bun === "string";
const databaseUrl = process.env.WORKER_POSTGRES_TEST_DATABASE_URL;
const isolatedDatabaseName = `brief_window_test_${process.pid}_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;

const now = new Date();
const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);

const shortText = "0123456789".repeat(40);
const shortBText = "abcdefghij".repeat(40);
const longText = "0123456789".repeat(200);
const foreignText = "qrstuvwxyz".repeat(40);
const allPublicAccess = { kind: "allPublicSources" } as const;
const budget: WindowBudget = { blockBudget: 150, hardCap: 260, fullDocMaxChars: 500 };

const sourceDatabaseUrl = () => {
  if (databaseUrl === undefined) {
    throw new Error("WORKER_POSTGRES_TEST_DATABASE_URL is required");
  }

  return databaseUrl;
};

const adminDatabaseUrl = () => {
  const url = new URL(sourceDatabaseUrl());
  url.pathname = "/postgres";
  return url.toString();
};

const isolatedDatabaseUrl = () => {
  const url = new URL(sourceDatabaseUrl());
  url.pathname = `/${isolatedDatabaseName}`;
  return url.toString();
};

const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;

function runDb<A, E>(url: string, effect: Effect.Effect<A, E, PgClient.PgClient>): Promise<A> {
  return Effect.runPromise(
    effect.pipe(
      Effect.provide(
        PgClient.layer({
          url: Redacted.make(url),
          applicationName: "brief-window-test",
        }),
      ),
    ),
  );
}

interface SourceFixture {
  readonly sourceId: string;
  readonly displayName: string;
  readonly publisherName: string;
  readonly discoveryUrl: string;
  readonly country: string;
  readonly language: string;
}

interface DocumentFixture {
  readonly documentId: string;
  readonly sourceId: string;
  readonly language: string;
  readonly title: string;
  readonly text: string;
  readonly publishedAt: Date;
  readonly documentType: string;
  readonly contentHash: string;
}

interface ChatRun {
  readonly chatId: string;
  readonly runId: string;
}

interface IdRow {
  readonly id: string;
}

interface StoredBlockRow {
  readonly blockId: string;
  readonly kind: string;
  readonly content: string;
  readonly tokenEstimate: number;
  readonly documentId: string | null;
  readonly charStart: number | null;
  readonly charEnd: number | null;
  readonly provenance: unknown;
  readonly createdByRunId: string;
  readonly lastCitedRunId: string | null;
  readonly evictedAt: Date | null;
}

interface ObservationRow {
  readonly payload: Record<string, unknown>;
}

const sourceFixtures: ReadonlyArray<SourceFixture> = [
  {
    sourceId: "win-src-a",
    displayName: "Win Source A",
    publisherName: "Win Source A",
    discoveryUrl: "https://window.example/a",
    country: "FR",
    language: "fr-FR",
  },
  {
    sourceId: "win-src-b",
    displayName: "Win Source B",
    publisherName: "Win Source B",
    discoveryUrl: "https://window.example/b",
    country: "FR",
    language: "fr-FR",
  },
];

const documentFixtures: ReadonlyArray<DocumentFixture> = [
  {
    documentId: "win-doc-short",
    sourceId: "win-src-a",
    language: "fr",
    title: "Short document",
    text: shortText,
    publishedAt: daysAgo(2),
    documentType: "article",
    contentHash: "win-h-01",
  },
  {
    documentId: "win-doc-short-b",
    sourceId: "win-src-a",
    language: "fr",
    title: "Second short document",
    text: shortBText,
    publishedAt: daysAgo(2),
    documentType: "article",
    contentHash: "win-h-02",
  },
  {
    documentId: "win-doc-long",
    sourceId: "win-src-a",
    language: "fr",
    title: "Long document",
    text: longText,
    publishedAt: daysAgo(2),
    documentType: "article",
    contentHash: "win-h-03",
  },
  {
    documentId: "win-doc-foreign",
    sourceId: "win-src-b",
    language: "fr",
    title: "Foreign document",
    text: foreignText,
    publishedAt: daysAgo(2),
    documentType: "article",
    contentHash: "win-h-04",
  },
];

const artifactIdForIndex = (index: number) =>
  `ffffffff-0000-0000-0000-${String(index).padStart(12, "0")}`;

const artifactBodyHashForIndex = (index: number) => `win-bh-${String(index).padStart(2, "0")}`;

const newChatRun = (): Effect.Effect<ChatRun, SqlError, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const chatRows = yield* sql<IdRow>`
      insert into chats (user_id)
      values (${"win-user"})
      returning id
    `;
    const chatId = chatRows[0]!.id;
    const messageRows = yield* sql<IdRow>`
      insert into chat_messages (chat_id, author, content)
      values (${chatId}, ${"user"}, ${"q"})
      returning id
    `;
    const runRows = yield* sql<IdRow>`
      insert into ai_runs (chat_id, user_message_id, locale, market)
      values (${chatId}, ${messageRows[0]!.id}, ${"fr-FR"}, ${"FR"})
      returning id
    `;

    return { chatId, runId: runRows[0]!.id };
  });

const finishRun = (runId: string): Effect.Effect<void, SqlError, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;

    yield* sql`
      update ai_runs
      set finished_at = now()
      where id = ${runId}
    `;
  });

const nextRun = (
  chatId: string,
): Effect.Effect<{ readonly runId: string }, SqlError, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const messageRows = yield* sql<IdRow>`
      insert into chat_messages (chat_id, author, content)
      values (${chatId}, ${"user"}, ${"q"})
      returning id
    `;
    const runRows = yield* sql<IdRow>`
      insert into ai_runs (chat_id, user_message_id, locale, market)
      values (${chatId}, ${messageRows[0]!.id}, ${"fr-FR"}, ${"FR"})
      returning id
    `;

    return { runId: runRows[0]!.id };
  });

const ctx = (
  chatId: string,
  aiRunId: string,
  overrides: Partial<HydrateRunContext> = {},
): HydrateRunContext => ({
  chatId,
  aiRunId,
  origin: "initial",
  memories: [],
  access: allPublicAccess,
  ...overrides,
});

const fetchBlocks = (
  chatId: string,
): Effect.Effect<readonly StoredBlockRow[], SqlError, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;

    return yield* sql<StoredBlockRow>`
      select
        block_id as "blockId",
        kind,
        content,
        token_estimate as "tokenEstimate",
        document_id as "documentId",
        char_start as "charStart",
        char_end as "charEnd",
        provenance,
        created_by_run_id as "createdByRunId",
        last_cited_run_id as "lastCitedRunId",
        evicted_at as "evictedAt"
      from chat_context_blocks
      where chat_id = ${chatId}
      order by block_id
    `;
  });

const fetchObservations = (
  runId: string,
  kind: string,
): Effect.Effect<readonly Record<string, unknown>[], SqlError, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<ObservationRow>`
      select payload
      from ai_observations
      where run_id = ${runId}
        and kind = ${kind}
      order by created_at, payload->>'blockId', payload->>'documentId', id
    `;

    return rows.map((row) => row.payload);
  });

const sourceAccess = (sourceIds: readonly string[]): SourceAccess => ({
  kind: "sourceIds",
  sourceIds,
});

describe.skipIf(!isBun || !databaseUrl)("context window hydration over postgres", () => {
  beforeAll(async () => {
    await runDb(
      adminDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const rows = yield* sql<{ readonly exists: boolean }>`
          select exists(
            select 1 from pg_database where datname = ${isolatedDatabaseName}
          ) as exists
        `;

        if (rows[0]?.exists !== true) {
          yield* sql.unsafe(`create database ${quoteIdentifier(isolatedDatabaseName)}`);
        }
      }),
    );

    await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        yield* runMigrations;
      }),
    );

    await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;

        yield* sql`
          delete from public_sources
          where source_id in ('win-src-a', 'win-src-b')
        `;

        for (const source of sourceFixtures) {
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
              ${source.sourceId},
              ${source.displayName},
              ${source.publisherName},
              ${"window fixtures"},
              ${"rss"},
              ${source.discoveryUrl},
              ${1000},
              ${source.country},
              ${source.language}
            )
          `;
        }

        for (const [index, document] of documentFixtures.entries()) {
          const fixtureIndex = index + 1;
          const artifactId = artifactIdForIndex(fixtureIndex);
          const canonicalUrl = `https://window.example/docs/${document.documentId}`;

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
              ${artifactId},
              ${document.sourceId},
              ${canonicalUrl},
              now(),
              ${"text/html"},
              ${"body"},
              ${artifactBodyHashForIndex(fixtureIndex)}
            )
          `;

          yield* sql`
            insert into public_source_documents (
              document_id,
              source_id,
              raw_artifact_id,
              canonical_url,
              external_id,
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
              ${document.documentId},
              ${document.sourceId},
              ${artifactId},
              ${canonicalUrl},
              ${null},
              ${document.title},
              ${document.text},
              ${document.language},
              ${document.publishedAt},
              ${document.publishedAt},
              ${document.publishedAt},
              ${document.documentType},
              ${document.contentHash},
              ${document.text.length}
            )
          `;
        }
      }),
    );
  }, 120_000);

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
    "hydrates memory and document blocks with provenance and observations",
    { timeout: 60_000 },
    async () => {
      await runDb(
        isolatedDatabaseUrl(),
        Effect.gen(function* () {
          const { chatId, runId } = yield* newChatRun();
          const memories: readonly MemoryItem[] = [
            { id: "m1", kind: "profile", content: "Engineer in Lyon" },
          ];
          const result = yield* hydrateWindow(
            [
              { documentId: "win-doc-short" },
              { documentId: "win-doc-long", charStart: 100, charEnd: 300 },
            ],
            [],
            budget,
            ctx(chatId, runId, { memories }),
          );
          const blocks = yield* fetchBlocks(chatId);
          const observations = yield* fetchObservations(runId, "context_block_added");
          const memoryContent = renderMemoryBody(memories);
          const memoryTokens = estimateTokens(memoryContent.length);

          expect(result.addedBlockIds).toEqual(["b1", "b2", "b3"]);
          expect(blocks).toHaveLength(3);
          expect(blocks[0]).toMatchObject({
            blockId: "b1",
            kind: "memory",
            content: memoryContent,
            tokenEstimate: memoryTokens,
            documentId: null,
            provenance: { memoryIds: ["m1"] },
            createdByRunId: runId,
          });
          expect(blocks[1]).toMatchObject({
            blockId: "b2",
            kind: "document",
            content: shortText,
            tokenEstimate: 100,
            documentId: "win-doc-short",
            charStart: null,
            charEnd: null,
            createdByRunId: runId,
          });
          expect(blocks[1]?.provenance).toMatchObject({
            documentId: "win-doc-short",
            sourceId: "win-src-a",
            sourceDisplayName: "Win Source A",
            canonicalUrl: "https://window.example/docs/win-doc-short",
            title: "Short document",
            publishedAt: documentFixtures[0]!.publishedAt.toISOString(),
            charStart: null,
            charEnd: null,
          });
          expect(blocks[2]).toMatchObject({
            blockId: "b3",
            kind: "document",
            content: longText.slice(100, 300),
            tokenEstimate: 50,
            documentId: "win-doc-long",
            charStart: 100,
            charEnd: 300,
            createdByRunId: runId,
          });
          expect(observations).toHaveLength(3);
          expect(observations[0]).toEqual({
            blockId: "b1",
            tokenEstimate: memoryTokens,
            origin: "initial",
            memoryIds: ["m1"],
          });
          expect(observations[1]).toEqual({
            blockId: "b2",
            documentId: "win-doc-short",
            charStart: null,
            charEnd: null,
            tokenEstimate: 100,
            origin: "initial",
            truncated: false,
          });
          expect(observations[2]).toEqual({
            blockId: "b3",
            documentId: "win-doc-long",
            charStart: 100,
            charEnd: 300,
            tokenEstimate: 50,
            origin: "initial",
            truncated: false,
          });
          expect(result.memoryBlock?.blockId).toBe("b1");
          expect(result.documentBlocks.map((block) => block.blockId)).toEqual(["b2", "b3"]);
          expect(result.totalActiveTokens).toBe(memoryTokens + 150);
          expect(result.evictedBlockIds).toEqual([]);
          expect(result.dropped).toEqual([]);
          expect(result.duplicates).toEqual([]);
        }),
      );
    },
  );

  it(
    "includes leading chars and records truncation for long docs without a range",
    { timeout: 60_000 },
    async () => {
      await runDb(
        isolatedDatabaseUrl(),
        Effect.gen(function* () {
          const { chatId, runId } = yield* newChatRun();
          const result = yield* hydrateWindow(
            [{ documentId: "win-doc-long" }],
            [],
            budget,
            ctx(chatId, runId),
          );
          const blocks = yield* fetchBlocks(chatId);
          const observations = yield* fetchObservations(runId, "context_block_added");

          expect(result.addedBlockIds).toEqual(["b1"]);
          expect(blocks[0]).toMatchObject({
            blockId: "b1",
            content: longText.slice(0, 500),
            charStart: 0,
            charEnd: 500,
            tokenEstimate: 125,
          });
          expect(observations[0]).toMatchObject({
            blockId: "b1",
            documentId: "win-doc-long",
            truncated: true,
          });
        }),
      );
    },
  );

  it(
    "follow-up turns dedupe against active blocks and keep ids monotonic",
    { timeout: 60_000 },
    async () => {
      await runDb(
        isolatedDatabaseUrl(),
        Effect.gen(function* () {
          const { chatId, runId: run1 } = yield* newChatRun();
          yield* hydrateWindow([{ documentId: "win-doc-short" }], [], budget, ctx(chatId, run1));
          yield* finishRun(run1);
          const standing = yield* loadActiveContextBlocks(chatId);
          const { runId: run2 } = yield* nextRun(chatId);
          const result = yield* hydrateWindow(
            [
              { documentId: "win-doc-short" },
              { documentId: "win-doc-short", charStart: 10, charEnd: 20 },
              { documentId: "win-doc-short-b" },
            ],
            standing,
            { ...budget, blockBudget: 300 },
            ctx(chatId, run2),
          );
          const blocks = yield* fetchBlocks(chatId);
          const observations = yield* fetchObservations(run2, "context_block_added");

          expect(result.addedBlockIds).toEqual(["b2"]);
          expect(result.duplicates).toEqual([
            {
              documentId: "win-doc-short",
              charStart: null,
              charEnd: null,
              coveredByBlockId: "b1",
            },
            {
              documentId: "win-doc-short",
              charStart: null,
              charEnd: null,
              coveredByBlockId: "b1",
            },
          ]);
          expect(observations).toHaveLength(1);
          expect(observations[0]?.blockId).toBe("b2");
          expect(blocks).toHaveLength(2);
          expect(blocks.every((block) => block.evictedAt === null)).toBe(true);
        }),
      );
    },
  );

  it(
    "a covering standing block survives over-budget eviction and keeps its duplicate consistent",
    { timeout: 60_000 },
    async () => {
      await runDb(
        isolatedDatabaseUrl(),
        Effect.gen(function* () {
          const { chatId, runId: run1 } = yield* newChatRun();
          yield* hydrateWindow([{ documentId: "win-doc-short" }], [], budget, ctx(chatId, run1));
          yield* finishRun(run1);
          const standing = yield* loadActiveContextBlocks(chatId);
          const { runId: run2 } = yield* nextRun(chatId);
          const result = yield* hydrateWindow(
            [{ documentId: "win-doc-short" }, { documentId: "win-doc-short-b" }],
            standing,
            budget,
            ctx(chatId, run2),
          );
          const evicted = yield* fetchObservations(run2, "context_block_evicted");
          const active = yield* loadActiveContextBlocks(chatId);

          expect(result.duplicates).toEqual([
            {
              documentId: "win-doc-short",
              charStart: null,
              charEnd: null,
              coveredByBlockId: "b1",
            },
          ]);
          expect(result.addedBlockIds).toEqual(["b2"]);
          expect(result.evictedBlockIds).toEqual([]);
          expect(evicted).toEqual([]);
          expect(active.map((block) => block.blockId)).toEqual(["b1", "b2"]);
          expect(result.totalActiveTokens).toBe(200);
        }),
      );
    },
  );

  it(
    "budget overshoot residue does not hard-cap-drop the next turn's evidence",
    { timeout: 60_000 },
    async () => {
      await runDb(
        isolatedDatabaseUrl(),
        Effect.gen(function* () {
          const { chatId, runId: run1 } = yield* newChatRun();
          yield* hydrateWindow(
            [{ documentId: "win-doc-short" }, { documentId: "win-doc-short-b" }],
            [],
            budget,
            ctx(chatId, run1),
          );
          yield* finishRun(run1);
          const standing = yield* loadActiveContextBlocks(chatId);
          const { runId: run2 } = yield* nextRun(chatId);
          const result = yield* hydrateWindow(
            [{ documentId: "win-doc-long" }],
            standing,
            budget,
            ctx(chatId, run2),
          );
          const dropped = yield* fetchObservations(run2, "context_block_dropped");
          const evicted = yield* fetchObservations(run2, "context_block_evicted");
          const active = yield* loadActiveContextBlocks(chatId);

          expect(result.dropped).toEqual([]);
          expect(dropped).toEqual([]);
          expect(result.addedBlockIds).toEqual(["b3"]);
          expect(result.evictedBlockIds).toEqual(["b1", "b2"]);
          expect(evicted).toEqual([
            { blockId: "b1", reason: "over_budget" },
            { blockId: "b2", reason: "over_budget" },
          ]);
          expect(result.totalActiveTokens).toBe(125);
          expect(active.map((block) => block.blockId)).toEqual(["b3"]);
        }),
      );
    },
  );

  it("evicts the oldest unpinned block when over budget", { timeout: 60_000 }, async () => {
    await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const { chatId, runId: run1 } = yield* newChatRun();
        yield* hydrateWindow([{ documentId: "win-doc-short" }], [], budget, ctx(chatId, run1));
        yield* finishRun(run1);
        const standing = yield* loadActiveContextBlocks(chatId);
        const { runId: run2 } = yield* nextRun(chatId);
        const result = yield* hydrateWindow(
          [{ documentId: "win-doc-short-b" }],
          standing,
          budget,
          ctx(chatId, run2),
        );
        const blocks = yield* fetchBlocks(chatId);
        const observations = yield* fetchObservations(run2, "context_block_evicted");
        const active = yield* loadActiveContextBlocks(chatId);

        expect(result.evictedBlockIds).toEqual(["b1"]);
        expect(blocks.find((block) => block.blockId === "b1")).toMatchObject({
          content: shortText,
          evictedAt: expect.any(Date),
        });
        expect(observations).toEqual([{ blockId: "b1", reason: "over_budget" }]);
        expect(active.map((block) => block.blockId)).toEqual(["b2"]);
        expect(result.documentBlocks.map((block) => block.blockId)).toEqual(["b2"]);
        expect(result.totalActiveTokens).toBe(100);
      }),
    );
  });

  it("pinned blocks survive eviction", { timeout: 60_000 }, async () => {
    await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const { chatId, runId: run1 } = yield* newChatRun();
        yield* hydrateWindow([{ documentId: "win-doc-short" }], [], budget, ctx(chatId, run1));
        yield* markBlocksCited(chatId, run1, ["b1"]);
        let blocks = yield* fetchBlocks(chatId);
        expect(blocks[0]?.lastCitedRunId).toBe(run1);
        yield* finishRun(run1);
        const standing = yield* loadActiveContextBlocks(chatId);
        const { runId: run2 } = yield* nextRun(chatId);
        const result = yield* hydrateWindow(
          [{ documentId: "win-doc-short-b" }],
          standing,
          budget,
          ctx(chatId, run2),
        );
        blocks = yield* fetchBlocks(chatId);

        expect(result.evictedBlockIds).toEqual([]);
        expect(blocks.every((block) => block.evictedAt === null)).toBe(true);
        expect(result.totalActiveTokens).toBe(200);
        expect(result.documentBlocks.map((block) => block.blockId)).toEqual(["b1", "b2"]);
      }),
    );
  });

  it("memory versioning retires and appends across turns", { timeout: 60_000 }, async () => {
    await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const { chatId, runId: run1 } = yield* newChatRun();
        const memoryV1: readonly MemoryItem[] = [{ id: "m1", kind: "profile", content: "v1" }];
        const memoryV2: readonly MemoryItem[] = [{ id: "m1", kind: "profile", content: "v2" }];
        yield* hydrateWindow([], [], budget, ctx(chatId, run1, { memories: memoryV1 }));
        yield* finishRun(run1);
        const standing = yield* loadActiveContextBlocks(chatId);
        const { runId: run2 } = yield* nextRun(chatId);
        const result2 = yield* hydrateWindow(
          [],
          standing,
          budget,
          ctx(chatId, run2, { memories: memoryV2 }),
        );
        const evicted = yield* fetchObservations(run2, "context_block_evicted");

        expect(evicted).toEqual([{ blockId: "b1", reason: "memory_superseded" }]);
        expect(result2.addedBlockIds).toEqual(["b2"]);
        expect(result2.retiredMemoryBlockId).toBe("b1");
        expect(result2.memoryBlock?.blockId).toBe("b2");
        yield* finishRun(run2);
        const standing2 = yield* loadActiveContextBlocks(chatId);
        const { runId: run3 } = yield* nextRun(chatId);
        const result3 = yield* hydrateWindow(
          [],
          standing2,
          budget,
          ctx(chatId, run3, { memories: memoryV2 }),
        );
        const blocks = yield* fetchBlocks(chatId);

        expect(blocks.filter((block) => block.kind === "memory")).toHaveLength(2);
        expect(result3.memoryBlock?.blockId).toBe("b2");
        expect(result3.addedBlockIds).toEqual([]);
      }),
    );
  });

  it(
    "records injected memory ids when a memory block is kept unchanged",
    { timeout: 60_000 },
    async () => {
      await runDb(
        isolatedDatabaseUrl(),
        Effect.gen(function* () {
          const { chatId, runId: run1 } = yield* newChatRun();
          const memories: readonly MemoryItem[] = [
            { id: "m1", kind: "profile", content: "v1" },
            { id: "m2", kind: "preference", content: "v2" },
          ];
          yield* hydrateWindow([], [], budget, ctx(chatId, run1, { memories }));
          yield* finishRun(run1);
          const standing = yield* loadActiveContextBlocks(chatId);
          const { runId: run2 } = yield* nextRun(chatId);
          yield* hydrateWindow([], standing, budget, ctx(chatId, run2, { memories }));
          const observations = yield* fetchObservations(run2, "memory_injected");

          expect(observations).toEqual([{ memoryIds: ["m1", "m2"] }]);
        }),
      );
    },
  );

  it("block ids are never reused after eviction", { timeout: 60_000 }, async () => {
    await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const { chatId, runId: run1 } = yield* newChatRun();
        yield* hydrateWindow([{ documentId: "win-doc-short" }], [], budget, ctx(chatId, run1));
        yield* finishRun(run1);
        const standing1 = yield* loadActiveContextBlocks(chatId);
        const { runId: run2 } = yield* nextRun(chatId);
        yield* hydrateWindow(
          [{ documentId: "win-doc-short-b" }],
          standing1,
          budget,
          ctx(chatId, run2),
        );
        yield* finishRun(run2);
        const standing2 = yield* loadActiveContextBlocks(chatId);
        const { runId: run3 } = yield* nextRun(chatId);
        const result = yield* hydrateWindow(
          [{ documentId: "win-doc-short" }],
          standing2,
          budget,
          ctx(chatId, run3),
        );
        const blocks = yield* fetchBlocks(chatId);

        expect(result.addedBlockIds).toEqual(["b3"]);
        expect(blocks.find((block) => block.blockId === "b3")).toMatchObject({
          documentId: "win-doc-short",
          content: shortText,
        });
      }),
    );
  });

  it("re-running hydrate with the same inputs is idempotent", { timeout: 60_000 }, async () => {
    await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const { chatId, runId } = yield* newChatRun();
        const standing = yield* loadActiveContextBlocks(chatId);
        const memories: readonly MemoryItem[] = [{ id: "m1", kind: "profile", content: "v1" }];
        const context = ctx(chatId, runId, { memories });
        yield* hydrateWindow(
          [{ documentId: "win-doc-short" }, { documentId: "win-doc-long" }],
          standing,
          budget,
          context,
        );
        const firstBlocks = yield* fetchBlocks(chatId);
        const second = yield* hydrateWindow(
          [{ documentId: "win-doc-short" }, { documentId: "win-doc-long" }],
          standing,
          budget,
          context,
        );
        const secondBlocks = yield* fetchBlocks(chatId);
        const added = yield* fetchObservations(runId, "context_block_added");
        const evicted = yield* fetchObservations(runId, "context_block_evicted");

        expect(secondBlocks).toHaveLength(firstBlocks.length);
        expect(added).toHaveLength(3);
        expect(evicted).toHaveLength(0);
        expect(second.addedBlockIds).toEqual([]);
      }),
    );
  });

  it(
    "raw duplicate active document range violates the 0008 unique index",
    { timeout: 60_000 },
    async () => {
      await runDb(
        isolatedDatabaseUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const { chatId, runId } = yield* newChatRun();
          yield* hydrateWindow([{ documentId: "win-doc-short" }], [], budget, ctx(chatId, runId));
          const error = yield* Effect.flip(sql`
          insert into chat_context_blocks (
            chat_id,
            block_id,
            kind,
            content,
            token_estimate,
            document_id,
            char_start,
            char_end,
            provenance,
            created_by_run_id
          )
          values (
            ${chatId},
            ${"b99"},
            ${"document"},
            ${"duplicate"},
            ${1},
            ${"win-doc-short"},
            ${null},
            ${null},
            ${sql.json({})},
            ${runId}
          )
        `);

          expect(error._tag).toBe("SqlError");
          expect(error.reason._tag).toBe("UniqueViolation");
          expect(error.reason._tag === "UniqueViolation" ? error.reason.constraint : null).toBe(
            "chat_context_blocks_active_document_range_key",
          );
        }),
      );
    },
  );

  it(
    "hard-cap overflow drops manifest tail and records the defect",
    { timeout: 60_000 },
    async () => {
      await runDb(
        isolatedDatabaseUrl(),
        Effect.gen(function* () {
          const { chatId, runId } = yield* newChatRun();
          const result = yield* hydrateWindow(
            [
              { documentId: "win-doc-short" },
              { documentId: "win-doc-short-b" },
              { documentId: "win-doc-long", charStart: 0, charEnd: 400 },
            ],
            [],
            budget,
            ctx(chatId, runId),
          );
          const observations = yield* fetchObservations(runId, "context_block_dropped");

          expect(result.addedBlockIds).toEqual(["b1", "b2"]);
          expect(result.dropped).toEqual([
            {
              documentId: "win-doc-long",
              charStart: 0,
              charEnd: 400,
              tokenEstimate: 100,
              reason: "hard_cap",
            },
          ]);
          expect(observations).toEqual([
            {
              documentId: "win-doc-long",
              charStart: 0,
              charEnd: 400,
              tokenEstimate: 100,
              reason: "hard_cap",
              origin: "initial",
            },
          ]);
        }),
      );
    },
  );

  it("source access is enforced during hydration", { timeout: 60_000 }, async () => {
    await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const { chatId, runId } = yield* newChatRun();
        const result = yield* hydrateWindow(
          [{ documentId: "win-doc-foreign" }],
          [],
          budget,
          ctx(chatId, runId, { access: sourceAccess(["win-src-a"]) }),
        );
        const blocks = yield* fetchBlocks(chatId);
        const observations = yield* fetchObservations(runId, "context_block_dropped");

        expect(blocks).toHaveLength(0);
        expect(result.dropped).toEqual([
          {
            documentId: "win-doc-foreign",
            charStart: null,
            charEnd: null,
            tokenEstimate: null,
            reason: "document_not_found",
          },
        ]);
        expect(observations).toEqual([
          {
            documentId: "win-doc-foreign",
            charStart: null,
            charEnd: null,
            tokenEstimate: null,
            reason: "document_not_found",
            origin: "initial",
          },
        ]);
      }),
    );
  });

  it("retry origin is recorded on added blocks", { timeout: 60_000 }, async () => {
    await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const { chatId, runId } = yield* newChatRun();
        yield* hydrateWindow(
          [{ documentId: "win-doc-short" }],
          [],
          budget,
          ctx(chatId, runId, { origin: "retry" }),
        );
        const observations = yield* fetchObservations(runId, "context_block_added");

        expect(observations[0]?.origin).toBe("retry");
      }),
    );
  });
});
