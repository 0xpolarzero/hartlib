import { Fragment } from "react";
import { AlertCircle, Check, LoaderCircle, Minus, RefreshCw } from "lucide-react";
import { cn } from "../../../lib/utils";
import { t } from "./localize";
import type { RunStageId, RunStages, StageStatus } from "./types";

const STAGES: RunStageId[] = ["understanding", "evidence", "preparing", "writing", "finishing"];

function StageGlyph({ status }: { status: StageStatus }) {
  switch (status) {
    case "complete":
      return <Check aria-hidden="true" className="size-3" strokeWidth={2.5} />;
    case "failed":
      return <AlertCircle aria-hidden="true" className="size-3" strokeWidth={2.5} />;
    case "skipped":
      return <Minus aria-hidden="true" className="size-3" strokeWidth={2.5} />;
    case "retrying":
      return <RefreshCw aria-hidden="true" className="size-3 animate-spin-slow" />;
    case "running":
      return <LoaderCircle aria-hidden="true" className="size-3 animate-spin" strokeWidth={2} />;
    default:
      return (
        <span
          aria-hidden="true"
          className="block size-2 rounded-full border border-current opacity-50"
        />
      );
  }
}

/**
 * Fixed five-slot run rail shown before the answer while it runs: slots are
 * positionally stable (no reflow), joined by a 1px rule; completed slots
 * fill with the accent. Stage changes are announced by the transcript's
 * live region — this component stays silent (aria-hidden decorative).
 */
export function RunRail({
  stages: state,
  className,
  labels: customLabels,
  locale = "en-US",
  selectedStage,
  selectableStages,
  onSelectStage,
  controlsId,
}: {
  stages?: Partial<RunStages>;
  className?: string;
  labels?: Partial<Record<RunStageId, string>>;
  locale?: string;
  selectedStage?: RunStageId;
  selectableStages?: readonly RunStageId[];
  onSelectStage?: (stage: RunStageId) => void;
  controlsId?: string;
}) {
  const resolved = {
    understanding: "waiting",
    evidence: "waiting",
    preparing: "waiting",
    writing: "waiting",
    finishing: "waiting",
    ...state,
  } as RunStages;
  const interactive = onSelectStage !== undefined;

  return (
    <ol
      className={cn("relative flex select-none items-start", className)}
      aria-hidden={interactive ? undefined : "true"}
    >
      <span aria-hidden="true" className="absolute left-2 right-2 top-[11px] h-px bg-line-2" />
      {STAGES.map((id, i) => {
        const status = resolved[id];
        const done = status === "complete";
        const bad = status === "failed";
        const warn = status === "retrying";
        const selected = selectedStage === id;
        const selectable = selectableStages === undefined || selectableStages.includes(id);
        const content = (
          <>
            <span
              className={cn(
                "relative z-10 flex size-6 items-center justify-center rounded-full border bg-paper",
                "transition-colors duration-100 ease-[cubic-bezier(0.23,1,0.32,1)]",
                done && "border-accent bg-accent text-paper",
                bad && "border-danger text-danger",
                warn && "border-warn text-warn",
                status === "running" && "border-ink text-ink",
                (status === "waiting" || status === "skipped") && "border-line-2 text-ink-3",
                selected && "ring-2 ring-accent/25 ring-offset-2 ring-offset-paper",
              )}
            >
              <StageGlyph status={status} />
            </span>
            <span
              className={cn(
                "text-center font-sans text-[10px] leading-tight tracking-[0.04em] uppercase",
                done && "text-accent",
                bad && "text-danger",
                warn && "text-warn",
                !done && !bad && !warn && "text-ink-2",
                selected && "font-semibold text-ink",
              )}
            >
              {customLabels?.[id] ?? t(locale, `run.stage_${id}`)}
            </span>
          </>
        );

        return (
          <Fragment key={id}>
            {i > 0 && <span aria-hidden="true" className="w-1 shrink-0 sm:w-4" />}
            <li className="relative flex w-[52px] shrink-0 flex-col items-center sm:w-[68px]">
              {interactive ? (
                <button
                  type="button"
                  disabled={!selectable}
                  aria-expanded={selected}
                  aria-controls={controlsId ? `${controlsId}-${id}` : undefined}
                  onClick={() => onSelectStage(id)}
                  className="flex w-full flex-col items-center gap-1.5 rounded-tiny focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-default"
                >
                  {content}
                </button>
              ) : (
                <div className="flex flex-col items-center gap-1.5">{content}</div>
              )}
            </li>
          </Fragment>
        );
      })}
    </ol>
  );
}

/** Compact mono status line shown under the rail. */
export function RunStatusLine({
  status,
  attempt = 0,
  label,
  locale = "en-US",
}: {
  status: string;
  attempt?: number;
  label?: string;
  locale?: string;
}) {
  const text =
    label ??
    (status === "queued"
      ? t(locale, "run.queued")
      : status === "streaming"
        ? t(locale, "run.streaming")
        : status === "error"
          ? t(locale, "run.failedShort", { attempt })
          : t(locale, "run.working"));
  return (
    <p className="font-mono text-[11px] tracking-wide text-ink-2">
      <span
        aria-hidden="true"
        className={cn(
          "mr-1.5 inline-block size-1.5 rounded-full",
          status === "error" ? "bg-danger" : "animate-pulse-soft bg-accent",
        )}
      />
      {text}
    </p>
  );
}
