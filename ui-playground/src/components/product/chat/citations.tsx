import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { Bookmark, FileText, Globe, MessagesSquare } from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";
import type { CitedSource, CitationKind } from "@/services/types";
import { HoverCard, HoverCardTrigger, HoverCardContent } from "@/components/ui";
import { useChat } from "./chat-store";

/* Marker syntax in scripted answers:
 *   [[1]]              bare ordinal chip
 *   [[1,2|claim text]]  chips + tinted claim span
 */
export const CLAIM_RE = /\[\[([\d,\s]+)\|([^\]]*)\]\]/;
export const BARE_RE = /\[\[([\d,\s]+)\]\]/;
const ANY_SPLIT = /\[\[(?:[\d,\s]+\|[^\]]*|[\d,\s]+)\]\]/;

interface CitationCtx {
  sources: CitedSource[];
  /** Ordinals → index of the first block citing them (margin-card owner). */
  carded: Map<number, number>;
  /** Hovered/focused citation key (comma-joined ordinals) — syncs chip, claim, card. */
  hovered: string | null;
  setHovered: (key: string | null) => void;
}

const Ctx = createContext<CitationCtx | null>(null);

export function CitationProvider({
  sources,
  children,
  carded,
}: {
  sources: CitedSource[];
  carded: Map<number, number>;
  children: ReactNode;
}) {
  const [hovered, setHovered] = useState<string | null>(null);
  const value = useMemo<CitationCtx>(() => ({ sources, carded, hovered, setHovered }), [sources, carded, hovered]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

function useCitations(): CitationCtx | null {
  return useContext(Ctx);
}

const KIND_GLYPH: Record<CitationKind, typeof FileText> = {
  document: FileText,
  web: Globe,
  memory: Bookmark,
  chat: MessagesSquare,
};

export function citationKindLabel(kind: CitationKind, t: (k: string) => string): string {
  return t(`citations.kind_${kind}`);
}

function CitationDetails({ source }: { source: CitedSource }) {
  const { t } = useI18n();

  return (
    <>
      <p className="caps-label text-accent">
        {citationKindLabel(source.kind, t)} · {source.ordinal}
        {source.meta ? ` · ${source.meta}` : ""}
      </p>
      <p className="mt-1 text-[13px] font-medium leading-snug text-ink">{source.label}</p>
      {source.quote && (
        <blockquote className="mt-2 border-l-2 border-accent/40 pl-2 font-read text-[13px] italic leading-snug text-ink-2">
          {source.quote}
        </blockquote>
      )}
      {!source.quote && <p className="mt-1.5 text-[12px] text-ink-2">{t("citations.quoteUnavailable")}</p>}
      {source.kind === "memory" && <p className="mt-2 font-mono text-[10.5px] text-accent">{t("citations.openMemory")}</p>}
    </>
  );
}

/** Inline ordinal chip. Focusable; hover/focus syncs highlight with its claim + card. */
export function CitationChip({ source, bare = false }: { source: CitedSource; bare?: boolean }) {
  const ctx = useCitations();
  const { t } = useI18n();
  const chat = useChat();
  const Glyph = KIND_GLYPH[source.kind];
  const key = String(source.ordinal);
  const active = ctx?.hovered === key;

  const body = (
    <button
      type="button"
      aria-label={`${t("citations.chipLabel", { n: String(source.ordinal) })} — ${source.label}`}
      onMouseEnter={() => ctx?.setHovered(key)}
      onMouseLeave={() => ctx?.setHovered(null)}
      onFocus={() => ctx?.setHovered(key)}
      onBlur={() => ctx?.setHovered(null)}
      onClick={() => {
        if (source.kind === "memory" && source.memoryId) {
          chat.openMemoryRevision({ id: source.memoryId, revision: source.memoryRevision ?? 1 });
        }
      }}
      className={cn(
        "mx-0.5 inline-flex h-[16px] select-none items-center gap-0.5 rounded-tiny border px-1 align-baseline",
        "font-mono text-[10px] leading-none",
        "transition-colors duration-100 ease-[cubic-bezier(0.23,1,0.32,1)]",
        active ? "border-accent bg-accent text-paper" : "border-accent/45 bg-accent/8 text-accent hover:border-accent",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
      )}
    >
      <span aria-hidden="true">{source.ordinal}</span>
    </button>
  );

  return (
    <HoverCard openDelay={220} closeDelay={140}>
      <HoverCardTrigger asChild>
        <span className="inline">
          {body}
          <span aria-hidden="true" className="ml-0.5 inline-block align-baseline">
            <Glyph className={cn("size-2.5", active ? "text-accent" : "text-ink-3")} />
          </span>
          {bare && <span className="sr-only">{citationKindLabel(source.kind, t)}</span>}
        </span>
      </HoverCardTrigger>
      <HoverCardContent side="top" className="w-72">
        <CitationDetails source={source} />
      </HoverCardContent>
    </HoverCard>
  );
}

/** Tinted claim span; hover/focus raises chip + card alongside it. */
export function ClaimSpan({ cites, children }: { cites: number[]; children: ReactNode }) {
  const ctx = useCitations();
  const key = cites.join(",");
  const active = ctx?.hovered === key;
  const citedSources = ctx
    ? cites.flatMap((ordinal) => {
        const source = ctx.sources.find((candidate) => candidate.ordinal === ordinal);
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
    <HoverCard openDelay={220} closeDelay={140}>
      <HoverCardTrigger asChild>{span}</HoverCardTrigger>
      <HoverCardContent side="top" className="w-72 lg:hidden">
        {citedSources.map((source, index) => (
          <div key={source.ordinal} className={cn(index > 0 && "mt-3 border-t border-line pt-3")}>
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
export function injectCitations(text: string): ReactNode[] {
  const ctx = useCitations();
  const out: ReactNode[] = [];
  let rest = text;
  let key = 0;
  const sourceFor = (ordinal: number): CitedSource | undefined => ctx?.sources.find((s) => s.ordinal === ordinal);

  while (rest.length > 0) {
    const claimMatch = rest.match(CLAIM_RE);
    const bareMatch = rest.match(BARE_RE);
    const useClaim = claimMatch && (!bareMatch || (claimMatch.index ?? 0) <= (bareMatch.index ?? 0));

    if (useClaim && claimMatch) {
      const idx = claimMatch.index ?? 0;
      if (idx > 0) out.push(rest.slice(0, idx));
      const ordinals = claimMatch[1].split(",").map((s) => Number(s.trim())).filter(Boolean);
      for (const ordinal of ordinals) {
        const source = sourceFor(ordinal);
        if (source) out.push(<CitationChip key={`c${key++}`} source={source} />);
      }
      out.push(
        <ClaimSpan key={`s${key++}`} cites={ordinals}>
          {claimMatch[2]}
        </ClaimSpan>,
      );
      rest = rest.slice(idx + claimMatch[0].length);
    } else if (bareMatch) {
      const idx = bareMatch.index ?? 0;
      if (idx > 0) out.push(rest.slice(0, idx));
      const ordinals = bareMatch[1].split(",").map((s) => Number(s.trim())).filter(Boolean);
      for (const ordinal of ordinals) {
        const source = sourceFor(ordinal);
        if (source) out.push(<CitationChip key={`b${key++}`} source={source} bare />);
      }
      rest = rest.slice(idx + bareMatch[0].length);
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
export function MarginCard({ source }: { source: CitedSource }) {
  const { t } = useI18n();
  const ctx = useCitations();
  const key = String(source.ordinal);
  const active = ctx?.hovered === key;
  const Glyph = KIND_GLYPH[source.kind];

  return (
    <aside
      tabIndex={0}
      aria-label={`${t("citations.cardLabel", { n: String(source.ordinal) })} — ${source.label}`}
      onMouseEnter={() => ctx?.setHovered(key)}
      onMouseLeave={() => ctx?.setHovered(null)}
      onFocus={() => ctx?.setHovered(key)}
      onBlur={() => ctx?.setHovered(null)}
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
            active ? "border-accent bg-accent text-paper" : "border-accent/45 bg-accent/8 text-accent",
          )}
        >
          {source.ordinal}
        </span>
        <Glyph aria-hidden="true" className="size-3 text-ink-2" />
        <span className="caps-label truncate text-ink-2">{citationKindLabel(source.kind, t)}</span>
      </p>
      <p className="mt-1.5 text-[12px] font-medium leading-snug text-ink">{source.label}</p>
      {source.meta && <p className="mt-0.5 font-mono text-[10px] text-ink-2">{source.meta}</p>}
      {source.quote ? (
        <blockquote className="mt-1.5 line-clamp-6 border-l-2 border-accent/40 pl-2 font-read text-[12px] italic leading-snug text-ink-2">
          {source.quote}
        </blockquote>
      ) : (
        <p className="mt-1.5 text-[11.5px] italic text-ink-2">{t("citations.quoteUnavailable")}</p>
      )}
    </aside>
  );
}
