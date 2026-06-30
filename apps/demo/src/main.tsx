import { createRoot } from "react-dom/client";
import {
  ArrowDown,
  ArrowUp,
  BookOpen,
  Bot,
  ChevronRight,
  ChevronsUpDown,
  Info,
  Lock,
  MessageSquare,
  Search,
  Send,
  Users,
} from "lucide-react";
import { Fragment, useMemo, useState } from "react";

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
const latestIssueBySourceId = new Map(demoDataset.issues.map((i) => [i.sourceId, i]));
const issuesBySourceId = new Map<string, readonly DemoIssue[]>();
for (const issue of demoDataset.issues) {
  const arr = issuesBySourceId.get(issue.sourceId) ?? [];
  issuesBySourceId.set(issue.sourceId, [...arr, issue]);
}
const primaryChat = demoDataset.chats[0];
const primaryArtifact = demoDataset.artifacts[0];
const demoClients = [
  {
    id: demoDataset.companies.client.id,
    name: demoDataset.companies.client.name,
    users: 1,
    subscriptions: demoDataset.sources.length,
    lastActive: formatDate(primaryChat?.updatedAt ?? demoDataset.generatedAt),
  },
];

// --- App ---

function App() {
  const [role, setRole] = useState<DemoRole>("publisher");
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(
    demoDataset.sources[0]?.id ?? null,
  );

  function handleRoleChange(next: DemoRole) {
    setRole(next);
    // Publisher lands directly on its first source; client lands on the sources list.
    setSelectedSourceId(next === "publisher" ? (demoDataset.sources[0]?.id ?? null) : null);
  }

  const selectedSource = selectedSourceId ? (sourceById.get(selectedSourceId) ?? null) : null;

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
          </div>
        </header>

        <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
          <div className="mb-6">
            <Crumbs
              items={
                selectedSource
                  ? [
                      { label: "Fils", onClick: () => setSelectedSourceId(null) },
                      { label: selectedSource.name },
                    ]
                  : [{ label: "Fils" }]
              }
            />
          </div>
          <TabsContent value="publisher" className="mt-0">
            {selectedSource ? (
              <PublisherSourceDetail source={selectedSource} />
            ) : (
              <PublisherSourcesList onSelect={setSelectedSourceId} />
            )}
          </TabsContent>
          <TabsContent value="client" className="mt-0">
            {selectedSource ? (
              <ClientSourceDetail source={selectedSource} />
            ) : (
              <ClientSourcesList onSelect={setSelectedSourceId} />
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

function PublisherSourcesList({ onSelect }: { onSelect: (id: string) => void }) {
  return (
    <section className="animate-in stagger-1">
      <SourcesTable onSelect={onSelect} />
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

function SourcesTable({ onSelect }: { onSelect: (id: string) => void }) {
  const [sorting, setSorting] = useState<SortingState>([
    { id: "lastPublishedAt", desc: true },
  ]);

  const rows = useMemo<FilRow[]>(
    () =>
      demoDataset.sources.map((source) => {
        const issues = issuesBySourceId.get(source.id) ?? [];
        return {
          id: source.id,
          name: source.name,
          issueCount: issues.length,
          lastPublishedAt: issues[0]?.publicationDate ?? null,
          subscriberCount: source.subscriberCount,
        };
      }),
    [],
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

function PublisherSourceDetail({ source }: { source: DemoSubscriptionSource }) {
  const issues = issuesBySourceId.get(source.id) ?? [];
  const [subscriberStatuses, setSubscriberStatuses] = useState<Record<string, SubscriberStatus>>(
    {},
  );
  const [deletedSubscriberIds, setDeletedSubscriberIds] = useState<readonly string[]>([]);

  function handleToggleSubscriberStatus(id: string) {
    setSubscriberStatuses((current) => ({
      ...current,
      [id]: current[id] === "paused" ? "active" : "paused",
    }));
  }

  function handleDeleteSubscriber(id: string) {
    setDeletedSubscriberIds((current) => (current.includes(id) ? current : [...current, id]));
  }

  return (
    <div className="space-y-8">
      <p className="font-serif text-sm leading-6 text-muted">{source.description}</p>

      <div className="animate-in stagger-1 grid gap-8 xl:grid-cols-[1.3fr_0.7fr]">
        <section>
          <h3 className="flex items-center gap-3 text-xs font-normal uppercase tracking-[0.16em] text-faint">
            <span>Publications</span>
            <span className="font-mono tracking-normal text-faint/60">{issues.length}</span>
          </h3>
          <div className="mt-4">
            <IssueTable issues={issues} compact />
          </div>
        </section>

        <section>
          <h3 className="text-xs font-normal uppercase tracking-[0.16em] text-faint">Abonnés</h3>
          <div className="mt-4">
            <SubscriberTable
              source={source}
              statuses={subscriberStatuses}
              deletedIds={deletedSubscriberIds}
              onToggleStatus={handleToggleSubscriberStatus}
              onDelete={handleDeleteSubscriber}
            />
          </div>
        </section>
      </div>

    </div>
  );
}

// --- Client Views ---

function ClientSourcesList({ onSelect }: { onSelect: (id: string) => void }) {
  const activeSources = demoDataset.sources;
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
            value={String(demoDataset.issues.length)}
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
                <span className="truncate text-sm">Rechercher dans les publications livrées...</span>
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

function ClientSourceDetail({ source }: { source: DemoSubscriptionSource }) {
  const issues = issuesBySourceId.get(source.id) ?? [];

  return (
    <div className="space-y-8">
      <p className="font-serif text-sm leading-6 text-muted">{source.description}</p>

      <section className="animate-in stagger-1">
        <SectionTitle title="Issue archive" />
        <div className="mt-4 divide-y divide-rule">
          {issues.map((issue) => (
            <ArchiveIssue key={issue.id} issue={issue} />
          ))}
        </div>
      </section>
    </div>
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
  onSelect,
}: {
  source: DemoSubscriptionSource;
  perspective: DemoRole;
  onSelect?: () => void;
}) {
  const latestIssue = latestIssueBySourceId.get(source.id);

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
          <div className="mt-1 text-sm text-ink">{latestIssue?.title ?? "Aucune publication livrée"}</div>
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
};

type SubscriberStatus = "active" | "paused";

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

function IssueTable({ issues, compact }: { issues: readonly DemoIssue[]; compact?: boolean }) {
  const [sorting, setSorting] = useState<SortingState>([
    { id: "publicationDate", desc: true },
  ]);

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
    ],
    [compact],
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
          <TableRow key={row.id}>
            {row.getVisibleCells().map((cell) => {
              if (cell.column.id === "title") {
                return (
                  <TableCell key={cell.id}>
                    <div className="font-medium text-ink">{row.original.title}</div>
                  </TableCell>
                );
              }
              if (cell.column.id === "publicationDate") {
                return (
                  <TableCell key={cell.id} className="font-mono text-[11px] text-faint">
                    {formatDate(row.original.publicationDate)}
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

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-faint">{label}</div>
      <div className="font-semibold text-ink">{value}</div>
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
