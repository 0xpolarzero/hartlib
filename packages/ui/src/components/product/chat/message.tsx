import { memo, useState } from "react";
import { CircleAlert, MoreHorizontal, RotateCcw } from "lucide-react";
import { cn } from "../../../lib/utils";
import { uiMessage } from "../../../lib/format";
import { Button } from "../../ui/button";
import { AutoTextarea } from "../../ui/controls";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  DialogFooter,
} from "../../ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../ui/overlays";
import { Tooltip } from "../../ui/overlays";
import { AnswerBody, type CopyAdapter } from "./markdown";
import { SourcesDisclosure } from "./sources-disclosure";
import type { ChatTranscriptMessage, PublicCitationRecord, RunFailure } from "./types";
export const FailureBlock = memo(function FailureBlock({
  failure,
  onRetry,
  locale = "en-US",
}: {
  failure: RunFailure;
  onRetry?: () => void;
  locale?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "animate-enter mt-1.5 max-w-[42ch] rounded-tiny border px-2.5 py-2 text-right",
        failure.retryable ? "border-warn/40 bg-warn/5" : "border-danger/40 bg-danger/5",
      )}
    >
      <p className="flex items-center justify-end gap-1.5 font-mono text-[11px] tracking-wide">
        <CircleAlert
          className={cn("size-3", failure.retryable ? "text-warn" : "text-danger")}
          aria-hidden="true"
        />
        <span className={failure.retryable ? "text-warn" : "text-danger"}>{failure.code}</span>
      </p>
      {failure.message && (
        <p className="mt-1 text-[12px] leading-snug text-ink-2">{failure.message}</p>
      )}
      {failure.retryable && onRetry && (
        <Button variant="secondary" size="sm" className="mt-2" onClick={onRetry}>
          {uiMessage(locale, "ui.retry")}
        </Button>
      )}
    </div>
  );
});

function MessageActions({
  message,
  onDelete,
  onEdit,
  locale,
}: {
  message: ChatTranscriptMessage;
  onDelete?: (message: ChatTranscriptMessage) => void;
  onEdit?: () => void;
  locale: string;
}) {
  const [confirm, setConfirm] = useState(false);
  if (!onDelete && !onEdit) return null;
  return (
    <>
      <DropdownMenu locale={locale}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={uiMessage(locale, "ui.actions")}
            title={uiMessage(locale, "ui.actions")}
          >
            <MoreHorizontal className="size-3.5" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {onEdit && (
            <DropdownMenuItem onSelect={onEdit}>
              {uiMessage(locale, "ui.editMessage")}
            </DropdownMenuItem>
          )}
          {onDelete && (
            <DropdownMenuItem destructive onSelect={() => setConfirm(true)}>
              {uiMessage(locale, "ui.deleteMessage")}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog locale={locale} open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogTitle>{uiMessage(locale, "ui.deleteMessageTitle")}</AlertDialogTitle>
          <AlertDialogDescription>
            {uiMessage(locale, "ui.deleteMessageDescription")}
          </AlertDialogDescription>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              {uiMessage(locale, "ui.cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirm(false);
                onDelete?.(message);
              }}
            >
              {uiMessage(locale, "action.delete")}
            </Button>
          </DialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export const UserMessage = memo(function UserMessage({
  message,
  onDelete,
  onEdit,
  onRetry,
  canEdit = false,
  locale = "en-US",
}: {
  message: ChatTranscriptMessage;
  onDelete?: (message: ChatTranscriptMessage) => void;
  onEdit?: (message: ChatTranscriptMessage) => void;
  onRetry?: (message: ChatTranscriptMessage) => void;
  canEdit?: boolean;
  locale?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const saveEdit = () => {
    const text = draft.trim();
    if (!text || !onEdit) return;
    setEditing(false);
    onEdit({ ...message, content: text });
  };
  return (
    <div
      className="flex flex-col items-end"
      data-message-id={message.id}
      data-testid="chat-message-user"
    >
      {editing ? (
        <div className="w-full max-w-[42ch] rounded-tiny border border-accent bg-paper-deep/70 p-2">
          <AutoTextarea
            aria-label={uiMessage(locale, "ui.editMessage")}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setEditing(false);
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                saveEdit();
              }
            }}
            maxRows={8}
            autoFocus
          />
          <div className="mt-1.5 flex justify-end gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setDraft(message.content);
                setEditing(false);
              }}
            >
              {uiMessage(locale, "ui.cancel")}
            </Button>
            <Button variant="primary" size="sm" disabled={!draft.trim()} onClick={saveEdit}>
              {uiMessage(locale, "ui.save")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="max-w-[42ch] rounded-tiny border border-line bg-paper-deep/70 px-3 py-1.5">
          <p className="text-left font-sans text-[13px] leading-relaxed whitespace-pre-wrap text-ink">
            {message.content}
          </p>
        </div>
      )}
      <div className="flex items-center gap-1">
        <p
          className="mt-0.5 font-mono text-[10px] text-ink-2"
          aria-label={uiMessage(locale, "chat.sentAtLabel")}
        >
          {message.createdAt ?? ""}
          {(message as ChatTranscriptMessage & { webSearch?: boolean }).webSearch && (
            <span className="ml-1.5 text-accent">· web</span>
          )}
          {message.stopped && (
            <span className="ml-1.5 text-warn">{uiMessage(locale, "ui.stopped")}</span>
          )}
        </p>
        {!editing && (
          <MessageActions
            message={message}
            locale={locale}
            {...(onDelete === undefined ? {} : { onDelete })}
            {...(canEdit && onEdit
              ? {
                  onEdit: () => {
                    setDraft(message.content);
                    setEditing(true);
                  },
                }
              : {})}
          />
        )}
      </div>
      {message.failure && (
        <FailureBlock
          failure={message.failure}
          locale={locale}
          {...(onRetry === undefined ? {} : { onRetry: () => onRetry(message) })}
        />
      )}
    </div>
  );
});
export const AssistantMessage = memo(function AssistantMessage({
  message,
  onDelete,
  onDebug,
  onShowVisualization,
  isLast = false,
  locale = "en-US",
  onCitation,
  copyAdapter,
  onRegenerate,
}: {
  message: ChatTranscriptMessage;
  onDelete?: (message: ChatTranscriptMessage) => void;
  onDebug?: (runId: string) => void;
  onShowVisualization?: (message: ChatTranscriptMessage) => void;
  onRegenerate?: () => void;
  isLast?: boolean;
  locale?: string;
  onCitation?: (citation: PublicCitationRecord) => void | Promise<void>;
  copyAdapter?: CopyAdapter;
}) {
  const stopped = message.stopped || message.failure?.stoppedAt;
  const answerProps = message.streaming === undefined ? {} : { streaming: message.streaming };
  const disclosureProps = message.citations === undefined ? {} : { citations: message.citations };
  return (
    <article
      className="grid gap-2.5"
      aria-label={uiMessage(locale, "ui.assistantAnswer")}
      data-message-id={message.id}
      data-testid="chat-message-assistant"
    >
      <header className="flex items-center gap-2">
        <p className="font-mono text-[10px] tracking-[0.12em] text-ink-2 uppercase">
          {uiMessage(locale, "chat.author.assistant")}
          {message.createdAt ? ` · ${message.createdAt}` : ""}
        </p>
        <span aria-hidden="true" className="h-px flex-1 bg-line" />
        {isLast && !message.streaming && onRegenerate && (
          <Tooltip content={uiMessage(locale, "chat.regenerateTip")}>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={uiMessage(locale, "chat.regenerate")}
              onClick={onRegenerate}
            >
              <RotateCcw className="size-3" />
            </Button>
          </Tooltip>
        )}
        {message.runId && onDebug && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={uiMessage(locale, "ui.showDiagnostics")}
            className="font-mono text-[10px]"
            onClick={() => onDebug(message.runId!)}
          >
            {"{}"}
          </Button>
        )}
        <MessageActions
          message={message}
          locale={locale}
          {...(onDelete === undefined ? {} : { onDelete })}
        />
      </header>
      <AnswerBody
        content={message.content}
        sources={message.citations ?? []}
        locale={locale}
        {...(onCitation === undefined ? {} : { onCitation })}
        {...(copyAdapter === undefined ? {} : { copyAdapter })}
        {...answerProps}
      />
      {stopped && (
        <p className="font-mono text-[11px] text-ink-2">{uiMessage(locale, "ui.answerStopped")}</p>
      )}
      {message.sourcesRead !== undefined && !message.streaming && (
        <SourcesDisclosure
          sources={message.sourcesRead}
          {...disclosureProps}
          answerId={message.id}
          locale={locale}
          {...(onCitation === undefined ? {} : { onCitation })}
        />
      )}
      {message.referencesVisualization && onShowVisualization && (
        <button
          type="button"
          className="w-fit font-mono text-[11px] text-accent underline decoration-dotted underline-offset-4 transition-colors duration-100 hover:text-accent-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent lg:hidden"
          onClick={() => onShowVisualization(message)}
        >
          {uiMessage(locale, "ui.showVisualization")}
        </button>
      )}
      {isLast && message.failure && <FailureBlock failure={message.failure} locale={locale} />}
    </article>
  );
});
