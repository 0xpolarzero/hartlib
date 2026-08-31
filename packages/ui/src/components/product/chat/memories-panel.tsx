import { useState } from "react";
import { Button } from "../../ui/button";
import { ConfirmingDeleteButton } from "../../ui/confirming-delete-button";
import { EmptyState, ErrorState } from "../../ui/states";
import { cn } from "../../../lib/utils";
import { uiMessage } from "../../../lib/format";
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
    <section className={className} aria-labelledby="memories-heading">
      <div className="flex items-baseline justify-between">
        <h2 id="memories-heading" className="caps-label text-ink-2">
          {uiMessage(locale, "section.memories")}
        </h2>
        <span className="font-mono text-[11px] text-ink-2">{memories.length}</span>
      </div>
      <p className="mt-1 font-mono text-[11px] text-ink-2">
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
        <EmptyState title={uiMessage(locale, "ui.noMemories")} className="px-0 py-8" />
      ) : (
        <ul className="mt-2 divide-y divide-line" data-testid="memory-list">
          {memories.map((memory) => {
            const open = expanded === memory.id;
            return (
              <li key={memory.id} className="py-2">
                <div className="grid gap-2 sm:grid-cols-[7rem_1fr_auto] sm:items-start">
                  <span className="caps-label text-ink-2">
                    {memory.current.kind}
                    {memory.current.deleted && (
                      <span className="mt-1 block text-danger">
                        {uiMessage(locale, "memory.deleted")}
                      </span>
                    )}
                  </span>
                  <div>
                    <p className="font-read text-[15px] leading-5">{memory.current.content}</p>
                    <p className="mt-1 font-mono text-[11px] text-ink-2">
                      {memory.updatedAt.slice(0, 10)}
                    </p>
                    {memory.revisions.length > 0 && (
                      <button
                        type="button"
                        className="mt-1 text-[11px] text-ink-2 underline"
                        onClick={() => setExpanded(open ? null : memory.id)}
                      >
                        {open
                          ? uiMessage(locale, "action.hideRevisions")
                          : uiMessage(locale, "action.viewRevisions")}
                      </button>
                    )}
                  </div>
                  {!memory.current.deleted && onDelete && (
                    <ConfirmingDeleteButton
                      onConfirm={() => void onDelete(memory.id)}
                      label={uiMessage(locale, "action.delete")}
                      locale={locale}
                    />
                  )}
                </div>
                {open && (
                  <ul className="mt-2 space-y-1 border-l border-line pl-3">
                    {memory.revisions.map((revision) => (
                      <li
                        key={revision.id}
                        className="flex items-center justify-between gap-2 font-mono text-[11px] text-ink-2"
                      >
                        <button
                          type="button"
                          className="underline"
                          onClick={() => onOpenRevision?.(memory.id, revision.id)}
                        >
                          {revision.action} · {revision.createdAt.slice(0, 10)}
                        </button>
                        {!revision.after.deleted &&
                          revision.id !== memory.headRevisionId &&
                          onRevert && (
                            <Button
                              variant="link"
                              size="sm"
                              onClick={() => void onRevert(memory.id, revision.id)}
                            >
                              {uiMessage(locale, "action.revertMemory")}
                            </Button>
                          )}
                      </li>
                    ))}
                  </ul>
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
