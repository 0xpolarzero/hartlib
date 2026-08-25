import { useState } from "react";
import { ChevronDown, FileText, Globe, Bookmark, MessagesSquare } from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";
import type { CitedSource, CitationKind } from "@/services/types";

const KIND_GLYPH: Record<CitationKind, typeof FileText> = {
  document: FileText,
  web: Globe,
  memory: Bookmark,
  chat: MessagesSquare,
};

/**
 * “Sources read” disclosure per answer: closed by default, opens to the
 * list in server order. Cited sources carry ordinals + a supporting quote;
 * read-but-uncited sources are marked distinctly; missing quotes show one
 * generic state.
 */
export function SourcesDisclosure({ sources }: { sources: CitedSource[] }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const cited = sources.filter((s) => s.ordinal > 0);
  const panelId = `sources-${sources.length}-${sources[0]?.label.length ?? 0}`;

  return (
    <div className="border-t border-line pt-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-7 items-center gap-1.5 font-mono text-[11px] tracking-wide text-ink-2 transition-colors duration-100 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <ChevronDown aria-hidden="true" className={cn("size-3 transition-transform duration-100", open && "rotate-180")} />
        {t("chat.sourcesRead", { n: String(sources.length), cited: String(cited.length) })}
      </button>
      {open && (
        <ol id={panelId} className="mt-1.5 grid animate-enter-fade gap-0">
          {sources.map((source, i) => {
            const Glyph = KIND_GLYPH[source.kind];
            const isUncited = source.ordinal === 0;
            return (
              <li
                key={`${source.label}-${i}`}
                className={cn(
                  "flex items-start gap-2.5 border-b border-line py-2 last:border-b-0",
                  isUncited && "opacity-80",
                )}
              >
                {isUncited ? (
                  <span
                    aria-hidden="true"
                    className="mt-1 size-2 shrink-0 rounded-full border border-ink-3"
                    title={t("citations.readNotCited")}
                  />
                ) : (
                  <span className="mt-0.5 inline-flex h-4 shrink-0 items-center rounded-tiny border border-accent/45 bg-accent/8 px-1 font-mono text-[9.5px] leading-none text-accent">
                    {source.ordinal}
                  </span>
                )}
                <Glyph aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-ink-2" />
                <div className="min-w-0">
                  <p className="text-[12.5px] font-medium leading-snug text-ink">
                    {source.label}
                    {source.meta && <span className="ml-1.5 font-mono text-[10.5px] font-normal text-ink-2">{source.meta}</span>}
                    {isUncited && (
                      <span className="ml-1.5 font-sans text-[11px] font-normal italic text-ink-2">
                        — {t("citations.readNotCited")}
                      </span>
                    )}
                  </p>
                  {source.quote ? (
                    <blockquote className="mt-1 line-clamp-3 border-l-2 border-line-2 pl-2 font-read text-[12.5px] italic leading-snug text-ink-2">
                      {source.quote}
                    </blockquote>
                  ) : (
                    <p className="mt-0.5 text-[11.5px] italic text-ink-2">{t("citations.quoteUnavailable")}</p>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
