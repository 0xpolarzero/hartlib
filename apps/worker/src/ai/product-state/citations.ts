export interface ParsedCitation {
  readonly sourceKey: string;
  readonly tagIndex: number;
  readonly keyIndex: number;
}

export interface CitationDefect {
  readonly token: string;
  readonly tagIndex: number;
  readonly defectSlot: number;
  readonly reason: "malformed" | "unknown_source_key";
}

export interface ParsedCitations {
  readonly citations: readonly ParsedCitation[];
  readonly defects: readonly CitationDefect[];
}

const boundedToken = (value: string): string => value.slice(0, 256);

/** Resolves only exact keys from the immutable current-turn source map. */
export const parseCurrentTurnCitations = (
  content: string,
  sourceKeys: ReadonlySet<string>,
): ParsedCitations => {
  const citations: ParsedCitation[] = [];
  const defects: CitationDefect[] = [];
  const completeTag = /\[\[cite:([^\]]*)\]\]/g;
  const coveredStarts = new Set<number>();
  let tagIndex = 0;

  for (const match of content.matchAll(completeTag)) {
    const matchStart = match.index;
    if (matchStart === undefined) continue;
    coveredStarts.add(matchStart);
    const token = match[0];
    const body = match[1] ?? "";
    const keys = body.split(",");
    const malformed =
      keys.length === 0 ||
      keys.some(
        (key) => key === "" || key !== key.trim() || !/^k_[A-Za-z0-9_-]+_[1-9][0-9]*$/.test(key),
      );

    if (malformed) {
      defects.push({ token: boundedToken(token), tagIndex, defectSlot: 0, reason: "malformed" });
      tagIndex += 1;
      continue;
    }

    for (const [keyIndex, sourceKey] of keys.entries()) {
      if (!sourceKeys.has(sourceKey)) {
        defects.push({
          token: boundedToken(token),
          tagIndex,
          defectSlot: keyIndex,
          reason: "unknown_source_key",
        });
        continue;
      }
      citations.push({ sourceKey, tagIndex, keyIndex });
    }
    tagIndex += 1;
  }

  let searchFrom = 0;
  while (true) {
    const start = content.indexOf("[[cite:", searchFrom);
    if (start < 0) break;
    searchFrom = start + 7;
    if (coveredStarts.has(start)) continue;
    const close = content.indexOf("]]", start + 7);
    const end = close < 0 ? Math.min(content.length, start + 256) : close + 2;
    defects.push({
      token: boundedToken(content.slice(start, end)),
      tagIndex,
      defectSlot: 0,
      reason: "malformed",
    });
    tagIndex += 1;
  }

  return { citations, defects };
};
