import { useIntl, useLocale } from "@brief/i18n";
import { Button } from "@brief/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Download, PackageOpen } from "lucide-react";
import { useState } from "react";

import {
  WorkspacePage,
  WorkspaceSection,
  WorkspaceState,
  StateBadge,
} from "@/components/layout/workspace-page";
import { publisherNavigation } from "@/components/publisher/publisher-workspace-page";
import {
  createPublisherCompanyExport,
  getProductExport,
  openProductExportDownload,
} from "@/lib/platform-api";
import { workspaceErrorLabel, workspaceStateLabel } from "@/lib/workspace-labels";

const formatDate = (value: string | null, locale: string): string =>
  value === null
    ? "—"
    : new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
        new Date(value),
      );

export function PublisherSettingsPage({ companyId }: { readonly companyId: string }) {
  const intl = useIntl();
  const locale = useLocale();
  const [exportId, setExportId] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () =>
      createPublisherCompanyExport(companyId, `publisher-company-export:${crypto.randomUUID()}`),
    onSuccess: (request) => setExportId(request.id),
  });
  const request = useQuery({
    queryKey: ["product-export", exportId],
    queryFn: () => getProductExport(exportId!),
    enabled: exportId !== null,
    refetchInterval: (query) =>
      query.state.data?.status === "queued" || query.state.data?.status === "running"
        ? 3000
        : false,
  });
  const download = useMutation({ mutationFn: openProductExportDownload });
  return (
    <WorkspacePage
      eyebrow={intl.formatMessage({ id: "workspace.publisher.eyebrow" })}
      title={intl.formatMessage({ id: "workspace.settings.title" })}
      navigation={publisherNavigation(companyId, "settings", (id) => intl.formatMessage({ id }))}
    >
      <WorkspaceSection
        title={intl.formatMessage({ id: "workspace.publisher.export.title" })}
        description={intl.formatMessage({ id: "workspace.publisher.export.description" })}
        action={
          <Button disabled={create.isPending} onClick={() => create.mutate()}>
            <PackageOpen className="size-4" aria-hidden="true" />
            {intl.formatMessage({ id: "workspace.settings.export.create" })}
          </Button>
        }
      >
        {request.data ? (
          <div className="rounded-sm border border-rule bg-paper p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="font-mono text-xs text-ink">{request.data.id}</p>
                <p className="mt-1 text-xs text-muted">
                  {formatDate(request.data.createdAt, locale)}
                </p>
              </div>
              <StateBadge
                state={
                  request.data.status === "completed"
                    ? "positive"
                    : request.data.status === "failed"
                      ? "failed"
                      : "pending"
                }
                label={workspaceStateLabel(intl, request.data.status)}
              />
            </div>
            {request.data.downloadPath ? (
              <Button
                className="mt-4"
                variant="outline"
                disabled={download.isPending}
                onClick={() => download.mutate(request.data.downloadPath!)}
              >
                <Download className="size-4" aria-hidden="true" />
                {intl.formatMessage({ id: "workspace.settings.export.download" })}
              </Button>
            ) : null}
          </div>
        ) : (
          <WorkspaceState title={intl.formatMessage({ id: "workspace.settings.export.empty" })} />
        )}
        {create.isError || request.isError || download.isError ? (
          <WorkspaceState
            tone="danger"
            title={intl.formatMessage({ id: "workspace.actionFailed" })}
            body={workspaceErrorLabel(intl, create.error ?? request.error ?? download.error)}
          />
        ) : null}
      </WorkspaceSection>
    </WorkspacePage>
  );
}
