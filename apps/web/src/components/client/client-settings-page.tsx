import { useIntl, useLocale } from "@hartlib/i18n";
import { Button, Label, Textarea } from "@hartlib/ui";
import { useLiveQuery } from "@tanstack/react-db";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Download, PackageOpen } from "lucide-react";
import { useState } from "react";

import { clientNavigation } from "@/components/client/client-archive-page";
import { useCurrentWorkspaces } from "@/components/layout/workspace-switcher";
import {
  StateBadge,
  WorkspacePage,
  WorkspaceSection,
  WorkspaceState,
} from "@/components/layout/workspace-page";
import {
  createClientCompanyExport,
  createUserChatsExport,
  getClientWebPolicy,
  getProductExport,
  openProductExportDownload,
  listCompanyDeletionRequests,
  requestCompanyDeletion,
  updateClientWebPolicy,
  type ProductExportRequest,
} from "@/lib/platform-api";
import { clientPublicSourceCollection } from "@/lib/db";
import { workspaceErrorLabel, workspaceStateLabel } from "@/lib/workspace-labels";

const formatDate = (value: string | null, locale: string): string =>
  value === null
    ? "—"
    : new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
        new Date(value),
      );

export function ClientSettingsPage({ companyId }: { readonly companyId: string }) {
  const intl = useIntl();
  const locale = useLocale();
  const workspaces = useCurrentWorkspaces();
  const role = workspaces.data?.clientWorkspaces.find(
    (workspace) => workspace.companyId === companyId,
  )?.role;
  const [exportId, setExportId] = useState<string | null>(null);
  const [personalExportId, setPersonalExportId] = useState<string | null>(null);
  const createPersonal = useMutation({
    mutationFn: () => createUserChatsExport(`user-chat-export:${crypto.randomUUID()}`),
    onSuccess: (request) => setPersonalExportId(request.id),
  });
  const personalExport = useQuery({
    queryKey: ["product-export", personalExportId],
    queryFn: () => getProductExport(personalExportId!),
    enabled: personalExportId !== null,
    refetchInterval: (query) =>
      query.state.data?.status === "queued" || query.state.data?.status === "running"
        ? 3_000
        : false,
  });
  const create = useMutation({
    mutationFn: () =>
      createClientCompanyExport(companyId, `client-company-export:${crypto.randomUUID()}`),
    onSuccess: (request) => setExportId(request.id),
  });
  const currentExport = useQuery({
    queryKey: ["product-export", exportId],
    queryFn: () => getProductExport(exportId!),
    enabled: exportId !== null,
    refetchInterval: (query) =>
      query.state.data?.status === "queued" || query.state.data?.status === "running"
        ? 3_000
        : false,
  });
  const download = useMutation({ mutationFn: openProductExportDownload });
  const webPolicy = useQuery({
    queryKey: ["client-web-policy", companyId],
    queryFn: () => getClientWebPolicy(companyId),
  });

  return (
    <WorkspacePage
      eyebrow={intl.formatMessage({ id: "workspace.client.eyebrow" })}
      title={intl.formatMessage({ id: "workspace.settings.title" })}
      navigation={clientNavigation(companyId, "settings", (id) => intl.formatMessage({ id }))}
    >
      <div className="space-y-9">
        <WorkspaceSection
          title={intl.formatMessage({ id: "workspace.settings.web.title" })}
          description={intl.formatMessage({ id: "workspace.settings.web.description" })}
        >
          {webPolicy.isPending ? (
            <WorkspaceState title={intl.formatMessage({ id: "workspace.loading" })} />
          ) : webPolicy.isError ? (
            <WorkspaceState
              tone="danger"
              title={intl.formatMessage({ id: "workspace.unavailable" })}
            />
          ) : role === "admin" ? (
            <WebPolicyEditor
              companyId={companyId}
              enabled={webPolicy.data.enabled}
              allowedDomains={webPolicy.data.allowedDomains}
              onUpdated={() => webPolicy.refetch()}
            />
          ) : (
            <div className="rounded-sm border border-rule bg-paper p-5">
              <StateBadge
                state={webPolicy.data.enabled ? "positive" : "paused"}
                label={intl.formatMessage({
                  id: webPolicy.data.enabled
                    ? "workspace.settings.web.enabled"
                    : "workspace.settings.web.disabled",
                })}
              />
              <p className="mt-3 text-sm text-muted">
                {webPolicy.data.allowedDomains?.join(", ") ??
                  intl.formatMessage({ id: "workspace.settings.web.noAllowlist" })}
              </p>
            </div>
          )}
        </WorkspaceSection>

        <WorkspaceSection
          title={intl.formatMessage({ id: "workspace.settings.personalExport.title" })}
          description={intl.formatMessage({ id: "workspace.settings.personalExport.description" })}
          action={
            <Button disabled={createPersonal.isPending} onClick={() => createPersonal.mutate()}>
              <PackageOpen className="size-4" aria-hidden="true" />
              {intl.formatMessage({ id: "workspace.settings.export.create" })}
            </Button>
          }
        >
          {personalExport.data ? (
            <ExportStatus
              request={personalExport.data}
              locale={locale}
              downloading={download.isPending}
              onDownload={(path) => download.mutate(path)}
            />
          ) : (
            <WorkspaceState title={intl.formatMessage({ id: "workspace.settings.export.empty" })} />
          )}
          {createPersonal.isError || personalExport.isError ? (
            <WorkspaceState
              tone="danger"
              title={intl.formatMessage({ id: "workspace.actionFailed" })}
            />
          ) : null}
        </WorkspaceSection>

        <WorkspaceSection
          title={intl.formatMessage({ id: "workspace.settings.export.title" })}
          description={intl.formatMessage({ id: "workspace.settings.export.description" })}
          action={
            role === "admin" ? (
              <Button disabled={create.isPending} onClick={() => create.mutate()}>
                <PackageOpen className="size-4" aria-hidden="true" />
                {intl.formatMessage({ id: "workspace.settings.export.create" })}
              </Button>
            ) : null
          }
        >
          {workspaces.isPending ? (
            <WorkspaceState title={intl.formatMessage({ id: "workspace.loading" })} />
          ) : role !== "admin" ? (
            <WorkspaceState title={intl.formatMessage({ id: "workspace.settings.adminOnly" })} />
          ) : currentExport.data ? (
            <ExportStatus
              request={currentExport.data}
              locale={locale}
              downloading={download.isPending}
              onDownload={(path) => download.mutate(path)}
            />
          ) : (
            <WorkspaceState title={intl.formatMessage({ id: "workspace.settings.export.empty" })} />
          )}
          {create.isError || currentExport.isError || download.isError ? (
            <WorkspaceState
              tone="danger"
              title={intl.formatMessage({ id: "workspace.actionFailed" })}
              body={workspaceErrorLabel(
                intl,
                create.error ?? currentExport.error ?? download.error,
              )}
            />
          ) : null}
        </WorkspaceSection>

        <PublicSourcesSection companyId={companyId} admin={role === "admin"} />

        {role === "admin" ? <CompanyDeletionSection companyId={companyId} /> : null}
      </div>
    </WorkspacePage>
  );
}

function PublicSourcesSection({
  companyId,
  admin,
}: {
  readonly companyId: string;
  readonly admin: boolean;
}) {
  const intl = useIntl();
  const sourcesCollection = clientPublicSourceCollection(companyId);
  const sources = useLiveQuery(sourcesCollection);
  const update = useMutation({
    mutationFn: async (input: { readonly sourceId: string; readonly enabled: boolean }) => {
      const transaction = sourcesCollection.update(input.sourceId, (draft) => {
        draft.enabled = input.enabled;
      });
      await transaction.isPersisted.promise;
    },
  });
  return (
    <WorkspaceSection
      title={intl.formatMessage({ id: "workspace.settings.publicSources.title" })}
      description={intl.formatMessage({ id: "workspace.settings.publicSources.description" })}
    >
      {sources.isLoading ? (
        <WorkspaceState title={intl.formatMessage({ id: "workspace.loading" })} />
      ) : sources.isError ? (
        <WorkspaceState tone="danger" title={intl.formatMessage({ id: "workspace.unavailable" })} />
      ) : sources.data.length === 0 ? (
        <WorkspaceState
          title={intl.formatMessage({ id: "workspace.settings.publicSources.empty" })}
        />
      ) : (
        <div className="divide-y divide-rule rounded-sm border border-rule bg-paper">
          {sources.data.map((source) => (
            <div key={source.sourceId} className="flex items-center justify-between gap-4 p-4">
              <div>
                <p className="font-medium text-ink">{source.displayName}</p>
                <p className="mt-1 text-xs text-muted">{source.publisherName}</p>
                <p className="mt-1 text-sm text-muted">{source.description}</p>
              </div>
              <Button
                size="sm"
                variant={source.enabled ? "outline" : "default"}
                disabled={!admin || update.isPending}
                onClick={() =>
                  update.mutate({ sourceId: source.sourceId, enabled: !source.enabled })
                }
              >
                {intl.formatMessage({
                  id: source.enabled
                    ? "workspace.settings.publicSources.disable"
                    : "workspace.settings.publicSources.enable",
                })}
              </Button>
            </div>
          ))}
        </div>
      )}
      {update.isError ? (
        <WorkspaceState
          tone="danger"
          title={intl.formatMessage({ id: "workspace.actionFailed" })}
          body={workspaceErrorLabel(intl, update.error)}
        />
      ) : null}
    </WorkspaceSection>
  );
}

function WebPolicyEditor({
  companyId,
  enabled: initialEnabled,
  allowedDomains,
  onUpdated,
}: {
  readonly companyId: string;
  readonly enabled: boolean;
  readonly allowedDomains: readonly string[] | null;
  readonly onUpdated: () => Promise<unknown>;
}) {
  const intl = useIntl();
  const [enabled, setEnabled] = useState(initialEnabled);
  const [domains, setDomains] = useState(allowedDomains?.join("\n") ?? "");
  const save = useMutation({
    mutationFn: () => {
      const values = domains
        .split("\n")
        .map((domain) => domain.trim())
        .filter(Boolean);
      return updateClientWebPolicy(companyId, {
        enabled,
        allowedDomains: values.length === 0 ? null : values,
      });
    },
    onSuccess: (settings) => {
      setEnabled(settings.enabled);
      setDomains(settings.allowedDomains?.join("\n") ?? "");
      void onUpdated();
    },
  });
  return (
    <form
      className="space-y-4 rounded-sm border border-rule bg-paper p-5"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <label className="flex items-start gap-3 text-sm text-ink">
        <input
          type="checkbox"
          className="mt-1"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
        />
        <span>
          <span className="font-medium">
            {intl.formatMessage({ id: "workspace.settings.web.enable" })}
          </span>
          <span className="mt-1 block text-muted">
            {intl.formatMessage({ id: "workspace.settings.web.enableHelp" })}
          </span>
        </span>
      </label>
      <div className="space-y-1.5">
        <Label htmlFor="web-domain-allowlist">
          {intl.formatMessage({ id: "workspace.settings.web.allowlist" })}
        </Label>
        <Textarea
          id="web-domain-allowlist"
          value={domains}
          rows={6}
          placeholder={"example.com\npublic-authority.eu"}
          onChange={(event) => setDomains(event.target.value)}
        />
        <p className="text-xs leading-5 text-muted">
          {intl.formatMessage({ id: "workspace.settings.web.allowlistHelp" })}
        </p>
      </div>
      <div className="flex justify-end">
        <Button type="submit" disabled={save.isPending}>
          {intl.formatMessage({ id: "workspace.settings.web.save" })}
        </Button>
      </div>
      {save.isError ? (
        <WorkspaceState
          tone="danger"
          title={intl.formatMessage({ id: "workspace.actionFailed" })}
          body={workspaceErrorLabel(intl, save.error)}
        />
      ) : null}
    </form>
  );
}

function CompanyDeletionSection({ companyId }: { readonly companyId: string }) {
  const intl = useIntl();
  const locale = useLocale();
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const requests = useQuery({
    queryKey: ["company-deletion-requests", companyId],
    queryFn: () => listCompanyDeletionRequests(companyId),
  });
  const create = useMutation({
    mutationFn: () =>
      requestCompanyDeletion(companyId, {
        reason: reason.trim(),
        idempotencyKey: `company-deletion:${crypto.randomUUID()}`,
      }),
    onSuccess: () => {
      setReason("");
      setConfirmed(false);
      void requests.refetch();
    },
  });
  return (
    <WorkspaceSection
      title={intl.formatMessage({ id: "workspace.settings.deletion.title" })}
      description={intl.formatMessage({ id: "workspace.settings.deletion.description" })}
    >
      {requests.data?.length ? (
        <div className="mb-4 divide-y divide-rule rounded-sm border border-rule bg-paper">
          {requests.data.map((request) => (
            <article
              key={request.id}
              className="flex flex-wrap items-center justify-between gap-3 p-4"
            >
              <div>
                <p className="font-mono text-xs text-ink">{request.id}</p>
                <p className="mt-1 text-xs text-muted">{formatDate(request.requestedAt, locale)}</p>
              </div>
              <StateBadge
                state={
                  request.status === "completed"
                    ? "positive"
                    : request.status === "rejected"
                      ? "failed"
                      : "pending"
                }
                label={workspaceStateLabel(intl, request.status)}
              />
            </article>
          ))}
        </div>
      ) : null}
      <form
        className="space-y-4 rounded-sm border border-danger/30 bg-paper p-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (confirmed && reason.trim() !== "") create.mutate();
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="company-deletion-reason">
            {intl.formatMessage({ id: "workspace.settings.deletion.reason" })}
          </Label>
          <Textarea
            id="company-deletion-reason"
            value={reason}
            maxLength={1000}
            required
            onChange={(event) => setReason(event.target.value)}
          />
        </div>
        <label className="flex items-start gap-3 text-sm text-muted">
          <input
            className="mt-1"
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          {intl.formatMessage({ id: "workspace.settings.deletion.confirm" })}
        </label>
        <div className="flex justify-end">
          <Button
            type="submit"
            variant="outline"
            disabled={create.isPending || !confirmed || reason.trim() === ""}
          >
            {intl.formatMessage({ id: "workspace.settings.deletion.request" })}
          </Button>
        </div>
      </form>
      {requests.isError || create.isError ? (
        <WorkspaceState
          tone="danger"
          title={intl.formatMessage({ id: "workspace.actionFailed" })}
        />
      ) : null}
    </WorkspaceSection>
  );
}

function ExportStatus({
  request,
  locale,
  downloading,
  onDownload,
}: {
  readonly request: ProductExportRequest;
  readonly locale: string;
  readonly downloading: boolean;
  readonly onDownload: (path: string) => void;
}) {
  const intl = useIntl();
  return (
    <div className="rounded-sm border border-rule bg-paper p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="font-mono text-xs text-ink">{request.id}</p>
          <p className="mt-1 text-xs text-muted">
            {intl.formatMessage(
              { id: "workspace.settings.export.requested" },
              { date: formatDate(request.createdAt, locale) },
            )}
          </p>
          {request.expiresAt ? (
            <p className="mt-1 text-xs text-muted">
              {intl.formatMessage(
                { id: "workspace.settings.export.expires" },
                { date: formatDate(request.expiresAt, locale) },
              )}
            </p>
          ) : null}
        </div>
        <StateBadge
          state={
            request.status === "completed"
              ? "positive"
              : request.status === "failed"
                ? "failed"
                : "pending"
          }
          label={workspaceStateLabel(intl, request.status)}
        />
      </div>
      {request.errorCode ? (
        <p className="mt-3 text-sm text-danger">{workspaceErrorLabel(intl, request.errorCode)}</p>
      ) : null}
      {request.downloadPath ? (
        <Button
          className="mt-4"
          variant="outline"
          disabled={downloading}
          onClick={() => onDownload(request.downloadPath!)}
        >
          <Download className="size-4" aria-hidden="true" />
          {intl.formatMessage({ id: "workspace.settings.export.download" })}
        </Button>
      ) : null}
    </div>
  );
}
