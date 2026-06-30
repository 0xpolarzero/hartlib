import { createRoot } from "react-dom/client";
import {
  CalendarClock,
  Check,
  ChevronsUpDown,
  ExternalLink,
  Eye,
  EyeOff,
  Info,
  Pause,
  Play,
  Plus,
  Send,
  Trash2,
  Upload,
  RotateCcw,
} from "lucide-react";
import { Fragment, type ChangeEvent, useEffect, useMemo, useRef, useState } from "react";

import {
  demoDataset,
  type DemoIssue,
  type DemoRole,
  type DemoSubscriptionSource,
} from "@brief/demo-data";
import {
  Button,
  DataTable,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  VirtualizedChatTranscript,
  cn,
} from "@brief/ui";

import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type SortingState,
} from "@tanstack/react-table";

import "./styles.css";

// --- Data helpers ---

const sourceById = new Map(demoDataset.sources.map((s) => [s.id, s]));
const primaryChat = demoDataset.chats[0];
const editableFieldChromeClass =
  "rounded-sm border border-rule/70 bg-paper/35 outline-none transition-colors duration-fast hover:border-rule hover:bg-paper/70 focus:border-ring focus:bg-paper focus:ring-2 focus:ring-ring/20";
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
// --- App ---

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

  const selectedSource = selectedSourceId ? (sourceById.get(selectedSourceId) ?? null) : null;
  const selectedIssue =
    selectedSource && selectedIssueId
      ? ((issuesBySourceId.get(selectedSource.id) ?? []).find(
          (issue) => issue.id === selectedIssueId,
        ) ?? null)
      : null;

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

  return (
    <TooltipProvider>
      <Tabs value={role} onValueChange={(v) => handleRoleChange(v as DemoRole)}>
        <main className="min-h-screen bg-canvas text-ink">
          <header className="border-b border-rule bg-paper/80 backdrop-blur">
            <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3 sm:px-6 lg:px-8">
              <div className="flex items-baseline gap-1.5">
                <h1 className="font-display text-xl font-medium text-ink">
                  brief<span className="text-accent">.</span>
                </h1>
                <span className="font-mono text-[11px] font-medium text-faint">(demo)</span>
              </div>
              <div className="flex items-center gap-1.5">
                <TabsList className="h-6 rounded-sm bg-canvas p-px">
                  <TabsTrigger
                    value="publisher"
                    className="h-5 rounded-sm px-2 !text-[12px] font-medium leading-none tracking-normal data-[state=active]:bg-paper data-[state=active]:text-ink data-[state=active]:shadow-none data-[state=inactive]:text-faint data-[state=inactive]:hover:bg-paper/70 data-[state=inactive]:hover:text-muted"
                  >
                    Publisher
                  </TabsTrigger>
                  <TabsTrigger
                    value="client"
                    className="h-5 rounded-sm px-2 !text-[12px] font-medium leading-none tracking-normal data-[state=active]:bg-paper data-[state=active]:text-ink data-[state=active]:shadow-none data-[state=inactive]:text-faint data-[state=inactive]:hover:bg-paper/70 data-[state=inactive]:hover:text-muted"
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
                      className="size-5 text-faint/70 hover:bg-rule/45 hover:text-muted"
                      onClick={handleResetDemoStorage}
                      aria-label="Réinitialiser les données locales de la démo"
                    >
                      <RotateCcw className="size-3" aria-hidden="true" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" align="end" sideOffset={8}>
                    Efface les changements de cette demo.
                  </TooltipContent>
                </Tooltip>
              </div>
            </div>
          </header>

          <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
            <div className="mb-6">
              <Crumbs
                items={
                  role === "client"
                    ? selectedIssue
                      ? [
                          {
                            label: "Chat",
                            href: buildDemoPath({
                              role: "client",
                              sourceId: null,
                              issueId: null,
                            }),
                            onClick: () =>
                              applyDemoRoute({
                                role: "client",
                                sourceId: null,
                                issueId: null,
                              }),
                          },
                          { label: selectedIssue.title },
                        ]
                      : [{ label: "Chat" }]
                    : selectedSource
                      ? [
                          {
                            label: "Fils",
                            href: buildDemoPath({
                              role: "publisher",
                              sourceId: null,
                              issueId: null,
                            }),
                            onClick: () => handleSelectSource(null),
                          },
                          ...(selectedIssue
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
                            : [{ label: selectedSource.name }]),
                        ]
                      : [{ label: "Fils" }]
                }
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

// --- Crumbs ---

type Crumb = { label: string; href?: string; onClick?: () => void };

function Crumbs({ items }: { items: readonly Crumb[] }) {
  return (
    <nav className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-wider">
      {items.map((item, index) => (
        <Fragment key={index}>
          {index > 0 ? <span className="text-faint">/</span> : null}
          {item.href && item.onClick ? (
            <a
              href={item.href}
              onClick={(event) => {
                event.preventDefault();
                item.onClick?.();
              }}
              className="font-mono uppercase tracking-wider text-muted transition-colors duration-fast hover:text-ink"
            >
              {item.label}
            </a>
          ) : (
            <span
              aria-current={index === items.length - 1 ? "page" : undefined}
              className="text-ink"
            >
              {item.label}
            </span>
          )}
        </Fragment>
      ))}
    </nav>
  );
}

// --- Publisher View ---

function PublisherSourcesList({
  issuesBySourceId,
  onSelect,
}: {
  issuesBySourceId: ReadonlyMap<string, readonly DemoIssue[]>;
  onSelect: (id: string) => void;
}) {
  return (
    <section className="animate-in stagger-1">
      <SourcesTable issuesBySourceId={issuesBySourceId} onSelect={onSelect} />
    </section>
  );
}

type FilRow = {
  id: string;
  name: string;
  issueCount: number;
  lastPublishedAt: string | null;
  subscriberCount: number;
};

const filColumnHelper = createColumnHelper<FilRow>();

function SourcesTable({
  issuesBySourceId,
  onSelect,
}: {
  issuesBySourceId: ReadonlyMap<string, readonly DemoIssue[]>;
  onSelect: (id: string) => void;
}) {
  const [sorting, setSorting] = useState<SortingState>([{ id: "lastPublishedAt", desc: true }]);

  const rows = useMemo<FilRow[]>(
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

  const columns = useMemo(
    () => [
      filColumnHelper.accessor("name", { header: "Fil" }),
      filColumnHelper.accessor("subscriberCount", { header: "Abonnés" }),
      filColumnHelper.accessor("issueCount", { header: "Publications" }),
      filColumnHelper.accessor((row) => row.lastPublishedAt ?? "", {
        id: "lastPublishedAt",
        header: "Dernière publication",
        sortingFn: (a, b) => {
          const av = a.original.lastPublishedAt;
          const bv = b.original.lastPublishedAt;
          if (!av && !bv) return 0;
          if (!av) return 1;
          if (!bv) return -1;
          return av < bv ? -1 : av > bv ? 1 : 0;
        },
      }),
    ],
    [],
  );

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  return (
    <DataTable<FilRow>
      table={table}
      renderContent={renderTableContent}
      onRowClick={(row) => onSelect(row.original.id)}
      renderCell={(cell, row) => (
        <TableCell key={cell.id} className="tabular-nums text-ink">
          {cell.column.id === "lastPublishedAt" ? (
            row.original.lastPublishedAt ? (
              formatDate(row.original.lastPublishedAt)
            ) : (
              "—"
            )
          ) : cell.column.id === "name" ? (
            <span className="font-medium text-ink">
              {renderTableContent(cell.column.columnDef.cell, cell.getContext())}
            </span>
          ) : (
            renderTableContent(cell.column.columnDef.cell, cell.getContext())
          )}
        </TableCell>
      )}
    />
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

  function handleAddSubscriber() {
    setDraftSubscriber((current) => current ?? { company: "", email: "" });
  }

  function handleCreateSubscriber(draft: DraftSubscriber) {
    const subscriber: CreatedSubscriberRow = {
      id: `subscriber_demo_${Date.now()}`,
      company: draft.company.trim(),
      email: draft.email.trim(),
      subscribedSince: new Date().toISOString(),
      status: "active",
    };

    setSubscriberState((current) => ({
      ...current,
      created: [...(current.created ?? []), subscriber],
    }));
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
            <IssueTable
              issues={issues}
              compact
              onDeleteIssue={onDeleteIssue}
              onSelectIssue={onSelectIssue}
            />
          </div>
        </section>

        <section>
          <SectionHeader
            title="Abonnés"
            count={subscribers.length}
            actionLabel="Ajouter un abonné"
            onAdd={handleAddSubscriber}
          />
          <div className="mt-4">
            <SubscriberTable
              rows={subscribers}
              draft={draftSubscriber}
              companyOptions={subscriberCompanies}
              onCancelDraft={() => setDraftSubscriber(null)}
              onCreateDraft={handleCreateSubscriber}
              onUpdateDraft={setDraftSubscriber}
              onToggleStatus={handleToggleSubscriberStatus}
              onDelete={handleDeleteSubscriber}
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
  const source = sourceById.get(issue.sourceId);
  const editable = Boolean(onUpdateIssue) && isEditableIssue(issue);

  function updateIssue(patch: Partial<DemoIssue>) {
    onUpdateIssue?.({ ...issue, ...patch });
  }

  function updateDocument(documentId: string, patch: Partial<DemoIssue["documents"][number]>) {
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
    <div className="space-y-8">
      <section>
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            {editable ? (
              <input
                value={issue.title}
                onChange={(event) => updateIssue({ title: event.target.value })}
                className={cn(
                  editableFieldChromeClass,
                  "w-full px-1 py-0.5 font-display text-2xl font-medium text-ink focus:text-accent",
                )}
                aria-label="Titre de la publication"
              />
            ) : (
              <h2 className="font-display text-2xl font-medium text-ink">{issue.title}</h2>
            )}
          </div>
          {editable && onDeleteIssue ? (
            <ConfirmingDeleteButton
              confirmLabel="Confirmer"
              idleLabel="Supprimer la publication programmée"
              onConfirm={() => onDeleteIssue(issue.id)}
            />
          ) : null}
        </div>
        <div className="mt-2 font-mono text-[11px] uppercase tracking-wider text-faint">
          {source?.name} /{" "}
          <span className="inline-flex items-center gap-2 align-middle">
            {editable ? (
              <input
                type="datetime-local"
                value={toDatetimeLocalValue(issue.publicationDate)}
                onChange={(event) => {
                  if (!event.target.value) return;
                  updateIssue({ publicationDate: new Date(event.target.value).toISOString() });
                }}
                className={cn(
                  editableFieldChromeClass,
                  "publication-date-input px-1 py-0.5 font-mono text-[11px] uppercase tracking-wider text-faint focus:text-accent",
                )}
                aria-label="Date de publication"
              />
            ) : (
              <span>{formatDate(issue.publicationDate)}</span>
            )}
            {issue.status === "scheduled" ? (
              <>
                <ScheduledPublicationIcon />
                <span className="font-sans text-xs normal-case tracking-normal text-muted">
                  {formatRelativeSchedule(issue.publicationDate)}
                </span>
              </>
            ) : null}
          </span>
        </div>
        {editable ? (
          <textarea
            value={issue.summary}
            onChange={(event) => updateIssue({ summary: event.target.value })}
            className={cn(
              editableFieldChromeClass,
              "mt-4 min-h-20 w-full max-w-3xl resize-y px-2 py-1 font-serif text-sm leading-6 text-muted focus:min-h-28 focus:text-ink",
            )}
            aria-label="Résumé de la publication"
          />
        ) : (
          <p className="mt-4 max-w-3xl font-serif text-sm leading-6 text-muted">{issue.summary}</p>
        )}
      </section>

      <section>
        <SectionHeader
          title="Documents"
          count={issue.documents.length}
          actionLabel="Ajouter un document"
          onAdd={editable ? handleAddDocument : undefined}
        />
        <div className="mt-4">
          <DocumentsTable
            documents={issue.documents}
            editable={editable}
            onDeleteDocument={deleteDocument}
            onUpdateDocument={updateDocument}
            onUploadDocumentPdf={handleUploadDocumentPdf}
          />
        </div>
      </section>
    </div>
  );
}

// --- Client Views ---

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

  function handleToggleContext(issueId: string) {
    setExcludedIssueIds((current) =>
      current.includes(issueId) ? current.filter((id) => id !== issueId) : [...current, issueId],
    );
  }

  return (
    <div className="space-y-7">
      <section className="animate-in stagger-1 max-w-4xl">
        <VirtualizedChatTranscript messages={primaryChat?.messages ?? []} />

        <div className="mt-4 flex items-center gap-2 rounded-sm border border-dashed border-rule bg-surface px-3 py-2 text-muted">
          <span className="min-w-0 flex-1 truncate text-sm">
            Le chat demo ne peut pas envoyer de nouveau message.
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
            issues={publishedIssues}
            excludedIssueIds={excludedIssueIdSet}
            onSelectIssue={onSelectIssue}
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

function ClientPublicationsTable({
  issues,
  excludedIssueIds,
  onSelectIssue,
  onToggleContext,
}: {
  issues: readonly DemoIssue[];
  excludedIssueIds: ReadonlySet<string>;
  onSelectIssue: (issue: DemoIssue) => void;
  onToggleContext: (issueId: string) => void;
}) {
  const [sorting, setSorting] = useState<SortingState>([{ id: "publicationDate", desc: true }]);
  const rows = useMemo<ClientPublicationRow[]>(
    () =>
      issues.map((issue) => ({
        id: issue.id,
        issue,
        sourceName: sourceById.get(issue.sourceId)?.name ?? "",
        title: issue.title,
        publicationDate: issue.publicationDate,
        includedInContext: !excludedIssueIds.has(issue.id),
        contextRank: excludedIssueIds.has(issue.id) ? 1 : 0,
      })),
    [excludedIssueIds, issues],
  );

  const columns = useMemo(
    () => [
      clientPublicationColumnHelper.accessor("contextRank", {
        header: "",
        cell: () => null,
      }),
      clientPublicationColumnHelper.accessor("sourceName", { header: "Fil" }),
      clientPublicationColumnHelper.accessor("title", { header: "Publication" }),
      clientPublicationColumnHelper.accessor("publicationDate", { header: "Date" }),
      clientPublicationColumnHelper.display({
        id: "actions",
        header: "",
        enableSorting: false,
      }),
    ],
    [],
  );

  const effectiveSorting = useMemo<SortingState>(() => {
    const visibleSort = sorting.filter((s) => s.id !== "contextRank");
    return [{ id: "contextRank", desc: false }, ...visibleSort];
  }, [sorting]);

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting: effectiveSorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  return (
    <DataTable<ClientPublicationRow>
      table={table}
      renderContent={renderTableContent}
      hiddenColumnIds={["contextRank"]}
      getHeaderAlign={(header) => (header.column.id === "actions" ? "right" : "left")}
      getRowClassName={(row) => (!row.original.includedInContext ? "opacity-60" : undefined)}
      onRowClick={(row) => onSelectIssue(row.original.issue)}
      renderCell={(cell, row) => {
        if (cell.column.id === "sourceName") {
          return (
            <TableCell key={cell.id} className="max-w-[12rem] text-muted">
              <div className="truncate">{row.original.sourceName}</div>
            </TableCell>
          );
        }
        if (cell.column.id === "title") {
          return (
            <TableCell key={cell.id}>
              <div className="max-w-[28rem] truncate font-medium text-ink">
                {row.original.title}
              </div>
            </TableCell>
          );
        }
        if (cell.column.id === "publicationDate") {
          return (
            <TableCell key={cell.id} className="whitespace-nowrap font-mono text-[11px] text-faint">
              {formatDate(row.original.publicationDate)}
            </TableCell>
          );
        }
        if (cell.column.id === "actions") {
          const isShown = row.original.includedInContext;

          return (
            <TableCell key={cell.id} className="text-right">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={(event) => {
                      event.stopPropagation();
                      onToggleContext(row.original.id);
                    }}
                    aria-label={
                      isShown
                        ? `Masquer ${row.original.title} pour l'assistant`
                        : `Afficher ${row.original.title} pour l'assistant`
                    }
                    className="!size-5 text-faint/70 hover:bg-rule/45 hover:text-muted focus-visible:text-muted"
                  >
                    {isShown ? (
                      <Eye className="size-3.5" aria-hidden="true" />
                    ) : (
                      <EyeOff className="size-3.5" aria-hidden="true" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" align="end">
                  {isShown
                    ? "Visible par l'assistant."
                    : "Masquée: l'assistant ne connaît pas cette publication."}
                </TooltipContent>
              </Tooltip>
            </TableCell>
          );
        }
        return (
          <TableCell key={cell.id}>
            {renderTableContent(cell.column.columnDef.cell, cell.getContext())}
          </TableCell>
        );
      }}
    />
  );
}

// --- Sub-components ---

function SectionTitle({ title }: { title: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="size-1.5 rounded-full bg-accent/70" aria-hidden="true" />
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
    </div>
  );
}

function SectionHeader({
  title,
  count,
  actionLabel,
  onAdd,
}: {
  title: string;
  count: number;
  actionLabel?: string;
  onAdd?: (() => void) | undefined;
}) {
  return (
    <h3 className="flex items-center gap-3 text-xs font-normal uppercase tracking-[0.16em] text-faint">
      <span>{title}</span>
      <span className="font-mono tracking-normal text-faint/60">{count}</span>
      {onAdd ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="ml-auto size-7 text-faint hover:text-accent"
          onClick={onAdd}
          aria-label={actionLabel ?? `Ajouter ${title.toLowerCase()}`}
        >
          <Plus className="size-4" aria-hidden="true" />
        </Button>
      ) : null}
    </h3>
  );
}

type PublicationRow = {
  id: string;
  issue: DemoIssue;
  title: string;
  sourceName: string;
  publicationDate: string;
  opens: number;
  downloads: number;
  contextPulls: number;
  status: DemoIssue["status"];
};

type ClientPublicationRow = {
  id: string;
  issue: DemoIssue;
  sourceName: string;
  title: string;
  publicationDate: string;
  includedInContext: boolean;
  contextRank: number;
};

type DocumentRow = DemoIssue["documents"][number];

type SubscriberStatus = "active" | "paused";

type SubscriberSessionState = {
  statuses: Record<string, SubscriberStatus>;
  deletedIds: readonly string[];
  created?: readonly CreatedSubscriberRow[];
};

type SubscriberRow = {
  id: string;
  company: string;
  email: string;
  subscribedSince: string;
  status: SubscriberStatus;
  statusRank: number;
};

type CreatedSubscriberRow = {
  id: string;
  company: string;
  email: string;
  subscribedSince: string;
  status: SubscriberStatus;
};

type DraftSubscriber = {
  company: string;
  email: string;
};

type DraftSubscriberErrors = Partial<Record<keyof DraftSubscriber, string>>;

const publicationColumnHelper = createColumnHelper<PublicationRow>();
const clientPublicationColumnHelper = createColumnHelper<ClientPublicationRow>();
const subscriberColumnHelper = createColumnHelper<SubscriberRow>();

function renderTableContent(renderer: unknown, context: unknown) {
  return flexRender(
    renderer as Parameters<typeof flexRender>[0],
    context as Parameters<typeof flexRender>[1],
  );
}

function IssueTable({
  issues,
  compact,
  onDeleteIssue,
  onSelectIssue,
}: {
  issues: readonly DemoIssue[];
  compact?: boolean;
  onDeleteIssue?: (id: string) => void;
  onSelectIssue?: (id: string) => void;
}) {
  const [sorting, setSorting] = useState<SortingState>([{ id: "publicationDate", desc: true }]);

  const rows = useMemo<PublicationRow[]>(
    () =>
      issues.map((issue) => ({
        id: issue.id,
        issue,
        title: issue.title,
        sourceName: sourceById.get(issue.sourceId)?.name ?? "",
        publicationDate: issue.publicationDate,
        opens: issue.metrics.opens,
        downloads: issue.metrics.downloads,
        contextPulls: issue.metrics.aiContextPulls,
        status: issue.status,
      })),
    [issues],
  );

  const columns = useMemo(
    () => [
      publicationColumnHelper.accessor("title", { header: "Publication" }),
      ...(compact
        ? []
        : [
            publicationColumnHelper.accessor("sourceName", {
              header: "Fil",
            }),
          ]),
      publicationColumnHelper.accessor("opens", { header: "Ouvertures" }),
      publicationColumnHelper.accessor("downloads", { header: "Téléchargements" }),
      publicationColumnHelper.accessor("contextPulls", {
        header: () => (
          <span className="inline-flex items-center gap-1">
            Contexte
            <Tooltip>
              <TooltipTrigger asChild>
                <Info className="size-3 text-faint" aria-hidden="true" />
              </TooltipTrigger>
              <TooltipContent side="top" align="center">
                Nombre de fois où l'archive a été lue par l'IA pour répondre.
              </TooltipContent>
            </Tooltip>
          </span>
        ),
      }),
      publicationColumnHelper.accessor("publicationDate", {
        header: "Date",
      }),
      ...(onDeleteIssue
        ? [
            publicationColumnHelper.display({
              id: "actions",
              header: "",
              enableSorting: false,
              cell: () => null,
            }),
          ]
        : []),
    ],
    [compact, onDeleteIssue],
  );

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  return (
    <DataTable<PublicationRow>
      table={table}
      renderContent={renderTableContent}
      getHeaderAlign={(header) => (header.column.id === "actions" ? "right" : "left")}
      {...(onSelectIssue ? { onRowClick: (row) => onSelectIssue(row.original.id) } : {})}
      renderCell={(cell, row) => {
        if (cell.column.id === "title") {
          return (
            <TableCell key={cell.id}>
              <div className="max-w-[24rem] truncate font-medium text-ink">
                {row.original.title}
              </div>
            </TableCell>
          );
        }
        if (cell.column.id === "actions") {
          return (
            <TableCell key={cell.id} className="text-right">
              {row.original.status === "scheduled" && onDeleteIssue ? (
                <ConfirmingDeleteButton
                  confirmLabel="Confirmer"
                  idleLabel="Supprimer la publication programmée"
                  onConfirm={() => onDeleteIssue(row.original.id)}
                />
              ) : null}
            </TableCell>
          );
        }
        if (cell.column.id === "publicationDate") {
          return (
            <TableCell key={cell.id} className="whitespace-nowrap font-mono text-[11px] text-faint">
              <span className="inline-flex items-center gap-2">
                <span>{formatDate(row.original.publicationDate)}</span>
                {row.original.status === "scheduled" ? <ScheduledPublicationIcon /> : null}
              </span>
            </TableCell>
          );
        }
        if (
          row.original.status === "scheduled" &&
          (cell.column.id === "opens" ||
            cell.column.id === "downloads" ||
            cell.column.id === "contextPulls")
        ) {
          return (
            <TableCell key={cell.id} className="whitespace-nowrap font-mono text-[11px] text-faint">
              -
            </TableCell>
          );
        }
        if (cell.column.id === "contextPulls") {
          return (
            <TableCell
              key={cell.id}
              className="whitespace-nowrap tabular-nums font-medium text-accent"
            >
              {renderTableContent(cell.column.columnDef.cell, cell.getContext())}
            </TableCell>
          );
        }
        return (
          <TableCell key={cell.id} className="whitespace-nowrap tabular-nums text-ink">
            {renderTableContent(cell.column.columnDef.cell, cell.getContext())}
          </TableCell>
        );
      }}
    />
  );
}

function DocumentsTable({
  documents,
  editable,
  onDeleteDocument,
  onUpdateDocument,
  onUploadDocumentPdf,
}: {
  documents: readonly DocumentRow[];
  editable: boolean;
  onDeleteDocument: (documentId: string) => void;
  onUpdateDocument: (documentId: string, patch: Partial<DocumentRow>) => void;
  onUploadDocumentPdf: (documentId: string, file: File) => void;
}) {
  if (documents.length === 0) {
    return (
      <div className="rounded-sm border border-rule bg-paper px-4 py-8 text-center text-sm text-muted">
        Aucun document.
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Titre</TableHead>
          <TableHead>Description</TableHead>
          <TableHead>PDF</TableHead>
          {editable ? <TableHead className="text-right" /> : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {documents.map((doc) => (
          <TableRow key={doc.id}>
            <TableCell className="align-top">
              {editable ? (
                <InlineInput
                  value={doc.title}
                  ariaLabel="Titre du document"
                  onChange={(title) => onUpdateDocument(doc.id, { title })}
                />
              ) : (
                <span className="font-medium text-ink">{doc.title}</span>
              )}
            </TableCell>
            <TableCell className="max-w-md align-top">
              {editable ? (
                <InlineInput
                  value={doc.extractedTextPreview}
                  ariaLabel="Description du document"
                  multiline
                  onChange={(extractedTextPreview) =>
                    onUpdateDocument(doc.id, { extractedTextPreview })
                  }
                />
              ) : (
                <span className="font-serif text-sm leading-6 text-muted">
                  {doc.extractedTextPreview}
                </span>
              )}
            </TableCell>
            <TableCell className="max-w-44 align-top font-mono text-[11px] text-faint">
              {editable && !doc.fileName ? (
                <PdfUploadControl
                  documentId={doc.id}
                  onUpload={(file) => onUploadDocumentPdf(doc.id, file)}
                />
              ) : (
                <PdfName document={doc} />
              )}
            </TableCell>
            {editable ? (
              <TableCell className="pt-2.5 align-top text-right">
                <ConfirmingDeleteButton
                  confirmLabel="Confirmer"
                  idleLabel="Supprimer le document"
                  onConfirm={() => onDeleteDocument(doc.id)}
                />
              </TableCell>
            ) : null}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function PdfName({ document }: { document: DocumentRow }) {
  const [error, setError] = useState<string | null>(null);
  const label = document.fileName ? `${document.fileName} / ${document.pageCount} pages` : "-";
  const publicUrl = getPublicPdfUrl(document);

  if (!document.fileName) {
    return <span className="block max-w-44 truncate">-</span>;
  }

  async function handleUploadedPdfOpen() {
    setError(null);
    try {
      const blob = await loadDemoPdf(document.id);
      if (!blob) {
        setError("PDF introuvable.");
        return;
      }
      const url = URL.createObjectURL(blob);
      const opened = window.open(url, "_blank", "noopener,noreferrer");
      if (!opened) {
        URL.revokeObjectURL(url);
        setError("Impossible d'ouvrir ce PDF.");
        return;
      }
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      setError("Impossible d'ouvrir ce PDF.");
    }
  }

  const content = publicUrl ? (
    <a
      href={publicUrl}
      target="_blank"
      rel="noreferrer"
      className="inline-flex max-w-44 items-center gap-1.5 text-faint outline-none transition-colors duration-fast hover:text-ink focus-visible:text-ink"
    >
      <span className="min-w-0 truncate">{label}</span>
      <ExternalLink className="size-3 shrink-0 opacity-65" aria-hidden="true" />
    </a>
  ) : (
    <button
      type="button"
      className="inline-flex max-w-44 items-center gap-1.5 text-left text-faint outline-none transition-colors duration-fast hover:text-ink focus-visible:text-ink"
      onClick={() => void handleUploadedPdfOpen()}
    >
      <span className="min-w-0 truncate">{label}</span>
      <ExternalLink className="size-3 shrink-0 opacity-65" aria-hidden="true" />
    </button>
  );

  return (
    <div className="space-y-1">
      <Tooltip>
        <TooltipTrigger asChild>{content}</TooltipTrigger>
        <TooltipContent side="top" align="start">
          {label}
        </TooltipContent>
      </Tooltip>
      {error ? <div className="max-w-44 font-sans text-[11px] text-accent">{error}</div> : null}
    </div>
  );
}

function getPublicPdfUrl(document: DocumentRow) {
  if (!document.storagePath || document.storagePath.startsWith("indexeddb://")) return null;
  return document.storagePath.startsWith("/") ? document.storagePath : `/${document.storagePath}`;
}

function PdfUploadControl({
  documentId,
  onUpload,
}: {
  documentId: string;
  onUpload: (file: File) => void;
}) {
  const inputId = `pdf-upload-${documentId}`;

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) return;
    onUpload(file);
  }

  return (
    <div className="leading-none">
      <input
        id={inputId}
        type="file"
        accept="application/pdf,.pdf"
        className="sr-only"
        onChange={handleChange}
      />
      <label
        htmlFor={inputId}
        className={cn(
          "inline-flex h-7 cursor-pointer items-center justify-center gap-1.5 rounded-sm px-2 text-[11px] font-medium transition-colors duration-fast",
          "border border-rule/70 bg-paper/35 text-muted hover:border-rule hover:bg-rule/45 hover:text-ink",
          "focus-within:ring-2 focus-within:ring-ring/20",
        )}
      >
        <Upload className="size-3.5" aria-hidden="true" />
        Importer
      </label>
    </div>
  );
}

function InlineInput({
  value,
  ariaLabel,
  multiline,
  onChange,
}: {
  value: string;
  ariaLabel: string;
  multiline?: boolean;
  onChange: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) {
      setDraft(value);
    }
  }, [focused, value]);

  useEffect(() => {
    if (draft === value) return;
    const timeout = window.setTimeout(() => onChange(draft), 150);
    return () => window.clearTimeout(timeout);
  }, [draft, onChange, value]);

  function commit() {
    if (draft !== value) onChange(draft);
  }

  if (multiline) {
    return (
      <textarea
        value={draft}
        rows={focused ? 4 : 1}
        onBlur={() => {
          setFocused(false);
          commit();
        }}
        onChange={(event) => setDraft(event.target.value)}
        onFocus={() => setFocused(true)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setDraft(value);
            event.currentTarget.blur();
          }
        }}
        className={cn(
          editableFieldChromeClass,
          "w-full resize-none px-2 py-1 text-sm leading-5 text-ink",
          focused ? "min-h-24" : "min-h-7 truncate",
        )}
        aria-label={ariaLabel}
      />
    );
  }

  return (
    <input
      value={draft}
      onBlur={() => {
        setFocused(false);
        commit();
      }}
      onChange={(event) => setDraft(event.target.value)}
      onFocus={() => setFocused(true)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.currentTarget.blur();
        }
        if (event.key === "Escape") {
          setDraft(value);
          event.currentTarget.blur();
        }
      }}
      className={cn(editableFieldChromeClass, "w-full px-1 py-0.5 text-sm text-ink")}
      aria-label={ariaLabel}
    />
  );
}

function ScheduledPublicationIcon({ className }: { className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className={cn(
            "inline-flex size-4 items-center justify-center rounded-sm border border-accent/30 bg-accent/10 align-middle text-accent outline-none",
            className,
          )}
          aria-label="Publication programmée"
        >
          <CalendarClock className="size-3" aria-hidden="true" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" align="center">
        Publication programmée
      </TooltipContent>
    </Tooltip>
  );
}

function ConfirmingDeleteButton({
  confirmLabel,
  idleLabel,
  onConfirm,
}: {
  confirmLabel: string;
  idleLabel: string;
  onConfirm: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!confirming) return;

    function handlePointerDown(event: PointerEvent) {
      if (rootRef.current?.contains(event.target as Node)) return;
      setConfirming(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setConfirming(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [confirming]);

  return (
    <div ref={rootRef} className="flex justify-end leading-none">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={cn(
          "!size-5",
          confirming
            ? "text-destructive hover:bg-rule/45 hover:text-destructive"
            : "text-faint/70 hover:bg-rule/45 hover:text-destructive focus-visible:text-destructive",
        )}
        onClick={(event) => {
          event.stopPropagation();
          if (confirming) {
            onConfirm();
            setConfirming(false);
            return;
          }
          setConfirming(true);
        }}
        aria-label={confirming ? confirmLabel : idleLabel}
      >
        {confirming ? (
          <Check className="size-3.5" aria-hidden="true" />
        ) : (
          <Trash2 className="size-3.5" aria-hidden="true" />
        )}
      </Button>
    </div>
  );
}

function SubscriberTable({
  rows,
  draft,
  companyOptions,
  onCancelDraft,
  onCreateDraft,
  onUpdateDraft,
  onToggleStatus,
  onDelete,
}: {
  rows: SubscriberRow[];
  draft: DraftSubscriber | null;
  companyOptions: readonly string[];
  onCancelDraft: () => void;
  onCreateDraft: (draft: DraftSubscriber) => void;
  onUpdateDraft: (draft: DraftSubscriber) => void;
  onToggleStatus: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [sorting, setSorting] = useState<SortingState>([{ id: "company", desc: false }]);
  const [draftErrors, setDraftErrors] = useState<DraftSubscriberErrors>({});

  const columns = useMemo(
    () => [
      subscriberColumnHelper.accessor("statusRank", {
        header: "",
        cell: () => null,
      }),
      subscriberColumnHelper.accessor("company", { header: "Société" }),
      subscriberColumnHelper.accessor("email", { header: "Email" }),
      subscriberColumnHelper.accessor("subscribedSince", {
        header: "Depuis",
        cell: (info) => formatDate(info.getValue()),
      }),
      subscriberColumnHelper.display({
        id: "actions",
        header: "",
        enableSorting: false,
        cell: (info) => {
          const row = info.row.original;
          const isPaused = row.status === "paused";
          return (
            <div className="flex items-center justify-end gap-1">
              <Button
                variant="ghost"
                size="icon"
                className="!size-5 text-faint/70 hover:bg-rule/45 hover:text-muted focus-visible:text-muted"
                onClick={(event) => {
                  event.stopPropagation();
                  onToggleStatus(row.id);
                }}
                aria-label={isPaused ? "Reprendre l'abonnement" : "Mettre en pause l'abonnement"}
              >
                {isPaused ? (
                  <Play className="size-3.5" aria-hidden="true" />
                ) : (
                  <Pause className="size-3.5" aria-hidden="true" />
                )}
              </Button>
              <ConfirmingDeleteButton
                confirmLabel="Confirmer"
                idleLabel="Supprimer l'abonné"
                onConfirm={() => onDelete(row.id)}
              />
            </div>
          );
        },
      }),
    ],
    [onDelete, onToggleStatus],
  );

  // Pin active subscribers above paused ones; within each group, honor the
  // visible column sort the user picked.
  const effectiveSorting = useMemo<SortingState>(() => {
    const visibleSort = sorting.filter((s) => s.id !== "statusRank");
    return [{ id: "statusRank", desc: false }, ...visibleSort];
  }, [sorting]);

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting: effectiveSorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getRowId: (row) => row.id,
  });

  function handleConfirmDraft() {
    if (!draft) return;

    const errors = validateDraftSubscriber(draft, rows);
    setDraftErrors(errors);
    if (Object.keys(errors).length > 0) return;

    onCreateDraft({
      company: draft.company.trim(),
      email: draft.email.trim(),
    });
    setDraftErrors({});
  }

  function handleCancelDraft() {
    setDraftErrors({});
    onCancelDraft();
  }

  if (rows.length === 0 && !draft) {
    return (
      <div className="rounded-sm border border-rule bg-paper px-4 py-8 text-center text-sm text-muted">
        Aucun abonné.
      </div>
    );
  }

  return (
    <DataTable<SubscriberRow>
      table={table}
      renderContent={renderTableContent}
      hiddenColumnIds={["statusRank"]}
      getHeaderAlign={(header) => (header.column.id === "actions" ? "right" : "left")}
      getRowClassName={(row) => (row.original.status === "paused" ? "opacity-60" : undefined)}
      renderBeforeRows={() =>
        draft ? (
          <DraftSubscriberTableRow
            draft={draft}
            errors={draftErrors}
            companyOptions={companyOptions}
            onCancel={handleCancelDraft}
            onConfirm={handleConfirmDraft}
            onUpdate={(nextDraft) => {
              setDraftErrors((current) => clearResolvedDraftErrors(current, nextDraft, rows));
              onUpdateDraft(nextDraft);
            }}
          />
        ) : null
      }
      renderCell={(cell, row) => {
        if (cell.column.id === "company") {
          return (
            <TableCell key={cell.id}>
              <div className="max-w-[12rem] truncate font-medium text-ink">
                {row.original.company}
              </div>
            </TableCell>
          );
        }
        if (cell.column.id === "email") {
          return (
            <TableCell key={cell.id} className="font-mono text-[11px] text-muted">
              <div className="max-w-[14rem] truncate">{row.original.email}</div>
            </TableCell>
          );
        }
        if (cell.column.id === "subscribedSince") {
          return (
            <TableCell key={cell.id} className="whitespace-nowrap font-mono text-[11px] text-faint">
              {formatDate(row.original.subscribedSince)}
            </TableCell>
          );
        }
        return (
          <TableCell key={cell.id} className="text-right">
            {renderTableContent(cell.column.columnDef.cell, cell.getContext())}
          </TableCell>
        );
      }}
    />
  );
}

function DraftSubscriberTableRow({
  draft,
  errors,
  companyOptions,
  onCancel,
  onConfirm,
  onUpdate,
}: {
  draft: DraftSubscriber;
  errors: DraftSubscriberErrors;
  companyOptions: readonly string[];
  onCancel: () => void;
  onConfirm: () => void;
  onUpdate: (draft: DraftSubscriber) => void;
}) {
  return (
    <TableRow className="bg-paper/45">
      <TableCell className="align-top">
        <DraftCompanyCombobox
          value={draft.company}
          options={companyOptions}
          error={errors.company}
          autoFocus
          onChange={(company) => onUpdate({ ...draft, company })}
          onConfirm={onConfirm}
        />
      </TableCell>
      <TableCell className="align-top">
        <DraftEmailInput
          value={draft.email}
          error={errors.email}
          onChange={(email) => onUpdate({ ...draft, email })}
          onConfirm={onConfirm}
        />
      </TableCell>
      <TableCell className="whitespace-nowrap align-top font-mono text-[11px] text-faint">
        -
      </TableCell>
      <TableCell className="pt-2.5 align-top text-right">
        <div className="flex items-center justify-end gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="!size-5 text-faint/70 hover:bg-rule/45 hover:text-accent focus-visible:text-accent"
            onClick={(event) => {
              event.stopPropagation();
              onConfirm();
            }}
            aria-label="Créer l'abonné"
          >
            <Check className="size-3.5" aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="!size-5 text-faint/70 hover:bg-rule/45 hover:text-destructive focus-visible:text-destructive"
            onClick={(event) => {
              event.stopPropagation();
              onCancel();
            }}
            aria-label="Annuler la création de l'abonné"
          >
            <Trash2 className="size-3.5" aria-hidden="true" />
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

function DraftCompanyCombobox({
  value,
  options,
  error,
  autoFocus,
  onChange,
  onConfirm,
}: {
  value: string;
  options: readonly string[];
  error: string | undefined;
  autoFocus?: boolean;
  onChange: (value: string) => void;
  onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listboxId = "draft-subscriber-company-options";
  const normalizedValue = value.trim().toLocaleLowerCase("fr-FR");
  const filteredOptions = options
    .filter((option) => option.toLocaleLowerCase("fr-FR").includes(normalizedValue))
    .slice(0, 5);
  const exactMatch = options.some(
    (option) => option.toLocaleLowerCase("fr-FR") === normalizedValue,
  );
  const canCreate = value.trim().length > 0 && !exactMatch;
  const comboboxOptions = [
    ...filteredOptions.map((option) => ({
      id: option,
      label: option,
      value: option,
      kind: "existing" as const,
    })),
    ...(canCreate
      ? [
          {
            id: `create-${value.trim()}`,
            label: `Créer "${value.trim()}"`,
            value: value.trim(),
            kind: "create" as const,
          },
        ]
      : []),
  ];
  const activeOption = comboboxOptions[activeIndex];

  useEffect(() => {
    setActiveIndex(0);
  }, [value]);

  useEffect(() => {
    if (!autoFocus) return;
    inputRef.current?.focus();
  }, [autoFocus]);

  function selectOption(option: (typeof comboboxOptions)[number]) {
    onChange(option.value);
    setOpen(false);
    setActiveIndex(0);
  }

  return (
    <div className="relative">
      <div className="relative">
        <input
          ref={inputRef}
          value={value}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
          onChange={(event) => {
            onChange(event.target.value);
            setOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setOpen(true);
              setActiveIndex((index) =>
                comboboxOptions.length === 0 ? 0 : (index + 1) % comboboxOptions.length,
              );
              return;
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setOpen(true);
              setActiveIndex((index) =>
                comboboxOptions.length === 0
                  ? 0
                  : (index - 1 + comboboxOptions.length) % comboboxOptions.length,
              );
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              setOpen(false);
              return;
            }
            if (event.key === "Enter") {
              event.preventDefault();
              if (open && activeOption) {
                selectOption(activeOption);
                return;
              }
              onConfirm();
            }
          }}
          aria-label="Société"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-activedescendant={open && activeOption ? `${listboxId}-${activeIndex}` : undefined}
          aria-invalid={Boolean(error)}
          className={cn(
            editableFieldChromeClass,
            "w-full px-1 py-0.5 pr-6 text-sm font-medium text-ink",
            error && "border-destructive/60 focus:border-destructive focus:ring-destructive/20",
          )}
        />
        <ChevronsUpDown
          className="pointer-events-none absolute right-1.5 top-1/2 size-3 -translate-y-1/2 text-faint"
          aria-hidden="true"
        />
      </div>
      {error ? <p className="mt-1 text-[11px] leading-4 text-destructive">{error}</p> : null}
      {open && comboboxOptions.length > 0 ? (
        <div
          id={listboxId}
          role="listbox"
          className="absolute left-0 right-0 top-[calc(100%+4px)] z-20 overflow-hidden rounded-sm border border-rule bg-paper shadow-sm"
        >
          {comboboxOptions.map((option, index) =>
            option.kind === "existing" ? (
              <button
                key={option.id}
                id={`${listboxId}-${index}`}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                className={cn(
                  "flex w-full items-center justify-between px-2 py-1.5 text-left text-xs text-muted hover:bg-rule/45 hover:text-ink",
                  index === activeIndex && "bg-rule/45 text-ink",
                )}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => selectOption(option)}
              >
                <span className="truncate">{option.label}</span>
                {option.value.toLocaleLowerCase("fr-FR") === normalizedValue ? (
                  <Check className="size-3 text-accent" aria-hidden="true" />
                ) : null}
              </button>
            ) : (
              <button
                key={option.id}
                id={`${listboxId}-${index}`}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                className={cn(
                  "flex w-full items-center gap-1.5 border-t border-rule px-2 py-1.5 text-left text-xs text-muted hover:bg-rule/45 hover:text-ink",
                  index === activeIndex && "bg-rule/45 text-ink",
                )}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => selectOption(option)}
              >
                <Plus className="size-3 text-accent" aria-hidden="true" />
                <span className="min-w-0 truncate">{option.label}</span>
              </button>
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}

function DraftEmailInput({
  value,
  error,
  onChange,
  onConfirm,
}: {
  value: string;
  error: string | undefined;
  onChange: (value: string) => void;
  onConfirm: () => void;
}) {
  return (
    <div>
      <input
        value={value}
        type="email"
        inputMode="email"
        autoComplete="email"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") onConfirm();
        }}
        aria-label="Email"
        aria-invalid={Boolean(error)}
        className={cn(
          editableFieldChromeClass,
          "w-full px-1 py-0.5 font-mono text-[11px] text-muted",
          error && "border-destructive/60 focus:border-destructive focus:ring-destructive/20",
        )}
      />
      {error ? <p className="mt-1 text-[11px] leading-4 text-destructive">{error}</p> : null}
    </div>
  );
}

function buildSubscriberRows(
  source: DemoSubscriptionSource,
  state: SubscriberSessionState,
): SubscriberRow[] {
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
        statusRank: status === "active" ? 0 : 1,
      };
    })
    .filter((row) => !state.deletedIds.includes(row.id));

  const createdRows = (state.created ?? [])
    .filter((row) => !state.deletedIds.includes(row.id))
    .map((row) => {
      const status = state.statuses[row.id] === "paused" ? "paused" : row.status;
      return {
        ...row,
        status,
        statusRank: status === "active" ? 0 : 1,
      };
    });

  return [...seededRows, ...createdRows];
}

function validateDraftSubscriber(
  draft: DraftSubscriber,
  rows: readonly SubscriberRow[],
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
  rows: readonly SubscriberRow[],
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

// --- Utilities ---

function formatDate(value: string) {
  return new Intl.DateTimeFormat("fr-FR", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(value));
}

function formatRelativeSchedule(value: string) {
  const diffMs = new Date(value).getTime() - Date.now();
  const absMs = Math.abs(diffMs);
  const minute = 60_000;
  const hour = minute * 60;
  const day = hour * 24;
  const week = day * 7;
  const month = day * 30;
  const formatter = new Intl.RelativeTimeFormat("fr-FR", { numeric: "auto" });

  if (absMs < hour) {
    return formatter.format(Math.round(diffMs / minute), "minute");
  }
  if (absMs < day) {
    return formatter.format(Math.round(diffMs / hour), "hour");
  }
  if (absMs < week) {
    return formatter.format(Math.round(diffMs / day), "day");
  }
  if (absMs < month) {
    return formatter.format(Math.round(diffMs / week), "week");
  }
  return formatter.format(Math.round(diffMs / month), "month");
}

function toDatetimeLocalValue(value: string) {
  const date = new Date(value);
  const offsetDate = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return offsetDate.toISOString().slice(0, 16);
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

// --- Browser-persisted state (demo only) ---
// Keeps demo interactions (pause/resume/delete) in this browser without
// persisting anything to a backend.
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
// --- Mount ---

createRoot(document.getElementById("root")!).render(<App />);
