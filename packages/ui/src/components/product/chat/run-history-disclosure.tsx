import type { PublicAiRunDebug } from "@hartlib/shared";
import { ChevronDown } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { uiMessage } from "../../../lib/format";
import { cn } from "../../../lib/utils";
import { RunActivity } from "./run-activity";
import type { AiRunActivityEvent, RunHistorySnapshot, RunStages, TerminalRunStatus } from "./types";

export type RunHistoryLoader = (runId: string) => Promise<PublicAiRunDebug | null>;

const emptyStages = (): RunStages => ({
  understanding: "waiting",
  evidence: "waiting",
  preparing: "waiting",
  writing: "waiting",
  finishing: "waiting",
});

export function runHistorySnapshotFromDebug(debug: PublicAiRunDebug): RunHistorySnapshot | null {
  if (debug.status !== "succeeded" && debug.status !== "failed" && debug.status !== "stopped") {
    return null;
  }
  const stages = emptyStages();
  for (const stage of debug.stages) stages[stage.stage] = stage.status;
  const activities: AiRunActivityEvent[] = debug.history.flatMap((event) => {
    if (event.stage === "terminal" || event.status === "terminal" || event.status === "done") {
      return [];
    }
    return [
      {
        type: "activity",
        stage: event.stage,
        code: event.code as AiRunActivityEvent["code"],
        status: event.status,
        ...(event.topicId === null ? {} : { topicId: event.topicId }),
        ...(event.occurredAt === null ? {} : { occurredAt: event.occurredAt }),
        ...(event.attempt === null ? {} : { attempt: event.attempt }),
        ...(event.durationMs === null ? {} : { durationMs: event.durationMs }),
        ...(event.sourceCount === null ? {} : { sourceCount: event.sourceCount }),
        ...(event.resultCount === null ? {} : { resultCount: event.resultCount }),
        ...(event.errorCode === null ? {} : { errorCode: event.errorCode }),
        ...(event.errorCategory === null ? {} : { errorCategory: event.errorCategory }),
      },
    ];
  });
  return { status: debug.status, stages, activities };
}

function disclosureLabel(locale: string, status: TerminalRunStatus): string {
  if (status === "succeeded") return uiMessage(locale, "run.historyCompleted");
  if (status === "failed") return uiMessage(locale, "run.historyFailed");
  return uiMessage(locale, "run.historyStopped");
}

export interface RunHistoryDisclosureProps {
  readonly runId: string;
  readonly status: TerminalRunStatus;
  readonly snapshot?: RunHistorySnapshot;
  readonly load?: RunHistoryLoader;
  readonly locale?: string;
}

export function RunHistoryDisclosure({
  runId,
  status,
  snapshot,
  load,
  locale = "en-US",
}: RunHistoryDisclosureProps) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<RunHistorySnapshot | null>(snapshot ?? null);
  const [loadState, setLoadState] = useState<
    "idle" | "loading" | "ready" | "unavailable" | "error"
  >(snapshot === undefined ? "idle" : "ready");
  const generation = useRef(0);
  const disclosureId = useId();

  useEffect(() => {
    generation.current += 1;
    setOpen(false);
    setLoaded(snapshot ?? null);
    setLoadState(snapshot === undefined ? "idle" : "ready");
  }, [runId, snapshot]);

  const toggle = () => {
    const nextOpen = !open;
    setOpen(nextOpen);
    if (!nextOpen || loaded !== null || load === undefined || loadState === "loading") return;
    const token = ++generation.current;
    setLoadState("loading");
    void load(runId)
      .then((debug) => {
        if (generation.current !== token) return;
        const next = debug === null ? null : runHistorySnapshotFromDebug(debug);
        setLoaded(next);
        setLoadState(next === null ? "unavailable" : "ready");
      })
      .catch(() => {
        if (generation.current === token) setLoadState("error");
      });
  };

  const attempt = Math.max(
    0,
    ...(loaded?.activities.map((activity) => activity.attempt ?? 0) ?? []),
  );
  return (
    <section
      className={cn(
        "min-w-0 overflow-hidden rounded-tiny border bg-paper",
        status === "failed" ? "border-warn/60" : "border-line",
      )}
      data-testid="run-history-disclosure"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={disclosureId}
        onClick={toggle}
        className="flex min-h-10 w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-paper-deep/50 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
      >
        <span className="flex min-w-0 items-center gap-2 font-mono text-[11px] tracking-wide text-ink-2">
          <span
            aria-hidden="true"
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              status === "succeeded" ? "bg-accent" : status === "failed" ? "bg-danger" : "bg-warn",
            )}
          />
          {disclosureLabel(locale, status)}
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn("size-3.5 shrink-0 text-ink-2 transition-transform", open && "rotate-180")}
        />
      </button>
      {open && (
        <div id={disclosureId} className="border-t border-line">
          {loadState === "loading" && (
            <p role="status" className="p-3 font-mono text-[11px] text-ink-2">
              {uiMessage(locale, "debug.loading")}
            </p>
          )}
          {loadState === "unavailable" && (
            <p className="p-3 text-[12px] text-ink-2">
              {uiMessage(locale, "ui.safeRunDetailsGone")}
            </p>
          )}
          {loadState === "error" && (
            <p className="p-3 text-[12px] text-warn">
              {uiMessage(locale, "ui.safeRunDetailsError")}
            </p>
          )}
          {loaded !== null && (
            <RunActivity
              status={
                loaded.status === "succeeded"
                  ? "complete"
                  : loaded.status === "failed"
                    ? "error"
                    : "stopped"
              }
              stages={loaded.stages}
              attempt={attempt}
              activities={loaded.activities}
              locale={locale}
              className="rounded-none border-0"
              compact
            />
          )}
        </div>
      )}
    </section>
  );
}
