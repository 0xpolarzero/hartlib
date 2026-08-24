import { useEffect, useState } from "react";
import { useI18n } from "@/i18n";
import { api } from "@/services";
import type { RunProjection, StageEvent } from "@/services/types";
import { formatDateTime, formatTime } from "@/lib/format";
import { Badge, Sheet, SheetContent, SheetHeader, SheetTitle, SheetBody } from "@/components/ui";

const STATUS_TONE: Record<StageEvent["status"], string> = {
  waiting: "outline",
  running: "accent",
  complete: "success",
  retrying: "warning",
  failed: "danger",
  skipped: "neutral",
};

/** Lazy chunk: normalized run projection for the owner debug drawer. */
export default function DebugSheet({ runId, onClose }: { runId: string; onClose: () => void }) {
  const { locale, t } = useI18n();
  const [projection, setProjection] = useState<RunProjection | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .getRunProjection(runId)
      .then((p) => alive && setProjection(p))
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
    };
  }, [runId]);

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-[min(94vw,27rem)]">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2 font-display text-[16px] font-medium">
            {t("debug.title")}
            <Badge tone="warning">{t("debug.internal")}</Badge>
          </SheetTitle>
        </SheetHeader>
        <SheetBody>
          {!projection && !error && <p className="font-mono text-[12px] text-ink-2">{t("debug.loading")}</p>}
          {error && <p className="text-[13px] text-danger">{t("debug.error")}</p>}
          {projection && (
            <div className="grid gap-5 pb-6">
              <section>
                <h3 className="caps-label mb-1.5 text-ink-2">{t("debug.meta")}</h3>
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-[11px]">
                  <dt className="text-ink-2">run</dt>
                  <dd className="truncate text-ink">{projection.runId}</dd>
                  <dt className="text-ink-2">chat</dt>
                  <dd className="text-ink">{projection.chatId}</dd>
                  <dt className="text-ink-2">started</dt>
                  <dd className="text-ink">{formatDateTime(locale, projection.startedAt)}</dd>
                  <dt className="text-ink-2">ended</dt>
                  <dd className="text-ink">{projection.endedAt ? formatDateTime(locale, projection.endedAt) : "—"}</dd>
                  <dt className="text-ink-2">attempt</dt>
                  <dd className="text-ink">{projection.attempt}</dd>
                </dl>
              </section>

              <section>
                <h3 className="caps-label mb-1.5 text-ink-2">{t("debug.stages")}</h3>
                <ol className="border-t border-line">
                  {projection.stages.map((stage, i) => (
                    <li key={i} className="flex items-center gap-2 border-b border-line py-1.5">
                      <span className="w-24 font-mono text-[11px] text-ink">{t(`run.stage_${stage.id}`)}</span>
                      <Badge tone={STATUS_TONE[stage.status] as "neutral"}>{stage.status}</Badge>
                      <span className="ml-auto font-mono text-[10.5px] text-ink-2">{formatTime(locale, stage.at)}</span>
                    </li>
                  ))}
                </ol>
              </section>

              <section>
                <h3 className="caps-label mb-1.5 text-ink-2">{t("debug.usage")}</h3>
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-[11px]">
                  <dt className="text-ink-2">prompt</dt>
                  <dd className="text-ink">{projection.tokenUsage.prompt} tok</dd>
                  <dt className="text-ink-2">completion</dt>
                  <dd className="text-ink">{projection.tokenUsage.completion} tok</dd>
                  <dt className="text-ink-2">total</dt>
                  <dd className="text-ink">{projection.tokenUsage.total} tok</dd>
                  <dt className="text-ink-2">{t("debug.sourcesRead")}</dt>
                  <dd className="text-ink">{projection.sourcesRead}</dd>
                  <dt className="text-ink-2">{t("debug.sourcesCited")}</dt>
                  <dd className="text-ink">{projection.sourcesCited}</dd>
                </dl>
              </section>

              {projection.failure && (
                <section>
                  <h3 className="caps-label mb-1.5 text-danger">{t("debug.failure")}</h3>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-[11px]">
                    <dt className="text-ink-2">code</dt>
                    <dd className="text-danger">{projection.failure.code}</dd>
                    <dt className="text-ink-2">retryable</dt>
                    <dd className="text-ink">{String(projection.failure.retryable)}</dd>
                  </dl>
                </section>
              )}
            </div>
          )}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}
