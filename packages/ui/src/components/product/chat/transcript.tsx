import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ArrowDown, Bug, Sparkles } from "lucide-react";
import { useAnnounce } from "../../../lib/announce";
import { cn } from "../../../lib/utils";
import { uiMessage } from "../../../lib/format";
import { Button } from "../../ui/button";
import { ErrorState } from "../../ui/states";
import { AssistantMessage, FailureBlock, UserMessage } from "./message";
import { RunActivity } from "./run-activity";
import { AnswerBody, type CopyAdapter } from "./markdown";
import type { ChatRunProjection, ChatTranscriptMessage, PublicCitationRecord } from "./types";

export interface TranscriptProps {
  messages: readonly ChatTranscriptMessage[];
  run?: ChatRunProjection | null;
  status?: "loading" | "ready" | "error";
  onRetryLoad?: () => void;
  suggestions?: readonly string[];
  onSuggestion?: (suggestion: string) => void;
  onDeleteMessage?: (message: ChatTranscriptMessage) => void;
  onEditMessage?: (message: ChatTranscriptMessage) => void;
  onRetryMessage?: (message: ChatTranscriptMessage) => void;
  canEditLastUser?: boolean;
  onDebug?: (runId: string) => void;
  onShowVisualization?: (message: ChatTranscriptMessage) => void;
  onCitation?: (citation: PublicCitationRecord) => void | Promise<void>;
  copyAdapter?: CopyAdapter;
  focusMessageId?: string | null;
  emptyTitle?: string;
  emptyDescription?: string;
  className?: string;
  children?: ReactNode;
  locale?: string;
}

export const TRANSCRIPT_NEAR_BOTTOM_PX = 48;
const VIRTUAL_OVERSCAN_PX = 480;
const TRANSCRIPT_ROW_GAP_PX = 28;
type LayoutItem = { id: string; top: number; size: number; bottom: number };

const estimateHeight = (message: ChatTranscriptMessage): number =>
  message.streaming || message.id.startsWith("run:") ? 220 : message.author === "user" ? 88 : 180;

export function Transcript({
  messages,
  run = null,
  status = "ready",
  onRetryLoad,
  suggestions = [],
  onSuggestion,
  onDeleteMessage,
  onEditMessage,
  onRetryMessage,
  canEditLastUser = false,
  onDebug,
  onShowVisualization,
  onCitation,
  copyAdapter,
  focusMessageId = null,
  emptyTitle,
  emptyDescription,
  className,
  children,
  locale = "en-US",
}: TranscriptProps) {
  const resolvedEmptyTitle = emptyTitle ?? uiMessage(locale, "ui.startConversation");
  const resolvedEmptyDescription = emptyDescription ?? uiMessage(locale, "ui.askAboutSources");
  const viewport = useRef<HTMLDivElement>(null);
  const observers = useRef(new Map<string, ResizeObserver>());
  const [nearBottom, setNearBottom] = useState(true);
  const [unread, setUnread] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(640);
  const [heights, setHeights] = useState<Map<string, number>>(new Map());
  const announce = useAnnounce();
  const previousLength = useRef(messages.length);
  const previousStreamText = useRef(run?.streamedText ?? "");
  const lastUserMessage = useMemo(
    () => [...messages].reverse().find((message) => message.author === "user"),
    [messages],
  );
  const lastUserId = lastUserMessage?.id;
  const provisionalId = run === null ? null : `streaming:${run.id}`;
  const hasProvisional =
    provisionalId !== null && messages.some((message) => message.id === provisionalId);
  const items = useMemo(
    () =>
      run !== null && !hasProvisional
        ? [
            ...messages,
            {
              id: `run:${run.id}`,
              author: "assistant",
              content: run.streamedText ?? "",
              streaming: true,
            } as ChatTranscriptMessage,
          ]
        : messages,
    [hasProvisional, messages, run],
  );
  const layout = useMemo(() => {
    let top = 0;
    const rows: LayoutItem[] = items.map((item) => {
      const size = Math.max(48, heights.get(item.id) ?? estimateHeight(item));
      const row = { id: item.id, top, size, bottom: top + size };
      top += size + TRANSCRIPT_ROW_GAP_PX;
      return row;
    });
    return { rows, total: Math.max(0, top - (rows.length === 0 ? 0 : TRANSCRIPT_ROW_GAP_PX)) };
  }, [heights, items]);
  const range = useMemo(() => {
    const startAt = Math.max(0, scrollTop - VIRTUAL_OVERSCAN_PX);
    const endAt = scrollTop + viewportHeight + VIRTUAL_OVERSCAN_PX;
    let start = layout.rows.findIndex((row) => row.bottom >= startAt);
    if (start < 0) start = Math.max(0, layout.rows.length - 1);
    let end = layout.rows.findIndex((row, index) => index >= start && row.top > endAt);
    if (end < 0) end = layout.rows.length;
    return { start, end };
  }, [layout.rows, scrollTop, viewportHeight]);
  const visibleItems = items.slice(range.start, range.end);
  const updatePosition = useCallback(() => {
    const element = viewport.current;
    if (!element) return;
    const atBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight <= TRANSCRIPT_NEAR_BOTTOM_PX;
    setScrollTop(element.scrollTop);
    setViewportHeight(element.clientHeight || 640);
    setNearBottom(atBottom);
    if (atBottom) setUnread(0);
  }, []);
  const measure = useCallback((id: string, node: HTMLDivElement | null) => {
    const previous = observers.current.get(id);
    previous?.disconnect();
    if (node === null) {
      observers.current.delete(id);
      return;
    }
    const update = (height: number) =>
      setHeights((current) => {
        const nextHeight = Math.max(48, Math.ceil(height));
        if (current.get(id) === nextHeight) return current;
        const next = new Map(current);
        next.set(id, nextHeight);
        return next;
      });
    update(node.getBoundingClientRect().height);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const height = entries[0]?.contentRect.height;
      if (height !== undefined) update(height);
    });
    observer.observe(node);
    observers.current.set(id, observer);
  }, []);
  useEffect(
    () => () => {
      observers.current.forEach((observer) => observer.disconnect());
      observers.current.clear();
    },
    [],
  );
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    if (nearBottom) {
      element.scrollTop = element.scrollHeight;
      setScrollTop(element.scrollTop);
    }
  }, [items.length, layout.total, nearBottom, run?.streamedText]);
  useEffect(() => {
    if (messages.length > previousLength.current && !nearBottom)
      setUnread((count) => count + messages.length - previousLength.current);
    previousLength.current = messages.length;
  }, [messages.length, nearBottom]);
  useEffect(() => {
    const nextText = run?.streamedText ?? "";
    const changed = nextText !== previousStreamText.current;
    previousStreamText.current = nextText;
    if (changed && nextText.length > 0 && !nearBottom) setUnread((count) => Math.max(1, count));
  }, [nearBottom, run?.streamedText]);
  const focusedMessage = useRef<string | null>(null);
  useEffect(() => {
    if (focusMessageId === null) {
      focusedMessage.current = null;
      return;
    }
    if (focusedMessage.current === focusMessageId) return;
    const element = viewport.current;
    const row = layout.rows.find((candidate) => candidate.id === focusMessageId);
    if (!element || !row) return;
    element.scrollTop = row.top;
    setScrollTop(row.top);
    setNearBottom(false);

    let cancelled = false;
    const focusTarget = () => {
      if (cancelled || focusedMessage.current === focusMessageId) return;
      const target = [...element.querySelectorAll<HTMLElement>("[data-message-id]")].find(
        (node) => node.dataset.messageId === focusMessageId,
      );
      if (target) {
        focusedMessage.current = focusMessageId;
        target.tabIndex = -1;
        target.focus({ preventScroll: true });
      }
    };
    const frame =
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame(focusTarget)
        : window.setTimeout(focusTarget, 0);
    return () => {
      cancelled = true;
      if (typeof requestAnimationFrame === "function") cancelAnimationFrame(frame);
      else window.clearTimeout(frame);
    };
  }, [focusMessageId, layout.rows, range.end, range.start]);
  useEffect(() => {
    if (!run) return;
    if (run.status === "queued") announce.status(uiMessage(locale, "chat.runQueued"));
    else if (run.status === "running") announce.status(uiMessage(locale, "chat.runRunning"));
    else if (run.status === "succeeded")
      announce.status(uiMessage(locale, "chat.progress.status.complete"));
    else if (run.status === "stopped") announce.status(uiMessage(locale, "ui.stopped"));
    else if (run.status === "failed")
      announce.alert(run.error?.message ?? uiMessage(locale, "chat.progress.failed"));
  }, [announce, locale, run?.attempt, run?.error?.message, run?.status]);
  if (status === "loading")
    return (
      <div className={cn("flex min-h-48 items-center justify-center", className)} role="status">
        {uiMessage(locale, "chat.loading")}
      </div>
    );
  if (status === "error")
    return (
      <ErrorState
        title={uiMessage(locale, "chat.unavailable")}
        description={uiMessage(locale, "ui.tryAgain")}
        {...(onRetryLoad === undefined ? {} : { onRetry: onRetryLoad })}
        retryLabel={uiMessage(locale, "ui.retry")}
        {...(className === undefined ? {} : { className })}
      />
    );
  if (messages.length === 0 && !run)
    return (
      <div
        className={cn(
          "flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6 py-10",
          className,
        )}
        data-testid="chat-transcript"
      >
        <div className="w-full max-w-md animate-enter text-center">
          <Sparkles aria-hidden="true" className="mx-auto size-4 text-accent" />
          <h2 className="mt-3 font-display text-[22px] leading-tight font-medium text-ink">
            {resolvedEmptyTitle}
          </h2>
          {resolvedEmptyDescription && (
            <p className="mx-auto mt-1.5 max-w-sm text-[13px] leading-relaxed text-ink-2">
              {resolvedEmptyDescription}
            </p>
          )}
          {suggestions.length > 0 && (
            <div className="mt-5 grid gap-1.5 text-left">
              {suggestions.map((suggestion) => (
                <Button
                  key={suggestion}
                  variant="secondary"
                  className="justify-start text-left font-normal"
                  onClick={() => onSuggestion?.(suggestion)}
                >
                  {suggestion}
                </Button>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  const renderItem = (message: ChatTranscriptMessage, index: number) => {
    const isRun =
      message.id.startsWith("run:") ||
      (run !== null && message.id === provisionalId && message.streaming === true);
    const isLastAssistant =
      message.author === "assistant" &&
      !items.slice(index + 1).some((item) => item.author === "assistant");
    if (isRun && run)
      return (
        <article className="grid gap-3" aria-label={uiMessage(locale, "chat.progress.active")}>
          <header className="flex items-center gap-2">
            <p className="animate-pulse-soft font-mono text-[10px] tracking-[0.12em] text-ink-2 uppercase">
              {uiMessage(locale, "chat.author.assistant")} · …
            </p>
            <span aria-hidden="true" className="h-px flex-1 bg-line" />
            {onDebug && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={uiMessage(locale, "ui.showDiagnostics")}
                onClick={() => onDebug(run.id)}
              >
                <Bug className="size-3" aria-hidden="true" />
              </Button>
            )}
          </header>
          <RunActivity
            status={run.status}
            locale={locale}
            {...(run.stages === undefined ? {} : { stages: run.stages })}
            {...(run.attempt === undefined ? {} : { attempt: run.attempt })}
          />
          {(run.streamedText ?? message.content) && (
            <div className="min-h-24">
              <AnswerBody
                content={run.streamedText ?? message.content}
                sources={message.citations ?? []}
                locale={locale}
                {...(onCitation === undefined ? {} : { onCitation })}
                {...(copyAdapter === undefined ? {} : { copyAdapter })}
                streaming
              />
            </div>
          )}
          {run.status === "stopped" && (
            <p className="font-mono text-[11px] text-ink-2">
              {uiMessage(locale, "ui.answerStopped")}
            </p>
          )}
          {run.error && <FailureBlock failure={run.error} locale={locale} />}
        </article>
      );
    if (message.author === "user")
      return (
        <UserMessage
          message={message}
          {...(onDeleteMessage === undefined ? {} : { onDelete: onDeleteMessage })}
          {...(onRetryMessage === undefined || message.id !== lastUserId
            ? {}
            : { onRetry: onRetryMessage })}
          {...(message.id === lastUserId && canEditLastUser && onEditMessage !== undefined
            ? { onEdit: onEditMessage }
            : {})}
          locale={locale}
          canEdit={message.id === lastUserId && canEditLastUser}
        />
      );
    return (
      <AssistantMessage
        message={message}
        {...(onDeleteMessage === undefined ? {} : { onDelete: onDeleteMessage })}
        {...(onDebug === undefined ? {} : { onDebug })}
        {...(onShowVisualization === undefined ? {} : { onShowVisualization })}
        {...(onCitation === undefined ? {} : { onCitation })}
        {...(copyAdapter === undefined ? {} : { copyAdapter })}
        {...(isLastAssistant && lastUserMessage && onRetryMessage
          ? { onRegenerate: () => onRetryMessage(lastUserMessage) }
          : {})}
        locale={locale}
        isLast={isLastAssistant}
      />
    );
  };
  return (
    <div
      className={cn("relative min-h-0 flex-1", className)}
      data-testid="chat-transcript-shell"
      data-near-bottom-threshold={TRANSCRIPT_NEAR_BOTTOM_PX}
      data-virtualized="true"
    >
      <div
        ref={viewport}
        tabIndex={0}
        role="log"
        aria-live="off"
        aria-label={uiMessage(locale, "ui.conversation")}
        onScroll={updatePosition}
        className="h-full overflow-y-auto overflow-x-hidden px-4 py-5 sm:px-6"
        data-testid="chat-transcript"
      >
        <div
          className="mx-auto grid max-w-[52rem] gap-7 pb-6"
          style={{ height: layout.total, position: "relative" }}
          data-virtual-range={`${range.start}:${range.end}`}
        >
          {visibleItems.map((message, offset) => {
            const index = range.start + offset;
            const item = layout.rows[index];
            if (!item) return null;
            return (
              <div
                key={message.id}
                data-index={index}
                ref={(node) => measure(message.id, node)}
                className="vrow absolute left-0 w-full"
                style={{ transform: `translateY(${item.top}px)` }}
              >
                {renderItem(message, index)}
              </div>
            );
          })}
          {children}
        </div>
      </div>
      {!nearBottom && (
        <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2">
          <Button
            variant="secondary"
            size="icon"
            className={cn(
              "pointer-events-auto animate-enter rounded-full bg-surface hover:bg-paper",
              unread > 0 && "w-auto gap-1 px-2",
            )}
            onClick={() => {
              const element = viewport.current;
              if (element) element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
              setNearBottom(true);
              setUnread(0);
            }}
            aria-label={uiMessage(locale, "ui.jumpToLatest")}
          >
            <ArrowDown className="size-3" aria-hidden="true" />
            {unread > 0 && (
              <span aria-hidden="true" className="text-[10px] font-mono">
                {unread}
              </span>
            )}
          </Button>
        </div>
      )}
    </div>
  );
}
