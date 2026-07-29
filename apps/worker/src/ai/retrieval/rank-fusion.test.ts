import { describe, expect, it } from "vitest";

import {
  CanonicalIdentitySchema,
  FusedResultSchema,
  FusedResultSetSchema,
  RankedBranchResultSchema,
  ReviewModelFusedResultSchema,
  canonicalIdentityKey,
  compareBytewise,
  fuseRankedResults,
  reciprocalRankContribution,
  toReviewModelFusedResults,
} from "./rank-fusion";

const notApplicable = (
  queryOrdinal: number,
  branch: "public_documents" | "publisher_documents" | "chat_messages",
) => ({
  queryOrdinal,
  branch,
  status: "not_applicable" as const,
  reason: "scope_documents" as const,
  hits: [],
  cap: 4,
  truncated: false,
});

const hash = "a".repeat(64);
const publicIdentity = (documentId: string, contentHash = hash) => ({
  kind: "public_document" as const,
  sourceId: "source",
  documentId,
  snapshotId: "snapshot",
  contentHash,
});

const hit = <T = string>(
  queryOrdinal: number,
  rank: number,
  documentId: string,
  value: T = documentId as T,
) => ({
  queryOrdinal,
  branch: "public_documents" as const,
  rank,
  identity: publicIdentity(documentId),
  value,
});

describe("pure rank fusion", () => {
  it("uses equal RRF contributions with exact provenance proof", () => {
    const fused = fuseRankedResults([
      {
        queryOrdinal: 1,
        branch: "public_documents",
        status: "applicable",
        hits: [hit(1, 1, "a")],
        cap: 4,
        truncated: false,
      },
      notApplicable(1, "publisher_documents"),
      notApplicable(1, "chat_messages"),
      {
        queryOrdinal: 2,
        branch: "public_documents",
        status: "applicable",
        hits: [hit(2, 1, "a")],
        cap: 4,
        truncated: false,
      },
      notApplicable(2, "publisher_documents"),
      notApplicable(2, "chat_messages"),
    ]);
    expect(fused.results).toHaveLength(1);
    expect(fused.results[0]?.score).toBeCloseTo(2 * reciprocalRankContribution(1));
    expect(fused.results[0]?.matchedQueryOrdinals).toEqual([1, 2]);
    expect(FusedResultSchema.parse(fused.results[0])).toBeDefined();
    expect(() => FusedResultSchema.parse({ ...fused.results[0], score: 99 })).toThrow();
    expect(() =>
      FusedResultSchema.parse({ ...fused.results[0], matchedQueryOrdinals: [1] }),
    ).toThrow();
  });

  it("rejects duplicate physical hits, branch-kind conflicts, and identity proof conflicts", () => {
    expect(() =>
      fuseRankedResults([
        {
          queryOrdinal: 1,
          branch: "public_documents",
          status: "applicable",
          hits: [hit(1, 1, "a"), hit(1, 2, "a")],
          cap: 4,
          truncated: false,
        },
        notApplicable(1, "publisher_documents"),
        notApplicable(1, "chat_messages"),
      ]),
    ).toThrow(/repeat a canonical identity/u);
    expect(() =>
      fuseRankedResults([
        {
          queryOrdinal: 1,
          branch: "publisher_documents",
          status: "applicable",
          hits: [{ ...hit(1, 1, "a"), branch: "publisher_documents" }],
          cap: 4,
          truncated: false,
        },
        notApplicable(1, "public_documents"),
        notApplicable(1, "chat_messages"),
      ]),
    ).toThrow(/identity kind/u);

    const changedHash = publicIdentity("a", "b".repeat(64));
    expect(canonicalIdentityKey(publicIdentity("a"))).toBe(canonicalIdentityKey(changedHash));
    expect(() =>
      CanonicalIdentitySchema.parse({
        kind: "public_document",
        sourceId: "source",
        documentId: "a",
        snapshotId: "snapshot",
      }),
    ).toThrow();
    expect(() =>
      fuseRankedResults([
        {
          queryOrdinal: 1,
          branch: "public_documents",
          status: "applicable",
          hits: [hit(1, 1, "a")],
          cap: 4,
          truncated: false,
        },
        notApplicable(1, "publisher_documents"),
        notApplicable(1, "chat_messages"),
        {
          queryOrdinal: 2,
          branch: "public_documents",
          status: "applicable",
          hits: [{ ...hit(2, 1, "a"), identity: changedHash }],
          cap: 4,
          truncated: false,
        },
        notApplicable(2, "publisher_documents"),
        notApplicable(2, "chat_messages"),
      ]),
    ).toThrow(/conflicting immutable proof/u);
  });

  it("keeps ranked branch envelopes strict and provenance-aligned", () => {
    const branch = {
      queryOrdinal: 1,
      branch: "public_documents" as const,
      status: "applicable" as const,
      hits: [hit(1, 1, "a")],
      cap: 2,
      truncated: false,
    };
    expect(RankedBranchResultSchema.parse(branch)).toBeDefined();
    expect(() =>
      RankedBranchResultSchema.parse({
        ...branch,
        hits: [{ ...branch.hits[0], rank: 2 }],
      }),
    ).toThrow(/sequential/u);
    expect(() =>
      RankedBranchResultSchema.parse({
        ...branch,
        status: "not_applicable",
        reason: "unsupported_country_filter",
      }),
    ).toThrow(/empty/u);
    expect(() =>
      RankedBranchResultSchema.parse({
        ...branch,
        status: "not_applicable",
        reason: "drop table",
      }),
    ).toThrow();
  });

  it("requires one complete physical branch envelope per contiguous query", () => {
    const publicRow = {
      queryOrdinal: 1,
      branch: "public_documents" as const,
      status: "applicable" as const,
      hits: [hit(1, 1, "a")],
      cap: 4,
      truncated: false,
    };
    expect(() => fuseRankedResults([publicRow, notApplicable(1, "publisher_documents")])).toThrow(
      /missing branch coverage/u,
    );
    expect(() =>
      fuseRankedResults([
        publicRow,
        notApplicable(1, "publisher_documents"),
        notApplicable(1, "chat_messages"),
        publicRow,
      ]),
    ).toThrow(/unique/u);
    expect(() =>
      fuseRankedResults([
        publicRow,
        notApplicable(1, "publisher_documents"),
        notApplicable(1, "chat_messages"),
        { ...publicRow, queryOrdinal: 3, hits: [hit(3, 1, "b")] },
        notApplicable(3, "publisher_documents"),
        notApplicable(3, "chat_messages"),
      ]),
    ).toThrow(/contiguous/u);
    expect(() =>
      fuseRankedResults([
        publicRow,
        notApplicable(1, "publisher_documents"),
        notApplicable(1, "chat_messages"),
        {
          ...publicRow,
          branch: "legacy" as never,
        },
      ]),
    ).toThrow(/unknown physical branch/u);
    expect(() =>
      fuseRankedResults([
        publicRow,
        notApplicable(1, "publisher_documents"),
        notApplicable(1, "chat_messages"),
        { ...publicRow, queryOrdinal: 2, hits: [hit(2, 1, "b")] },
        notApplicable(2, "publisher_documents"),
        notApplicable(2, "chat_messages"),
        { ...publicRow, queryOrdinal: 4, hits: [hit(4, 1, "c")] },
        notApplicable(4, "publisher_documents"),
        notApplicable(4, "chat_messages"),
      ]),
    ).toThrow(/contiguous/u);
  });

  it("carries branch, candidate, and hydration truncation proof", () => {
    expect(compareBytewise("é", "z")).toBeGreaterThan(0);
    const value = (id: string, bytes: number) => ({ id, bytes });
    const fused = fuseRankedResults(
      [
        {
          queryOrdinal: 1,
          branch: "public_documents",
          status: "applicable",
          hits: [hit(1, 1, "a", value("a", 2)), hit(1, 2, "b", value("b", 2))],
          cap: 2,
          truncated: true,
        },
        notApplicable(1, "publisher_documents"),
        notApplicable(1, "chat_messages"),
        {
          queryOrdinal: 2,
          branch: "public_documents",
          status: "applicable",
          hits: [hit(2, 1, "c", value("c", 2))],
          cap: 2,
          truncated: false,
        },
        notApplicable(2, "publisher_documents"),
        notApplicable(2, "chat_messages"),
      ],
      {
        maxCandidates: 2,
        maxHydratedBytes: 2,
        hydrationBytes: (entry) => entry.bytes,
      },
    );
    expect(fused.results).toHaveLength(1);
    expect(fused.candidateCountBeforeCap).toBe(3);
    expect(fused.candidateCap).toBe(2);
    expect(fused.hydratedBytes).toBe(2);
    expect(fused.hydrationByteCap).toBe(2);
    expect(fused.truncation).toEqual({ branch: true, candidates: true, hydration: true });
    expect(FusedResultSetSchema.parse(fused)).toBeDefined();
  });

  it("uses canonical UTF-8 byte order for equal-score ties", () => {
    const fused = fuseRankedResults([
      {
        queryOrdinal: 1,
        branch: "public_documents",
        status: "applicable",
        hits: [hit(1, 1, "z")],
        cap: 4,
        truncated: false,
      },
      notApplicable(1, "publisher_documents"),
      notApplicable(1, "chat_messages"),
      {
        queryOrdinal: 2,
        branch: "public_documents",
        status: "applicable",
        hits: [hit(2, 1, "é")],
        cap: 4,
        truncated: false,
      },
      notApplicable(2, "publisher_documents"),
      notApplicable(2, "chat_messages"),
    ]);
    expect(
      fused.results.map((result) =>
        result.identity.kind === "public_document" ? result.identity.documentId : "",
      ),
    ).toEqual(["z", "é"]);
  });

  it("projects the exact provider-safe review shape and no private fields", () => {
    const fused = fuseRankedResults([
      {
        queryOrdinal: 1,
        branch: "public_documents",
        status: "applicable",
        hits: [
          hit(1, 1, "a", {
            kind: "document" as const,
            label: "Document",
            date: "2026-01-01",
            tokenCount: 17,
            preview: "Exact preview",
          }),
        ],
        cap: 4,
        truncated: false,
      },
      {
        queryOrdinal: 1,
        branch: "publisher_documents",
        status: "not_applicable",
        reason: "unsupported_country_filter",
        hits: [],
        cap: 4,
        truncated: false,
      },
      notApplicable(1, "chat_messages"),
    ]);
    const views = toReviewModelFusedResults(fused);
    expect(ReviewModelFusedResultSchema.parse(views[0])).toBeDefined();
    expect(views[0]?.branchCoverage).toEqual([
      {
        queryOrdinal: 1,
        branch: "chat_messages",
        status: "not_applicable",
        reason: "scope_documents",
        hitCount: 0,
        truncated: false,
        cap: 4,
      },
      {
        queryOrdinal: 1,
        branch: "public_documents",
        status: "applicable",
        hitCount: 1,
        truncated: false,
        cap: 4,
      },
      {
        queryOrdinal: 1,
        branch: "publisher_documents",
        status: "not_applicable",
        reason: "unsupported_country_filter",
        hitCount: 0,
        truncated: false,
        cap: 4,
      },
    ]);
    expect(Object.keys(views[0]!).sort()).toEqual(
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
    for (const privateField of [
      "identity",
      "identityKey",
      "value",
      "sourceId",
      "documentId",
      "messageId",
      "contentHash",
      "sql",
      "table",
      "provenance",
      "rrfK",
    ]) {
      expect(privateField in views[0]!).toBe(false);
    }
    expect(() =>
      ReviewModelFusedResultSchema.parse({
        ...views[0],
        sourceId: "private",
      }),
    ).toThrow();
  });
});
