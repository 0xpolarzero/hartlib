import { useEffect, useRef, useState } from "react";
import { Download, Maximize2, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";
import { formatTime } from "@/lib/format";
import {
  Button, Dialog, DialogContent, DialogHeader, DialogTitle, EmptyState, Skeleton, Tooltip,
} from "@/components/ui";
import { useChat } from "./chat-store";

/**
 * Visualization companion: renders model-generated documents inside a fully
 * sandboxed iframe (sandbox="", no same-origin, no scripts — SVG only),
 * titled for a11y. Version rail: every update creates a version; clicking
 * scrubs (preview), Restore commits it as a new version. Refresh jitters
 * the data; Fullscreen opens a dialog; Download saves the current .html.
 */
export function VizPane({ fullscreen = false }: { fullscreen?: boolean }) {
  const { locale, t } = useI18n();
  const chat = useChat();
  const [fullscreenOpen, setFullscreenOpen] = useState(false);
  const highlightRef = useRef<HTMLDivElement>(null);

  const current = chat.versions[chat.activeVersionIndex];
  const scrubbedOlder = chat.activeVersionIndex < chat.versions.length - 1;

  // Brief pane-edge highlight when a completed answer references the visual.
  useEffect(() => {
    if (chat.vizHighlightKey === 0 || !highlightRef.current) return;
    highlightRef.current.classList.remove("animate-pulse-edge");
    // force reflow to restart the animation
    void highlightRef.current.offsetWidth;
    highlightRef.current.classList.add("animate-pulse-edge");
  }, [chat.vizHighlightKey]);

  const download = () => {
    if (!current) return;
    const blob = new Blob([current.html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `bref-${current.specId}-v${chat.activeVersionIndex + 1}.html`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!current) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState
          title={t("viz.emptyTitle")}
          description={t("viz.emptyBody")}
        />
      </div>
    );
  }

  const frame = (
    <iframe
      title={t("viz.iframeTitle", { label: current.label })}
      srcDoc={current.html}
      sandbox=""
      className={cn("h-full w-full border-0 bg-paper", fullscreen ? "min-h-[60vh]" : "min-h-0 flex-1")}
    />
  );

  return (
    <div ref={highlightRef} className="flex h-full min-h-0 flex-col outline outline-1 outline-transparent">
      {/* Header */}
      <div className="flex min-h-10 shrink-0 items-center gap-2 border-b border-line px-3 py-1.5">
        <p className="caps-label truncate text-ink-2">{t("viz.title")}</p>
        <span aria-hidden="true" className="h-px flex-1 bg-line" />
        <Tooltip content={t("viz.refresh")}>
          <Button variant="ghost" size="icon-sm" aria-label={t("viz.refresh")} onClick={() => void chat.refreshVersion()} disabled={chat.regenerating}>
            <RotateCcw className={cn("size-3", chat.regenerating && "animate-spin-slow")} />
          </Button>
        </Tooltip>
        {!fullscreen && (
          <Tooltip content={t("viz.fullscreen")}>
            <Button variant="ghost" size="icon-sm" aria-label={t("viz.fullscreen")} onClick={() => setFullscreenOpen(true)}>
              <Maximize2 className="size-3" />
            </Button>
          </Tooltip>
        )}
        <Tooltip content={t("viz.download")}>
          <Button variant="ghost" size="icon-sm" aria-label={t("viz.download")} onClick={download}>
            <Download className="size-3" />
          </Button>
        </Tooltip>
      </div>

      {/* Version rail */}
      <div
        role="group"
        aria-label={t("viz.versionsLabel")}
        className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-line px-3 py-1.5"
      >
        {chat.versions.map((version, i) => {
          const active = i === chat.activeVersionIndex;
          return (
            <button
              key={version.id}
              type="button"
              onClick={() => chat.scrubVersion(i)}
              aria-current={active ? "true" : undefined}
              title={`${version.label} — ${formatTime(locale, version.createdAt)}`}
              className={cn(
                "shrink-0 rounded-tiny border px-1.5 py-0.5 font-mono text-[10.5px] transition-colors duration-100",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                active ? "border-accent bg-accent/10 text-accent" : "border-line-2 text-ink-2 hover:border-ink-3 hover:text-ink",
              )}
            >
              v{i + 1}
            </button>
          );
        })}
        {scrubbedOlder && (
          <Button
            variant="secondary"
            size="sm"
            className="ml-1 animate-enter"
            onClick={() => chat.restoreVersion(chat.activeVersionIndex)}
          >
            {t("viz.restore", { v: String(chat.activeVersionIndex + 1) })}
          </Button>
        )}
        <span className="ml-auto hidden shrink-0 pl-2 font-mono text-[10px] text-ink-2 sm:inline">
          {current.label}
        </span>
      </div>

      {/* Canvas — previous visual stays visible (dimmed) while regenerating */}
      <div className="relative min-h-0 flex-1">
        {chat.regenerating && (
          <div className="absolute inset-0 z-10 grid gap-2 bg-paper/70 p-4" role="status" aria-label={t("viz.regenerating")}>
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-40 w-full" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        )}
        {frame}
      </div>

      {/* Fullscreen dialog */}
      <Dialog open={fullscreenOpen} onOpenChange={setFullscreenOpen}>
        <DialogContent className="top-[6vh] h-[80vh] w-[min(96vw,64rem)] max-h-none p-0">
          <DialogHeader className="pr-12">
            <DialogTitle className="truncate">{current.label}</DialogTitle>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-hidden">
            <VizPane fullscreen />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
