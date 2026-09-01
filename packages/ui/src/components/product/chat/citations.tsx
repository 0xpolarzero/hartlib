import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { Bookmark, FileText, Globe, MessagesSquare } from "lucide-react";
import { cn } from "../../../lib/utils";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "../../ui/overlays";
import { t } from "./localize";
import type { CitationKind, PublicCitationRecord } from "./types";

/* Inline citation syntax in streamed answers (production marker format):
 *   [[cite:source-1]]              bare chip for one normalized source key
 *   [[cite:source-1,source-2]]     chips + tinted claim span over the preceding text
 */
export const CLAIM_RE = /\[\[cite:([A-Za-z0-9_-]+(?:,[A-Za-z0-9_-]+)*)\]\]/;
export const BARE_RE = /\[\[cite:([A-Za-z0-9_-]+(?:,[A-Za-z0-9_-]+)*)\]\]/;
const ANY_SPLIT = /\[\[cite:[A-Za-z0-9_-]+(?:,[A-Za-z0-9_-]+)*\]\]/;

/** Production citation record with its normalized display ordinal. */
export type CitationSource = PublicCitationRecord & { ordinal: number; meta?: string | undefined };

interface CitationCtx {
  sources: readonly CitationSource[];
  /** Ordinals → index of the first block citing them (margin-card owner). */
  carded: Map<number, number>;
  /** Hovered/focused citation key (comma-joined source keys) — syncs chip, claim, card. */
  hovered: string | null;
  setHovered: (key: string | null) => void;
  locale: string;
  onCitation?: (source: PublicCitationRecord) => void | Promise<void>;
}

const Ctx = createContext<CitationCtx | null>(null);

export function CitationProvider({
  sources,
  children,
  carded,
  locale = "en-US",
  onCitation,
}: {
  sources: readonly CitationSource[];
  carded: Map<number, number>;
  children: ReactNode;
  locale?: string;
  onCitation?: (source: PublicCitationRecord) => void | Promise<void>;
}) {
  const [hovered, setHovered] = useState<string | null>(null);
  const value = useMemo<CitationCtx>(
    () => ({ sources, carded, hovered, setHovered, locale, ...(onCitation ? { onCitation } : {}) }),
    [sources, carded, hovered, locale, onCitation],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

function useCitations(): CitationCtx | null {
  return useContext(Ctx);
}

const KIND_GLYPH: Record<CitationKind, typeof FileText> = {
  document: FileText,
  web: Globe,
  memory: Bookmark,
  chat_message: MessagesSquare,
};

const kindKey = (kind: CitationKind): string =>
  kind === "chat_message" ? "citations.kind_chat" : `citations.kind_${kind}`;

export function citationKindLabel(kind: CitationKind, t?: (key: string) => string): string {
  const key = kindKey(kind);
  if (t) return t(key);
  return kind.replace("_", " ");
}

function CitationDetails({ source }: { source: CitationSource }) {
  const ctx = useCitations();
  const locale = ctx?.locale ?? "en-US";
  return (
    <>
      <p className="caps-label text-accent">
        {citationKindLabel(source.kind, (key) => t(locale, key))} · {source.ordinal}
        {source.meta ? ` · ${source.meta}` : ""}
      </p>
      <p className="mt-1 text-[13px] font-medium leading-snug text-ink">
        {source.label ?? source.sourceKey}
      </p>
      {source.quote && (
        <blockquote className="mt-2 border-l-2 border-accent/40 pl-2 font-read text-[13px] italic leading-snug text-ink-2">
          {String(source.quote.text)}
        </blockquote>
      )}
      {!source.quote && (
        <p className="mt-1.5 text-[12px] text-ink-2">{t(locale, "citations.quoteUnavailable")}</p>
      )}
      {source.kind === "memory" && (
        <p className="mt-2 font-mono text-[10.5px] text-accent">
          {t(locale, "citations.openMemory")}
        </p>
      )}
    </>
  );
}

/** Inline ordinal chip. Focusable; hover/focus syncs highlight with its claim + card. */
export function CitationChip({
  source,
  bare = false,
  focusable = true,
}: {
  source: CitationSource;
  bare?: boolean;
  focusable?: boolean;
}) {
  const ctx = useCitations();
  const locale = ctx?.locale ?? "en-US";
  const Glyph = KIND_GLYPH[source.kind];
  const key = source.sourceKey;
  const active = ctx?.hovered === key;
  const label = `${t(locale, "citations.chipLabel", { n: String(source.ordinal) })} — ${source.label ?? source.sourceKey}`;

  const chip = focusable ? (
    <button
      type="button"
      data-testid="citation-chip"
      aria-label={label}
      onMouseEnter={() => ctx?.setHovered(key)}
      onMouseLeave={() => ctx?.setHovered(null)}
      onFocus={() => ctx?.setHovered(key)}
      onBlur={() => ctx?.setHovered(null)}
      onClick={() => void ctx?.onCitation?.(source)}
      className={cn(
        "mx-0.5 inline-flex h-[16px] select-none items-center gap-0.5 rounded-tiny border px-1 align-baseline",
        "font-mono text-[10px] leading-none",
        "transition-colors duration-100 ease-[cubic-bezier(0.23,1,0.32,1)]",
        active
          ? "border-accent bg-accent text-paper"
          : "border-accent/45 bg-accent/8 text-accent hover:border-accent",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
      )}
    >
      <span aria-hidden="true">{source.ordinal}</span>
    </button>
  ) : (
    <span
      data-testid="citation-chip-repeat"
      aria-label={label}
      onMouseEnter={() => ctx?.setHovered(key)}
      onMouseLeave={() => ctx?.setHovered(null)}
      className={cn(
        "mx-0.5 inline-flex h-[16px] select-none items-center gap-0.5 rounded-tiny border px-1 align-baseline",
        "font-mono text-[10px] leading-none",
        "transition-colors duration-100 ease-[cubic-bezier(0.23,1,0.32,1)]",
        active ? "border-accent bg-accent text-paper" : "border-accent/45 bg-accent/8 text-accent",
      )}
    >
      <span aria-hidden="true">{source.ordinal}</span>
    </span>
  );

  return (
    <HoverCard>
      <HoverCardTrigger asChild>
        <span className="inline">
          {chip}
          <span aria-hidden="true" className="ml-0.5 inline-block align-baseline">
            <Glyph className={cn("size-2.5", active ? "text-accent" : "text-ink-3")} />
          </span>
          {bare && (
            <span className="sr-only">
              {citationKindLabel(source.kind, (key) => t(locale, key))}
            </span>
          )}
        </span>
      </HoverCardTrigger>
      <HoverCardContent className="w-72">
        <CitationDetails source={source} />
      </HoverCardContent>
    </HoverCard>
  );
}

/** Tinted claim span; hover/focus raises chip + card alongside it. */
export function ClaimSpan({ cites, children }: { cites: readonly string[]; children: ReactNode }) {
  const ctx = useCitations();
  const key = cites.join(",");
  const active = ctx?.hovered === key;
  const citedSources = ctx
    ? cites.flatMap((sourceKey) => {
        const source = ctx.sources.find((candidate) => candidate.sourceKey === sourceKey);
        return source ? [source] : [];
      })
    : [];
  const span = (
    <span
      onMouseEnter={() => ctx?.setHovered(key)}
      onMouseLeave={() => ctx?.setHovered(null)}
      onFocus={() => ctx?.setHovered(key)}
      onBlur={() => ctx?.setHovered(null)}
      tabIndex={0}
      className={cn(
        "rounded-[2px] transition-colors duration-100 ease-[cubic-bezier(0.23,1,0.32,1)]",
        "bg-accent/8 decoration-accent/50 underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent",
        active && "bg-accent/18 underline",
      )}
    >
      {children}
    </span>
  );

  if (citedSources.length === 0) return span;

  return (
    <HoverCard>
      <HoverCardTrigger asChild>{span}</HoverCardTrigger>
      <HoverCardContent className="w-72 lg:hidden">
        {citedSources.map((source, index) => (
          <div key={source.sourceKey} className={cn(index > 0 && "mt-3 border-t border-line pt-3")}>
            <CitationDetails source={source} />
          </div>
        ))}
      </HoverCardContent>
    </HoverCard>
  );
}

/**
 * Parse a raw string into nodes: text, bare chips, and claim spans.
 * Applied to text nodes of markdown inline content only (never to code).
 */
export function injectCitations(
  text: string,
  sources: readonly CitationSource[] = [],
): ReactNode[] {
  const ctx = useCitations();
  const sourceFor = (sourceKey: string): CitationSource | undefined =>
    ctx?.sources.find((s) => s.sourceKey === sourceKey) ??
    sources.find((s) => s.sourceKey === sourceKey);
  const out: ReactNode[] = [];
  let rest = text;
  let key = 0;

  while (rest.length > 0) {
    const match = rest.match(CLAIM_RE);
    if (match) {
      const idx = match.index ?? 0;
      if (idx > 0) out.push(rest.slice(0, idx));
      const sourceKeys = match[1]!
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      for (const sourceKey of sourceKeys) {
        const source = sourceFor(sourceKey);
        if (source) out.push(<CitationChip key={`c${key++}`} source={source} />);
        else out.push(`[[cite:${sourceKey}]]`);
      }
      rest = rest.slice(idx + match[0].length);
    } else {
      out.push(rest);
      break;
    }
  }
  return out;
}

/** Does a string contain any citation marker? */
export function hasMarkers(text: string): boolean {
  return ANY_SPLIT.test(text);
}

/**
 * Margin card for a source, placed in the gutter of the first block that
 * cites it. Hovering or focusing raises the matching inline treatment.
 */
export function MarginCard({ source }: { source: CitationSource }) {
  const ctx = useCitations();
  const locale = ctx?.locale ?? "en-US";
  const key = source.sourceKey;
  const active = ctx?.hovered === key;
  const Glyph = KIND_GLYPH[source.kind];

  return (
    <aside
      role="button"
      tabIndex={0}
      aria-label={`${t(locale, "citations.cardLabel", { n: String(source.ordinal) })} — ${source.label ?? source.sourceKey}`}
      onMouseEnter={() => ctx?.setHovered(key)}
      onMouseLeave={() => ctx?.setHovered(null)}
      onFocus={() => ctx?.setHovered(key)}
      onBlur={() => ctx?.setHovered(null)}
      onClick={() => void ctx?.onCitation?.(source)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          void ctx?.onCitation?.(source);
        }
      }}
      className={cn(
        "rounded-tiny border bg-surface px-2.5 py-2 text-left",
        "transition-colors duration-100 ease-[cubic-bezier(0.23,1,0.32,1)]",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        active ? "border-accent shadow-none" : "border-line",
      )}
    >
      <p className="flex items-center gap-1.5">
        <span
          className={cn(
            "inline-flex h-4 items-center rounded-tiny border px-1 font-mono text-[9.5px] leading-none",
            active
              ? "border-accent bg-accent text-paper"
              : "border-accent/45 bg-accent/8 text-accent",
          )}
        >
          {source.ordinal}
        </span>
        <Glyph aria-hidden="true" className="size-3 text-ink-2" />
        <span className="caps-label truncate text-ink-2">
          {citationKindLabel(source.kind, (k) => t(locale, k))}
        </span>
      </p>
      <p className="mt-1.5 text-[12px] font-medium leading-snug text-ink">
        {source.label ?? source.sourceKey}
      </p>
      {source.meta && <p className="mt-0.5 font-mono text-[10px] text-ink-2">{source.meta}</p>}
      {source.quote ? (
        <blockquote className="mt-1.5 line-clamp-6 border-l-2 border-accent/40 pl-2 font-read text-[12px] italic leading-snug text-ink-2">
          {String(source.quote.text)}
        </blockquote>
      ) : (
        <p className="mt-1.5 text-[11.5px] italic text-ink-2">
          {t(locale, "citations.quoteUnavailable")}
        </p>
      )}
    </aside>
  );
}
