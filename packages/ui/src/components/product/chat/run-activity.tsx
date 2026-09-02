import { useEffect, useId, useMemo, useState } from "react";
import { cn } from "../../../lib/utils";
import { RunRail, RunStatusLine } from "./run-rail";
import { t } from "./localize";
import type { AiRunActivityEvent, PublicSourceRecord, RunStageId, RunStages } from "./types";

export interface RunActivityProps {
  status: string;
  stages?: Partial<RunStages>;
  attempt?: number;
  activities?: readonly AiRunActivityEvent[];
  sourcesRead?: readonly PublicSourceRecord[];
  locale?: string;
  className?: string;
  compact?: boolean;
}

const STAGE_ORDER: readonly RunStageId[] = [
  "understanding",
  "evidence",
  "preparing",
  "writing",
  "finishing",
];

function activeStageFor(
  stages: Partial<RunStages> | undefined,
  status: string,
  activities: readonly AiRunActivityEvent[],
): RunStageId {
  const active = STAGE_ORDER.find((stage) => {
    const stageStatus = stages?.[stage];
    return stageStatus === "running" || stageStatus === "retrying" || stageStatus === "failed";
  });
  if (active) return active;
  if (status === "succeeded" || status === "complete") return "finishing";
  for (let index = STAGE_ORDER.length - 1; index >= 0; index -= 1) {
    const stage = STAGE_ORDER[index]!;
    if (activities.some((event) => event.stage === stage)) return stage;
  }
  return "understanding";
}

function eventKey(event: AiRunActivityEvent): string {
  const detailKey = event.detail ? `${event.detail.kind}:${event.detail.ordinal}` : "phase";
  return `${event.topicId ?? "run"}:${event.code}:${detailKey}`;
}

function latestEvents(activities: readonly AiRunActivityEvent[]): readonly AiRunActivityEvent[] {
  const byKey = new Map<string, AiRunActivityEvent>();
  for (const activity of activities) byKey.set(eventKey(activity), activity);
  return [...byKey.values()];
}

function eventTone(status: AiRunActivityEvent["status"]): string {
  if (status === "complete") return "border-accent bg-accent";
  if (status === "running") {
    return "border-ink bg-paper shadow-[inset_0_0_0_2px_var(--color-accent)]";
  }
  if (status === "retrying" || status === "failed") return "border-warn bg-warn";
  return "border-line-2 bg-paper";
}

function eventMeta(locale: string, event: AiRunActivityEvent): readonly string[] {
  return [
    event.attempt !== undefined && event.attempt > 1
      ? t(locale, "run.activityAttempt", { count: event.attempt })
      : null,
    event.sourceCount !== undefined
      ? t(locale, "run.activitySources", { count: event.sourceCount })
      : null,
    event.resultCount !== undefined
      ? t(locale, "run.activityResults", { count: event.resultCount })
      : null,
    event.durationMs !== undefined
      ? t(locale, "run.activityDuration", { count: event.durationMs })
      : null,
    event.occurredAt ?? null,
    event.errorCategory ?? null,
    event.errorCode ?? null,
  ].filter((item): item is string => item !== null);
}

function Detail({ event, locale }: { event: AiRunActivityEvent; locale: string }) {
  const detail = event.detail;
  if (!detail) return null;

  if (detail.kind === "internal_queries") {
    return (
      <div className="mt-2 grid gap-1.5">
        <p className="font-mono text-[9px] tracking-wide text-ink-3 uppercase">
          {t(
            locale,
            detail.plan === "initial" ? "run.activityPlanInitial" : "run.activityPlanFinal",
          )}
          {` · ${detail.action}`}
        </p>
        {detail.queries.map((query, index) => (
          <pre
            key={`${query.purpose}-${index}`}
            className="block max-w-full overflow-x-auto whitespace-pre rounded-tiny border border-line bg-paper-deep px-2.5 py-2 font-mono text-[10px] leading-relaxed text-ink"
          >
            {JSON.stringify(query)}
          </pre>
        ))}
      </div>
    );
  }

  if (detail.kind === "web_search") {
    return (
      <div className="mt-2">
        <code className="block overflow-x-auto rounded-tiny border border-line bg-paper-deep px-2.5 py-2 font-mono text-[10px] leading-relaxed text-ink">
          {detail.query}
        </code>
        {(detail.cursor !== undefined || detail.resultCount !== undefined) && (
          <p className="mt-1 font-mono text-[9px] text-ink-3">
            {[
              detail.resultCount === undefined
                ? null
                : t(locale, "run.activityResults", { count: detail.resultCount }),
              detail.cursor === undefined ? null : `cursor ${detail.cursor}`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        )}
      </div>
    );
  }

  if (detail.kind === "web_fetch") {
    return (
      <div className="mt-1.5 min-w-0">
        <a
          className="block truncate text-[11px] font-medium text-ink underline decoration-dotted underline-offset-2"
          href={detail.url}
          target="_blank"
          rel="noreferrer"
        >
          {detail.title ?? detail.url}
        </a>
        <p className="truncate font-mono text-[9px] text-ink-3">
          {[detail.domain, detail.capturedAt].filter(Boolean).join(" · ")}
        </p>
      </div>
    );
  }

  if (detail.kind === "source_search") {
    return (
      <div className="mt-1.5 min-w-0">
        {detail.query && (
          <code className="block overflow-x-auto rounded-tiny border border-line bg-paper-deep px-2.5 py-2 font-mono text-[10px] leading-relaxed text-ink">
            {detail.query}
          </code>
        )}
        <p className="mt-1 truncate font-mono text-[9px] text-ink-3">
          {[
            detail.candidateId,
            detail.resultCount === undefined
              ? null
              : t(locale, "run.activityResults", { count: detail.resultCount }),
            detail.cursor === undefined ? null : `cursor ${detail.cursor}`,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </div>
    );
  }

  return (
    <p className="mt-1 font-mono text-[9px] text-ink-3">
      {detail.candidateId} · {t(locale, "run.activityPassages", { count: detail.passageCount })}
    </p>
  );
}

function sourceLabel(locale: string, source: PublicSourceRecord): string {
  if (source.kind === "web") return source.title;
  if (source.kind === "document") return source.documentTitle;
  if (source.kind === "chat_message") return source.label ?? t(locale, "run.activityChatMessage");
  return source.label ?? t(locale, "run.activityMemory");
}

function sourceMeta(source: PublicSourceRecord): string {
  if (source.kind === "web") return source.domain;
  if (source.kind === "document") return source.sourceName ?? source.issueTitle ?? source.url;
  if (source.kind === "chat_message") return source.messageId;
  return source.memoryId;
}

function Sources({ locale, sources }: { locale: string; sources: readonly PublicSourceRecord[] }) {
  if (sources.length === 0) return null;
  return (
    <li className="relative">
      <span
        aria-hidden="true"
        className="absolute -left-[16.5px] top-1 size-1.5 rounded-full border border-accent bg-accent"
      />
      <p className="font-mono text-[10px] font-medium tracking-wide text-ink uppercase">
        {t(locale, "run.activitySourcesRead")}
      </p>
      <ul className="mt-2 divide-y divide-line border-y border-line">
        {sources.map((source, index) => (
          <li key={`${source.sourceKey}-${index}`} className="min-w-0 py-2">
            <p className="truncate text-[12px] font-medium text-ink">
              {sourceLabel(locale, source)}
            </p>
            <p className="truncate font-mono text-[9px] text-ink-3">{sourceMeta(source)}</p>
          </li>
        ))}
      </ul>
    </li>
  );
}

/** Renders only strict activity records and source identities emitted by the run. */
export function RunActivity({
  status,
  stages,
  attempt = 0,
  activities = [],
  sourcesRead = [],
  locale = "en-US",
  className,
  compact = false,
}: RunActivityProps) {
  const events = useMemo(() => latestEvents(activities), [activities]);
  const failed = status === "failed" || status === "error";
  const activeStage = activeStageFor(stages, status, events);
  const [selectedStage, setSelectedStage] = useState<RunStageId>(activeStage);
  const activityId = useId();
  const shortLabels = {
    understanding: t(locale, "run.stageShort_understanding"),
    evidence: t(locale, "run.stageShort_evidence"),
    preparing: t(locale, "run.stageShort_preparing"),
    writing: t(locale, "run.stageShort_writing"),
    finishing: t(locale, "run.stageShort_finishing"),
  };
  const selectableStages = STAGE_ORDER.filter(
    (stage) =>
      events.some((event) => event.stage === stage) ||
      (stage === "evidence" && sourcesRead.length > 0),
  );
  const selectedEvents = events.filter((event) => event.stage === selectedStage);
  const selectedSources = selectedStage === "evidence" ? sourcesRead : [];

  useEffect(() => {
    setSelectedStage(activeStage);
  }, [activeStage]);

  return (
    <section
      className={cn(
        "min-w-0 max-w-full rounded-tiny border bg-paper",
        failed ? "border-warn/60" : "border-line",
        compact ? "p-3" : "p-4 sm:p-5",
        className,
      )}
      aria-label={t(locale, "run.activityLabel")}
    >
      <RunStatusLine
        status={status}
        attempt={attempt}
        locale={locale}
        {...(events.length === 0 ? {} : { label: shortLabels[activeStage] })}
      />

      <div className="min-w-0 max-w-full overflow-x-auto pb-1">
        <RunRail
          className={compact ? "mt-3" : "mt-4"}
          locale={locale}
          labels={shortLabels}
          {...(stages === undefined ? {} : { stages })}
          {...(selectableStages.length === 0
            ? {}
            : {
                selectedStage,
                selectableStages,
                onSelectStage: setSelectedStage,
                controlsId: activityId,
              })}
        />
      </div>

      {(selectedEvents.length > 0 || selectedSources.length > 0) && (
        <div
          id={`${activityId}-${selectedStage}`}
          role="region"
          aria-label={shortLabels[selectedStage]}
          className="mt-3 border-t border-line pt-3"
        >
          <ol className="grid gap-3 border-l border-line pl-3">
            {selectedEvents.map((event) => {
              const meta = eventMeta(locale, event);
              return (
                <li key={eventKey(event)} className="relative">
                  <span
                    aria-hidden="true"
                    className={cn(
                      "absolute -left-[16.5px] top-1 size-1.5 rounded-full border",
                      eventTone(event.status),
                    )}
                  />
                  <p className="font-mono text-[10px] font-medium tracking-wide text-ink uppercase">
                    {t(locale, `run.activityCode_${event.code}`)}
                  </p>
                  {meta.length > 0 && (
                    <p className="mt-0.5 break-words font-mono text-[9px] leading-relaxed text-ink-3">
                      {meta.join(" · ")}
                    </p>
                  )}
                  {event.errorMessage && (
                    <p className="mt-1 text-[11px] leading-relaxed text-warn">
                      {event.errorMessage}
                    </p>
                  )}
                  <Detail event={event} locale={locale} />
                </li>
              );
            })}
            <Sources locale={locale} sources={selectedSources} />
          </ol>
        </div>
      )}
    </section>
  );
}
