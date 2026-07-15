import { describe, expect, it } from "vitest";

import { sourceKeyForOrdinal, webQuoteHash } from "../runtime/canonicalization";
import type { AnswerLaneResult, FinalSourceRecord } from "../runtime/types";
import { assertFinalSourceMap } from "./finalization";

const citationNonce = new Uint8Array(16);
const citationNonceHex = Buffer.from(citationNonce).toString("hex");
const sourceKey = (ordinal: number): string => sourceKeyForOrdinal(citationNonce, ordinal);

const memorySource = (ordinal = 1): FinalSourceRecord => ({
  sourceKey: sourceKey(ordinal),
  locator: {
    kind: "memory",
    memoryId: "memory-1",
    memoryRevisionId: "revision-1",
  },
  label: null,
  publicProvenance: {},
  uses: [
    {
      consumerTaskId: "single-answer",
      contextOrder: ordinal - 1,
      renderedTokenCount: 12,
      ranges: [],
    },
  ],
});

const singleAnswer = (
  sourceMap: readonly FinalSourceRecord[],
): Extract<AnswerLaneResult, { readonly status: "ok" }> => ({
  status: "ok",
  mode: "single",
  content: "Answer",
  sourceMap,
});

describe("final source-map validation", () => {
  it("accepts a valid turn-local immutable source map", () => {
    expect(() =>
      assertFinalSourceMap(singleAnswer([memorySource()]), citationNonceHex),
    ).not.toThrow();
  });

  it("accepts a zero-token marginal for a source use", () => {
    const source = memorySource();
    expect(() =>
      assertFinalSourceMap(
        singleAnswer([{ ...source, uses: [{ ...source.uses[0]!, renderedTokenCount: 0 }] }]),
        citationNonceHex,
      ),
    ).not.toThrow();
  });

  it("rejects clarification provenance and keys from another citation namespace", () => {
    expect(() =>
      assertFinalSourceMap(
        { status: "ok", mode: "clarification", content: "Clarify", sourceMap: [memorySource()] },
        citationNonceHex,
      ),
    ).toThrow("clarification result must have an empty source map");
    expect(() =>
      assertFinalSourceMap(
        singleAnswer([
          { ...memorySource(), sourceKey: sourceKeyForOrdinal(new Uint8Array(16).fill(1), 1) },
        ]),
        citationNonceHex,
      ),
    ).toThrow("outside the current citation namespace");
  });

  it("rejects duplicate identities, missing consumers, and invalid consumer ownership", () => {
    expect(() =>
      assertFinalSourceMap(singleAnswer([memorySource(1), memorySource(2)]), citationNonceHex),
    ).toThrow("duplicate final source identity");
    expect(() =>
      assertFinalSourceMap(singleAnswer([{ ...memorySource(), uses: [] }]), citationNonceHex),
    ).toThrow("source has no answer consumer");
    expect(() =>
      assertFinalSourceMap(
        singleAnswer([
          {
            ...memorySource(),
            uses: [
              {
                consumerTaskId: "topic-t1-answer",
                topicId: "t1",
                contextOrder: 0,
                renderedTokenCount: 12,
                ranges: [],
              },
            ],
          },
        ]),
        citationNonceHex,
      ),
    ).toThrow("single answer has a non-single source consumer");
  });

  it("rejects non-normalized document ranges and incomplete publisher provenance", () => {
    const document: FinalSourceRecord = {
      sourceKey: sourceKey(1),
      locator: {
        kind: "document",
        sourceId: "public:source-1",
        documentId: "document-1",
        documentVersionId: "version-1",
        contentHash: "a".repeat(64),
        ranges: [
          { charStart: 0, charEnd: 10 },
          { charStart: 15, charEnd: 20 },
        ],
      },
      label: "Report",
      publicProvenance: {
        documentTitle: "Report",
        citationUrl: "https://example.test/report",
      },
      uses: [
        {
          consumerTaskId: "single-answer",
          contextOrder: 0,
          renderedTokenCount: 10,
          ranges: [{ charStart: 0, charEnd: 10 }],
        },
      ],
    };
    if (document.locator.kind !== "document") throw new Error("expected document locator");
    const documentLocator = document.locator;
    expect(() =>
      assertFinalSourceMap(
        singleAnswer([
          {
            ...document,
            uses: [{ ...document.uses[0]!, ranges: [{ charStart: 9, charEnd: 16 }] }],
          },
        ]),
        citationNonceHex,
      ),
    ).toThrow("document use range exceeds locator union");
    expect(() =>
      assertFinalSourceMap(
        singleAnswer([
          {
            ...document,
            locator: { ...documentLocator, publisherIssueId: "issue-1" },
          },
        ]),
        citationNonceHex,
      ),
    ).toThrow("publisher document identity is incomplete");
    for (const citationUrl of [
      "http://example.com/report",
      "https://user@example.com/report",
      "/relative/report",
    ]) {
      expect(() =>
        assertFinalSourceMap(
          singleAnswer([
            { ...document, publicProvenance: { documentTitle: "Report", citationUrl } },
          ]),
          citationNonceHex,
        ),
      ).toThrow("document public provenance is incomplete");
    }
    expect(() =>
      assertFinalSourceMap(
        singleAnswer([
          {
            ...document,
            locator: { ...documentLocator, sourceId: "publisher:source-1" },
          },
        ]),
        citationNonceHex,
      ),
    ).toThrow("public document source identity is incomplete");
    for (const sourceId of [
      "source-1",
      " public:source-1",
      "public:public:source-1",
      "public:source-1\u2003",
    ]) {
      expect(
        () =>
          assertFinalSourceMap(
            singleAnswer([
              {
                ...document,
                locator: { ...documentLocator, sourceId },
              },
            ]),
            citationNonceHex,
          ),
        sourceId,
      ).toThrow("document locator identity is incomplete");
    }
    expect(() =>
      assertFinalSourceMap(
        singleAnswer([
          {
            ...document,
            locator: {
              ...documentLocator,
              sourceId: "publisher:source-1",
              publisherIssueId: "issue-1",
              publisherDocumentId: "other-document",
            },
          },
        ]),
        citationNonceHex,
      ),
    ).toThrow("publisher document provenance is incomplete");
    expect(() =>
      assertFinalSourceMap(
        singleAnswer([
          {
            ...document,
            publicProvenance: {
              documentTitle: "Report",
              citationUrl: "https://example.test/report",
              forged: true,
            } as never,
          },
        ]),
        citationNonceHex,
      ),
    ).toThrow();
  });

  it("rejects stale document locator ranges and non-contiguous consumer ledgers", () => {
    const document: FinalSourceRecord = {
      sourceKey: sourceKey(1),
      locator: {
        kind: "document",
        sourceId: "public:source-1",
        documentId: "document-1",
        documentVersionId: "version-1",
        contentHash: "a".repeat(64),
        ranges: [
          { charStart: 0, charEnd: 10 },
          { charStart: 20, charEnd: 30 },
        ],
      },
      label: "Report",
      publicProvenance: {
        documentTitle: "Report",
        citationUrl: "https://example.test/report",
      },
      uses: [
        {
          consumerTaskId: "single-answer",
          contextOrder: 0,
          renderedTokenCount: 10,
          ranges: [{ charStart: 0, charEnd: 10 }],
        },
      ],
    };
    const documentLocator = document.locator;
    if (documentLocator.kind !== "document") throw new Error("expected document locator");

    expect(() => assertFinalSourceMap(singleAnswer([document]), citationNonceHex)).toThrow(
      "document use ranges do not equal locator union",
    );

    expect(() =>
      assertFinalSourceMap(
        singleAnswer([
          {
            ...document,
            locator: {
              ...documentLocator,
              ranges: [{ charStart: 0, charEnd: 10 }],
            },
            uses: [
              {
                ...document.uses[0]!,
                contextOrder: 1,
                ranges: [{ charStart: 0, charEnd: 10 }],
              },
            ],
          },
        ]),
        citationNonceHex,
      ),
    ).toThrow("non-contiguous context order");
  });

  it("property: each consumer's document slices reconstruct exactly its locator union", () => {
    const cases = [
      [[{ charStart: 0, charEnd: 4 }]],
      [
        [
          { charStart: 0, charEnd: 6 },
          { charStart: 8, charEnd: 10 },
        ],
      ],
      [
        [
          { charStart: 0, charEnd: 4 },
          { charStart: 8, charEnd: 12 },
        ],
      ],
    ] as const;

    for (const [index, useRanges] of cases.entries()) {
      const allRanges = useRanges.flat();
      const locatorRanges = allRanges.map((range) => ({ ...range }));
      const source: FinalSourceRecord = {
        sourceKey: sourceKey(index + 1),
        locator: {
          kind: "document",
          sourceId: `public:source-${index + 1}`,
          documentId: `document-${index + 1}`,
          documentVersionId: `version-${index + 1}`,
          contentHash: "b".repeat(64),
          ranges: locatorRanges,
        },
        label: "Report",
        publicProvenance: {
          documentTitle: "Report",
          citationUrl: "https://example.test/report",
        },
        uses: useRanges.map((ranges, contextOrder) => ({
          consumerTaskId: "single-answer",
          contextOrder,
          renderedTokenCount: 10,
          ranges: [...ranges],
        })),
      };
      expect(() => assertFinalSourceMap(singleAnswer([source]), citationNonceHex)).not.toThrow();
    }
  });

  it("rejects mutable or fabricated web provenance", () => {
    const quote = "Official result.";
    const web: FinalSourceRecord = {
      sourceKey: sourceKey(1),
      locator: {
        kind: "web",
        url: "https://example.com/report",
        title: "Official report",
        domain: "example.com",
        quote,
        quoteHash: webQuoteHash(quote),
        capturedAt: "2026-07-10T12:00:00.000Z",
      },
      label: "Official report",
      publicProvenance: { citationUrl: "https://example.com/report" },
      uses: [
        {
          consumerTaskId: "single-answer",
          contextOrder: 0,
          renderedTokenCount: 10,
          ranges: [],
        },
      ],
    };
    if (web.locator.kind !== "web") throw new Error("expected web locator");
    const webLocator = web.locator;
    expect(() => assertFinalSourceMap(singleAnswer([web]), citationNonceHex)).not.toThrow();
    expect(() =>
      assertFinalSourceMap(
        singleAnswer([
          {
            ...web,
            locator: { ...webLocator, domain: "attacker.example" },
          },
        ]),
        citationNonceHex,
      ),
    ).toThrow("web locator provenance is not canonical");
    expect(() =>
      assertFinalSourceMap(
        singleAnswer([{ ...web, publicProvenance: { citationUrl: "https://other.example" } }]),
        citationNonceHex,
      ),
    ).toThrow("web public provenance URL differs");
  });
});
