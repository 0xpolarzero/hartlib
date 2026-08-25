import { useCallback, useEffect, useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { ExternalLink } from "lucide-react";
import { useI18n } from "@/i18n";
import { api } from "@/services";
import type { DocumentFile, Publication, Source } from "@/services/types";
import { formatDate, formatDateShort } from "@/lib/format";
import { useToast } from "@/components/ui/toast";
import {
  Badge,
  Breadcrumbs,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Switch,
  Tooltip,
} from "@/components/ui";
import { DataTable, type DemoDataState } from "./data-table";

function useList<T>(loader: () => Promise<T[]>) {
  const [data, setData] = useState<T[] | null>(null);
  const [error, setError] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    loader()
      .then((rows) => {
        if (alive) {
          setData(rows);
          setError(false);
        }
      })
      .catch((reason) => {
        if (alive) {
          console.error("[subscriber library] load failed:", reason);
          setError(true);
        }
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);

  return { data, error, loading: data === null && !error, reload: useCallback(() => setTick((value) => value + 1), []) };
}

function sourceTypeLabel(source: Source, t: (key: string) => string) {
  return source.type === "invitation" ? t("sources.typeInvitation") : t("sources.typePublic");
}

export function SubscriberLibrary({
  locale,
  subscriptionId,
  issueId,
  onNavigate,
}: {
  locale: "fr" | "en";
  subscriptionId?: string;
  issueId?: string;
  onNavigate: (next: { subscriptionId?: string; issueId?: string }) => void;
}) {
  const { t } = useI18n();
  const sources = useList(() => api.listSources());
  const publications = useList(() => api.listPublications());
  const subscribedSources = useMemo(
    () => (sources.data ?? []).filter((source) => source.subscription === "subscribed"),
    [sources.data],
  );
  const selectedSource = subscribedSources.find((source) => source.id === subscriptionId);
  const sourcePublications = useMemo(
    () => (publications.data ?? []).filter((publication) => publication.sourceId === selectedSource?.id && publication.status === "published"),
    [publications.data, selectedSource?.id],
  );
  const selectedIssue = sourcePublications.find((publication) => publication.id === issueId);

  useEffect(() => {
    if (sources.loading || publications.loading) return;
    if (subscriptionId && !selectedSource) {
      onNavigate({});
      return;
    }
    if (issueId && !selectedIssue) onNavigate({ subscriptionId });
  }, [issueId, onNavigate, publications.loading, selectedIssue, selectedSource, sources.loading, subscriptionId]);

  const crumbs = [
    {
      label: t("subscriptions.title"),
      ...(selectedSource
        ? {
            to: "/$locale/client/chat",
            params: { locale },
            search: { subscription: undefined, issue: undefined },
          }
        : {}),
    },
    ...(selectedSource
      ? [
          {
            label: selectedSource.name,
            ...(selectedIssue
              ? {
                  to: "/$locale/client/chat",
                  params: { locale },
                  search: { subscription: selectedSource.id, issue: undefined },
                }
              : {}),
          },
        ]
      : []),
    ...(selectedIssue ? [{ label: selectedIssue.title }] : []),
  ];

  const navigate = (next: { subscriptionId?: string; issueId?: string }) => onNavigate(next);
  const rootState: DemoDataState = sources.error || publications.error ? "error" : sources.loading || publications.loading ? "loading" : "data";

  return (
    <div className="grid gap-3 p-3">
      {selectedSource && <Breadcrumbs items={crumbs} />}

      {!selectedSource && (
        <section aria-label={t("subscriptions.title")} className="grid gap-2">
          <div>
            <p className="mt-1 text-[12px] leading-relaxed text-ink-2">{t("subscriptions.description")}</p>
          </div>
          <SubscriptionsTable
            sources={subscribedSources}
            state={rootState}
            onRetry={() => {
              sources.reload();
              publications.reload();
            }}
            onSelectSource={(id) => navigate({ subscriptionId: id })}
            onToggle={async (id, enabled) => {
              await api.setSourceSubscriptionEnabled(id, enabled);
              sources.reload();
            }}
          />
        </section>
      )}

      {selectedSource && !selectedIssue && (
        <section aria-labelledby="subscription-publications-heading" className="grid gap-2">
          <div>
            <h2 id="subscription-publications-heading" className="font-display text-[18px] font-medium text-ink">
              {t("subscriptions.publicationsTitle")}
            </h2>
            <p className="mt-1 text-[12px] leading-relaxed text-ink-2">
              {t("subscriptions.publicationsDescription", { source: selectedSource.name })}
            </p>
          </div>
          <SourcePublicationsTable
            sourceId={selectedSource.id}
            publications={sourcePublications}
            state={rootState}
            onRetry={() => publications.reload()}
            onOpenIssue={(id) => navigate({ subscriptionId: selectedSource.id, issueId: id })}
          />
        </section>
      )}

      {selectedSource && selectedIssue && (
        <IssueDetail publication={selectedIssue} source={selectedSource} />
      )}
    </div>
  );
}

function SubscriptionsTable({
  sources,
  state,
  onRetry,
  onSelectSource,
  onToggle,
}: {
  sources: Source[];
  state: DemoDataState;
  onRetry: () => void;
  onSelectSource: (id: string) => void;
  onToggle: (id: string, enabled: boolean) => Promise<void>;
}) {
  const { t, locale } = useI18n();
  const columns = useMemo<ColumnDef<Source, unknown>[]>(
    () => [
      {
        accessorKey: "name",
        header: t("subscriptions.colSource"),
        cell: ({ row }) => (
          <button
            type="button"
            className="block w-full min-w-0 max-w-[13rem] truncate text-left text-[13px] font-medium text-ink underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            title={row.original.name}
            aria-label={row.original.name}
            onClick={() => onSelectSource(row.original.id)}
          >
            {row.original.name}
          </button>
        ),
      },
      {
        accessorKey: "type",
        header: t("subscriptions.colType"),
        enableSorting: false,
        size: 92,
        cell: ({ row }) => <Badge tone={row.original.type === "invitation" ? "accent" : "outline"}>{sourceTypeLabel(row.original, t)}</Badge>,
      },
      {
        accessorKey: "latestPublicationAt",
        header: t("subscriptions.colLatest"),
        cell: ({ getValue }) => <span className="whitespace-nowrap font-mono text-[12px] text-ink-2">{formatDate(locale, getValue() as string)}</span>,
      },
      {
        accessorKey: "subscriptionEnabled",
        header: () => (
          <Tooltip content={t("subscriptions.enabledTip")}>
            <span tabIndex={0} className="inline-flex cursor-help items-center underline decoration-dotted underline-offset-2">
              {t("subscriptions.colEnabled")}
            </span>
          </Tooltip>
        ),
        cell: ({ row }) => {
          const enabled = row.original.subscriptionEnabled;
          return (
            <span className="inline-flex shrink-0 items-center whitespace-nowrap" onClick={(event) => event.stopPropagation()}>
              <Switch
                checked={enabled}
                onCheckedChange={(next) => void onToggle(row.original.id, next)}
                aria-label={t("subscriptions.toggleA11y", {
                  source: row.original.name,
                  state: enabled ? t("subscriptions.enabled") : t("subscriptions.disabled"),
                })}
              />
            </span>
          );
        },
      },
    ],
    [locale, onSelectSource, onToggle, t],
  );

  return (
    <div className="subscriptions-list-table">
      <DataTable
        ariaLabel={t("subscriptions.title")}
        columns={columns}
        data={sources}
        demoState={state}
        onRetry={onRetry}
        urlKey="sub"
        facetLabel={(columnId, value) =>
          value === "__col"
            ? {
                name: t("subscriptions.colSource"),
                type: t("subscriptions.colType"),
                latestPublicationAt: t("subscriptions.colLatest"),
                subscriptionEnabled: t("subscriptions.colEnabled"),
              }[columnId] ?? value
            : value
        }
        emptyTitle={t("subscriptions.emptyTitle")}
        emptyDescription={t("subscriptions.emptyDescription")}
        stickyHeader
      />
    </div>
  );
}

function SourcePublicationsTable({
  sourceId,
  publications,
  state,
  onRetry,
  onOpenIssue,
}: {
  sourceId: string;
  publications: Publication[];
  state: DemoDataState;
  onRetry: () => void;
  onOpenIssue: (id: string) => void;
}) {
  const { locale, t } = useI18n();
  const rows = useMemo(() => publications.filter((publication) => publication.sourceId === sourceId), [publications, sourceId]);
  const columns = useMemo<ColumnDef<Publication, unknown>[]>(
    () => [
      {
        accessorKey: "title",
        header: t("subscriptions.issueTitle"),
        cell: ({ row }) => (
          <button
            type="button"
            className="block w-full min-w-0 truncate text-left text-ink underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            title={row.original.title}
            onClick={() => onOpenIssue(row.original.id)}
          >
            {row.original.title}
          </button>
        ),
      },
      {
        accessorKey: "publishedAt",
        header: t("subscriptions.issueDate"),
        cell: ({ getValue }) => {
          const iso = getValue() as string;
          const fullDate = formatDate(locale, iso);
          return <time dateTime={iso} title={fullDate} aria-label={fullDate} className="whitespace-nowrap font-mono text-[12px] text-ink-2">{formatDateShort(locale, iso)}</time>;
        },
      },
      {
        id: "read",
        header: t("subscriptions.issueRead"),
        accessorFn: (row) => [...row.title].reduce((acc, ch) => acc + ch.codePointAt(0)!, 0) % 3 !== 0,
        filterFn: (row, id, value: string[]) => value.includes(String(row.getValue(id))),
        cell: ({ getValue }) => getValue() === true ? <Badge tone="neutral">{t("subscriptions.issueReadState")}</Badge> : <Badge tone="accent">{t("subscriptions.issueUnreadState")}</Badge>,
      },
      {
        id: "open",
        header: "",
        enableSorting: false,
        size: 32,
        cell: ({ row }) => (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("subscriptions.openIssue")}
            title={t("subscriptions.openIssue")}
            onClick={() => onOpenIssue(row.original.id)}
          >
            <ExternalLink aria-hidden="true" className="size-3" />
          </Button>
        ),
      },
    ],
    [locale, onOpenIssue, t],
  );

  return (
    <DataTable
      ariaLabel={t("subscriptions.publicationsTitle")}
      columns={columns}
      data={rows}
      demoState={state}
      onRetry={onRetry}
      urlKey="subpub"
      facets={["read"]}
      facetLabel={(_column, value) => value === "__col" ? t("subscriptions.issueRead") : value === "true" ? t("subscriptions.issueReadState") : t("subscriptions.issueUnreadState")}
      emptyTitle={t("subscriptions.publicationsEmptyTitle")}
      emptyDescription={t("subscriptions.publicationsEmptyDescription")}
      stickyHeader
    />
  );
}

function IssueDetail({ publication, source }: { publication: Publication; source: Source }) {
  const { locale, t } = useI18n();
  const { toast } = useToast();
  const { data: documents, loading } = useList(() => api.listDocuments());
  const docs = (documents ?? []).filter((document) => document.publicationId === publication.id);

  const openDocument = (document: DocumentFile) => {
    if (document.url) {
      window.open(document.url, "_blank", "noopener");
    } else {
      toast({
        title: t("subscriptions.issueDocumentMissing"),
        description: t("subscriptions.issueDocumentMissingBody"),
        tone: "error",
      });
    }
  };

  return (
    <article aria-labelledby="subscription-issue-heading" className="grid gap-3">
      <div>
        <p className="caps-label text-ink-2">{source.name}</p>
        <h2 id="subscription-issue-heading" className="mt-1 font-display text-[20px] font-medium leading-snug text-ink">{publication.title}</h2>
        {publication.publishedAt && <p className="mt-1 font-mono text-[12px] text-ink-2">{formatDate(locale, publication.publishedAt)}</p>}
      </div>
      <Card>
        <CardHeader><CardTitle>{t("subscriptions.issueSummary")}</CardTitle></CardHeader>
        <CardBody><p className="font-read text-[15px] leading-relaxed text-ink">{publication.summary}</p></CardBody>
      </Card>
      <Card>
        <CardHeader><CardTitle>{t("subscriptions.issueDocuments")}</CardTitle></CardHeader>
        <CardBody>
          {loading && <p className="text-[12px] text-ink-2">{t("common.loading")}</p>}
          {!loading && docs.length === 0 && <p className="text-[12px] text-ink-2">{t("subscriptions.issueNoDocuments")}</p>}
          {!loading && docs.length > 0 && (
            <ul className="grid gap-2">
              {docs.map((document) => (
                <li key={document.id} className="flex items-center justify-between gap-3 border-b border-line pb-2 last:border-b-0 last:pb-0">
                  <span className="min-w-0 truncate text-[13px]" title={document.title}>{document.title}</span>
                  <Button variant="secondary" size="sm" onClick={() => openDocument(document)}>
                    {t("subscriptions.openDocument")}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </article>
  );
}
