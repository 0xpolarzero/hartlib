import { createRoot } from "react-dom/client";
import { RotateCcw, Send } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ApiResponseError, createProductApiClient } from "@brief/api-client";
import {
  clearRunStreamState,
  persistRunStreamState,
  restoreRunStreamState,
} from "@brief/api-client/stream";
import { demoDataset, type BriefPublication, type BriefSource } from "@brief/demo-data";
import {
  I18nProvider,
  LOCALES,
  MARKETS,
  type Locale,
  type LocaleMarketPair,
  type Market,
  FormattedMessage,
  htmlLang,
  isLocale,
  isMarket,
  useIntl,
  useLocale,
  useMarket,
  useSetLocaleMarket,
} from "@brief/i18n";
import type {
  EffectiveWebPolicy,
  GetChatResponse,
  MemoryRevisionResponse,
  PublicSourcesResponse,
} from "@brief/shared";
import { Schema } from "effect";
import {
  type DemoRoute,
  buildLocalePath,
  buildDemoPath,
  getDemoLocalePrefixFromPath,
  getDemoRouteFromPath,
  resolveDemoRoute,
} from "./routing";
import {
  detectLocale,
  getStoredMarket,
  resolveDemoLocaleMarket,
  setStoredLocale,
  setStoredMarket,
} from "./locale-bootstrap";
import {
  Breadcrumbs,
  Button,
  ClientFeedsTable,
  ClientPublicationsTable,
  PublicationDetail,
  SectionHeader,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  Textarea,
  VirtualizedChatTranscript,
  ChatWebSearchToggle,
  createAuthenticatedDocumentOpener,
  memoryRevisionFragment,
  parseMemoryRevisionFragment,
  type BreadcrumbItem,
  type ChatTranscriptMessage,
  type ClientFeedTableRow,
  type OpenStoredPdfResult,
  type PublicationDetailIssue,
  type PublicationDocument,
} from "@brief/ui";

import {
  mapApiMessagesToTranscript,
  type ChatApiResponse,
  type MemoriesApiResponse,
  type MemoryResponse,
  type SendMessageConflict,
  type SendMessageResponse,
} from "./chat-api";
import {
  initialChatStreamState,
  isWebResearchUnavailable,
  reconcileUserScopedConflict,
  reduceChatStream,
  resolveAmbiguousUserScopedConflict,
  restoreChatStreamState,
  streamReconnectAction,
  type UserScopedConflict,
  type ChatStreamEvent,
} from "./chat-stream";
import { buildTranscriptMessages } from "./chat-transcript";
import { DemoPublications, readStoredOr } from "./demo-state";
import "./styles.css";
import { loadDemoBrowserConfig } from "./config";
import { DocsDocument } from "./docs-document";
import { isDocsPath } from "./docs-path";
import {
  currentMarketPublicContent,
  emptyPublicContent,
  scopePublicContentToMarket,
  type MarketPublicContentState,
} from "./market-content";
import {
  createChatResetController,
  type ChatResetController,
  type ChatResetSnapshot,
} from "./chat-reset";

const docsPath = isDocsPath(window.location.pathname);
const publicApiBaseUrl = docsPath ? "" : loadDemoBrowserConfig(import.meta.env).apiBaseUrl;
const demoSessionUrl = `${publicApiBaseUrl}/v1/demo/session`;

// Every demo request carries the per-browser session cookie. The first call
// from a new browser arrives with no cookie and is rejected (401); this wrapper
// establishes a session (the API mints a visitor id and sets the cookie) and
// retries the original request once. Returning visitors keep their cookie and
// never hit the session call. There is no password and no app-wide gate.
const demoFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const response = await globalThis.fetch(input, { ...init, credentials: "include" });
  if (response.status !== 401) return response;
  await globalThis.fetch(demoSessionUrl, { method: "POST", credentials: "include" });
  return globalThis.fetch(input, { ...init, credentials: "include" });
};

const demoApi = createProductApiClient({
  fetch: demoFetch,
  ...(publicApiBaseUrl === "" ? {} : { baseUrl: publicApiBaseUrl }),
});

function isDemoPdfPath(pathname: string) {
  return pathname.startsWith("/demo/pdfs/") && pathname.endsWith(".pdf");
}

async function fetchPublicContent(market: Market): Promise<PublicSourcesResponse> {
  return scopePublicContentToMarket(
    normalizePublicContentUrls(await demoApi.fetchPublicSources(market)),
    market,
  );
}

async function fetchDemoChat(): Promise<ChatApiResponse> {
  return demoApi.getChat();
}

const emptyResetChatId = "00000000-0000-4000-8000-000000000000";

const emptyResetProjection = (): GetChatResponse => ({
  chat: {
    id: emptyResetChatId,
    memoryMode: "disabled",
    createdAt: "1970-01-01T00:00:00.000Z",
    updatedAt: "1970-01-01T00:00:00.000Z",
    archivedAt: null,
  },
  messages: [],
  effectiveWebPolicy: {
    enabled: false,
    reason: "deployment_unavailable",
    allowlistActive: false,
  },
  activeRun: null,
  canWrite: false,
});

async function postDemoChatMessage(input: {
  readonly text: string;
  readonly locale: Locale;
  readonly market: Market;
  readonly webSearchEnabled: boolean;
}): Promise<SendMessageResponse> {
  return demoApi.sendChatMessage(input);
}

async function fetchDemoMemories(): Promise<MemoriesApiResponse> {
  return { memories: await demoApi.fetchMemories() };
}

async function postRevertMemory(memoryId: string, revisionId: string): Promise<void> {
  await demoApi.revertMemory(memoryId, revisionId);
}

async function deleteDemoMemory(memoryId: string): Promise<void> {
  await demoApi.tombstoneMemory(memoryId);
}

function readInitialPublications() {
  const fallback = demoDataset.issues.map(clonePublication);
  if (typeof window === "undefined") return fallback;
  return readStoredOr(window.localStorage, "brief:demo:issues:v1", DemoPublications, fallback);
}

function App() {
  const intl = useIntl();
  const locale = useLocale();
  const market = useMarket();
  const initialPublications = useMemo(readInitialPublications, []);
  const initialRoute = useMemo(
    () => resolveDemoRoute(getDemoRouteFromPath(window.location.pathname), initialPublications),
    [initialPublications],
  );
  const [issues, , resetIssues] = useSessionState<readonly BriefPublication[]>(
    "brief:demo:issues:v1",
    initialPublications,
    DemoPublications,
  );
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(initialRoute.sourceId);
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(initialRoute.issueId);
  const resetHostRef = useRef<{
    readonly start: (snapshot: ChatResetSnapshot<string>) => void;
    readonly succeed: (response: { readonly replacement: GetChatResponse }) => Promise<void>;
    readonly fail: (cause: unknown, snapshot: ChatResetSnapshot<string>) => Promise<void>;
  }>({
    start: () => {},
    succeed: () => Promise.resolve(),
    fail: () => Promise.resolve(),
  });
  const resetSnapshotRef = useRef<ChatResetSnapshot<string> | null>(null);
  const resetControllerRef = useRef<ChatResetController<string> | null>(null);
  if (resetControllerRef.current === null) {
    resetControllerRef.current = createChatResetController<string>({
      initial: {
        projection: emptyResetProjection(),
        draft: "",
        activeRunId: null,
        streamGeneration: 0,
        cursor: null,
        route: typeof window === "undefined" ? "" : window.location.pathname,
      },
      api: {
        resetChat: (chatId, replacementChatId) => demoApi.resetChat(chatId, replacementChatId),
        getCommittedChat: fetchDemoChat,
      },
      onStart: (snapshot) => resetHostRef.current.start(snapshot),
      onSuccess: (response) => resetHostRef.current.succeed(response),
      onFailure: (cause, snapshot) => resetHostRef.current.fail(cause, snapshot),
    });
  }
  const resetController = resetControllerRef.current;
  const [resetPending, setResetPending] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const [loadedPublicContent, setLoadedPublicContent] = useState<MarketPublicContentState>(() => ({
    market,
    status: "loading",
    content: emptyPublicContent(),
  }));
  const visiblePublicContent = currentMarketPublicContent(loadedPublicContent, market);
  const publicContent = visiblePublicContent.content;
  const publicContentStatus = visiblePublicContent.status;
  const sources = useMemo(
    () => [...demoDataset.sources, ...publicContent.sources],
    [publicContent.sources],
  );
  const publications = useMemo(
    () => [...issues, ...publicContent.publications],
    [issues, publicContent.publications],
  );
  const sourceById = useMemo(
    () => new Map(sources.map((source) => [source.id, source])),
    [sources],
  );

  function applyDemoRoute(
    route: DemoRoute,
    historyMode: "push" | "replace" = "push",
    routePublications: readonly BriefPublication[] = publications,
    routeSources: readonly BriefSource[] = sources,
  ) {
    const nextRoute = resolveDemoRoute(route, routePublications, routeSources);
    setSelectedSourceId(nextRoute.sourceId);
    setSelectedIssueId(nextRoute.issueId);

    if (typeof window === "undefined") return;
    const localePrefixed: DemoRoute = {
      ...nextRoute,
      locale: nextRoute.locale ?? locale,
    };
    const nextPath = buildDemoPath(localePrefixed);
    if (window.location.pathname === nextPath) return;
    if (historyMode === "replace") {
      window.history.replaceState(null, "", nextPath);
      return;
    }
    window.history.pushState(null, "", nextPath);
  }

  useEffect(() => {
    if (typeof window === "undefined") return;
    applyDemoRoute(getDemoRouteFromPath(window.location.pathname), "replace");

    function handlePopState() {
      applyDemoRoute(getDemoRouteFromPath(window.location.pathname), "replace");
    }

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publications, sources, locale]);

  useEffect(() => {
    let cancelled = false;
    setLoadedPublicContent({ market, status: "loading", content: emptyPublicContent() });
    void fetchPublicContent(market)
      .then((content) => {
        if (cancelled) return;
        setLoadedPublicContent({ market, status: "ready", content });
      })
      .catch(() => {
        if (cancelled) return;
        setLoadedPublicContent({ market, status: "error", content: emptyPublicContent() });
      });

    return () => {
      cancelled = true;
    };
  }, [market]);

  useEffect(
    () =>
      resetController.subscribe(() => {
        setResetPending(resetController.getState().phase === "pending");
      }),
    [resetController],
  );

  useEffect(() => {
    if (initialRoute.sourceId === null) return;
    if (resetController.getState().projection.chat.id !== emptyResetChatId) return;
    let cancelled = false;
    void fetchDemoChat()
      .then((chat) => {
        if (cancelled || resetController.getState().phase === "pending") return;
        const activeRunId = chat.activeRun?.id ?? null;
        const restored =
          activeRunId === null ? null : restoreRunStreamState(window.sessionStorage, activeRunId);
        resetController.dispatch({
          type: "hydrate",
          projection: chat,
          activeRunId,
          streamGeneration: resetController.getState().streamGeneration,
          cursor:
            activeRunId === null || restored === null
              ? null
              : { runId: activeRunId, lastSeq: restored.lastSeq },
          route: window.location.pathname,
        });
      })
      .catch(() => {
        if (!cancelled) setResetError(intl.formatMessage({ id: "chat.resetFailed" }));
      });
    return () => {
      cancelled = true;
    };
  }, [initialRoute.sourceId, intl, resetController]);

  async function handleResetChat() {
    if (resetController.getState().phase === "pending") return;
    const route = window.location.pathname;
    let state = resetController.getState();
    if (state.projection.chat.id === emptyResetChatId) {
      try {
        const chat = await fetchDemoChat();
        const activeRunId = chat.activeRun?.id ?? null;
        const restored =
          activeRunId === null ? null : restoreRunStreamState(window.sessionStorage, activeRunId);
        resetController.dispatch({
          type: "hydrate",
          projection: chat,
          activeRunId,
          streamGeneration: state.streamGeneration,
          cursor:
            activeRunId === null || restored === null
              ? null
              : { runId: activeRunId, lastSeq: restored.lastSeq },
          route,
        });
      } catch {
        setResetError(intl.formatMessage({ id: "chat.resetFailed" }));
        return;
      }
      state = resetController.getState();
    } else if (state.route !== route) {
      const restored =
        state.activeRunId === null
          ? null
          : restoreRunStreamState(window.sessionStorage, state.activeRunId);
      resetController.dispatch({
        type: "hydrate",
        projection: state.projection,
        activeRunId: state.activeRunId,
        streamGeneration: state.streamGeneration,
        cursor:
          state.activeRunId === null || restored === null
            ? state.cursor
            : { runId: state.activeRunId, lastSeq: restored.lastSeq },
        route,
      });
      state = resetController.getState();
    }
    await resetController.reset(state.projection.chat.id, route);
  }

  function finishResetDemoStorage() {
    resetDemoStorage();
    resetIssues(demoDataset.issues.map(clonePublication));
    applyDemoRoute({ locale, role: "client", sourceId: null, issueId: null }, "replace");
  }

  resetHostRef.current = {
    start: (snapshot) => {
      resetSnapshotRef.current = snapshot;
      setResetError(null);
      applyDemoRoute({ locale, role: "client", sourceId: null, issueId: null }, "replace");
    },
    succeed: async () => {
      const previousRunId =
        resetSnapshotRef.current?.cursor?.runId ?? resetSnapshotRef.current?.activeRunId;
      if (previousRunId !== null && previousRunId !== undefined) {
        clearRunStreamState(window.sessionStorage, previousRunId);
      }
      setResetError(null);
      resetSnapshotRef.current = null;
      finishResetDemoStorage();
    },
    fail: async (cause, snapshot) => {
      setResetError(intl.formatMessage({ id: "chat.resetFailed" }));
      applyDemoRoute(getDemoRouteFromPath(snapshot.route), "replace");
      resetSnapshotRef.current = null;
      void cause;
    },
  };
  function handleToggleSubscribed(sourceId: string) {
    const source = sources.find((candidate) => candidate.id === sourceId);
    if (!source) return;
    void demoApi
      .setPublicSourceEnabled(sourceId, !source.subscribed, market)
      .then(() => fetchPublicContent(market))
      .then((content) => setLoadedPublicContent({ market, status: "ready", content }))
      .catch(() => {});
  }

  const selectedFeed = selectedSourceId ? (sourceById.get(selectedSourceId) ?? null) : null;
  const selectedClientIssue =
    selectedSourceId && selectedIssueId
      ? (publications.find(
          (issue) =>
            issue.id === selectedIssueId &&
            issue.sourceId === selectedSourceId &&
            issue.status === "published",
        ) ?? null)
      : null;

  return (
    <TooltipProvider>
      <main className="min-h-screen bg-canvas text-ink">
        <header className="border-b border-rule bg-paper/90">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3 sm:px-6 lg:px-8">
            <div className="flex min-w-0 items-baseline gap-1.5">
              <h1 className="shrink-0 font-display text-xl font-medium text-ink">
                brief<span className="text-accent">.</span>
              </h1>
              <span className="truncate font-mono text-[11px] font-medium text-faint">
                <FormattedMessage id="demo.badge" />
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <LocaleMarketSwitcher />
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-7 text-faint/70 hover:bg-rule/45 hover:text-muted"
                    onClick={() => void handleResetChat()}
                    disabled={resetPending}
                    aria-label={intl.formatMessage({ id: "action.reset" })}
                  >
                    <RotateCcw className="size-3" aria-hidden="true" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" align="end" sideOffset={8}>
                  <FormattedMessage id="action.reset.tooltip" />
                </TooltipContent>
              </Tooltip>
            </div>
          </div>
        </header>

        <div className="mx-auto max-w-7xl px-4 py-5 sm:px-6 sm:py-6 lg:px-8">
          <div className="mb-6">
            <Breadcrumbs
              items={buildBreadcrumbs({
                selectedFeed,
                selectedClientIssue,
                locale,
                intl,
                applyDemoRoute,
              })}
            />
            {resetError ? (
              <p className="mt-2 text-sm text-accent" data-testid="chat-reset-error">
                {resetError}
              </p>
            ) : null}
          </div>
          {selectedFeed && selectedClientIssue ? (
            <ClientPublicationDetail issue={selectedClientIssue} sourceById={sourceById} />
          ) : selectedFeed ? (
            <ClientFeedDetail
              feed={selectedFeed}
              publications={publications}
              onSelectIssue={(issueId) =>
                applyDemoRoute({
                  locale,
                  role: "client",
                  sourceId: selectedFeed.id,
                  issueId,
                })
              }
            />
          ) : (
            <ClientFeedsList
              market={market}
              sources={sources}
              publications={publications}
              publicContentStatus={publicContentStatus}
              onSelectFeed={(feedId) =>
                applyDemoRoute({ locale, role: "client", sourceId: feedId, issueId: null })
              }
              onToggleSubscribed={handleToggleSubscribed}
              resetController={resetController}
            />
          )}
        </div>
      </main>
    </TooltipProvider>
  );
}

function PublisherPublicationDetail({
  issue,
  sourceById,
  onDeleteIssue,
  onUpdateIssue,
}: {
  issue: BriefPublication;
  sourceById: ReadonlyMap<string, BriefSource>;
  onDeleteIssue?: (id: string) => void;
  onUpdateIssue?: (issue: BriefPublication) => void;
}) {
  const intl = useIntl();
  const editable = Boolean(onUpdateIssue) && isEditableIssue(issue);

  function handleOpenStoredPdf(document: PublicationDocument): Promise<OpenStoredPdfResult> {
    return openStoredDemoPdf(document, {
      pdfNotFound: intl.formatMessage({ id: "error.pdfNotFound" }),
      pdfOpenFailed: intl.formatMessage({ id: "error.pdfOpenFailed" }),
    });
  }

  function updateIssue(patch: Partial<PublicationDetailIssue>) {
    onUpdateIssue?.({
      ...issue,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.publicationDate !== undefined ? { publicationDate: patch.publicationDate } : {}),
      ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
    });
  }

  function updateDocument(documentId: string, patch: Partial<PublicationDocument>) {
    onUpdateIssue?.({
      ...issue,
      documents: issue.documents.map((doc) => (doc.id === documentId ? { ...doc, ...patch } : doc)),
    });
  }

  function deleteDocument(documentId: string) {
    void deleteDemoPdf(documentId).catch(() => {});
    onUpdateIssue?.({
      ...issue,
      documents: issue.documents.filter((doc) => doc.id !== documentId),
    });
  }

  function handleAddDocument() {
    onUpdateIssue?.({
      ...issue,
      documents: [
        ...issue.documents,
        createDraftDocument(issue.id, issue.sourceId, issue.documents.length + 1),
      ],
    });
  }

  function handleUploadDocumentPdf(documentId: string, file: File) {
    void storeDemoPdf(documentId, file).catch(() => {});
    updateDocument(documentId, {
      fileName: file.name,
      storagePath: `indexeddb://${demoPdfDatabaseName}/${demoPdfStoreName}/${documentId}`,
    });
  }

  return (
    <PublicationDetail
      issue={toPublicationDetailIssue(issue, sourceById)}
      editable={editable}
      getPdfHref={getPublicPdfUrl}
      onAddDocument={handleAddDocument}
      onDeleteDocument={deleteDocument}
      onDeleteIssue={onDeleteIssue}
      onOpenStoredPdf={handleOpenStoredPdf}
      onUpdateDocument={updateDocument}
      onUpdateIssue={updateIssue}
      onUploadDocumentPdf={handleUploadDocumentPdf}
    />
  );
}

function ClientFeedsList({
  market,
  sources,
  publications,
  publicContentStatus,
  onSelectFeed,
  onToggleSubscribed,
  resetController,
}: {
  market: Market;
  sources: readonly BriefSource[];
  publications: readonly BriefPublication[];
  publicContentStatus: "loading" | "ready" | "error";
  onSelectFeed: (feedId: string) => void;
  onToggleSubscribed: (feedId: string) => void;
  resetController: ChatResetController<string>;
}) {
  const intl = useIntl();
  const locale = useLocale();
  const publishedIssues = publications.filter((issue) => issue.status === "published");
  const initialResetState = useMemo(() => resetController.getState(), [resetController]);
  const [chatMessages, setChatMessages] = useState<readonly ChatTranscriptMessage[]>(() =>
    mapApiMessagesToTranscript(initialResetState.projection.messages),
  );
  const [activeRunId, setActiveRunId] = useState<string | null>(initialResetState.activeRunId);
  const [userScopedConflict, setUserScopedConflict] = useState<UserScopedConflict | null>(null);
  const [effectiveWebPolicy, setEffectiveWebPolicy] = useState<EffectiveWebPolicy>(
    initialResetState.projection.effectiveWebPolicy,
  );
  const [webSearchEnabled, setWebSearchEnabled] = useState(false);
  const [chatStatus, setChatStatus] = useState<"loading" | "ready" | "error">(
    initialResetState.projection.chat.id === emptyResetChatId ? "loading" : "ready",
  );
  const [draftMessage, setDraftMessage] = useState(initialResetState.draft);
  const [sendStatus, setSendStatus] = useState<"idle" | "sending">("idle");
  const [chatNotice, setChatNotice] = useState<string | null>(() =>
    initialResetState.phase === "pending" ? intl.formatMessage({ id: "chat.resetPending" }) : null,
  );
  const [chatError, setChatError] = useState<string | null>(null);
  const [failedMessage, setFailedMessage] = useState<string | null>(null);
  const [streamState, setStreamState] = useState(initialChatStreamState);
  const streamSeqRef = useRef(0);
  const chatRefreshSequenceRef = useRef(0);
  const [resetPending, setResetPending] = useState(initialResetState.phase === "pending");
  const [memories, setMemories] = useState<readonly MemoryResponse[]>([]);
  const [memoriesStatus, setMemoriesStatus] = useState<"loading" | "ready" | "error">("loading");
  const [memoryError, setMemoryError] = useState<string | null>(null);
  const [revertingMemoryId, setRevertingMemoryId] = useState<string | null>(null);
  const chatAuthorLabels = useMemo(
    () => ({
      assistant: intl.formatMessage({ id: "chat.author.assistant" }),
      client: intl.formatMessage({ id: "chat.author.client" }),
    }),
    [intl],
  );
  const openAuthenticatedDocument = useMemo(
    () => createAuthenticatedDocumentOpener(demoApi.fetchPublisherDocument),
    [],
  );

  useEffect(() => {
    if (!resetPending) return;
    document.querySelector<HTMLTextAreaElement>('[data-testid="chat-composer-input"]')?.focus();
  }, [resetPending]);

  useEffect(() => {
    let previous = resetController.getState();
    return resetController.subscribe(() => {
      const next = resetController.getState();
      const started = next.phase === "pending" && previous.phase !== "pending";
      const completed = next.phase === "idle" && previous.phase === "pending";
      if (started) {
        chatRefreshSequenceRef.current += 1;
        setChatMessages([]);
        setActiveRunId(null);
        setStreamState(initialChatStreamState);
        setChatStatus("ready");
        setChatNotice(intl.formatMessage({ id: "chat.resetPending" }));
        setChatError(null);
        setFailedMessage(null);
        document.querySelector<HTMLTextAreaElement>('[data-testid="chat-composer-input"]')?.focus();
      } else if (completed) {
        setChatMessages(mapApiMessagesToTranscript(next.projection.messages));
        setActiveRunId(next.activeRunId);
        setEffectiveWebPolicy(next.projection.effectiveWebPolicy);
        setStreamState(initialChatStreamState);
        setChatNotice(null);
      }
      setDraftMessage(next.draft);
      setResetPending(next.phase === "pending");
      previous = next;
    });
  }, [intl, resetController]);

  const refreshChat = useCallback(
    async (preserveActiveRunId?: string) => {
      const sequence = ++chatRefreshSequenceRef.current;
      const resetGeneration = resetController.getState().generation;
      const chat = await fetchDemoChat();
      if (sequence !== chatRefreshSequenceRef.current) return chat;
      const resetState = resetController.getState();
      if (resetState.generation !== resetGeneration) return chat;
      setChatMessages(mapApiMessagesToTranscript(chat.messages));
      setActiveRunId(preserveActiveRunId ?? chat.activeRun?.id ?? null);
      setEffectiveWebPolicy(chat.effectiveWebPolicy);
      if (!chat.effectiveWebPolicy.enabled) setWebSearchEnabled(false);
      setChatStatus("ready");
      resetController.dispatch({
        type: "hydrate",
        projection: chat,
        activeRunId: preserveActiveRunId ?? chat.activeRun?.id ?? null,
        streamGeneration: resetController.getState().streamGeneration,
        cursor:
          preserveActiveRunId === undefined || preserveActiveRunId === null
            ? null
            : resetController.getState().cursor,
        route: window.location.pathname,
      });
      return chat;
    },
    [resetController],
  );

  const refreshMemories = useCallback(async () => {
    const result = await fetchDemoMemories();
    setMemories(result.memories);
    setMemoriesStatus("ready");
    setMemoryError(null);
    return result;
  }, []);

  useEffect(() => {
    if (resetController.getState().projection.chat.id !== emptyResetChatId) {
      setChatStatus("ready");
      return;
    }
    let cancelled = false;
    setChatStatus("loading");
    void refreshChat()
      .then((chat) => {
        if (cancelled) return;
        // refreshChat owns the fenced state update. This continuation only
        // reports errors; an older initial GET must not overwrite a later
        // accepted send.
        if (chat !== undefined) setChatStatus("ready");
      })
      .catch(() => {
        if (cancelled) return;
        setChatStatus("error");
      });

    return () => {
      cancelled = true;
    };
  }, [refreshChat, resetController]);

  useEffect(() => {
    let cancelled = false;
    setMemoriesStatus("loading");
    void fetchDemoMemories()
      .then((result) => {
        if (cancelled) return;
        setMemories(result.memories);
        setMemoriesStatus("ready");
      })
      .catch(() => {
        if (cancelled) return;
        setMemoriesStatus("error");
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (activeRunId === null) {
      streamSeqRef.current = 0;
      setStreamState((current) => (current.phase === "error" ? current : initialChatStreamState));
      return;
    }

    let closed = false;
    let controller: AbortController | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    const resetGeneration = resetController.getState().generation;
    const restored = restoreRunStreamState(window.sessionStorage, activeRunId);
    let currentStreamState = restoreChatStreamState(restored);
    streamSeqRef.current = restored?.lastSeq ?? 0;
    setStreamState(currentStreamState);

    const closeCurrent = () => {
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      controller?.abort();
      controller = null;
    };

    const handleStreamEvent = (seq: number, event: ChatStreamEvent) => {
      if (closed || resetController.getState().generation !== resetGeneration) return;
      const next = reduceChatStream(currentStreamState, { seq, event });
      currentStreamState = next;
      streamSeqRef.current = next.seq;
      resetController.dispatch({
        type: "late_stream",
        generation: resetController.getState().generation,
        streamGeneration: resetController.getState().streamGeneration,
        cursor: { runId: activeRunId, lastSeq: next.seq },
      });
      if (event.type !== "done" && event.type !== "error") {
        persistRunStreamState(window.sessionStorage, {
          version: 4,
          runId: activeRunId,
          lastSeq: next.seq,
          draft: {
            runId: activeRunId,
            text: next.assistantText,
            attempt: next.attempt,
            sourcesRead: next.sourcesRead,
            activities: next.activities,
            activityHistory: next.activityHistory,
            context: next.context,
            memoryUpdated: next.memoryUpdated,
            terminalFailure: null,
          },
        });
      }
      setStreamState(next);

      if (event.type === "done" || event.type === "error") {
        closed = true;
        closeCurrent();
        clearRunStreamState(window.sessionStorage, activeRunId);
        void refreshChat().catch(() => setChatStatus("error"));
        void refreshMemories().catch(() => setMemoriesStatus("error"));
      }
    };

    const clearLocalStream = () => {
      closed = true;
      closeCurrent();
      clearRunStreamState(window.sessionStorage, activeRunId);
      setStreamState(initialChatStreamState);
    };

    const reconcileBeforeRetry = async (): Promise<void> => {
      if (closed) return;
      try {
        const latest = await refreshChat();
        if (closed) return;
        if (latest.activeRun?.id !== activeRunId) {
          clearLocalStream();
          void refreshMemories().catch(() => setMemoriesStatus("error"));
          return;
        }
        reconnectTimer = setTimeout(connect, 1000);
      } catch {
        // A failed authoritative reload cannot establish that the run is
        // still active. Stop and clear instead of retrying an unknown cursor.
        clearLocalStream();
        setChatStatus("error");
        void refreshMemories().catch(() => setMemoriesStatus("error"));
      }
    };

    const connect = () => {
      if (closed) return;
      controller = new AbortController();
      const signal = controller.signal;
      void (async () => {
        for await (const frame of demoApi.streamAiRun(activeRunId, streamSeqRef.current, signal)) {
          handleStreamEvent(frame.seq, frame.event);
        }
      })()
        .then(() => {
          if (!closed && !signal.aborted) void reconcileBeforeRetry();
        })
        .catch((cause) => {
          if (streamReconnectAction(cause) === "reconcile") {
            clearLocalStream();
            void refreshChat().catch(() => setChatStatus("error"));
            void refreshMemories().catch(() => setMemoriesStatus("error"));
            return;
          }
          if (!closed && !signal.aborted) void reconcileBeforeRetry();
        });
    };

    connect();

    return () => {
      closed = true;
      closeCurrent();
    };
  }, [activeRunId, refreshChat, refreshMemories]);

  useEffect(() => {
    if (userScopedConflict === null) return;
    const controller = new AbortController();
    void reconcileUserScopedConflict({
      conflict: userScopedConflict,
      signal: controller.signal,
      send: postDemoChatMessage,
      onStillActive: (conflict) => {
        setUserScopedConflict((current) =>
          current === null || current.runId === conflict.activeRun.id
            ? current
            : { ...current, runId: conflict.activeRun.id },
        );
      },
      onAccepted: async (body) => {
        setChatNotice(null);
        setUserScopedConflict(null);
        setDraftMessage("");
        setActiveRunId(body.run.id);
        // Fence the accepted run after the refresh. A GET started for an
        // earlier 409 may resolve later with the foreign run descriptor; it
        // must never overwrite this 202's own run id.
        await refreshChat(body.run.id).catch(() => {
          setChatStatus("error");
        });
      },
      onChatConflict: async (conflict) => {
        setUserScopedConflict(null);
        setActiveRunId(conflict.activeRun.id);
        await refreshChat().catch(() => {
          setActiveRunId(null);
          setChatStatus("error");
        });
      },
      onStopped: async () => {
        try {
          const latest = await refreshChat();
          const resolution = resolveAmbiguousUserScopedConflict(userScopedConflict, latest);
          if (resolution.action === "attach") setActiveRunId(resolution.runId);
          else setActiveRunId(null);
        } catch {
          // Release the permanent blocker after an authoritative attempt. The
          // request is never replayed automatically, so an explicit user
          // resend remains the only way to issue another POST.
          setActiveRunId(null);
          setChatStatus("error");
        } finally {
          setUserScopedConflict(null);
          setChatError(intl.formatMessage({ id: "chat.sendFailed" }));
        }
      },
    });
    return () => controller.abort();
  }, [intl, refreshChat, userScopedConflict]);

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      const request = {
        text: trimmed,
        locale,
        market,
        webSearchEnabled,
      } as const;
      if (
        trimmed.length === 0 ||
        resetPending ||
        sendStatus === "sending" ||
        activeRunId !== null ||
        userScopedConflict !== null
      )
        return;

      setSendStatus("sending");
      setChatNotice(null);
      setChatError(null);
      setFailedMessage(null);

      try {
        const body = await postDemoChatMessage(request);
        setDraftMessage("");
        resetController.dispatch({ type: "draft", draft: "" });
        setUserScopedConflict(null);
        setActiveRunId(body.run.id);
        await refreshChat();
      } catch (cause) {
        if (
          cause instanceof ApiResponseError &&
          cause.status === 409 &&
          cause.body !== undefined &&
          "conflictScope" in cause.body
        ) {
          const conflict: SendMessageConflict = cause.body;
          setChatNotice(intl.formatMessage({ id: "chat.runActive" }));
          if (conflict.conflictScope === "chat") setActiveRunId(conflict.activeRun.id);
          if (conflict.conflictScope === "user") {
            setUserScopedConflict({
              runId: conflict.activeRun.id,
              request,
              knownMessageIds: chatMessages.map((message) => message.id),
            });
          }
          await refreshChat().catch((reloadCause) => {
            // A revoked viewer cannot safely keep reconciling a foreign run.
            // Clear the local blocker and stop the retry effect.
            if (
              reloadCause instanceof ApiResponseError &&
              (reloadCause.status === 401 ||
                reloadCause.status === 403 ||
                reloadCause.status === 404)
            ) {
              setUserScopedConflict(null);
              setActiveRunId(null);
              setChatStatus("error");
            }
          });
          return;
        }
        if (isWebResearchUnavailable(cause)) {
          setWebSearchEnabled(false);
          setChatError(intl.formatMessage({ id: "chat.webPolicyChanged" }));
          await refreshChat().catch(() => undefined);
          return;
        }
        setFailedMessage(trimmed);
        setChatError(intl.formatMessage({ id: "chat.sendFailed" }));
      } finally {
        setSendStatus("idle");
      }
    },
    [
      activeRunId,
      intl,
      locale,
      market,
      refreshChat,
      resetPending,
      sendStatus,
      userScopedConflict,
      webSearchEnabled,
    ],
  );

  async function handleRevertMemory(memoryId: string, revisionId: string) {
    setRevertingMemoryId(memoryId);
    setMemoryError(null);
    try {
      await postRevertMemory(memoryId, revisionId);
      await refreshMemories();
      await refreshChat();
    } catch {
      setMemoryError(intl.formatMessage({ id: "chat.memoryRevertFailed" }));
    } finally {
      setRevertingMemoryId(null);
    }
  }

  async function handleDeleteMemory(memoryId: string) {
    setRevertingMemoryId(memoryId);
    setMemoryError(null);
    try {
      await deleteDemoMemory(memoryId);
      await refreshMemories();
    } catch {
      setMemoryError(intl.formatMessage({ id: "chat.memoryDeleteFailed" }));
    } finally {
      setRevertingMemoryId(null);
    }
  }

  const rows = useMemo<ClientFeedTableRow[]>(() => {
    const publisherIssueSourceIds = new Set(publishedIssues.map((i) => i.sourceId));
    return sources.map((source) => ({
      id: source.id,
      name: source.name,
      description: source.description,
      sourceType: source.kind === "publisher" ? "publisher_invite" : "public",
      subscribed: source.subscribed,
      lastPublicationDate: computeSourceLastDate(source, publisherIssueSourceIds, publishedIssues),
      publisherName: source.publisherName,
    }));
  }, [publishedIssues, sources]);

  const runActive = activeRunId !== null || userScopedConflict !== null;
  const transcriptMessages = useMemo(
    () => buildTranscriptMessages(chatMessages, activeRunId, streamState.phase, streamState),
    [activeRunId, chatMessages, streamState],
  );

  return (
    <div className="mx-auto max-w-5xl space-y-7">
      <section className="animate-in stagger-1">
        <VirtualizedChatTranscript
          messages={transcriptMessages}
          authorLabels={chatAuthorLabels}
          onOpenAuthenticatedDocument={openAuthenticatedDocument}
          onResubmit={(message) => setDraftMessage(message.content)}
        />

        {chatStatus === "loading" ? (
          <p className="mt-2 font-mono text-[11px] text-faint">
            <FormattedMessage id="chat.loading" />
          </p>
        ) : null}
        {chatStatus === "error" ? (
          <p className="mt-2 font-mono text-[11px] text-accent">
            <FormattedMessage id="chat.unavailable" />
          </p>
        ) : null}

        <form
          className="mt-4 border-t border-rule pt-3"
          data-testid="chat-composer"
          onSubmit={(event) => {
            event.preventDefault();
            void sendMessage(draftMessage);
          }}
        >
          <div className="mb-2">
            <ChatWebSearchToggle
              policy={effectiveWebPolicy}
              checked={webSearchEnabled}
              disabled={resetPending || runActive || sendStatus === "sending"}
              onChange={setWebSearchEnabled}
            />
          </div>
          <div className="flex items-end gap-2">
            <Textarea
              value={draftMessage}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setDraftMessage(value);
                resetController.dispatch({ type: "draft", draft: value });
              }}
              placeholder={intl.formatMessage({ id: "chat.placeholder" })}
              disabled={runActive || sendStatus === "sending"}
              rows={2}
              className="min-h-10 resize-none bg-paper"
              data-testid="chat-composer-input"
            />
            <Button
              type="submit"
              disabled={
                resetPending ||
                runActive ||
                sendStatus === "sending" ||
                draftMessage.trim().length === 0
              }
              data-testid="chat-send-button"
            >
              <Send className="size-4" aria-hidden="true" />
              <FormattedMessage id="action.send" />
            </Button>
          </div>
        </form>
        {chatNotice ? <p className="mt-2 text-sm text-muted">{chatNotice}</p> : null}
        {chatError ? (
          <div className="mt-2 flex items-center gap-2 text-sm text-accent">
            <span>{chatError}</span>
            {failedMessage ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void sendMessage(failedMessage)}
              >
                <FormattedMessage id="action.retry" />
              </Button>
            ) : null}
          </div>
        ) : null}
      </section>

      <section
        className="animate-in stagger-2 border-y border-rule py-3"
        data-testid="memories-panel"
      >
        <MemoriesPanel
          memories={memories}
          status={memoriesStatus}
          error={memoryError}
          revertingMemoryId={revertingMemoryId}
          onRevert={handleRevertMemory}
          onDelete={handleDeleteMemory}
        />
      </section>

      <section className="animate-in stagger-3">
        <SectionHeader title={intl.formatMessage({ id: "section.feeds" })} count={sources.length} />
        {publicContentStatus === "loading" ? (
          <p className="mt-2 text-sm text-muted">
            <FormattedMessage id="state.loadingPublicSources" />
          </p>
        ) : null}
        {publicContentStatus === "error" ? (
          <p className="mt-2 text-sm text-muted">
            <FormattedMessage id="state.publicSourcesUnavailable" />
          </p>
        ) : null}
        {publicContentStatus === "ready" && !sources.some((source) => source.kind === "public") ? (
          <div
            className="mt-3 rounded-sm border border-rule bg-paper px-4 py-5 text-sm text-muted"
            data-testid="public-sources-empty"
          >
            <FormattedMessage id="state.noPublicSources" />
          </div>
        ) : null}
        <div className="mt-3">
          <ClientFeedsTable
            rows={rows}
            onSelectFeed={onSelectFeed}
            onToggleSubscribed={onToggleSubscribed}
          />
        </div>
      </section>
    </div>
  );
}

function MemoriesPanel({
  memories,
  status,
  error,
  revertingMemoryId,
  onRevert,
  onDelete,
}: {
  memories: readonly MemoryResponse[];
  status: "loading" | "ready" | "error";
  error: string | null;
  revertingMemoryId: string | null;
  onRevert: (memoryId: string, revisionId: string) => void;
  onDelete: (memoryId: string) => void;
}) {
  const intl = useIntl();
  const [expandedMemoryId, setExpandedMemoryId] = useState<string | null>(null);
  const [openedMemoryRevision, setOpenedMemoryRevision] = useState<MemoryRevisionResponse | null>(
    null,
  );
  const [provenanceError, setProvenanceError] = useState<string | null>(null);

  useEffect(() => {
    let requestGeneration = 0;
    const openHashRevision = () => {
      const identity = parseMemoryRevisionFragment(window.location.hash);
      if (identity === null) {
        requestGeneration += 1;
        setOpenedMemoryRevision(null);
        setProvenanceError(null);
        return;
      }
      setExpandedMemoryId(identity.memoryId);
      setProvenanceError(null);
      const generation = ++requestGeneration;
      void demoApi
        .fetchMemoryRevision(identity.memoryId, identity.revisionId)
        .then((response) => {
          if (generation !== requestGeneration) return;
          setOpenedMemoryRevision(response);
          window.requestAnimationFrame(() =>
            document.getElementById(window.location.hash.slice(1))?.scrollIntoView({
              block: "center",
            }),
          );
        })
        .catch(() => {
          if (generation !== requestGeneration) return;
          setOpenedMemoryRevision(null);
          setProvenanceError("memory_revision_load_failed");
        });
    };
    openHashRevision();
    window.addEventListener("hashchange", openHashRevision);
    return () => {
      requestGeneration += 1;
      window.removeEventListener("hashchange", openHashRevision);
    };
  }, []);

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-mono text-[11px] font-medium uppercase tracking-wider text-faint">
          <FormattedMessage id="section.memories" />
        </h2>
        <span className="font-mono text-[11px] text-faint">
          <FormattedMessage id="chat.memoriesCount" values={{ count: memories.length }} />
        </span>
      </div>
      <p className="mt-1 font-mono text-[11px] text-faint">
        <FormattedMessage id="chat.memoryDeletionNotice" />
      </p>

      {status === "loading" ? (
        <p className="mt-2 text-sm text-muted">
          <FormattedMessage id="state.loadingMemories" />
        </p>
      ) : null}
      {status === "error" ? (
        <p className="mt-2 text-sm text-accent">
          <FormattedMessage id="state.memoriesUnavailable" />
        </p>
      ) : null}
      {error ? <p className="mt-2 text-sm text-accent">{error}</p> : null}
      {openedMemoryRevision === null ? null : (
        <article
          id={memoryRevisionFragment(
            openedMemoryRevision.memoryId,
            openedMemoryRevision.revision.id,
          ).slice(1)}
          className="mt-2 border border-rule p-3"
          data-testid="memory-provenance-revision"
        >
          <h3 className="font-mono text-[11px] font-medium uppercase tracking-wider text-faint">
            <FormattedMessage id="memory.provenanceTitle" />
          </h3>
          <p className="mt-1 font-serif text-sm leading-5 text-ink">
            {openedMemoryRevision.revision.after.content}
          </p>
          <p className="mt-1 font-mono text-[11px] text-faint">
            <FormattedMessage
              id="memory.provenanceDescription"
              values={{
                action: intl.formatMessage(
                  { id: memoryRevisionActionMessageId(openedMemoryRevision.revision.action) },
                  { action: openedMemoryRevision.revision.action },
                ),
                date: openedMemoryRevision.revision.createdAt.slice(0, 10),
              }}
            />
          </p>
        </article>
      )}
      {provenanceError === null ? null : (
        <p className="mt-2 text-sm text-accent" role="alert">
          <FormattedMessage id="memory.provenanceError" values={{ code: provenanceError }} />
        </p>
      )}
      {status === "ready" && memories.length === 0 ? (
        <p className="mt-2 text-sm text-muted">
          <FormattedMessage id="state.noMemories" />
        </p>
      ) : null}

      {memories.length > 0 ? (
        <ul className="mt-2 divide-y divide-rule" data-testid="memory-list">
          {memories.map((memory) => {
            const expanded = expandedMemoryId === memory.id;
            return (
              <li key={memory.id} className="py-2" data-testid="memory-item">
                <div className="grid gap-2 sm:grid-cols-[7rem_1fr_auto] sm:items-start">
                  <div className="font-mono text-[11px] uppercase tracking-wider text-faint">
                    {intl.formatMessage(
                      { id: memoryKindMessageId(memory.current.kind) },
                      { kind: memory.current.kind },
                    )}
                    {memory.current.deleted ? (
                      <span className="mt-1 block text-accent">
                        <FormattedMessage id="memory.deleted" />
                      </span>
                    ) : null}
                  </div>
                  <div>
                    <p
                      className="font-serif text-sm leading-5 text-ink"
                      data-testid="memory-content"
                    >
                      {memory.current.content}
                    </p>
                    <p className="mt-1 font-mono text-[11px] text-faint">
                      {memory.updatedAt.slice(0, 10)}
                    </p>
                    {memory.revisions.length > 0 ? (
                      <button
                        type="button"
                        className="mt-1 font-mono text-[11px] text-muted underline decoration-rule underline-offset-2 hover:text-accent"
                        onClick={() => setExpandedMemoryId(expanded ? null : memory.id)}
                        data-testid="memory-revisions-toggle"
                      >
                        <FormattedMessage
                          id={expanded ? "action.hideRevisions" : "action.viewRevisions"}
                        />
                      </button>
                    ) : null}
                  </div>
                  {!memory.current.deleted ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={revertingMemoryId === memory.id}
                      onClick={() => onDelete(memory.id)}
                      data-testid="memory-delete-button"
                    >
                      <FormattedMessage id="action.delete" />
                    </Button>
                  ) : null}
                </div>
                {expanded ? (
                  <ul
                    className="mt-2 space-y-1 border-l border-rule pl-3"
                    data-testid="memory-revisions"
                  >
                    {memory.revisions.map((revision) => (
                      <li
                        key={revision.id}
                        className="flex items-center justify-between gap-2 font-mono text-[11px] text-muted"
                      >
                        <FormattedMessage
                          id="memory.revisionLine"
                          values={{
                            action: intl.formatMessage(
                              { id: memoryRevisionActionMessageId(revision.action) },
                              { action: revision.action },
                            ),
                            date: revision.createdAt.slice(0, 10),
                          }}
                        />
                        {!revision.after.deleted && revision.id !== memory.headRevisionId ? (
                          <button
                            type="button"
                            className="text-accent underline underline-offset-2"
                            disabled={revertingMemoryId === memory.id}
                            onClick={() => onRevert(memory.id, revision.id)}
                            data-testid="memory-revert-button"
                          >
                            <FormattedMessage id="action.revertMemory" />
                          </button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

function memoryKindMessageId(kind: string): string {
  switch (kind) {
    case "profile":
      return "memory.kind.profile";
    case "preference":
      return "memory.kind.preference";
    case "instruction":
      return "memory.kind.instruction";
    case "fact":
      return "memory.kind.fact";
    case "episode":
      return "memory.kind.episode";
    default:
      return "memory.kind.unknown";
  }
}

function memoryRevisionActionMessageId(action: string): string {
  switch (action) {
    case "create":
      return "memory.revisionAction.create";
    case "update":
      return "memory.revisionAction.update";
    case "delete":
      return "memory.revisionAction.delete";
    case "revert":
      return "memory.revisionAction.revert";
    default:
      return "memory.revisionAction.unknown";
  }
}

function ClientFeedDetail({
  feed,
  publications,
  onSelectIssue,
}: {
  feed: BriefSource;
  publications: readonly BriefPublication[];
  onSelectIssue: (issueId: string) => void;
}) {
  const intl = useIntl();
  const feedIssues = useMemo(() => {
    return publications
      .filter((issue) => issue.sourceId === feed.id && issue.status === "published")
      .sort((a, b) => (b.publicationDate ?? "").localeCompare(a.publicationDate ?? ""));
  }, [feed.id, publications]);

  const publicationRows = useMemo(
    () =>
      feedIssues.map((issue) => ({
        id: issue.id,
        title: issue.title,
        publicationDate: issue.publicationDate,
      })),
    [feedIssues],
  );

  return (
    <div className="space-y-8">
      <p className="font-serif text-sm leading-6 text-muted">{feed.description}</p>

      <section className="animate-in stagger-1">
        <SectionHeader
          title={intl.formatMessage({ id: "section.publications" })}
          count={feedIssues.length}
        />
        <div className="mt-4">
          {publicationRows.length === 0 ? (
            <div className="rounded-sm border border-rule bg-paper px-4 py-8 text-center text-sm text-muted">
              <FormattedMessage id="empty.publicationIssues" />
            </div>
          ) : (
            <ClientPublicationsTable
              publications={publicationRows}
              onSelectPublication={onSelectIssue}
            />
          )}
        </div>
      </section>
    </div>
  );
}

function ClientPublicationDetail({
  issue,
  sourceById,
}: {
  issue: BriefPublication;
  sourceById: ReadonlyMap<string, BriefSource>;
}) {
  return <PublisherPublicationDetail issue={issue} sourceById={sourceById} />;
}

function buildBreadcrumbs({
  selectedFeed,
  selectedClientIssue,
  locale,
  intl,
  applyDemoRoute,
}: {
  selectedFeed: BriefSource | null;
  selectedClientIssue: BriefPublication | null;
  locale: Locale;
  intl: ReturnType<typeof useIntl>;
  applyDemoRoute: (route: DemoRoute) => void;
}): readonly BreadcrumbItem[] {
  const chatLabel = intl.formatMessage({ id: "section.chat" });

  if (selectedFeed && selectedClientIssue) {
    return [
      {
        label: chatLabel,
        href: buildDemoPath({ locale, role: "client", sourceId: null, issueId: null }),
        onClick: () => applyDemoRoute({ locale, role: "client", sourceId: null, issueId: null }),
      },
      {
        label: selectedFeed.name,
        href: buildDemoPath({
          locale,
          role: "client",
          sourceId: selectedFeed.id,
          issueId: null,
        }),
        onClick: () =>
          applyDemoRoute({ locale, role: "client", sourceId: selectedFeed.id, issueId: null }),
      },
      { label: selectedClientIssue.title, truncate: true },
    ];
  }

  if (selectedFeed) {
    return [
      {
        label: chatLabel,
        href: buildDemoPath({ locale, role: "client", sourceId: null, issueId: null }),
        onClick: () => applyDemoRoute({ locale, role: "client", sourceId: null, issueId: null }),
      },
      { label: selectedFeed.name },
    ];
  }

  return [{ label: chatLabel }];
}

function computeSourceLastDate(
  source: BriefSource,
  publisherSourceIds: ReadonlySet<string>,
  publisherIssues: readonly BriefPublication[],
): string | null {
  if (!publisherSourceIds.has(source.id)) return source.latestPublicationDate;
  let latest: string | null = source.latestPublicationDate;
  for (const issue of publisherIssues) {
    if (
      issue.sourceId === source.id &&
      issue.publicationDate &&
      (latest === null || issue.publicationDate > latest)
    ) {
      latest = issue.publicationDate;
    }
  }
  return latest;
}

function toPublicationDetailIssue(
  issue: BriefPublication,
  sourceById: ReadonlyMap<string, BriefSource>,
): PublicationDetailIssue {
  return {
    id: issue.id,
    title: issue.title,
    sourceName: sourceById.get(issue.sourceId)?.name ?? "",
    publicationDate: issue.publicationDate,
    status: issue.status,
    summary: issue.summary,
    documents: issue.documents,
  };
}

function isEditableIssue(issue: BriefPublication) {
  return (
    issue.status === "scheduled" &&
    issue.publicationDate !== null &&
    new Date(issue.publicationDate).getTime() > Date.now()
  );
}

function clonePublication(issue: BriefPublication): BriefPublication {
  return {
    ...issue,
    documents: issue.documents.map((document) => ({
      ...document,
      metrics: { ...document.metrics },
    })),
    metrics: { ...issue.metrics },
  };
}

function createDraftDocument(
  issueId: string,
  sourceId: string,
  index: number,
): BriefPublication["documents"][number] {
  const id = `document_local_${Date.now()}_${index}`;
  return {
    id,
    publicationId: issueId,
    sourceId,
    title: `Document ${index}`,
    fileName: null,
    pageCount: 1,
    language: "fr",
    documentType: "pdf",
    storagePath: null,
    canonicalUrl: null,
    hostedContentUrl: null,
    textPreview: "Description éditable du document.",
    metrics: {
      opens: 0,
      downloads: 0,
      aiContextPulls: 0,
    },
  };
}

function getPublicPdfUrl(document: PublicationDocument) {
  if (document.canonicalUrl) return document.canonicalUrl;
  if (!document.storagePath || document.storagePath.startsWith("indexeddb://")) return null;
  const path = document.storagePath.startsWith("/")
    ? document.storagePath
    : `/${document.storagePath}`;
  return typeof window === "undefined" ? path : new URL(path, window.location.origin).href;
}

function resolveHostedContentUrl(url: string | null) {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  return new URL(url, publicApiBaseUrl).href;
}

function normalizePublicContentUrls(content: PublicSourcesResponse): PublicSourcesResponse {
  return {
    ...content,
    publications: content.publications.map((publication) => ({
      ...publication,
      documents: publication.documents.map((document) => ({
        ...document,
        hostedContentUrl: resolveHostedContentUrl(document.hostedContentUrl),
      })),
    })),
  };
}

async function openStoredDemoPdf(
  document: PublicationDocument,
  messages: { pdfNotFound: string; pdfOpenFailed: string },
): Promise<OpenStoredPdfResult> {
  try {
    const blob = await loadDemoPdf(document.id);
    if (!blob) return { ok: false, message: messages.pdfNotFound };
    const url = URL.createObjectURL(blob);
    const opened = window.open(url, "_blank", "noopener,noreferrer");
    if (!opened) {
      URL.revokeObjectURL(url);
      return { ok: false, message: messages.pdfOpenFailed };
    }
    window.setTimeout(() => URL.revokeObjectURL(url), 300_000);
    return { ok: true };
  } catch {
    return { ok: false, message: messages.pdfOpenFailed };
  }
}

function resetDemoStorage() {
  if (typeof window === "undefined") return;
  void clearDemoPdfStorage().catch(() => {});
  const keys = Array.from({ length: window.localStorage.length }, (_, index) =>
    window.localStorage.key(index),
  ).filter((key): key is string => Boolean(key?.startsWith("brief:demo:")));
  for (const key of keys) {
    window.localStorage.removeItem(key);
  }
}

const demoPdfDatabaseName = "brief-demo-pdfs";
const demoPdfStoreName = "pdfs";

function openDemoPdfDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined" || !window.indexedDB) {
      reject(new Error("IndexedDB is not available."));
      return;
    }

    const request = window.indexedDB.open(demoPdfDatabaseName, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(demoPdfStoreName);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Failed to open demo PDF storage."));
  });
}

function storeDemoPdf(documentId: string, file: File): Promise<void> {
  return runDemoPdfTransaction("readwrite", (store) => {
    store.put(file, documentId);
  });
}

async function loadDemoPdf(documentId: string): Promise<Blob | null> {
  if (typeof window === "undefined" || !window.indexedDB) return null;

  const db = await openDemoPdfDatabase();
  return await new Promise<Blob | null>((resolve, reject) => {
    const transaction = db.transaction(demoPdfStoreName, "readonly");
    const request = transaction.objectStore(demoPdfStoreName).get(documentId);
    request.onsuccess = () => resolve(request.result instanceof Blob ? request.result : null);
    request.onerror = () => reject(request.error ?? new Error("Failed to read demo PDF."));
    transaction.onerror = () => reject(transaction.error ?? new Error("Demo PDF storage failed."));
    transaction.onabort = () => reject(transaction.error ?? new Error("Demo PDF storage aborted."));
  }).finally(() => {
    db.close();
  });
}

function deleteDemoPdf(documentId: string): Promise<void> {
  return runDemoPdfTransaction("readwrite", (store) => {
    store.delete(documentId);
  });
}

function clearDemoPdfStorage(): Promise<void> {
  return runDemoPdfTransaction("readwrite", (store) => {
    store.clear();
  });
}

async function runDemoPdfTransaction(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => void,
): Promise<void> {
  if (typeof window === "undefined" || !window.indexedDB) return;

  const db = await openDemoPdfDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(demoPdfStoreName, mode);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Demo PDF storage failed."));
    transaction.onabort = () => reject(transaction.error ?? new Error("Demo PDF storage aborted."));
    work(transaction.objectStore(demoPdfStoreName));
  }).finally(() => {
    db.close();
  });
}

function useSessionState<T, I = T>(
  key: string,
  initialValue: T | (() => T),
  schema: Schema.Codec<T, I, never, never>,
): [T, (next: T | ((prev: T) => T)) => void, (nextValue: T) => void] {
  const [value, setValue] = useState<T>(() => {
    const fallback =
      typeof initialValue === "function" ? (initialValue as () => T)() : initialValue;
    if (typeof window === "undefined") return fallback;
    return readStoredOr(window.localStorage, key, schema, fallback);
  });

  function update(next: T | ((prev: T) => T)) {
    setValue((prev) => {
      const resolved = typeof next === "function" ? (next as (prev: T) => T)(prev) : next;
      let validated: T;
      try {
        validated = Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(resolved);
      } catch {
        return prev;
      }
      try {
        window.localStorage.setItem(key, JSON.stringify(validated));
      } catch {
        // Ignore storage failures; demo state stays in memory.
      }
      return validated;
    });
  }

  function reset(nextValue: T) {
    try {
      setValue(Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(nextValue));
    } catch {
      // Ignore invalid reset values.
    }
  }

  return [value, update, reset];
}

function LocaleMarketSwitcher() {
  const intl = useIntl();
  const setLocaleMarket = useSetLocaleMarket();
  const locale = useLocale();
  const market = useMarket();

  return (
    <div className="flex items-center gap-1">
      <select
        value={locale}
        data-testid="locale-switcher"
        aria-label={intl.formatMessage({ id: "localeSwitcher.label" })}
        className="h-7 rounded-sm border border-rule bg-canvas px-1 !text-[12px] font-medium leading-none text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent"
        onChange={(event) => {
          const next = event.target.value;
          if (!isLocale(next)) return;
          setLocaleMarket({ locale: next, market });
        }}
      >
        {LOCALES.map((optionLocale) => (
          <option key={optionLocale} value={optionLocale}>
            {intl.formatMessage({
              id: optionLocale === "fr-FR" ? "localeSwitcher.frFR" : "localeSwitcher.enUS",
            })}
          </option>
        ))}
      </select>
      <select
        value={market}
        data-testid="market-switcher"
        aria-label={intl.formatMessage({ id: "marketSwitcher.label" })}
        className="h-7 rounded-sm border border-rule bg-canvas px-1 !text-[12px] font-medium leading-none text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent"
        onChange={(event) => {
          const next = event.target.value;
          if (!isMarket(next)) return;
          setLocaleMarket({ locale, market: next });
        }}
      >
        {MARKETS.map((optionMarket) => (
          <option key={optionMarket} value={optionMarket}>
            {optionMarket}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * Root shell that owns the (locale, market) pair, wires it into the i18n
 * provider, persists user choices, syncs `<html lang>`, and rewrites the URL
 * to the new locale prefix when the user switches.
 */
function DemoShell() {
  const initial = useMemo<DemoRoute & { resolved: LocaleMarketPair }>(() => {
    const parsed = getDemoRouteFromPath(window.location.pathname);
    const prefix = getDemoLocalePrefixFromPath(window.location.pathname);
    const resolved = resolveDemoLocaleMarket(
      parsed.locale,
      getStoredMarket(),
      detectLocale(),
      prefix.forcedMarket,
    );
    return { ...parsed, resolved };
  }, []);

  const [locale, setLocale] = useState<Locale>(initial.resolved.locale);
  const [market, setMarket] = useState<Market>(initial.resolved.market);

  useEffect(() => {
    document.documentElement.lang = htmlLang(locale);
  }, [locale]);

  // If the entry URL had no locale, redirect to the resolved locale prefix.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const parsed = getDemoRouteFromPath(window.location.pathname);
    if (parsed.locale) return;
    const target = buildLocalePath(initial.resolved.locale, {
      role: parsed.role,
      sourceId: parsed.sourceId,
      issueId: parsed.issueId,
    });
    window.history.replaceState(null, "", target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleChangeLocaleMarket(next: LocaleMarketPair) {
    setLocale(next.locale);
    setMarket(next.market);
    setStoredLocale(next.locale);
    setStoredMarket(next.market);

    if (typeof window === "undefined") return;
    const parsed = getDemoRouteFromPath(window.location.pathname);
    const target = buildLocalePath(next.locale, {
      role: parsed.role,
      sourceId: parsed.sourceId,
      issueId: parsed.issueId,
    });
    if (window.location.pathname === target) return;
    window.history.pushState(null, "", target);
  }

  return (
    <I18nProvider locale={locale} market={market} onChangeLocaleMarket={handleChangeLocaleMarket}>
      <App />
    </I18nProvider>
  );
}

if (docsPath) {
  document.documentElement.lang = "en";
  createRoot(document.getElementById("root")!).render(<DocsDocument />);
} else if (!isDemoPdfPath(window.location.pathname)) {
  createRoot(document.getElementById("root")!).render(<DemoShell />);
}
