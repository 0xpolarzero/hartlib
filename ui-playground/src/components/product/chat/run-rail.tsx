import { Fragment } from "react";
import { AlertCircle, Check, Minus, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";
import type { RunStageId, StageStatus } from "@/services/types";

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
      return (
        <span aria-hidden="true" className="block size-2.5 animate-pulse-soft rounded-full border-[2px] border-current border-t-transparent" />
      );
    default:
      return <span aria-hidden="true" className="block size-2 rounded-full border border-current opacity-50" />;
  }
}

/**
 * Fixed five-slot run rail shown before the answer while it runs: slots are
 * positionally stable (no reflow), joined by a 1px rule; completed slots
 * fill with the accent. Stage changes are announced by the store's live
 * region — this component stays silent (aria-hidden decorative; text is
 * duplicated accessibly through announcements).
 */
export function RunRail({
  stages,
  className,
}: {
  stages: Record<RunStageId, StageStatus>;
  className?: string;
}) {
  const { t } = useI18n();
  return (
    <ol className={cn("relative flex select-none items-start", className)} aria-hidden="true">
      {/* Connecting hairline */}
      <span aria-hidden="true" className="absolute left-2 right-2 top-[11px] h-px bg-line-2" />
      {STAGES.map((id, i) => {
        const status = stages[id];
        const done = status === "complete";
        const bad = status === "failed";
        const warn = status === "retrying";
        return (
          <Fragment key={id}>
            {i > 0 && <span aria-hidden="true" className="w-4 shrink-0" />}
            <li className="relative flex w-[68px] shrink-0 flex-col items-center gap-1.5">
              <span
                className={cn(
                  "relative z-10 flex size-6 items-center justify-center rounded-full border bg-paper",
                  "transition-colors duration-100 ease-[cubic-bezier(0.23,1,0.32,1)]",
                  done && "border-accent bg-accent text-paper",
                  bad && "border-danger text-danger",
                  warn && "border-warn text-warn",
                  status === "running" && "border-ink text-ink",
                  (status === "waiting" || status === "skipped") && "border-line-2 text-ink-3",
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
                )}
              >
                {t(`run.stage_${id}`)}
              </span>
            </li>
          </Fragment>
        );
      })}
    </ol>
  );
}

/** Compact mono status line shown under the rail. */
export function RunStatusLine({ status, attempt }: { status: string; attempt: number }) {
  const { t } = useI18n();
  const label =
    status === "queued"
      ? t("run.queued")
      : status === "streaming"
        ? t("run.streaming")
        : status === "error"
          ? t("run.failedShort", { attempt: String(attempt) })
          : t("run.working");
  return (
    <p className="font-mono text-[11px] tracking-wide text-ink-2">
      <span
        aria-hidden="true"
        className={cn("mr-1.5 inline-block size-1.5 rounded-full", status === "error" ? "bg-danger" : "animate-pulse-soft bg-accent")}
      />
      {label}
    </p>
  );
}
