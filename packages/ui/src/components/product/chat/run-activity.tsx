import { cn } from "../../../lib/utils";
import { RunRail, RunStatusLine } from "./run-rail";
import { t } from "./localize";
import type { RunStages } from "./types";

export type RunActivityTone = "done" | "active" | "waiting" | "warning";

export interface RunActivitySource {
  title: string;
  meta?: string;
  status?: string;
}

export interface RunActivityEvent {
  label: string;
  detail?: string;
  tone: RunActivityTone;
  queries?: readonly string[];
  sources?: readonly RunActivitySource[];
}

export interface RunActivityProps {
  status: string;
  stages?: Partial<RunStages>;
  attempt?: number;
  title?: string;
  meta?: string;
  current?: string;
  events?: readonly RunActivityEvent[];
  defaultExpanded?: boolean;
  locale?: string;
  className?: string;
  compact?: boolean;
}

const toneClass: Record<RunActivityTone, string> = {
  done: "border-accent bg-accent",
  active: "border-ink bg-paper shadow-[inset_0_0_0_2px_var(--color-accent)]",
  waiting: "border-line-2 bg-paper",
  warning: "border-warn bg-warn",
};

function QueryList({ items }: { items: readonly string[] }) {
  return (
    <ul className="mt-2 grid gap-1.5">
      {items.map((query) => (
        <li
          key={query}
          className="overflow-x-auto rounded-tiny border border-line bg-paper-deep px-2.5 py-2 font-mono text-[10px] leading-relaxed text-ink"
        >
          {query}
        </li>
      ))}
    </ul>
  );
}

function SourceList({ items }: { items: readonly RunActivitySource[] }) {
  return (
    <ul className="mt-2 divide-y divide-line border-y border-line">
      {items.map((source) => (
        <li key={source.title} className="grid grid-cols-[1fr_auto] gap-3 py-2">
          <div className="min-w-0">
            <p className="truncate text-[12px] font-medium text-ink">{source.title}</p>
            {source.meta && (
              <p className="truncate font-mono text-[9px] text-ink-3">{source.meta}</p>
            )}
          </div>
          {source.status && (
            <span
              className={cn(
                "self-center font-mono text-[9px] uppercase",
                source.status === "Reading" ? "text-accent" : "text-ink-3",
              )}
            >
              {source.status}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * Production run progress. The fixed stage rail stays scannable while optional
 * activity events expose the queries, sources, retries, and other concrete work.
 */
export function RunActivity({
  status,
  stages,
  attempt = 0,
  title,
  meta,
  current,
  events = [],
  defaultExpanded = false,
  locale = "en-US",
  className,
  compact = false,
}: RunActivityProps) {
  const failed = status === "failed" || status === "error";
  const shortLabels = {
    understanding: t(locale, "run.stageShort_understanding"),
    evidence: t(locale, "run.stageShort_evidence"),
    preparing: t(locale, "run.stageShort_preparing"),
    writing: t(locale, "run.stageShort_writing"),
    finishing: t(locale, "run.stageShort_finishing"),
  };

  return (
    <section
      className={cn(
        "min-w-0 max-w-full rounded-tiny border bg-paper",
        failed ? "border-warn/60" : "border-line",
        compact ? "p-3" : "p-4 sm:p-5",
        className,
      )}
      aria-label={title ? `${title} activity` : undefined}
    >
      <header className="flex items-start justify-between gap-3">
        <RunStatusLine
          status={status}
          attempt={attempt}
          locale={locale}
          {...(title ? { label: title } : {})}
        />
        {meta && <p className="font-mono text-[10px] text-ink-3">{meta}</p>}
      </header>

      <div className="min-w-0 max-w-full overflow-x-auto pb-1">
        <RunRail
          className={compact ? "mt-3" : "mt-4"}
          locale={locale}
          labels={shortLabels}
          {...(stages === undefined ? {} : { stages })}
        />
      </div>

      {current && <p className="mt-3 text-[12px] leading-relaxed text-ink-2">{current}</p>}

      {events.length > 0 && (
        <details className="group mt-3" open={defaultExpanded || undefined}>
          <summary className="w-fit cursor-pointer list-none rounded-tiny font-mono text-[10px] text-accent underline decoration-dotted underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden">
            <span className="group-open:hidden">Show work</span>
            <span className="hidden group-open:inline">Hide work</span>
          </summary>
          <ol className="mt-3 grid gap-3 border-l border-line pl-3">
            {events.map((event, index) => (
              <li key={`${event.label}-${index}`} className="relative">
                <span
                  aria-hidden="true"
                  className={cn(
                    "absolute -left-[16.5px] top-1 size-1.5 rounded-full border",
                    toneClass[event.tone],
                  )}
                />
                <p className="font-mono text-[10px] font-medium tracking-wide text-ink uppercase">
                  {event.label}
                </p>
                {event.detail && (
                  <p className="mt-0.5 text-[11px] leading-relaxed text-ink-2">{event.detail}</p>
                )}
                {event.queries && <QueryList items={event.queries} />}
                {event.sources && <SourceList items={event.sources} />}
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}
