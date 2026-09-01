import { useEffect, useRef, useState, type ReactNode } from "react";
import { Bug } from "lucide-react";
import {
  Badge,
  Button,
  ErrorState,
  Sheet,
  SheetBody,
  SheetContent,
  SheetHeader,
  SheetTitle,
  Skeleton,
} from "../../ui";
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
      <Sheet
        locale={locale}
        open={open}
        onOpenChange={(value) => (value ? setOpen(true) : close())}
      >
        <SheetContent side="right" className="w-[min(94vw,27rem)]">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2 font-display text-[16px] font-medium">
              {uiMessage(locale, "ui.debugDetails")}
              <Badge tone="warning">{uiMessage(locale, "debug.internal")}</Badge>
            </SheetTitle>
          </SheetHeader>
          <SheetBody>
            {loadState === "loading" && (
              <div role="status" aria-label={uiMessage(locale, "debug.loading")}>
                <p className="caps-label text-ink-2">{uiMessage(locale, "debug.loading")}</p>
                <div className="mt-3 grid gap-2">
                  <Skeleton className="h-6 w-2/3" />
                  <Skeleton className="h-24 w-full" />
                  <Skeleton className="h-24 w-full" />
                </div>
              </div>
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
              <div className="grid gap-5 pb-6">
                <section>
                  <h3 className="caps-label mb-1.5 text-ink-2">
                    {uiMessage(locale, "debug.meta")}
                  </h3>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-[11px]">
                    {Object.entries(loaded)
                      .filter(([key]) => key !== "events")
                      .map(([key, value]) => (
                        <div key={key} className="contents">
                          <dt className="text-ink-2">{key}</dt>
                          <dd className="truncate text-ink">
                            {typeof value === "string" || typeof value === "number"
                              ? String(value)
                              : JSON.stringify(value)}
                          </dd>
                        </div>
                      ))}
                  </dl>
                </section>
              </div>
            )}
            {children}
          </SheetBody>
        </SheetContent>
      </Sheet>
    </>
  );
}
