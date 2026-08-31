import { AlertCircle, Check, Minus, RefreshCw } from "lucide-react";
import type { Messages } from "@hartlib/i18n";
import { cn } from "../../../lib/utils";
import { uiMessage } from "../../../lib/format";
import type { RunStageId, RunStages, StageStatus } from "./types";
const stages: RunStageId[] = ["understanding", "evidence", "preparing", "writing", "finishing"];
const stageMessageIds: Record<
  RunStageId,
  | "chat.progress.stage.understanding"
  | "chat.progress.stage.evidence"
  | "chat.progress.stage.preparing"
  | "chat.progress.stage.writing"
  | "chat.progress.stage.finishing"
> = {
  understanding: "chat.progress.stage.understanding",
  evidence: "chat.progress.stage.evidence",
  preparing: "chat.progress.stage.preparing",
  writing: "chat.progress.stage.writing",
  finishing: "chat.progress.stage.finishing",
};
const statusMessageIds: Record<StageStatus, keyof Messages> = {
  waiting: "chat.progress.status.waiting",
  running: "chat.progress.status.running",
  complete: "chat.progress.status.complete",
  retrying: "chat.progress.status.retrying",
  failed: "chat.progress.status.failed",
  skipped: "chat.progress.status.skipped",
};
function Glyph({ status }: { status: StageStatus }) {
  if (status === "complete") return <Check className="size-3" />;
  if (status === "failed") return <AlertCircle className="size-3" />;
  if (status === "retrying") return <RefreshCw className="size-3 animate-spin-slow" />;
  if (status === "skipped") return <Minus className="size-3" />;
  if (status === "running")
    return (
      <span className="size-2.5 animate-pulse-soft rounded-full border-2 border-current border-t-transparent" />
    );
  return <span className="size-2 rounded-full border border-current opacity-50" />;
}
export function RunRail({
  stages: state,
  className,
  labels: customLabels,
  locale = "en-US",
}: {
  stages?: Partial<RunStages>;
  className?: string;
  labels?: Partial<Record<RunStageId, string>>;
  locale?: string;
}) {
  const resolved = {
    understanding: "waiting",
    evidence: "waiting",
    preparing: "waiting",
    writing: "waiting",
    finishing: "waiting",
    ...state,
  } as RunStages;
  return (
    <ol
      className={cn("relative flex select-none items-start", className)}
      aria-label={uiMessage(locale, "chat.progress.active")}
    >
      {stages.map((stage, index) => (
        <li
          key={stage}
          role="listitem"
          aria-label={`${customLabels?.[stage] ?? uiMessage(locale, stageMessageIds[stage])}: ${uiMessage(locale, statusMessageIds[resolved[stage]])}`}
          className="relative flex min-w-0 flex-1 flex-col items-center gap-1.5"
        >
          {index < stages.length - 1 && (
            <span
              aria-hidden="true"
              className={cn(
                "absolute left-1/2 top-3 h-px w-[calc(100%+1rem)] bg-line-2",
                resolved[stage] === "complete" && "bg-accent",
              )}
            />
          )}
          <span
            className={cn(
              "relative z-10 flex size-6 items-center justify-center rounded-full border bg-paper",
              resolved[stage] === "complete" && "border-accent bg-accent text-paper",
              resolved[stage] === "failed" && "border-danger text-danger",
              resolved[stage] === "retrying" && "border-warn text-warn",
              resolved[stage] === "running" && "border-ink",
              (resolved[stage] === "waiting" || resolved[stage] === "skipped") &&
                "border-line-2 text-ink-3",
            )}
          >
            <Glyph status={resolved[stage]} />
          </span>
          <span
            className={cn(
              "text-center text-[10px] uppercase leading-tight",
              resolved[stage] === "complete" && "text-accent",
              resolved[stage] === "failed" && "text-danger",
              resolved[stage] === "retrying" && "text-warn",
              !["complete", "failed", "retrying"].includes(resolved[stage]) && "text-ink-2",
            )}
          >
            {customLabels?.[stage] ?? uiMessage(locale, stageMessageIds[stage])}
          </span>
        </li>
      ))}
    </ol>
  );
}
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
      ? uiMessage(locale, "chat.runQueued")
      : status === "stopped"
        ? uiMessage(locale, "ui.stopped")
        : status === "failed" || status === "error"
          ? `${uiMessage(locale, "chat.progress.status.failed")}${attempt ? ` · ${uiMessage(locale, "ui.attempt")} ${attempt}` : ""}`
          : status === "succeeded" || status === "done"
            ? uiMessage(locale, "chat.progress.status.complete")
            : uiMessage(locale, "chat.runRunning"));
  return (
    <p role="status" aria-live="polite" className="font-mono text-[11px] text-ink-2">
      <span
        aria-hidden="true"
        className={cn(
          "mr-1.5 inline-block size-1.5 rounded-full",
          status === "failed" || status === "error"
            ? "bg-danger"
            : status === "stopped"
              ? "bg-warn"
              : "animate-pulse-soft bg-accent",
        )}
      />
      {text}
    </p>
  );
}
