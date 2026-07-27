export type ExactTextRange = Readonly<{ charStart: number; charEnd: number }>;

/** Return false for any unpaired UTF-16 surrogate. */
export const isWellFormedUtf16 = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) return false;
  }
  return true;
};

const isCodePointBoundary = (value: string, offset: number): boolean => {
  if (offset <= 0 || offset >= value.length) return true;
  const previous = value.charCodeAt(offset - 1);
  const next = value.charCodeAt(offset);
  return !(previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff);
};

type NormalizationEntry = {
  readonly text: string;
  readonly span: ExactTextRange;
};

type FoldedText = {
  readonly text: string;
  readonly spans: readonly ExactTextRange[];
};

const caseFoldCodePoint = (value: string): string => {
  const codePoint = value.codePointAt(0);
  if (codePoint === undefined) return "";
  if (codePoint === 0x0131) return "ı";
  if (codePoint === 0x1e9e) return "ss";
  if (codePoint >= 0x13a0 && codePoint <= 0x13f5) return value;
  if (codePoint >= 0x13f8 && codePoint <= 0x13fd) {
    return String.fromCodePoint(codePoint - 8);
  }
  if (codePoint >= 0xab70 && codePoint <= 0xabbf) {
    return String.fromCodePoint(codePoint - 0x97d0);
  }
  return value.toUpperCase().toLowerCase();
};

export const normalizeAndCaseFold = (value: string): string =>
  Array.from(value.normalize("NFKC"), caseFoldCodePoint).join("");

const reorderWithOriginalSpans = (
  decomposed: readonly NormalizationEntry[],
  reorderedText: string,
): readonly NormalizationEntry[] => {
  const indicesByText = new Map<string, number[]>();
  for (let index = 0; index < decomposed.length; index += 1) {
    const entry = decomposed[index];
    if (entry === undefined) throw new Error("text normalization lost a decomposed contributor");
    const indices = indicesByText.get(entry.text);
    if (indices === undefined) indicesByText.set(entry.text, [index]);
    else indices.push(index);
  }

  const nextIndexByText = new Map<string, number>();
  const reordered: NormalizationEntry[] = [];
  for (const normalized of Array.from(reorderedText)) {
    const indices = indicesByText.get(normalized);
    const occurrence = nextIndexByText.get(normalized) ?? 0;
    const index = indices?.[occurrence];
    if (index === undefined) throw new Error("text normalization lost a reordered contributor");
    nextIndexByText.set(normalized, occurrence + 1);
    const entry = decomposed[index];
    if (entry === undefined) throw new Error("text normalization lost a reordered entry");
    reordered.push(entry);
  }
  if (reordered.length !== decomposed.length) {
    throw new Error("text normalization changed the decomposed contributor count");
  }
  return reordered;
};

const composeWithOriginalSpans = (
  reordered: readonly NormalizationEntry[],
  composedText: string,
): readonly NormalizationEntry[] => {
  const composed: NormalizationEntry[] = [];
  const indicesByText = new Map<string, number[]>();
  for (let index = 0; index < reordered.length; index += 1) {
    const entry = reordered[index];
    if (entry === undefined) throw new Error("text normalization lost a reordered entry");
    const indices = indicesByText.get(entry.text);
    if (indices === undefined) indicesByText.set(entry.text, [index]);
    else indices.push(index);
  }
  const nextIndexByText = new Map<string, number>();
  for (const composedCodePoint of Array.from(composedText)) {
    const contributors = Array.from(composedCodePoint.normalize("NFD"));
    if (contributors.length === 0) {
      throw new Error("text normalization produced an empty composed contributor");
    }
    const spans: ExactTextRange[] = [];
    for (const contributor of contributors) {
      const indices = indicesByText.get(contributor);
      const occurrence = nextIndexByText.get(contributor) ?? 0;
      const foundIndex = indices?.[occurrence];
      if (foundIndex === undefined) {
        throw new Error("text normalization could not prove a composed contributor mapping");
      }
      nextIndexByText.set(contributor, occurrence + 1);
      const entry = reordered[foundIndex];
      if (entry === undefined) throw new Error("text normalization lost a composed contributor");
      spans.push(entry.span);
    }
    const charStart = Math.min(...spans.map((span) => span.charStart));
    const charEnd = Math.max(...spans.map((span) => span.charEnd));
    composed.push({
      text: composedCodePoint,
      span: {
        charStart,
        charEnd,
      },
    });
  }
  let mappedContributors = 0;
  for (const occurrence of nextIndexByText.values()) mappedContributors += occurrence;
  if (mappedContributors !== reordered.length) {
    throw new Error("text normalization left an unmapped decomposed contributor");
  }
  return composed;
};

export const normalizeWithOriginalSpans = (value: string, originalOffset = 0): FoldedText => {
  const decomposed: NormalizationEntry[] = [];
  for (let index = 0; index < value.length; ) {
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) break;
    const source = String.fromCodePoint(codePoint);
    const span = {
      charStart: originalOffset + index,
      charEnd: originalOffset + index + source.length,
    };
    for (const normalized of Array.from(source.normalize("NFKD"))) {
      decomposed.push({ text: normalized, span });
    }
    index += source.length;
  }

  const reorderedText = decomposed
    .map((entry) => entry.text)
    .join("")
    .normalize("NFD");
  const reordered = reorderWithOriginalSpans(decomposed, reorderedText);
  const composed = composeWithOriginalSpans(reordered, reorderedText.normalize("NFC"));

  const foldedParts: string[] = [];
  const spans: ExactTextRange[] = [];
  for (const entry of composed) {
    const folded = caseFoldCodePoint(entry.text);
    for (let index = 0; index < folded.length; index += 1) {
      foldedParts.push(folded[index] ?? "");
      spans.push(entry.span);
    }
  }
  return { text: foldedParts.join(""), spans };
};

export const findNormalizedSubstringRanges = (
  text: string,
  terms: readonly string[],
  originalOffset = 0,
): readonly ExactTextRange[] => {
  if (terms.some((term) => !isWellFormedUtf16(term))) return [];
  let folded: FoldedText;
  try {
    folded = normalizeWithOriginalSpans(text, originalOffset);
  } catch {
    return [];
  }
  // The span composer is deliberately checked against the platform's exact
  // NFKC-plus-case-fold result. If a Unicode sequence cannot be mapped without
  // proof, return no ranges rather than exposing a guessed occurrence.
  if (folded.text !== normalizeAndCaseFold(text) || folded.spans.length !== folded.text.length) {
    return [];
  }
  const ranges: ExactTextRange[] = [];
  const seen = new Set<string>();
  for (const term of terms) {
    const normalizedTerm = normalizeAndCaseFold(term);
    if (normalizedTerm.length === 0) continue;
    let offset = 0;
    while (offset < folded.text.length) {
      const index = folded.text.indexOf(normalizedTerm, offset);
      if (index < 0) break;
      const end = index + normalizedTerm.length;
      if (!isCodePointBoundary(folded.text, index) || !isCodePointBoundary(folded.text, end)) {
        offset = index + 1;
        continue;
      }
      let charStart = Number.POSITIVE_INFINITY;
      let charEnd = 0;
      for (let spanIndex = index; spanIndex < end; spanIndex += 1) {
        const span = folded.spans[spanIndex];
        if (span === undefined) return [];
        charStart = Math.min(charStart, span.charStart);
        charEnd = Math.max(charEnd, span.charEnd);
      }
      if (!Number.isFinite(charStart) || charStart >= charEnd) return [];
      const key = `${charStart}:${charEnd}`;
      if (!seen.has(key)) {
        seen.add(key);
        ranges.push({ charStart, charEnd });
      }
      offset = end;
    }
  }
  return ranges.sort(
    (left, right) => left.charStart - right.charStart || left.charEnd - right.charEnd,
  );
};
