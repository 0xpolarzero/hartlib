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
    <div className="brief-chat-row" data-author={message.author}>
      <div className="brief-chat-bubble" data-author={message.author}>
        <div className="brief-chat-meta">
          {isAssistant ? (
            <Bot className="brief-chat-meta-icon" aria-hidden="true" />
          ) : (
            <Users className="brief-chat-meta-icon" aria-hidden="true" />
          )}
          {isAssistant ? "Assistant" : "Client"}
        </div>
        <div className="brief-chat-content">{message.content}</div>
        {message.citations && message.citations.length > 0 ? (
          <div className="brief-chat-citations">
            {message.citations.map((citation) => (
              <a
                key={citation.id}
                href="#"
                onClick={(event) => event.preventDefault()}
                className="brief-chat-citation"
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
      className={cn("brief-chat-transcript", className)}
      style={{ height, overflowY: "auto" }}
      data-testid="chat-transcript"
    >
      <div className="brief-chat-virtual-canvas" style={{ height: `${virtualizer.getTotalSize()}px` }}>
        {virtualizer.getVirtualItems().map((virtualItem) => {
          const message = messages[virtualItem.index];
          if (!message) return null;

          return (
            <div
              key={message.id}
              ref={virtualizer.measureElement}
              data-index={virtualItem.index}
              className="brief-chat-virtual-item"
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
