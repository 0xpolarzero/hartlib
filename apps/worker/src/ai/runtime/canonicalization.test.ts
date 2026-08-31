import { describe, expect, it } from "vitest";

import {
  CanonicalizationError,
  canonicalizeWebUrl,
  documentEvidenceIdentity,
  namespacedDocumentEvidenceIdentity,
  encodeCitationNamespace,
  normalizeCharacterRanges,
  normalizeWebQuote,
  orderRankedCandidates,
  requiresExplicitInspectionRange,
  sourceKeyForOrdinal,
  sourceOrdinalFromKey,
  compareSourceKeys,
  memoryExtractionSha256Hex,
  stripHistoricalCitationTags,
  webEvidenceIdentity,
  webQuoteHash,
} from "./canonicalization";

describe("AI evidence canonicalization golden contract", () => {
  it("constructs nonce-prefixed citation keys from exactly 128 bits", () => {
    const nonce = Uint8Array.from([
      0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e,
      0x0f,
    ]);
    expect(encodeCitationNamespace(nonce)).toBe("cn_AAECAwQFBgcICQoLDA0ODw");
    expect(sourceKeyForOrdinal(nonce, 1)).toBe("k_cn_AAECAwQFBgcICQoLDA0ODw_1");
    expect(() => encodeCitationNamespace(new Uint8Array(15))).toThrow(CanonicalizationError);
    expect(() => sourceKeyForOrdinal(nonce, 0)).toThrow(CanonicalizationError);
  });

  it("orders source keys by numeric ordinal beyond one digit", () => {
    const nonce = new Uint8Array(16).fill(9);
    const keys = [11, 2, 10, 1].map((ordinal) => sourceKeyForOrdinal(nonce, ordinal));
    expect([...keys].sort(compareSourceKeys).map(sourceOrdinalFromKey)).toEqual([1, 2, 10, 11]);
    expect(() => sourceOrdinalFromKey("k_invalid_2")).toThrow(CanonicalizationError);
  });

  it("commits memory proposal order, targets, heads, and discarded count", () => {
    const first = {
      proposals: [
        { kind: "fact" as const, content: "  alpha  " },
        {
          kind: "preference" as const,
          content: "beta",
          targetMemoryId: "00000000-0000-4000-8000-000000000001",
          expectedHeadRevisionId: "00000000-0000-4000-8000-000000000002",
        },
      ],
      discardedCount: 1,
    };
    expect(memoryExtractionSha256Hex(first)).toMatch(/^[a-f0-9]{64}$/u);
    expect(memoryExtractionSha256Hex(first)).toBe(
      memoryExtractionSha256Hex({
        ...first,
        proposals: [{ ...first.proposals[0]!, content: "alpha" }, first.proposals[1]!],
      }),
    );
    expect(memoryExtractionSha256Hex(first)).not.toBe(
      memoryExtractionSha256Hex({ ...first, proposals: [...first.proposals].reverse() }),
    );
    expect(memoryExtractionSha256Hex(first)).not.toBe(
      memoryExtractionSha256Hex({ ...first, discardedCount: 2 }),
    );
  });

  it("normalizes only transport-level quote differences before hashing", () => {
    expect(normalizeWebQuote("  Cafe\u0301\r\n  keeps  spaces.  ")).toBe("Café\n  keeps  spaces.");
    expect(webQuoteHash("Cafe\u0301\r\nline")).toBe(webQuoteHash("Café\nline"));
    expect(webQuoteHash("a  b")).not.toBe(webQuoteHash("a b"));
  });

  it("strips complete and malformed historical citation spans without rewriting other wording", () => {
    expect(
      stripHistoricalCitationTags(
        "Avant [[cite:k_old_nonce_1]] milieu [[cite:k_old_2,k_old_3]] après.",
      ),
    ).toBe("Avant  milieu  après.");
    expect(stripHistoricalCitationTags("Conserver exactement. [[cite:k_old_1 trailing")).toBe(
      "Conserver exactement. ",
    );
    expect(stripHistoricalCitationTags("Aucun marqueur")).toBe("Aucun marqueur");
  });

  it("canonicalizes URL syntax without changing path or query evidence", () => {
    expect(canonicalizeWebUrl("HTTPS://Example.COM:443/a/../b?q=2&q=1#section")).toBe(
      "https://example.com/b?q=2&q=1",
    );
    expect(() => canonicalizeWebUrl("http://example.com/plaintext")).toThrow(
      expect.objectContaining({ code: "invalid_url" }),
    );
    expect(() => canonicalizeWebUrl("file:///etc/passwd")).toThrow(CanonicalizationError);
    expect(() => canonicalizeWebUrl("https://user:pass@example.com/")).toThrow(
      CanonicalizationError,
    );
  });

  it("uses URL plus normalized quote hash for web identity", () => {
    expect(webEvidenceIdentity("https://EXAMPLE.com:443/a#x", " quote\r\n")).toBe(
      webEvidenceIdentity("https://example.com/a", "quote\n"),
    );
    expect(documentEvidenceIdentity("doc-7")).toBe("document:doc-7");
  });

  it("includes the literal public namespace in document identity", () => {
    const publicIdentity = namespacedDocumentEvidenceIdentity(
      { kind: "public", sourceId: "public:source" },
      "same-document",
    );
    expect(publicIdentity).toContain(":public:");
    expect(
      namespacedDocumentEvidenceIdentity(
        { kind: "public", sourceId: "public:source" },
        "same-document",
      ),
    ).toBe(publicIdentity);
  });

  it("orders candidates independently of completion order", () => {
    const shuffled = [
      { topicId: "t2" as const, domain: "internal" as const, rank: 0, identity: "d" },
      { topicId: "t1" as const, domain: "web" as const, rank: 0, identity: "w" },
      { topicId: "t1" as const, domain: "internal" as const, rank: 1, identity: "b" },
      { topicId: "t1" as const, domain: "internal" as const, rank: 0, identity: "a" },
    ];
    expect(orderRankedCandidates(shuffled).map((candidate) => candidate.identity)).toEqual([
      "a",
      "b",
      "w",
      "d",
    ]);
  });

  it("unions overlaps and adjacency without bridging gaps", () => {
    expect(
      normalizeCharacterRanges(
        [
          { charStart: 20, charEnd: 30 },
          { charStart: 0, charEnd: 10 },
          { charStart: 8, charEnd: 15 },
          { charStart: 15, charEnd: 18 },
          { charStart: 20, charEnd: 30 },
        ],
        40,
      ),
    ).toEqual([
      { charStart: 0, charEnd: 18 },
      { charStart: 20, charEnd: 30 },
    ]);
    expect(() => normalizeCharacterRanges([{ charStart: 0, charEnd: 41 }], 40)).toThrow(
      CanonicalizationError,
    );
  });

  it("defines a large document through the exact complete-response gate", () => {
    expect(requiresExplicitInspectionRange(1_001, 1_000)).toBe(true);
    expect(requiresExplicitInspectionRange(1_000, 1_000)).toBe(false);
  });

  it("property: range normalization is permutation-invariant, idempotent, and coverage-preserving", () => {
    let state = 0x5eed_c0de;
    const next = (): number => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state;
    };

    for (let example = 0; example < 250; example += 1) {
      const textLength = 1 + (next() % 500);
      const ranges = Array.from({ length: 1 + (next() % 40) }, () => {
        const charStart = next() % textLength;
        const charEnd = charStart + 1 + (next() % (textLength - charStart));
        return { charStart, charEnd };
      });
      const normalized = normalizeCharacterRanges(ranges, textLength);

      expect(normalizeCharacterRanges(normalized, textLength)).toEqual(normalized);
      expect(normalizeCharacterRanges(ranges.toReversed(), textLength)).toEqual(normalized);
      for (let index = 0; index < normalized.length; index += 1) {
        const range = normalized[index]!;
        expect(range.charStart).toBeGreaterThanOrEqual(0);
        expect(range.charEnd).toBeLessThanOrEqual(textLength);
        if (index > 0) expect(range.charStart).toBeGreaterThan(normalized[index - 1]!.charEnd);
      }
      for (let position = 0; position < textLength; position += 1) {
        const coveredBefore = ranges.some(
          (range) => range.charStart <= position && position < range.charEnd,
        );
        const coveredAfter = normalized.some(
          (range) => range.charStart <= position && position < range.charEnd,
        );
        expect(coveredAfter).toBe(coveredBefore);
      }
    }
  });
});
