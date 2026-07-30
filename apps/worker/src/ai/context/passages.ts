import { z } from "zod";

import { stripHistoricalCitationTags, type SourceRange } from "../workflow/types";

export type PassageKind = "paragraph" | "sentence";

export interface Passage {
  readonly passageId: `p${number}`;
  readonly kind: PassageKind;
  readonly ordinal: number;
  readonly paragraphOrdinal: number;
  readonly sentenceOrdinal: number | null;
  readonly range: SourceRange;
  readonly text: string;
  readonly tokenCount: number;
  readonly utf8ByteCount: number;
}

export interface PassageIndex {
  readonly text: string;
  readonly passages: readonly Passage[];
  readonly paragraphs: readonly Passage[];
  readonly sentences: readonly Passage[];
}

/** The provider receives opaque IDs and exact text, never source offsets. */
export interface PassageView {
  readonly passageId: `p${number}`;
  readonly text: string;
}

const isHighSurrogate = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff;
const isLowSurrogate = (unit: number): boolean => unit >= 0xdc00 && unit <= 0xdfff;

export function isWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (isHighSurrogate(unit)) {
      const next = value.charCodeAt(index + 1);
      if (!isLowSurrogate(next)) return false;
      index += 1;
    } else if (isLowSurrogate(unit)) {
      return false;
    }
  }
  return true;
}

export const PassageViewSchema = z.strictObject({
  passageId: z.string().regex(/^p[1-9][0-9]*$/u),
  text: z.string().refine(isWellFormedUtf16, "passage text must be well-formed UTF-16"),
});

export const PassageRangeSchema = z
  .strictObject({
    charStart: z.number().int().finite().safe().min(0),
    charEnd: z.number().int().finite().safe().positive(),
  })
  .superRefine((range, context) => {
    if (range.charEnd <= range.charStart) {
      context.addIssue({ code: "custom", message: "range end must be greater than start" });
    }
  });

export const PassageSchema = z.strictObject({
  passageId: z.string().regex(/^p[1-9][0-9]*$/u),
  kind: z.enum(["paragraph", "sentence"]),
  ordinal: z.number().int().finite().positive(),
  paragraphOrdinal: z.number().int().finite().positive(),
  sentenceOrdinal: z.number().int().finite().positive().nullable(),
  range: PassageRangeSchema,
  text: z.string().refine(isWellFormedUtf16, "passage text must be well-formed UTF-16"),
  tokenCount: z.number().int().finite().safe().min(0),
  utf8ByteCount: z.number().int().finite().safe().min(0),
});

export const toProviderPassageView = (passage: Passage): PassageView => ({
  passageId: passage.passageId,
  text: passage.text,
});

export const isUtf16Boundary = (text: string, offset: number): boolean => {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length) return false;
  if (offset === 0 || offset === text.length) return true;
  return !(isHighSurrogate(text.charCodeAt(offset - 1)) && isLowSurrogate(text.charCodeAt(offset)));
};

const trimRange = (text: string, start: number, end: number): SourceRange | null => {
  while (start < end && /\s/u.test(text[start] ?? "")) start += 1;
  while (end > start && /\s/u.test(text[end - 1] ?? "")) end -= 1;
  return start < end ? { charStart: start, charEnd: end } : null;
};

export { stripHistoricalCitationTags };

export const sanitizePassageText = (
  value: string,
  options: { readonly stripCitations?: boolean | undefined } = {},
): string => {
  const stripped = options.stripCitations === true ? stripHistoricalCitationTags(value) : value;
  if (!isWellFormedUtf16(stripped)) throw new Error("passage text contains an unpaired surrogate");
  return stripped;
};

/** Canonical form for matching and deduplication; source ranges stay in the sanitized text. */
export const normalizePassageText = (value: string): string => {
  if (!isWellFormedUtf16(value)) throw new Error("passage text contains an unpaired surrogate");
  return value.normalize("NFC");
};

export const normalizeRange = (text: string, range: SourceRange): SourceRange => {
  if (
    !isWellFormedUtf16(text) ||
    !Number.isSafeInteger(range.charStart) ||
    !Number.isSafeInteger(range.charEnd) ||
    range.charStart < 0 ||
    range.charEnd <= range.charStart ||
    range.charEnd > text.length ||
    !isUtf16Boundary(text, range.charStart) ||
    !isUtf16Boundary(text, range.charEnd)
  ) {
    throw new Error("range is outside text or splits a surrogate pair");
  }
  return { charStart: range.charStart, charEnd: range.charEnd };
};

/** Sort, validate, and merge overlapping or directly adjacent UTF-16 ranges. */
export const mergeAdjacentRanges = (
  text: string,
  ranges: readonly SourceRange[],
): readonly SourceRange[] => {
  const ordered = ranges
    .map((range) => normalizeRange(text, range))
    .sort((left, right) => left.charStart - right.charStart || left.charEnd - right.charEnd);
  const merged: SourceRange[] = [];
  for (const range of ordered) {
    const previous = merged.at(-1);
    if (previous === undefined || range.charStart > previous.charEnd) {
      merged.push(range);
    } else {
      merged[merged.length - 1] = {
        charStart: previous.charStart,
        charEnd: Math.max(previous.charEnd, range.charEnd),
      };
    }
  }
  return merged;
};

export const rangesSubsetOf = (
  text: string,
  subset: readonly SourceRange[],
  superset: readonly SourceRange[],
): boolean => {
  const subsetRanges = mergeAdjacentRanges(text, subset);
  const supersetRanges = mergeAdjacentRanges(text, superset);
  return subsetRanges.every((small) =>
    supersetRanges.some(
      (large) => small.charStart >= large.charStart && small.charEnd <= large.charEnd,
    ),
  );
};

/** Split an immutable range at Unicode scalar boundaries under a UTF-8 byte cap. */
export const splitRangeByUtf8Bytes = (
  text: string,
  range: SourceRange,
  maxBytes: number,
): readonly SourceRange[] => {
  const normalized = normalizeRange(text, range);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("byte cap must be a positive safe integer");
  }
  const encoder = new TextEncoder();
  const ranges: SourceRange[] = [];
  let start = normalized.charStart;
  let bytes = 0;
  for (let index = normalized.charStart; index < normalized.charEnd; ) {
    const codePoint = text.codePointAt(index);
    if (codePoint === undefined) throw new Error("range ended before a Unicode scalar");
    const scalar = String.fromCodePoint(codePoint);
    const scalarBytes = encoder.encode(scalar).byteLength;
    if (scalarBytes > maxBytes) throw new Error("one Unicode scalar exceeds the byte cap");
    if (bytes > 0 && bytes + scalarBytes > maxBytes) {
      ranges.push({ charStart: start, charEnd: index });
      start = index;
      bytes = 0;
    }
    bytes += scalarBytes;
    index += scalar.length;
  }
  if (start < normalized.charEnd) ranges.push({ charStart: start, charEnd: normalized.charEnd });
  return ranges;
};

const paragraphRanges = (text: string): readonly SourceRange[] => {
  if (text.length === 0) return [];
  const ranges: SourceRange[] = [];
  let start = 0;
  const separator = /\r?\n[ \t\r]*\r?\n+/gu;
  for (const match of text.matchAll(separator)) {
    const separatorStart = match.index;
    const paragraph = trimRange(text, start, separatorStart);
    if (paragraph !== null) ranges.push(paragraph);
    start = separatorStart + match[0].length;
  }
  const final = trimRange(text, start, text.length);
  if (final !== null) ranges.push(final);
  return ranges;
};

const sentenceRanges = (text: string, paragraph: SourceRange): readonly SourceRange[] => {
  const ranges: SourceRange[] = [];
  let start = paragraph.charStart;
  let index = paragraph.charStart;
  const isTerminator = (unit: string): boolean => ".!?。！？".includes(unit);
  while (index < paragraph.charEnd) {
    const unit = text[index] ?? "";
    if (unit === "\n") {
      const next = text[index + 1] ?? "";
      if (next !== "" && !/\s/u.test(next)) {
        const range = trimRange(text, start, index);
        if (range !== null) ranges.push(range);
        start = index + 1;
      }
    } else if (isTerminator(unit)) {
      let end = index + 1;
      while (end < paragraph.charEnd && /["'”’»)]/u.test(text[end] ?? "")) end += 1;
      const next = text[end] ?? "";
      if (end === paragraph.charEnd || /\s/u.test(next)) {
        const range = trimRange(text, start, end);
        if (range !== null) ranges.push(range);
        start = end;
        index = end - 1;
      }
    }
    index += 1;
  }
  const final = trimRange(text, start, paragraph.charEnd);
  if (final !== null) ranges.push(final);
  return ranges;
};

export interface PassageIndexOptions {
  readonly stripCitations?: boolean | undefined;
  readonly maxTokens: number;
  readonly maxUtf8Bytes: number;
  readonly countTokens: (text: string) => number;
  /**
   * Restrict passage views to these immutable UTF-16 source ranges. An
   * omitted value means the complete text; an empty array means no text is
   * authorized.
   */
  readonly authorizedRanges?: readonly SourceRange[] | undefined;
}

const assertPassageLimit = (value: number, name: string): void => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
};

const splitRangeByTokenCount = (
  text: string,
  range: SourceRange,
  maxTokens: number,
  countTokens: (text: string) => number,
): readonly SourceRange[] => {
  const normalized = normalizeRange(text, range);
  const ranges: SourceRange[] = [];
  const scalarEnds: number[] = [normalized.charStart];
  for (let index = normalized.charStart; index < normalized.charEnd; ) {
    const codePoint = text.codePointAt(index);
    if (codePoint === undefined) throw new Error("passage ended before a Unicode scalar");
    index += String.fromCodePoint(codePoint).length;
    scalarEnds.push(index);
  }

  let startScalar = 0;
  const lastScalar = scalarEnds.length - 1;
  while (startScalar < lastScalar) {
    const start = scalarEnds[startScalar]!;
    const countPrefix = (endScalar: number): number => {
      const count = countTokens(text.slice(start, scalarEnds[endScalar]!));
      if (!Number.isSafeInteger(count) || count < 0) {
        throw new Error("token counter must return a non-negative safe integer");
      }
      return count;
    };

    let accepted = 0;
    let probe = 1;
    while (probe <= lastScalar - startScalar) {
      const count = countPrefix(startScalar + probe);
      if (count > maxTokens) break;
      accepted = probe;
      if (probe === lastScalar - startScalar) break;
      probe = Math.min(lastScalar - startScalar, probe * 2);
    }
    if (accepted === 0) throw new Error("one Unicode scalar exceeds the token cap");

    let low = accepted;
    let high = Math.min(probe, lastScalar - startScalar);
    if (high === low && low < lastScalar - startScalar) {
      high = low + 1;
    }
    while (high - low > 1) {
      const middle = low + Math.floor((high - low) / 2);
      if (countPrefix(startScalar + middle) <= maxTokens) low = middle;
      else high = middle;
    }

    const endScalar = startScalar + low;
    const end = scalarEnds[endScalar]!;
    const finalCount = countPrefix(endScalar);
    if (finalCount > maxTokens) {
      throw new Error("token-bounded passage exceeds its exact token cap");
    }
    ranges.push({ charStart: start, charEnd: end });
    startScalar = endScalar;
  }
  return ranges;
};

export const buildPassageIndex = (value: string, options: PassageIndexOptions): PassageIndex => {
  assertPassageLimit(options.maxTokens, "token cap");
  assertPassageLimit(options.maxUtf8Bytes, "UTF-8 byte cap");
  const text = sanitizePassageText(value, options);
  const encoder = new TextEncoder();
  const passages: Passage[] = [];
  const addPassage = (
    kind: PassageKind,
    paragraphOrdinal: number,
    sentenceOrdinal: number | null,
    range: SourceRange,
  ): void => {
    const passageText = text.slice(range.charStart, range.charEnd);
    const tokenCount = options.countTokens(passageText);
    const utf8ByteCount = encoder.encode(passageText).byteLength;
    if (!Number.isSafeInteger(tokenCount) || tokenCount < 0) {
      throw new Error("token counter must return a non-negative safe integer");
    }
    if (tokenCount > options.maxTokens || utf8ByteCount > options.maxUtf8Bytes) {
      throw new Error("passage exceeds its exact token or UTF-8 byte cap");
    }
    if (passageText !== text.slice(range.charStart, range.charEnd)) {
      throw new Error("passage text does not reconstruct from its range");
    }
    const ordinal = passages.length + 1;
    passages.push({
      passageId: `p${ordinal}`,
      kind,
      ordinal,
      paragraphOrdinal,
      sentenceOrdinal,
      range,
      text: passageText,
      tokenCount,
      utf8ByteCount,
    });
  };

  const authorizedRanges =
    options.authorizedRanges === undefined
      ? text.length === 0
        ? []
        : [{ charStart: 0, charEnd: text.length }]
      : mergeAdjacentRanges(text, options.authorizedRanges);
  const paragraphsInText = paragraphRanges(text);
  const addAuthorizedParagraph = (
    paragraphOrdinal: number,
    paragraphRange: SourceRange,
    authorizedRange: SourceRange,
  ): void => {
    const range = trimRange(
      text,
      Math.max(paragraphRange.charStart, authorizedRange.charStart),
      Math.min(paragraphRange.charEnd, authorizedRange.charEnd),
    );
    if (range === null) return;
    const paragraphText = text.slice(range.charStart, range.charEnd);
    const paragraphTokenCount = options.countTokens(paragraphText);
    const paragraphByteCount = encoder.encode(paragraphText).byteLength;
    if (
      !Number.isSafeInteger(paragraphTokenCount) ||
      paragraphTokenCount < 0 ||
      !Number.isSafeInteger(paragraphByteCount)
    ) {
      throw new Error("token counter must return a non-negative safe integer");
    }
    if (paragraphByteCount <= options.maxUtf8Bytes && paragraphTokenCount <= options.maxTokens) {
      addPassage("paragraph", paragraphOrdinal, null, range);
      return;
    }

    for (const [sentenceIndex, sentenceRange] of sentenceRanges(text, range).entries()) {
      const byteRanges = splitRangeByUtf8Bytes(text, sentenceRange, options.maxUtf8Bytes);
      for (const byteRange of byteRanges) {
        for (const tokenRange of splitRangeByTokenCount(
          text,
          byteRange,
          options.maxTokens,
          options.countTokens,
        )) {
          addPassage("sentence", paragraphOrdinal, sentenceIndex + 1, tokenRange);
        }
      }
    }
  };

  for (const authorizedRange of authorizedRanges) {
    for (const [paragraphIndex, paragraphRange] of paragraphsInText.entries()) {
      if (
        paragraphRange.charEnd <= authorizedRange.charStart ||
        paragraphRange.charStart >= authorizedRange.charEnd
      ) {
        continue;
      }
      addAuthorizedParagraph(paragraphIndex + 1, paragraphRange, authorizedRange);
    }
  }
  for (let index = 1; index < passages.length; index += 1) {
    if (passages[index]!.range.charStart < passages[index - 1]!.range.charEnd) {
      throw new Error("passage index contains overlapping passages");
    }
  }
  const paragraphs = passages.filter((passage) => passage.kind === "paragraph");
  const sentences = passages.filter((passage) => passage.kind === "sentence");
  return { text, passages, paragraphs, sentences };
};

export const mapPassageIdsToRanges = (
  index: PassageIndex,
  passageIds: readonly string[],
): readonly SourceRange[] => {
  const passagesById = new Map<string, Passage>(
    index.passages.map((passage) => [passage.passageId, passage]),
  );
  const seen = new Set<string>();
  const ranges: SourceRange[] = [];
  for (const passageId of passageIds) {
    if (seen.has(passageId)) throw new Error(`passage ${passageId} was selected twice`);
    seen.add(passageId);
    const passage = passagesById.get(passageId);
    if (passage === undefined) throw new Error(`passage ${passageId} is not in this index`);
    ranges.push(passage.range);
  }
  return mergeAdjacentRanges(index.text, ranges);
};

export const selectedTextFromRanges = (
  text: string,
  ranges: readonly SourceRange[],
  separator = "\n…\n",
): string =>
  mergeAdjacentRanges(text, ranges)
    .map((range) => text.slice(range.charStart, range.charEnd))
    .join(separator);
