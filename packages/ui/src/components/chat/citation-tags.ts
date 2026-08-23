import type { PublicCitationRecord, PublicSourceRecord } from "@hartlib/shared";

export type CitationTextSegment = {
  readonly type: "text";
  readonly text: string;
};

export type CitationMarkerSegment = {
  readonly type: "citations";
  readonly citationIds: readonly string[];
};

export type CitationTagSegment = CitationTextSegment | CitationMarkerSegment;

export type CitationRun = {
  readonly text: string;
  /** Citation keys terminating this run; empty for uncited text. */
  readonly citationIds: readonly string[];
};

export type GroupedCitationRuns = {
  readonly runs: readonly CitationRun[];
  readonly pendingTail: string;
};

export type ParsedCitationTags = {
  readonly segments: readonly CitationTagSegment[];
  readonly pendingTail: string;
};

export type CitationParseMode = "streaming" | "final";

const citationOpen = "[[cite:";
const citationTagPattern = /\[\[cite:([A-Za-z0-9_-]+(?:,[A-Za-z0-9_-]+)*)\]\]/g;

const appendText = (segments: CitationTagSegment[], text: string) => {
  if (text.length === 0) return;
  const previous = segments[segments.length - 1];
  if (previous?.type === "text") {
    segments[segments.length - 1] = { type: "text", text: previous.text + text };
    return;
  }
  segments.push({ type: "text", text });
};

const splitPendingTail = (
  text: string,
): { readonly visible: string; readonly pendingTail: string } => {
  const openIndex = text.lastIndexOf(citationOpen);
  if (openIndex >= 0 && text.indexOf("]]", openIndex + citationOpen.length) === -1) {
    return {
      visible: text.slice(0, openIndex),
      pendingTail: text.slice(openIndex),
    };
  }

  const maxPrefixLength = Math.min(citationOpen.length - 1, text.length);
  for (let length = maxPrefixLength; length > 0; length -= 1) {
    const tail = text.slice(text.length - length);
    if (citationOpen.startsWith(tail)) {
      return {
        visible: text.slice(0, text.length - length),
        pendingTail: tail,
      };
    }
  }

  return { visible: text, pendingTail: "" };
};

export function parseCitationTags(
  text: string,
  knownCitationIds: readonly string[],
  mode: CitationParseMode = "streaming",
): ParsedCitationTags {
  const knownIds = new Set(knownCitationIds);
  const tailSplit = splitPendingTail(text);
  const visible = mode === "streaming" ? tailSplit.visible : text;
  const pendingTail = mode === "streaming" ? tailSplit.pendingTail : "";
  const segments: CitationTagSegment[] = [];
  let cursor = 0;

  for (const match of visible.matchAll(citationTagPattern)) {
    const raw = match[0];
    const rawIds = match[1];
    const index = match.index;
    if (index === undefined || rawIds === undefined) continue;

    appendText(segments, visible.slice(cursor, index));
    const citationIds = rawIds.split(",");
    if (citationIds.every((id) => knownIds.has(id))) {
      segments.push({ type: "citations", citationIds });
    } else {
      appendText(segments, raw);
    }
    cursor = index + raw.length;
  }

  appendText(segments, visible.slice(cursor));
  return { segments, pendingTail };
}

/**
 * Derive the answer span each citation supports: a `[[cite:...]]` tag
 * terminates the claim before it, so a run is the text since the previous
 * tag (or block start) plus the keys of the tag that closes it. Adjacent
 * tags share one run; a tag at the start of the text yields an empty-text
 * run so markers still render without inventing a highlighted span.
 */
export function groupCitationRuns(
  text: string,
  knownCitationIds: readonly string[],
  mode: CitationParseMode = "streaming",
): GroupedCitationRuns {
  const { segments, pendingTail } = parseCitationTags(text, knownCitationIds, mode);
  const runs: CitationRun[] = [];
  let current: { readonly text: string; readonly citationIds: string[] } | null = null;

  const closeCurrent = () => {
    if (current === null) return;
    if (current.text.length > 0 || current.citationIds.length > 0) runs.push(current);
    current = null;
  };

  for (const segment of segments) {
    if (segment.type === "citations") {
      if (current !== null) {
        current = {
          text: current.text,
          citationIds: [...current.citationIds, ...segment.citationIds],
        };
      } else {
        runs.push({ text: "", citationIds: [...segment.citationIds] });
      }
      continue;
    }
    if (current !== null && current.citationIds.length > 0) closeCurrent();
    current = {
      text: current === null ? segment.text : current.text + segment.text,
      citationIds: [],
    };
  }
  closeCurrent();
  return { runs, pendingTail };
}

/**
 * Resolve only complete, known citation tags from a streaming answer into the
 * public citation shape used by the transcript. Unknown or partial tags stay
 * in the rendered text and never fabricate a source record.
 */
export const citationRecordsFromText = (
  text: string,
  sources: readonly PublicSourceRecord[],
): readonly PublicCitationRecord[] => {
  const byKey = new Map(sources.map((source) => [source.sourceKey, source]));
  const parsed = parseCitationTags(text, [...byKey.keys()]);
  const ordered: PublicCitationRecord[] = [];

  for (const segment of parsed.segments) {
    if (segment.type !== "citations") continue;
    for (const key of segment.citationIds) {
      const source = byKey.get(key);
      if (source !== undefined && !ordered.some((citation) => citation.sourceKey === key)) {
        const { tokenCount: _tokenCount, topicIds: _topicIds, ...citation } = source;
        ordered.push({
          ...citation,
          // Streaming sources are not the server-authorized citation projection.
          // Never derive a quote from the public source record in the browser.
          quote: null,
        } as PublicCitationRecord);
      }
    }
  }
  return ordered;
};
