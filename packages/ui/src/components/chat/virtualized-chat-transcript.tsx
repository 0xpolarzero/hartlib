import { useVirtualizer } from "@tanstack/react-virtual";
import { Bot, ChevronDown, ChevronRight, Users } from "lucide-react";
import type { CSSProperties } from "react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";

import { FormattedMessage, useIntl } from "@brief/i18n";

import { parseCitationTags } from "./citation-tags";
import { cn } from "../../lib/utils";

export type ChatTranscriptCitation = {
  id: string;
  label: string;
  url: string | null;
  publishedAt: string | null;
  title?: string | null;
  sourceDisplayName?: string | null;
  page?: number | undefined;
};

export type ChatTranscriptContextBlock = {
  blockId: string;
  kind: "document" | "memory";
  label: string;
  tokenEstimate: number;
};

export type ChatTranscriptMessage = {
  id: string;
  author: "user" | "assistant";
  content: string;
  citations?: readonly ChatTranscriptCitation[] | undefined;
  contextBlocks?: readonly ChatTranscriptContextBlock[] | undefined;
  streaming?: boolean | undefined;
};

export function ChatBubble({ message }: { message: ChatTranscriptMessage }) {
  const isAssistant = message.author === "assistant";
  const intl = useIntl();
  const citationsById = useMemo(
    () => new Map((message.citations ?? []).map((citation) => [citation.id, citation])),
    [message.citations],
  );
  const parsed = useMemo(
    () => parseCitationTags(message.content, [...citationsById.keys()]),
    [citationsById, message.content],
  );

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
          {parsed.segments.map((segment, index) => {
            if (segment.type === "text") {
              return <span key={`text:${index}`}>{segment.text}</span>;
            }

            return (
              <span key={`cite:${index}`} className="brief-chat-inline-citations whitespace-nowrap">
                {segment.citationIds.map((citationId, citationIndex) => {
                  const citation = citationsById.get(citationId);
                  if (citation === undefined) return citationId;
                  return (
                    <CitationMarker
                      key={`${citationId}:${citationIndex}`}
                      citation={citation}
                      ariaLabel={intl.formatMessage(
                        { id: "chat.citationMarker" },
                        { label: citation.label },
                      )}
                    />
                  );
                })}
              </span>
            );
          })}
          {message.streaming ? (
            <span className="brief-chat-streaming-indicator ml-1 align-baseline font-mono text-[11px] text-muted">
              <FormattedMessage id="chat.streaming" />
            </span>
          ) : null}
        </div>
        {message.citations && message.citations.length > 0 ? (
          <div className="brief-chat-citations mt-2 flex flex-wrap gap-x-2 gap-y-1">
            {message.citations.map((citation) => (
              <CitationReference key={citation.id} citation={citation} />
            ))}
          </div>
        ) : null}
        {isAssistant && message.contextBlocks && message.contextBlocks.length > 0 ? (
          <SourcesRead contextBlocks={message.contextBlocks} />
        ) : null}
      </div>
    </div>
  );
}

function CitationMarker({
  citation,
  ariaLabel,
}: {
  citation: ChatTranscriptCitation;
  ariaLabel: string;
}) {
  const className =
    "brief-chat-citation-marker mx-0.5 inline-flex translate-y-[-0.28em] items-center rounded-sm border border-accent/25 px-1 font-mono text-[10px] font-medium leading-4 text-accent no-underline";
  const label = citation.id;

  if (citation.url) {
    return (
      <a
        href={citation.url}
        target="_blank"
        rel="noopener"
        className={className}
        aria-label={ariaLabel}
        title={citation.title ?? citation.label}
      >
        {label}
      </a>
    );
  }

  return (
    <span className={className} aria-label={ariaLabel} title={citation.title ?? citation.label}>
      {label}
    </span>
  );
}

function CitationReference({ citation }: { citation: ChatTranscriptCitation }) {
  const className =
    "brief-chat-citation font-mono text-[11px] text-accent underline decoration-accent/30 underline-offset-2 transition-transform duration-fast ease-snappy active:scale-[0.97] motion-reduce:transition-none motion-reduce:active:scale-100 [@media(hover:hover)_and_(pointer:fine)]:hover:decoration-accent";
  const content = (
    <>
      {citation.label}
      {citation.page ? `, p. ${citation.page}` : null}
      {citation.publishedAt ? ` · ${citation.publishedAt.slice(0, 10)}` : null}
    </>
  );

  if (citation.url) {
    return (
      <a href={citation.url} target="_blank" rel="noopener" className={className}>
        {content}
      </a>
    );
  }

  return <span className={cn(className, "no-underline")}>{content}</span>;
}

function SourcesRead({ contextBlocks }: { contextBlocks: readonly ChatTranscriptContextBlock[] }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="brief-chat-sources-read mt-2 border-t border-rule pt-2">
      <button
        type="button"
        className="inline-flex items-center gap-1 font-mono text-[11px] font-medium text-muted transition-colors duration-fast hover:text-accent"
        onClick={() => setExpanded((current) => !current)}
        aria-expanded={expanded}
      >
        {expanded ? (
          <ChevronDown className="size-3" aria-hidden="true" />
        ) : (
          <ChevronRight className="size-3" aria-hidden="true" />
        )}
        <FormattedMessage id="chat.sourcesRead" values={{ count: contextBlocks.length }} />
      </button>
      {expanded ? (
        <ul className="mt-1.5 space-y-1 border-l border-rule pl-2">
          {contextBlocks.map((block) => (
            <li key={block.blockId} className="text-xs leading-5 text-muted">
              <span className="font-mono text-[11px] text-faint">{block.blockId}</span>{" "}
              <span className="text-ink">{block.label}</span>{" "}
              <span className="font-mono text-[11px] text-faint">
                <FormattedMessage id={`chat.contextKind.${block.kind}`} /> ·{" "}
                <FormattedMessage id="chat.tokenEstimate" values={{ count: block.tokenEstimate }} />
              </span>
            </li>
          ))}
        </ul>
      ) : null}
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
