export type CitationTextSegment = { readonly type: "text"; readonly text: string };
export type CitationMarkerSegment = {
  readonly type: "citations";
  readonly citationIds: readonly string[];
};
export type CitationTagSegment = CitationTextSegment | CitationMarkerSegment;
export interface ParsedCitationTags {
  readonly segments: readonly CitationTagSegment[];
  readonly pendingTail: string;
}
export type CitationParseMode = "streaming" | "final";
const open = "[[cite:";
const pattern = /\[\[cite:([A-Za-z0-9_-]+(?:,[A-Za-z0-9_-]+)*)\]\]/g;
function tail(text: string): { visible: string; pendingTail: string } {
  const index = text.lastIndexOf(open);
  if (index >= 0 && !text.includes("]]", index + open.length))
    return { visible: text.slice(0, index), pendingTail: text.slice(index) };
  for (let length = Math.min(open.length - 1, text.length); length > 0; length -= 1) {
    const candidate = text.slice(-length);
    if (open.startsWith(candidate))
      return { visible: text.slice(0, -length), pendingTail: candidate };
  }
  return { visible: text, pendingTail: "" };
}
/** Remove only an incomplete trailing citation marker while an answer streams. */
export function stripPendingCitationTail(text: string): string {
  return tail(text).visible;
}
function append(segments: CitationTagSegment[], text: string) {
  if (!text) return;
  const previous = segments.at(-1);
  if (previous?.type === "text")
    segments[segments.length - 1] = { type: "text", text: previous.text + text };
  else segments.push({ type: "text", text });
}
export function parseCitationTags(
  text: string,
  knownCitationIds: readonly string[],
  mode: CitationParseMode = "streaming",
): ParsedCitationTags {
  const split = tail(text);
  const visible = mode === "streaming" ? split.visible : text;
  const segments: CitationTagSegment[] = [];
  const known = new Set(knownCitationIds);
  let cursor = 0;
  for (const match of visible.matchAll(pattern)) {
    const index = match.index ?? 0;
    const raw = match[0];
    const rawIds = match[1]!.split(",");
    append(segments, visible.slice(cursor, index));
    if (rawIds.every((id) => known.has(id)))
      segments.push({ type: "citations", citationIds: rawIds });
    else append(segments, raw);
    cursor = index + raw.length;
  }
  append(segments, visible.slice(cursor));
  return { segments, pendingTail: mode === "streaming" ? split.pendingTail : "" };
}
