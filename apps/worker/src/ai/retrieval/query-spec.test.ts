import { describe, expect, it } from "vitest";

import {
  BranchCoverageSchema,
  BranchResultSchema,
  InternalQueryPlanSchema,
  InternalQuerySchema,
  QUERY_CONTRACT_LIMITS,
  QueryReviewSchema,
} from "./query-spec";

const query = (purpose = "Résumé des batteries") => ({
  purpose,
  all: [{ text: " batterie ", mode: "term" as const }],
  anyOf: [
    [
      { text: "stockage", mode: "term" as const },
      { text: "storage", mode: "term" as const },
    ],
  ],
  not: [],
  filters: { documents: { languages: [" fr-FR "] } },
  order: "relevance" as const,
});

const branchHit = {
  resultId: "r1",
  kind: "chat_message" as const,
  label: null,
  date: null,
  fullTokenCount: 4,
  preview: "text",
};

describe("Phase A query contracts", () => {
  it("uses NFC and outer trim only and rejects hostile unknown fields", () => {
    const parsed = InternalQuerySchema.parse({
      ...query("  Re\u0301sume\u0301  exact  wording  "),
      all: [{ text: "  cafe\u0301  au  lait  ", mode: "phrase" }],
    });
    expect(parsed.purpose).toBe("Résumé  exact  wording");
    expect(parsed.all[0]?.text).toBe("café  au  lait");
    expect(() => InternalQuerySchema.parse({ ...query(), extra: true })).toThrow();
    expect(() =>
      InternalQuerySchema.parse({
        ...query(),
        filters: { documents: { languages: ["fr"], sql: "drop table" } },
      }),
    ).toThrow();
  });

  it("rejects negative-only work without an applicable positive indexed filter", () => {
    const negativeOnly = {
      ...query(),
      all: [],
      anyOf: [],
      not: [{ text: "x", mode: "term" as const }],
    };
    expect(() => InternalQuerySchema.parse({ ...negativeOnly, filters: {} })).toThrow();
    expect(() =>
      InternalQuerySchema.parse({
        ...negativeOnly,
        scope: "documents",
        filters: { chatMessages: { authors: ["assistant"] } },
      }),
    ).toThrow();
    expect(() =>
      InternalQuerySchema.parse({
        ...negativeOnly,
        scope: "documents",
        filters: { documents: { publishedAt: { after: "2026-01-01" } } },
      }),
    ).not.toThrow();
    expect(() =>
      InternalQuerySchema.parse({
        ...negativeOnly,
        filters: { documents: { publishedAt: { after: "2026-01-01" } } },
      }),
    ).toThrow();
    expect(() =>
      InternalQuerySchema.parse({
        ...negativeOnly,
        filters: {
          documents: { publishedAt: { after: "2026-01-01" } },
          chatMessages: { sentAt: { after: "2026-01-01" } },
        },
      }),
    ).not.toThrow();
    expect(() =>
      InternalQuerySchema.parse({
        ...negativeOnly,
        scope: "chat_messages",
        filters: { chatMessages: { authors: ["assistant"] } },
      }),
    ).not.toThrow();
  });

  it("rejects duplicate normalized atom text even when the mode differs", () => {
    expect(() =>
      InternalQuerySchema.parse({
        ...query(),
        all: [
          { text: "cafe\u0301", mode: "term" as const },
          { text: " café ", mode: "phrase" as const },
        ],
        anyOf: [],
      }),
    ).toThrow(/unique/u);
  });

  it("enforces exact calendar dates and ordered intervals", () => {
    const withDate = (publishedAt: { after?: string; before?: string }) => ({
      ...query(),
      filters: { documents: { publishedAt } },
    });
    expect(InternalQuerySchema.parse(withDate({ after: "2024-02-29" }))).toBeDefined();
    expect(() => InternalQuerySchema.parse(withDate({ after: "2023-02-29" }))).toThrow();
    expect(() => InternalQuerySchema.parse(withDate({ after: "2026-1-01" }))).toThrow();
    expect(() =>
      InternalQuerySchema.parse(withDate({ after: "2026-02-01", before: "2026-01-01" })),
    ).toThrow();
  });

  it("enforces exact query, atom, and UTF-8 byte bounds", () => {
    const exactAtom = "é".repeat(QUERY_CONTRACT_LIMITS.maxAtomUtf8Bytes / 2);
    expect(
      InternalQuerySchema.parse({
        ...query(),
        all: [{ text: exactAtom, mode: "term" }],
        anyOf: [],
      }),
    ).toBeDefined();
    expect(() =>
      InternalQuerySchema.parse({
        ...query(),
        all: [{ text: `${exactAtom}é`, mode: "term" }],
        anyOf: [],
      }),
    ).toThrow();

    const atoms = Array.from({ length: 128 }, (_, index) => ({
      text: `a${index}`,
      mode: "term" as const,
    }));
    const exactAtomQuery = {
      ...query(),
      all: atoms,
      anyOf: [
        atoms.map((atom) => ({ ...atom, text: `b${atom.text}` })),
        atoms.map((atom) => ({ ...atom, text: `d${atom.text}` })),
      ],
      not: atoms.map((atom) => ({ ...atom, text: `c${atom.text}` })),
    };
    expect(
      InternalQueryPlanSchema.parse({ action: "search", queries: [exactAtomQuery] }),
    ).toBeDefined();
    expect(() =>
      InternalQueryPlanSchema.parse({
        action: "search",
        queries: [
          {
            ...exactAtomQuery,
            anyOf: [...exactAtomQuery.anyOf, [{ text: "one-too-many", mode: "term" }]],
          },
        ],
      }),
    ).toThrow();

    const exactQueries = Array.from({ length: QUERY_CONTRACT_LIMITS.maxQueries }, (_, index) =>
      query(`purpose ${index}`),
    );
    expect(
      InternalQueryPlanSchema.parse({ action: "search", queries: exactQueries }),
    ).toBeDefined();
    expect(() =>
      InternalQueryPlanSchema.parse({
        action: "search",
        queries: [...exactQueries, query("too many")],
      }),
    ).toThrow();
    expect(() =>
      InternalQueryPlanSchema.parse({
        action: "search",
        queries: exactQueries.map((item, index) => ({
          ...item,
          purpose: `${index} ${"x".repeat(1200)}`,
        })),
      }),
    ).toThrow();

    const exactByteQueries = exactQueries.map((item) => InternalQuerySchema.parse(item));
    const encoder = new TextEncoder();
    const exactBytePlan = { action: "search" as const, queries: exactByteQueries };
    let bytesToAdd =
      QUERY_CONTRACT_LIMITS.maxPlanUtf8Bytes -
      encoder.encode(JSON.stringify(exactBytePlan)).byteLength;
    for (const item of exactByteQueries) {
      const available = QUERY_CONTRACT_LIMITS.maxPurposeUtf8Bytes - item.purpose.length;
      const added = Math.min(available, bytesToAdd);
      item.purpose += "x".repeat(added);
      bytesToAdd -= added;
    }
    expect(bytesToAdd).toBe(0);
    expect(encoder.encode(JSON.stringify(exactBytePlan))).toHaveLength(
      QUERY_CONTRACT_LIMITS.maxPlanUtf8Bytes,
    );
    expect(InternalQueryPlanSchema.parse(exactBytePlan)).toBeDefined();
    exactByteQueries.at(-1)!.purpose += "x";
    expect(() => InternalQueryPlanSchema.parse(exactBytePlan)).toThrow();
  });

  it("keeps review and branch coverage recursively strict and cap-safe", () => {
    for (const reason of [
      "sufficient_coverage",
      "missed_concept",
      "narrow_filter",
      "wrong_language",
      "unsupported_branch",
      "no_supporting_evidence",
    ] as const) {
      const action =
        reason === "sufficient_coverage"
          ? { action: "accept" as const, reason }
          : reason === "no_supporting_evidence"
            ? { action: "no_evidence" as const, reason }
            : { action: "replace" as const, reason, queries: [query()] };
      expect(QueryReviewSchema.parse(action).reason).toBe(reason);
    }
    expect(
      QueryReviewSchema.parse({
        action: "replace",
        reason: "missed_concept",
        queries: [query()],
      }).action,
    ).toBe("replace");
    expect(() =>
      QueryReviewSchema.parse({ action: "accept", reason: "sufficient_coverage", queries: [] }),
    ).toThrow();
    expect(() =>
      QueryReviewSchema.parse({ action: "replace", reason: "drop table", queries: [query()] }),
    ).toThrow();
    expect(() =>
      QueryReviewSchema.parse({ action: "accept", reason: "missing_concept" }),
    ).toThrow();
    for (const reason of [
      "scope_documents",
      "scope_chat_messages",
      "unsupported_country_filter",
    ] as const) {
      expect(
        BranchCoverageSchema.parse({
          queryOrdinal: 1,
          branch: "chat_messages",
          status: "not_applicable",
          reason,
          hitCount: 0,
          truncated: false,
          cap: 4,
        }).reason,
      ).toBe(reason);
    }
    expect(() =>
      BranchCoverageSchema.parse({
        queryOrdinal: 1,
        branch: "chat_messages",
        status: "not_applicable",
        reason: "scope_documents",
        hitCount: 1,
        truncated: false,
        cap: 4,
      }),
    ).toThrow();
    expect(() =>
      BranchCoverageSchema.parse({
        queryOrdinal: 1,
        branch: "chat_messages",
        status: "applicable",
        hitCount: 5,
        truncated: false,
        cap: 4,
      }),
    ).toThrow();
    expect(() =>
      BranchResultSchema.parse({
        queryOrdinal: 1,
        branch: "chat_messages",
        status: "applicable",
        hitCount: 2,
        truncated: false,
        cap: 1,
        hits: [branchHit, { ...branchHit, resultId: "r2" }],
      }),
    ).toThrow();
    expect(() =>
      BranchResultSchema.parse({
        queryOrdinal: 1,
        branch: "chat_messages",
        status: "applicable",
        hitCount: 1,
        truncated: false,
        cap: 4,
        hits: [{ ...branchHit, kind: "document" }],
      }),
    ).toThrow(/kind/u);
    expect(() =>
      BranchResultSchema.parse({
        queryOrdinal: 1,
        branch: "chat_messages",
        status: "applicable",
        hitCount: 1,
        truncated: false,
        cap: 4,
        hits: [{ ...branchHit, preview: "é".repeat(QUERY_CONTRACT_LIMITS.maxHitPreviewUtf8Bytes) }],
      }),
    ).toThrow(/large/u);
    expect(() =>
      BranchResultSchema.parse({
        queryOrdinal: 1,
        branch: "chat_messages",
        status: "not_applicable",
        reason: "scope_documents",
        hitCount: 1,
        truncated: false,
        cap: 4,
        hits: [branchHit],
      }),
    ).toThrow();
  });
});
