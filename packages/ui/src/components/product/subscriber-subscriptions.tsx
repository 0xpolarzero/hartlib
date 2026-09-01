import { useMemo, useRef, useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import { cn } from "../../lib/utils";
import { Badge, Card, CardBody, CardHeader, CardTitle } from "../ui/atoms";
import { Button } from "../ui/button";
import { Switch } from "../ui/controls";
import { Breadcrumbs, type BreadcrumbItem } from "../ui/breadcrumbs";
import { Select, SelectContent, SelectItem, SelectTrigger } from "../ui/select";
import { DataTable, type DataTableColumn, type DemoDataState } from "./data-table";
import { formatDate, uiMessage } from "../../lib/format";

export type SubscriptionSourceKind = "public" | "invitation" | "publisher";

export interface SubscriptionSource {
  id: string;
  name: string;
  description?: string;
  kind?: SubscriptionSourceKind;
  country?: string;
  enabled?: boolean;
  subscribedSince?: string | null;
  latestPublicationDate?: string | null;
  subscriberCount?: number | null;
  error?: string | null;
}
export interface SubscriptionPublication {
  id: string;
  sourceId: string;
  sourceKind?: SubscriptionSourceKind;
  title: string;
  publicationDate?: string | null;
  status?: "published";
  summary?: string;
  documents?: readonly SubscriptionDocument[];
}
export interface SubscriptionDocument {
  id: string;
  title: string;
  url?: string | null;
  canonicalUrl?: string | null;
  hostedContentUrl?: string | null;
  state?: "ready" | "loading" | "missing" | "error";
  error?: string | null;
}

const sourceKindLabel = (locale: string, kind: SubscriptionSource["kind"]): string =>
  kind === "invitation"
    ? locale.startsWith("fr")
      ? "Sur invitation"
      : "By invitation"
    : kind === "publisher"
      ? uiMessage(locale, "ui.sourceKindPublisher")
      : uiMessage(locale, "ui.sourceKindPublic");

export interface SubscriberSubscriptionsProps {
  sources?: readonly SubscriptionSource[];
  publications?: readonly SubscriptionPublication[];
  sourceId?: string | null;
  issueId?: string | null;
  state?: DemoDataState;
  locale?: string;
  onRetry?: () => void;
  onSelectSource?: (id: string | null) => void;
  onSelectIssue?: (id: string | null) => void;
  onToggle?: (id: string, enabled: boolean) => Promise<void> | void;
  onOpenDocument?: (
    document: SubscriptionDocument,
    issue: SubscriptionPublication,
  ) => Promise<void> | void;
  className?: string;
}

export function SubscriberSubscriptions({
  sources = [],
  publications = [],
  sourceId = null,
  issueId = null,
  state = "data",
  locale = "en-US",
  onRetry,
  onSelectSource,
  onSelectIssue,
  onToggle,
  onOpenDocument,
  className,
}: SubscriberSubscriptionsProps) {
  const source = sources.find((item) => item.id === sourceId) ?? null;
  const issue =
    publications.find((item) => item.id === issueId && item.sourceId === sourceId) ?? null;
  const crumbs: BreadcrumbItem[] = [
    {
      label: uiMessage(locale, "ui.subscriptions"),
      ...(source === null ? {} : { onClick: () => onSelectSource?.(null) }),
    },
    ...(source === null
      ? []
      : [
          {
            label: source.name,
            ...(issue === null ? {} : { onClick: () => onSelectIssue?.(null) }),
          },
        ]),
    ...(issue === null ? [] : [{ label: issue.title }]),
  ];
  return (
    <div className={cn("grid gap-3 p-3", className)}>
      {source !== null && (
        <Breadcrumbs items={crumbs} ariaLabel={uiMessage(locale, "ui.breadcrumb")} />
      )}
      {source === null ? (
        <section aria-label={uiMessage(locale, "ui.subscriptions")} className="grid gap-2">
          <div>
            <p className="mt-1 text-[12px] leading-relaxed text-ink-2">
              {uiMessage(locale, "ui.subscriptionsDescription")}
            </p>
          </div>
          <SubscriptionsTable
            sources={sources}
            state={state}
            locale={locale}
            {...(onRetry === undefined ? {} : { onRetry })}
            {...(onSelectSource === undefined ? {} : { onSelectSource })}
            {...(onToggle === undefined ? {} : { onToggle })}
          />
        </section>
      ) : issue === null ? (
        <section aria-labelledby="subscription-publications-heading" className="grid gap-2">
          <div>
            <h2
              id="subscription-publications-heading"
              className="font-display text-[18px] font-medium text-ink"
            >
              {uiMessage(locale, "ui.publisherPublications")}
            </h2>
            <p className="mt-1 text-[12px] leading-relaxed text-ink-2">{source.name}</p>
          </div>
          <SourcePublicationsTable
            source={source}
            publications={publications.filter((item) => item.sourceId === source.id)}
            state={state}
            locale={locale}
            {...(onRetry === undefined ? {} : { onRetry })}
            {...(onSelectIssue === undefined ? {} : { onSelectIssue })}
          />
        </section>
      ) : (
        <IssueDetail
          publication={issue}
          source={source}
          locale={locale}
          {...(onOpenDocument === undefined ? {} : { onOpenDocument })}
        />
      )}
    </div>
  );
}

function SubscriptionsTable({
  sources,
  state,
  locale,
  onRetry,
  onSelectSource,
  onToggle,
}: {
  sources: readonly SubscriptionSource[];
  state: DemoDataState;
  locale: string;
  onRetry?: () => void;
  onSelectSource?: (id: string) => void;
  onToggle?: (id: string, enabled: boolean) => Promise<void> | void;
}) {
  const pending = useRef(new Set<string>());
  const [, rerender] = useState(0);
  const [pageSize, setPageSize] = useState(10);
  const columns = useMemo<DataTableColumn<SubscriptionSource>[]>(
    () => [
      {
        accessorKey: "name",
        header: uiMessage(locale, "ui.tableSource"),
        cell: ({ row }) => (
          <button
            type="button"
            className="block w-full min-w-0 max-w-[13rem] truncate text-left text-[13px] font-medium text-ink underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            title={row.original.name}
            aria-label={row.original.name}
            onClick={() => onSelectSource?.(row.original.id)}
          >
            {row.original.name}
          </button>
        ),
      },
      {
        accessorKey: "kind",
        header: uiMessage(locale, "column.type"),
        sortable: false,
        cell: ({ row }) => (
          <Badge
            tone={
              row.original.kind === "publisher" || row.original.kind === "invitation"
                ? "accent"
                : "outline"
            }
          >
            {sourceKindLabel(locale, row.original.kind)}
          </Badge>
        ),
      },
      {
        accessorKey: "latestPublicationDate",
        header: uiMessage(locale, "column.latestPublication"),
        cell: ({ value }) => (
          <span className="whitespace-nowrap font-mono text-[12px] text-ink-2">
            {formatDate(locale, value as string | null)}
          </span>
        ),
      },
      {
        accessorKey: "enabled",
        header: uiMessage(locale, "ui.enabled"),
        cell: ({ row }) => {
          const enabled = row.original.enabled ?? false;
          const busy = pending.current.has(row.original.id);
          return (
            <span
              className="inline-flex items-center gap-2"
              onClick={(event) => event.stopPropagation()}
            >
              <Switch
                checked={enabled}
                disabled={busy || onToggle === undefined}
                {...(onToggle === undefined
                  ? {}
                  : {
                      onCheckedChange: (next: boolean) => {
                        pending.current.add(row.original.id);
                        rerender((value) => value + 1);
                        const result = onToggle(row.original.id, next);
                        void Promise.resolve(result)
                          .catch(() => undefined)
                          .finally(() => {
                            pending.current.delete(row.original.id);
                            rerender((value) => value + 1);
                          });
                      },
                    })}
                aria-label={`${row.original.name} ${enabled ? uiMessage(locale, "workspace.delivery.enabled") : uiMessage(locale, "workspace.delivery.disabled")}`}
              />
              {busy && (
                <RefreshCw
                  className="size-3 animate-spin-slow"
                  aria-label={uiMessage(locale, "ui.updating")}
                />
              )}
              {row.original.error && (
                <span role="alert" className="text-[11px] text-danger">
                  {row.original.error}
                </span>
              )}
            </span>
          );
        },
      },
    ],
    [locale, onSelectSource, onToggle],
  );
  return (
    <div className="subscriptions-list-table relative">
      <DataTable
        key={pageSize}
        ariaLabel={uiMessage(locale, "ui.subscriptions")}
        columns={columns}
        data={sources}
        demoState={state}
        locale={locale}
        pageSize={pageSize}
        {...(onRetry === undefined ? {} : { onRetry })}
        facets={["kind", "enabled"]}
        facetLabel={(columnId, value) =>
          columnId === "kind" ? sourceKindLabel(locale, value as SubscriptionSourceKind) : value
        }
        emptyTitle={uiMessage(locale, "ui.noSubscriptions")}
        emptyDescription={uiMessage(locale, "ui.noAuthorizedPublicSource")}
        stickyHeader
      />
      {state === "data" && sources.length > 0 && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex justify-end pr-20 sm:pr-24">
          <SubscriptionPageSizeSelect locale={locale} value={pageSize} onChange={setPageSize} />
        </div>
      )}
    </div>
  );
}

function SourcePublicationsTable({
  source: _source,
  publications,
  state,
  locale,
  onRetry,
  onSelectIssue,
}: {
  source: SubscriptionSource;
  publications: readonly SubscriptionPublication[];
  state: DemoDataState;
  locale: string;
  onRetry?: () => void;
  onSelectIssue?: (id: string) => void;
}) {
  const [pageSize, setPageSize] = useState(10);
  const columns: DataTableColumn<SubscriptionPublication>[] = [
    {
      accessorKey: "title",
      header: uiMessage(locale, "column.publication"),
      cell: ({ row }) => (
        <button
          type="button"
          className="block w-full min-w-0 truncate text-left text-ink underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          title={row.original.title}
          aria-label={row.original.title}
          onClick={() => onSelectIssue?.(row.original.id)}
        >
          {row.original.title}
        </button>
      ),
    },
    {
      accessorKey: "publicationDate",
      header: uiMessage(locale, "column.date"),
      cell: ({ value }) => (
        <span className="whitespace-nowrap font-mono text-[12px] text-ink-2">
          {formatDate(locale, value as string | null)}
        </span>
      ),
    },
    {
      accessorKey: "status",
      header: uiMessage(locale, "workspace.issueStatus.published"),
      cell: () => (
        <Badge tone="success">{uiMessage(locale, "ui.publicationStatusPublished")}</Badge>
      ),
    },
    {
      id: "open",
      header: <span className="sr-only">{uiMessage(locale, "ui.actions")}</span>,
      sortable: false,
      cell: ({ row }) => (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`${uiMessage(locale, "ui.open")} ${row.original.title}`}
          onClick={() => onSelectIssue?.(row.original.id)}
        >
          <ExternalLink className="size-3" aria-hidden="true" />
        </Button>
      ),
    },
  ];
  return (
    <div className="subscription-publications-table relative">
      <DataTable
        key={pageSize}
        ariaLabel={uiMessage(locale, "ui.publisherPublications")}
        columns={columns}
        data={publications}
        demoState={state}
        locale={locale}
        {...(onRetry === undefined ? {} : { onRetry })}
        pageSize={pageSize}
        emptyTitle={uiMessage(locale, "ui.noPublisherPublications")}
        emptyDescription={uiMessage(locale, "ui.noPublicationIngested")}
        stickyHeader
      />
      {state === "data" && publications.length > 0 && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex justify-end pr-20 sm:pr-24">
          <SubscriptionPageSizeSelect locale={locale} value={pageSize} onChange={setPageSize} />
        </div>
      )}
    </div>
  );
}

function SubscriptionPageSizeSelect({
  locale,
  value,
  onChange,
}: {
  locale: string;
  value: number;
  onChange: (value: number) => void;
}) {
  const label = locale.startsWith("fr") ? "Lignes par page" : "Rows per page";
  return (
    <Select value={String(value)} onValueChange={(next) => onChange(Number(next))}>
      <SelectTrigger
        className="pointer-events-auto h-6 w-24 shrink-0 whitespace-nowrap px-2"
        aria-label={label}
      >
        <span>{value} / page</span>
      </SelectTrigger>
      <SelectContent>
        {[10, 25, 50].map((size) => (
          <SelectItem key={size} value={String(size)}>
            {size} / page
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function IssueDetail({
  publication,
  source,
  locale,
  onOpenDocument,
}: {
  publication: SubscriptionPublication;
  source: SubscriptionSource;
  locale: string;
  onOpenDocument?: (
    document: SubscriptionDocument,
    issue: SubscriptionPublication,
  ) => Promise<void> | void;
}) {
  const docs = publication.documents ?? [];
  return (
    <article aria-labelledby="subscription-issue-heading" className="grid gap-3">
      <div>
        <p className="caps-label text-ink-2">{source.name}</p>
        <h2
          id="subscription-issue-heading"
          className="mt-1 font-display text-[20px] font-medium leading-snug text-ink"
        >
          {publication.title}
        </h2>
        {publication.publicationDate && (
          <p className="mt-1 font-mono text-[12px] text-ink-2">
            {formatDate(locale, publication.publicationDate)}
          </p>
        )}
      </div>
      <Card>
        <CardHeader>
          <CardTitle>{uiMessage(locale, "ui.summary")}</CardTitle>
        </CardHeader>
        <CardBody>
          <p className="font-read text-[15px] leading-relaxed text-ink">
            {publication.summary || uiMessage(locale, "ui.noSummary")}
          </p>
        </CardBody>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{uiMessage(locale, "ui.publisherDocuments")}</CardTitle>
        </CardHeader>
        <CardBody>
          {docs.length === 0 ? (
            <p className="text-[12px] text-ink-2">{uiMessage(locale, "ui.noDocument")}</p>
          ) : (
            <ul className="grid gap-2">
              {docs.map((document) => (
                <li
                  key={document.id}
                  className="flex items-center justify-between gap-3 border-b border-line pb-2 last:border-b-0 last:pb-0"
                >
                  <span className="min-w-0 truncate text-[13px]" title={document.title}>
                    {document.title}
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    {document.canonicalUrl && (
                      <a
                        href={document.canonicalUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        referrerPolicy="no-referrer"
                        className="text-[12px] text-ink-2 underline underline-offset-2"
                      >
                        {uiMessage(locale, "ui.officialSource")}
                      </a>
                    )}
                    {document.state === "loading" ? (
                      <span role="status" className="text-[12px] text-ink-2">
                        {uiMessage(locale, "ui.loadingDocument")}
                      </span>
                    ) : document.state === "missing" ? (
                      <span className="text-[12px] text-ink-2">
                        {uiMessage(locale, "ui.unavailable")}
                      </span>
                    ) : document.state === "error" ? (
                      <span className="flex items-center gap-2">
                        <span role="alert" className="text-[12px] text-danger">
                          {document.error ?? uiMessage(locale, "ui.unableOpen")}
                        </span>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            if (onOpenDocument) void onOpenDocument(document, publication);
                          }}
                        >
                          {uiMessage(locale, "ui.retry")}
                        </Button>
                      </span>
                    ) : (
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={onOpenDocument === undefined}
                        onClick={() => {
                          if (onOpenDocument) void onOpenDocument(document, publication);
                        }}
                      >
                        {uiMessage(locale, "ui.openDocument")}
                      </Button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </article>
  );
}
