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
  fuseTwoStageRankedResults,
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

const publisherHit = (queryOrdinal: number, rank: number, documentId: string, date: string) => ({
  queryOrdinal,
  branch: "publisher_documents" as const,
  rank,
  identity: {
    kind: "publisher_document" as const,
    subscriptionId: "subscription",
    issueId: "issue",
    documentId,
    snapshotId: "snapshot",
    publisherExtractionId: "extraction",
    contentHash: hash,
  },
  value: documentId,
  date,
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

  it("feeds stage one into stage two for cross-branch logical documents and chats", () => {
    const publisher = {
      kind: "publisher_document" as const,
      subscriptionId: "subscription",
      issueId: "issue",
      documentId: "shared",
      snapshotId: "snapshot",
      publisherExtractionId: "extraction",
      contentHash: hash,
    };
    const chat = {
      kind: "chat_message" as const,
      messageId: "chat",
      sanitizedContentHash: hash,
    };
    const branches = [
      {
        queryOrdinal: 1,
        branch: "public_documents" as const,
        status: "applicable" as const,
        hits: [hit(1, 1, "shared"), hit(1, 2, "other")],
        cap: 4,
        truncated: false,
      },
      {
        queryOrdinal: 1,
        branch: "publisher_documents" as const,
        status: "applicable" as const,
        hits: [
          {
            queryOrdinal: 1,
            branch: "publisher_documents" as const,
            rank: 1,
            identity: publisher,
            value: "publisher",
          },
        ],
        cap: 4,
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
            identity: chat,
            value: "chat",
          },
        ],
        cap: 4,
        truncated: false,
      },
    ] as const;
    const flat = fuseRankedResults(branches);
    const staged = fuseTwoStageRankedResults(branches);
    expect(staged.results.map((result) => result.value)).not.toEqual(
      flat.results.map((result) => result.value),
    );
    const shared = staged.results.find(
      (result) =>
        (result.identity.kind === "public_document" ||
          result.identity.kind === "publisher_document") &&
        result.identity.documentId === "shared",
    )!;
    expect(shared.physicalIdentities).toHaveLength(2);
    expect(shared.provenance.map((entry) => entry.branch)).toEqual([
      "public_documents",
      "publisher_documents",
    ]);
    expect(() =>
      fuseTwoStageRankedResults([
        branches[0]!,
        {
          ...branches[1]!,
          hits: [
            {
              ...branches[1]!.hits[0]!,
              identity: { ...publisher, contentHash: "b".repeat(64) },
            },
          ],
        },
        branches[2]!,
      ]),
    ).toThrow(/conflicting immutable proof/u);
    expect(staged.results.some((result) => result.identity.kind === "chat_message")).toBe(true);
    expect(FusedResultSetSchema.parse(staged)).toBeDefined();
  });

  it("keeps score and logical rank ahead of requested date order", () => {
    const branches = [
      {
        queryOrdinal: 1,
        branch: "public_documents" as const,
        status: "applicable" as const,
        hits: [
          { ...hit(1, 1, "older"), date: "2020-01-01" },
          { ...hit(1, 2, "newer"), date: "2030-01-01" },
        ],
        cap: 4,
        truncated: false,
      },
      notApplicable(1, "publisher_documents"),
      notApplicable(1, "chat_messages"),
    ];
    expect(
      fuseTwoStageRankedResults(branches, { order: "newest" }).results.map((item) =>
        item.identity.kind === "chat_message" ? "" : item.identity.documentId,
      ),
    ).toEqual(["older", "newer"]);
    expect(
      fuseTwoStageRankedResults(branches, { order: "oldest" }).results.map((item) =>
        item.identity.kind === "chat_message" ? "" : item.identity.documentId,
      ),
    ).toEqual(["older", "newer"]);
  });

  it.each(["newest", "oldest"] as const)(
    "uses uniform %s date order only after equal stage scores and ranks across queries",
    (order) => {
      const branches = [1, 2].flatMap((queryOrdinal) => [
        {
          queryOrdinal,
          branch: "public_documents" as const,
          status: "applicable" as const,
          hits: [
            { ...hit(queryOrdinal, 1, "older"), date: "2020-01-01" },
            { ...hit(queryOrdinal, 2, "newer"), date: "2030-01-01" },
          ],
          cap: 4,
          truncated: false,
        },
        {
          queryOrdinal,
          branch: "publisher_documents" as const,
          status: "applicable" as const,
          hits: [
            publisherHit(queryOrdinal, 1, "newer", "2030-01-01"),
            publisherHit(queryOrdinal, 2, "older", "2020-01-01"),
          ],
          cap: 4,
          truncated: false,
        },
        notApplicable(queryOrdinal, "chat_messages"),
      ]);
      const result = fuseTwoStageRankedResults(branches, { order });
      const byId = new Map(
        result.results.map((item) => [
          item.identity.kind === "chat_message" ? "" : item.identity.documentId,
          item,
        ]),
      );
      const first = order === "newest" ? "newer" : "older";
      const second = first === "newer" ? "older" : "newer";
      expect(
        result.results.map((item) =>
          item.identity.kind === "chat_message" ? "" : item.identity.documentId,
        ),
      ).toEqual([first, second]);
      expect(byId.get(first)?.provenance.every((entry) => entry.logicalRank === 1)).toBe(true);
      expect(byId.get(second)?.provenance.every((entry) => entry.logicalRank === 2)).toBe(true);
      expect(byId.get(first)?.bestRank).toBe(1);
      expect(byId.get(second)?.bestRank).toBe(2);
    },
  );

  it.each(["newest", "oldest"] as const)(
    "keeps final score and best logical rank ahead of date for %s",
    (order) => {
      const branches = [1, 2].flatMap((queryOrdinal) => [
        {
          queryOrdinal,
          branch: "public_documents" as const,
          status: "applicable" as const,
          hits: [
            { ...hit(queryOrdinal, 1, "older"), date: "2020-01-01" },
            { ...hit(queryOrdinal, 2, "newer"), date: "2030-01-01" },
          ],
          cap: 4,
          truncated: false,
        },
        notApplicable(queryOrdinal, "publisher_documents"),
        notApplicable(queryOrdinal, "chat_messages"),
      ]);
      const result = fuseTwoStageRankedResults(branches, { order });
      expect(
        result.results.map((item) =>
          item.identity.kind === "chat_message" ? "" : item.identity.documentId,
        ),
      ).toEqual(["older", "newer"]);
      expect(result.results[0]?.score).toBeGreaterThan(result.results[1]?.score ?? 0);
      expect(result.results[0]?.bestRank).toBeLessThan(result.results[1]?.bestRank ?? 0);
    },
  );

  it.each(["newest", "oldest"] as const)(
    "uses best logical rank before date when final scores tie for %s",
    (order) => {
      const branchFor = (queryOrdinal: number, olderRank: number) => {
        const ids = Array.from({ length: 24 }, (_, index) => `filler-${queryOrdinal}-${index + 1}`);
        ids[olderRank - 1] = "older";
        ids[11] = "newer";
        return {
          queryOrdinal,
          branch: "public_documents" as const,
          status: "applicable" as const,
          hits: ids.map((documentId, index) => ({
            ...hit(queryOrdinal, index + 1, documentId),
            date:
              documentId === "older"
                ? "2020-01-01"
                : documentId === "newer"
                  ? "2030-01-01"
                  : "2025-01-01",
          })),
          cap: 24,
          truncated: false,
        };
      };
      const result = fuseTwoStageRankedResults(
        [
          branchFor(1, 3),
          notApplicable(1, "publisher_documents"),
          notApplicable(1, "chat_messages"),
          branchFor(2, 24),
          notApplicable(2, "publisher_documents"),
          notApplicable(2, "chat_messages"),
        ],
        { order },
      );
      const older = result.results.find(
        (item) => item.identity.kind !== "chat_message" && item.identity.documentId === "older",
      )!;
      const newer = result.results.find(
        (item) => item.identity.kind !== "chat_message" && item.identity.documentId === "newer",
      )!;
      expect(older.score).toBe(newer.score);
      expect(older.bestRank).toBe(3);
      expect(newer.bestRank).toBe(12);
      expect(result.results.indexOf(older)).toBeLessThan(result.results.indexOf(newer));
    },
  );

  it("uses date descending for mixed-order equal score and rank ties", () => {
    const result = fuseTwoStageRankedResults([
      {
        queryOrdinal: 1,
        branch: "public_documents" as const,
        order: "newest" as const,
        status: "applicable" as const,
        hits: [{ ...hit(1, 1, "q1-old"), date: "2020-01-01" }],
        cap: 4,
        truncated: false,
      },
      notApplicable(1, "publisher_documents"),
      notApplicable(1, "chat_messages"),
      {
        queryOrdinal: 2,
        branch: "public_documents" as const,
        order: "oldest" as const,
        status: "applicable" as const,
        hits: [{ ...hit(2, 1, "q2-new"), date: "2030-01-01" }],
        cap: 4,
        truncated: false,
      },
      notApplicable(2, "publisher_documents"),
      notApplicable(2, "chat_messages"),
    ]);
    expect(
      result.results.map((item) =>
        item.identity.kind === "chat_message" ? "" : item.identity.documentId,
      ),
    ).toEqual(["q2-new", "q1-old"]);
    expect(result.results[0]?.score).toBe(result.results[1]?.score);
    expect(result.results[0]?.bestRank).toBe(result.results[1]?.bestRank);
  });

  it("uses UTF-8 canonical identity for exact date ties", () => {
    const tie = fuseTwoStageRankedResults([
      {
        queryOrdinal: 1,
        branch: "public_documents" as const,
        status: "applicable" as const,
        hits: [{ ...hit(1, 1, "é"), date: "2020-01-01" }],
        cap: 4,
        truncated: false,
      },
      notApplicable(1, "publisher_documents"),
      notApplicable(1, "chat_messages"),
      {
        queryOrdinal: 2,
        branch: "public_documents" as const,
        status: "applicable" as const,
        hits: [{ ...hit(2, 1, "z"), date: "2020-01-01" }],
        cap: 4,
        truncated: false,
      },
      notApplicable(2, "publisher_documents"),
      notApplicable(2, "chat_messages"),
    ]);
    expect(
      tie.results.map((item) =>
        item.identity.kind === "chat_message" ? "" : item.identity.documentId,
      ),
    ).toEqual(["z", "é"]);
  });

  it("fails closed for two-stage immutable proof conflicts and merges exact duplicates", () => {
    const base = [
      {
        queryOrdinal: 1,
        branch: "public_documents" as const,
        status: "applicable" as const,
        hits: [hit(1, 1, "same")],
        cap: 4,
        truncated: false,
      },
      notApplicable(1, "publisher_documents"),
      notApplicable(1, "chat_messages"),
    ];
    const duplicate = fuseTwoStageRankedResults([
      ...base,
      {
        ...base[0]!,
        queryOrdinal: 2,
        hits: [hit(2, 1, "same")],
      },
      notApplicable(2, "publisher_documents"),
      notApplicable(2, "chat_messages"),
    ]);
    expect(duplicate.results).toHaveLength(1);
    expect(duplicate.results[0]?.provenance).toHaveLength(2);
    for (const identity of [
      { ...publicIdentity("same"), contentHash: "b".repeat(64) },
      { ...publicIdentity("same"), snapshotId: "changed" },
      { ...publicIdentity("same"), sourceId: "changed-source" },
    ]) {
      expect(() =>
        fuseTwoStageRankedResults([
          ...base,
          {
            ...base[0]!,
            queryOrdinal: 2,
            hits: [{ ...hit(2, 1, "same"), identity }],
          },
          notApplicable(2, "publisher_documents"),
          notApplicable(2, "chat_messages"),
        ]),
      ).toThrow(/conflicting immutable proof/u);
    }
    for (const changedHit of [
      { ...hit(2, 1, "same"), date: "2026-01-01" },
      { ...hit(2, 1, "same"), value: "changed title" },
    ]) {
      expect(() =>
        fuseTwoStageRankedResults([
          ...base,
          { ...base[0]!, queryOrdinal: 2, hits: [changedHit] },
          notApplicable(2, "publisher_documents"),
          notApplicable(2, "chat_messages"),
        ]),
      ).toThrow(/conflicting immutable proof/u);
    }
    const publisherIdentity = {
      kind: "publisher_document" as const,
      subscriptionId: "subscription",
      issueId: "issue",
      documentId: "same-publisher",
      snapshotId: "snapshot",
      publisherExtractionId: "extraction",
      contentHash: hash,
    };
    expect(() =>
      fuseTwoStageRankedResults([
        {
          queryOrdinal: 1,
          branch: "publisher_documents" as const,
          status: "applicable" as const,
          hits: [
            {
              queryOrdinal: 1,
              branch: "publisher_documents" as const,
              rank: 1,
              identity: publisherIdentity,
              value: "publisher",
            },
          ],
          cap: 4,
          truncated: false,
        },
        notApplicable(1, "public_documents"),
        notApplicable(1, "chat_messages"),
        {
          queryOrdinal: 2,
          branch: "publisher_documents" as const,
          status: "applicable" as const,
          hits: [
            {
              queryOrdinal: 2,
              branch: "publisher_documents" as const,
              rank: 1,
              identity: { ...publisherIdentity, publisherExtractionId: "changed" },
              value: "publisher",
            },
          ],
          cap: 4,
          truncated: false,
        },
        notApplicable(2, "public_documents"),
        notApplicable(2, "chat_messages"),
      ]),
    ).toThrow(/conflicting immutable proof/u);
    const chat = (sanitizedContentHash: string) => ({
      kind: "chat_message" as const,
      messageId: "message",
      sanitizedContentHash,
    });
    expect(() =>
      fuseTwoStageRankedResults([
        {
          queryOrdinal: 1,
          branch: "chat_messages" as const,
          status: "applicable" as const,
          hits: [
            {
              queryOrdinal: 1,
              branch: "chat_messages" as const,
              rank: 1,
              identity: chat(hash),
              value: "chat",
            },
          ],
          cap: 4,
          truncated: false,
        },
        notApplicable(1, "public_documents"),
        notApplicable(1, "publisher_documents"),
        {
          queryOrdinal: 2,
          branch: "chat_messages" as const,
          status: "applicable" as const,
          hits: [
            {
              queryOrdinal: 2,
              branch: "chat_messages" as const,
              rank: 1,
              identity: chat("b".repeat(64)),
              value: "chat",
            },
          ],
          cap: 4,
          truncated: false,
        },
        notApplicable(2, "public_documents"),
        notApplicable(2, "publisher_documents"),
      ]),
    ).toThrow(/conflicting immutable proof/u);
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
