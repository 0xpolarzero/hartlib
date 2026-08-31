import { describe, expect, it } from "vitest";

import {
  fuseRankedResults,
  reciprocalRankContribution,
  toReviewModelFusedResults,
  type RankedBranchResult,
} from "./rank-fusion";

const publicIdentity = (documentId: string, sourceId = "source-1") => ({
  kind: "public_document" as const,
  sourceId,
  documentId,
  snapshotId: `snapshot-${documentId}`,
  contentHash: "a".repeat(64),
});

const chatIdentity = (messageId: string) => ({
  kind: "chat_message" as const,
  messageId,
  sanitizedContentHash: "b".repeat(64),
});

const branches = <T = string>(
  queryOrdinal: number,
  publicHits: readonly ReturnType<typeof publicIdentity>[],
  chatHits: readonly ReturnType<typeof chatIdentity>[] = [],
  value: (identity: ReturnType<typeof publicIdentity> | ReturnType<typeof chatIdentity>) => T = (
    identity,
  ) => ("documentId" in identity ? identity.documentId : identity.messageId) as T,
): RankedBranchResult<T>[] => [
  {
    queryOrdinal,
    branch: "public_documents",
    status: "applicable",
    hits: publicHits.map((identity, index) => ({
      queryOrdinal,
      branch: "public_documents" as const,
      rank: index + 1,
      identity,
      value: value(identity),
      date: "2026-01-01T00:00:00.000Z",
    })),
    cap: Math.max(1, publicHits.length),
    truncated: false,
  },
  {
    queryOrdinal,
    branch: "chat_messages",
    status: chatHits.length === 0 ? "not_applicable" : "applicable",
    ...(chatHits.length === 0 ? { reason: "scope_documents" as const } : {}),
    hits: chatHits.map((identity, index) => ({
      queryOrdinal,
      branch: "chat_messages" as const,
      rank: index + 1,
      identity,
      value: value(identity),
      date: "2026-01-02T00:00:00.000Z",
    })),
    cap: Math.max(1, chatHits.length),
    truncated: false,
  },
];

describe("rank fusion", () => {
  it("computes reciprocal rank contributions", () => {
    expect(reciprocalRankContribution(1, 60)).toBeCloseTo(1 / 61);
    expect(() => reciprocalRankContribution(0)).toThrow();
  });

  it("fuses public documents across queries and retains provenance", () => {
    const first = publicIdentity("doc-1");
    const result = fuseRankedResults([
      ...branches(1, [first]),
      ...branches(2, [first, publicIdentity("doc-2")]),
    ]);
    expect(result.results.map((item) => item.identity)).toEqual([first, publicIdentity("doc-2")]);
    expect(result.results[0]?.matchedQueryOrdinals).toEqual([1, 2]);
    expect(result.results[0]?.provenance).toHaveLength(2);
    expect(result.coverage).toHaveLength(4);
  });

  it("fuses chat messages as a separate physical branch", () => {
    const result = fuseRankedResults(branches(1, [], [chatIdentity("message-1")]));
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.identity.kind).toBe("chat_message");
  });

  it("rejects incomplete branch coverage and identity mismatches", () => {
    const complete = branches(1, [publicIdentity("doc-1")]);
    expect(() => fuseRankedResults(complete.slice(0, 1))).toThrow(/coverage|branch/i);
    expect(() =>
      fuseRankedResults([
        {
          ...complete[0]!,
          hits: [
            {
              ...complete[0]!.hits[0]!,
              identity: chatIdentity("wrong-branch"),
            },
          ],
        },
        complete[1]!,
      ]),
    ).toThrow(/identity|branch/i);
  });

  it("applies candidate and hydration caps without splitting a candidate", () => {
    const result = fuseRankedResults(
      branches(1, [publicIdentity("doc-1"), publicIdentity("doc-2")]),
      { maxCandidates: 1, maxHydratedBytes: 8, hydrationBytes: (value) => value.length },
    );
    expect(result.results).toHaveLength(1);
    expect(result.truncation.candidates).toBe(true);
  });

  it("projects provider-safe review metadata", () => {
    const result = fuseRankedResults<{
      kind: "document";
      label: string;
      date: string;
      tokenCount: number;
      preview: string;
    }>([
      {
        ...branches(1, [publicIdentity("doc-1")], [], () => ({
          kind: "document" as const,
          label: "Document",
          date: "2026-01-01T00:00:00.000Z",
          tokenCount: 2,
          preview: "evidence",
        }))[0]!,
        hits: [
          {
            ...branches(1, [publicIdentity("doc-1")], [], () => ({
              kind: "document" as const,
              label: "Document",
              date: "2026-01-01T00:00:00.000Z",
              tokenCount: 2,
              preview: "evidence",
            }))[0]!.hits[0]!,
            value: {
              kind: "document",
              label: "Document",
              date: "2026-01-01T00:00:00.000Z",
              tokenCount: 2,
              preview: "evidence",
            },
          },
        ],
      },
      branches(1, [publicIdentity("doc-1")], [], () => ({
        kind: "document" as const,
        label: "Document",
        date: "2026-01-01T00:00:00.000Z",
        tokenCount: 2,
        preview: "evidence",
      }))[1]!,
    ]);
    expect(toReviewModelFusedResults(result)[0]).toMatchObject({
      resultId: "r1",
      kind: "document",
      preview: "evidence",
    });
  });
});
