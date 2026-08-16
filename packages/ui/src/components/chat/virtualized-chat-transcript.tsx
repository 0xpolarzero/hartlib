import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, Bot, ChevronDown, ChevronRight, Globe2, Users } from "lucide-react";
import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { FormattedMessage, useIntl } from "@hartlib/i18n";
import type {
  AiRunActivityEvent,
  AiRunActivityStage,
  EffectiveWebPolicy,
  PublicContextConsumer,
  PublicCitationRecord,
  PublicSourceRecord,
  UserMessageRunOutcome,
} from "@hartlib/shared";

import { cn } from "../../lib/utils";
import { parseCitationTags, type CitationParseMode } from "./citation-tags";
import {
  publisherDocumentCitationTarget,
  type AuthenticatedDocumentOpener,
} from "./authenticated-document";
import { memoryRevisionFragment } from "./memory-provenance";

export type ChatTranscriptMessage =
  | {
      readonly id: string;
      readonly author: "user";
      readonly content: string;
      readonly run: UserMessageRunOutcome;
    }
  | {
      readonly id: string;
      readonly author: "assistant";
      readonly content: string;
      readonly citations: readonly PublicCitationRecord[];
      readonly sourcesRead: readonly PublicSourceRecord[];
      readonly activities?: readonly AiRunActivityEvent[];
      readonly diagnostics?: ChatRunDiagnostics;
      readonly activityFailure?: { readonly code: string; readonly retryable: boolean } | null;
      readonly streaming?: boolean;
    };

export type ChatTranscriptAuthorLabels = {
  readonly assistant: string;
  readonly client: string;
};

export type ChatRunDiagnostics = {
  readonly activityHistory?: readonly AiRunActivityEvent[];
  readonly context?: {
    readonly compactionRan: boolean;
    readonly consumers: readonly PublicContextConsumer[];
  } | null;
  readonly memoryUpdated?: {
    readonly created: number;
    readonly updated: number;
    readonly discarded: number;
  } | null;
  readonly sequence?: number;
};

const localizedFailureCodes = new Set([
  "agent_context_budget_exceeded",
  "context_mandatory_too_large",
  "context_plan_unfit",
  "context_compaction_failed",
  "context_assembly_failed",
  "context_budget_mismatch",
  "synthesis_budget_mismatch",
  "memory_conflict",
  "workflow_resume_incompatible",
]);

export const chatFailureMessageId = (code: string): string =>
  localizedFailureCodes.has(code) ? `chat.failure.${code}` : "chat.failure.generic";

const progressStages: readonly AiRunActivityStage[] = [
  "understanding",
  "evidence",
  "preparing",
  "writing",
  "finishing",
];

export const chatProgressStages = (
  activities: readonly AiRunActivityEvent[],
): readonly {
  readonly stage: AiRunActivityStage;
  readonly status: AiRunActivityEvent["status"];
}[] =>
  progressStages.flatMap((stage) => {
    const items = activities.filter((activity) => activity.stage === stage);
    if (items.length === 0) return [];
    const status = items.some((item) => item.status === "running")
      ? "running"
      : items.some((item) => item.status === "retrying")
        ? "retrying"
        : items.some((item) => item.status === "failed")
          ? "failed"
          : items.every((item) => item.status === "skipped")
            ? "skipped"
            : items.every((item) => item.status === "complete" || item.status === "skipped")
              ? "complete"
              : "waiting";
    return [{ stage, status }];
  });

const chatProgressStatusGlyph = (status: AiRunActivityEvent["status"]): string => {
  switch (status) {
    case "complete":
      return "✓";
    case "retrying":
      return "↻";
    case "failed":
      return "×";
    case "skipped":
      return "—";
    case "waiting":
      return "○";
    case "running":
      return "•";
  }
};

export const isChatTranscriptNearBottom = (
  metrics: {
    readonly scrollHeight: number;
    readonly scrollTop: number;
    readonly clientHeight: number;
  },
  threshold = 48,
): boolean => metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= threshold;

const sourceLabel = (source: PublicCitationRecord | PublicSourceRecord): string => {
  if (source.label !== null) return source.label;
  switch (source.kind) {
    case "document":
      return source.documentTitle;
    case "chat_message":
      return source.messageId;
    case "memory":
      return source.memoryId;
    case "web":
      return source.title;
  }
};

const sourceHref = (source: PublicCitationRecord | PublicSourceRecord): string => {
  switch (source.kind) {
    case "document":
    case "web":
      return source.url;
    case "chat_message":
      return `#message-${source.messageId}`;
    case "memory":
      return memoryRevisionFragment(source.memoryId, source.memoryRevisionId);
  }
};

const externalSourceLinkProps = (source: PublicCitationRecord | PublicSourceRecord) =>
  source.kind === "document" || source.kind === "web"
    ? ({
        target: "_blank",
        rel: "noopener noreferrer",
        referrerPolicy: "no-referrer",
      } as const)
    : {};

const citationMarkerUrlPrefix = "https://hartlib.invalid/inline-citation/";

const citationMarkerHref = (citationIds: readonly string[]): string =>
  `${citationMarkerUrlPrefix}${citationIds.join(",")}`;

const citationIdsFromMarkerHref = (href: string | undefined): readonly string[] | null => {
  if (href === undefined || !href.startsWith(citationMarkerUrlPrefix)) return null;
  const citationIds = href.slice(citationMarkerUrlPrefix.length).split(",");
  return citationIds.length > 0 && citationIds.every((id) => /^[A-Za-z0-9_-]+$/u.test(id))
    ? citationIds
    : null;
};

const markdownFromAssistantContent = (
  content: string,
  knownCitationIds: readonly string[],
  mode: CitationParseMode,
): string =>
  parseCitationTags(content, knownCitationIds, mode)
    .segments.map((segment) =>
      segment.type === "text"
        ? segment.text
        : `[citation](${citationMarkerHref(segment.citationIds)})`,
    )
    .join("");

function AssistantMarkdown({
  content,
  citationsById,
  citationNumbersById,
  citationMode,
  formatCitationLabel,
  onCitationClick,
}: {
  readonly content: string;
  readonly citationsById: ReadonlyMap<string, PublicCitationRecord>;
  readonly citationNumbersById: ReadonlyMap<string, number>;
  readonly citationMode: CitationParseMode;
  readonly formatCitationLabel: (citation: PublicCitationRecord) => string;
  readonly onCitationClick: (
    source: PublicCitationRecord | PublicSourceRecord,
    event: ReactMouseEvent<HTMLAnchorElement>,
  ) => void;
}) {
  const markdown = useMemo(
    () => markdownFromAssistantContent(content, [...citationsById.keys()], citationMode),
    [citationMode, citationsById, content],
  );

  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ node: _node, className, ...props }) => (
          <p {...props} className={cn("m-0 [&+p]:mt-3", className)} />
        ),
        ul: ({ node: _node, className, ...props }) => (
          <ul {...props} className={cn("my-3 list-disc pl-5", className)} />
        ),
        ol: ({ node: _node, className, ...props }) => (
          <ol {...props} className={cn("my-3 list-decimal pl-5", className)} />
        ),
        blockquote: ({ node: _node, className, ...props }) => (
          <blockquote
            {...props}
            className={cn("my-3 border-l-2 border-rule pl-3 text-muted", className)}
          />
        ),
        table: ({ node: _node, className, ...props }) => (
          <div className="my-3 overflow-x-auto">
            <table
              {...props}
              className={cn("w-full border-collapse text-left text-[13px]", className)}
            />
          </div>
        ),
        th: ({ node: _node, className, ...props }) => (
          <th {...props} className={cn("border-b border-rule px-2 py-1 font-medium", className)} />
        ),
        td: ({ node: _node, className, ...props }) => (
          <td {...props} className={cn("border-b border-rule/70 px-2 py-1 align-top", className)} />
        ),
        pre: ({ node: _node, className, ...props }) => (
          <pre
            {...props}
            className={cn(
              "my-3 overflow-x-auto rounded-sm border border-rule bg-canvas p-2 font-mono text-xs leading-5",
              className,
            )}
          />
        ),
        code: ({ node: _node, className, ...props }) => (
          <code
            {...props}
            className={cn("rounded-sm bg-canvas px-1 font-mono text-[0.9em]", className)}
          />
        ),
        img: ({ alt }) => (alt ? <span>{alt}</span> : null),
        a: ({ href, children, node: _node, className, ...props }) => {
          const citationIds = citationIdsFromMarkerHref(href);
          if (
            citationIds !== null &&
            citationIds.every(
              (sourceKey) => citationsById.has(sourceKey) && citationNumbersById.has(sourceKey),
            )
          ) {
            return (
              <span className="whitespace-nowrap">
                {citationIds.map((sourceKey, citationIndex) => {
                  const citation = citationsById.get(sourceKey);
                  const citationNumber = citationNumbersById.get(sourceKey);
                  if (citation === undefined || citationNumber === undefined) return null;
                  return (
                    <CitationMarker
                      key={`${sourceKey}:${citationIndex}`}
                      citation={citation}
                      citationNumber={citationNumber}
                      ariaLabel={formatCitationLabel(citation)}
                      onClick={onCitationClick}
                    />
                  );
                })}
              </span>
            );
          }

          const external = href !== undefined && /^https?:\/\//u.test(href);
          return (
            <a
              href={href}
              {...(external
                ? {
                    target: "_blank",
                    rel: "noopener noreferrer",
                    referrerPolicy: "no-referrer" as const,
                  }
                : {})}
              {...props}
              className={cn(
                "break-all text-accent underline decoration-accent/30 underline-offset-2",
                className,
              )}
            >
              {children}
            </a>
          );
        },
      }}
    >
      {markdown}
    </Markdown>
  );
}

export function ChatRunOutcome({
  run,
  onResubmit,
}: {
  readonly run: UserMessageRunOutcome;
  readonly onResubmit?: () => void;
}) {
  if (run.status === "succeeded") return null;

  if (run.status === "queued" || run.status === "running") {
    return (
      <p className="mt-2 font-mono text-[11px] text-muted" data-testid="chat-run-active">
        <FormattedMessage id={run.status === "queued" ? "chat.runQueued" : "chat.runRunning"} />
      </p>
    );
  }

  return (
    <div className="mt-2 border-t border-rule pt-2" data-testid="chat-run-failed">
      <p className="font-mono text-[11px] text-danger">
        <FormattedMessage
          id={chatFailureMessageId(run.errorCode)}
          values={{ code: run.errorCode }}
        />
      </p>
      {run.retryable && onResubmit ? (
        <button
          type="button"
          className="mt-1 font-mono text-[11px] text-accent underline underline-offset-2"
          onClick={onResubmit}
          data-testid="chat-run-resubmit"
        >
          <FormattedMessage id="chat.resubmit" />
        </button>
      ) : null}
    </div>
  );
}

export function ChatBubble({
  message,
  authorLabels,
  onResubmit,
  onOpenAuthenticatedDocument,
}: {
  readonly message: ChatTranscriptMessage;
  readonly authorLabels: ChatTranscriptAuthorLabels;
  readonly onResubmit?: (message: Extract<ChatTranscriptMessage, { author: "user" }>) => void;
  readonly onOpenAuthenticatedDocument?: AuthenticatedDocumentOpener;
}) {
  const isAssistant = message.author === "assistant";
  const activities = isAssistant ? (message.activities ?? []) : [];
  const activityFailure = isAssistant ? (message.activityFailure ?? null) : null;
  const intl = useIntl();
  const citations = isAssistant ? message.citations : [];
  const citationsById = useMemo(
    () => new Map(citations.map((citation) => [citation.sourceKey, citation])),
    [citations],
  );
  const citationNumbersById = useMemo(
    () => new Map(citations.map((citation, index) => [citation.sourceKey, index + 1])),
    [citations],
  );
  const [documentOpenFailed, setDocumentOpenFailed] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const progressStagesForMessage = useMemo(() => chatProgressStages(activities), [activities]);
  const diagnostics = isAssistant ? (message.diagnostics ?? {}) : {};
  const activityHistory = diagnostics.activityHistory ?? activities;
  const retryCount = activityHistory.filter((activity) => activity.status === "retrying").length;
  const maxAttempt = activityHistory.reduce(
    (maximum, activity) => Math.max(maximum, activity.attempt ?? 0),
    0,
  );
  const contextInputTokens =
    diagnostics.context?.consumers.reduce((total, consumer) => total + consumer.inputTokens, 0) ??
    0;
  const contextUsableTokens =
    diagnostics.context?.consumers.reduce(
      (total, consumer) => total + consumer.usableInputTokens,
      0,
    ) ?? 0;

  const handleSourceClick = (
    source: PublicCitationRecord | PublicSourceRecord,
    event: ReactMouseEvent<HTMLAnchorElement>,
  ) => {
    if (source.kind !== "document") return;
    const target = publisherDocumentCitationTarget(source.url);
    if (target === null) return;
    event.preventDefault();
    setDocumentOpenFailed(false);
    if (onOpenAuthenticatedDocument === undefined) {
      setDocumentOpenFailed(true);
      return;
    }
    void onOpenAuthenticatedDocument(target).catch(() => setDocumentOpenFailed(true));
  };

  return (
    <div
      id={`message-${message.id}`}
      className={cn("hartlib-chat-row flex", isAssistant ? "justify-start" : "justify-end")}
      data-author={message.author}
      data-testid={`chat-message-${message.author}`}
    >
      <div
        className={cn(
          "hartlib-chat-bubble max-w-[86%] rounded-sm border px-3 py-2",
          isAssistant ? "border-rule bg-paper text-ink" : "border-accent/25 bg-accent/10 text-ink",
        )}
      >
        <div
          className={cn(
            "mb-1.5 flex items-center gap-1.5 font-mono text-[11px] font-medium uppercase tracking-wider",
            isAssistant ? "text-muted" : "text-accent",
          )}
        >
          {isAssistant ? (
            <Bot className="size-3" aria-hidden="true" />
          ) : (
            <Users className="size-3" aria-hidden="true" />
          )}
          {isAssistant ? authorLabels.assistant : authorLabels.client}
        </div>
        <div
          className={cn(
            "font-serif text-sm leading-6",
            isAssistant ? "break-words" : "whitespace-pre-wrap",
          )}
          data-testid="chat-message-content"
        >
          {isAssistant ? (
            <AssistantMarkdown
              content={message.content}
              citationsById={citationsById}
              citationNumbersById={citationNumbersById}
              citationMode={message.streaming === true ? "streaming" : "final"}
              formatCitationLabel={(citation) =>
                intl.formatMessage({ id: "chat.citationMarker" }, { label: sourceLabel(citation) })
              }
              onCitationClick={handleSourceClick}
            />
          ) : (
            message.content
          )}
        </div>
        {isAssistant && message.streaming ? (
          <>
            <div
              className="mt-1 font-mono text-[11px] text-muted"
              data-testid="chat-provisional-draft"
              role="status"
              aria-live="polite"
            >
              <FormattedMessage
                id={
                  activityFailure === null
                    ? message.content === ""
                      ? "chat.progress.active"
                      : "chat.provisionalDraft"
                    : "chat.progress.failed"
                }
              />
            </div>
            {progressStagesForMessage.length > 0 ? (
              <ol
                className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px]"
                data-testid="chat-progress-stage-rail"
                aria-label={intl.formatMessage({ id: "chat.progress.rail" })}
              >
                {progressStagesForMessage.map(({ stage, status }) => (
                  <li
                    key={stage}
                    className={cn(
                      "inline-flex items-center gap-1",
                      status === "running"
                        ? "animate-pulse text-accent"
                        : status === "retrying"
                          ? "text-warning"
                          : status === "failed"
                            ? "text-danger"
                            : "text-muted",
                    )}
                    data-status={status}
                  >
                    <span aria-hidden="true">{chatProgressStatusGlyph(status)}</span>
                    <FormattedMessage id={`chat.progress.stage.${stage}`} />
                    <span className="sr-only">
                      <FormattedMessage id={`chat.progress.status.${status}`} />
                    </span>
                  </li>
                ))}
              </ol>
            ) : null}
            <details
              className="mt-2"
              open={diagnosticsOpen}
              onToggle={(event) => setDiagnosticsOpen(event.currentTarget.open)}
              data-testid="chat-progress-diagnostics"
            >
              <summary className="cursor-pointer font-mono text-[11px] text-accent">
                <FormattedMessage id="chat.progress.diagnostics" />
              </summary>
              <div
                className="mt-2 space-y-2 font-mono text-[11px]"
                data-testid="chat-progress-details"
              >
                <p className="text-muted">
                  <FormattedMessage
                    id="chat.progress.sources"
                    values={{ read: message.sourcesRead.length, cited: citations.length }}
                  />
                </p>
                <p className="text-muted">
                  <FormattedMessage
                    id="chat.progress.retries"
                    values={{ count: retryCount, attempt: maxAttempt }}
                  />
                </p>
                {diagnostics.context === null || diagnostics.context === undefined ? null : (
                  <p className="text-muted">
                    <FormattedMessage
                      id="chat.progress.context"
                      values={{
                        compaction: diagnostics.context.compactionRan
                          ? intl.formatMessage({ id: "chat.progress.context.compacted" })
                          : intl.formatMessage({ id: "chat.progress.context.fit" }),
                        consumers: diagnostics.context.consumers.length,
                        inputTokens: contextInputTokens,
                        usableTokens: contextUsableTokens,
                      }}
                    />
                  </p>
                )}
                {diagnostics.memoryUpdated === null ||
                diagnostics.memoryUpdated === undefined ? null : (
                  <p className="text-muted">
                    <FormattedMessage
                      id="chat.progress.memory"
                      values={{
                        created: diagnostics.memoryUpdated.created,
                        updated: diagnostics.memoryUpdated.updated,
                        discarded: diagnostics.memoryUpdated.discarded,
                      }}
                    />
                  </p>
                )}
                {diagnostics.sequence === undefined ? null : (
                  <p className="text-muted">
                    <FormattedMessage
                      id="chat.progress.sse"
                      values={{ sequence: diagnostics.sequence }}
                    />
                  </p>
                )}
                <ol
                  className="space-y-1.5 border-l border-rule pl-2"
                  data-testid="chat-progress-activities"
                >
                  {activityHistory.map((activity, index) => (
                    <li key={`${activity.code}:${activity.topicId ?? "all"}:${index}`}>
                      <span className="text-muted">
                        <FormattedMessage id={`chat.progress.code.${activity.code}`} />
                      </span>{" "}
                      <FormattedMessage id={`chat.progress.status.${activity.status}`} />
                      {activity.attempt === undefined ? null : ` · ${activity.attempt}`}
                      {activity.durationMs === undefined ? null : ` · ${activity.durationMs}ms`}
                      {activity.sourceCount === undefined ? null : ` · ${activity.sourceCount}`}
                      {activity.resultCount === undefined ? null : ` · ${activity.resultCount}`}
                    </li>
                  ))}
                </ol>
              </div>
            </details>
          </>
        ) : null}
        {isAssistant ? (
          <ChatSourcesRead sources={message.sourcesRead} onSourceClick={handleSourceClick} />
        ) : null}
        {documentOpenFailed ? (
          <p className="mt-2 font-mono text-[11px] text-danger" role="alert">
            <FormattedMessage id="chat.documentOpenFailed" />
          </p>
        ) : null}
        {!isAssistant ? (
          <ChatRunOutcome
            run={message.run}
            {...(onResubmit === undefined ? {} : { onResubmit: () => onResubmit(message) })}
          />
        ) : null}
      </div>
    </div>
  );
}

function CitationMarker({
  citation,
  citationNumber,
  ariaLabel,
  onClick,
}: {
  readonly citation: PublicCitationRecord;
  readonly citationNumber: number;
  readonly ariaLabel: string;
  readonly onClick: (
    source: PublicCitationRecord | PublicSourceRecord,
    event: ReactMouseEvent<HTMLAnchorElement>,
  ) => void;
}) {
  return (
    <a
      href={sourceHref(citation)}
      {...externalSourceLinkProps(citation)}
      onClick={(event) => onClick(citation, event)}
      className="mx-0.5 inline-flex translate-y-[-0.28em] items-center rounded-sm border border-accent/25 px-1 font-mono text-[10px] font-medium leading-4 text-accent no-underline"
      aria-label={ariaLabel}
      title={sourceLabel(citation)}
      data-testid="citation-marker"
    >
      [{citationNumber}]
    </a>
  );
}

export function ChatSourcesRead({
  sources,
  onSourceClick,
}: {
  readonly sources: readonly PublicSourceRecord[];
  readonly onSourceClick?: (
    source: PublicCitationRecord | PublicSourceRecord,
    event: ReactMouseEvent<HTMLAnchorElement>,
  ) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="mt-2 border-t border-rule pt-2">
      <button
        type="button"
        className="inline-flex items-center gap-1 font-mono text-[11px] font-medium text-muted hover:text-accent"
        onClick={() => setExpanded((current) => !current)}
        aria-expanded={expanded}
        data-testid="sources-read-toggle"
      >
        {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        <FormattedMessage id="chat.sourcesRead" values={{ count: sources.length }} />
      </button>
      {expanded ? (
        sources.length > 0 ? (
          <ul
            className="mt-1.5 space-y-1 border-l border-rule pl-2"
            data-testid="sources-read-list"
          >
            {sources.map((source) => (
              <li
                key={source.sourceKey}
                className="text-xs leading-5 text-muted"
                data-testid="source-read-item"
              >
                <a
                  href={sourceHref(source)}
                  {...externalSourceLinkProps(source)}
                  onClick={(event) => onSourceClick?.(source, event)}
                  className="text-ink underline decoration-rule underline-offset-2"
                >
                  {sourceLabel(source)}
                </a>{" "}
                <span className="font-mono text-[11px] text-faint">
                  <FormattedMessage id={`chat.contextKind.${source.kind}`} /> ·{" "}
                  <FormattedMessage id="chat.tokenCount" values={{ count: source.tokenCount }} />
                  {source.topicIds.length > 0 ? ` · ${source.topicIds.join(", ")}` : null}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1.5 text-xs text-muted" data-testid="sources-read-empty">
            <FormattedMessage id="chat.sourcesReadEmpty" />
          </p>
        )
      ) : null}
    </div>
  );
}

export function ChatWebSearchToggle({
  policy,
  checked,
  disabled = false,
  onChange,
}: {
  readonly policy: EffectiveWebPolicy;
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly onChange: (checked: boolean) => void;
}) {
  const unavailable = !policy.enabled;
  return (
    <label className="inline-flex items-center gap-2 font-mono text-[11px] text-muted">
      <input
        type="checkbox"
        checked={checked && !unavailable}
        disabled={disabled || unavailable}
        onChange={(event) => onChange(event.currentTarget.checked)}
        className="size-4 accent-accent"
        data-testid="chat-web-search-toggle"
      />
      <Globe2 className="size-3" aria-hidden="true" />
      <span>
        <FormattedMessage id="chat.webSearch" />
      </span>
      {unavailable ? (
        <span className="text-faint" data-testid="chat-web-search-disabled-reason">
          <FormattedMessage id={`chat.webPolicy.${policy.reason}`} />
        </span>
      ) : null}
    </label>
  );
}

export function VirtualizedChatTranscript({
  messages,
  authorLabels,
  onResubmit,
  onOpenAuthenticatedDocument,
  className,
  height = 544,
  estimateSize = 148,
  overscan = 6,
  scrollToLatest = true,
}: {
  readonly messages: readonly ChatTranscriptMessage[];
  readonly authorLabels: ChatTranscriptAuthorLabels;
  readonly onResubmit?: (message: Extract<ChatTranscriptMessage, { author: "user" }>) => void;
  readonly onOpenAuthenticatedDocument?: AuthenticatedDocumentOpener;
  readonly className?: string;
  readonly height?: CSSProperties["height"];
  readonly estimateSize?: number;
  readonly overscan?: number;
  readonly scrollToLatest?: boolean;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);
  const [nearBottom, setNearBottom] = useState(true);
  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => estimateSize,
    overscan,
  });

  useLayoutEffect(() => {
    if (!scrollToLatest || messages.length === 0) return;
    const scrollElement = parentRef.current;
    if (!scrollElement || !nearBottomRef.current) return;
    let followUpFrame: number | undefined;
    const frame = window.requestAnimationFrame(() => {
      if (!nearBottomRef.current) return;
      virtualizer.scrollToIndex(messages.length - 1, { align: "end" });
      followUpFrame = window.requestAnimationFrame(() => {
        if (nearBottomRef.current) scrollElement.scrollTop = scrollElement.scrollHeight;
      });
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (followUpFrame !== undefined) window.cancelAnimationFrame(followUpFrame);
    };
  }, [messages, scrollToLatest, virtualizer]);

  const updateBottomState = () => {
    const scrollElement = parentRef.current;
    if (!scrollElement) return;
    const next = isChatTranscriptNearBottom({
      scrollHeight: scrollElement.scrollHeight,
      scrollTop: scrollElement.scrollTop,
      clientHeight: scrollElement.clientHeight,
    });
    nearBottomRef.current = next;
    setNearBottom(next);
  };

  const jumpToLatest = () => {
    const scrollElement = parentRef.current;
    if (!scrollElement || messages.length === 0) return;
    nearBottomRef.current = true;
    setNearBottom(true);
    virtualizer.scrollToIndex(messages.length - 1, { align: "end" });
    window.requestAnimationFrame(() => {
      scrollElement.scrollTop = scrollElement.scrollHeight;
    });
  };

  return (
    <div
      className={cn("relative", className)}
      style={{ height }}
      data-testid="chat-transcript-shell"
    >
      <div
        ref={parentRef}
        className="h-full rounded-sm border border-rule bg-canvas"
        style={{ overflowY: "auto" }}
        onScroll={updateBottomState}
        data-testid="chat-transcript"
      >
        <div className="relative" style={{ height: `${virtualizer.getTotalSize()}px` }}>
          {virtualizer.getVirtualItems().map((virtualItem) => {
            const message = messages[virtualItem.index];
            if (!message) return null;
            return (
              <div
                key={message.id}
                ref={virtualizer.measureElement}
                data-index={virtualItem.index}
                className="absolute left-0 top-0 w-full px-3 py-2"
                style={{ transform: `translateY(${virtualItem.start}px)` }}
              >
                <ChatBubble
                  message={message}
                  authorLabels={authorLabels}
                  {...(onResubmit === undefined ? {} : { onResubmit })}
                  {...(onOpenAuthenticatedDocument === undefined
                    ? {}
                    : { onOpenAuthenticatedDocument })}
                />
              </div>
            );
          })}
        </div>
      </div>
      {!nearBottom && scrollToLatest ? (
        <button
          type="button"
          className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-sm border border-accent/40 bg-paper px-2 py-1 font-mono text-[11px] text-accent shadow-sm"
          onClick={jumpToLatest}
          data-testid="chat-jump-to-latest"
        >
          <ArrowDown className="size-3" aria-hidden="true" />
          <FormattedMessage id="chat.jumpToLatest" />
        </button>
      ) : null}
    </div>
  );
}
