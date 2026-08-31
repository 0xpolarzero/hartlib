import { useEffect, useRef, useState, type ReactNode } from "react";
import { Bug, X } from "lucide-react";
import { Button } from "../../ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../ui/dialog";
import { ErrorState } from "../../ui/states";
import { uiMessage } from "../../../lib/format";
import type { PublicAiRunDebug } from "@hartlib/shared";
export type DebugLoadState =
  | "idle"
  | "loading"
  | "ready"
  | "denied"
  | "error"
  | "retention-unavailable"
  | "stopped";
export interface DebugDrawerProps {
  runId?: string | null;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  data?: PublicAiRunDebug | null;
  state?: DebugLoadState;
  load?: (runId: string) => Promise<PublicAiRunDebug | null>;
  onRetry?: () => void;
  onClose?: () => void;
  triggerLabel?: string;
  children?: ReactNode;
  locale?: string;
}
export function createDebugLoadFence() {
  let generation = 0;
  return {
    begin: () => ++generation,
    isCurrent: (token: number, open: boolean) => open && token === generation,
  };
}
export function DebugDrawer({
  runId,
  open: controlledOpen,
  onOpenChange,
  data,
  state = "idle",
  load,
  onRetry,
  onClose,
  triggerLabel = "Show diagnostics",
  children,
  locale = "en-US",
}: DebugDrawerProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = (value: boolean) => {
    if (controlledOpen === undefined) setInternalOpen(value);
    onOpenChange?.(value);
  };
  const [loaded, setLoaded] = useState<PublicAiRunDebug | null>(data ?? null);
  const [loadState, setLoadState] = useState(state);
  const [loadNonce, setLoadNonce] = useState(0);
  const loadFence = useRef(createDebugLoadFence());
  useEffect(() => {
    loadFence.current.begin();
    setLoaded(data ?? null);
    setLoadState(state);
    setLoadNonce((value) => value + 1);
  }, [data, runId, state]);
  useEffect(() => {
    if (!open || !runId || !load || loaded) return;
    const generation = loadFence.current.begin();
    setLoadState("loading");
    void load(runId)
      .then((value) => {
        if (!loadFence.current.isCurrent(generation, open)) return;
        if (value === null) {
          setLoaded(null);
          setLoadState("retention-unavailable");
        } else {
          setLoaded(value);
          setLoadState("ready");
        }
      })
      .catch((error: unknown) => {
        if (!loadFence.current.isCurrent(generation, open)) return;
        const failure = error as { readonly status?: unknown; readonly code?: unknown };
        if (failure.status === 404 || failure.code === "not_found") setLoadState("denied");
        else if (failure.status === 410 || failure.code === "terminal_event_unavailable")
          setLoadState("retention-unavailable");
        else setLoadState("error");
      });
    return () => {
      if (loadFence.current.isCurrent(generation, true)) loadFence.current.begin();
    };
  }, [load, loaded, loadNonce, open, runId]);
  const close = () => {
    setOpen(false);
    onClose?.();
  };
  const resolvedTriggerLabel =
    triggerLabel === "Show diagnostics" ? uiMessage(locale, "ui.showDiagnostics") : triggerLabel;
  const trigger =
    controlledOpen === undefined &&
    ((runId !== null && runId !== undefined) || (data !== null && data !== undefined)) ? (
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={resolvedTriggerLabel}
        title={resolvedTriggerLabel}
        onClick={() => setOpen(true)}
      >
        <Bug className="size-3" />
      </Button>
    ) : null;
  return (
    <>
      {trigger}
      <Dialog
        locale={locale}
        open={open}
        onOpenChange={(value) => (value ? setOpen(true) : close())}
      >
        <DialogContent className="w-[min(94vw,36rem)] p-0">
          <DialogHeader>
            <DialogTitle>{uiMessage(locale, "ui.debugDetails")}</DialogTitle>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={uiMessage(locale, "ui.close")}
              onClick={close}
            >
              <X className="size-3.5" />
            </Button>
          </DialogHeader>
          <div className="max-h-[65vh] overflow-y-auto px-4 py-3">
            {loadState === "loading" && (
              <p role="status" className="text-[13px] text-ink-2">
                {uiMessage(locale, "ui.loadingSafeRunDetails")}
              </p>
            )}
            {loadState === "denied" && (
              <ErrorState
                title={uiMessage(locale, "ui.debugDetailsUnavailable")}
                description={uiMessage(locale, "ui.debugAccessDenied")}
              />
            )}
            {loadState === "retention-unavailable" && (
              <ErrorState title={uiMessage(locale, "ui.safeRunDetailsGone")} />
            )}
            {loadState === "error" && (
              <ErrorState
                title={uiMessage(locale, "ui.safeRunDetailsError")}
                onRetry={
                  onRetry ??
                  (() => {
                    setLoaded(null);
                    setLoadState("idle");
                    setLoadNonce((value) => value + 1);
                  })
                }
                retryLabel={uiMessage(locale, "ui.tryAgain")}
              />
            )}
            {loadState === "stopped" && (
              <p role="status" className="text-[13px] text-ink-2">
                {uiMessage(locale, "ui.thisRunStopped")}
              </p>
            )}
            {(loadState === "ready" || (loadState === "idle" && loaded)) && loaded && (
              <dl className="grid gap-1 text-[13px]">
                {Object.entries(loaded)
                  .filter(([key]) => key !== "events")
                  .map(([key, value]) => (
                    <div
                      key={key}
                      className="flex justify-between gap-3 border-b border-line py-1.5"
                    >
                      <dt className="caps-label text-ink-2">{key}</dt>
                      <dd className="text-right text-ink">
                        {typeof value === "string" || typeof value === "number"
                          ? String(value)
                          : JSON.stringify(value)}
                      </dd>
                    </div>
                  ))}
              </dl>
            )}
            {children}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
