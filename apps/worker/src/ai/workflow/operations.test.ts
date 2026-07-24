import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { CanonicalAgentClient } from "../runtime/agent-client";
import { resolveRegisteredModel } from "../runtime/model-registry";
import type { AnswerCandidate, FinalSourceRecord, PlanTurnResult } from "../runtime/types";
import {
  type CanonicalAiConfig,
  CanonicalWorkflowOperations,
  documentReferenceIdentity,
  answerDeltaEmissionKey,
  answerStartedEmissionKey,
  canonicalProviderValueSchemas,
  InternalRetrievalSearchProtocol,
  boundedWebProviderText,
  internalSearchQueryIssue,
  normalizeInternalChatSearchTerms,
  normalizeSelectedDocumentRanges,
  searchWithinCandidate,
  searchWithinCandidateWindow,
  type ContextState,
  type LoadedTurn,
} from "./operations";

describe("bounded web provider views", () => {
  it("keeps exact beginning and ending excerpts within the provider token bound", () => {
    const page = "BEGINNING evidence " + "middle ".repeat(100) + "ENDING evidence";
    const bounded = boundedWebProviderText(page, 50, (value) => value.length);

    expect(bounded.length).toBeLessThanOrEqual(50);
    expect(bounded.startsWith("BEGINNING evidence")).toBe(true);
    expect(bounded.endsWith("ENDING evidence")).toBe(true);
    expect(page.includes("BEGINNING evidence")).toBe(true);
    expect(page.includes("ENDING evidence")).toBe(true);
  });
});

describe("older chat search terms", () => {
  it("removes temporal scope modifiers without losing the requested subject", () => {
    expect(normalizeInternalChatSearchTerms("old storage pilot")).toBe("storage pilot");
    expect(normalizeInternalChatSearchTerms("earlier prior storage")).toBe("storage");
    expect(normalizeInternalChatSearchTerms("old")).toBe("old");
  });
});

describe("canonical answer event emission keys", () => {
  it("uses only consumer task, answer attempt, and delta index", () => {
    expect(answerStartedEmissionKey("single-answer", 1)).toBe("answer_started:single-answer:1");
    expect(answerDeltaEmissionKey("single-answer", 1, 0)).toBe("text_delta:single-answer:1:0");
    expect(answerDeltaEmissionKey("single-answer", 2, 0)).not.toBe(
      answerDeltaEmissionKey("single-answer", 1, 0),
    );
  });

  it("uses flat provider schemas but retains exact semantic unions", () => {
    const planTurnProviderJsonSchema = z.toJSONSchema(
      canonicalProviderValueSchemas.planTurnProvider,
    ) as Record<string, unknown>;
    expect(planTurnProviderJsonSchema).toMatchObject({
      type: "object",
      required: ["mode"],
      additionalProperties: false,
    });
    expect(planTurnProviderJsonSchema).not.toHaveProperty("oneOf");
    const validPlanTurnOutputs = [
      { mode: "clarify", question: "Which result?" },
      { mode: "single", question: "resolved", relevantTurnIds: ["turn-1"] },
      {
        mode: "fanout",
        question: "resolved",
        topics: [
          { question: "First", relevantTurnIds: ["turn-1"] },
          { question: "Second", relevantTurnIds: [] },
        ],
      },
    ];
    for (const output of validPlanTurnOutputs) {
      expect(
        canonicalProviderValueSchemas.planTurn.parse(
          canonicalProviderValueSchemas.planTurnProvider.parse(output),
        ),
      ).toEqual(output);
    }
    expect(() => canonicalProviderValueSchemas.planTurnProvider.parse({})).toThrow();
    expect(() =>
      canonicalProviderValueSchemas.planTurn.parse(
        canonicalProviderValueSchemas.planTurnProvider.parse({
          mode: "clarify",
          question: "Which result?",
          extra: true,
        }),
      ),
    ).toThrow();

    const providerJsonSchema = z.toJSONSchema(
      canonicalProviderValueSchemas.planTurnProvider,
    ) as Record<string, unknown>;
    expect(providerJsonSchema).toMatchObject({
      type: "object",
      required: ["mode"],
      additionalProperties: false,
    });
    expect(providerJsonSchema).not.toHaveProperty("oneOf");
    expect(
      canonicalProviderValueSchemas.planTurnProvider.parse({
        mode: "single",
      }),
    ).toEqual({ mode: "single" });
    expect(() =>
      canonicalProviderValueSchemas.planTurn.parse({
        mode: "single",
        question: "The request is atomic.",
        relevantTurnIds: [],
        topics: [
          { question: "First", relevantTurnIds: [] },
          { question: "Second", relevantTurnIds: [] },
        ],
      }),
    ).toThrow();
  });
});

describe("document selection range semantics", () => {
  it("treats absent and explicitly empty ranges as the complete immutable document", () => {
    expect(normalizeSelectedDocumentRanges(undefined, 12)).toEqual([{ charStart: 0, charEnd: 12 }]);
    expect(normalizeSelectedDocumentRanges([], 12)).toEqual([{ charStart: 0, charEnd: 12 }]);
    expect(normalizeSelectedDocumentRanges([{ charStart: 2, charEnd: 7 }], 12)).toEqual([
      { charStart: 2, charEnd: 7 },
    ]);
  });

  it("reports literal matches in original-document coordinates across noncontiguous ranges", () => {
    const candidate: AnswerCandidate = {
      id: "document:one",
      kind: "document",
      rank: 0,
      purpose: "test ranges",
      sourceId: "source-one",
      documentId: "document-one",
      versionId: "version-one",
      contentHash: "a".repeat(64),
      text: "alpha hidden alpha gap alpha",
      ranges: [
        { charStart: 0, charEnd: 5 },
        { charStart: 19, charEnd: 28 },
      ],
      label: "Document",
      publicProvenance: {
        documentTitle: "Document",
        citationUrl: "https://example.test/document",
      },
      renderedTokenCount: 0,
    };

    expect(searchWithinCandidate(candidate, "alpha")).toEqual([
      { charStart: 0, charEnd: 5 },
      { charStart: 23, charEnd: 28 },
    ]);
  });

  it("keeps offsets in the original text when Unicode case folding expands a prefix", () => {
    const candidate: AnswerCandidate = {
      id: "document:unicode",
      kind: "document",
      rank: 0,
      purpose: "test Unicode offsets",
      sourceId: "source-unicode",
      documentId: "document-unicode",
      versionId: "version-unicode",
      contentHash: "c".repeat(64),
      text: "İ alpha 😀 ALPHA",
      ranges: [{ charStart: 0, charEnd: "İ alpha 😀 ALPHA".length }],
      label: "Unicode",
      publicProvenance: {
        documentTitle: "Unicode",
        citationUrl: "https://example.test/unicode",
      },
      renderedTokenCount: 0,
    };

    expect(searchWithinCandidate(candidate, "alpha")).toEqual([
      { charStart: 2, charEnd: 7 },
      { charStart: 11, charEnd: 16 },
    ]);
  });

  it("maps composed, decomposed, combining, and supplementary matches to UTF-16 spans", () => {
    const text = "Cafe\u0301 CAFÉ x😀y";
    const candidate: AnswerCandidate = {
      id: "document:unicode-spans",
      kind: "document",
      rank: 0,
      purpose: "test normalized UTF-16 spans",
      sourceId: "source-unicode-spans",
      documentId: "document-unicode-spans",
      versionId: "version-unicode-spans",
      contentHash: "d".repeat(64),
      text,
      ranges: [{ charStart: 0, charEnd: text.length }],
      label: "Unicode spans",
      publicProvenance: {
        documentTitle: "Unicode spans",
        citationUrl: "https://example.test/unicode-spans",
      },
      renderedTokenCount: 0,
    };

    expect(searchWithinCandidate(candidate, "café")).toEqual([
      { charStart: 0, charEnd: 5 },
      { charStart: 6, charEnd: 10 },
    ]);
    expect(searchWithinCandidate(candidate, "e\u0301")).toEqual([
      { charStart: 3, charEnd: 5 },
      { charStart: 9, charEnd: 10 },
    ]);
    expect(searchWithinCandidate(candidate, "😀")).toEqual([{ charStart: 12, charEnd: 14 }]);
  });

  it("rejects surrogate fragments and malformed suffixes while preserving supplementary offsets", () => {
    const text = "x😀y needle";
    const candidate: AnswerCandidate = {
      id: "document:surrogate-boundaries",
      kind: "document",
      rank: 0,
      purpose: "test surrogate boundaries",
      sourceId: "source-surrogate-boundaries",
      documentId: "document-surrogate-boundaries",
      versionId: "version-surrogate-boundaries",
      contentHash: "s".repeat(64),
      text,
      ranges: [{ charStart: 0, charEnd: text.length }],
      label: "Surrogate boundaries",
      publicProvenance: {
        documentTitle: "Surrogate boundaries",
        citationUrl: "https://example.test/surrogate-boundaries",
      },
      renderedTokenCount: 0,
    };

    expect(searchWithinCandidate(candidate, "\ud83d")).toEqual([]);
    expect(searchWithinCandidate(candidate, "\ude00")).toEqual([]);
    expect(searchWithinCandidate(candidate, "needle\ud800")).toEqual([]);
    expect(searchWithinCandidate(candidate, "😀")).toEqual([{ charStart: 1, charEnd: 3 }]);
    expect(searchWithinCandidate(candidate, "needle")).toEqual([{ charStart: 5, charEnd: 11 }]);
  });

  it("keeps a combining-mark match narrower than its base code point", () => {
    const text = "x\u0301";
    const candidate: AnswerCandidate = {
      id: "document:combining-only",
      kind: "document",
      rank: 0,
      purpose: "test combining-only spans",
      sourceId: "source-combining-only",
      documentId: "document-combining-only",
      versionId: "version-combining-only",
      contentHash: "1".repeat(64),
      text,
      ranges: [{ charStart: 0, charEnd: text.length }],
      label: "Combining only",
      publicProvenance: {
        documentTitle: "Combining only",
        citationUrl: "https://example.test/combining-only",
      },
      renderedTokenCount: 0,
    };

    expect(searchWithinCandidate(candidate, "x")).toEqual([{ charStart: 0, charEnd: 1 }]);
    expect(searchWithinCandidate(candidate, "\u0301")).toEqual([{ charStart: 1, charEnd: 2 }]);
  });

  it("maps canonically reordered marks to their original code-point spans", () => {
    const text = "x\u0315\u0300";
    const candidate: AnswerCandidate = {
      id: "document:reordered-marks",
      kind: "document",
      rank: 0,
      purpose: "test reordered combining marks",
      sourceId: "source-reordered-marks",
      documentId: "document-reordered-marks",
      versionId: "version-reordered-marks",
      contentHash: "2".repeat(64),
      text,
      ranges: [{ charStart: 0, charEnd: text.length }],
      label: "Reordered marks",
      publicProvenance: {
        documentTitle: "Reordered marks",
        citationUrl: "https://example.test/reordered-marks",
      },
      renderedTokenCount: 0,
    };

    expect(searchWithinCandidate(candidate, "\u0300")).toEqual([{ charStart: 2, charEnd: 3 }]);
    expect(searchWithinCandidate(candidate, "\u0315")).toEqual([{ charStart: 1, charEnd: 2 }]);
  });

  it("maps a composed code point to only the source contributors it needs", () => {
    const text = "a\u0301\u0323";
    const candidate: AnswerCandidate = {
      id: "document:composed-reordered-mark",
      kind: "document",
      rank: 0,
      purpose: "test composed reordered contributors",
      sourceId: "source-composed-reordered-mark",
      documentId: "document-composed-reordered-mark",
      versionId: "version-composed-reordered-mark",
      contentHash: "4".repeat(64),
      text,
      ranges: [{ charStart: 0, charEnd: text.length }],
      label: "Composed reordered mark",
      publicProvenance: {
        documentTitle: "Composed reordered mark",
        citationUrl: "https://example.test/composed-reordered-mark",
      },
      renderedTokenCount: 0,
    };

    // NFKC reorders the marks before composing a + dot-below into ạ. The
    // range is the smallest UTF-16 interval containing those contributors.
    expect(searchWithinCandidate(candidate, "ạ")).toEqual([{ charStart: 0, charEnd: 3 }]);
    expect(searchWithinCandidate(candidate, "\u0301")).toEqual([{ charStart: 1, charEnd: 2 }]);
  });

  it("composes across a lower-class combining mark without losing contributors", () => {
    const text = "a\u0334\u0301";
    const candidate: AnswerCandidate = {
      id: "document:blocked-composition",
      kind: "document",
      rank: 0,
      purpose: "test composition across a lower-class mark",
      sourceId: "source-blocked-composition",
      documentId: "document-blocked-composition",
      versionId: "version-blocked-composition",
      contentHash: "5".repeat(64),
      text,
      ranges: [{ charStart: 0, charEnd: text.length }],
      label: "Blocked composition",
      publicProvenance: {
        documentTitle: "Blocked composition",
        citationUrl: "https://example.test/blocked-composition",
      },
      renderedTokenCount: 0,
    };

    expect(searchWithinCandidate(candidate, "á")).toEqual([{ charStart: 0, charEnd: 3 }]);
    expect(searchWithinCandidate(candidate, "\u0334")).toEqual([{ charStart: 1, charEnd: 2 }]);
  });

  it("keeps supplementary and following combining contributors distinct", () => {
    const text = "😀\u0301";
    const candidate: AnswerCandidate = {
      id: "document:supplementary-combining",
      kind: "document",
      rank: 0,
      purpose: "test supplementary combining spans",
      sourceId: "source-supplementary-combining",
      documentId: "document-supplementary-combining",
      versionId: "version-supplementary-combining",
      contentHash: "3".repeat(64),
      text,
      ranges: [{ charStart: 0, charEnd: text.length }],
      label: "Supplementary combining",
      publicProvenance: {
        documentTitle: "Supplementary combining",
        citationUrl: "https://example.test/supplementary-combining",
      },
      renderedTokenCount: 0,
    };

    expect(searchWithinCandidate(candidate, "😀")).toEqual([{ charStart: 0, charEnd: 2 }]);
    expect(searchWithinCandidate(candidate, "\u0301")).toEqual([{ charStart: 2, charEnd: 3 }]);
    expect(searchWithinCandidate(candidate, "😀\u0301")).toEqual([{ charStart: 0, charEnd: 3 }]);
  });

  it("maps length-changing full folds, including an expanded prefix, without shifting later spans", () => {
    const text = "pre Straße and ẞ and ﬃ before \u0130 alpha";
    const candidate: AnswerCandidate = {
      id: "document:fold-expansions",
      kind: "document",
      rank: 0,
      purpose: "test full fold expansions",
      sourceId: "source-fold-expansions",
      documentId: "document-fold-expansions",
      versionId: "version-fold-expansions",
      contentHash: "e".repeat(64),
      text,
      ranges: [{ charStart: 0, charEnd: text.length }],
      label: "Fold expansions",
      publicProvenance: {
        documentTitle: "Fold expansions",
        citationUrl: "https://example.test/fold-expansions",
      },
      renderedTokenCount: 0,
    };

    expect(searchWithinCandidate(candidate, "strasse")).toEqual([{ charStart: 4, charEnd: 10 }]);
    expect(searchWithinCandidate(candidate, "ss")).toEqual([
      { charStart: 8, charEnd: 9 },
      { charStart: 15, charEnd: 16 },
    ]);
    expect(searchWithinCandidate(candidate, "ffi")).toEqual([{ charStart: 21, charEnd: 22 }]);
    expect(searchWithinCandidate(candidate, "i\u0307")).toEqual([{ charStart: 30, charEnd: 31 }]);
    expect(searchWithinCandidate(candidate, "alpha")).toEqual([{ charStart: 32, charEnd: 37 }]);
  });

  it("keeps default case-folded Greek combining sequences in canonical search order", () => {
    const text = "ΐ ΐ";
    const candidate: AnswerCandidate = {
      id: "document:greek-case-fold",
      kind: "document",
      rank: 0,
      purpose: "test default Unicode case folding",
      sourceId: "source-greek-case-fold",
      documentId: "document-greek-case-fold",
      versionId: "version-greek-case-fold",
      contentHash: "f".repeat(64),
      text,
      ranges: [{ charStart: 0, charEnd: text.length }],
      label: "Greek case fold",
      publicProvenance: {
        documentTitle: "Greek case fold",
        citationUrl: "https://example.test/greek-case-fold",
      },
      renderedTokenCount: 0,
    };

    expect(searchWithinCandidate(candidate, "ΐ")).toEqual([
      { charStart: 0, charEnd: 1 },
      { charStart: 2, charEnd: 5 },
    ]);
  });

  it("matches Hangul syllables through decomposed Jamo with exact UTF-16 spans", () => {
    const text = "가 가";
    const candidate: AnswerCandidate = {
      id: "document:hangul-normalization",
      kind: "document",
      rank: 0,
      purpose: "test Hangul normalization spans",
      sourceId: "source-hangul-normalization",
      documentId: "document-hangul-normalization",
      versionId: "version-hangul-normalization",
      contentHash: "0".repeat(64),
      text,
      ranges: [{ charStart: 0, charEnd: text.length }],
      label: "Hangul normalization",
      publicProvenance: {
        documentTitle: "Hangul normalization",
        citationUrl: "https://example.test/hangul-normalization",
      },
      renderedTokenCount: 0,
    };

    const expected = [
      { charStart: 0, charEnd: 1 },
      { charStart: 2, charEnd: 4 },
    ];
    expect(searchWithinCandidate(candidate, "가")).toEqual(expected);
    expect(searchWithinCandidate(candidate, "가")).toEqual(expected);
  });

  it("fails closed across a blocked Hangul trailing-jamo boundary", () => {
    const text = "가\u0327\u11a8";
    const candidate: AnswerCandidate = {
      id: "document:blocked-hangul-boundary",
      kind: "document",
      rank: 0,
      purpose: "test blocked Hangul composition",
      sourceId: "source-blocked-hangul-boundary",
      documentId: "document-blocked-hangul-boundary",
      versionId: "version-blocked-hangul-boundary",
      contentHash: "h".repeat(64),
      text,
      ranges: [{ charStart: 0, charEnd: text.length }],
      label: "Blocked Hangul boundary",
      publicProvenance: {
        documentTitle: "Blocked Hangul boundary",
        citationUrl: "https://example.test/blocked-hangul-boundary",
      },
      renderedTokenCount: 0,
    };

    expect(searchWithinCandidate(candidate, "각")).toEqual([]);
    expect(searchWithinCandidate(candidate, "가")).toEqual([{ charStart: 0, charEnd: 1 }]);
  });

  it("does not compose a match across an intervening combining mark", () => {
    const text = "a\u0323\u0301";
    const candidate: AnswerCandidate = {
      id: "document:combining-boundary",
      kind: "document",
      rank: 0,
      purpose: "test combining boundary",
      sourceId: "source-combining-boundary",
      documentId: "document-combining-boundary",
      versionId: "version-combining-boundary",
      contentHash: "i".repeat(64),
      text,
      ranges: [{ charStart: 0, charEnd: text.length }],
      label: "Combining boundary",
      publicProvenance: {
        documentTitle: "Combining boundary",
        citationUrl: "https://example.test/combining-boundary",
      },
      renderedTokenCount: 0,
    };

    expect(searchWithinCandidate(candidate, "á")).toEqual([]);
    expect(searchWithinCandidate(candidate, "ạ")).toEqual([{ charStart: 0, charEnd: 2 }]);
  });

  it("surfaces structurally distinct verbatim match previews with exact document ranges", () => {
    const text =
      "Region 1 signed row 1: curtailment baseline. " +
      "Region 1 signed row 2: curtailment baseline. " +
      "Region 1 binding conclusion: curtailment reduced by 12 percent.";
    const candidate: AnswerCandidate = {
      id: "document:preview",
      kind: "document",
      rank: 0,
      purpose: "test previews",
      sourceId: "source-preview",
      documentId: "document-preview",
      versionId: "version-preview",
      contentHash: "b".repeat(64),
      text,
      ranges: [{ charStart: 0, charEnd: text.length }],
      label: "Preview",
      publicProvenance: {
        documentTitle: "Preview",
        citationUrl: "https://example.test/preview",
      },
      renderedTokenCount: 0,
    };

    const result = searchWithinCandidateWindow(candidate, "curtailment", 0, 50);
    expect(result.matchPreviews).toHaveLength(2);
    expect(result.matchPreviews[1]?.text).toBe(
      "Region 1 binding conclusion: curtailment reduced by 12 percent.",
    );
    for (const preview of result.matchPreviews) {
      expect(text.slice(preview.range.charStart, preview.range.charEnd)).toBe(preview.text);
    }
  });

  it("reports a truthful cursor and searched scope when literal matches hit the hard page bound", () => {
    const text = Array.from({ length: 52 }, () => "alpha").join(" ");
    const candidate: AnswerCandidate = {
      id: "chat_message:many-matches",
      kind: "chat_message",
      rank: 0,
      purpose: "test pagination",
      messageId: "many-matches",
      text,
      label: null,
      renderedTokenCount: 0,
    };

    const first = searchWithinCandidateWindow(candidate, "alpha");
    expect(first).toMatchObject({
      complete: false,
      truncated: true,
      cursor: 50,
      scope: {
        kind: "complete_candidate",
        matchOffset: 0,
        maximumMatches: 50,
      },
    });
    expect(first.matches).toHaveLength(50);
    expect(searchWithinCandidateWindow(candidate, "alpha", first.cursor ?? 0)).toMatchObject({
      complete: true,
      truncated: false,
      cursor: null,
      matches: [
        { charStart: text.lastIndexOf("alpha", text.lastIndexOf("alpha") - 1) },
        { charStart: text.lastIndexOf("alpha") },
      ],
    });
  });

  it("paginates normalized matches by ordinal without skipping folded expansions", () => {
    const text = Array.from({ length: 5 }, () => "ß").join(" ");
    const candidate: AnswerCandidate = {
      id: "chat_message:folded-pages",
      kind: "chat_message",
      rank: 0,
      purpose: "test normalized pagination",
      messageId: "folded-pages",
      text,
      label: null,
      renderedTokenCount: 0,
    };

    const first = searchWithinCandidateWindow(candidate, "SS", 0, 2);
    expect(first).toMatchObject({
      complete: false,
      truncated: true,
      cursor: 2,
      matches: [
        { charStart: 0, charEnd: 1 },
        { charStart: 2, charEnd: 3 },
      ],
    });
    expect(searchWithinCandidateWindow(candidate, "SS", first.cursor ?? 0, 3)).toMatchObject({
      complete: true,
      truncated: false,
      cursor: null,
      matches: [
        { charStart: 4, charEnd: 5 },
        { charStart: 6, charEnd: 7 },
        { charStart: 8, charEnd: 9 },
      ],
    });
  });
});

describe("internal retrieval search protocol", () => {
  const documentQuery = {
    target: "documents" as const,
    terms: "solar",
    purpose: "answer the question",
  };
  const chatQuery = {
    target: "chat_messages" as const,
    terms: "solar",
    purpose: "answer the question",
  };

  it("rejects non-sparse lexical terms before consuming a search turn", () => {
    expect(internalSearchQueryIssue("curtailment storage dispatch")).toBeUndefined();
    expect(internalSearchQueryIssue("(storage OR stockage) dispatch")).toBeUndefined();
    expect(internalSearchQueryIssue("audit rule curtailment storage dispatch regional trial")).toBe(
      "internal search terms must contain at most three required terms",
    );
    expect(internalSearchQueryIssue('"storage dispatch"')).toBe(
      "internal search terms must not contain quoted phrases",
    );
    expect(internalSearchQueryIssue("storage-dispatch")).toBe(
      "internal search terms must separate words joined by hyphens",
    );
  });

  it("does not allow an empty manifest until a rejected query is corrected", () => {
    const protocol = new InternalRetrievalSearchProtocol();

    protocol.recordRejectedQuery();
    expect(() => protocol.assertEmptyManifestAllowed()).toThrow(
      "internal manifest cannot be empty until a rejected query is corrected",
    );

    protocol.beforeSearch(documentQuery, undefined, 0);
    protocol.afterSearch(documentQuery, true, 0, null, 0);
    protocol.recordCompletedSearch();
    expect(() => protocol.assertEmptyManifestAllowed()).not.toThrow();
  });

  it("allows one empty-result refinement and rejects a third ordinary search turn", () => {
    const protocol = new InternalRetrievalSearchProtocol();

    protocol.beforeSearch(documentQuery, undefined, 0);
    protocol.afterSearch(documentQuery, true, 0, null, 0);
    protocol.beforeSearch(documentQuery, undefined, 1);
    protocol.afterSearch(documentQuery, true, 0, null, 1);

    expect(() => protocol.beforeSearch(documentQuery, undefined, 2)).toThrow(
      "internal search/refinement turn limit exceeded",
    );
  });

  it("allows only one search call in a provider turn", () => {
    const protocol = new InternalRetrievalSearchProtocol();

    protocol.beforeSearch(documentQuery, undefined, 0);
    protocol.afterSearch(documentQuery, true, 1, null, 0);
    expect(() => protocol.beforeSearch(chatQuery, undefined, 0)).toThrow(
      "internal search permits at most one call per provider turn",
    );
  });

  it("allows a distinct subject search after a non-empty result", () => {
    const protocol = new InternalRetrievalSearchProtocol();

    protocol.beforeSearch(documentQuery, undefined, 0);
    protocol.afterSearch(documentQuery, true, 1, null, 0);
    protocol.beforeSearch(chatQuery, undefined, 1);
    protocol.afterSearch(chatQuery, true, 1, null, 1);
    expect(protocol.ordinarySearchTurnsExhausted()).toBe(true);
    expect(() => protocol.beforeSearch(documentQuery, undefined, 2)).toThrow(
      "internal search cannot repeat a completed query without its returned cursor",
    );
  });

  it("rejects distinct same-target searches in one provider turn", () => {
    const protocol = new InternalRetrievalSearchProtocol();
    const refinedDocumentQuery = { ...documentQuery, terms: "storage" };

    protocol.beforeSearch(documentQuery, undefined, 0);
    protocol.afterSearch(documentQuery, true, 1, null, 0);
    expect(() => protocol.beforeSearch(refinedDocumentQuery, undefined, 0)).toThrow(
      "internal search permits at most one call per provider turn",
    );
  });

  it("requires a cursor continuation to be the only search in its turn", () => {
    const protocol = new InternalRetrievalSearchProtocol();

    protocol.beforeSearch(documentQuery, undefined, 0);
    protocol.afterSearch(documentQuery, false, 1, 7, 0);
    expect(() => protocol.beforeSearch(chatQuery, undefined, 1)).toThrow(
      "internal search has an unresolved cursor continuation",
    );
    protocol.beforeSearch(documentQuery, 7, 1);
    expect(() => protocol.beforeSearch(documentQuery, 7, 1)).toThrow(
      "internal search permits at most one call per provider turn",
    );
  });

  it("requires cursor continuation and rejects repeating a completed query", () => {
    const protocol = new InternalRetrievalSearchProtocol();

    protocol.beforeSearch(documentQuery, undefined, 0);
    protocol.afterSearch(documentQuery, false, 1, 7, 0);
    expect(() => protocol.beforeSearch(chatQuery, undefined, 1)).toThrow(
      "internal search has an unresolved cursor continuation",
    );
    expect(() => protocol.beforeSearch(documentQuery, 6, 1)).toThrow(
      "internal search continuation did not use the exact returned cursor",
    );
    protocol.beforeSearch(documentQuery, 7, 1);
    protocol.afterSearch(documentQuery, true, 1, null, 1);
    expect(() => protocol.beforeSearch(chatQuery, undefined, 1)).toThrow(
      "internal search cursor continuation must be followed by termination",
    );

    expect(() => protocol.beforeSearch(documentQuery, undefined, 2)).toThrow(
      "internal search cannot repeat a completed query without its returned cursor",
    );
    protocol.beforeSearch(chatQuery, undefined, 2);
  });
});

const config = (mainInputTokens: number): CanonicalAiConfig => ({
  aiMainModel: "glm-5-turbo" as const,
  aiFastModel: "glm-5-turbo" as const,
  aiMainInputMaxTokens: mainInputTokens,
  aiMainOutputMaxTokens: 4096,
  aiFastInputMaxTokens: 100_000,
  aiFastOutputMaxTokens: 4096,
  aiConversationRecentTurns: 12,
  aiFanoutMaxTopics: 3,
  aiRetrievalMaxTurns: 4,
  aiInternalMaxSearches: 4,
  aiInternalMaxInspections: 4,
  aiWebMaxSearches: 2,
  aiWebMaxFetches: 2,
  aiWebMaxDomainFilters: 8,
  aiContextReductionMaxIterations: 2,
  aiMemoryToolResultMaxItems: 20,
  webResearchProvider: "" as const,
});

const citationNamespace = "cn_AAAAAAAAAAAAAAAAAAAAAA";

const load = (_historyText: string): LoadedTurn => {
  const aiRunId = crypto.randomUUID();
  const chatId = crypto.randomUUID();
  return {
    aiRunId,
    chatId,
    initiatingUserId: "fanout-allocation-user",
    userMessageId: crypto.randomUUID(),
    userMessage: "Compare both topics.",
    locale: "en-US",
    market: "US",
    currentDate: "2026-07-10",
    citationNamespace,
    memoryMode: "disabled",
    webRequested: false,
    acceptanceScope: {
      userId: "fanout-allocation-user",
      chatId,
      companyId: "00000000-0000-4000-8000-000000000002",
      subscriptionIds: [],
      accessIds: [],
      publicSourceIds: [],
      memoryMode: "disabled",
      memoryRevisionIds: [],
      webRequested: false,
      webEnabled: false,
      provider: "zai_coding_plan_official",
      fastModelId: "glm-5-turbo",
      mainModelId: "glm-5-turbo",
      webTransportProvider: null,
      allowedDomains: null,
    },
  };
};

const plan = (
  relevantTurnIds: readonly string[],
): Extract<PlanTurnResult, { readonly mode: "fanout" }> => ({
  mode: "fanout",
  question: "Compare both topics.",
  topics: [
    { topicId: "t1", question: "Topic one", relevantTurnIds },
    { topicId: "t2", question: "Topic two", relevantTurnIds },
  ],
});

const stubPriorTurns = (operations: CanonicalWorkflowOperations, historyText = ""): void => {
  (operations as any).currentPriorTurns = async () =>
    historyText === ""
      ? []
      : [
          {
            turnId: "turn-1",
            userMessageId: "message-user-1",
            userContent: historyText,
            assistantMessageId: "message-assistant-1",
            assistantContent: historyText,
          },
        ];
};

describe("fanout source-key merge", () => {
  it("does only stable cross-topic identity deduplication and namespace-key assignment", async () => {
    const operations = new CanonicalWorkflowOperations(
      "postgres://unused",
      config(100_000),
      {} as CanonicalAgentClient,
    );
    stubPriorTurns(operations);
    const turn = load("");
    const topics = plan([]).topics;
    const sharedDocument = {
      kind: "document" as const,
      documentId: "shared-document",
      versionId: "shared-version",
      source: { kind: "public" as const, sourceId: "public:shared-source" },
      ranges: [{ charStart: 0, charEnd: 10 }],
      purpose: "shared evidence",
    };
    const selectors = {
      t1: {
        internal: [sharedDocument],
        memories: [],
        memorySelection: "enabled" as const,
        web: [],
        webSelection: "enabled" as const,
      },
      t2: {
        internal: [
          sharedDocument,
          { kind: "chat_message" as const, messageId: "older-message", purpose: "older evidence" },
        ],
        memories: [],
        memorySelection: "enabled" as const,
        web: [],
        webSelection: "enabled" as const,
      },
      t3: {
        internal: [],
        memories: [],
        memorySelection: "enabled" as const,
        web: [],
        webSelection: "enabled" as const,
      },
    };

    const first = await operations.mergeFanoutSources(turn, topics, selectors);
    const reversed = await operations.mergeFanoutSources(turn, [...topics].reverse(), selectors);

    expect(first).toEqual(reversed);
    expect(first.sources.map(({ candidateId }) => candidateId)).toEqual([
      documentReferenceIdentity(sharedDocument),
      "chat_message:older-message",
    ]);
    expect(new Set(first.sources.map(({ sourceKey }) => sourceKey)).size).toBe(
      first.sources.length,
    );
  });

  it("keeps identical raw IDs distinct across public and publisher namespaces in both orders", async () => {
    const operations = new CanonicalWorkflowOperations(
      "postgres://unused",
      config(100_000),
      {} as CanonicalAgentClient,
    );
    stubPriorTurns(operations);
    const publicReference = {
      kind: "document" as const,
      documentId: "same-document",
      versionId: "same-version",
      source: { kind: "public" as const, sourceId: "public:same-source" },
      purpose: "public",
    };
    const publisherReference = {
      kind: "document" as const,
      documentId: "same-document",
      versionId: "same-version",
      source: {
        kind: "publisher" as const,
        sourceId: "publisher:same-source",
        issueId: "same-issue",
        documentId: "same-document",
      },
      purpose: "publisher",
    };
    const topics = plan([]).topics;
    const first = await operations.mergeFanoutSources(load(""), topics, {
      t1: {
        internal: [publicReference, publisherReference],
        memories: [],
        memorySelection: "enabled" as const,
        web: [],
        webSelection: "enabled" as const,
      },
      t2: {
        internal: [],
        memories: [],
        memorySelection: "enabled" as const,
        web: [],
        webSelection: "enabled" as const,
      },
      t3: {
        internal: [],
        memories: [],
        memorySelection: "enabled" as const,
        web: [],
        webSelection: "enabled" as const,
      },
    });
    const second = await operations.mergeFanoutSources(load(""), topics, {
      t1: {
        internal: [publisherReference, publicReference],
        memories: [],
        memorySelection: "enabled" as const,
        web: [],
        webSelection: "enabled" as const,
      },
      t2: {
        internal: [],
        memories: [],
        memorySelection: "enabled" as const,
        web: [],
        webSelection: "enabled" as const,
      },
      t3: {
        internal: [],
        memories: [],
        memorySelection: "enabled" as const,
        web: [],
        webSelection: "enabled" as const,
      },
    });
    expect(first.sources).toHaveLength(2);
    expect(second.sources).toHaveLength(2);
    expect(new Set(first.sources.map(({ candidateId }) => candidateId)).size).toBe(2);
    expect(new Set(second.sources.map(({ candidateId }) => candidateId)).size).toBe(2);
    expect(first.sources.map(({ candidateId }) => candidateId).sort()).toEqual(
      second.sources.map(({ candidateId }) => candidateId).sort(),
    );
  });
});

describe("fanout synthesis allocation", () => {
  const topicContext = (topicId: "t1" | "t2", packetOutputTokens: number): ContextState => ({
    status: "ready",
    question: `Question ${topicId}`,
    topicId,
    candidates: [],
    sourceMap: [],
    ledgerCandidates: [],
    ledgerSourceMap: [],
    selectedConversation: [],
    consumers: [],
    gaps: [],
    reductionFeedback: [],
    request: {
      requestClass: "main",
      model: "glm-5-turbo",
      messages: [{ role: "user", content: `Question ${topicId}` }],
      requestedOutputTokens: packetOutputTokens,
      reasoning: "medium",
    },
    inputTokens: 10,
    usableInputTokens: 100_000,
    reductionRan: false,
  });

  it("reserves the exact selected conversation and packet framing before topic calls", async () => {
    const operations = new CanonicalWorkflowOperations(
      "postgres://unused",
      config(100_000),
      {} as CanonicalAgentClient,
    );
    stubPriorTurns(operations, "Relevant historical context. ".repeat(500));
    const turn = load("Relevant historical context. ".repeat(500));
    const withoutHistory = await operations.allocateFanout(turn, plan([]));
    const withHistory = await operations.allocateFanout(turn, plan(["turn-1"]));
    expect(withHistory.fixedSynthesisInput).toBeGreaterThan(withoutHistory.fixedSynthesisInput);
    expect(withHistory.packetOutputTokens).toBeLessThanOrEqual(withoutHistory.packetOutputTokens);
    expect(withHistory.packetOutputTokens).toBeGreaterThan(0);
  });

  it("uses the exact minimum valid topic-packet serialization instead of an arbitrary threshold", async () => {
    const turn = load("");
    const roomyOperations = new CanonicalWorkflowOperations(
      "postgres://unused",
      config(100_000),
      {} as CanonicalAgentClient,
    );
    stubPriorTurns(roomyOperations);
    const roomy = await roomyOperations.allocateFanout(turn, plan([]));
    const minimum = resolveRegisteredModel("glm-5-turbo").countTextTokens(
      JSON.stringify({ topicId: "t1", status: "partial", claims: [], gaps: ["gap"] }),
    );
    const exact = new CanonicalWorkflowOperations(
      "postgres://unused",
      config(roomy.fixedSynthesisInput + minimum * 2),
      {} as CanonicalAgentClient,
    );
    stubPriorTurns(exact);
    expect((await exact.allocateFanout(turn, plan([]))).packetOutputTokens).toBe(minimum);

    const oneTokenShort = new CanonicalWorkflowOperations(
      "postgres://unused",
      config(roomy.fixedSynthesisInput + minimum * 2 - 1),
      {} as CanonicalAgentClient,
    );
    stubPriorTurns(oneTokenShort);
    await expect(oneTokenShort.allocateFanout(turn, plan([]))).rejects.toThrow(
      "synthesis_budget_mismatch",
    );
  });

  it("fails before fanout when mandatory selected history leaves no packet allowance", async () => {
    const operations = new CanonicalWorkflowOperations(
      "postgres://unused",
      config(2_000),
      {} as CanonicalAgentClient,
    );
    stubPriorTurns(operations, "mandatory history ".repeat(20_000));
    try {
      await operations.allocateFanout(load("mandatory history ".repeat(20_000)), plan(["turn-1"]));
      throw new Error("expected synthesis allocation to fail");
    } catch (error) {
      expect(error).toMatchObject({ code: "synthesis_budget_mismatch", retryable: false });
    }
  });

  it("reasserts the exact preallocation against the real synthesis request", async () => {
    const operations = new CanonicalWorkflowOperations(
      "postgres://unused",
      config(100_000),
      {} as CanonicalAgentClient,
    );
    stubPriorTurns(operations);
    const turn = load("");
    const allocation = await operations.allocateFanout(turn, plan([]));
    const contexts = [
      topicContext("t1", allocation.packetOutputTokens),
      topicContext("t2", allocation.packetOutputTokens),
    ];
    const packets = [
      { topicId: "t1" as const, status: "partial" as const, claims: [], gaps: ["none"] },
      { topicId: "t2" as const, status: "partial" as const, claims: [], gaps: ["none"] },
    ];

    await expect(
      operations.synthesisContext(turn, packets, [], contexts, allocation),
    ).resolves.toMatchObject({
      status: "ready",
    });
    await expect(
      operations.synthesisContext(turn, packets, [], contexts, {
        ...allocation,
        fixedSynthesisInput: allocation.fixedSynthesisInput + 1,
      }),
    ).resolves.toMatchObject({ status: "failed", failureCode: "synthesis_budget_mismatch" });
    await expect(
      operations.synthesisContext(
        turn,
        packets,
        [],
        [
          topicContext("t1", allocation.packetOutputTokens - 1),
          topicContext("t2", allocation.packetOutputTokens),
        ],
        allocation,
      ),
    ).resolves.toMatchObject({ status: "failed", failureCode: "synthesis_budget_mismatch" });
  });

  it("rejects packets whose real serialization exceeds their combined output allowance", async () => {
    const operations = new CanonicalWorkflowOperations(
      "postgres://unused",
      config(100_000),
      {} as CanonicalAgentClient,
    );
    stubPriorTurns(operations);
    const turn = load("");
    const allocation = await operations.allocateFanout(turn, plan([]));
    const contexts = [
      topicContext("t1", allocation.packetOutputTokens),
      topicContext("t2", allocation.packetOutputTokens),
    ];
    const oversized = "grounded claim ".repeat(allocation.packetOutputTokens * 2);
    const packets = [
      {
        topicId: "t1" as const,
        status: "answered" as const,
        claims: [{ text: oversized, sourceKeys: ["k_cn_AAAAAAAAAAAAAAAAAAAAAA_1"] }],
        gaps: [],
      },
      { topicId: "t2" as const, status: "partial" as const, claims: [], gaps: ["none"] },
    ];

    await expect(
      operations.synthesisContext(turn, packets, [], contexts, allocation),
    ).resolves.toMatchObject({
      status: "failed",
      failureCode: "synthesis_budget_mismatch",
    });
  });
});

describe("typed controlled operation failures", () => {
  it("does not add an empty-web gap when web was not requested", async () => {
    const operations = new CanonicalWorkflowOperations(
      "postgres://unused",
      config(100_000),
      {} as CanonicalAgentClient,
    );
    stubPriorTurns(operations);
    const assembly = await operations.assembleContext(
      {
        ...load(""),
        webRequested: false,
      },
      "question",
      {
        internal: [],
        memories: [],
        memorySelection: "enabled",
        web: [],
        webSelection: "disabled",
      },
      "single-assemble",
      "single-answer",
    );
    expect(assembly.gaps).toEqual([]);
  });

  it("preserves a context failure as the exact nonretryable topic error", async () => {
    const operations = new CanonicalWorkflowOperations(
      "postgres://unused",
      config(100_000),
      {} as CanonicalAgentClient,
    );
    const failed: ContextState = {
      status: "failed",
      failureCode: "context_plan_unfit",
      question: "question",
      topicId: "t1",
      candidates: [],
      sourceMap: [],
      ledgerCandidates: [],
      ledgerSourceMap: [],
      selectedConversation: [],
      consumers: [],
      gaps: [],
      reductionFeedback: [],
      request: {
        requestClass: "main",
        model: "glm-5-turbo",
        messages: [{ role: "user", content: "question" }],
        requestedOutputTokens: 100,
        reasoning: "medium",
      },
      inputTokens: 1,
      usableInputTokens: 1,
      reductionRan: false,
    };
    await expect(
      operations.answerTopic(load(""), failed, "topic-t1-answer", 100),
    ).rejects.toMatchObject({ code: "context_plan_unfit", retryable: false });
  });
});

describe("fanout immutable source-map merge", () => {
  const source = (
    topicId: "t1" | "t2",
    range: { readonly charStart: number; readonly charEnd: number },
    versionId = "version-1",
    sourceKey = "k_cn_AAAAAAAAAAAAAAAAAAAAAA_1",
  ): FinalSourceRecord => ({
    sourceKey,
    locator: {
      kind: "document",
      sourceId: "public:source-1",
      documentId: "document-1",
      versionId,
      contentHash: "a".repeat(64),
      ranges: [range],
    },
    label: "Official report",
    publicProvenance: {
      documentTitle: "Official report",
      citationUrl: "https://example.test/report",
    },
    uses: [
      {
        consumerTaskId: `topic-${topicId}-answer`,
        topicId,
        contextOrder: 0,
        renderedTokenCount: 10,
        ranges: [range],
      },
    ],
  });
  const context = (topicId: "t1" | "t2", record: FinalSourceRecord): ContextState => ({
    status: "ready",
    question: topicId,
    topicId,
    candidates: [],
    sourceMap: [record],
    ledgerCandidates: [],
    ledgerSourceMap: [record],
    selectedConversation: [],
    consumers: [],
    gaps: [],
    reductionFeedback: [],
    request: {
      requestClass: "main",
      model: "glm-5-turbo",
      messages: [{ role: "user", content: "answer" }],
      requestedOutputTokens: 512,
      reasoning: "medium",
    },
    inputTokens: 10,
    usableInputTokens: 100,
    reductionRan: false,
  });

  it("unions locator ranges while retaining exact per-topic consumer subsets", () => {
    const operations = new CanonicalWorkflowOperations(
      "postgres://unused",
      config(100_000),
      {} as CanonicalAgentClient,
    );
    expect(
      operations.mergeFanoutSourceMaps([
        context("t1", source("t1", { charStart: 0, charEnd: 10 })),
        context("t2", source("t2", { charStart: 20, charEnd: 30 })),
      ]),
    ).toEqual([
      {
        ...source("t1", { charStart: 0, charEnd: 10 }),
        locator: {
          kind: "document",
          sourceId: "public:source-1",
          documentId: "document-1",
          versionId: "version-1",
          contentHash: "a".repeat(64),
          ranges: [
            { charStart: 0, charEnd: 10 },
            { charStart: 20, charEnd: 30 },
          ],
        },
        uses: [
          source("t1", { charStart: 0, charEnd: 10 }).uses[0],
          source("t2", { charStart: 20, charEnd: 30 }).uses[0],
        ],
      },
    ]);
  });

  it("rejects one source key reused for a different immutable version", () => {
    const operations = new CanonicalWorkflowOperations(
      "postgres://unused",
      config(100_000),
      {} as CanonicalAgentClient,
    );
    expect(() =>
      operations.mergeFanoutSourceMaps([
        context("t1", source("t1", { charStart: 0, charEnd: 10 })),
        context("t2", source("t2", { charStart: 20, charEnd: 30 }, "version-2")),
      ]),
    ).toThrow("different immutable provenance");
  });

  it("reuses the first canonical fanout locator for the same normalized web quotation", () => {
    const webSource = (topicId: "t1" | "t2", capturedAt: string): FinalSourceRecord => ({
      sourceKey: "k_cn_AAAAAAAAAAAAAAAAAAAAAA_1",
      locator: {
        kind: "web",
        url: "https://example.test/report",
        title: `Capture ${topicId}`,
        domain: "example.test",
        quote: "The same immutable quotation.",
        quoteHash: "quote-hash",
        capturedAt,
      },
      label: `Capture ${topicId}`,
      publicProvenance: {
        documentTitle: `Capture ${topicId}`,
        citationUrl: "https://example.test/report",
      },
      uses: [
        {
          consumerTaskId: `topic-${topicId}-answer`,
          topicId,
          contextOrder: 0,
          renderedTokenCount: 12,
          ranges: [],
        },
      ],
    });
    const first = webSource("t1", "2026-07-10T12:00:00.000Z");

    expect(
      new CanonicalWorkflowOperations(
        "postgres://unused",
        config(100_000),
        {} as CanonicalAgentClient,
      ).mergeFanoutSourceMaps([
        context("t1", first),
        context("t2", webSource("t2", "2026-07-10T12:00:01.000Z")),
      ]),
    ).toEqual([
      {
        ...first,
        uses: [first.uses[0], webSource("t2", "2026-07-10T12:00:01.000Z").uses[0]],
      },
    ]);
  });

  it("orders merged source keys by numeric ordinal and rejects malformed keys", () => {
    const operations = new CanonicalWorkflowOperations(
      "postgres://unused",
      config(100_000),
      {} as CanonicalAgentClient,
    );
    const keys = [9, 10, 11].map((ordinal) => `k_cn_AAAAAAAAAAAAAAAAAAAAAA_${ordinal}`);
    const contexts = keys.map((key, index) =>
      context("t1", source("t1", { charStart: index, charEnd: index + 1 }, "version-1", key)),
    );
    expect(operations.mergeFanoutSourceMaps(contexts).map((item) => item.sourceKey)).toEqual(keys);
    expect(() =>
      operations.mergeFanoutSourceMaps([
        context("t1", source("t1", { charStart: 0, charEnd: 1 }, "version-1", "not-a-key")),
        context("t2", source("t2", { charStart: 1, charEnd: 2 }, "version-1", "also-not-a-key")),
      ]),
    ).toThrow();
  });
});

describe("provider-authored canonical schemas", () => {
  it("keeps provider JSON schemas compatible with Z.AI while retaining exact namespace rejection", () => {
    for (const schema of Object.values(canonicalProviderValueSchemas)) {
      const providerJson = JSON.stringify(z.toJSONSchema(schema));
      expect(providerJson).not.toMatch(/\\p\{/u);
    }

    const publicReference = {
      kind: "document" as const,
      documentId: "document",
      versionId: "version",
      source: { kind: "public" as const, sourceId: "public:source" },
      purpose: "ground answer",
    };
    for (const whitespace of ["\u00a0", "\u2028", "\ufeff"]) {
      expect(() =>
        canonicalProviderValueSchemas.internalReference.parse({
          ...publicReference,
          source: { kind: "public", sourceId: `public:source${whitespace}tail` },
        }),
      ).toThrow();
    }
  });

  it("accepts only the model-visible document identity", () => {
    const publicReference = {
      kind: "document" as const,
      documentId: "document",
      purpose: "ground answer",
    };
    expect(canonicalProviderValueSchemas.internalReference.parse(publicReference)).toEqual(
      publicReference,
    );
    expect(() =>
      canonicalProviderValueSchemas.internalReference.parse({
        ...publicReference,
        versionId: "version",
        source: { kind: "public", sourceId: "public:source" },
      }),
    ).toThrow();
  });

  it("rejects unknown fields at every model-output root and nested object boundary", () => {
    expect(() =>
      canonicalProviderValueSchemas.planTurn.parse({
        mode: "single",
        question: "question",
        relevantTurnIds: [],
        ignored: true,
      }),
    ).toThrow();
    expect(() =>
      canonicalProviderValueSchemas.planTurn.parse({
        mode: "fanout",
        reason: "independent topics",
        topics: [
          { question: "one", relevantTurnIds: [], ignored: true },
          { question: "two", relevantTurnIds: [] },
        ],
      }),
    ).toThrow();
    expect(() =>
      canonicalProviderValueSchemas.internalManifestOutput.parse({
        entries: [
          {
            kind: "document",
            documentId: "document",
            versionId: "version",
            ranges: [{ charStart: 0, charEnd: 1, ignored: true }],
            purpose: "ground answer",
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      canonicalProviderValueSchemas.internalQuery.parse({
        target: "chat_messages",
        terms: "term",
        purpose: "retrieve",
        ignored: true,
      }),
    ).toThrow();
    expect(() =>
      canonicalProviderValueSchemas.memoryManifestOutput.parse({
        entries: [{ memoryId: "memory", memoryRevisionId: "revision", ignored: true }],
      }),
    ).toThrow();
    expect(() =>
      canonicalProviderValueSchemas.webManifestOutput.parse({
        entries: [
          {
            url: "https://example.com/",
            title: "Title",
            domain: "example.com",
            quote: "quote",
            capturedAt: "2026-07-10T00:00:00.000Z",
            purpose: "ground answer",
            ignored: true,
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      canonicalProviderValueSchemas.memoryProposalOutput.parse({
        proposals: [{ kind: "preference", content: "value", ignored: true }],
      }),
    ).toThrow();
    expect(() =>
      canonicalProviderValueSchemas.contextPlanOutput.parse({
        decisions: [{ id: "candidate", action: "keep", reason: "relevant", ignored: true }],
      }),
    ).toThrow();
    expect(() =>
      canonicalProviderValueSchemas.topicPacket.parse({
        topicId: "t1",
        status: "answered",
        claims: [{ text: "claim", sourceKeys: ["key"], ignored: true }],
        gaps: [],
      }),
    ).toThrow();
  });
});
