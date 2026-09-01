import { useEffect, useMemo, useRef, useState } from "react";
import { Download, Maximize2, RotateCcw } from "lucide-react";
import { cn } from "../../../lib/utils";
import { uiMessage } from "../../../lib/format";
import { Button } from "../../ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../ui/dialog";
import { EmptyState } from "../../ui/states";
import { Skeleton } from "../../ui/atoms";
import type { VisualizationPresentationState } from "./types";

export interface VizPaneProps extends VisualizationPresentationState {
  fullscreen?: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
  title?: string;
  className?: string;
  locale?: string;
}
export function VizPane({
  versions,
  activeVersionId,
  state = "idle",
  highlightKey,
  association,
  onSelectVersion,
  onRestoreVersion,
  onRefresh,
  onDownload,
  onFullscreen,
  onShow,
  emptyTitle,
  emptyDescription,
  title = "Visualization",
  fullscreen = false,
  className,
  locale = "en-US",
}: VizPaneProps) {
  const resolvedEmptyTitle =
    emptyTitle ??
    (locale === "fr" || locale === "fr-FR"
      ? "Le panneau attend sa première réponse"
      : uiMessage(locale, "ui.noVisualization"));
  const resolvedEmptyDescription =
    emptyDescription ??
    (locale === "fr" || locale === "fr-FR"
      ? "Chaque réponse visuelle — comparaison, tendance, tableau ou indicateurs — s’affichera ici, avec son historique de versions."
      : uiMessage(locale, "ui.visualizationDescription"));
  const resolvedTitle = title === "Visualization" ? uiMessage(locale, "ui.visualization") : title;
  const [fullscreenOpen, setFullscreenOpen] = useState(false);
  const highlight = useRef<HTMLDivElement>(null);
  const current = useMemo(
    () => versions.find((version) => version.id === activeVersionId) ?? versions.at(-1),
    [activeVersionId, versions],
  );
  const index = current ? versions.findIndex((version) => version.id === current.id) : -1;
  useEffect(() => {
    if (
      highlightKey === null ||
      highlightKey === undefined ||
      !highlight.current ||
      typeof highlight.current.animate !== "function"
    )
      return;
    if (
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;
    highlight.current.animate(
      [
        { outlineColor: "transparent" },
        { outlineColor: "var(--color-accent)" },
        { outlineColor: "transparent" },
      ],
      { duration: 800 },
    );
  }, [highlightKey]);
  if (!current)
    return (
      <div
        ref={highlight}
        className={cn("flex h-full items-center justify-center p-6", className)}
        data-testid="viz-empty"
      >
        {state === "loading" || state === "regenerating" ? (
          <div
            className="grid w-full max-w-sm gap-2 p-5"
            role="status"
            data-testid="viz-loading"
            aria-label={
              state === "loading"
                ? uiMessage(locale, "ui.loadingVisualization")
                : uiMessage(locale, "ui.regeneratingVisualization")
            }
          >
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        ) : (
          <EmptyState
            className="animate-enter-fade"
            title={resolvedEmptyTitle}
            description={resolvedEmptyDescription}
          />
        )}
      </div>
    );
  const nestedProps = {
    versions,
    activeVersionId: current.id,
    state,
    locale,
    ...(association === undefined ? {} : { association }),
    ...(highlightKey === undefined ? {} : { highlightKey }),
    ...(onSelectVersion === undefined ? {} : { onSelectVersion }),
    ...(onRestoreVersion === undefined ? {} : { onRestoreVersion }),
    ...(onRefresh === undefined ? {} : { onRefresh }),
    ...(onDownload === undefined ? {} : { onDownload }),
    ...(onShow === undefined ? {} : { onShow }),
  };
  return (
    <div
      ref={highlight}
      className={cn(
        "flex h-full min-h-0 flex-col outline outline-1 outline-transparent",
        className,
      )}
      data-testid="viz-pane"
    >
      <div className="flex min-h-10 shrink-0 items-center gap-2 border-b border-line px-3 py-1.5">
        <p className="caps-label truncate text-ink-2">{resolvedTitle}</p>
        <span aria-hidden="true" className="h-px flex-1 bg-line" />
        {onShow && association && (
          <Button variant="secondary" size="sm" onClick={() => onShow(association)}>
            {uiMessage(locale, "ui.show")}
          </Button>
        )}
        {onRefresh && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={uiMessage(locale, "ui.refreshVisualization")}
            onClick={() => void onRefresh()}
            disabled={state === "regenerating"}
          >
            <RotateCcw className={cn("size-3", state === "regenerating" && "animate-spin-slow")} />
          </Button>
        )}
        {!fullscreen && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={uiMessage(locale, "ui.openFullscreen")}
            onClick={() => {
              setFullscreenOpen(true);
              onFullscreen?.();
            }}
          >
            <Maximize2 className="size-3" />
          </Button>
        )}
        {onDownload && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={uiMessage(locale, "ui.downloadVisualization")}
            onClick={() => onDownload(current)}
          >
            <Download className="size-3" />
          </Button>
        )}
      </div>
      <div
        role="group"
        aria-label={uiMessage(locale, "ui.visualizationVersions")}
        className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-line px-3 py-1.5"
      >
        {versions.map((version, versionIndex) => (
          <button
            key={version.id}
            type="button"
            aria-current={version.id === current.id ? "true" : undefined}
            title={`${version.label} · ${version.createdAt}`}
            className={cn(
              "shrink-0 rounded-tiny border px-1.5 py-0.5 font-mono text-[10.5px]",
              "transition-colors duration-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
              version.id === current.id
                ? "border-accent bg-accent/10 text-accent"
                : "border-line-2 text-ink-2 hover:border-ink-3 hover:text-ink",
            )}
            onClick={() => onSelectVersion?.(version.id)}
          >
            v{versionIndex + 1}
          </button>
        ))}
        {index >= 0 && index < versions.length - 1 && onRestoreVersion && (
          <Button
            variant="secondary"
            size="sm"
            className="ml-1 animate-enter"
            onClick={() => onRestoreVersion(current.id)}
          >
            {uiMessage(locale, "ui.restoreVisualization")} v{index + 1}
          </Button>
        )}
        <span className="ml-auto hidden shrink-0 font-mono text-[10px] text-ink-2 sm:inline">
          {current.label}
        </span>
      </div>
      <div className="relative min-h-0 flex-1">
        {state === "loading" || state === "regenerating" ? (
          <div
            className="absolute inset-0 z-10 grid gap-2 bg-paper/75 p-4"
            role="status"
            aria-label={
              state === "loading"
                ? uiMessage(locale, "ui.loadingVisualization")
                : uiMessage(locale, "ui.regeneratingVisualization")
            }
          >
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-40 w-full" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        ) : null}
        <iframe
          title={current.label}
          srcDoc={current.html}
          sandbox=""
          className={cn(
            "h-full w-full border-0 bg-paper",
            fullscreen ? "min-h-[60vh]" : "min-h-0 flex-1",
          )}
        />
      </div>
      {association && (
        <p className="border-t border-line px-3 py-1.5 font-mono text-[11px] text-ink-2">
          {uiMessage(locale, "ui.associatedWithMessage")} {association.messageId}
        </p>
      )}
      <Dialog locale={locale} open={fullscreenOpen} onOpenChange={setFullscreenOpen}>
        <DialogContent className="top-[6vh] h-[80vh] w-[min(96vw,64rem)] max-h-none p-0">
          <DialogHeader>
            <DialogTitle>{current.label}</DialogTitle>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-hidden">
            <VizPane fullscreen {...nestedProps} />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
