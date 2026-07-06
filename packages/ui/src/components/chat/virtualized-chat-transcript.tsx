import { useVirtualizer } from "@tanstack/react-virtual";
import { Bot, Users } from "lucide-react";
import type { CSSProperties } from "react";
import { useLayoutEffect, useRef } from "react";

import { cn } from "../../lib/utils";

export type ChatTranscriptCitation = {
  id: string;
  label: string;
  page?: number | undefined;
};

export type ChatTranscriptMessage = {
  id: string;
  author: "user" | "assistant";
  content: string;
  citations?: readonly ChatTranscriptCitation[] | undefined;
};

export function ChatBubble({ message }: { message: ChatTranscriptMessage }) {
  const isAssistant = message.author === "assistant";

  return (
    <div
      className={cn("brief-chat-row flex", isAssistant ? "justify-start" : "justify-end")}
      data-author={message.author}
    >
      <div
        className={cn(
          "brief-chat-bubble max-w-[86%] rounded-sm border px-3 py-2",
          isAssistant ? "border-rule bg-paper text-ink" : "border-accent/25 bg-accent/10 text-ink",
        )}
        data-author={message.author}
      >
        <div
          className={cn(
            "brief-chat-meta mb-1.5 flex items-center gap-1.5 font-mono text-[11px] font-medium uppercase tracking-wider",
            isAssistant ? "text-muted" : "text-accent",
          )}
        >
          {isAssistant ? (
            <Bot className="brief-chat-meta-icon size-3" aria-hidden="true" />
          ) : (
            <Users className="brief-chat-meta-icon size-3" aria-hidden="true" />
          )}
          {isAssistant ? "Assistant" : "Client"}
        </div>
        <div className="brief-chat-content whitespace-pre-wrap font-serif text-sm leading-6">
          {message.content}
        </div>
        {message.citations && message.citations.length > 0 ? (
          <div className="brief-chat-citations mt-2 flex flex-wrap gap-x-2 gap-y-1">
            {message.citations.map((citation) => (
              <a
                key={citation.id}
                href="#"
                onClick={(event) => event.preventDefault()}
                className="brief-chat-citation font-mono text-[11px] text-accent underline decoration-accent/30 underline-offset-2 transition-transform duration-fast ease-snappy active:scale-[0.97] motion-reduce:transition-none motion-reduce:active:scale-100 [@media(hover:hover)_and_(pointer:fine)]:hover:decoration-accent"
              >
                {citation.label}
                {citation.page ? `, p. ${citation.page}` : null}
              </a>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function VirtualizedChatTranscript({
  messages,
  className,
  height = 544,
  estimateSize = 148,
  overscan = 6,
  scrollToLatest = true,
}: {
  messages: readonly ChatTranscriptMessage[];
  className?: string | undefined;
  height?: CSSProperties["height"] | undefined;
  estimateSize?: number | undefined;
  overscan?: number | undefined;
  scrollToLatest?: boolean | undefined;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => estimateSize,
    overscan,
  });

  useLayoutEffect(() => {
    if (!scrollToLatest || messages.length === 0) return;
    const scrollElement = parentRef.current;
    if (!scrollElement) return;

    const frame = window.requestAnimationFrame(() => {
      scrollElement.scrollTop = scrollElement.scrollHeight;
      virtualizer.scrollToIndex(messages.length - 1, { align: "end" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [messages.length, scrollToLatest, virtualizer]);

  return (
    <div
      ref={parentRef}
      className={cn("brief-chat-transcript rounded-sm border border-rule bg-canvas", className)}
      style={{ height, overflowY: "auto" }}
      data-testid="chat-transcript"
    >
      <div
        className="brief-chat-virtual-canvas relative"
        style={{ height: `${virtualizer.getTotalSize()}px` }}
      >
        {virtualizer.getVirtualItems().map((virtualItem) => {
          const message = messages[virtualItem.index];
          if (!message) return null;

          return (
            <div
              key={message.id}
              ref={virtualizer.measureElement}
              data-index={virtualItem.index}
              className="brief-chat-virtual-item absolute left-0 top-0 w-full px-3 py-2"
              style={{
                transform: `translateY(${virtualItem.start}px)`,
              }}
            >
              <ChatBubble message={message} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
