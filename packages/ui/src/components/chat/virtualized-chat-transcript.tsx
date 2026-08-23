import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ChevronDown, ChevronRight, Globe2, Users } from "lucide-react";
import type { CSSProperties, MouseEvent as ReactMouseEvent, SyntheticEvent } from "react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { FormattedMessage, useIntl } from "@hartlib/i18n";
import type {
  AiRunActivityEvent,
  AiRunActivityStage,
  AiRunErrorEvent,
  EffectiveWebPolicy,
  PublicContextConsumer,
  PublicCitationRecord,
  PublicAiRunDebug,
  PublicAiRunDebugResponse,
  PublicCitationQuote,
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
      readonly runId?: string;
      readonly citations: readonly PublicCitationRecord[];
      readonly sourcesRead: readonly PublicSourceRecord[];
      readonly activities?: readonly AiRunActivityEvent[];
      readonly diagnostics?: ChatRunDiagnostics;
      readonly activityFailure?: ChatActivityFailure | null;
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
  readonly terminalFailure?: ChatActivityFailure | null;
};

export type ChatAiRunDebugLoader = (runId: string) => Promise<PublicAiRunDebugResponse>;

type ChatActivityFailure = Omit<AiRunErrorEvent, "type">;

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
  progressStages.map((stage) => {
    const items = activities.filter((activity) => activity.stage === stage);
    if (items.length === 0) return { stage, status: "waiting" };
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
    return { stage, status };
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

const isCompletedProgressStatus = (status: AiRunActivityEvent["status"]): boolean =>
  status === "complete" || status === "skipped";

const completedStagePrefixLength = (
  stages: readonly ReturnType<typeof chatProgressStages>[number][],
): number => {
  let count = 0;
  for (const stage of stages) {
    if (!isCompletedProgressStatus(stage.status)) break;
    count += 1;
  }
  return count;
};

const activityErrorCategoryMessageId = (
  category: NonNullable<AiRunActivityEvent["errorCategory"]>,
): string => `chat.progress.error.category.${category}`;

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

const citationQuote = (citation: PublicCitationRecord): PublicCitationQuote => {
  return citation.quote;
};

/** Keep source-list ordinals identical to the ordinals rendered inline. */
export const citationNumbersBySourceKey = (
  citations: readonly PublicCitationRecord[],
): ReadonlyMap<string, number> =>
  new Map(citations.map((citation, index) => [citation.sourceKey, index + 1]));

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
  onLoadAiRunDebug,
}: {
  readonly run: UserMessageRunOutcome;
  readonly onResubmit?: () => void;
  readonly onLoadAiRunDebug?: ChatAiRunDebugLoader;
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
      {onLoadAiRunDebug === undefined ? null : (
        <ChatDebugDetails runId={run.id} load={onLoadAiRunDebug} />
      )}
    </div>
  );
}

function ChatProgressRail({
  stages,
}: {
  readonly stages: readonly ReturnType<typeof chatProgressStages>[number][];
}) {
  const intl = useIntl();
  const completedStages = completedStagePrefixLength(stages);
  const completedSegments = Math.max(0, completedStages - 1);
  const connectorFillPercent =
    progressStages.length <= 1
      ? 0
      : Math.round((completedSegments / (progressStages.length - 1)) * 100);

  return (
    <div
      className="relative mt-3 w-full"
      data-testid="chat-progress-stage-rail"
      data-completed-stages={completedStages}
      aria-label={intl.formatMessage({ id: "chat.progress.rail" })}
      role="group"
    >
      <span
        className="pointer-events-none absolute left-[10%] right-[10%] top-2 z-0 h-px bg-rule"
        data-testid="chat-progress-connector"
        aria-hidden="true"
      >
        <span
          className="absolute inset-y-0 left-0 h-px bg-accent transition-[width] duration-200 ease-out"
          data-testid="chat-progress-connector-fill"
          data-fill-percent={connectorFillPercent}
          style={{ width: `${connectorFillPercent}%` }}
        />
      </span>
      <ol
        className="relative z-10 grid w-full grid-cols-5 gap-1 font-mono text-[10px] leading-4 sm:gap-2 sm:text-[11px]"
        aria-label={intl.formatMessage({ id: "chat.progress.rail" })}
      >
        {stages.map(({ stage, status }) => (
          <li
            key={stage}
            className={cn(
              "min-w-0 text-center",
              status === "running"
                ? "animate-pulse text-accent"
                : status === "complete"
                  ? "text-accent"
                  : status === "retrying"
                    ? "text-warning"
                    : status === "failed"
                      ? "text-danger"
                      : "text-muted",
            )}
            data-stage={stage}
            data-status={status}
            aria-label={`${intl.formatMessage({ id: `chat.progress.stage.${stage}` })}: ${intl.formatMessage({ id: `chat.progress.status.${status}` })}`}
          >
            <span
              className="relative mx-auto flex size-4 items-center justify-center"
              aria-hidden="true"
            >
              {chatProgressStatusGlyph(status)}
            </span>
            <span className="block break-words">
              <FormattedMessage id={`chat.progress.stage.${stage}`} />
            </span>
            <span className="sr-only">
              <FormattedMessage id={`chat.progress.status.${status}`} />
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function ChatAnswerCompletion({
  sourcesRead,
  cited,
}: {
  readonly sourcesRead: number;
  readonly cited: number;
}) {
  return (
    <div
      className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-muted"
      data-testid="chat-answer-completion"
      role="status"
    >
      <span className="font-medium text-accent" data-testid="chat-answer-ready">
        <FormattedMessage id="chat.answerReady" />
      </span>
      <span aria-hidden="true" className="text-faint">
        ·
      </span>
      <span data-testid="chat-answer-sources-read">
        <FormattedMessage id="chat.answerSourcesRead" values={{ count: sourcesRead }} />
      </span>
      <span aria-hidden="true" className="text-faint">
        ·
      </span>
      <span data-testid="chat-answer-sources-cited">
        <FormattedMessage id="chat.answerSourcesCited" values={{ count: cited }} />
      </span>
    </div>
  );
}

const debugStageLabel = (stage: PublicAiRunDebug["stages"][number]["stage"]): string =>
  `chat.progress.stage.${stage}`;

const debugEventStageLabel = (stage: PublicAiRunDebug["history"][number]["stage"]): string =>
  stage === "terminal" ? "chat.debug.terminal" : `chat.progress.stage.${stage}`;

const debugStatusLabel = (status: PublicAiRunDebug["status"]): string =>
  `chat.debug.status.${status}`;

const debugEventStatusLabel = (status: PublicAiRunDebug["history"][number]["status"]): string =>
  status === "done"
    ? "chat.debug.status.done"
    : status === "terminal"
      ? "chat.debug.terminal"
      : `chat.progress.status.${status}`;

const debugValue = (value: string | number | null): string | number => value ?? "—";

const debugCategoryValue = (
  intl: ReturnType<typeof useIntl>,
  category: PublicAiRunDebug["history"][number]["errorCategory"],
): string =>
  category === null
    ? intl.formatMessage({ id: "chat.debugUnavailableValue" })
    : intl.formatMessage({ id: `chat.progress.error.category.${category}` });

function ChatDebugDetails({
  runId,
  load,
}: {
  readonly runId: string;
  readonly load: ChatAiRunDebugLoader;
}) {
  const intl = useIntl();
  const disclosureId = useId();
  const detailsId = `${disclosureId}-details`;
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<
    | { readonly status: "idle" | "loading" | "error" }
    | { readonly status: "ready"; readonly debug: PublicAiRunDebug }
    | { readonly status: "unavailable" }
  >({ status: "idle" });
  const loadGeneration = useRef(0);

  useEffect(() => {
    loadGeneration.current += 1;
    setOpen(false);
    setState({ status: "idle" });
  }, [runId]);

  const loadDebug = () => {
    const generation = ++loadGeneration.current;
    setState({ status: "loading" });
    void load(runId)
      .then((response) => {
        if (generation !== loadGeneration.current) return;
        setState(
          response.available
            ? { status: "ready", debug: response.debug }
            : { status: "unavailable" },
        );
      })
      .catch(() => {
        if (generation === loadGeneration.current) setState({ status: "error" });
      });
  };

  const handleToggle = (event: SyntheticEvent<HTMLDetailsElement>) => {
    const nextOpen = event.currentTarget.open;
    setOpen(nextOpen);
    if (!nextOpen || state.status !== "idle") return;
    loadDebug();
  };

  const debug = state.status === "ready" ? state.debug : null;
  const attempts =
    debug === null
      ? 0
      : debug.stages.reduce((maximum, stage) => Math.max(maximum, stage.attempt ?? 0), 0);
  const contextLabel =
    debug?.context.compactionRan === true
      ? intl.formatMessage({ id: "chat.debug.compacted" })
      : debug?.context.compactionRan === false
        ? intl.formatMessage({ id: "chat.debug.fit" })
        : intl.formatMessage({ id: "chat.debugUnavailableValue" });

  return (
    <details
      className="mt-3 border-t border-rule pt-2"
      open={open}
      onToggle={handleToggle}
      data-testid="chat-debug-details"
    >
      <summary
        className="inline-flex cursor-pointer list-none items-center gap-1 font-mono text-[11px] font-medium text-muted hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden"
        id={disclosureId}
        aria-controls={detailsId}
        aria-expanded={open}
        data-testid="chat-debug-toggle"
      >
        {open ? (
          <ChevronDown className="size-3" aria-hidden="true" />
        ) : (
          <ChevronRight className="size-3" aria-hidden="true" />
        )}
        <FormattedMessage id="chat.debugDetails" />
      </summary>
      <div
        id={detailsId}
        className="mt-2 space-y-3 font-mono text-[11px]"
        role="region"
        aria-labelledby={disclosureId}
        data-testid="chat-debug-panel"
      >
        {state.status === "loading" ? (
          <p
            className="text-muted"
            role="status"
            aria-live="polite"
            data-testid="chat-debug-loading"
          >
            <FormattedMessage id="chat.debugLoading" />
          </p>
        ) : state.status === "error" ? (
          <div className="space-y-1" role="status">
            <p className="text-muted">
              <FormattedMessage id="chat.debugLoadFailed" />
            </p>
            <button
              type="button"
              className="text-accent underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              onClick={loadDebug}
              data-testid="chat-debug-retry"
            >
              <FormattedMessage id="chat.debugRetry" />
            </button>
          </div>
        ) : state.status === "unavailable" ? (
          <p className="text-muted" role="status" data-testid="chat-debug-unavailable">
            <FormattedMessage id="chat.debugUnavailable" />
          </p>
        ) : debug === null ? null : (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="chat-debug-summary">
              <div className="min-w-0 border border-rule px-2 py-1.5">
                <span className="block text-[10px] uppercase text-muted">
                  <FormattedMessage id="chat.debug.outcome" />
                </span>
                <strong className="mt-0.5 block truncate text-ink">
                  <FormattedMessage id={debugStatusLabel(debug.status)} />
                </strong>
              </div>
              <div className="min-w-0 border border-rule px-2 py-1.5">
                <span className="block text-[10px] uppercase text-muted">
                  <FormattedMessage id="chat.debug.attempts" />
                </span>
                <strong className="mt-0.5 block truncate text-ink">{attempts}</strong>
              </div>
              <div className="min-w-0 border border-rule px-2 py-1.5">
                <span className="block text-[10px] uppercase text-muted">
                  <FormattedMessage id="chat.debug.sources" />
                </span>
                <strong className="mt-0.5 block truncate text-ink">
                  {debug.sourceSummary.read} · {debug.sourceSummary.cited}
                </strong>
              </div>
              <div className="min-w-0 border border-rule px-2 py-1.5">
                <span className="block text-[10px] uppercase text-muted">
                  <FormattedMessage id="chat.debug.context" />
                </span>
                <strong className="mt-0.5 block truncate text-ink">{contextLabel}</strong>
              </div>
            </div>
            <div className="space-y-1 border-t border-rule pt-2" data-testid="chat-debug-stages">
              {debug.stages.map((stage) => (
                <div key={stage.stage} className="min-w-0 border-b border-rule/70 py-1">
                  <div className="grid min-w-0 gap-1 sm:grid-cols-[minmax(7rem,1fr)_minmax(6rem,1fr)_auto] sm:items-center sm:gap-2">
                    <span className="truncate text-ink">
                      <FormattedMessage id={debugStageLabel(stage.stage)} />
                    </span>
                    <span className="text-muted">
                      <FormattedMessage id={`chat.progress.status.${stage.status}`} />
                    </span>
                    <span className="text-faint">
                      {stage.durationMs === null ? "—" : `${stage.durationMs}ms`}
                      {stage.attempt === null
                        ? ""
                        : ` · ${intl.formatMessage({ id: "chat.debug.attemptShort" }, { count: stage.attempt })}`}
                    </span>
                  </div>
                  <p className="mt-1 break-words text-faint">
                    <FormattedMessage
                      id="chat.debug.stageMetrics"
                      values={{
                        sources: debugValue(stage.sourceCount),
                        results: debugValue(stage.resultCount),
                        error: debugValue(stage.errorCode),
                        category: debugCategoryValue(intl, stage.errorCategory),
                      }}
                    />
                  </p>
                </div>
              ))}
            </div>
            <div
              className="grid gap-1 border-t border-rule pt-2 text-muted sm:grid-cols-3"
              data-testid="chat-debug-times"
            >
              <span>
                <FormattedMessage
                  id="chat.debug.startedAt"
                  values={{ value: debugValue(debug.startedAt) }}
                />
              </span>
              <span>
                <FormattedMessage
                  id="chat.debug.finishedAt"
                  values={{ value: debugValue(debug.finishedAt) }}
                />
              </span>
              <span>
                <FormattedMessage
                  id="chat.debug.failedAt"
                  values={{ value: debugValue(debug.failedAt) }}
                />
              </span>
            </div>
            <div className="grid gap-1 text-muted sm:grid-cols-2">
              <span>
                <FormattedMessage
                  id="chat.debug.contextSummary"
                  values={{
                    consumers: debug.context.consumers,
                    inputTokens: debug.context.inputTokens ?? "—",
                    usableInputTokens: debug.context.usableInputTokens ?? "—",
                  }}
                />
              </span>
              <span>
                <FormattedMessage
                  id="chat.debug.sourceSummary"
                  values={{
                    read: debug.sourceSummary.read,
                    cited: debug.sourceSummary.cited,
                    uncited: debug.sourceSummary.uncited,
                  }}
                />
              </span>
              <span>
                <FormattedMessage
                  id="chat.debug.memorySummary"
                  values={{
                    created: debug.memory?.created ?? "—",
                    updated: debug.memory?.updated ?? "—",
                    discarded: debug.memory?.discarded ?? "—",
                  }}
                />
              </span>
              <span>
                <FormattedMessage
                  id="chat.debug.usageSummary"
                  values={{
                    modelInputTokens: debug.usage?.modelInputTokens ?? "—",
                    modelOutputTokens: debug.usage?.modelOutputTokens ?? "—",
                    webSearches: debug.usage?.webSearches ?? "—",
                    webFetches: debug.usage?.webFetches ?? "—",
                    webResponseBytes: debug.usage?.webResponseBytes ?? "—",
                  }}
                />
              </span>
            </div>
            {debug.terminalError === null ? null : (
              <div className="space-y-1 text-danger" data-testid="chat-debug-terminal-error">
                <p>
                  <FormattedMessage
                    id="chat.debug.terminalError"
                    values={{
                      code: debug.terminalError.code,
                      message: debugValue(debug.terminalError.message),
                    }}
                  />
                </p>
                <p>
                  <FormattedMessage
                    id="chat.debug.terminalRetryable"
                    values={{
                      value: debug.terminalError.retryable
                        ? intl.formatMessage({ id: "chat.debug.yes" })
                        : intl.formatMessage({ id: "chat.debug.no" }),
                    }}
                  />
                  {" · "}
                  <FormattedMessage
                    id="chat.debug.terminalCategory"
                    values={{ value: debugCategoryValue(intl, debug.terminalError.category) }}
                  />
                </p>
                <p>
                  <FormattedMessage
                    id="chat.debug.terminalMessage"
                    values={{ value: debugValue(debug.terminalError.message) }}
                  />
                </p>
              </div>
            )}
            {debug.history.length === 0 ? null : (
              <details className="border-t border-rule pt-2" data-testid="chat-debug-history">
                <summary className="cursor-pointer text-accent">
                  <FormattedMessage
                    id="chat.debug.history"
                    values={{ count: debug.history.length }}
                  />
                </summary>
                <ol
                  className="mt-2 max-h-64 space-y-1 overflow-y-auto border-l border-rule pl-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  tabIndex={0}
                  aria-label={intl.formatMessage({ id: "chat.debug.historyLabel" })}
                >
                  {debug.history.map((event, index) => (
                    <li
                      key={`${event.code}:${event.occurredAt ?? ""}:${index}`}
                      className="break-words text-muted"
                    >
                      <div>
                        <span className="text-ink">
                          <FormattedMessage id={debugEventStageLabel(event.stage)} />
                        </span>{" "}
                        · {event.code} ·{" "}
                        <FormattedMessage id={debugEventStatusLabel(event.status)} />
                        {event.topicId === null ? null : ` · ${event.topicId}`}
                        {event.occurredAt === null ? null : ` · ${event.occurredAt}`}
                        {event.durationMs === null ? null : ` · ${event.durationMs}ms`}
                      </div>
                      <div className="text-faint">
                        <FormattedMessage
                          id="chat.debug.eventMetrics"
                          values={{
                            attempt: debugValue(event.attempt),
                            sources: debugValue(event.sourceCount),
                            results: debugValue(event.resultCount),
                            error: debugValue(event.errorCode),
                            category: debugCategoryValue(intl, event.errorCategory),
                          }}
                        />
                      </div>
                    </li>
                  ))}
                </ol>
              </details>
            )}
            <p className="text-faint">
              <FormattedMessage
                id="chat.debug.runCursor"
                values={{ runId: debug.runId, sequence: debug.lastSequence ?? "—" }}
              />
            </p>
          </>
        )}
      </div>
    </details>
  );
}

export function ChatBubble({
  message,
  authorLabels,
  onResubmit,
  onOpenAuthenticatedDocument,
  onLoadAiRunDebug,
}: {
  readonly message: ChatTranscriptMessage;
  readonly authorLabels: ChatTranscriptAuthorLabels;
  readonly onResubmit?: (message: Extract<ChatTranscriptMessage, { author: "user" }>) => void;
  readonly onOpenAuthenticatedDocument?: AuthenticatedDocumentOpener;
  readonly onLoadAiRunDebug?: ChatAiRunDebugLoader;
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
  const citationNumbersById = useMemo(() => citationNumbersBySourceKey(citations), [citations]);
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
      className={cn("hartlib-chat-row flex w-full", isAssistant ? "justify-start" : "justify-end")}
      data-author={message.author}
      data-testid={`chat-message-${message.author}`}
    >
      <div
        className={cn(
          "hartlib-chat-bubble text-ink",
          isAssistant
            ? "w-full max-w-[72ch] px-0 py-1"
            : "max-w-[86%] rounded-sm border border-accent/25 bg-accent/10 px-3 py-2",
        )}
        role="group"
        aria-labelledby={`chat-message-${message.id}-author`}
        data-testid={isAssistant ? "chat-assistant-answer-column" : "chat-user-bubble"}
      >
        <div
          id={`chat-message-${message.id}-author`}
          className={cn(
            "mb-1.5 font-mono text-[11px] font-medium uppercase tracking-wider",
            isAssistant ? "text-muted" : "text-accent",
          )}
        >
          {isAssistant ? (
            authorLabels.assistant
          ) : (
            <span className="inline-flex items-center gap-1.5">
              <Users className="size-3" aria-hidden="true" />
              {authorLabels.client}
            </span>
          )}
        </div>
        {isAssistant && message.streaming ? (
          <>
            <ChatProgressRail stages={progressStagesForMessage} />
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
          </>
        ) : null}
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
        {isAssistant && !message.streaming ? (
          <ChatAnswerCompletion sourcesRead={message.sourcesRead.length} cited={citations.length} />
        ) : null}
        {isAssistant && !message.streaming && message.runId !== undefined && onLoadAiRunDebug ? (
          <ChatDebugDetails runId={message.runId} load={onLoadAiRunDebug} />
        ) : null}
        {isAssistant && message.streaming ? (
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
              {diagnostics.terminalFailure === null ||
              diagnostics.terminalFailure === undefined ? null : (
                <p className="text-danger" data-testid="chat-progress-terminal-error">
                  <FormattedMessage
                    id="chat.progress.error.terminal"
                    values={{
                      code: diagnostics.terminalFailure.code,
                      category:
                        diagnostics.terminalFailure.errorCategory === undefined
                          ? ""
                          : intl.formatMessage({
                              id: activityErrorCategoryMessageId(
                                diagnostics.terminalFailure.errorCategory,
                              ),
                            }),
                      message: diagnostics.terminalFailure.errorMessage ?? "",
                    }}
                  />
                  {diagnostics.terminalFailure.runId === undefined ? null : (
                    <span data-testid="chat-progress-terminal-run-id">
                      {" · "}
                      <FormattedMessage
                        id="chat.progress.error.run"
                        values={{ runId: diagnostics.terminalFailure.runId }}
                      />
                    </span>
                  )}
                  {diagnostics.terminalFailure.occurredAt === undefined ? null : (
                    <span data-testid="chat-progress-terminal-time">
                      {" · "}
                      <FormattedMessage
                        id="chat.progress.error.time"
                        values={{ timestamp: diagnostics.terminalFailure.occurredAt }}
                      />
                    </span>
                  )}
                  {diagnostics.terminalFailure.stage === undefined ? null : (
                    <span>
                      {" · "}
                      <FormattedMessage
                        id={`chat.progress.stage.${diagnostics.terminalFailure.stage}`}
                      />
                    </span>
                  )}
                  {diagnostics.terminalFailure.attempt === undefined ? null : (
                    <span>
                      {" · "}
                      <FormattedMessage
                        id="chat.progress.error.attempt"
                        values={{ attempt: diagnostics.terminalFailure.attempt }}
                      />
                    </span>
                  )}
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
                    {activity.attempt === undefined ? null : (
                      <span>
                        {" · "}
                        <FormattedMessage
                          id="chat.progress.error.attempt"
                          values={{ attempt: activity.attempt }}
                        />
                      </span>
                    )}
                    {activity.durationMs === undefined ? null : ` · ${activity.durationMs}ms`}
                    {activity.sourceCount === undefined ? null : ` · ${activity.sourceCount}`}
                    {activity.resultCount === undefined ? null : ` · ${activity.resultCount}`}
                    {activity.runId === undefined ? null : (
                      <span data-testid="chat-progress-run-id">
                        {" · "}
                        <FormattedMessage
                          id="chat.progress.error.run"
                          values={{ runId: activity.runId }}
                        />
                      </span>
                    )}
                    {activity.occurredAt === undefined ? null : (
                      <span data-testid="chat-progress-error-time">
                        {" · "}
                        <FormattedMessage
                          id="chat.progress.error.time"
                          values={{ timestamp: activity.occurredAt }}
                        />
                      </span>
                    )}
                    {activity.errorCode === undefined &&
                    activity.errorCategory === undefined &&
                    activity.errorMessage === undefined ? null : (
                      <span
                        className="block pl-2 text-danger"
                        data-testid="chat-progress-failure-details"
                      >
                        {activity.errorCode === undefined ? null : (
                          <span>
                            <FormattedMessage
                              id="chat.progress.error.code"
                              values={{ code: activity.errorCode }}
                            />
                          </span>
                        )}
                        {activity.errorCategory === undefined ? null : (
                          <span>
                            {" · "}
                            <FormattedMessage
                              id={activityErrorCategoryMessageId(activity.errorCategory)}
                            />
                          </span>
                        )}
                        {activity.errorMessage === undefined ? null : (
                          <span>
                            {" · "}
                            {activity.errorMessage}
                          </span>
                        )}
                      </span>
                    )}
                  </li>
                ))}
              </ol>
            </div>
          </details>
        ) : null}
        {isAssistant ? (
          <ChatSourcesRead
            sources={message.sourcesRead}
            citations={citations}
            onSourceClick={handleSourceClick}
          />
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
            {...(onLoadAiRunDebug === undefined ? {} : { onLoadAiRunDebug })}
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
  citations = [],
  onSourceClick,
}: {
  readonly sources: readonly PublicSourceRecord[];
  readonly citations?: readonly PublicCitationRecord[];
  readonly onSourceClick?: (
    source: PublicCitationRecord | PublicSourceRecord,
    event: ReactMouseEvent<HTMLAnchorElement>,
  ) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const intl = useIntl();
  const disclosureId = useId();
  const labelId = `${disclosureId}-label`;
  const listId = `${disclosureId}-list`;
  const citationNumbersById = useMemo(() => citationNumbersBySourceKey(citations), [citations]);
  const citationsById = useMemo(
    () => new Map(citations.map((citation) => [citation.sourceKey, citation])),
    [citations],
  );

  return (
    <details
      className="mt-2 border-t border-rule pt-2"
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
      data-testid="sources-read-disclosure"
    >
      <summary
        className="inline-flex cursor-pointer list-none items-center gap-1 font-mono text-[11px] font-medium text-muted hover:text-accent [&::-webkit-details-marker]:hidden"
        id={labelId}
        aria-controls={listId}
        aria-expanded={expanded}
        data-testid="sources-read-toggle"
      >
        {expanded ? (
          <ChevronDown className="size-3" aria-hidden="true" />
        ) : (
          <ChevronRight className="size-3" aria-hidden="true" />
        )}
        <FormattedMessage id="chat.sourcesRead" values={{ count: sources.length }} />
      </summary>
      {sources.length > 0 ? (
        <ul
          className="mt-1.5 space-y-1 border-l border-rule pl-2"
          data-testid="sources-read-list"
          id={listId}
          role="region"
          aria-labelledby={labelId}
        >
          {sources.map((source) => {
            const citationNumber = citationNumbersById.get(source.sourceKey);
            const citation = citationsById.get(source.sourceKey);
            const quote = citation === undefined ? null : citationQuote(citation);
            return (
              <li
                key={source.sourceKey}
                className="text-xs leading-5 text-muted"
                data-testid="source-read-item"
              >
                {citationNumber === undefined ? (
                  <span className="mr-1 font-mono text-[11px] text-faint" data-cited="false">
                    <FormattedMessage id="chat.sourceReadUncited" />
                  </span>
                ) : (
                  <span
                    className="mr-1 font-mono text-[11px] text-accent"
                    data-cited="true"
                    aria-label={intl.formatMessage(
                      { id: "chat.sourceCitationNumber" },
                      { number: citationNumber },
                    )}
                  >
                    [{citationNumber}]
                  </span>
                )}
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
                {citation === undefined ? null : (
                  <div
                    className="mt-1 border-l-2 border-accent/30 bg-accent/5 px-2 py-1.5 text-xs text-muted"
                    data-testid="citation-quote"
                  >
                    <span className="font-mono text-[10px] font-medium uppercase tracking-wide text-accent">
                      <FormattedMessage id="chat.citationQuote" />
                    </span>
                    {quote === null ? (
                      <span
                        className="mt-0.5 block text-muted"
                        data-testid="citation-quote-unavailable"
                      >
                        <FormattedMessage id="chat.citationQuoteUnavailable" />
                      </span>
                    ) : (
                      <q className="mt-0.5 block break-words font-serif text-sm leading-5 text-ink">
                        {quote.text}
                      </q>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p
          className="mt-1.5 text-xs text-muted"
          data-testid="sources-read-empty"
          id={listId}
          role="region"
          aria-labelledby={labelId}
        >
          <FormattedMessage id="chat.sourcesReadEmpty" />
        </p>
      )}
    </details>
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
  onLoadAiRunDebug,
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
  /** Owner-authorized lazy loader; omitted for shared viewers. */
  readonly onLoadAiRunDebug?: ChatAiRunDebugLoader;
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
                  {...(onLoadAiRunDebug === undefined ? {} : { onLoadAiRunDebug })}
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
