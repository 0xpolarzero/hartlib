import { useState } from "react";
import { History, RotateCcw } from "lucide-react";
import { Button } from "../../ui/button";
import { ConfirmingDeleteButton } from "../../ui/confirming-delete-button";
import { EmptyState, ErrorState } from "../../ui/states";
import { cn } from "../../../lib/utils";
import { formatDateTime, uiMessage } from "../../../lib/format";
import type { MemoryRecord, MemoryRevision } from "@hartlib/shared";

export interface MemoriesPanelProps {
  memories?: readonly MemoryRecord[];
  status?: "loading" | "ready" | "error" | "denied" | "retention-unavailable";
  error?: string | null;
  onRetry?: () => void;
  onDelete?: (id: string) => void | Promise<void>;
  onRevert?: (memoryId: string, revisionId: string) => void | Promise<void>;
  onOpenRevision?: (memoryId: string, revisionId: string) => void;
  onOpenProvenance?: (memory: MemoryRecord) => void;
  selectedRevision?: { readonly memoryId: string; readonly revision: MemoryRevision } | null;
  onCloseRevision?: () => void;
  className?: string;
  locale?: string;
}

const emptyMemoriesDescription = (locale: string): string =>
  locale === "fr" || locale === "fr-FR"
    ? "Les préférences et échéances que vous confierez à l’assistant apparaîtront ici, avec leur historique réversible."
    : "Preferences and deadlines you entrust to the assistant will appear here, with their reversible history.";

export function MemoriesPanel({
  memories = [],
  status = "ready",
  error = null,
  onRetry,
  onDelete,
  onRevert,
  onOpenRevision,
  onOpenProvenance,
  selectedRevision = null,
  onCloseRevision,
  className,
  locale = "en-US",
}: MemoriesPanelProps) {
  const [expanded, setExpanded] = useState<string | null>(null);
  if (status === "loading")
    return (
      <p role="status" className={cn("p-3 text-[12px] text-ink-2", className)}>
        {uiMessage(locale, "state.loadingMemories")}
      </p>
    );
  if (status === "error")
    return (
      <ErrorState
        title={uiMessage(locale, "state.memoriesUnavailable")}
        {...(error === null ? {} : { description: error })}
        {...(onRetry === undefined ? {} : { onRetry })}
        retryLabel={uiMessage(locale, "ui.retry")}
        {...(className === undefined ? {} : { className })}
      />
    );
  if (status === "denied")
    return (
      <ErrorState
        title={uiMessage(locale, "state.memoriesDenied")}
        description={uiMessage(locale, "ui.debugAccessDenied")}
        {...(className === undefined ? {} : { className })}
      />
    );
  if (status === "retention-unavailable")
    return (
      <ErrorState
        title={uiMessage(locale, "state.memoriesRetentionUnavailable")}
        description={uiMessage(locale, "state.retainedDataUnavailable")}
        {...(onRetry === undefined ? {} : { onRetry })}
        retryLabel={uiMessage(locale, "ui.retry")}
        {...(className === undefined ? {} : { className })}
      />
    );
  return (
    <section
      className={cn("min-h-full", className)}
      aria-labelledby="memories-heading"
      aria-describedby="memories-retention-notice"
    >
      <header className="-mx-3 -mt-3 flex min-h-10 items-center justify-between border-b border-line px-3">
        <h2 id="memories-heading" className="font-display text-[15px] font-medium text-ink">
          {uiMessage(locale, "section.memories")}
        </h2>
        <span className="sr-only font-mono text-[11px] text-ink-2">{memories.length}</span>
      </header>
      <p id="memories-retention-notice" className="sr-only">
        {uiMessage(locale, "chat.memoryDeletionNotice")}
      </p>
      {error !== null && (
        <p role="alert" className="mt-2 text-[12px] text-danger">
          {error}
        </p>
      )}
      {selectedRevision !== null && (
        <article className="mt-3 rounded-tiny border border-line bg-surface p-3" aria-live="polite">
          <div className="flex items-center justify-between gap-2">
            <h3 className="font-medium">{uiMessage(locale, "ui.memoryRevision")}</h3>
            {onCloseRevision && (
              <Button variant="ghost" size="sm" onClick={onCloseRevision}>
                {uiMessage(locale, "ui.close")}
              </Button>
            )}
          </div>
          <p className="mt-1 font-mono text-[11px] text-ink-2">
            {selectedRevision.revision.action} · {selectedRevision.revision.createdAt.slice(0, 10)}
          </p>
          <p className="mt-2 font-read text-[14px]">{selectedRevision.revision.after.content}</p>
        </article>
      )}
      {memories.length === 0 ? (
        <EmptyState
          title={uiMessage(locale, "ui.noMemories")}
          description={emptyMemoriesDescription(locale)}
          className="px-0 py-16"
        />
      ) : (
        <ul
          className="divide-y divide-line"
          data-testid="memory-list"
          aria-label={uiMessage(locale, "section.memories")}
        >
          {memories.map((memory) => {
            const deleted = memory.current.deleted;
            const open = expanded === memory.id;
            const historyLabel = uiMessage(
              locale,
              open ? "action.hideRevisions" : "action.viewRevisions",
            );
            return (
              <li key={memory.id} className={cn("py-3", deleted && "opacity-75")}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p
                      className={cn(
                        "flex flex-wrap items-center gap-1.5 text-[13px] font-medium text-ink",
                        deleted && "line-through decoration-danger/60",
                      )}
                    >
                      {memory.current.kind}
                      {deleted && (
                        <span className="rounded-tiny border border-danger/40 px-1 py-0.5 font-sans text-[10px] font-normal text-danger">
                          {uiMessage(locale, "memory.deleted")}
                        </span>
                      )}
                    </p>
                    <p
                      className={cn(
                        "font-read text-[13.5px] leading-relaxed text-ink-2",
                        deleted && "line-through",
                      )}
                    >
                      {memory.current.content}
                    </p>
                    <p className="mt-1 font-mono text-[10.5px] text-ink-2">
                      {formatDateTime(locale, memory.createdAt)} · {formatDateTime(locale, memory.updatedAt)}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {memory.revisions.length > 0 && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-expanded={open}
                        aria-label={historyLabel}
                        title={historyLabel}
                        onClick={() => setExpanded(open ? null : memory.id)}
                      >
                        <History className="size-3.5" aria-hidden="true" />
                        <span className="sr-only">{historyLabel}</span>
                      </Button>
                    )}
                    {!deleted && onDelete && (
                      <ConfirmingDeleteButton
                        onConfirm={() => void onDelete(memory.id)}
                        label={uiMessage(locale, "action.delete")}
                        locale={locale}
                      />
                    )}
                  </div>
                </div>
                {open && (
                  <div className="mt-2.5 border-l border-line-2 pl-3">
                    <p className="caps-label mb-1.5 text-ink-2">{historyLabel}</p>
                    <ol className="grid gap-1">
                      {memory.revisions.map((revision) => (
                        <li
                          key={revision.id}
                          className="flex items-start gap-2.5 rounded-tiny px-1 py-1.5"
                        >
                          <button
                            type="button"
                            className="min-w-0 flex-1 text-left"
                            onClick={() => onOpenRevision?.(memory.id, revision.id)}
                          >
                            <span className="block font-mono text-[11px] text-ink-2">
                              {revision.action} · {formatDateTime(locale, revision.createdAt)}
                            </span>
                            <span className="mt-0.5 block font-read text-[13px] leading-snug text-ink">
                              {revision.after.content}
                            </span>
                          </button>
                          {!revision.after.deleted &&
                            revision.id !== memory.headRevisionId &&
                            onRevert && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="shrink-0"
                                onClick={() => void onRevert(memory.id, revision.id)}
                              >
                                <RotateCcw className="size-3" aria-hidden="true" />
                                {uiMessage(locale, "action.revertMemory")}
                              </Button>
                            )}
                        </li>
                      ))}
                    </ol>
                  </div>
                )}
                {onOpenProvenance && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mt-1"
                    onClick={() => onOpenProvenance(memory)}
                  >
                    {uiMessage(locale, "ui.viewProvenance")}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
