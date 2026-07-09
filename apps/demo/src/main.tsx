import { createRoot } from "react-dom/client";
import { RotateCcw, Send } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  demoDataset,
  type BriefPublication,
  type BriefSource,
  type DemoRole,
} from "@brief/demo-data";
import {
  DEFAULT_MARKET_FOR_LOCALE,
  I18nProvider,
  LOCALES,
  type Locale,
  type LocaleMarketPair,
  type Market,
  FormattedMessage,
  htmlLang,
  isLocale,
  useIntl,
  useLocale,
  useMarket,
  useSetLocaleMarket,
} from "@brief/i18n";
import type { PublicSourcesResponse } from "@brief/shared";
import {
  type DemoRoute,
  buildLocalePath,
  buildDemoPath,
  getDemoRouteFromPath,
  resolveDemoRoute,
} from "./routing";
import {
  detectLocale,
  getManualSourceSelection,
  setManualSourceSelection,
  setStoredLocale,
  setStoredMarket,
} from "./locale-bootstrap";
import {
  Breadcrumbs,
  Button,
  ClientFeedsTable,
  ClientPublicationsTable,
  PublicationDetail,
  PublicationsTable,
  SectionHeader,
  SourcesTable,
  SubscribersTable,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  Textarea,
  VirtualizedChatTranscript,
  type BreadcrumbItem,
  type ChatTranscriptCitation,
  type ChatTranscriptContextBlock,
  type ChatTranscriptMessage,
  type ClientFeedTableRow,
  type DraftSubscriber,
  type DraftSubscriberErrors,
  type OpenStoredPdfResult,
  type PublicationDetailIssue,
  type PublicationDocument,
  type PublicationTableIssue,
  type SourceTableRow,
  type SubscriberStatus,
  type SubscriberTableRow,
} from "@brief/ui";

import {
  mapApiMessagesToTranscript,
  type ChatApiResponse,
  type MemoriesApiResponse,
  type MemoryResponse,
  type SendMessageResponse,
} from "./chat-api";
import {
  initialChatStreamState,
  reduceChatStream,
  type ChatStreamEvent,
  type ChatStreamPhase,
} from "./chat-stream";
import "./styles.css";

const emptyPublicContent: PublicSourcesResponse = { sources: [], publications: [] };
const publicApiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3000";
const streamEventTypes: readonly ChatStreamEvent["type"][] = [
  "run_started",
  "preflight_search",
  "preflight_peek",
  "context_window",
  "answer_started",
  "answer_retry",
  "text_delta",
  "memory_updated",
  "usage",
  "done",
  "error",
];
const demoSubscriberProfiles = [
  {
    id: demoDataset.companies.client.id,
    company: demoDataset.companies.client.name,
    email: demoDataset.users.client.email,
  },
  {
    id: "client_saint_honore_capital",
    company: "Saint-Honore Capital",
    email: "operations@saint-honore-capital.example",
  },
  {
    id: "client_lutetia_risk_advisory",
    company: "Lutetia Risk Advisory",
    email: "veille@lutetia-risk.example",
  },
];

function isDemoPdfPath(pathname: string) {
  return pathname.startsWith("/demo/pdfs/") && pathname.endsWith(".pdf");
}

const clientFeedSubscriptionsKey = "brief:demo:client-feed-subscriptions:v1";
const legacyClientFilSubscriptionsKey = "brief:demo:client-fil-subscriptions:v1";

/**
 * One-time migration: copy the legacy `client-fil-subscriptions` localStorage
 * value into the renamed `client-feed-subscriptions` key when the new key is
 * absent, so existing demo users keep their feed subscriptions.
 */
function migrateClientFeedSubscriptions(): void {
  if (typeof window === "undefined") return;
  try {
    const hasNew = window.localStorage.getItem(clientFeedSubscriptionsKey);
    if (hasNew !== null) return;
    const legacy = window.localStorage.getItem(legacyClientFilSubscriptionsKey);
    if (legacy !== null) {
      window.localStorage.setItem(clientFeedSubscriptionsKey, legacy);
    }
  } catch {
    // Ignore storage failures; demo state stays in memory.
  }
}

async function fetchPublicContent(): Promise<PublicSourcesResponse> {
  const response = await fetch(new URL("/public-sources", publicApiBaseUrl));
  if (!response.ok) {
    throw new Error(`Failed to fetch public sources: ${response.status}`);
  }
  return normalizePublicContentUrls((await response.json()) as PublicSourcesResponse);
}

function apiUrl(path: string): URL {
  return new URL(path, publicApiBaseUrl);
}

async function fetchDemoChat(): Promise<ChatApiResponse> {
  const response = await fetch(apiUrl("/v1/chat"));
  if (!response.ok) {
    throw new Error(`Failed to fetch chat: ${response.status}`);
  }
  return (await response.json()) as ChatApiResponse;
}

async function postDemoChatMessage(input: {
  readonly text: string;
  readonly locale: Locale;
  readonly market: Market;
}): Promise<Response> {
  return fetch(apiUrl("/v1/chat/messages"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

async function fetchDemoMemories(): Promise<MemoriesApiResponse> {
  const response = await fetch(apiUrl("/v1/memories"));
  if (!response.ok) {
    throw new Error(`Failed to fetch memories: ${response.status}`);
  }
  return (await response.json()) as MemoriesApiResponse;
}

async function postRevertMemory(memoryId: string): Promise<void> {
  const response = await fetch(apiUrl(`/v1/memories/${encodeURIComponent(memoryId)}/revert`), {
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(`Failed to revert memory: ${response.status}`);
  }
}

function readInitialPublications() {
  const fallback = demoDataset.issues.map(clonePublication);
  if (typeof window === "undefined") return fallback;
  try {
    const stored = window.localStorage.getItem("brief:demo:issues:v1");
    return stored ? (JSON.parse(stored) as BriefPublication[]) : fallback;
  } catch {
    return fallback;
  }
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
  const [role, setRole] = useState<DemoRole>(() => initialRoute.role);
  const [issues, setIssues, resetIssues] = useSessionState<BriefPublication[]>(
    "brief:demo:issues:v1",
    initialPublications,
  );
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(initialRoute.sourceId);
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(initialRoute.issueId);
  const [resetVersion, setResetVersion] = useState(0);
  const [publicContent, setPublicContent] = useState<PublicSourcesResponse>(emptyPublicContent);
  const [publicContentStatus, setPublicContentStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const publicationsBySourceId = useMemo(() => buildPublicationsBySourceId(issues), [issues]);
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
    setRole(nextRoute.role);
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
    setPublicContentStatus("loading");
    void fetchPublicContent()
      .then((content) => {
        if (cancelled) return;
        setPublicContent(content);
        setPublicContentStatus("ready");
      })
      .catch(() => {
        if (cancelled) return;
        setPublicContent(emptyPublicContent);
        setPublicContentStatus("error");
      });

    return () => {
      cancelled = true;
    };
  }, []);

  function handleRoleChange(next: DemoRole) {
    if (next === role) return;
    applyDemoRoute({ locale, role: next, sourceId: null, issueId: null });
  }

  function handleSelectSource(id: string | null) {
    applyDemoRoute({ locale, role: "publisher", sourceId: id, issueId: null });
  }

  function handleCreateIssue(sourceId: string) {
    const issue = createDraftPublication(sourceId);
    setIssues((current) => [issue, ...current]);
    applyDemoRoute({ locale, role: "publisher", sourceId, issueId: issue.id }, "push", [
      issue,
      ...publications,
    ]);
  }

  function handleUpdateIssue(nextIssue: BriefPublication) {
    setIssues((current) => current.map((issue) => (issue.id === nextIssue.id ? nextIssue : issue)));
  }

  function handleDeleteIssue(issueId: string) {
    setIssues((current) => current.filter((issue) => issue.id !== issueId));
    if (selectedIssueId === issueId) {
      applyDemoRoute({ locale, role, sourceId: selectedSourceId, issueId: null }, "replace");
    }
  }

  function handleResetDemoStorage() {
    resetDemoStorage();
    resetIssues(demoDataset.issues.map(clonePublication));
    applyDemoRoute({ locale, role, sourceId: null, issueId: null }, "replace");
    setResetVersion((version) => version + 1);
  }

  const selectedSource = selectedSourceId ? (sourceById.get(selectedSourceId) ?? null) : null;
  const selectedIssue =
    selectedSource?.kind === "publisher" && selectedIssueId
      ? ((publicationsBySourceId.get(selectedSource.id) ?? []).find(
          (issue) => issue.id === selectedIssueId,
        ) ?? null)
      : null;
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
      <Tabs value={role} onValueChange={(v) => handleRoleChange(v as DemoRole)}>
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
                <TabsList className="h-7 rounded-sm bg-canvas p-px">
                  <TabsTrigger
                    value="publisher"
                    className="h-6 rounded-sm px-2 !text-[12px] font-medium leading-none tracking-normal data-[state=active]:bg-paper data-[state=active]:text-ink data-[state=active]:shadow-none data-[state=inactive]:text-faint data-[state=inactive]:hover:bg-paper/70 data-[state=inactive]:hover:text-muted"
                  >
                    <FormattedMessage id="role.publisher" />
                  </TabsTrigger>
                  <TabsTrigger
                    value="client"
                    className="h-6 rounded-sm px-2 !text-[12px] font-medium leading-none tracking-normal data-[state=active]:bg-paper data-[state=active]:text-ink data-[state=active]:shadow-none data-[state=inactive]:text-faint data-[state=inactive]:hover:bg-paper/70 data-[state=inactive]:hover:text-muted"
                  >
                    <FormattedMessage id="role.client" />
                  </TabsTrigger>
                </TabsList>
                <LocaleMarketSwitcher />
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-7 text-faint/70 hover:bg-rule/45 hover:text-muted"
                      onClick={handleResetDemoStorage}
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
                  role,
                  selectedIssue,
                  selectedSource,
                  selectedFeed,
                  selectedClientIssue,
                  locale,
                  intl,
                  applyDemoRoute,
                  handleSelectSource,
                })}
              />
            </div>
            <TabsContent value="publisher" className="mt-0">
              {selectedSource && selectedIssue ? (
                <PublisherPublicationDetail
                  issue={selectedIssue}
                  sourceById={sourceById}
                  onDeleteIssue={handleDeleteIssue}
                  onUpdateIssue={handleUpdateIssue}
                />
              ) : selectedSource ? (
                <PublisherSourceDetail
                  key={`${selectedSource.id}:${resetVersion}`}
                  source={selectedSource}
                  issues={publicationsBySourceId.get(selectedSource.id) ?? []}
                  onCreateIssue={handleCreateIssue}
                  onDeleteIssue={handleDeleteIssue}
                  onSelectIssue={(issueId) =>
                    applyDemoRoute({
                      locale,
                      role: "publisher",
                      sourceId: selectedSource.id,
                      issueId,
                    })
                  }
                />
              ) : (
                <PublisherSourcesList
                  publicationsBySourceId={publicationsBySourceId}
                  onSelect={handleSelectSource}
                />
              )}
            </TabsContent>
            <TabsContent value="client" className="mt-0">
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
                />
              )}
            </TabsContent>
          </div>
        </main>
      </Tabs>
    </TooltipProvider>
  );
}

function PublisherSourcesList({
  publicationsBySourceId,
  onSelect,
}: {
  publicationsBySourceId: ReadonlyMap<string, readonly BriefPublication[]>;
  onSelect: (id: string) => void;
}) {
  const rows = useMemo<SourceTableRow[]>(
    () =>
      demoDataset.sources.map((source) => {
        const issues = publicationsBySourceId.get(source.id) ?? [];
        const latestPublishedIssue =
          issues.find((issue) => issue.status === "published") ?? issues[0];
        return {
          id: source.id,
          name: source.name,
          issueCount: issues.length,
          lastPublishedAt: latestPublishedIssue?.publicationDate ?? null,
          subscriberCount: source.subscriberCount,
        };
      }),
    [publicationsBySourceId],
  );

  return (
    <section className="animate-in stagger-1">
      <SourcesTable rows={rows} onSelectSource={onSelect} />
    </section>
  );
}

function PublisherSourceDetail({
  source,
  issues,
  onCreateIssue,
  onDeleteIssue,
  onSelectIssue,
}: {
  source: BriefSource;
  issues: readonly BriefPublication[];
  onCreateIssue: (sourceId: string) => void;
  onDeleteIssue: (id: string) => void;
  onSelectIssue: (id: string) => void;
}) {
  const intl = useIntl();
  const [subscriberState, setSubscriberState] = useSessionState<SubscriberSessionState>(
    `brief:demo:publisher-subscribers:${source.id}`,
    { statuses: {}, deletedIds: [] },
  );
  const [draftSubscriber, setDraftSubscriber] = useState<DraftSubscriber | null>(null);
  const [draftErrors, setDraftErrors] = useState<DraftSubscriberErrors>({});
  const subscribers = useMemo(
    () => buildSubscriberRows(source, subscriberState),
    [source, subscriberState],
  );
  const subscriberCompanies = useMemo(
    () =>
      Array.from(
        new Set([
          ...subscribers.map((row) => row.company),
          ...demoSubscriberProfiles.map((profile) => profile.company),
        ]),
      ).sort((a, b) => a.localeCompare(b)),
    [subscribers],
  );

  function handleToggleSubscriberStatus(id: string) {
    setSubscriberState((current) => ({
      ...current,
      statuses: {
        ...current.statuses,
        [id]: current.statuses[id] === "paused" ? "active" : "paused",
      },
    }));
  }

  function handleDeleteSubscriber(id: string) {
    setSubscriberState((current) => ({
      ...current,
      deletedIds: current.deletedIds.includes(id)
        ? current.deletedIds
        : [...current.deletedIds, id],
    }));
  }

  function handleCreateSubscriber() {
    if (!draftSubscriber) return;

    const errors = validateDraftSubscriber(draftSubscriber, subscribers, intl);
    setDraftErrors(errors);
    if (Object.keys(errors).length > 0) return;

    const subscriber: CreatedSubscriberRow = {
      id: `subscriber_demo_${Date.now()}`,
      company: draftSubscriber.company.trim(),
      email: draftSubscriber.email.trim(),
      subscribedSince: new Date().toISOString(),
      status: "active",
    };

    setSubscriberState((current) => ({
      ...current,
      created: [...(current.created ?? []), subscriber],
    }));
    setDraftSubscriber(null);
    setDraftErrors({});
  }

  function handleCancelSubscriberDraft() {
    setDraftErrors({});
    setDraftSubscriber(null);
  }

  return (
    <div className="space-y-8">
      <p className="font-serif text-sm leading-6 text-muted">{source.description}</p>

      <div className="animate-in stagger-1 grid gap-8 xl:grid-cols-[1.3fr_0.7fr]">
        <section>
          <SectionHeader
            title={intl.formatMessage({ id: "section.publications" })}
            count={issues.length}
            actionLabel={intl.formatMessage({ id: "action.createPublication" })}
            onAdd={() => onCreateIssue(source.id)}
          />
          <div className="mt-4">
            <PublicationsTable
              issues={toPublicationTableIssues(issues)}
              compact
              onDeleteScheduledIssue={onDeleteIssue}
              onSelectIssue={onSelectIssue}
            />
          </div>
        </section>

        <section>
          <SectionHeader
            title={intl.formatMessage({ id: "section.subscribers" })}
            count={subscribers.length}
            actionLabel={intl.formatMessage({ id: "action.addSubscriber" })}
            onAdd={() => setDraftSubscriber((current) => current ?? { company: "", email: "" })}
          />
          <div className="mt-4">
            <SubscribersTable
              rows={subscribers}
              draft={draftSubscriber}
              draftErrors={draftErrors}
              companyOptions={subscriberCompanies}
              onCancelDraft={handleCancelSubscriberDraft}
              onConfirmDraft={handleCreateSubscriber}
              onDelete={handleDeleteSubscriber}
              onToggleStatus={handleToggleSubscriberStatus}
              onUpdateDraft={(nextDraft) => {
                setDraftErrors((current) =>
                  clearResolvedDraftErrors(current, nextDraft, subscribers, intl),
                );
                setDraftSubscriber(nextDraft);
              }}
            />
          </div>
        </section>
      </div>
    </div>
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
}: {
  market: Market;
  sources: readonly BriefSource[];
  publications: readonly BriefPublication[];
  publicContentStatus: "loading" | "ready" | "error";
  onSelectFeed: (feedId: string) => void;
}) {
  const intl = useIntl();
  const locale = useLocale();
  const publishedIssues = publications.filter((issue) => issue.status === "published");
  const manualSources = useMemo(getManualSourceSelection, []);
  const [chatMessages, setChatMessages] = useState<readonly ChatTranscriptMessage[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [chatStatus, setChatStatus] = useState<"loading" | "ready" | "error">("loading");
  const [draftMessage, setDraftMessage] = useState("");
  const [sendStatus, setSendStatus] = useState<"idle" | "sending">("idle");
  const [chatNotice, setChatNotice] = useState<string | null>(null);
  const [chatError, setChatError] = useState<string | null>(null);
  const [failedMessage, setFailedMessage] = useState<string | null>(null);
  const [streamState, setStreamState] = useState(initialChatStreamState);
  const streamSeqRef = useRef(0);
  const [memories, setMemories] = useState<readonly MemoryResponse[]>([]);
  const [memoriesStatus, setMemoriesStatus] = useState<"loading" | "ready" | "error">("loading");
  const [memoryError, setMemoryError] = useState<string | null>(null);
  const [revertingMemoryId, setRevertingMemoryId] = useState<string | null>(null);

  // `feedSubscriptions` stores only the user's *manual overrides*. The default
  // subscription state is derived reactively from the active market so that
  // switching locale/market re-defaults public sources (subscribed when their
  // country matches the market). Once the user toggles a source manually, the
  // `manualSources` flag is set and their persisted overrides always win.
  const [feedSubscriptions, setFeedSubscriptions] = useSessionState<Record<string, boolean>>(
    clientFeedSubscriptionsKey,
    {},
  );

  const refreshChat = useCallback(async () => {
    const chat = await fetchDemoChat();
    setChatMessages(mapApiMessagesToTranscript(chat.messages));
    setActiveRunId(chat.activeRunId);
    setChatStatus("ready");
    return chat;
  }, []);

  const refreshMemories = useCallback(async () => {
    const result = await fetchDemoMemories();
    setMemories(result.memories);
    setMemoriesStatus("ready");
    setMemoryError(null);
    return result;
  }, []);

  useEffect(() => {
    let cancelled = false;
    setChatStatus("loading");
    void fetchDemoChat()
      .then((chat) => {
        if (cancelled) return;
        setChatMessages(mapApiMessagesToTranscript(chat.messages));
        setActiveRunId(chat.activeRunId);
        setChatStatus("ready");
      })
      .catch(() => {
        if (cancelled) return;
        setChatStatus("error");
      });

    return () => {
      cancelled = true;
    };
  }, []);

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
      setStreamState(initialChatStreamState);
      return;
    }

    let closed = false;
    let eventSource: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    streamSeqRef.current = 0;
    setStreamState(initialChatStreamState);

    const closeCurrent = () => {
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      eventSource?.close();
      eventSource = null;
    };

    const handleStreamMessage = (message: MessageEvent<string>) => {
      const seq = Number.parseInt(message.lastEventId, 10);
      if (!Number.isFinite(seq) || seq <= 0) return;

      const event = JSON.parse(message.data) as ChatStreamEvent;
      setStreamState((current) => {
        const next = reduceChatStream(current, { seq, event });
        streamSeqRef.current = next.seq;
        return next;
      });

      if (event.type === "done" || event.type === "error") {
        closed = true;
        closeCurrent();
        void refreshChat().catch(() => setChatStatus("error"));
        void refreshMemories().catch(() => setMemoriesStatus("error"));
      }
    };

    const connect = () => {
      if (closed) return;
      const url = apiUrl(`/v1/ai-runs/${encodeURIComponent(activeRunId)}/stream`);
      if (streamSeqRef.current > 0) {
        url.searchParams.set("afterSeq", String(streamSeqRef.current));
      }

      const source = new EventSource(url.toString());
      eventSource = source;
      for (const type of streamEventTypes) {
        source.addEventListener(type, (event) =>
          handleStreamMessage(event as MessageEvent<string>),
        );
      }
      source.onerror = () => {
        if (closed) return;
        source.close();
        reconnectTimer = setTimeout(connect, 1000);
      };
    };

    connect();

    return () => {
      closed = true;
      closeCurrent();
    };
  }, [activeRunId, refreshChat, refreshMemories]);

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (trimmed.length === 0 || sendStatus === "sending" || activeRunId !== null) return;

      setSendStatus("sending");
      setChatNotice(null);
      setChatError(null);
      setFailedMessage(null);

      try {
        const response = await postDemoChatMessage({ text: trimmed, locale, market });
        if (response.status === 409) {
          setChatNotice(intl.formatMessage({ id: "chat.runActive" }));
          await refreshChat();
          return;
        }

        if (!response.ok) {
          setFailedMessage(trimmed);
          setChatError(intl.formatMessage({ id: "chat.sendFailed" }));
          return;
        }

        const body = (await response.json()) as SendMessageResponse;
        setDraftMessage("");
        setActiveRunId(body.runId);
        await refreshChat();
      } catch {
        setFailedMessage(trimmed);
        setChatError(intl.formatMessage({ id: "chat.sendFailed" }));
      } finally {
        setSendStatus("idle");
      }
    },
    [activeRunId, intl, locale, market, refreshChat, sendStatus],
  );

  async function handleRevertMemory(memoryId: string) {
    setRevertingMemoryId(memoryId);
    setMemoryError(null);
    try {
      await postRevertMemory(memoryId);
      await refreshMemories();
      await refreshChat();
    } catch {
      setMemoryError(intl.formatMessage({ id: "chat.memoryRevertFailed" }));
    } finally {
      setRevertingMemoryId(null);
    }
  }

  function isSourceSubscribed(source: BriefSource): boolean {
    const override = feedSubscriptions[source.id];
    if (override !== undefined) return override;
    if (manualSources) return source.subscribed;
    return source.kind === "publisher" ? source.subscribed : source.country === market;
  }

  const rows = useMemo<ClientFeedTableRow[]>(() => {
    const publisherIssueSourceIds = new Set(publishedIssues.map((i) => i.sourceId));
    return sources.map((source) => ({
      id: source.id,
      name: source.name,
      description: source.description,
      sourceType: source.kind === "publisher" ? "publisher_invite" : "public",
      subscribed: isSourceSubscribed(source),
      lastPublicationDate: computeSourceLastDate(source, publisherIssueSourceIds, publishedIssues),
      publisherName: source.publisherName,
    }));
  }, [feedSubscriptions, manualSources, market, publishedIssues, sources]);

  function handleToggleSubscribed(feedId: string) {
    setManualSourceSelection(true);
    setFeedSubscriptions((current) => ({
      ...current,
      [feedId]: !(current[feedId] ?? true),
    }));
  }

  const runActive = activeRunId !== null;
  const transcriptMessages = useMemo(
    () => buildTranscriptMessages(chatMessages, activeRunId, streamState.phase, streamState),
    [activeRunId, chatMessages, streamState],
  );
  const showProgress =
    runActive &&
    (streamState.phase === "idle" ||
      streamState.phase === "preflight" ||
      streamState.phase === "retrying");

  return (
    <div className="mx-auto max-w-5xl space-y-7">
      <section className="animate-in stagger-1">
        <VirtualizedChatTranscript messages={transcriptMessages} />

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
        {showProgress ? (
          <p className="mt-2 font-mono text-[11px] text-muted">
            <FormattedMessage
              id="chat.searchingSources"
              values={{
                searches: streamState.searchCount,
                results: streamState.latestResultCount,
              }}
            />
          </p>
        ) : null}
        {streamState.phase === "error" && streamState.error ? (
          <p className="mt-2 font-mono text-[11px] text-accent">
            <FormattedMessage
              id={streamState.error.retryable ? "chat.streamRetryable" : "chat.streamFailed"}
              values={{ code: streamState.error.code }}
            />
          </p>
        ) : null}

        <form
          className="mt-4 flex items-end gap-2 border-t border-rule pt-3"
          onSubmit={(event) => {
            event.preventDefault();
            void sendMessage(draftMessage);
          }}
        >
          <Textarea
            value={draftMessage}
            onChange={(event) => setDraftMessage(event.currentTarget.value)}
            placeholder={intl.formatMessage({ id: "chat.placeholder" })}
            disabled={runActive || sendStatus === "sending"}
            rows={2}
            className="min-h-10 resize-none bg-paper"
          />
          <Button
            type="submit"
            disabled={runActive || sendStatus === "sending" || draftMessage.trim().length === 0}
          >
            <Send className="size-4" aria-hidden="true" />
            <FormattedMessage id="action.send" />
          </Button>
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

      <section className="animate-in stagger-2 border-y border-rule py-3">
        <MemoriesPanel
          memories={memories}
          status={memoriesStatus}
          error={memoryError}
          revertingMemoryId={revertingMemoryId}
          onRevert={handleRevertMemory}
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
        <div className="mt-3">
          <ClientFeedsTable
            rows={rows}
            onSelectFeed={onSelectFeed}
            onToggleSubscribed={handleToggleSubscribed}
          />
        </div>
      </section>
    </div>
  );
}

function isStreamingPhase(phase: ChatStreamPhase): boolean {
  return phase === "answering" || phase === "retrying";
}

function citationFromContextBlock(block: ChatTranscriptContextBlock): ChatTranscriptCitation {
  return {
    id: block.blockId,
    label: block.label,
    url: null,
    publishedAt: null,
    title: block.label,
    sourceDisplayName: null,
  };
}

function buildTranscriptMessages(
  messages: readonly ChatTranscriptMessage[],
  activeRunId: string | null,
  phase: ChatStreamPhase,
  stream: {
    readonly assistantText: string;
    readonly contextBlocks: readonly ChatTranscriptContextBlock[];
  },
): readonly ChatTranscriptMessage[] {
  if (activeRunId === null || !isStreamingPhase(phase)) return messages;

  return [
    ...messages,
    {
      id: `streaming:${activeRunId}`,
      author: "assistant",
      content: stream.assistantText,
      citations: stream.contextBlocks.map(citationFromContextBlock),
      contextBlocks: stream.contextBlocks,
      streaming: true,
    },
  ];
}

function MemoriesPanel({
  memories,
  status,
  error,
  revertingMemoryId,
  onRevert,
}: {
  memories: readonly MemoryResponse[];
  status: "loading" | "ready" | "error";
  error: string | null;
  revertingMemoryId: string | null;
  onRevert: (memoryId: string) => void;
}) {
  const intl = useIntl();
  const [expandedMemoryId, setExpandedMemoryId] = useState<string | null>(null);

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
      {status === "ready" && memories.length === 0 ? (
        <p className="mt-2 text-sm text-muted">
          <FormattedMessage id="state.noMemories" />
        </p>
      ) : null}

      {memories.length > 0 ? (
        <ul className="mt-2 divide-y divide-rule">
          {memories.map((memory) => {
            const expanded = expandedMemoryId === memory.id;
            return (
              <li key={memory.id} className="py-2">
                <div className="grid gap-2 sm:grid-cols-[7rem_1fr_auto] sm:items-start">
                  <div className="font-mono text-[11px] uppercase tracking-wider text-faint">
                    {intl.formatMessage(
                      { id: memoryKindMessageId(memory.kind) },
                      { kind: memory.kind },
                    )}
                    {memory.deleted ? (
                      <span className="mt-1 block text-accent">
                        <FormattedMessage id="memory.deleted" />
                      </span>
                    ) : null}
                  </div>
                  <div>
                    <p className="font-serif text-sm leading-5 text-ink">{memory.content}</p>
                    <p className="mt-1 font-mono text-[11px] text-faint">
                      {memory.updatedAt.slice(0, 10)}
                    </p>
                    {memory.revisions.length > 0 ? (
                      <button
                        type="button"
                        className="mt-1 font-mono text-[11px] text-muted underline decoration-rule underline-offset-2 hover:text-accent"
                        onClick={() => setExpandedMemoryId(expanded ? null : memory.id)}
                      >
                        <FormattedMessage
                          id={expanded ? "action.hideRevisions" : "action.viewRevisions"}
                        />
                      </button>
                    ) : null}
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={revertingMemoryId === memory.id}
                    onClick={() => onRevert(memory.id)}
                  >
                    <FormattedMessage id="action.revertMemory" />
                  </Button>
                </div>
                {expanded ? (
                  <ul className="mt-2 space-y-1 border-l border-rule pl-3">
                    {memory.revisions.map((revision) => (
                      <li key={revision.id} className="font-mono text-[11px] text-muted">
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
    case "created":
      return "memory.revisionAction.created";
    case "updated":
      return "memory.revisionAction.updated";
    case "deleted":
      return "memory.revisionAction.deleted";
    case "reverted":
      return "memory.revisionAction.reverted";
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
  role,
  selectedIssue,
  selectedSource,
  selectedFeed,
  selectedClientIssue,
  locale,
  intl,
  applyDemoRoute,
  handleSelectSource,
}: {
  role: DemoRole;
  selectedIssue: BriefPublication | null;
  selectedSource: BriefSource | null;
  selectedFeed: BriefSource | null;
  selectedClientIssue: BriefPublication | null;
  locale: Locale;
  intl: ReturnType<typeof useIntl>;
  applyDemoRoute: (route: DemoRoute) => void;
  handleSelectSource: (id: string | null) => void;
}): readonly BreadcrumbItem[] {
  const chatLabel = intl.formatMessage({ id: "section.chat" });
  const feedsLabel = intl.formatMessage({ id: "section.feeds" });

  if (role === "client") {
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

  if (!selectedSource) return [{ label: feedsLabel }];

  const sourceCrumb = selectedIssue
    ? [
        {
          label: selectedSource.name,
          href: buildDemoPath({
            locale,
            role: "publisher",
            sourceId: selectedSource.id,
            issueId: null,
          }),
          onClick: () =>
            applyDemoRoute({
              locale,
              role: "publisher",
              sourceId: selectedSource.id,
              issueId: null,
            }),
        },
        { label: selectedIssue.title, truncate: true },
      ]
    : [{ label: selectedSource.name }];

  return [
    {
      label: feedsLabel,
      href: buildDemoPath({ locale, role: "publisher", sourceId: null, issueId: null }),
      onClick: () => handleSelectSource(null),
    },
    ...sourceCrumb,
  ];
}

function toPublicationTableIssues(
  issues: readonly BriefPublication[],
  sourceById?: ReadonlyMap<string, BriefSource>,
): PublicationTableIssue[] {
  return issues.map((issue) => ({
    id: issue.id,
    title: issue.title,
    sourceName: sourceById?.get(issue.sourceId)?.name ?? "",
    publicationDate: issue.publicationDate,
    opens: issue.metrics.opens,
    downloads: issue.metrics.downloads,
    contextPulls: issue.metrics.aiContextPulls,
    status: issue.status,
  }));
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

type SubscriberSessionState = {
  statuses: Record<string, SubscriberStatus>;
  deletedIds: readonly string[];
  created?: readonly CreatedSubscriberRow[];
};

type CreatedSubscriberRow = SubscriberTableRow;

function buildSubscriberRows(
  source: BriefSource,
  state: SubscriberSessionState,
): SubscriberTableRow[] {
  const baseDate = new Date(source.subscribedSince).getTime();
  const seededRows = demoSubscriberProfiles
    .slice(0, Math.max(1, source.subscriberCount))
    .map((profile, index) => {
      const status: SubscriberStatus =
        state.statuses[profile.id] === "paused" ? "paused" : "active";
      return {
        id: profile.id,
        company: profile.company,
        email: profile.email,
        subscribedSince: new Date(baseDate - index * 86_400_000 * 12).toISOString(),
        status,
      };
    })
    .filter((row) => !state.deletedIds.includes(row.id));

  const createdRows = (state.created ?? [])
    .filter((row) => !state.deletedIds.includes(row.id))
    .map((row) => ({
      ...row,
      status: state.statuses[row.id] === "paused" ? "paused" : row.status,
    }));

  return [...seededRows, ...createdRows];
}

function validateDraftSubscriber(
  draft: DraftSubscriber,
  rows: readonly SubscriberTableRow[],
  intl: ReturnType<typeof useIntl>,
): DraftSubscriberErrors {
  const errors: DraftSubscriberErrors = {};
  const company = draft.company.trim();
  const email = draft.email.trim();

  if (!company) {
    errors.company = intl.formatMessage({ id: "error.companyRequired" });
  }

  if (!email) {
    errors.email = intl.formatMessage({ id: "error.emailRequired" });
  } else if (!isValidEmail(email)) {
    errors.email = intl.formatMessage({ id: "error.emailInvalid" });
  } else if (
    rows.some(
      (row) => row.email.toLocaleLowerCase(intl.locale) === email.toLocaleLowerCase(intl.locale),
    )
  ) {
    errors.email = intl.formatMessage({ id: "error.emailDuplicate" });
  }

  return errors;
}

function clearResolvedDraftErrors(
  errors: DraftSubscriberErrors,
  draft: DraftSubscriber,
  rows: readonly SubscriberTableRow[],
  intl: ReturnType<typeof useIntl>,
): DraftSubscriberErrors {
  if (Object.keys(errors).length === 0) return errors;
  const nextErrors = validateDraftSubscriber(draft, rows, intl);
  return Object.fromEntries(
    Object.entries(errors).filter(([field]) => nextErrors[field as keyof DraftSubscriber]),
  );
}

function isValidEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isEditableIssue(issue: BriefPublication) {
  return (
    issue.status === "scheduled" &&
    issue.publicationDate !== null &&
    new Date(issue.publicationDate).getTime() > Date.now()
  );
}

function buildPublicationsBySourceId(issues: readonly BriefPublication[]) {
  const map = new Map<string, BriefPublication[]>();
  for (const issue of [...issues].sort((a, b) =>
    (b.publicationDate ?? "").localeCompare(a.publicationDate ?? ""),
  )) {
    const sourceIssues = map.get(issue.sourceId) ?? [];
    sourceIssues.push(issue);
    map.set(issue.sourceId, sourceIssues);
  }
  return map;
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

function createDraftPublication(sourceId: string): BriefPublication {
  const id = `publication_local_${Date.now()}`;
  const publicationDate = new Date(Date.now() + 86_400_000 * 7).toISOString();
  return {
    id,
    sourceId,
    sourceKind: "publisher",
    title: "Nouvelle publication",
    publicationDate,
    status: "scheduled",
    summary: "Résumé éditable de la publication planifiée.",
    canonicalUrl: null,
    documents: [createDraftDocument(id, sourceId, 1)],
    metrics: {
      opens: 0,
      downloads: 0,
      aiContextPulls: 0,
    },
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

function useSessionState<T>(
  key: string,
  initialValue: T | (() => T),
): [T, (next: T | ((prev: T) => T)) => void, (nextValue: T) => void] {
  const [value, setValue] = useState<T>(() => {
    const fallback =
      typeof initialValue === "function" ? (initialValue as () => T)() : initialValue;
    if (typeof window === "undefined") return fallback;
    try {
      const stored = window.localStorage.getItem(key);
      return stored ? (JSON.parse(stored) as T) : fallback;
    } catch {
      return fallback;
    }
  });

  function update(next: T | ((prev: T) => T)) {
    setValue((prev) => {
      const resolved = typeof next === "function" ? (next as (prev: T) => T)(prev) : next;
      try {
        window.localStorage.setItem(key, JSON.stringify(resolved));
      } catch {
        // Ignore storage failures; demo state stays in memory.
      }
      return resolved;
    });
  }

  function reset(nextValue: T) {
    setValue(nextValue);
  }

  return [value, update, reset];
}

function LocaleMarketSwitcher() {
  const intl = useIntl();
  const setLocaleMarket = useSetLocaleMarket();
  const locale = useLocale();

  return (
    <select
      value={locale}
      aria-label={intl.formatMessage({ id: "localeSwitcher.label" })}
      className="h-7 rounded-sm border border-rule bg-canvas px-1 !text-[12px] font-medium leading-none text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent"
      onChange={(event) => {
        const next = event.target.value;
        if (!isLocale(next)) return;
        setLocaleMarket({ locale: next, market: DEFAULT_MARKET_FOR_LOCALE[next] });
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
  );
}

/**
 * Root shell that owns the (locale, market) pair, wires it into the i18n
 * provider, persists user choices, syncs `<html lang>`, and rewrites the URL
 * to the new locale prefix when the user switches.
 */
function DemoShell() {
  const initial = useMemo<DemoRoute & { resolved: LocaleMarketPair }>(() => {
    migrateClientFeedSubscriptions();
    const parsed = getDemoRouteFromPath(window.location.pathname);
    const resolved = parsed.locale
      ? {
          locale: parsed.locale,
          market: DEFAULT_MARKET_FOR_LOCALE[parsed.locale],
        }
      : detectLocale();
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

if (!isDemoPdfPath(window.location.pathname)) {
  createRoot(document.getElementById("root")!).render(<DemoShell />);
}
