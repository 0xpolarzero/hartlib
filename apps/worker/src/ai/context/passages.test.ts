import { describe, expect, it } from "vitest";

import {
  PassageViewSchema,
  buildPassageIndex,
  mapPassageIdsToRanges,
  mergeAdjacentRanges,
  normalizePassageText,
  normalizeRange,
  sanitizePassageText,
  selectedTextFromRanges,
  splitRangeByUtf8Bytes,
  stripHistoricalCitationTags,
  toProviderPassageView,
} from "./passages";

const scalarTokens = (text: string): number => Array.from(text).length;
const options = {
  maxTokens: 6,
  maxUtf8Bytes: 64,
  countTokens: scalarTokens,
};

describe("deterministic passage and range helpers", () => {
  it("returns ordered non-overlapping bounded passages with exact reconstruction", () => {
    expect(buildPassageIndex("", options).passages).toEqual([]);
    const index = buildPassageIndex("One. Two!\n\nThree.", options);
    expect(index.passages.map((passage) => passage.text)).toEqual(["One.", "Two!", "Three."]);
    expect(index.passages.map((passage) => passage.passageId)).toEqual(["p1", "p2", "p3"]);
    for (const [position, passage] of index.passages.entries()) {
      expect(index.text.slice(passage.range.charStart, passage.range.charEnd)).toBe(passage.text);
      expect(passage.tokenCount).toBe(scalarTokens(passage.text));
      expect(passage.tokenCount).toBeLessThanOrEqual(options.maxTokens);
      expect(passage.utf8ByteCount).toBeLessThanOrEqual(options.maxUtf8Bytes);
      if (position > 0) {
        expect(passage.range.charStart).toBeGreaterThanOrEqual(
          index.passages[position - 1]!.range.charEnd,
        );
      }
    }
    expect(
      buildPassageIndex("One.\r\n\r\nTwo.", options).passages.map((passage) => passage.text),
    ).toEqual(["One.", "Two."]);
  });

  it("builds views only from authorized base ranges", () => {
    const text = "Allowed 😀. Secret.";
    const authorizedEnd = "Allowed 😀.".length;
    const index = buildPassageIndex(text, {
      ...options,
      maxTokens: 32,
      authorizedRanges: [{ charStart: 0, charEnd: authorizedEnd }],
    });
    expect(index.passages.map((passage) => passage.text)).toEqual(["Allowed 😀."]);
    expect(index.passages.every((passage) => passage.range.charEnd <= authorizedEnd)).toBe(true);
    expect(
      index.passages.map((passage) => text.slice(passage.range.charStart, passage.range.charEnd)),
    ).toEqual(["Allowed 😀."]);
  });

  it("treats an empty authorized range set as no exposed text", () => {
    expect(
      buildPassageIndex("Unauthorized text.", {
        ...options,
        authorizedRanges: [],
      }).passages,
    ).toEqual([]);
    expect(
      buildPassageIndex("", {
        ...options,
        authorizedRanges: [],
      }).passages,
    ).toEqual([]);
  });

  it("exposes only opaque passage IDs and exact text to providers", () => {
    const passage = buildPassageIndex("Exact text.", {
      ...options,
      maxTokens: 20,
    }).passages[0]!;
    const view = toProviderPassageView(passage);
    expect(view).toEqual({ passageId: "p1", text: "Exact text." });
    expect(PassageViewSchema.parse(view)).toEqual(view);
    expect("charStart" in view).toBe(false);
    expect("charEnd" in view).toBe(false);
    expect("range" in view).toBe(false);
  });

  it("enforces exact UTF-8 and token caps through Unicode-safe splitting", () => {
    const byteBound = buildPassageIndex("A😀B", {
      maxTokens: 10,
      maxUtf8Bytes: 5,
      countTokens: scalarTokens,
    });
    expect(byteBound.passages.map((passage) => passage.text)).toEqual(["A😀", "B"]);
    expect(byteBound.passages.map((passage) => passage.utf8ByteCount)).toEqual([5, 1]);

    const tokenBound = buildPassageIndex("abcd", {
      maxTokens: 2,
      maxUtf8Bytes: 100,
      countTokens: scalarTokens,
    });
    expect(tokenBound.passages.map((passage) => passage.text)).toEqual(["ab", "cd"]);
    expect(tokenBound.passages.map((passage) => passage.tokenCount)).toEqual([2, 2]);
  });

  it("bounds token-counter calls for a large Unicode sentence", () => {
    const text = "😀".repeat(1_048_576);
    let tokenCalls = 0;
    const index = buildPassageIndex(text, {
      maxTokens: 1_000_000,
      maxUtf8Bytes: 4_194_304,
      countTokens: (value) => {
        tokenCalls += 1;
        return value.length / 2;
      },
    });
    expect(tokenCalls).toBeLessThan(100);
    expect(index.passages.map((passage) => passage.tokenCount)).toEqual([1_000_000, 48_576]);
    expect(index.passages[0]!.range).toEqual({ charStart: 0, charEnd: 2_000_000 });
    expect(index.passages[1]!.range).toEqual({ charStart: 2_000_000, charEnd: text.length });
    expect(index.passages[0]!.range.charEnd).toBe(index.passages[1]!.range.charStart);
    expect(
      index.passages.every(
        (passage) => passage.text === text.slice(passage.range.charStart, passage.range.charEnd),
      ),
    ).toBe(true);
  });

  it("rejects malformed surrogate text and surrogate-splitting ranges", () => {
    const text = "A😀B";
    expect(normalizeRange(text, { charStart: 1, charEnd: 3 })).toEqual({
      charStart: 1,
      charEnd: 3,
    });
    expect(() => normalizeRange(text, { charStart: 2, charEnd: 3 })).toThrow();
    expect(() => normalizeRange("\ud800", { charStart: 0, charEnd: 1 })).toThrow();
    expect(() => sanitizePassageText("\ud800")).toThrow();
    expect(() => buildPassageIndex("\ud800", options)).toThrow();
    expect(splitRangeByUtf8Bytes("A😀B", { charStart: 0, charEnd: 4 }, 5)).toEqual([
      { charStart: 0, charEnd: 3 },
      { charStart: 3, charEnd: 4 },
    ]);
    expect(() => splitRangeByUtf8Bytes("😀", { charStart: 0, charEnd: 2 }, 3)).toThrow();
  });

  it("strips historical citations and maps exact passage text to normalized ranges", () => {
    expect(stripHistoricalCitationTags("A [[cite:old]] B [[cite:next]]")).toBe("A  B ");
    expect(stripHistoricalCitationTags("safe [[cite:unterminated")).toBe("safe ");
    expect(normalizePassageText("e\u0301")).toBe("é");
    const index = buildPassageIndex("Alpha. Beta.", {
      maxTokens: 6,
      maxUtf8Bytes: 64,
      countTokens: scalarTokens,
      stripCitations: true,
    });
    const ranges = mapPassageIdsToRanges(
      index,
      index.passages.map((passage) => passage.passageId),
    );
    expect(ranges).toEqual([
      { charStart: 0, charEnd: 6 },
      { charStart: 7, charEnd: 12 },
    ]);
    expect(selectedTextFromRanges(index.text, ranges)).toBe("Alpha.\n…\nBeta.");
    expect(() =>
      mapPassageIdsToRanges(index, [index.passages[0]!.passageId, index.passages[0]!.passageId]),
    ).toThrow();
    expect(
      mergeAdjacentRanges("A😀B", [
        { charStart: 0, charEnd: 1 },
        { charStart: 1, charEnd: 3 },
      ]),
    ).toEqual([{ charStart: 0, charEnd: 3 }]);
  });
});
