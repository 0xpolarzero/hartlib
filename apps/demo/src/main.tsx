import { createRoot } from "react-dom/client";
import {
  ArrowDown,
  ArrowUp,
  BookOpen,
  Bot,
  CalendarClock,
  Check,
  ChevronRight,
  ChevronsUpDown,
  Info,
  Lock,
  MessageSquare,
  Pause,
  Play,
  Plus,
  Search,
  Send,
  Trash2,
  Users,
  RotateCcw,
} from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";

import {
  demoDataset,
  type DemoChatMessage,
  type DemoIssue,
  type DemoRole,
  type DemoSubscriptionSource,
} from "@brief/demo-data";
import {
  ArtifactFrame,
  Button,
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
  cn,
} from "@brief/ui";

import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type Column,
  type SortingState,
} from "@tanstack/react-table";

import "./styles.css";

// --- Data helpers ---

const sourceById = new Map(demoDataset.sources.map((s) => [s.id, s]));
const primaryChat = demoDataset.chats[0];
const primaryArtifact = demoDataset.artifacts[0];
const editableFieldChromeClass =
  "rounded-sm border border-transparent bg-transparent outline-none transition-colors duration-fast hover:border-rule hover:bg-surface/60 focus:border-ring focus:bg-paper focus:ring-2 focus:ring-ring/20";
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

function App() {
  const [role, setRole] = useState<DemoRole>("publisher");
  const [issues, setIssues, resetIssues] = useSessionState<DemoIssue[]>(
    "brief:demo:issues:v1",
    () => demoDataset.issues.map(cloneIssue),
  );
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(
    demoDataset.sources[0]?.id ?? null,
  );
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
  const [resetVersion, setResetVersion] = useState(0);
  const issuesBySourceId = useMemo(() => buildIssuesBySourceId(issues), [issues]);

  function handleRoleChange(next: DemoRole) {
    setRole(next);
    // Publisher lands directly on its first source; client lands on the sources list.
    setSelectedSourceId(next === "publisher" ? (demoDataset.sources[0]?.id ?? null) : null);
    setSelectedIssueId(null);
  }

  function handleSelectSource(id: string | null) {
    setSelectedSourceId(id);
    setSelectedIssueId(null);
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
    setSelectedIssueId(issue.id);
  }

  function handleUpdateIssue(nextIssue: DemoIssue) {
    setIssues((current) => current.map((issue) => (issue.id === nextIssue.id ? nextIssue : issue)));
  }

  function handleDeleteIssue(issueId: string) {
    setIssues((current) => current.filter((issue) => issue.id !== issueId));
    setSelectedIssueId((current) => (current === issueId ? null : current));
  }

  function handleResetDemoStorage() {
    resetDemoStorage();
    resetIssues(demoDataset.issues.map(cloneIssue));
    setSelectedSourceId(role === "publisher" ? (demoDataset.sources[0]?.id ?? null) : null);
    setSelectedIssueId(null);
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
              <div className="flex items-center gap-2">
                <TabsList className="h-auto rounded-sm border border-rule bg-paper p-0.5">
                  <TabsTrigger
                    value="publisher"
                    className="rounded-sm px-2 py-0.5 text-[0.7rem] font-medium data-[state=active]:bg-surface data-[state=active]:text-ink data-[state=active]:shadow-none data-[state=inactive]:hover:text-ink data-[state=inactive]:text-muted"
                  >
                    Publisher
                  </TabsTrigger>
                  <TabsTrigger
                    value="client"
                    className="rounded-sm px-2 py-0.5 text-[0.7rem] font-medium data-[state=active]:bg-surface data-[state=active]:text-ink data-[state=active]:shadow-none data-[state=inactive]:hover:text-ink data-[state=inactive]:text-muted"
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
                      className="size-7 text-faint hover:text-accent"
                      onClick={handleResetDemoStorage}
                      aria-label="Réinitialiser les données locales de la démo"
                    >
                      <RotateCcw className="size-4" aria-hidden="true" />
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
                  selectedSource
                    ? [
                        { label: "Fils", onClick: () => handleSelectSource(null) },
                        ...(selectedIssue
                          ? [
                              {
                                label: selectedSource.name,
                                onClick: () => setSelectedIssueId(null),
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
                  onSelectIssue={setSelectedIssueId}
                />
              ) : (
                <PublisherSourcesList
                  issuesBySourceId={issuesBySourceId}
                  onSelect={handleSelectSource}
                />
              )}
            </TabsContent>
            <TabsContent value="client" className="mt-0">
              {selectedSource && selectedIssue ? (
                <ClientPublicationDetail issue={selectedIssue} />
              ) : selectedSource ? (
                <ClientSourceDetail
                  source={selectedSource}
                  issues={issuesBySourceId.get(selectedSource.id) ?? []}
                />
              ) : (
                <ClientSourcesList issues={issues} onSelect={handleSelectSource} />
              )}
            </TabsContent>
          </div>
        </main>
      </Tabs>
    </TooltipProvider>
  );
}

// --- Crumbs ---

type Crumb = { label: string; onClick?: () => void };

function Crumbs({ items }: { items: readonly Crumb[] }) {
  return (
    <nav className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-wider">
      {items.map((item, index) => (
        <Fragment key={index}>
          {index > 0 ? <span className="text-faint">/</span> : null}
          {item.onClick ? (
            <button
              type="button"
              onClick={item.onClick}
              className="font-mono uppercase tracking-wider text-muted transition-colors duration-fast hover:text-ink"
            >
              {item.label}
            </button>
          ) : (
            <span className="text-ink">{item.label}</span>
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

function SortableTableHead<TData>({
  column,
  align = "left",
  children,
}: {
  column: Column<TData, unknown>;
  align?: "left" | "right";
  children: React.ReactNode;
}) {
  const sorted = column.getIsSorted();

  return (
    <TableHead className={cn(align === "right" && "text-right")}>
      {!column.getCanSort() ? (
        <span
          className={cn(
            "flex h-6 w-full items-center text-faint",
            align === "right" ? "justify-end text-right" : "justify-start text-left",
          )}
        >
          {children}
        </span>
      ) : (
        <button
          type="button"
          onClick={column.getToggleSortingHandler()}
          className={cn(
            "group flex h-6 w-full items-center text-faint",
            align === "right" ? "justify-end text-right" : "justify-start text-left",
          )}
        >
          <span className="inline-flex max-w-full items-center gap-1">
            <span className="min-w-0 truncate">{children}</span>
            <span className="flex size-3 shrink-0 items-center justify-center">
              {sorted === "desc" ? (
                <ArrowDown className="size-3 text-ink" aria-hidden="true" />
              ) : sorted === "asc" ? (
                <ArrowUp className="size-3 text-ink" aria-hidden="true" />
              ) : (
                <ChevronsUpDown
                  className="size-3 opacity-0 transition-opacity duration-fast group-hover:opacity-100"
                  aria-hidden="true"
                />
              )}
            </span>
          </span>
        </button>
      )}
    </TableHead>
  );
}

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
    <div>
      <Table>
        <TableHeader>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header) => {
                return (
                  <SortableTableHead key={header.id} column={header.column}>
                    {flexRender(header.column.columnDef.header, header.getContext())}
                  </SortableTableHead>
                );
              })}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.map((row) => (
            <TableRow
              key={row.id}
              className="cursor-pointer"
              onClick={() => onSelect(row.original.id)}
            >
              {row.getVisibleCells().map((cell) => {
                return (
                  <TableCell key={cell.id} className="tabular-nums text-ink">
                    {cell.column.id === "lastPublishedAt" ? (
                      row.original.lastPublishedAt ? (
                        formatDate(row.original.lastPublishedAt)
                      ) : (
                        "—"
                      )
                    ) : cell.column.id === "name" ? (
                      <span className="font-medium text-ink">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </span>
                    ) : (
                      flexRender(cell.column.columnDef.cell, cell.getContext())
                    )}
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
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
  const subscribers = useMemo(
    () => buildSubscriberRows(source, subscriberState),
    [source, subscriberState],
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
          <SectionHeader title="Abonnés" count={subscribers.length} />
          <div className="mt-4">
            <SubscriberTable
              rows={subscribers}
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

  function handleAddDocument() {
    onUpdateIssue?.({
      ...issue,
      documents: [...issue.documents, createDraftDocument(issue.id, issue.documents.length + 1)],
    });
  }

  return (
    <div className="space-y-8">
      <section>
        <div className="flex items-start gap-3">
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
                  "px-1 py-0.5 font-mono text-[11px] uppercase tracking-wider text-faint focus:text-accent",
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
            onUpdateDocument={updateDocument}
          />
        </div>
      </section>
    </div>
  );
}

// --- Client Views ---

function ClientSourcesList({
  issues,
  onSelect,
}: {
  issues: readonly DemoIssue[];
  onSelect: (id: string) => void;
}) {
  const activeSources = demoDataset.sources;
  const publishedIssues = issues.filter((issue) => issue.status === "published");
  const availableCredits =
    demoDataset.aiPlan.monthlyCredits +
    demoDataset.aiPlan.extraCredits -
    demoDataset.aiPlan.monthlyCreditsUsed -
    demoDataset.aiPlan.extraCreditsUsed;
  const usedCredits = demoDataset.aiPlan.monthlyCreditsUsed + demoDataset.aiPlan.extraCreditsUsed;

  const readSources = useMemo(() => {
    if (!primaryChat?.messages) return [];
    const labels = new Set<string>();
    primaryChat.messages.forEach((msg) => {
      msg.citations?.forEach((c) => labels.add(c.label));
    });
    return Array.from(labels);
  }, []);

  return (
    <div className="space-y-8">
      <div className="animate-in stagger-1">
        <StatsGrid>
          <StatBlock
            label="Fils actifs"
            value={String(activeSources.length)}
            detail="Abonnements livres"
          />
          <StatBlock
            label="Publications archivées"
            value={String(publishedIssues.length)}
            detail="Consultables"
          />
          <StatBlock
            label="Credits IA"
            value={availableCredits.toLocaleString("fr-FR")}
            detail={`${usedCredits.toLocaleString("fr-FR")} consommés`}
          />
          <StatBlock
            label="Renouvellement"
            value={formatShortDate(demoDataset.aiPlan.renewsAt)}
            detail={`Plan ${demoDataset.aiPlan.tier}`}
          />
        </StatsGrid>
      </div>

      <div className="animate-in stagger-2 grid gap-8 xl:grid-cols-[0.85fr_1.15fr]">
        <div className="space-y-8">
          <section>
            <div className="mt-4 divide-y divide-rule">
              {demoDataset.sources.map((source) => (
                <SourceRow
                  key={source.id}
                  source={source}
                  perspective="client"
                  latestIssue={publishedIssues.find((issue) => issue.sourceId === source.id)}
                  onSelect={() => onSelect(source.id)}
                />
              ))}
            </div>
          </section>

          <section>
            <SectionTitle title="Recherche archivée" />
            <div className="mt-4">
              <div className="flex items-center gap-2 rounded-sm border border-rule bg-surface px-3 py-2 text-muted">
                <Search className="size-4 shrink-0" aria-hidden="true" />
                <span className="truncate text-sm">
                  Rechercher dans les publications livrées...
                </span>
                <Lock className="ml-auto size-4 shrink-0" aria-hidden="true" />
              </div>
              <div className="mt-3 flex flex-wrap gap-3">
                {["credit", "raccordement", "EUR/USD", "industrie"].map((tag) => (
                  <span key={tag} className="font-mono text-[11px] text-faint">
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          </section>
        </div>

        <section>
          <SectionTitle title="Chat représenté" />
          <div className="mt-4 space-y-3">
            {primaryChat?.messages.map((message) => (
              <ChatBubble key={message.id} message={message} />
            )) ?? null}
          </div>

          {readSources.length > 0 && (
            <div className="mt-4 space-y-1">
              <div className="font-mono text-[10px] uppercase tracking-wider text-faint">
                Fils consultés
              </div>
              {readSources.map((source) => (
                <div
                  key={source}
                  className="flex items-center gap-1.5 font-mono text-[11px] text-muted"
                >
                  <span className="size-1.5 rounded-full bg-accent" aria-hidden="true" />
                  {source}
                </div>
              ))}
            </div>
          )}

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
      </div>

      <div className="animate-in stagger-3 grid gap-8 xl:grid-cols-[1.1fr_0.9fr]">
        <section>
          <SectionTitle title="Citations et fils lus" />
          <div className="mt-4 divide-y divide-rule">
            {primaryChat?.messages
              .flatMap((message) => message.citations ?? [])
              .map((citation) => (
                <div key={citation.id} className="py-3 first:pt-0 last:pb-0">
                  <div className="font-medium text-ink">
                    {citation.label}, p. {citation.page}
                  </div>
                  <div className="mt-0.5 font-serif text-sm leading-6 text-muted">
                    {citation.quote}
                  </div>
                </div>
              )) ?? null}
          </div>
        </section>

        <section>
          <SectionTitle title={primaryArtifact?.title ?? "Artifact"} />
          <ArtifactFrame
            title={primaryArtifact?.title ?? "Artifact"}
            html={buildMarkdownArtifactHtml(primaryArtifact?.files[0]?.content ?? "")}
            className="mt-4"
          />
        </section>
      </div>
    </div>
  );
}

function ClientSourceDetail({
  source,
  issues,
}: {
  source: DemoSubscriptionSource;
  issues: readonly DemoIssue[];
}) {
  const publishedIssues = issues.filter((issue) => issue.status === "published");

  return (
    <div className="space-y-8">
      <p className="font-serif text-sm leading-6 text-muted">{source.description}</p>

      <section className="animate-in stagger-1">
        <SectionTitle title="Issue archive" />
        <div className="mt-4 divide-y divide-rule">
          {publishedIssues.map((issue) => (
            <ArchiveIssue key={issue.id} issue={issue} />
          ))}
        </div>
      </section>
    </div>
  );
}

function ClientPublicationDetail({ issue }: { issue: DemoIssue }) {
  return <PublisherPublicationDetail issue={issue} />;
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

function StatsGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-0 md:grid-cols-4">{children}</div>;
}

function StatBlock({
  label,
  value,
  detail,
  accent,
}: {
  label: string;
  value: string;
  detail?: string;
  accent?: boolean;
}) {
  return (
    <div className="border-b border-rule pb-4 md:border-b-0 md:border-r md:border-rule md:px-4 last:md:border-r-0 first:md:pl-0 last:md:pr-0">
      <div className="font-mono text-[11px] uppercase tracking-wider text-muted">{label}</div>
      <div
        className={cn(
          "mt-1 font-display text-3xl font-medium",
          accent ? "text-accent" : "text-ink",
        )}
      >
        {value}
      </div>
      {detail && <div className="mt-0.5 text-xs text-faint">{detail}</div>}
    </div>
  );
}

function SourceRow({
  source,
  perspective,
  latestIssue,
  onSelect,
}: {
  source: DemoSubscriptionSource;
  perspective: DemoRole;
  latestIssue?: DemoIssue | undefined;
  onSelect?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={!onSelect}
      className="block w-full py-3 text-left transition-colors duration-fast disabled:cursor-default enabled:hover:bg-surface/60 first:pt-0 last:pb-0"
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-ink">{source.name}</span>
          </div>
          <div className="mt-0.5 text-xs text-muted">
            {perspective === "client" ? source.branding.publisherName : source.description}
          </div>
          <div className="mt-1 text-sm text-ink">
            {latestIssue?.title ?? "Aucune publication livrée"}
          </div>
        </div>
        {onSelect ? (
          <ChevronRight className="mt-1 size-4 shrink-0 text-faint" aria-hidden="true" />
        ) : null}
      </div>
    </button>
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

type DocumentRow = DemoIssue["documents"][number];

type SubscriberStatus = "active" | "paused";

type SubscriberSessionState = {
  statuses: Record<string, SubscriberStatus>;
  deletedIds: readonly string[];
};

type SubscriberRow = {
  id: string;
  company: string;
  email: string;
  subscribedSince: string;
  status: SubscriberStatus;
  statusRank: number;
};

const publicationColumnHelper = createColumnHelper<PublicationRow>();
const subscriberColumnHelper = createColumnHelper<SubscriberRow>();

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
    <Table>
      <TableHeader>
        {table.getHeaderGroups().map((headerGroup) => (
          <TableRow key={headerGroup.id}>
            {headerGroup.headers.map((header) => {
              const alignRight = header.column.id === "actions";
              return (
                <SortableTableHead
                  key={header.id}
                  column={header.column}
                  align={alignRight ? "right" : "left"}
                >
                  {flexRender(header.column.columnDef.header, header.getContext())}
                </SortableTableHead>
              );
            })}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody>
        {table.getRowModel().rows.map((row) => (
          <TableRow
            key={row.id}
            className={cn(onSelectIssue && "cursor-pointer")}
            onClick={() => onSelectIssue?.(row.original.id)}
          >
            {row.getVisibleCells().map((cell) => {
              if (cell.column.id === "title") {
                return (
                  <TableCell key={cell.id}>
                    <div className="font-medium text-ink">{row.original.title}</div>
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
                  <TableCell
                    key={cell.id}
                    className="font-mono text-[11px] text-faint"
                    title={
                      row.original.status === "scheduled" ? "Publication programmée" : undefined
                    }
                  >
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
                  <TableCell key={cell.id} className="font-mono text-[11px] text-faint">
                    -
                  </TableCell>
                );
              }
              if (cell.column.id === "contextPulls") {
                return (
                  <TableCell key={cell.id} className="tabular-nums font-medium text-accent">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                );
              }
              return (
                <TableCell key={cell.id} className="tabular-nums text-ink">
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </TableCell>
              );
            })}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function DocumentsTable({
  documents,
  editable,
  onUpdateDocument,
}: {
  documents: readonly DocumentRow[];
  editable: boolean;
  onUpdateDocument: (documentId: string, patch: Partial<DocumentRow>) => void;
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
        </TableRow>
      </TableHeader>
      <TableBody>
        {documents.map((doc) => (
          <TableRow key={doc.id}>
            <TableCell>
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
            <TableCell className="max-w-md">
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
            <TableCell className="font-mono text-[11px] text-faint">
              {editable ? (
                <InlineInput
                  value={doc.fileName}
                  ariaLabel="Nom du PDF"
                  onChange={(fileName) => onUpdateDocument(doc.id, { fileName })}
                />
              ) : (
                `${doc.fileName} / ${doc.pageCount} pages`
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
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
    <span
      className={cn(
        "inline-flex size-5 items-center justify-center rounded-sm border border-accent/30 bg-accent/10 align-middle text-accent",
        className,
      )}
      title="Publication programmée"
      aria-label="Publication programmée"
    >
      <CalendarClock className="size-3.5" aria-hidden="true" />
    </span>
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
    <div ref={rootRef} className="inline-flex">
      <Button
        type="button"
        variant={confirming ? "destructive" : "ghost"}
        size="icon"
        className={cn(
          "size-7",
          !confirming &&
            "text-faint/70 hover:bg-surface hover:text-destructive focus-visible:text-destructive",
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
          <Check className="size-4" aria-hidden="true" />
        ) : (
          <Trash2 className="size-4" aria-hidden="true" />
        )}
      </Button>
    </div>
  );
}

function SubscriberTable({
  rows,
  onToggleStatus,
  onDelete,
}: {
  rows: SubscriberRow[];
  onToggleStatus: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [sorting, setSorting] = useState<SortingState>([{ id: "company", desc: false }]);

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
                className="size-7 text-faint/70 hover:bg-surface hover:text-muted focus-visible:text-muted"
                onClick={(event) => {
                  event.stopPropagation();
                  onToggleStatus(row.id);
                }}
                aria-label={isPaused ? "Reprendre l'abonnement" : "Mettre en pause l'abonnement"}
              >
                {isPaused ? (
                  <Play className="size-4" aria-hidden="true" />
                ) : (
                  <Pause className="size-4" aria-hidden="true" />
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

  if (rows.length === 0) {
    return (
      <div className="rounded-sm border border-rule bg-paper px-4 py-8 text-center text-sm text-muted">
        Aucun abonné.
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        {table.getHeaderGroups().map((headerGroup) => (
          <TableRow key={headerGroup.id}>
            {headerGroup.headers.map((header) => {
              if (header.column.id === "statusRank") {
                return <TableHead key={header.id} className="hidden" />;
              }
              const alignRight = header.column.id === "actions";
              return (
                <SortableTableHead
                  key={header.id}
                  column={header.column}
                  align={alignRight ? "right" : "left"}
                >
                  {flexRender(header.column.columnDef.header, header.getContext())}
                </SortableTableHead>
              );
            })}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody>
        {table.getRowModel().rows.map((row) => {
          const isPaused = row.original.status === "paused";
          return (
            <TableRow key={row.id} className={cn(isPaused && "opacity-60")}>
              {row.getVisibleCells().map((cell) => {
                if (cell.column.id === "statusRank") return null;
                if (cell.column.id === "company") {
                  return (
                    <TableCell key={cell.id}>
                      <div className="font-medium text-ink">{row.original.company}</div>
                    </TableCell>
                  );
                }
                if (cell.column.id === "email") {
                  return (
                    <TableCell key={cell.id} className="font-mono text-[11px] text-muted">
                      {row.original.email}
                    </TableCell>
                  );
                }
                if (cell.column.id === "subscribedSince") {
                  return (
                    <TableCell key={cell.id} className="font-mono text-[11px] text-faint">
                      {formatDate(row.original.subscribedSince)}
                    </TableCell>
                  );
                }
                return (
                  <TableCell key={cell.id} className="text-right">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                );
              })}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function buildSubscriberRows(
  source: DemoSubscriptionSource,
  state: SubscriberSessionState,
): SubscriberRow[] {
  const baseDate = new Date(source.subscribedSince).getTime();
  return demoSubscriberProfiles
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
}

function ArchiveIssue({ issue }: { issue: DemoIssue }) {
  const source = sourceById.get(issue.sourceId);

  return (
    <div className="py-4 first:pt-0 last:pb-0">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <div className="font-semibold text-ink">{issue.title}</div>
          <div className="mt-0.5 font-mono text-[11px] uppercase tracking-wider text-faint">
            {source?.name} &middot; {formatDate(issue.publicationDate)}
          </div>
          <p className="mt-2 font-serif text-sm leading-6 text-muted">{issue.summary}</p>
          {issue.documents.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5">
              {issue.documents.map((doc) => (
                <span key={doc.id} className="font-mono text-[11px] text-faint">
                  {doc.title}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="flex shrink-0 gap-2">
          <Button variant="secondary" disabled>
            <BookOpen className="size-4" aria-hidden="true" />
            Lire
          </Button>
          <Button variant="ghost" disabled>
            <MessageSquare className="size-4" aria-hidden="true" />
            Citer
          </Button>
        </div>
      </div>
    </div>
  );
}

function ChatBubble({ message }: { message: DemoChatMessage }) {
  const isAssistant = message.author === "assistant";

  return (
    <div className={`flex ${isAssistant ? "justify-start" : "justify-end"}`}>
      <div
        className={`max-w-[85%] rounded-sm px-4 py-3 text-sm leading-6 ${
          isAssistant ? "border border-rule bg-paper text-ink" : "bg-ink text-paper"
        }`}
      >
        <div className="mb-1 flex items-center gap-2 font-mono text-[11px] uppercase tracking-wider text-faint">
          {isAssistant ? <Bot className="size-3" /> : <Users className="size-3" />}
          {isAssistant ? "Assistant" : "Client"}
        </div>
        <div className={isAssistant ? "font-serif" : ""}>{message.content}</div>
        {message.citations && message.citations.length > 0 && (
          <div className="mt-3 space-y-1">
            {message.citations.map((citation) => (
              <a
                key={citation.id}
                href="#"
                onClick={(e) => e.preventDefault()}
                className="block font-mono text-xs text-accent underline decoration-accent/30 hover:decoration-accent/60 transition-all duration-fast"
              >
                {citation.label}, p. {citation.page}
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// --- Utilities ---

function formatDate(value: string) {
  return new Intl.DateTimeFormat("fr-FR", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(value));
}

function formatShortDate(value: string) {
  return new Intl.DateTimeFormat("fr-FR", {
    day: "numeric",
    month: "short",
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
    fileName: `document-demo-${index}.pdf`,
    pageCount: 1,
    language: "fr",
    indexingStatus: "indexed",
    storagePath: `demo/local/${issueId}/${id}.pdf`,
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
  const keys = Array.from({ length: window.localStorage.length }, (_, index) =>
    window.localStorage.key(index),
  ).filter((key): key is string => Boolean(key?.startsWith("brief:demo:")));
  for (const key of keys) {
    window.localStorage.removeItem(key);
  }
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
function buildMarkdownArtifactHtml(markdown: string) {
  const lines = markdown
    .trim()
    .split("\n")
    .filter((line) => line.trim().startsWith("|"));
  const [headerLine, , ...rowLines] = lines;

  if (!headerLine) {
    return `<pre>${escapeHtml(markdown)}</pre>`;
  }

  const headers = splitMarkdownRow(headerLine);
  const rows = rowLines.map(splitMarkdownRow);

  return `<table style="width:100%;border-collapse:collapse;font:14px ui-sans-serif,system-ui,sans-serif;">
    <thead>
      <tr>${headers
        .map(
          (header) =>
            `<th style="text-align:left;border-bottom:1px solid #d6d3ce;padding:10px;color:#334155;">${escapeHtml(
              header,
            )}</th>`,
        )
        .join("")}</tr>
    </thead>
    <tbody>
      ${rows
        .map(
          (row) =>
            `<tr>${row
              .map(
                (cell) =>
                  `<td style="border-bottom:1px solid #e7e5e0;padding:10px;color:#0f172a;vertical-align:top;">${escapeHtml(
                    cell,
                  )}</td>`,
              )
              .join("")}</tr>`,
        )
        .join("")}
    </tbody>
  </table>`;
}

function splitMarkdownRow(row: string) {
  return row
    .split("|")
    .slice(1, -1)
    .map((cell) => cell.trim());
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// --- Mount ---

createRoot(document.getElementById("root")!).render(<App />);
