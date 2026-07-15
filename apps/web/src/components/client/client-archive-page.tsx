import { useIntl, useLocale } from "@brief/i18n";
import { Button, Input, Label } from "@brief/ui";
import { useForm } from "@tanstack/react-form";
import { eq, useLiveInfiniteQuery, useLiveQuery } from "@tanstack/react-db";
import { useQuery } from "@tanstack/react-query";
import { Download, FileText, Search } from "lucide-react";
import { useState } from "react";

import {
  StateBadge,
  WorkspacePage,
  WorkspaceSection,
  WorkspaceState,
} from "@/components/layout/workspace-page";
import { apiResourceUrl, authenticatedFetch } from "@/lib/api-auth";
import {
  archiveCollection,
  clientPublicSourceCollection,
  clientSubscriptionAccessCollection,
  decodeArchiveSourceSelection,
  encodeArchiveSourceSelection,
  type ArchiveCollectionFilter,
} from "@/lib/db";
import { getIssueDetail } from "@/lib/platform-api";
import { validateArchiveQuery } from "@/lib/form-validation";
import { workspaceErrorLabel } from "@/lib/workspace-labels";

const formatDate = (value: string | null, locale: string): string =>
  value === null
    ? "—"
    : new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(value));

const plainSnippet = (value: string | null): string | null =>
  value
    ?.replace(/<[^>]*>/gu, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">") ?? null;

export const openAuthorizedArchiveContent = async (descriptor: {
  readonly contentPath: string;
  readonly mediaType: "application/pdf" | "text/html";
}): Promise<void> => {
  const target = window.open("about:blank", "_blank");
  if (target === null) throw new Error("archive_content_popup_blocked");
  if (descriptor.mediaType === "text/html") {
    // Navigating to the API response preserves its CSP. Copying HTML into a blob would
    // execute it under the application origin and is therefore forbidden.
    target.opener = null;
    target.location.replace(apiResourceUrl(descriptor.contentPath));
    return;
  }
  try {
    const response = await authenticatedFetch(descriptor.contentPath, {
      headers: { accept: "application/pdf" },
    });
    if (!response.ok) throw new Error(`document_open_${response.status}`);
    if (response.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/pdf") {
      throw new Error("document_media_type_mismatch");
    }
    if (response.redirected && response.url !== "") {
      const finalUrl = new URL(response.url);
      const loopbackHttp =
        finalUrl.protocol === "http:" &&
        (finalUrl.hostname === "localhost" ||
          finalUrl.hostname === "127.0.0.1" ||
          finalUrl.hostname === "[::1]");
      if (finalUrl.protocol !== "https:" && !loopbackHttp) {
        throw new Error("document_redirect_invalid");
      }
      // Complete the authorized response before navigating. This prevents an unread
      // fetch body from being cancelled while preserving the exact signed-object check.
      await response.arrayBuffer();
      target.location.href = finalUrl.toString();
      target.opener = null;
      return;
    }
    const objectUrl = URL.createObjectURL(await response.blob());
    target.location.href = objectUrl;
    target.opener = null;
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  } catch (error) {
    target.close();
    throw error;
  }
};

export const openAuthorizedPdfDocument = (contentPath: string): Promise<void> =>
  openAuthorizedArchiveContent({ contentPath, mediaType: "application/pdf" });

export function ClientArchivePage({ companyId }: { readonly companyId: string }) {
  const intl = useIntl();
  const locale = useLocale();
  const [filter, setFilter] = useState<ArchiveCollectionFilter>({ query: "", source: null });
  const [openError, setOpenError] = useState<string | null>(null);
  const archiveItems = archiveCollection(companyId, filter);
  const archive = useLiveInfiniteQuery(
    (query) => query.from({ item: archiveItems }).orderBy(({ item }) => item.publicationAt, "desc"),
    { pageSize: 25 },
    [companyId, filter.query, encodeArchiveSourceSelection(filter.source)],
  );
  const publisherSourcesCollection = clientSubscriptionAccessCollection(companyId);
  const publisherSources = useLiveQuery(publisherSourcesCollection);
  const publicSourcesCollection = clientPublicSourceCollection(companyId);
  const publicSources = useLiveQuery(
    (query) =>
      query
        .from({ source: publicSourcesCollection })
        .where(({ source }) => eq(source.enabled, true)),
    [publicSourcesCollection],
  );
  const form = useForm({
    defaultValues: { query: "", source: "" },
    onSubmit: ({ value }) => {
      setFilter({
        query: value.query.trim(),
        source: decodeArchiveSourceSelection(value.source),
      });
    },
  });
  const items = archive.data;

  return (
    <WorkspacePage
      eyebrow={intl.formatMessage({ id: "workspace.client.eyebrow" })}
      title={intl.formatMessage({ id: "workspace.client.title" })}
      navigation={clientNavigation(companyId, "archive", (id) => intl.formatMessage({ id }))}
    >
      <WorkspaceSection
        title={intl.formatMessage({ id: "workspace.archive.title" })}
        description={intl.formatMessage({ id: "workspace.archive.description" })}
      >
        <form
          className="grid gap-3 rounded-sm border border-rule bg-paper p-4 sm:grid-cols-[minmax(0,1fr)_14rem_auto] sm:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            void form.handleSubmit();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="archive-search">
              {intl.formatMessage({ id: "workspace.archive.searchLabel" })}
            </Label>
            <form.Field
              name="query"
              validators={{
                onChange: ({ value }) => validateArchiveQuery(value),
              }}
            >
              {(field) => (
                <Input
                  id="archive-search"
                  name={field.name}
                  value={field.state.value}
                  maxLength={500}
                  placeholder={intl.formatMessage({ id: "workspace.archive.searchPlaceholder" })}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
              )}
            </form.Field>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="archive-subscription">
              {intl.formatMessage({ id: "workspace.nav.subscriptions" })}
            </Label>
            <form.Field name="source">
              {(field) => (
                <select
                  id="archive-subscription"
                  name={field.name}
                  value={field.state.value}
                  className="h-9 w-full rounded-sm border border-input bg-canvas px-3 text-sm text-ink"
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                >
                  <option value="">
                    {intl.formatMessage({ id: "workspace.archive.allSources" })}
                  </option>
                  {[...publisherSources.data]
                    .sort((left, right) =>
                      left.subscriptionName.localeCompare(right.subscriptionName, locale),
                    )
                    .map((source) => (
                      <option
                        key={`publisher:${source.subscriptionId}`}
                        value={encodeArchiveSourceSelection({
                          kind: "publisher",
                          subscriptionId: source.subscriptionId,
                        })}
                      >
                        {source.publisherName} · {source.subscriptionName}
                      </option>
                    ))}
                  {[...publicSources.data]
                    .sort((left, right) =>
                      left.displayName.localeCompare(right.displayName, locale),
                    )
                    .map((source) => (
                      <option
                        key={`public:${source.sourceId}`}
                        value={encodeArchiveSourceSelection({
                          kind: "public",
                          sourceId: source.sourceId,
                        })}
                      >
                        {source.publisherName} · {source.displayName}
                      </option>
                    ))}
                </select>
              )}
            </form.Field>
          </div>
          <form.Subscribe selector={(state) => [state.canSubmit, state.isSubmitting] as const}>
            {([canSubmit, isSubmitting]) => (
              <Button type="submit" disabled={!canSubmit || isSubmitting}>
                <Search className="size-4" aria-hidden="true" />
                {intl.formatMessage({ id: "workspace.archive.search" })}
              </Button>
            )}
          </form.Subscribe>
        </form>

        {openError ? (
          <WorkspaceState
            tone="danger"
            title={intl.formatMessage({ id: "error.contentOpenFailed" })}
            body={workspaceErrorLabel(intl, openError)}
          />
        ) : null}
        {archive.isLoading || publisherSources.isLoading || publicSources.isLoading ? (
          <WorkspaceState title={intl.formatMessage({ id: "workspace.loading" })} />
        ) : archive.isError || publisherSources.isError || publicSources.isError ? (
          <WorkspaceState
            tone="danger"
            title={intl.formatMessage({ id: "workspace.unavailable" })}
            action={
              <Button
                variant="outline"
                onClick={() =>
                  void Promise.all([
                    archiveItems.utils.clearError(),
                    publisherSourcesCollection.utils.clearError(),
                    publicSourcesCollection.utils.clearError(),
                  ])
                }
              >
                {intl.formatMessage({ id: "action.retry" })}
              </Button>
            }
          />
        ) : items.length === 0 ? (
          <WorkspaceState title={intl.formatMessage({ id: "workspace.archive.empty" })} />
        ) : (
          <div className="divide-y divide-rule rounded-sm border border-rule bg-paper">
            {items.map((item) => (
              <article
                key={`${item.sourceKind}:${item.sourceKind === "publisher" ? item.issueId : item.sourceId}:${item.documentId}`}
                className="grid gap-4 p-4 sm:grid-cols-[minmax(0,1fr)_auto]"
              >
                <div className="min-w-0">
                  <p className="text-xs font-medium text-accent">
                    {item.publisherName} · {item.subscriptionName}
                  </p>
                  <h2 className="mt-1 truncate text-sm font-semibold text-ink">
                    {item.sourceKind === "publisher" ? (
                      <a
                        className="hover:text-accent"
                        href={`/${locale}/client/${encodeURIComponent(companyId)}/issues/${encodeURIComponent(item.issueId)}`}
                      >
                        {item.issueTitle}
                      </a>
                    ) : (
                      item.issueTitle
                    )}
                  </h2>
                  <p className="mt-1 flex items-center gap-2 text-sm text-muted">
                    <FileText className="size-3.5" aria-hidden="true" />
                    {item.documentTitle}
                  </p>
                  {plainSnippet(item.snippet) ? (
                    <p className="mt-3 max-w-3xl font-serif text-sm leading-6 text-muted">
                      {plainSnippet(item.snippet)}
                    </p>
                  ) : null}
                </div>
                <div className="flex items-start gap-3 sm:flex-col sm:items-end">
                  <span className="font-mono text-[11px] text-faint">
                    {formatDate(item.publicationAt, locale)}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setOpenError(null);
                      void openAuthorizedArchiveContent({
                        contentPath: item.contentPath,
                        mediaType: item.mediaType,
                      }).catch((error: unknown) =>
                        setOpenError(error instanceof Error ? error.message : String(error)),
                      );
                    }}
                  >
                    <Download className="size-4" aria-hidden="true" />
                    {intl.formatMessage({
                      id:
                        item.mediaType === "application/pdf"
                          ? "workspace.archive.openPdf"
                          : "workspace.archive.openContent",
                    })}
                  </Button>
                  {item.canonicalUrl === null ? null : (
                    <a
                      className="text-xs text-accent underline-offset-2 hover:underline"
                      href={item.canonicalUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {intl.formatMessage({ id: "workspace.archive.officialSource" })}
                    </a>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
        {archive.hasNextPage ? (
          <div className="flex justify-center">
            <Button
              variant="outline"
              disabled={archive.isFetchingNextPage}
              onClick={archive.fetchNextPage}
            >
              {intl.formatMessage({ id: "workspace.loadMore" })}
            </Button>
          </div>
        ) : null}
      </WorkspaceSection>
    </WorkspacePage>
  );
}

export function ClientIssuePage({
  companyId,
  issueId,
}: {
  readonly companyId: string;
  readonly issueId: string;
}) {
  const intl = useIntl();
  const locale = useLocale();
  const [openError, setOpenError] = useState<string | null>(null);
  const detail = useQuery({
    queryKey: ["issue-detail", issueId],
    queryFn: () => getIssueDetail(issueId),
  });
  return (
    <WorkspacePage
      eyebrow={intl.formatMessage({ id: "workspace.client.eyebrow" })}
      title={intl.formatMessage({ id: "workspace.client.title" })}
      navigation={clientNavigation(companyId, "archive", (id) => intl.formatMessage({ id }))}
    >
      {detail.isPending ? (
        <WorkspaceState title={intl.formatMessage({ id: "workspace.loading" })} />
      ) : detail.isError ? (
        <WorkspaceState tone="danger" title={intl.formatMessage({ id: "workspace.unavailable" })} />
      ) : (
        <div className="space-y-8">
          <header className="border-b border-rule pb-5">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="font-display text-2xl text-ink">{detail.data.issue.title}</h1>
              <StateBadge
                state={detail.data.issue.indexingStatus === "failed" ? "failed" : "positive"}
                label={intl.formatMessage({
                  id: `workspace.indexingStatus.${detail.data.issue.indexingStatus}`,
                })}
              />
            </div>
            <p className="mt-2 font-mono text-[11px] text-faint">
              {formatDate(detail.data.issue.publicationAt, locale)}
              {detail.data.issue.historical
                ? ` · ${intl.formatMessage({ id: "workspace.publisher.issues.historicalShort" })}`
                : ""}
            </p>
          </header>
          {openError ? (
            <WorkspaceState
              tone="danger"
              title={intl.formatMessage({ id: "error.pdfOpenFailed" })}
              body={workspaceErrorLabel(intl, openError)}
            />
          ) : null}
          <WorkspaceSection title={intl.formatMessage({ id: "section.documents" })}>
            <div className="grid gap-3 sm:grid-cols-2">
              {detail.data.documents.map((document) => (
                <div key={document.id} className="rounded-sm border border-rule bg-paper p-4">
                  <p className="text-sm font-semibold text-ink">{document.title}</p>
                  <p className="mt-1 truncate font-mono text-[11px] text-faint">
                    {document.originalFileName} · {Math.ceil(document.byteSize / 1024)} KB
                  </p>
                  <Button
                    className="mt-4"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setOpenError(null);
                      void openAuthorizedPdfDocument(
                        `/v1/issues/${encodeURIComponent(issueId)}/documents/${encodeURIComponent(document.id)}/content`,
                      ).catch((error: unknown) =>
                        setOpenError(error instanceof Error ? error.message : String(error)),
                      );
                    }}
                  >
                    <Download className="size-4" aria-hidden="true" />
                    {intl.formatMessage({ id: "workspace.archive.openPdf" })}
                  </Button>
                </div>
              ))}
            </div>
          </WorkspaceSection>
        </div>
      )}
    </WorkspacePage>
  );
}

export function clientNavigation(
  companyId: string,
  active: "archive" | "chats" | "notifications" | "team" | "billing" | "settings",
  format: (id: string) => string,
) {
  return [
    {
      href: `/client/${companyId}`,
      label: format("workspace.nav.archive"),
      active: active === "archive",
    },
    {
      href: `/client/${companyId}/chats`,
      label: format("workspace.nav.chats"),
      active: active === "chats",
    },
    {
      href: `/client/${companyId}/notifications`,
      label: format("workspace.nav.notifications"),
      active: active === "notifications",
    },
    {
      href: `/client/${companyId}/team`,
      label: format("workspace.nav.team"),
      active: active === "team",
    },
    {
      href: `/client/${companyId}/billing`,
      label: format("workspace.nav.billing"),
      active: active === "billing",
    },
    {
      href: `/client/${companyId}/settings`,
      label: format("workspace.nav.settings"),
      active: active === "settings",
    },
  ];
}
