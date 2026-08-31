import { useId, useState } from "react";
import { Bookmark, ChevronDown, FileText, Globe, MessagesSquare } from "lucide-react";
import { cn } from "../../../lib/utils";
import { uiMessage } from "../../../lib/format";
import type { CitationKind, PublicCitationRecord, PublicSourceRecord } from "./types";
const glyphs: Record<CitationKind, typeof FileText> = {
  document: FileText,
  web: Globe,
  memory: Bookmark,
  chat_message: MessagesSquare,
};
export interface SourcesDisclosureProps {
  sources?: readonly PublicSourceRecord[];
  citations?: readonly PublicCitationRecord[];
  citedSourceKeys?: readonly string[];
  answerId?: string;
  label?: string;
  defaultOpen?: boolean;
  locale?: string;
  onCitation?: (citation: PublicCitationRecord) => void | Promise<void>;
}
export function SourcesDisclosure({
  sources = [],
  citations = [],
  citedSourceKeys,
  answerId,
  label = "Sources read",
  defaultOpen = false,
  locale = "en-US",
  onCitation,
}: SourcesDisclosureProps) {
  const resolvedLabel = label === "Sources read" ? uiMessage(locale, "ui.sourcesRead") : label;
  const [open, setOpen] = useState(defaultOpen);
  const generatedId = useId();
  const ordinalByKey = new Map<string, number>();
  citations.forEach((citation, index) => ordinalByKey.set(citation.sourceKey, index + 1));
  citedSourceKeys?.forEach((key) => {
    if (!ordinalByKey.has(key)) ordinalByKey.set(key, ordinalByKey.size + 1);
  });
  const disclosureId = `sources-${answerId ?? generatedId}`;
  if (sources.length === 0)
    return (
      <div className="border-t border-line pt-2">
        <p className="font-mono text-[11px] text-ink-2">{resolvedLabel} (0)</p>
        <p className="mt-1 text-[12px] text-ink-2">{uiMessage(locale, "ui.noSourcesRead")}</p>
      </div>
    );
  return (
    <div className="border-t border-line pt-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={disclosureId}
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-7 items-center gap-1.5 font-mono text-[11px] text-ink-2 hover:text-ink"
      >
        <ChevronDown
          className={cn("size-3 transition-transform", open && "rotate-180")}
          aria-hidden="true"
        />
        {resolvedLabel} ({sources.length})
      </button>
      {open && (
        <ol id={disclosureId} className="mt-1.5 grid animate-enter-fade">
          {sources.map((source, index) => {
            const Glyph = glyphs[source.kind];
            const ordinal = ordinalByKey.get(source.sourceKey);
            const citation = citations.find((item) => item.sourceKey === source.sourceKey);
            const quote = source.kind === "web" ? source.quote : (citation?.quote?.text ?? null);
            return (
              <li
                key={`${source.sourceKey}-${index}`}
                className={cn(
                  "flex items-start gap-2.5 border-b border-line py-2 last:border-b-0",
                  ordinal ? "" : "opacity-80",
                )}
              >
                <span className="mt-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-tiny border border-accent/45 bg-accent/8 px-1 font-mono text-[9.5px] text-accent">
                  {ordinal ?? "·"}
                </span>
                <Glyph className="mt-0.5 size-3.5 shrink-0 text-ink-2" aria-hidden="true" />
                <div className="min-w-0">
                  <p className="text-[12.5px] font-medium">
                    {citation && onCitation ? (
                      <button
                        type="button"
                        className="text-left underline decoration-dotted underline-offset-2"
                        onClick={() => void onCitation(citation)}
                      >
                        {source.label ?? source.sourceKey}
                      </button>
                    ) : (
                      (source.label ?? source.sourceKey)
                    )}
                    {ordinal === undefined && (
                      <span className="ml-1.5 text-[11px] italic text-ink-2">
                        — {uiMessage(locale, "ui.notCited")}
                      </span>
                    )}
                  </p>
                  {quote ? (
                    <blockquote className="mt-1 border-l-2 border-line-2 pl-2 font-read text-[12.5px] italic text-ink-2">
                      {quote}
                    </blockquote>
                  ) : (
                    <p className="mt-0.5 text-[11.5px] italic text-ink-2">
                      {uiMessage(locale, "ui.quoteUnavailable")}
                    </p>
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
