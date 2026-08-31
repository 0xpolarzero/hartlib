import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { Bookmark, FileText, Globe, MessagesSquare } from "lucide-react";
import { cn } from "../../../lib/utils";
import { uiMessage } from "../../../lib/format";
import type { CitationKind, PublicCitationRecord } from "./types";

type CitationSource = PublicCitationRecord & { ordinal?: number; meta?: string };
type CitationContext = {
  sources: readonly CitationSource[];
  activeKeys: ReadonlySet<string>;
  setActive: (keys: string | readonly string[] | null) => void;
  locale: string;
  onCitation?: (source: CitationSource) => void | Promise<void>;
};
const Context = createContext<CitationContext | null>(null);
const glyphs: Record<CitationKind, typeof FileText> = {
  document: FileText,
  web: Globe,
  memory: Bookmark,
  chat_message: MessagesSquare,
};
const citationKindMessageIds: Record<
  CitationKind,
  | "ui.citationKindDocument"
  | "ui.citationKindWeb"
  | "ui.citationKindMemory"
  | "ui.citationKindChatMessage"
> = {
  document: "ui.citationKindDocument",
  web: "ui.citationKindWeb",
  memory: "ui.citationKindMemory",
  chat_message: "ui.citationKindChatMessage",
};
export function CitationProvider({
  sources,
  children,
  locale = "en-US",
  onCitation,
}: {
  sources: readonly CitationSource[];
  children: ReactNode;
  locale?: string;
  onCitation?: (source: CitationSource) => void | Promise<void>;
}) {
  const [activeKeys, setActiveKeys] = useState<ReadonlySet<string>>(new Set());
  const setActive = (keys: string | readonly string[] | null) =>
    setActiveKeys(new Set(keys === null ? [] : typeof keys === "string" ? [keys] : keys));
  const value = useMemo(
    () => ({ sources, activeKeys, setActive, locale, ...(onCitation ? { onCitation } : {}) }),
    [activeKeys, locale, onCitation, sources],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function citationKindLabel(kind: CitationKind, labeler?: (kind: CitationKind) => string) {
  return labeler?.(kind) ?? kind.replace("_", " ");
}
function localizedCitationKindLabel(kind: CitationKind, locale: string) {
  return uiMessage(locale, citationKindMessageIds[kind]);
}
const citationMark = (source: CitationSource) =>
  source.ordinal === undefined ? source.sourceKey : `[${source.ordinal}]`;
function Details({ source, locale }: { source: CitationSource; locale?: string }) {
  return (
    <>
      <p className="caps-label text-accent">
        {localizedCitationKindLabel(source.kind, locale ?? "en-US")} · {source.sourceKey}
      </p>
      <p className="mt-1 text-[13px] font-medium">{source.label ?? source.sourceKey}</p>
      {source.quote ? (
        <blockquote className="mt-2 border-l-2 border-accent/40 pl-2 font-read text-[13px] italic text-ink-2">
          {source.quote.text}
        </blockquote>
      ) : (
        <p className="mt-1.5 text-[12px] text-ink-2">{uiMessage(locale, "ui.quoteUnavailable")}</p>
      )}
    </>
  );
}
export function CitationChip({
  source,
  bare = false,
  focusable = true,
}: {
  source: CitationSource;
  bare?: boolean;
  focusable?: boolean;
}) {
  const context = useContext(Context);
  const Glyph = glyphs[source.kind];
  const key = source.sourceKey;
  const active = context?.activeKeys.has(key) === true;
  const locale = context?.locale ?? "en-US";
  const ariaLabel = `${uiMessage(locale, "ui.citation")} ${source.ordinal ?? key} — ${source.label ?? key}`;
  return (
    <span className="relative inline">
      {focusable ? (
        <button
          type="button"
          data-testid="citation-chip"
          aria-label={ariaLabel}
          onMouseEnter={() => context?.setActive(key)}
          onMouseLeave={() => context?.setActive(null)}
          onFocus={() => context?.setActive(key)}
          onBlur={() => context?.setActive(null)}
          onClick={() => void context?.onCitation?.(source)}
          className={cn(
            "mx-0.5 inline-flex h-4 items-center gap-0.5 rounded-tiny border px-1 align-baseline font-mono text-[10px] text-accent focus-visible:outline-2 focus-visible:outline-accent",
            active ? "border-accent bg-accent text-paper" : "border-accent/45 bg-accent/8",
          )}
        >
          {citationMark(source)}
        </button>
      ) : (
        <span
          data-testid="citation-chip-repeat"
          aria-label={ariaLabel}
          onMouseEnter={() => context?.setActive(key)}
          onMouseLeave={() => context?.setActive(null)}
          className={cn(
            "mx-0.5 inline-flex h-4 items-center gap-0.5 rounded-tiny border px-1 align-baseline font-mono text-[10px] text-accent",
            active ? "border-accent bg-accent text-paper" : "border-accent/45 bg-accent/8",
          )}
        >
          {citationMark(source)}
        </span>
      )}
      <Glyph className="ml-0.5 inline size-2.5 text-ink-3" aria-hidden="true" />
      {bare && <span className="sr-only">{localizedCitationKindLabel(source.kind, locale)}</span>}
      {active && (
        <span
          role="tooltip"
          className="absolute left-0 top-full z-30 mt-1 w-64 rounded-tiny border border-line-2 bg-surface p-2.5 text-left shadow-none animate-enter"
        >
          <Details source={source} locale={context?.locale} />
        </span>
      )}
    </span>
  );
}
export function ClaimSpan({ cites, children }: { cites: readonly string[]; children: ReactNode }) {
  const context = useContext(Context);
  return (
    <span
      tabIndex={0}
      onMouseEnter={() => context?.setActive(cites)}
      onMouseLeave={() => context?.setActive(null)}
      onFocus={() => context?.setActive(cites)}
      onBlur={() => context?.setActive(null)}
      className={cn(
        "rounded-[2px] bg-accent/8 underline decoration-accent/50 underline-offset-2 focus-visible:outline-2 focus-visible:outline-accent",
        cites.some((cite) => context?.activeKeys.has(cite)) && "bg-accent/18",
      )}
    >
      {children}
    </span>
  );
}
export function MarginCard({ source }: { source: CitationSource }) {
  const context = useContext(Context);
  const Glyph = glyphs[source.kind];
  const active = context?.activeKeys.has(source.sourceKey) === true;
  const locale = context?.locale ?? "en-US";
  return (
    <aside
      role="button"
      tabIndex={0}
      aria-label={`${uiMessage(locale, "ui.citation")} ${source.ordinal ?? source.sourceKey} — ${source.label ?? source.sourceKey}`}
      onMouseEnter={() => context?.setActive(source.sourceKey)}
      onMouseLeave={() => context?.setActive(null)}
      onFocus={() => context?.setActive(source.sourceKey)}
      onBlur={() => context?.setActive(null)}
      onClick={() => void context?.onCitation?.(source)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          void context?.onCitation?.(source);
        }
      }}
      className={cn(
        "rounded-tiny border bg-surface px-2.5 py-2",
        active ? "border-accent" : "border-line",
      )}
    >
      <p className="flex items-center gap-1.5">
        <span className="font-mono text-[10px] text-accent">{citationMark(source)}</span>
        <Glyph className="size-3 text-ink-2" aria-hidden="true" />
        <span className="caps-label text-ink-2">
          {localizedCitationKindLabel(source.kind, locale)}
        </span>
      </p>
      <p className="mt-1.5 text-[12px] font-medium">{source.label ?? source.sourceKey}</p>
      {source.quote ? (
        <blockquote className="mt-1.5 line-clamp-6 border-l-2 border-accent/40 pl-2 font-read text-[12px] italic text-ink-2">
          {source.quote.text}
        </blockquote>
      ) : (
        <p className="mt-1.5 text-[11.5px] italic text-ink-2">
          {uiMessage(context?.locale, "ui.quoteUnavailable")}
        </p>
      )}
    </aside>
  );
}
export function injectCitations(
  text: string,
  sources: readonly CitationSource[] = [],
): ReactNode[] {
  const byKey = new Map(sources.map((source) => [source.sourceKey, source]));
  const out: ReactNode[] = [];
  const focusKeys = new Set<string>();
  const re = /\[\[cite:([A-Za-z0-9_-]+(?:,[A-Za-z0-9_-]+)*)\]\]/g;
  let cursor = 0;
  for (const match of text.matchAll(re)) {
    const index = match.index ?? 0;
    if (index > cursor) out.push(text.slice(cursor, index));
    const ids = match[1]!.split(",");
    ids.forEach((id) => {
      const source = byKey.get(id);
      if (source) {
        const focusable = !focusKeys.has(id);
        focusKeys.add(id);
        out.push(<CitationChip key={`${id}-${index}`} source={source} focusable={focusable} />);
      } else out.push(`[[cite:${id}]]`);
    });
    cursor = index + match[0].length;
  }
  if (cursor < text.length) out.push(text.slice(cursor));
  return out;
}
export function hasMarkers(text: string) {
  return /\[\[cite:[A-Za-z0-9_-]+(?:,[A-Za-z0-9_-]+)*\]\]/.test(text);
}
