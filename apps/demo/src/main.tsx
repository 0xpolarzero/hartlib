import { createRoot } from "react-dom/client";
import { RotateCcw, Send } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  demoDataset,
  type DemoIssue,
  type DemoRole,
  type DemoSubscriptionSource,
} from "@brief/demo-data";
import {
  Breadcrumbs,
  Button,
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
  VirtualizedChatTranscript,
  type BreadcrumbItem,
  type ClientPublicationTableRow,
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

import "./styles.css";

const sourceById = new Map(demoDataset.sources.map((s) => [s.id, s]));
const primaryChat = demoDataset.chats[0];
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

type DemoRoute = {
  role: DemoRole;
  sourceId: string | null;
  issueId: string | null;
};

function getDemoRouteFromPath(
  pathname = typeof window === "undefined" ? "" : window.location.pathname,
): DemoRoute {
  const [scope, segment, sourceId, nestedSegment, issueId] = pathname
    .split("/")
    .filter(Boolean)
    .map(decodeURIComponent);

  if (scope === "client") {
    return {
      role: "client",
      sourceId: null,
      issueId: segment === "publications" ? (sourceId ?? null) : null,
    };
  }

  if (scope === "publisher" && segment === "sources") {
    return {
      role: "publisher",
      sourceId: sourceId ?? null,
      issueId: nestedSegment === "publications" ? (issueId ?? null) : null,
    };
  }

  return {
    role: "publisher",
    sourceId: null,
    issueId: null,
  };
}

function buildDemoPath(route: DemoRoute) {
  if (route.role === "client") {
    return route.issueId ? `/client/publications/${encodeURIComponent(route.issueId)}` : "/client";
  }

  if (!route.sourceId) return "/publisher";

  const sourcePath = `/publisher/sources/${encodeURIComponent(route.sourceId)}`;
  return route.issueId
    ? `${sourcePath}/publications/${encodeURIComponent(route.issueId)}`
    : sourcePath;
}

function resolveDemoRoute(route: DemoRoute, issues: readonly DemoIssue[]): DemoRoute {
  if (route.role === "client") {
    if (!route.issueId) {
      return { role: "client", sourceId: null, issueId: null };
    }

    const issue = issues.find(
      (candidate) => candidate.id === route.issueId && candidate.status === "published",
    );
    if (!issue) return { role: "client", sourceId: null, issueId: null };

    return {
      role: "client",
      sourceId: issue.sourceId,
      issueId: issue.id,
    };
  }

  if (!route.sourceId || !sourceById.has(route.sourceId)) {
    return { role: "publisher", sourceId: null, issueId: null };
  }

  if (!route.issueId) {
    return { role: "publisher", sourceId: route.sourceId, issueId: null };
  }

  const issue = issues.find(
    (candidate) => candidate.id === route.issueId && candidate.sourceId === route.sourceId,
  );
  if (!issue) {
    return { role: "publisher", sourceId: route.sourceId, issueId: null };
  }

  return {
    role: "publisher",
    sourceId: route.sourceId,
    issueId: issue.id,
  };
}

function readInitialDemoIssues() {
  const fallback = demoDataset.issues.map(cloneIssue);
  if (typeof window === "undefined") return fallback;
  try {
    const stored = window.localStorage.getItem("brief:demo:issues:v1");
    return stored ? (JSON.parse(stored) as DemoIssue[]) : fallback;
  } catch {
    return fallback;
  }
}

function App() {
  const initialIssues = useMemo(readInitialDemoIssues, []);
  const initialRoute = useMemo(() => resolveDemoRoute(getDemoRouteFromPath(), initialIssues), []);
  const [role, setRole] = useState<DemoRole>(() => initialRoute.role);
  const [issues, setIssues, resetIssues] = useSessionState<DemoIssue[]>(
    "brief:demo:issues:v1",
    initialIssues,
  );
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(initialRoute.sourceId);
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(initialRoute.issueId);
  const [resetVersion, setResetVersion] = useState(0);
  const issuesBySourceId = useMemo(() => buildIssuesBySourceId(issues), [issues]);

  function applyDemoRoute(
    route: DemoRoute,
    historyMode: "push" | "replace" = "push",
    routeIssues: readonly DemoIssue[] = issues,
  ) {
    const nextRoute = resolveDemoRoute(route, routeIssues);
    setRole(nextRoute.role);
    setSelectedSourceId(nextRoute.sourceId);
    setSelectedIssueId(nextRoute.issueId);

    if (typeof window === "undefined") return;
    const nextPath = buildDemoPath(nextRoute);
    if (window.location.pathname === nextPath) return;
    if (historyMode === "replace") {
      window.history.replaceState(null, "", nextPath);
      return;
    }
    window.history.pushState(null, "", nextPath);
  }

  useEffect(() => {
    if (typeof window === "undefined") return;
    applyDemoRoute(getDemoRouteFromPath(), "replace");

    function handlePopState() {
      applyDemoRoute(getDemoRouteFromPath(), "replace");
    }

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [issues]);

  function handleRoleChange(next: DemoRole) {
    if (next === role) return;
    applyDemoRoute({ role: next, sourceId: null, issueId: null });
  }

  function handleSelectSource(id: string | null) {
    applyDemoRoute({ role: "publisher", sourceId: id, issueId: null });
  }

  function handleCreateIssue(sourceId: string) {
    const issue = createDraftIssue(sourceId);
    setIssues((current) => [issue, ...current]);
    applyDemoRoute({ role: "publisher", sourceId, issueId: issue.id }, "push", [issue, ...issues]);
  }

  function handleUpdateIssue(nextIssue: DemoIssue) {
    setIssues((current) => current.map((issue) => (issue.id === nextIssue.id ? nextIssue : issue)));
  }

  function handleDeleteIssue(issueId: string) {
    setIssues((current) => current.filter((issue) => issue.id !== issueId));
    if (selectedIssueId === issueId) {
      applyDemoRoute({ role, sourceId: selectedSourceId, issueId: null }, "replace");
    }
  }

  function handleResetDemoStorage() {
    resetDemoStorage();
    resetIssues(demoDataset.issues.map(cloneIssue));
    applyDemoRoute({ role, sourceId: null, issueId: null }, "replace");
    setResetVersion((version) => version + 1);
  }

  const selectedSource = selectedSourceId ? (sourceById.get(selectedSourceId) ?? null) : null;
  const selectedIssue =
    selectedSource && selectedIssueId
      ? ((issuesBySourceId.get(selectedSource.id) ?? []).find(
          (issue) => issue.id === selectedIssueId,
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
                  (démo)
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <TabsList className="h-7 rounded-sm bg-canvas p-px">
                  <TabsTrigger
                    value="publisher"
                    className="h-6 rounded-sm px-2 !text-[12px] font-medium leading-none tracking-normal data-[state=active]:bg-paper data-[state=active]:text-ink data-[state=active]:shadow-none data-[state=inactive]:text-faint data-[state=inactive]:hover:bg-paper/70 data-[state=inactive]:hover:text-muted"
                  >
                    Éditeur
                  </TabsTrigger>
                  <TabsTrigger
                    value="client"
                    className="h-6 rounded-sm px-2 !text-[12px] font-medium leading-none tracking-normal data-[state=active]:bg-paper data-[state=active]:text-ink data-[state=active]:shadow-none data-[state=inactive]:text-faint data-[state=inactive]:hover:bg-paper/70 data-[state=inactive]:hover:text-muted"
                  >
                    Client
                  </TabsTrigger>
                </TabsList>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-7 text-faint/70 hover:bg-rule/45 hover:text-muted"
                      onClick={handleResetDemoStorage}
                      aria-label="Réinitialiser les données locales de la démo"
                    >
                      <RotateCcw className="size-3" aria-hidden="true" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" align="end" sideOffset={8}>
                    Efface les changements de cette démo.
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
                  applyDemoRoute,
                  handleSelectSource,
                })}
              />
            </div>
            <TabsContent value="publisher" className="mt-0">
              {selectedSource && selectedIssue ? (
                <PublisherPublicationDetail
                  issue={selectedIssue}
                  onDeleteIssue={handleDeleteIssue}
                  onUpdateIssue={handleUpdateIssue}
                />
              ) : selectedSource ? (
                <PublisherSourceDetail
                  key={`${selectedSource.id}:${resetVersion}`}
                  source={selectedSource}
                  issues={issuesBySourceId.get(selectedSource.id) ?? []}
                  onCreateIssue={handleCreateIssue}
                  onDeleteIssue={handleDeleteIssue}
                  onSelectIssue={(issueId) =>
                    applyDemoRoute({
                      role: "publisher",
                      sourceId: selectedSource.id,
                      issueId,
                    })
                  }
                />
              ) : (
                <PublisherSourcesList
                  issuesBySourceId={issuesBySourceId}
                  onSelect={handleSelectSource}
                />
              )}
            </TabsContent>
            <TabsContent value="client" className="mt-0">
              {selectedIssue ? (
                <ClientPublicationDetail issue={selectedIssue} />
              ) : (
                <ClientSourcesList
                  issues={issues}
                  onSelectIssue={(issue) =>
                    applyDemoRoute({
                      role: "client",
                      sourceId: issue.sourceId,
                      issueId: issue.id,
                    })
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
  issuesBySourceId,
  onSelect,
}: {
  issuesBySourceId: ReadonlyMap<string, readonly DemoIssue[]>;
  onSelect: (id: string) => void;
}) {
  const rows = useMemo<SourceTableRow[]>(
    () =>
      demoDataset.sources.map((source) => {
        const issues = issuesBySourceId.get(source.id) ?? [];
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
    [issuesBySourceId],
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
  source: DemoSubscriptionSource;
  issues: readonly DemoIssue[];
  onCreateIssue: (sourceId: string) => void;
  onDeleteIssue: (id: string) => void;
  onSelectIssue: (id: string) => void;
}) {
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

    const errors = validateDraftSubscriber(draftSubscriber, subscribers);
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
            title="Publications"
            count={issues.length}
            actionLabel="Créer une publication"
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
            title="Abonnés"
            count={subscribers.length}
            actionLabel="Ajouter un abonné"
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
                  clearResolvedDraftErrors(current, nextDraft, subscribers),
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
  onDeleteIssue,
  onUpdateIssue,
}: {
  issue: DemoIssue;
  onDeleteIssue?: (id: string) => void;
  onUpdateIssue?: (issue: DemoIssue) => void;
}) {
  const editable = Boolean(onUpdateIssue) && isEditableIssue(issue);

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
      documents: [...issue.documents, createDraftDocument(issue.id, issue.documents.length + 1)],
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
      issue={toPublicationDetailIssue(issue)}
      editable={editable}
      getPdfHref={getPublicPdfUrl}
      onAddDocument={handleAddDocument}
      onDeleteDocument={deleteDocument}
      onDeleteIssue={onDeleteIssue}
      onOpenStoredPdf={openStoredDemoPdf}
      onUpdateDocument={updateDocument}
      onUpdateIssue={updateIssue}
      onUploadDocumentPdf={handleUploadDocumentPdf}
    />
  );
}

function ClientSourcesList({
  issues,
  onSelectIssue,
}: {
  issues: readonly DemoIssue[];
  onSelectIssue: (issue: DemoIssue) => void;
}) {
  const publishedIssues = issues.filter((issue) => issue.status === "published");
  const [excludedIssueIds, setExcludedIssueIds] = useSessionState<readonly string[]>(
    "brief:demo:client-context-exclusions:v1",
    [],
  );
  const excludedIssueIdSet = useMemo(() => new Set(excludedIssueIds), [excludedIssueIds]);
  const publicationById = useMemo(
    () => new Map(publishedIssues.map((issue) => [issue.id, issue])),
    [publishedIssues],
  );

  function handleToggleContext(issueId: string) {
    setExcludedIssueIds((current) =>
      current.includes(issueId) ? current.filter((id) => id !== issueId) : [...current, issueId],
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-7">
      <section className="animate-in stagger-1">
        <VirtualizedChatTranscript messages={primaryChat?.messages ?? []} />

        <div className="mt-4 flex min-h-10 items-center gap-2 rounded-sm border border-dashed border-rule bg-surface px-3 py-2 text-muted">
          <span className="min-w-0 flex-1 truncate text-sm">
            Le chat démo ne peut pas envoyer de nouveau message.
          </span>
          <Button disabled>
            <Send className="size-4" aria-hidden="true" />
            Envoyer
          </Button>
        </div>
      </section>

      <section className="animate-in stagger-2">
        <SectionHeader title="Publications" count={publishedIssues.length} />
        <div className="mt-3">
          <ClientPublicationsTable
            publications={toClientPublicationRows(publishedIssues, excludedIssueIdSet)}
            onSelectPublication={(issueId) => {
              const issue = publicationById.get(issueId);
              if (issue) onSelectIssue(issue);
            }}
            onToggleContext={handleToggleContext}
          />
        </div>
      </section>
    </div>
  );
}

function ClientPublicationDetail({ issue }: { issue: DemoIssue }) {
  return <PublisherPublicationDetail issue={issue} />;
}

function buildBreadcrumbs({
  role,
  selectedIssue,
  selectedSource,
  applyDemoRoute,
  handleSelectSource,
}: {
  role: DemoRole;
  selectedIssue: DemoIssue | null;
  selectedSource: DemoSubscriptionSource | null;
  applyDemoRoute: (route: DemoRoute) => void;
  handleSelectSource: (id: string | null) => void;
}): readonly BreadcrumbItem[] {
  if (role === "client") {
    return selectedIssue
      ? [
          {
            label: "Chat",
            href: buildDemoPath({ role: "client", sourceId: null, issueId: null }),
            onClick: () => applyDemoRoute({ role: "client", sourceId: null, issueId: null }),
          },
          { label: selectedIssue.title },
        ]
      : [{ label: "Chat" }];
  }

  if (!selectedSource) return [{ label: "Fils" }];

  const sourceCrumb = selectedIssue
    ? [
        {
          label: selectedSource.name,
          href: buildDemoPath({
            role: "publisher",
            sourceId: selectedSource.id,
            issueId: null,
          }),
          onClick: () =>
            applyDemoRoute({
              role: "publisher",
              sourceId: selectedSource.id,
              issueId: null,
            }),
        },
        { label: selectedIssue.title },
      ]
    : [{ label: selectedSource.name }];

  return [
    {
      label: "Fils",
      href: buildDemoPath({ role: "publisher", sourceId: null, issueId: null }),
      onClick: () => handleSelectSource(null),
    },
    ...sourceCrumb,
  ];
}

function toPublicationTableIssues(issues: readonly DemoIssue[]): PublicationTableIssue[] {
  return issues.map((issue) => ({
    id: issue.id,
    title: issue.title,
    sourceName: sourceById.get(issue.sourceId)?.name ?? "",
    publicationDate: issue.publicationDate,
    opens: issue.metrics.opens,
    downloads: issue.metrics.downloads,
    contextPulls: issue.metrics.aiContextPulls,
    status: issue.status,
  }));
}

function toClientPublicationRows(
  issues: readonly DemoIssue[],
  excludedIssueIds: ReadonlySet<string>,
): ClientPublicationTableRow[] {
  return issues.map((issue) => ({
    id: issue.id,
    sourceName: sourceById.get(issue.sourceId)?.name ?? "",
    title: issue.title,
    publicationDate: issue.publicationDate,
    includedInContext: !excludedIssueIds.has(issue.id),
  }));
}

function toPublicationDetailIssue(issue: DemoIssue): PublicationDetailIssue {
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
  source: DemoSubscriptionSource,
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
): DraftSubscriberErrors {
  const errors: DraftSubscriberErrors = {};
  const company = draft.company.trim();
  const email = draft.email.trim();

  if (!company) {
    errors.company = "La société est requise.";
  }

  if (!email) {
    errors.email = "L'email est requis.";
  } else if (!isValidEmail(email)) {
    errors.email = "Entrez un email valide.";
  } else if (
    rows.some((row) => row.email.toLocaleLowerCase("fr-FR") === email.toLocaleLowerCase("fr-FR"))
  ) {
    errors.email = "Cet email est déjà abonné.";
  }

  return errors;
}

function clearResolvedDraftErrors(
  errors: DraftSubscriberErrors,
  draft: DraftSubscriber,
  rows: readonly SubscriberTableRow[],
): DraftSubscriberErrors {
  if (Object.keys(errors).length === 0) return errors;
  const nextErrors = validateDraftSubscriber(draft, rows);
  return Object.fromEntries(
    Object.entries(errors).filter(([field]) => nextErrors[field as keyof DraftSubscriber]),
  );
}

function isValidEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isEditableIssue(issue: DemoIssue) {
  return issue.status === "scheduled" && new Date(issue.publicationDate).getTime() > Date.now();
}

function buildIssuesBySourceId(issues: readonly DemoIssue[]) {
  const map = new Map<string, DemoIssue[]>();
  for (const issue of [...issues].sort((a, b) =>
    b.publicationDate.localeCompare(a.publicationDate),
  )) {
    const sourceIssues = map.get(issue.sourceId) ?? [];
    sourceIssues.push(issue);
    map.set(issue.sourceId, sourceIssues);
  }
  return map;
}

function cloneIssue(issue: DemoIssue): DemoIssue {
  return {
    ...issue,
    documents: issue.documents.map((document) => ({
      ...document,
      metrics: { ...document.metrics },
    })),
    metrics: { ...issue.metrics },
  };
}

function createDraftIssue(sourceId: string): DemoIssue {
  const id = `issue_demo_${Date.now()}`;
  const publicationDate = new Date(Date.now() + 86_400_000 * 7).toISOString();
  return {
    id,
    sourceId,
    title: "Nouvelle publication",
    publicationDate,
    status: "scheduled",
    summary: "Résumé éditable de la publication planifiée.",
    documents: [createDraftDocument(id, 1)],
    metrics: {
      opens: 0,
      downloads: 0,
      aiContextPulls: 0,
    },
  };
}

function createDraftDocument(issueId: string, index: number): DemoIssue["documents"][number] {
  const id = `doc_demo_${Date.now()}_${index}`;
  return {
    id,
    issueId,
    title: `Document ${index}`,
    fileName: "",
    pageCount: 1,
    language: "fr",
    indexingStatus: "indexed",
    storagePath: "",
    extractedTextPreview: "Description éditable du document.",
    metrics: {
      opens: 0,
      downloads: 0,
      aiContextPulls: 0,
    },
  };
}

function getPublicPdfUrl(document: PublicationDocument) {
  if (!document.storagePath || document.storagePath.startsWith("indexeddb://")) return null;
  const path = document.storagePath.startsWith("/")
    ? document.storagePath
    : `/${document.storagePath}`;
  return typeof window === "undefined" ? path : new URL(path, window.location.origin).href;
}

async function openStoredDemoPdf(document: PublicationDocument): Promise<OpenStoredPdfResult> {
  try {
    const blob = await loadDemoPdf(document.id);
    if (!blob) return { ok: false, message: "PDF introuvable." };
    const url = URL.createObjectURL(blob);
    const opened = window.open(url, "_blank", "noopener,noreferrer");
    if (!opened) {
      URL.revokeObjectURL(url);
      return { ok: false, message: "Impossible d'ouvrir ce PDF." };
    }
    window.setTimeout(() => URL.revokeObjectURL(url), 300_000);
    return { ok: true };
  } catch {
    return { ok: false, message: "Impossible d'ouvrir ce PDF." };
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

if (!isDemoPdfPath(window.location.pathname)) {
  createRoot(document.getElementById("root")!).render(<App />);
}
