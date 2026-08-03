import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  BranchCoverageSchema,
  BranchResultSchema,
  PHYSICAL_QUERY_BRANCHES,
  InternalQueryPlanProviderSchema,
  InternalQueryPlanSchema,
  InternalQueryProviderSchema,
  InternalQuerySchema,
  QUERY_CONTRACT_LIMITS,
  QueryReviewProviderSchema,
  QueryReviewSchema,
  StructuredRetrievalTraceSchema,
  normalizeInternalQueryPlanProvider,
  normalizeQueryReviewProvider,
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
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  const containsUniqueItems = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(containsUniqueItems);
    if (!isRecord(value)) return false;
    return value.uniqueItems === true || Object.values(value).some(containsUniqueItems);
  };

  it("exposes strict JSON-schema-safe provider contracts and normalizes after return", () => {
    const planSchema = z.toJSONSchema(InternalQueryPlanProviderSchema);
    const reviewSchema = z.toJSONSchema(QueryReviewProviderSchema);
    expect(planSchema).not.toHaveProperty("oneOf");
    expect(reviewSchema).not.toHaveProperty("oneOf");
    expect(planSchema).toMatchObject({
      type: "object",
      required: ["action"],
      additionalProperties: false,
    });

    const rawPlan = {
      action: "search" as const,
      queries: [
        {
          purpose: "  Résumé  ",
          all: [{ text: "  cafe\u0301  ", mode: "term" as const }],
          anyOf: [],
          not: [],
          filters: { documents: { publishedAt: { after: " 2026-02-01 " } } },
          order: "relevance" as const,
        },
      ],
    };
    const providerNullFilters = {
      ...rawPlan,
      queries: [
        {
          ...rawPlan.queries[0],
          filters: { documents: null, chatMessages: null },
        },
      ],
    };
    const parsedNullFilters = InternalQueryPlanProviderSchema.parse(providerNullFilters);
    expect(parsedNullFilters.action).toBe("search");
    if (parsedNullFilters.action === "search") {
      expect(parsedNullFilters.queries[0]?.filters).toEqual({
        documents: null,
        chatMessages: null,
      });
      const providerQuery = parsedNullFilters.queries[0]!;
      const flatAnyOf: typeof providerQuery.anyOf = [{ text: "flat", mode: "term" }];
      const nullableFilters: typeof providerQuery.filters = {
        documents: null,
        chatMessages: null,
      };
      expect(flatAnyOf).toEqual([{ text: "flat", mode: "term" }]);
      expect(nullableFilters).toEqual({ documents: null, chatMessages: null });
    }
    const normalizedNullFilters = normalizeInternalQueryPlanProvider(providerNullFilters);
    expect(normalizedNullFilters).toMatchObject({
      action: "search",
      queries: [{ filters: {} }],
    });
    expect(() => InternalQueryPlanProviderSchema.parse({ ...rawPlan, extra: true })).toThrow();
    expect(JSON.stringify(planSchema)).toContain("additionalProperties");
    expect(() =>
      InternalQueryProviderSchema.parse({
        ...rawPlan.queries[0],
        anyOf: [[]],
      }),
    ).toThrow();
    expect(() =>
      InternalQueryPlanSchema.parse({
        action: "search",
        queries: [
          {
            ...rawPlan.queries[0],
            filters: { documents: { publishedAt: { after: "2023-02-29" } } },
          },
        ],
      }),
    ).toThrow();

    const flattened = normalizeInternalQueryPlanProvider({
      action: "search",
      reason: "provider explanation is transport-only",
      queries: [
        {
          ...rawPlan.queries[0],
          anyOf: [
            { text: "battery", mode: "term" },
            { text: "accumulator", mode: "phrase" },
          ],
        },
      ],
    });
    expect(flattened.action === "search" ? flattened.queries[0]?.anyOf : undefined).toEqual([
      [
        { text: "battery", mode: "term" },
        { text: "accumulator", mode: "phrase" },
      ],
    ]);
    expect(flattened).not.toHaveProperty("reason");
    expect(() => normalizeInternalQueryPlanProvider({ action: "search", queries: [] })).toThrow();
  });

  it("keeps provider date and author constraints in raw parsing and emitted JSON Schema", () => {
    const plan = {
      action: "search" as const,
      queries: [
        {
          purpose: "date and author check",
          all: [{ text: "evidence", mode: "term" as const }],
          anyOf: [],
          not: [],
          filters: {
            chatMessages: {
              sentAt: { after: "2023-02-29" },
              authors: ["user", "user"],
            },
          },
          order: "relevance" as const,
        },
      ],
    };
    expect(PHYSICAL_QUERY_BRANCHES).toEqual([
      "public_documents",
      "publisher_documents",
      "chat_messages",
    ]);
    expect(() => InternalQueryPlanProviderSchema.parse(plan)).toThrow();
    expect(
      InternalQueryPlanProviderSchema.parse({
        ...plan,
        queries: [
          {
            ...plan.queries[0],
            filters: { chatMessages: { sentAt: { after: "2024-02-29" }, authors: ["user"] } },
          },
        ],
      }),
    ).toBeDefined();
    expect(containsUniqueItems(z.toJSONSchema(InternalQueryPlanProviderSchema))).toBe(true);
    expect(containsUniqueItems(z.toJSONSchema(QueryReviewProviderSchema))).toBe(true);
    expect(JSON.stringify(z.toJSONSchema(InternalQueryPlanProviderSchema))).toContain(
      '"format":"date"',
    );
    expect(
      normalizeQueryReviewProvider({ action: "accept", reason: "provider explanation" }),
    ).toEqual({
      action: "accept",
      reason: "sufficient_coverage",
    });
    expect(() => normalizeQueryReviewProvider({ action: "accept" })).toThrow();
    const providerReviewQuery = {
      ...query(),
      anyOf: [
        { text: "stockage", mode: "term" as const },
        { text: "storage", mode: "term" as const },
      ],
    };
    const parsedReview = QueryReviewProviderSchema.parse({
      action: "replace",
      reason: "unclassified provider prose",
      queries: [providerReviewQuery],
    });
    expect(parsedReview).toMatchObject({
      action: "replace",
      reason: "unclassified provider prose",
    });
    expect(
      normalizeQueryReviewProvider({
        action: "replace",
        reason: "Zero results: the English term missed the French concept.",
        queries: [providerReviewQuery],
      }),
    ).toMatchObject({ action: "replace", reason: "wrong_language" });
    expect(() =>
      normalizeQueryReviewProvider({
        action: "replace",
        reason: "unclassified provider prose",
        queries: [providerReviewQuery],
      }),
    ).toThrow();
  });

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
  it("enforces strict terminal retrieval trace outcomes", () => {
    const initialPlan = { action: "search" as const, queries: [query()] };
    const replacementPlan = { action: "search" as const, queries: [query("replacement")] };
    expect(
      StructuredRetrievalTraceSchema.parse({
        initialPlan: { action: "skip", reason: "not needed" },
        review: null,
        replacementPlan: null,
        outcome: "skipped",
      }).outcome,
    ).toBe("skipped");
    expect(
      StructuredRetrievalTraceSchema.parse({
        initialPlan,
        review: { action: "accept", reason: "sufficient_coverage" },
        replacementPlan: null,
        outcome: "accepted",
      }).outcome,
    ).toBe("accepted");
    expect(() =>
      StructuredRetrievalTraceSchema.parse({
        initialPlan,
        review: { action: "replace", reason: "missed_concept", queries: initialPlan.queries },
        replacementPlan,
        outcome: "replaced",
      }),
    ).toThrow();
    const matchingReplacement = { action: "search" as const, queries: [query()] };
    expect(
      StructuredRetrievalTraceSchema.parse({
        initialPlan,
        review: {
          action: "replace",
          reason: "missed_concept",
          queries: matchingReplacement.queries,
        },
        replacementPlan: matchingReplacement,
        outcome: "replaced",
      }).outcome,
    ).toBe("replaced");
    expect(
      StructuredRetrievalTraceSchema.parse({
        initialPlan,
        review: { action: "no_evidence", reason: "no_supporting_evidence" },
        replacementPlan: null,
        outcome: "no_evidence",
      }).outcome,
    ).toBe("no_evidence");
    expect(() =>
      StructuredRetrievalTraceSchema.parse({
        initialPlan,
        review: null,
        replacementPlan: null,
        outcome: "accepted",
      }),
    ).toThrow();
    expect(() =>
      StructuredRetrievalTraceSchema.parse({
        initialPlan,
        review: { action: "accept", reason: "sufficient_coverage" },
        replacementPlan: null,
        outcome: "accepted",
        extra: true,
      }),
    ).toThrow();
  });
});
