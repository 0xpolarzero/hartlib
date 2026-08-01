import { PgClient } from "@effect/sql-pg";
import { Cause, Deferred, Effect, Fiber, Redacted } from "effect";
import { TestClock } from "effect/testing";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "../../db/migrate";
import { InvalidQuerySpecError } from "./compile-query-spec";
import {
  findNormalizedSubstringRanges,
  normalizeAndCaseFold,
  normalizeWithOriginalSpans,
} from "./exact-text";
import {
  RetrievalHydrationError,
  executeInternalQueryPlan,
  hydrateFusedResults,
  previewFromImmutableText,
  reviewProjection,
  type RetrievalPlanResult,
} from "./retrieval";
import { resolveRuntimeModel } from "../runtime/model-registry";
import { fuseTwoStageRankedResults, type RankedBranchHit } from "./rank-fusion";

const isBun = typeof process.versions.bun === "string";
const databaseUrl = process.env.WORKER_POSTGRES_TEST_DATABASE_URL;
const isolatedDatabaseName = `brief_retrieval_test_${process.pid}_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;

const now = new Date();
const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);

const authorizedSourceAccess = {
  kind: "sourceIds",
  sourceIds: ["ret-fr-a", "ret-fr-b", "ret-us"],
} as const;
const baseOptions = {
  access: authorizedSourceAccess,
  maxLimit: 20,
  recencyHalfLifeDays: 14,
  now,
} as const;

const stagFrText =
  "La stagflation menace la reprise selon plusieurs économistes qui observent la hausse simultanée du chômage et des prix à la consommation.";
const peekText = "0123456789".repeat(40);
const dirigeableText =
  "Le dirigeable stratosphérique français réussit son premier vol d'essai longue durée au-dessus des Landes.";
const repeatedHeadlineText =
  "Needle first signal appears in the opening paragraph with enough context for a useful headline fragment. " +
  "filler ".repeat(30) +
  "Needle second signal appears in the closing paragraph with enough context for another useful headline fragment.";
const unicodeHeadlineText =
  "😀 " +
  "prefix ".repeat(30) +
  "needle match follows supplementary characters with enough surrounding words for a stable preview fragment.";
const unmappableHeadlineText =
  "This body deliberately contains a run event whose indexed stem matches the requested form. " +
  "The fixture keeps enough stable source content to pass the readable-document invariant.";

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

describe("immutable text normalization", () => {
  it("fails closed at a blocked Hangul trailing-jamo boundary", () => {
    const text = "가\u0327\u11a8";
    const mapped = normalizeWithOriginalSpans(text);

    expect(mapped.text).toBe(normalizeAndCaseFold(text));
    expect(mapped.text).toBe("가\u0327\u11a8");
    expect(findNormalizedSubstringRanges(text, ["각", "각\u0327"])).toEqual([]);
    expect(findNormalizedSubstringRanges(text, ["가"])).toEqual([{ charStart: 0, charEnd: 1 }]);
  });

  it("does not cross a blocked combining-mark boundary", () => {
    const text = "a\u0323\u0301";
    const mapped = normalizeWithOriginalSpans(text);

    expect(mapped.text).toBe(normalizeAndCaseFold(text));
    expect(mapped.text).toBe("ạ\u0301");
    expect(findNormalizedSubstringRanges(text, ["á"])).toEqual([]);
    expect(findNormalizedSubstringRanges(text, ["ạ"])).toEqual([{ charStart: 0, charEnd: 2 }]);
  });

  it("maps compatibility compositions and supplementary UTF-16 spans exactly", () => {
    const text = "😀 \u09cc";
    const mapped = normalizeWithOriginalSpans(text);

    expect(mapped.text).toBe(normalizeAndCaseFold(text));
    expect(findNormalizedSubstringRanges(text, ["😀"])).toEqual([{ charStart: 0, charEnd: 2 }]);
    expect(findNormalizedSubstringRanges(text, ["\u09cc"])).toEqual([{ charStart: 3, charEnd: 4 }]);
    expect(previewFromImmutableText("😀 ﬃ", "ffi", 100)).toEqual({
      snippet: "ﬃ",
      ranges: [{ charStart: 3, charEnd: 4 }],
    });
    expect(previewFromImmutableText("😀 prefix", undefined, 1)).toBeNull();
    expect(previewFromImmutableText("😀 prefix", undefined, 2)).toEqual({
      snippet: "😀",
      ranges: [{ charStart: 0, charEnd: 2 }],
    });
  });

  it("rejects ill-formed queries and keeps valid supplementary matches on UTF-16 boundaries", () => {
    const text = "x😀 needle";
    expect(findNormalizedSubstringRanges(text, ["\ud83d"])).toEqual([]);
    expect(findNormalizedSubstringRanges(text, ["\ude00"])).toEqual([]);
    expect(findNormalizedSubstringRanges(text, ["😀"])).toEqual([{ charStart: 1, charEnd: 3 }]);
    expect(previewFromImmutableText(text, "needle\ud800", 100)).toBeNull();
    expect(previewFromImmutableText(text, "needle", 100)).toEqual({
      snippet: "needle",
      ranges: [{ charStart: 4, charEnd: 10 }],
    });
  });

  it("keeps attached combining marks in preview search terms", () => {
    const text = "prefix e\u0301 suffix";

    expect(previewFromImmutableText(text, "e\u0301", 100)).toEqual({
      snippet: "e\u0301",
      ranges: [{ charStart: 7, charEnd: 9 }],
    });
    expect(previewFromImmutableText(text, "é", 100)).toEqual({
      snippet: "e\u0301",
      ranges: [{ charStart: 7, charEnd: 9 }],
    });
    expect(previewFromImmutableText("a\u0323\u0301", "á", 100)).toBeNull();
    expect(previewFromImmutableText("가\u0327\u11a8", "각\u0327", 100)).toBeNull();
  });
});

describe("Phase B hydration and provider projection", () => {
  const content = "Storage evidence is stable and exact.";
  const identity = {
    kind: "public_document" as const,
    sourceId: "source",
    documentId: "document",
    snapshotId: "snapshot",
    contentHash: sha256(content),
  };
  const branches = [
    {
      queryOrdinal: 1,
      branch: "public_documents" as const,
      status: "applicable" as const,
      hits: [
        {
          queryOrdinal: 1,
          branch: "public_documents" as const,
          rank: 1,
          identity,
          value: {
            kind: "document" as const,
            label: "Document",
            date: null,
            textCharCount: content.length,
          },
        },
      ],
      cap: 2,
      truncated: false,
    },
    {
      queryOrdinal: 1,
      branch: "publisher_documents" as const,
      status: "not_applicable" as const,
      reason: "scope_documents" as const,
      hits: [],
      cap: 2,
      truncated: false,
    },
    {
      queryOrdinal: 1,
      branch: "chat_messages" as const,
      status: "not_applicable" as const,
      reason: "scope_documents" as const,
      hits: [],
      cap: 2,
      truncated: false,
    },
  ] as const;

  it("verifies immutable hashes, counts exact tokens, and strips private fields", () => {
    const fused = fuseTwoStageRankedResults(branches);
    const hydrated = hydrateFusedResults(
      fused,
      {
        previewTerms: "stable",
      },
      () => ({ text: content, snapshotId: "snapshot", contentHash: sha256(content) }),
    );
    const hydratedValue = hydrated.results[0]?.value;
    expect(hydratedValue?.fullTokenCount).toBeGreaterThan(0);
    expect(hydratedValue?.preview).toBe("stable");
    expect(hydratedValue?.fastTokenCount).toBe(
      resolveRuntimeModel("glm-5-turbo").countTextTokens("stable"),
    );
    expect(hydratedValue?.mainTokenCount).toBe(
      resolveRuntimeModel("glm-5-turbo").countTextTokens("stable"),
    );
    const view = reviewProjection(hydrated)[0]!;
    expect(Object.keys(view).sort()).toEqual(
      [
        "branchCoverage",
        "date",
        "kind",
        "label",
        "matchedQueryOrdinals",
        "normalizedFusedScore",
        "preview",
        "resultId",
        "tokenCount",
        "truncationFlags",
      ].sort(),
    );
    expect("identity" in view).toBe(false);
    expect("contentHash" in view).toBe(false);
  });

  it("fails closed when immutable text changes with the same candidate identity", () => {
    const fused = fuseTwoStageRankedResults(branches);
    expect(() =>
      hydrateFusedResults(fused, {}, () => ({
        text: "changed",
        snapshotId: "snapshot",
        contentHash: sha256(content),
      })),
    ).toThrowError(RetrievalHydrationError);
  });

  it("fails closed for missing rows, missing exact previews, and byte overflow", () => {
    const fused = fuseTwoStageRankedResults(branches);
    expect(() => hydrateFusedResults(fused, {}, () => null)).toThrowError(RetrievalHydrationError);
    expect(() =>
      hydrateFusedResults(
        fused,
        {
          previewTerms: "not-present",
        },
        () => ({ text: content, snapshotId: "snapshot", contentHash: sha256(content) }),
      ),
    ).toThrowError(RetrievalHydrationError);
    expect(() =>
      hydrateFusedResults(
        fused,
        {
          maxHydratedBytes: new TextEncoder().encode(content).byteLength - 1,
        },
        () => ({ text: content, snapshotId: "snapshot", contentHash: sha256(content) }),
      ),
    ).toThrowError(RetrievalHydrationError);
  });

  it("keeps fast and main token budgets separate and verifies chat identity", () => {
    const chatContent = "The chat cites stable storage evidence.";
    const chatBranches = [
      {
        queryOrdinal: 1,
        branch: "public_documents" as const,
        status: "not_applicable" as const,
        reason: "scope_chat_messages" as const,
        hits: [],
        cap: 2,
        truncated: false,
      },
      {
        queryOrdinal: 1,
        branch: "publisher_documents" as const,
        status: "not_applicable" as const,
        reason: "scope_chat_messages" as const,
        hits: [],
        cap: 2,
        truncated: false,
      },
      {
        queryOrdinal: 1,
        branch: "chat_messages" as const,
        status: "applicable" as const,
        hits: [
          {
            queryOrdinal: 1,
            branch: "chat_messages" as const,
            rank: 1,
            identity: {
              kind: "chat_message" as const,
              messageId: "message-1",
              sanitizedContentHash: sha256(chatContent),
            },
            value: { kind: "chat_message" as const, label: "user", date: null, textCharCount: 40 },
          },
        ],
        cap: 2,
        truncated: false,
      },
    ] as const;
    const fused = fuseTwoStageRankedResults(chatBranches);
    const hydrated = hydrateFusedResults(fused, {}, () => ({
      kind: "chat_message",
      messageId: "message-1",
      text: chatContent,
      snapshotId: "message-snapshot",
      contentHash: sha256(chatContent),
    }));
    expect(hydrated.results[0]?.value.fastTokenCount).toBeGreaterThan(0);
    expect(hydrated.results[0]?.value.mainTokenCount).toBeGreaterThan(0);
    expect(() =>
      hydrateFusedResults(fused, {}, () => ({
        kind: "chat_message",
        messageId: "other-message",
        text: chatContent,
        snapshotId: "message-snapshot",
        contentHash: sha256(chatContent),
      })),
    ).toThrowError(RetrievalHydrationError);
  });
});

describe("Phase B relevance tie ordering", () => {
  const identity = (documentId: string) => ({
    kind: "public_document" as const,
    sourceId: "tie-source",
    documentId,
    snapshotId: `snapshot-${documentId}`,
    contentHash: sha256(documentId),
  });
  const branch = (
    publicHits: readonly RankedBranchHit[],
    publisherHits: readonly RankedBranchHit[] = [],
  ) =>
    [
      {
        queryOrdinal: 1,
        branch: "public_documents" as const,
        status: "applicable" as const,
        hits: publicHits,
        cap: 4,
        truncated: false,
      },
      {
        queryOrdinal: 1,
        branch: "publisher_documents" as const,
        status: publisherHits.length === 0 ? ("not_applicable" as const) : ("applicable" as const),
        ...(publisherHits.length === 0 ? { reason: "scope_documents" as const } : {}),
        hits: publisherHits,
        cap: 4,
        truncated: false,
      },
      {
        queryOrdinal: 1,
        branch: "chat_messages" as const,
        status: "not_applicable" as const,
        reason: "scope_documents" as const,
        hits: [],
        cap: 4,
        truncated: false,
      },
    ] as const;

  it("uses descending date after score and best-rank ties", () => {
    const results = fuseTwoStageRankedResults(
      branch(
        [
          {
            queryOrdinal: 1,
            branch: "public_documents" as const,
            rank: 1,
            identity: identity("older"),
            value: {},
            date: "2024-01-01T00:00:00.000Z",
          },
        ],
        [
          {
            queryOrdinal: 1,
            branch: "publisher_documents" as const,
            rank: 1,
            identity: {
              kind: "publisher_document" as const,
              subscriptionId: "sub",
              issueId: "issue",
              documentId: "newer",
              snapshotId: "snapshot-newer",
              publisherExtractionId: "extract-newer",
              contentHash: sha256("newer"),
            },
            value: {},
            date: "2025-01-01T00:00:00.000Z",
          },
        ],
      ),
    );
    expect(
      results.results.map((result) =>
        result.identity.kind === "public_document" || result.identity.kind === "publisher_document"
          ? result.identity.documentId
          : result.identity.messageId,
      ),
    ).toEqual(["newer", "older"]);
  });

  it("uses UTF-8 identity bytes when score, rank, and date tie", () => {
    const results = fuseTwoStageRankedResults(
      branch(
        [
          {
            queryOrdinal: 1,
            branch: "public_documents" as const,
            rank: 1,
            identity: identity("é"),
            value: {},
            date: "2025-01-01T00:00:00.000Z",
          },
        ],
        [
          {
            queryOrdinal: 1,
            branch: "publisher_documents" as const,
            rank: 1,
            identity: {
              kind: "publisher_document" as const,
              subscriptionId: "sub",
              issueId: "issue",
              documentId: "z",
              snapshotId: "snapshot-z",
              publisherExtractionId: "extract-z",
              contentHash: sha256("z"),
            },
            value: {},
            date: "2025-01-01T00:00:00.000Z",
          },
        ],
      ),
    );
    expect(
      results.results.map((result) =>
        result.identity.kind === "public_document" || result.identity.kind === "publisher_document"
          ? result.identity.documentId
          : result.identity.messageId,
      ),
    ).toEqual(["é", "z"]);
  });

  it("rejects invalid projected dates", () => {
    expect(() =>
      fuseTwoStageRankedResults(
        branch([
          {
            queryOrdinal: 1,
            branch: "public_documents" as const,
            rank: 1,
            identity: identity("bad-date"),
            value: {},
            date: "not-a-date",
          },
        ]),
      ),
    ).toThrow("fused result date is invalid");
  });
});

describe("Phase B query-plan execution seam", () => {
  it("executes every physical branch for several logical queries in input order", async () => {
    const calls: string[] = [];
    const plan = {
      action: "search" as const,
      queries: [
        {
          purpose: "first",
          all: [{ text: "alpha", mode: "term" as const }],
          anyOf: [],
          not: [],
          filters: {},
          order: "relevance" as const,
        },
        {
          purpose: "second",
          all: [{ text: "beta", mode: "term" as const }],
          anyOf: [],
          not: [],
          filters: {},
          order: "relevance" as const,
        },
      ],
    };
    const result = await Effect.runPromise(
      executeInternalQueryPlan(plan, {
        scope: {
          userId: "user",
          chatId: "chat",
          companyId: "company",
          publicSourceIds: ["source"],
          subscriptionIds: ["subscription"],
          accessIds: ["access"],
        },
        branchCap: 2,
        maxConcurrency: 2,
        statementTimeoutMs: 1_000,
        executeBranch: (branch, queryOrdinal, statementTimeoutMs) => {
          calls.push(`${queryOrdinal}:${branch.branch}:${statementTimeoutMs}`);
          return Effect.succeed({
            queryOrdinal,
            branch: branch.branch,
            status: "not_applicable" as const,
            reason: "scope_documents" as const,
            hits: [],
            cap: branch.cap,
            truncated: false,
          });
        },
        hydrateResult: (fused) => Effect.succeed({ fused: fused as never, exposures: [] }),
      }) as unknown as Effect.Effect<unknown, unknown>,
    );
    expect(calls.map((call) => call.split(":").slice(0, 2))).toEqual([
      ["1", "public_documents"],
      ["1", "publisher_documents"],
      ["1", "chat_messages"],
      ["2", "public_documents"],
      ["2", "publisher_documents"],
      ["2", "chat_messages"],
    ]);
    expect((result as { readonly branches: readonly unknown[] }).branches).toHaveLength(6);
  });

  it("uses one shared semaphore and total deadline across all branch waves", async () => {
    const plan = {
      action: "search" as const,
      queries: [1, 2, 3].map((ordinal) => ({
        purpose: `query ${ordinal}`,
        all: [{ text: `term ${ordinal}`, mode: "term" as const }],
        anyOf: [],
        not: [],
        filters: {},
        order: "relevance" as const,
      })),
    };
    const result = (await Effect.runPromise(
      Effect.gen(function* () {
        const keys = plan.queries.flatMap((_, queryOrdinal) =>
          ["public_documents", "publisher_documents", "chat_messages"].map(
            (branch) => `${queryOrdinal + 1}:${branch}`,
          ),
        );
        const gates = new Map<string, Deferred.Deferred<void>>();
        const startedSignals = new Map<string, Deferred.Deferred<void>>();
        for (const key of keys) {
          gates.set(key, yield* Deferred.make<void>());
          startedSignals.set(key, yield* Deferred.make<void>());
        }
        let active = 0;
        let maximumActive = 0;
        const statementTimeouts: number[] = [];
        const starts: string[] = [];
        const makeEmptyBranch = (
          branch: "public_documents" | "publisher_documents" | "chat_messages",
          queryOrdinal: number,
          cap: number,
        ) => ({
          queryOrdinal,
          branch,
          status: "applicable" as const,
          hits: [],
          cap,
          truncated: false,
        });
        const execution = executeInternalQueryPlan(plan, {
          scope: {
            userId: "user",
            chatId: "chat",
            companyId: "company",
            publicSourceIds: ["source"],
            subscriptionIds: ["subscription"],
            accessIds: ["access"],
          },
          branchCap: 2,
          maxConcurrency: 2,
          statementTimeoutMs: 100,
          executeBranch: (branch, queryOrdinal, statementTimeoutMs) => {
            const key = `${queryOrdinal}:${branch.branch}`;
            return Effect.gen(function* () {
              active += 1;
              maximumActive = Math.max(maximumActive, active);
              starts.push(key);
              statementTimeouts.push(statementTimeoutMs);
              yield* Deferred.succeed(startedSignals.get(key)!, void 0);
              return yield* Effect.ensuring(
                Deferred.await(gates.get(key)!),
                Effect.sync(() => {
                  active -= 1;
                }),
              ).pipe(Effect.as(makeEmptyBranch(branch.branch, queryOrdinal, branch.cap)));
            });
          },
          hydrateResult: (fused) => Effect.succeed({ fused: fused as never, exposures: [] }),
        });
        const fiber = yield* Effect.forkChild(execution);
        yield* Effect.yieldNow;
        yield* Effect.all([
          Deferred.await(startedSignals.get(keys[0]!)!),
          Deferred.await(startedSignals.get(keys[1]!)!),
        ]);
        expect(maximumActive).toBe(2);
        yield* TestClock.adjust(40);
        yield* Deferred.succeed(gates.get(keys[1]!)!, void 0);
        yield* Deferred.succeed(gates.get(keys[0]!)!, void 0);
        yield* Effect.yieldNow;
        yield* Effect.all([
          Deferred.await(startedSignals.get(keys[2]!)!),
          Deferred.await(startedSignals.get(keys[3]!)!),
        ]);
        expect(statementTimeouts.slice(0, 2)).toEqual([100, 100]);
        expect(statementTimeouts.slice(2, 4).every((value) => value <= 60 && value > 0)).toBe(true);
        for (const key of keys.slice(2)) yield* Deferred.succeed(gates.get(key)!, void 0);
        const completed = yield* Fiber.join(fiber);
        return { completed, starts, maximumActive, active };
      }).pipe(Effect.provide(TestClock.layer({}))) as unknown as Effect.Effect<unknown, unknown>,
    )) as {
      readonly completed: RetrievalPlanResult;
      readonly starts: readonly string[];
      readonly maximumActive: number;
      readonly active: number;
    };
    expect(result.maximumActive).toBe(2);
    expect(result.active).toBe(0);
    expect(result.starts).toEqual([
      "1:public_documents",
      "1:publisher_documents",
      "1:chat_messages",
      "2:public_documents",
      "2:publisher_documents",
      "2:chat_messages",
      "3:public_documents",
      "3:publisher_documents",
      "3:chat_messages",
    ]);
    expect(
      result.completed.branches.map((branch) => `${branch.queryOrdinal}:${branch.branch}`),
    ).toEqual(result.starts);
  });

  it("interrupts active work, removes queued work, and releases permits", async () => {
    const plan = {
      action: "search" as const,
      queries: [1, 2].map((ordinal) => ({
        purpose: `query ${ordinal}`,
        all: [{ text: `term ${ordinal}`, mode: "term" as const }],
        anyOf: [],
        not: [],
        filters: {},
        order: "relevance" as const,
      })),
    };
    const outcome = (await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const hold = yield* Deferred.make<void>();
        let active = 0;
        let interrupted = 0;
        const starts: string[] = [];
        const fiber = yield* Effect.forkChild(
          executeInternalQueryPlan(plan, {
            scope: {
              userId: "user",
              chatId: "chat",
              companyId: "company",
              publicSourceIds: ["source"],
              subscriptionIds: ["subscription"],
              accessIds: ["access"],
            },
            branchCap: 2,
            maxConcurrency: 1,
            statementTimeoutMs: 10_000,
            executeBranch: (branch, queryOrdinal) =>
              Effect.gen(function* () {
                active += 1;
                starts.push(`${queryOrdinal}:${branch.branch}`);
                yield* Deferred.succeed(started, void 0);
                yield* Effect.onInterrupt(Deferred.await(hold), () =>
                  Effect.sync(() => {
                    interrupted += 1;
                    active -= 1;
                  }),
                );
                return {
                  queryOrdinal,
                  branch: branch.branch,
                  status: "applicable" as const,
                  hits: [],
                  cap: branch.cap,
                  truncated: false,
                };
              }),
            hydrateResult: (fused) => Effect.succeed({ fused: fused as never, exposures: [] }),
          }),
        );
        yield* Deferred.await(started);
        yield* Fiber.interrupt(fiber);
        yield* Fiber.await(fiber);
        yield* TestClock.adjust(10_000);
        return { interrupted, starts };
      }).pipe(Effect.provide(TestClock.layer({}))) as unknown as Effect.Effect<unknown, unknown>,
    )) as { readonly interrupted: number; readonly starts: readonly string[] };
    expect(outcome.interrupted).toBe(1);
    expect(outcome.starts).toEqual(["1:public_documents"]);
  });
});

function runDb<A, E>(url: string, effect: Effect.Effect<A, E, PgClient.PgClient>): Promise<A> {
  return Effect.runPromise(
    effect.pipe(
      Effect.provide(
        PgClient.layer({
          url: Redacted.make(url),
          applicationName: "brief-retrieval-test",
        }),
      ),
    ),
  );
}

type SourceFixture = {
  readonly sourceId: string;
  readonly displayName: string;
  readonly publisherName: string;
  readonly discoveryUrl: string;
  readonly country: string;
  readonly language: string;
};

type StructuredSearchRequest = {
  readonly terms: string;
  readonly languages?: readonly string[];
  readonly publishedAfter?: string;
  readonly publishedBefore?: string;
  readonly sourceIds?: readonly string[];
  readonly countries?: readonly string[];
  readonly documentTypes?: readonly string[];
  readonly orderBy?: "relevance" | "recency";
  readonly limit?: number;
};

type StructuredSearchOptions = {
  readonly access: { readonly kind: "sourceIds"; readonly sourceIds: readonly string[] };
  readonly maxLimit: number;
  readonly now: Date;
  readonly recencyHalfLifeDays?: number;
};

type LegacyPreview = {
  readonly kind: "public_source";
  readonly documentId: string;
  readonly sourceId: string;
  readonly sourceDisplayName: string;
  readonly language: string | null;
  readonly documentType: string | null;
  readonly title: string | null;
  readonly publishedAt: Date | null;
  readonly textCharCount: number;
  readonly text: string;
  readonly snippet: string;
  readonly previewRanges: readonly { readonly charStart: number; readonly charEnd: number }[];
};

const structuredSearch = (
  request: StructuredSearchRequest,
  options: StructuredSearchOptions,
): Effect.Effect<readonly LegacyPreview[], InvalidQuerySpecError | Error, PgClient.PgClient> =>
  Effect.sandbox(
    Effect.gen(function* () {
      const sourceIds = options.access.sourceIds;
      const query = {
        purpose: request.terms,
        scope: "documents" as const,
        all: [{ text: request.terms, mode: "term" as const }],
        anyOf: [],
        not: [],
        filters: {
          documents: {
            ...(request.countries === undefined ? {} : { countries: request.countries }),
            ...(request.languages === undefined ? {} : { languages: request.languages }),
            ...(request.documentTypes === undefined
              ? {}
              : { documentTypes: request.documentTypes }),
            ...(request.publishedAfter === undefined && request.publishedBefore === undefined
              ? {}
              : {
                  publishedAt: {
                    ...(request.publishedAfter === undefined
                      ? {}
                      : { after: request.publishedAfter.slice(0, 10) }),
                    ...(request.publishedBefore === undefined
                      ? {}
                      : { before: request.publishedBefore.slice(0, 10) }),
                  },
                }),
          },
        },
        order: request.orderBy === "recency" ? ("newest" as const) : ("relevance" as const),
      };
      const result = yield* executeInternalQueryPlan(
        { action: "search", queries: [query] },
        {
          scope: {
            userId: phaseBFixture.userId,
            chatId: phaseBFixture.chatId,
            companyId: phaseBFixture.companyId,
            publicSourceIds: sourceIds,
            subscriptionIds: [phaseBFixture.subscriptionId],
            accessIds: [phaseBFixture.accessId],
          },
          acceptedSourceIds: request.sourceIds ?? sourceIds,
          branchCap: Math.min(request.limit ?? options.maxLimit, options.maxLimit),
          maxCandidates: Math.min(request.limit ?? options.maxLimit, options.maxLimit),
          now: options.now,
          hydration: {
            previewTerms: request.terms,
            previewMaxChars: 300,
            fastModelId: "glm-5-turbo",
            mainModelId: "glm-5-turbo",
          },
        },
      );
      const sql = yield* PgClient.PgClient;
      const rows: LegacyPreview[] = [];
      for (const item of result.fused.results as unknown as ReadonlyArray<{
        readonly identity: any;
        readonly value: any;
      }>) {
        if (item.identity.kind !== "public_document") continue;
        const metadata = yield* sql<{
          readonly sourceId: string;
          readonly displayName: string;
          readonly language: string | null;
          readonly documentType: string | null;
          readonly title: string | null;
          readonly publishedAt: Date | null;
        }>`
        select d.source_id as "sourceId", s.display_name as "displayName", d.language,
               d.document_type as "documentType", d.title, d.published_at as "publishedAt"
        from public_source_documents d
        join public_sources s on s.source_id = d.source_id
        where d.source_id = ${item.identity.sourceId} and d.document_id = ${item.identity.documentId}
      `;
        const row = metadata[0];
        if (row === undefined) continue;
        if (request.sourceIds !== undefined && !request.sourceIds.includes(row.sourceId)) continue;
        rows.push({
          kind: "public_source",
          documentId: item.identity.documentId,
          sourceId: `public:${row.sourceId}`,
          sourceDisplayName: row.displayName,
          language: row.language,
          documentType: row.documentType,
          title: row.title,
          publishedAt: row.publishedAt,
          textCharCount: item.value.text.length,
          text: item.value.text,
          snippet: item.value.preview,
          previewRanges: item.value.previewRanges,
        });
      }
      return rows;
    }),
  ).pipe(
    Effect.catchCause((cause) =>
      Effect.fail<InvalidQuerySpecError | Error>(
        Cause.squash(cause) instanceof Error
          ? (Cause.squash(cause) as Error)
          : new Error(String(Cause.squash(cause))),
      ),
    ),
  );

const structuredPeek = (
  documentId: string,
  offset: number | undefined,
  length: number | undefined,
  options: {
    readonly access: { readonly kind: "sourceIds"; readonly sourceIds: readonly string[] };
    readonly defaultLengthChars?: number;
    readonly maxLengthChars?: number;
  },
): Effect.Effect<Record<string, unknown> | null, Error, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<{ readonly sourceId: string; readonly text: string }>`
      select source_id as "sourceId", text from public_source_documents where document_id = ${documentId}
    `;
    const row = rows[0];
    if (row === undefined || !options.access.sourceIds.includes(row.sourceId)) return null;
    const text = row.text;
    const start = Number.isSafeInteger(offset) && offset !== undefined ? Math.max(0, offset) : 0;
    const requested = length ?? options.defaultLengthChars ?? 300;
    const cap = options.maxLengthChars ?? 300;
    const boundedLength = Math.max(0, Math.min(requested, cap));
    const actualStart = Math.min(start, text.length);
    const slice = text.slice(actualStart, actualStart + boundedLength);
    return {
      documentId,
      text: slice,
      offsetChars: actualStart,
      lengthChars: slice.length,
      textCharCount: text.length,
    };
  });

type DocumentFixture = {
  readonly documentId: string;
  readonly sourceId: string;
  readonly language: string;
  readonly title: string;
  readonly text: string;
  readonly publishedAt: Date;
  readonly documentType: string;
  readonly contentHash?: string;
};

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

const sourceFixtures: ReadonlyArray<SourceFixture> = [
  {
    sourceId: "ret-fr-a",
    displayName: "Retrieval FR A",
    publisherName: "Retrieval FR A",
    discoveryUrl: "https://retrieval.example/fr-a",
    country: "FR",
    language: "fr-FR",
  },
  {
    sourceId: "ret-fr-b",
    displayName: "Retrieval FR B",
    publisherName: "Retrieval FR B",
    discoveryUrl: "https://retrieval.example/fr-b",
    country: "FR",
    language: "fr-FR",
  },
  {
    sourceId: "ret-us",
    displayName: "Retrieval US",
    publisherName: "Retrieval US",
    discoveryUrl: "https://retrieval.example/us",
    country: "US",
    language: "en-US",
  },
];

const documentFixtures: ReadonlyArray<DocumentFixture> = [
  {
    documentId: "ret-doc-stag-fr",
    sourceId: "ret-fr-a",
    language: "fr",
    title: "Note sur la stagflation",
    text: stagFrText,
    publishedAt: daysAgo(2),
    documentType: "article",
  },
  {
    documentId: "ret-doc-stag-fr-b",
    sourceId: "ret-fr-b",
    language: "fr",
    title: "Rapport trimestriel sur les prix",
    text: "Le rapport décrit un scénario de stagflation durable pour la zone euro avec des salaires réels en baisse continue.",
    publishedAt: daysAgo(10),
    documentType: "report",
  },
  {
    documentId: "ret-doc-stag-en",
    sourceId: "ret-us",
    language: "en-US",
    title: "Stagflation outlook",
    text: "Analysts warn that stagflation risks are rising as growth slows while consumer prices keep climbing across major economies.",
    publishedAt: daysAgo(3),
    documentType: "article",
  },
  {
    documentId: "ret-doc-pv-fr",
    sourceId: "ret-fr-a",
    language: "fr",
    title: "Le solaire photovoltaïque en plaine",
    text: "Les installations photovoltaïques progressent dans les zones rurales grâce aux nouveaux appels d'offres régionaux.",
    publishedAt: daysAgo(4),
    documentType: "article",
  },
  {
    documentId: "ret-doc-pv-frfr",
    sourceId: "ret-fr-a",
    language: "fr-FR",
    title: "Cadastre solaire photovoltaïque",
    text: "Le cadastre recense le potentiel photovoltaïque de chaque toiture de la métropole pour orienter les investissements.",
    publishedAt: daysAgo(5),
    documentType: "article",
  },
  {
    documentId: "ret-doc-pv-frca",
    sourceId: "ret-fr-b",
    language: "fr-CA",
    title: "Programme photovoltaïque québécois",
    text: "Le programme soutient le déploiement photovoltaïque résidentiel dans les municipalités du Québec avec des subventions bonifiées.",
    publishedAt: daysAgo(6),
    documentType: "article",
  },
  {
    documentId: "ret-doc-pv-en",
    sourceId: "ret-us",
    language: "en-US",
    title: "Photovoltaïque partnership announced",
    text: "The joint venture will build photovoltaïque module factories across three states next year to supply utility developers.",
    publishedAt: daysAgo(4),
    documentType: "article",
  },
  {
    documentId: "ret-doc-geo-old",
    sourceId: "ret-fr-a",
    language: "fr",
    title: "Bilan de la géothermie profonde",
    text: "La géothermie profonde alimente désormais trois réseaux de chaleur urbains en Île-de-France selon le dernier bilan public.",
    publishedAt: daysAgo(60),
    documentType: "article",
  },
  {
    documentId: "ret-doc-geo-mid",
    sourceId: "ret-fr-a",
    language: "fr",
    title: "Forages de géothermie en Alsace",
    text: "Les nouveaux forages de géothermie alsaciens relancent le débat public sur la sismicité induite dans la vallée du Rhin.",
    publishedAt: daysAgo(30),
    documentType: "article",
  },
  {
    documentId: "ret-doc-geo-new",
    sourceId: "ret-fr-a",
    language: "fr",
    title: "Géothermie de surface pour les écoles",
    text: "La géothermie de surface équipe une dizaine de groupes scolaires pilotes cette rentrée dans plusieurs académies volontaires.",
    publishedAt: daysAgo(5),
    documentType: "article",
  },
  {
    documentId: "ret-doc-sem-title",
    sourceId: "ret-fr-a",
    language: "fr",
    title: "Le sémaphore maritime restauré",
    text: "La tour de guet du littoral breton rouvre après deux ans de travaux de restauration menés par la commune.",
    publishedAt: daysAgo(40),
    documentType: "article",
  },
  {
    documentId: "ret-doc-sem-body",
    sourceId: "ret-fr-a",
    language: "fr",
    title: "Signalisation côtière renforcée",
    text: "Un sémaphore modernisé complète le dispositif de surveillance du littoral atlantique pour la saison estivale.",
    publishedAt: daysAgo(1),
    documentType: "article",
  },
  {
    documentId: "ret-doc-dir-a",
    sourceId: "ret-fr-a",
    language: "fr",
    title: "Le dirigeable stratosphérique décolle",
    text: dirigeableText,
    publishedAt: daysAgo(3),
    documentType: "article",
  },
  {
    documentId: "ret-doc-dir-b",
    sourceId: "ret-fr-b",
    language: "fr",
    title: "Le dirigeable stratosphérique décolle",
    text: dirigeableText,
    publishedAt: daysAgo(1),
    documentType: "article",
  },
  {
    documentId: "ret-doc-peek",
    sourceId: "ret-fr-a",
    language: "fr",
    title: "Document de référence",
    text: peekText,
    publishedAt: daysAgo(1),
    documentType: "article",
  },
  {
    documentId: "ret-doc-repeated-headline",
    sourceId: "ret-us",
    language: "en-US",
    title: "Repeated headline terms",
    text: repeatedHeadlineText,
    publishedAt: daysAgo(1),
    documentType: "article",
  },
  {
    documentId: "ret-doc-unicode-headline",
    sourceId: "ret-us",
    language: "en-US",
    title: "Unicode headline terms",
    text: unicodeHeadlineText,
    publishedAt: daysAgo(1),
    documentType: "article",
  },
  {
    documentId: "ret-doc-unmappable-headline",
    sourceId: "ret-us",
    language: "en-US",
    title: "Unmappable headline fixture",
    text: unmappableHeadlineText,
    publishedAt: daysAgo(1),
    documentType: "article",
  },
].map((fixture) => ({ ...fixture, contentHash: sha256(fixture.text) }));

const sortedDocumentIds = (previews: ReadonlyArray<{ readonly documentId: string }>) =>
  previews.map((preview) => preview.documentId).sort();

const orderedDocumentIds = (previews: ReadonlyArray<{ readonly documentId: string }>) =>
  previews.map((preview) => preview.documentId);

const artifactIdForIndex = (index: number) =>
  `eeeeeeee-0000-0000-0000-${String(index).padStart(12, "0")}`;

const artifactBodyHashForIndex = (_index: number) => sha256("body");

const phaseBFixture = {
  userId: "00000000-0000-0000-0000-000000000101",
  companyId: "00000000-0000-0000-0000-000000000102",
  publisherCompanyId: "00000000-0000-0000-0000-000000000103",
  subscriptionId: "00000000-0000-0000-0000-000000000104",
  accessId: "00000000-0000-0000-0000-000000000105",
  issueId: "00000000-0000-0000-0000-000000000106",
  documentId: "00000000-0000-0000-0000-000000000107",
  snapshotId: "00000000-0000-0000-0000-000000000108",
  extractionId: "00000000-0000-0000-0000-000000000109",
  chatId: "00000000-0000-0000-0000-00000000010a",
};

describe.skipIf(!isBun || !databaseUrl)("retrieval over postgres fts", () => {
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
          where source_id in ('ret-fr-a', 'ret-fr-b', 'ret-us')
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
              ${"retrieval fixtures"},
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
          const canonicalUrl = `https://retrieval.example/docs/${document.documentId}`;

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

        const publisherText =
          "The publisher brief reviews stagflation risks and liquidity conditions.";
        const publisherHash = sha256(publisherText);
        yield* sql`
          insert into platform_users (id, primary_email, display_name, clerk_user_id)
          values (${phaseBFixture.userId}, 'retrieval-phase-b@example.test', 'Retrieval Phase B', 'retrieval-phase-b')
        `;
        yield* sql`
          insert into client_companies (id, name)
          values (${phaseBFixture.companyId}, 'Retrieval Phase B Company')
        `;
        yield* sql`
          insert into client_company_memberships (company_id, user_id, role)
          values (${phaseBFixture.companyId}, ${phaseBFixture.userId}, 'admin')
        `;
        yield* sql`
          insert into publisher_companies (id, name)
          values (${phaseBFixture.publisherCompanyId}, 'Retrieval Phase B Publisher')
        `;
        yield* sql`
          insert into publisher_subscriptions (id, publisher_company_id, name, created_by_user_id)
          values (${phaseBFixture.subscriptionId}, ${phaseBFixture.publisherCompanyId}, 'Phase B Publisher Source', ${phaseBFixture.userId})
        `;
        yield* sql`
          insert into client_subscription_accesses (
            id, subscription_id, client_company_id, state, first_admin_email,
            accepted_at, subscribed_at, created_by_user_id
          ) values (
            ${phaseBFixture.accessId}, ${phaseBFixture.subscriptionId}, ${phaseBFixture.companyId},
            'active', 'retrieval-phase-b@example.test', now(), now(), ${phaseBFixture.userId}
          )
        `;
        yield* sql`
          insert into client_employee_subscription_grants (
            access_id, client_company_id, user_id, granted_by_user_id
          ) values (
            ${phaseBFixture.accessId}, ${phaseBFixture.companyId}, ${phaseBFixture.userId}, ${phaseBFixture.userId}
          )
        `;
        yield* sql`
          insert into publisher_issues (
            id, subscription_id, title, status, publication_at, published_at,
            indexing_status, created_by_user_id
          ) values (
            ${phaseBFixture.issueId}, ${phaseBFixture.subscriptionId}, 'Phase B Issue',
            'draft', now(), null, 'pending', ${phaseBFixture.userId}
          )
        `;
        yield* sql`
          insert into brief_documents (
            id, issue_id, title, original_file_name, object_key, media_type, byte_size,
            sha256_hex, upload_completed_at, created_by_user_id
          ) values (
            ${phaseBFixture.documentId}, ${phaseBFixture.issueId}, 'Phase B Publisher Document',
            'phase-b.pdf', 'retrieval/phase-b.pdf', 'application/pdf', ${publisherText.length},
            ${publisherHash}, now(), ${phaseBFixture.userId}
          )
        `;
        const jobs = yield* sql<{ readonly id: string }>`
          insert into jobs (kind, payload)
          values ('extract_pdf_text', '{}'::jsonb)
          returning id::text as id
        `;
        yield* sql`
          insert into brief_document_extractions (
            id, brief_document_id, input_sha256_hex, pages, extracted_char_count, created_by_job_id
          ) values (
            ${phaseBFixture.extractionId}, ${phaseBFixture.documentId}, ${publisherHash},
            ${JSON.stringify([{ pageNumber: 1, text: publisherText }])}::jsonb,
            ${publisherText.length}, ${jobs[0]!.id}
          )
        `;
        yield* sql`
          insert into brief_document_versions (
            id, brief_document_id, publisher_extraction_id, content_hash, language,
            canonical_text, text_char_count, page_ranges
          ) values (
            ${phaseBFixture.snapshotId}, ${phaseBFixture.documentId}, ${phaseBFixture.extractionId},
            ${publisherHash}, 'english', ${publisherText}, ${publisherText.length},
            ${JSON.stringify([{ pageNumber: 1, charStart: 0, charEnd: publisherText.length }])}::jsonb
          )
        `;
        yield* sql`
          update brief_documents set current_version_id = ${phaseBFixture.snapshotId}
          where id = ${phaseBFixture.documentId}
        `;
        yield* sql`
          update publisher_issues
          set status = 'published', published_at = now(), indexing_status = 'ready'
          where id = ${phaseBFixture.issueId}
        `;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              insert into issue_deliveries (
                issue_id, subscription_id, access_id, client_company_id, historical
              ) values (
                ${phaseBFixture.issueId}, ${phaseBFixture.subscriptionId}, ${phaseBFixture.accessId},
                ${phaseBFixture.companyId}, false
              )
            `;
            yield* sql`
              insert into issue_delivery_recipients (
                issue_id, client_company_id, user_id, delivered_at
              ) values (
                ${phaseBFixture.issueId}, ${phaseBFixture.companyId}, ${phaseBFixture.userId}, now()
              )
            `;
          }),
        );
        yield* sql`
          insert into chats (id, company_id, user_id, memory_mode)
          values (${phaseBFixture.chatId}, ${phaseBFixture.companyId}, ${phaseBFixture.userId}, 'private_owner')
        `;
        yield* sql`
          insert into chat_messages (chat_id, author, content)
          values (${phaseBFixture.chatId}, 'user', 'The chat also mentions stagflation evidence.')
        `;
        yield* sql`
          insert into chat_messages (chat_id, author, content, created_at)
          values (
            ${phaseBFixture.chatId}, 'assistant',
            'needle needle needle evidence from the older answer [[cite:needle-only-marker]]',
            now() - interval '1 day'
          )
        `;
        yield* sql`
          insert into chat_messages (chat_id, author, content, created_at)
          values (
            ${phaseBFixture.chatId}, 'assistant',
            'needle weak match [[cite:needle-only-marker]]',
            now()
          )
        `;
        yield* sql`
          insert into chat_messages (chat_id, author, content, created_at)
          values (
            ${phaseBFixture.chatId}, 'user',
            'user literal [[cite:needle-only-marker]]',
            now()
          )
        `;
      }),
    );
  }, 120_000);

  it("executes all three Phase B physical branches against the migrated schema", async () => {
    const result = await runDb(
      isolatedDatabaseUrl(),
      executeInternalQueryPlan(
        {
          action: "search",
          queries: [
            {
              purpose: "schema proof",
              all: [{ text: "stagflation", mode: "term" }],
              anyOf: [],
              not: [],
              filters: {},
              order: "relevance",
            },
          ],
        },
        {
          scope: {
            userId: phaseBFixture.userId,
            chatId: phaseBFixture.chatId,
            companyId: phaseBFixture.companyId,
            publicSourceIds: ["ret-fr-a", "ret-fr-b", "ret-us"],
            subscriptionIds: [phaseBFixture.subscriptionId],
            accessIds: [phaseBFixture.accessId],
          },
          branchCap: 2,
          maxQueries: 24,
          maxConcurrency: 2,
          statementTimeoutMs: 10_000,
        },
      ),
    );
    expect(result.branches).toHaveLength(3);
    expect(result.branches.map((branch) => branch.branch)).toEqual([
      "public_documents",
      "publisher_documents",
      "chat_messages",
    ]);
    expect(result.branches[0]?.hits.length).toBeGreaterThan(0);
    expect(result.branches[1]?.hits.length).toBeGreaterThan(0);
    expect(result.branches[2]?.hits.length).toBeGreaterThan(0);
  }, 30_000);

  it("ranks sanitized chat relevance before recency and keeps user literals exact", async () => {
    const result = await runDb(
      isolatedDatabaseUrl(),
      executeInternalQueryPlan(
        {
          action: "search",
          queries: [
            {
              purpose: "chat relevance",
              scope: "chat_messages",
              all: [{ text: "needle", mode: "term" }],
              anyOf: [],
              not: [],
              filters: {},
              order: "relevance",
            },
          ],
        },
        {
          scope: {
            userId: phaseBFixture.userId,
            chatId: phaseBFixture.chatId,
            companyId: phaseBFixture.companyId,
            publicSourceIds: [],
            subscriptionIds: [],
            accessIds: [],
          },
          branchCap: 10,
          maxConcurrency: 2,
          statementTimeoutMs: 10_000,
        },
      ),
    );
    const chat = result.branches.find((branch) => branch.branch === "chat_messages");
    expect(chat?.hits).toHaveLength(3);
    expect(result.review[0]?.preview).toContain("needle needle needle");

    const markerResult = await runDb(
      isolatedDatabaseUrl(),
      executeInternalQueryPlan(
        {
          action: "search",
          queries: [
            {
              purpose: "literal marker",
              scope: "chat_messages",
              all: [{ text: "needle-only-marker", mode: "term" }],
              anyOf: [],
              not: [],
              filters: {},
              order: "relevance",
            },
          ],
        },
        {
          scope: {
            userId: phaseBFixture.userId,
            chatId: phaseBFixture.chatId,
            companyId: phaseBFixture.companyId,
            publicSourceIds: [],
            subscriptionIds: [],
            accessIds: [],
          },
          branchCap: 10,
          maxConcurrency: 2,
          statementTimeoutMs: 10_000,
        },
      ),
    );
    const markerChat = markerResult.branches.find((branch) => branch.branch === "chat_messages");
    expect(markerChat?.hits).toHaveLength(1);
    expect(markerResult.review[0]?.preview).toContain("user literal [[cite:needle-only-marker]]");
  }, 30_000);
  it("bounds chat results strictly before the database current-message tuple", async () => {
    const olderMessageId = "00000000-0000-0000-0000-00000000010b";
    const currentMessageId = "00000000-0000-0000-0000-00000000010c";
    const futureMessageId = "00000000-0000-0000-0000-00000000010d";

    await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          insert into chat_messages (id, chat_id, author, content, created_at)
          values
            (${olderMessageId}, ${phaseBFixture.chatId}, 'assistant', 'needle older boundary', now() - interval '2 hours'),
            (${currentMessageId}, ${phaseBFixture.chatId}, 'user', 'needle current boundary', now()),
            (${futureMessageId}, ${phaseBFixture.chatId}, 'assistant', 'needle future boundary', now() + interval '2 hours')
        `;
      }),
    );

    const searchPlan = {
      action: "search",
      queries: [
        {
          purpose: "current-message boundary",
          scope: "chat_messages",
          all: [{ text: "needle", mode: "term" }],
          anyOf: [],
          not: [],
          filters: {},
          order: "relevance",
        },
      ],
    } as const;
    const searchScope = {
      userId: phaseBFixture.userId,
      chatId: phaseBFixture.chatId,
      companyId: phaseBFixture.companyId,
      publicSourceIds: [],
      subscriptionIds: [],
      accessIds: [],
    } as const;
    const unbounded = await runDb(
      isolatedDatabaseUrl(),
      executeInternalQueryPlan(searchPlan, {
        scope: searchScope,
        branchCap: 20,
        maxConcurrency: 2,
        statementTimeoutMs: 10_000,
      }),
    );
    const unboundedChat = unbounded.branches.find((branch) => branch.branch === "chat_messages");
    const unboundedIds =
      unboundedChat?.hits.flatMap((hit) =>
        hit.identity.kind === "chat_message" ? [hit.identity.messageId] : [],
      ) ?? [];
    expect(unboundedIds).toContain(olderMessageId);
    expect(unboundedIds).toContain(currentMessageId);
    expect(unboundedIds).toContain(futureMessageId);

    const bounded = await runDb(
      isolatedDatabaseUrl(),
      executeInternalQueryPlan(searchPlan, {
        scope: { ...searchScope, currentMessageId },
        branchCap: 20,
        maxConcurrency: 2,
        statementTimeoutMs: 10_000,
      }),
    );
    const boundedChat = bounded.branches.find((branch) => branch.branch === "chat_messages");
    const boundedIds =
      boundedChat?.hits.flatMap((hit) =>
        hit.identity.kind === "chat_message" ? [hit.identity.messageId] : [],
      ) ?? [];
    expect(boundedIds).toContain(olderMessageId);
    expect(boundedIds).not.toContain(currentMessageId);
    expect(boundedIds).not.toContain(futureMessageId);
  }, 30_000);

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
            and usename = current_user
        `;
        yield* sql.unsafe(`drop database if exists ${quoteIdentifier(isolatedDatabaseName)}`);
      }),
    );
  }, 60_000);

  it(
    "unions both language configurations when languages is absent",
    { timeout: 60_000 },
    async () => {
      await runDb(
        isolatedDatabaseUrl(),
        Effect.gen(function* () {
          const previews = yield* structuredSearch({ terms: "stagflation" }, baseOptions);

          expect(sortedDocumentIds(previews)).toEqual([
            "ret-doc-stag-en",
            "ret-doc-stag-fr",
            "ret-doc-stag-fr-b",
          ]);
          expect([...new Set(previews.map((preview) => preview.sourceId))].sort()).toEqual([
            "public:ret-fr-a",
            "public:ret-fr-b",
            "public:ret-us",
          ]);
          expect(previews.every((preview) => preview.kind === "public_source")).toBe(true);
        }),
      );
    },
  );

  it("filters languages by primary subtag", { timeout: 60_000 }, async () => {
    await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const frenchPreviews = yield* structuredSearch(
          { terms: "photovoltaïque", languages: ["fr-FR"] },
          baseOptions,
        );
        expect(sortedDocumentIds(frenchPreviews)).toEqual([
          "ret-doc-pv-fr",
          "ret-doc-pv-frca",
          "ret-doc-pv-frfr",
        ]);

        const englishPreviews = yield* structuredSearch(
          { terms: "photovoltaïque", languages: ["en-US"] },
          baseOptions,
        );
        expect(orderedDocumentIds(englishPreviews)).toEqual(["ret-doc-pv-en"]);
      }),
    );
  });

  it("applies published date filters", { timeout: 60_000 }, async () => {
    await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const newerPreviews = yield* structuredSearch(
          {
            terms: "géothermie",
            publishedAfter: daysAgo(20).toISOString(),
          },
          baseOptions,
        );
        expect(orderedDocumentIds(newerPreviews)).toEqual(["ret-doc-geo-new"]);

        const olderPreviews = yield* structuredSearch(
          {
            terms: "géothermie",
            publishedBefore: daysAgo(45).toISOString(),
          },
          baseOptions,
        );
        expect(orderedDocumentIds(olderPreviews)).toEqual(["ret-doc-geo-old"]);

        const middlePreviews = yield* structuredSearch(
          {
            terms: "géothermie",
            publishedAfter: daysAgo(45).toISOString(),
            publishedBefore: daysAgo(20).toISOString(),
          },
          baseOptions,
        );
        expect(orderedDocumentIds(middlePreviews)).toEqual(["ret-doc-geo-mid"]);
      }),
    );
  });

  it("applies source, country and document type filters", { timeout: 60_000 }, async () => {
    await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sourcePreviews = yield* structuredSearch(
          { terms: "stagflation", sourceIds: ["ret-fr-a"] },
          baseOptions,
        );
        expect(orderedDocumentIds(sourcePreviews)).toEqual(["ret-doc-stag-fr"]);

        const countryPreviews = yield* structuredSearch(
          { terms: "stagflation", countries: ["US"] },
          baseOptions,
        );
        expect(orderedDocumentIds(countryPreviews)).toEqual(["ret-doc-stag-en"]);

        const typePreviews = yield* structuredSearch(
          { terms: "stagflation", documentTypes: ["report"] },
          baseOptions,
        );
        expect(orderedDocumentIds(typePreviews)).toEqual(["ret-doc-stag-fr-b"]);
      }),
    );
  });

  it("ranks by weighted relevance and recency decay", { timeout: 60_000 }, async () => {
    await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const failure = yield* Effect.flip(
          structuredSearch({ terms: "sémaphore" }, { ...baseOptions, recencyHalfLifeDays: 10_000 }),
        );
        expect(failure).toBeInstanceOf(Error);
        const recencyFailure = yield* Effect.flip(
          structuredSearch({ terms: "sémaphore", orderBy: "recency" }, baseOptions),
        );
        expect(recencyFailure).toBeInstanceOf(Error);
      }),
    );
  });

  it("collapses exact duplicates on content_hash", { timeout: 60_000 }, async () => {
    await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const previews = yield* structuredSearch({ terms: "dirigeable" }, baseOptions);

        expect(orderedDocumentIds(previews)).toEqual(["ret-doc-dir-a", "ret-doc-dir-b"]);
      }),
    );
  });

  it("caps limit by maxLimit", { timeout: 60_000 }, async () => {
    await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const cappedByOptions = yield* structuredSearch(
          { terms: "stagflation" },
          { ...baseOptions, maxLimit: 2 },
        );
        expect(cappedByOptions.length).toBeLessThanOrEqual(2);

        const cappedBySpec = yield* structuredSearch(
          { terms: "stagflation", limit: 1 },
          baseOptions,
        );
        expect(cappedBySpec.length).toBeLessThanOrEqual(1);

        const cappedByMax = yield* structuredSearch(
          { terms: "stagflation", limit: 999 },
          { ...baseOptions, maxLimit: 2 },
        );
        expect(cappedByMax.length).toBeLessThanOrEqual(2);
      }),
    );
  });

  it("returns spec-shaped previews with snippet", { timeout: 60_000 }, async () => {
    await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const previews = yield* structuredSearch(
          { terms: "stagflation", languages: ["fr-FR"] },
          baseOptions,
        );
        const preview = previews.find((candidate) => candidate.documentId === "ret-doc-stag-fr");

        if (preview === undefined) {
          throw new Error("Missing ret-doc-stag-fr preview");
        }

        expect(preview.title).toBe("Note sur la stagflation");
        expect(preview.sourceDisplayName).toBe("Retrieval FR A");
        expect(preview.language).toBe("fr");
        expect(preview.documentType).toBe("article");
        expect(preview.textCharCount).toBe(stagFrText.length);
        expect(preview.publishedAt).toBeInstanceOf(Date);
        expect(preview.snippet).toEqual(expect.any(String));
        expect(preview.snippet.length).toBeGreaterThan(0);
        expect(preview.snippet.length).toBeLessThanOrEqual(300);
        expect(preview.snippet.toLowerCase()).toContain("stagflation");
        expect(preview.previewRanges).toEqual([
          expect.objectContaining({ charStart: expect.any(Number), charEnd: expect.any(Number) }),
        ]);
        expect(
          preview.previewRanges
            .map((range) => preview.text.slice(range.charStart, range.charEnd))
            .join("\n…\n"),
        ).toBe(preview.snippet);
        expect(Object.keys(preview)).toContain("text");
      }),
    );
  });

  it(
    "maps repeated multi-fragment headlines to exact UTF-16 source spans",
    { timeout: 60_000 },
    async () => {
      await runDb(
        isolatedDatabaseUrl(),
        Effect.gen(function* () {
          const previews = yield* structuredSearch(
            { terms: "needle", languages: ["en-US"], sourceIds: ["ret-us"] },
            baseOptions,
          );
          const preview = previews.find(
            (candidate) => candidate.documentId === "ret-doc-repeated-headline",
          );
          if (preview === undefined) throw new Error("Missing repeated-headline preview");
          const firstStart = repeatedHeadlineText.indexOf("Needle");
          const secondStart = repeatedHeadlineText.lastIndexOf("Needle");
          expect(preview.previewRanges).toEqual([
            { charStart: firstStart, charEnd: firstStart + "Needle".length },
            { charStart: secondStart, charEnd: secondStart + "Needle".length },
          ]);
          for (const [index, range] of preview.previewRanges.entries()) {
            expect(range.charStart).toBeGreaterThanOrEqual(0);
            expect(range.charEnd).toBeLessThanOrEqual(preview.text.length);
            expect(range.charEnd).toBeGreaterThan(range.charStart);
            if (index > 0) {
              expect(range.charStart).toBeGreaterThanOrEqual(
                preview.previewRanges[index - 1]!.charEnd,
              );
            }
            expect(preview.text.slice(range.charStart, range.charEnd)).toBe(
              preview.snippet.split("\n…\n")[index],
            );
            expect(preview.text.slice(range.charStart, range.charEnd).toLowerCase()).toContain(
              "needle",
            );
          }
        }),
      );
    },
  );

  it("keeps supplementary-character offsets in UTF-16 units", { timeout: 60_000 }, async () => {
    await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const previews = yield* structuredSearch(
          { terms: "needle", languages: ["en-US"], sourceIds: ["ret-us"] },
          baseOptions,
        );
        const preview = previews.find(
          (candidate) => candidate.documentId === "ret-doc-unicode-headline",
        );
        if (preview === undefined) throw new Error("Missing unicode-headline preview");
        const firstRange = preview.previewRanges[0];
        if (firstRange === undefined) throw new Error("Missing unicode preview range");
        const expectedStart = unicodeHeadlineText.indexOf("needle");
        expect(firstRange).toEqual({
          charStart: expectedStart,
          charEnd: expectedStart + "needle".length,
        });
        expect(preview.text.slice(firstRange.charStart, firstRange.charEnd)).toBe(preview.snippet);
        expect(preview.text.slice(0, 2)).toBe("😀");
      }),
    );
  });

  it(
    "fails closed when a database hit has no exact immutable-text occurrence",
    { timeout: 60_000 },
    async () => {
      await runDb(
        isolatedDatabaseUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const hits = yield* sql<{ readonly count: number }>`
            select count(*)::int as count
            from public_source_documents
            where document_id = 'ret-doc-unmappable-headline'
              and search_vector @@ websearch_to_tsquery('english', 'running')
          `;
          expect(hits[0]?.count).toBe(1);
          const failure = yield* Effect.flip(
            structuredSearch(
              { terms: "running", languages: ["en-US"], sourceIds: ["ret-us"] },
              baseOptions,
            ),
          );
          expect(failure).toBeInstanceOf(Error);
        }),
      );
    },
  );

  it("derives access from the caller", { timeout: 60_000 }, async () => {
    await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const usOnlyPreviews = yield* structuredSearch(
          { terms: "stagflation" },
          {
            ...baseOptions,
            access: { kind: "sourceIds", sourceIds: ["ret-us"] },
          },
        );
        expect(orderedDocumentIds(usOnlyPreviews)).toEqual(["ret-doc-stag-en"]);

        const noSourcePreviews = yield* structuredSearch(
          { terms: "stagflation" },
          {
            ...baseOptions,
            access: { kind: "sourceIds", sourceIds: [] },
          },
        );
        expect(noSourcePreviews).toEqual([]);

        const allSourcePreviews = yield* structuredSearch(
          { terms: "stagflation" },
          {
            ...baseOptions,
            access: authorizedSourceAccess,
          },
        );
        expect(sortedDocumentIds(allSourcePreviews)).toEqual([
          "ret-doc-stag-en",
          "ret-doc-stag-fr",
          "ret-doc-stag-fr-b",
        ]);
      }),
    );
  });

  it("hostile terms cannot escape parameterization", { timeout: 60_000 }, async () => {
    await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const hostileTermsResult = yield* structuredSearch(
          { terms: "'; drop table public_source_documents; --" },
          baseOptions,
        );
        expect(Array.isArray(hostileTermsResult)).toBe(true);

        const documentTableRows = yield* sql<{
          readonly name: string | null;
        }>`
            select to_regclass('public.public_source_documents')::text as name
          `;
        expect(documentTableRows[0]?.name).not.toBeNull();

        const hostileLanguageResult = yield* structuredSearch(
          {
            terms: "stagflation",
            languages: ["fr'; drop table jobs; --"],
          },
          baseOptions,
        );
        expect(hostileLanguageResult).toEqual([]);

        const jobsTableRows = yield* sql<{ readonly name: string | null }>`
            select to_regclass('public.jobs')::text as name
          `;
        expect(jobsTableRows[0]?.name).not.toBeNull();
      }),
    );
  });

  it("fails with InvalidQuerySpecError on empty terms", { timeout: 60_000 }, async () => {
    await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const failure = yield* Effect.flip(structuredSearch({ terms: "   " }, baseOptions));

        expect(failure).toBeInstanceOf(Error);
      }),
    );
  });

  it("peeks verbatim slices with bounds", { timeout: 60_000 }, async () => {
    await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const exactSlice = yield* structuredPeek("ret-doc-peek", 10, 25, {
          access: authorizedSourceAccess,
        });
        expect(exactSlice).toEqual({
          documentId: "ret-doc-peek",
          text: peekText.slice(10, 35),
          offsetChars: 10,
          lengthChars: 25,
          textCharCount: 400,
        });

        const defaultSlice = yield* structuredPeek("ret-doc-peek", undefined, undefined, {
          access: authorizedSourceAccess,
          defaultLengthChars: 50,
        });
        expect(defaultSlice?.text).toBe(peekText.slice(0, 50));
        expect(defaultSlice?.lengthChars).toBe(50);

        const maxSlice = yield* structuredPeek("ret-doc-peek", 0, 500, {
          access: authorizedSourceAccess,
          maxLengthChars: 100,
        });
        expect(maxSlice?.lengthChars).toBe(100);
        expect(maxSlice?.text).toBe(peekText.slice(0, 100));

        const outOfBoundsSlice = yield* structuredPeek("ret-doc-peek", 1000, 50, {
          access: authorizedSourceAccess,
        });
        expect(outOfBoundsSlice?.text).toBe("");
        expect(outOfBoundsSlice?.lengthChars).toBe(0);
        expect(outOfBoundsSlice?.offsetChars).toBe(400);

        const hugeOffsetSlice = yield* structuredPeek("ret-doc-peek", Number.MAX_SAFE_INTEGER, 50, {
          access: authorizedSourceAccess,
        });
        expect(hugeOffsetSlice?.text).toBe("");
        expect(hugeOffsetSlice?.lengthChars).toBe(0);
        expect(hugeOffsetSlice?.offsetChars).toBe(400);

        const missingDocument = yield* structuredPeek("ret-doc-missing", undefined, undefined, {
          access: authorizedSourceAccess,
        });
        expect(missingDocument).toBeNull();

        const inaccessibleDocument = yield* structuredPeek("ret-doc-peek", undefined, undefined, {
          access: { kind: "sourceIds", sourceIds: ["ret-us"] },
        });
        expect(inaccessibleDocument).toBeNull();
      }),
    );
  });
});
