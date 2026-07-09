export type CitationTextSegment = {
  readonly type: "text";
  readonly text: string;
};

export type CitationMarkerSegment = {
  readonly type: "citations";
  readonly citationIds: readonly string[];
};

export type CitationTagSegment = CitationTextSegment | CitationMarkerSegment;

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
