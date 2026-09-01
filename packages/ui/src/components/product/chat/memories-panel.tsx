import { useMemo, useState } from "react";
import { History, RotateCcw } from "lucide-react";
import { Button } from "../../ui/button";
import { Badge, Skeleton } from "../../ui/atoms";
import { ConfirmingDeleteButton } from "../../ui/confirming-delete-button";
import { EmptyState, ErrorState } from "../../ui/states";
import { cn } from "../../../lib/utils";
import { formatDateTime, uiMessage } from "../../../lib/format";
import type { MemoryRecord, MemoryRevision } from "@hartlib/shared";

const THIRTY_DAYS = 30 * 86400000;

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

/**
 * Reflowing Memories panel: saved memories with content, origin turn,
 * timestamps; tombstone soft-delete (struck-through row), a 30-day reversible
 * history timeline, per-entry Revert that appends a new revision, and an
 * empty state. Data and mutations are production-controlled through props.
 */
export function MemoriesPanel({
  memories = [],
  status = "ready",
  error = null,
  onRetry,
  onDelete,
  onRevert,
  onOpenRevision: _onOpenRevision,
  onOpenProvenance,
  selectedRevision = null,
  onCloseRevision,
  className,
  locale = "en-US",
}: MemoriesPanelProps) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const cutoff = useMemo(() => Date.now() - THIRTY_DAYS, []);
  const withinWindow = (revision: MemoryRevision) =>
    new Date(revision.createdAt).getTime() >= cutoff;

  if (status === "loading")
    return (
      <div className={cn("grid gap-2 p-4", className)}>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
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
          className="py-16"
        />
      ) : (
        <ul
          className="divide-y divide-line"
          data-testid="memory-list"
          aria-label={uiMessage(locale, "memories.list")}
        >
          {memories.map((memory) => {
            const deleted = memory.current.deleted;
            const open = expanded === memory.id;
            const revs = memory.revisions.filter(withinWindow);
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
                        <Badge tone="danger">{uiMessage(locale, "memories.tombstoned")}</Badge>
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
                      {uiMessage(locale, "memories.created")}{" "}
                      {formatDateTime(locale, memory.createdAt)} ·{" "}
                      {uiMessage(locale, "memories.updated")}{" "}
                      {formatDateTime(locale, memory.updatedAt)}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-expanded={open}
                      aria-label={uiMessage(locale, "memories.history").replace(
                        "{label}",
                        memory.current.kind,
                      )}
                      onClick={() => setExpanded(open ? null : memory.id)}
                    >
                      <History className="size-3.5" />
                    </Button>
                    {!deleted && onDelete && (
                      <ConfirmingDeleteButton
                        label={uiMessage(locale, "memories.deleteA11y").replace(
                          "{label}",
                          memory.current.kind,
                        )}
                        onConfirm={() => void onDelete(memory.id)}
                        locale={locale}
                      />
                    )}
                  </div>
                </div>

                {open && (
                  <div className="mt-2.5 animate-enter border-l border-line-2 pl-3">
                    <p className="caps-label mb-1.5 text-ink-2">
                      {uiMessage(locale, "memories.timeline").replace("{n}", String(revs.length))}
                    </p>
                    {revs.length === 0 && (
                      <p className="text-[12px] text-ink-2">
                        {uiMessage(locale, "memories.noRecentRevisions")}
                      </p>
                    )}
                    <ol className="grid gap-1">
                      {revs.map((revision) => (
                        <li
                          key={revision.id}
                          id={`mem-${memory.id}-rev-${revision.id}`}
                          className="flex items-start gap-2.5 rounded-tiny px-1 py-1.5 transition-colors duration-100 hover:bg-paper-deep/50"
                        >
                          <span className="mt-0.5 inline-flex h-4 shrink-0 items-center rounded-tiny border border-line-2 px-1 font-mono text-[9.5px] text-ink-2">
                            r{memory.revisions.indexOf(revision) + 1}
                          </span>
                          <div className="min-w-0 flex-1">
                            <p className="text-[12.5px] leading-snug text-ink">
                              {revision.after.content}
                            </p>
                            <p className="mt-0.5 font-mono text-[10px] text-ink-2">
                              {formatDateTime(locale, revision.createdAt)} —{" "}
                              {uiMessage(locale, "memories.originCreated")}
                            </p>
                          </div>
                          {onRevert &&
                            !revision.after.deleted &&
                            revision.id !== memory.headRevisionId && (
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
