import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";
import { useChat } from "./chat-store";
import { AssistantMessage, UserMessage } from "./message";
import { RunRail, RunStatusLine } from "./run-rail";
import { AnswerBody } from "./markdown";
import { SCRIPT_ARBITRATION_Q, SCRIPT_CHURN_Q, SCRIPT_GROWTH_Q, SCRIPT_RENEWAL_Q } from "@/services/mock/scripts";
import { Button } from "@/components/ui";

const RUN_ITEM = "__run__";

/**
 * Virtualized transcript (TanStack Virtual, dynamic measurement, overscan).
 * Scroll anchoring: stays pinned to the bottom while streaming if the
 * reader is already there; otherwise the scroll-to-latest button surfaces
 * with an unread count.
 */
export function Transcript() {
  const { t } = useI18n();
  const chat = useChat();
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  const items = [...chat.messages];
  if (chat.run) items.push({ id: RUN_ITEM } as (typeof items)[number]);

  const rowCount = items.length;
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => {
      const item = items[i];
      if (!item) return 120;
      if (item.id === RUN_ITEM) return 220;
      return item.role === "user" ? 80 : 140 + item.content.length * 0.55;
    },
    getItemKey: (i) => items[i]?.id ?? String(i),
    overscan: 6,
  });

  const maybeStick = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !atBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, []);

  // Stick to bottom while content grows (messages, stream text).
  useLayoutEffect(() => {
    maybeStick();
  });

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atEnd = distanceFromBottom <= 1;
    if (atEnd && !atBottomRef.current) {
      atBottomRef.current = true;
      chat.clearUnread();
      setAtBottom(true);
    } else if (!atEnd && atBottomRef.current) {
      atBottomRef.current = false;
      setAtBottom(false);
      if (chat.run) chat.bumpUnread();
    }
  };

  const lastRun = chat.run;
  const streamLen = lastRun?.streamedText.length ?? 0;
  useEffect(() => {
    // New assistant content while the reader is away: count one unread message.
    if (!atBottom && lastRun && streamLen > 0 && chat.unread === 0) chat.bumpUnread();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [atBottom, lastRun != null, streamLen, chat.unread]);

  const goLatest = () => {
    const el = scrollRef.current;
    if (!el) return;
    atBottomRef.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    chat.clearUnread();
    setAtBottom(true);
  };

  if (chat.messages.length === 0 && !chat.run) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6 py-10">
        <div className="w-full max-w-md animate-enter text-center">
          <Sparkles aria-hidden="true" className="mx-auto size-4 text-accent" />
          <h2 className="mt-3 font-display text-[22px] leading-tight font-medium text-ink">{t("chat.emptyTitle")}</h2>
          <p className="mx-auto mt-1.5 max-w-sm text-[13px] leading-relaxed text-ink-2">{t("chat.emptyBody")}</p>
          <div className="mt-5 grid gap-1.5 text-left">
            {[SCRIPT_GROWTH_Q, SCRIPT_ARBITRATION_Q, SCRIPT_RENEWAL_Q, SCRIPT_CHURN_Q].map((question) => (
              <Button key={question} variant="secondary" size="md" className="justify-start text-left font-normal" onClick={() => chat.send(question)}>
                {question}
              </Button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        onWheelCapture={(event) => {
          const el = scrollRef.current;
          if (!el || event.deltaY === 0 || el.scrollHeight <= el.clientHeight) return;

          const startingScrollTop = el.scrollTop;
          atBottomRef.current = false;
          setAtBottom(false);
          requestAnimationFrame(() => {
            const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
            if (el.scrollTop === startingScrollTop && distanceFromBottom <= 1) {
              atBottomRef.current = true;
              setAtBottom(true);
            }
          });
        }}
        onKeyDownCapture={(event) => {
          if (event.key === "PageUp" || event.key === "Home" || event.key === "ArrowUp") {
            atBottomRef.current = false;
            setAtBottom(false);
          }
        }}
        className="h-full overflow-y-auto overflow-x-hidden px-4 py-5 sm:px-6"
        tabIndex={0}
        role="log"
        aria-label={t("chat.transcriptLabel")}
        aria-live="off"
      >
        <div className="mx-auto grid max-w-[52rem] gap-7 pb-6" style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((row) => {
            const item = items[row.index];
            const isRun = item.id === RUN_ITEM;
            const isLastAssistant =
              item.role === "assistant" && !items.slice(row.index + 1).some((m) => m.role === "assistant");
            return (
              <div
                key={row.key}
                data-index={row.index}
                ref={virtualizer.measureElement}
                className="vrow absolute left-0 w-full"
                style={{ transform: `translateY(${row.start}px)` }}
              >
                {isRun && lastRun ? (
                  <article className="grid gap-3" aria-label={t("chat.answerLabel")}>
                    <header className="flex items-center gap-2">
                      <p className="animate-pulse-soft font-mono text-[10px] tracking-[0.12em] text-ink-2 uppercase">
                        {t("chat.assistantLabel")} · …
                      </p>
                      <span aria-hidden="true" className="h-px flex-1 bg-line" />
                    </header>
                    <RunRail stages={lastRun.stages} />
                    <RunStatusLine status={lastRun.status} attempt={lastRun.attempt} />
                    {lastRun.streamedText.length > 0 && (
                      <div className="min-h-24">
                        <AnswerBody content={lastRun.streamedText} sources={[]} streaming />
                      </div>
                    )}
                  </article>
                ) : item.role === "user" ? (
                  <UserMessage message={item} />
                ) : (
                  <AssistantMessage message={item} isLast={isLastAssistant} />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {!atBottom && (
        <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2">
          <Button
            variant="secondary"
            size="icon"
            className={cn(
              "pointer-events-auto animate-enter rounded-full bg-surface hover:bg-paper",
              chat.unread > 0 && "w-auto gap-1 px-2",
            )}
            onClick={goLatest}
            aria-label={t("chat.scrollLatest", { n: String(chat.unread) })}
          >
            <ArrowDown className="size-3" />
            {chat.unread > 0 && (
              <span aria-hidden="true" className="text-[10px] font-mono">
                {chat.unread}
              </span>
            )}
          </Button>
        </div>
      )}
    </div>
  );
}
