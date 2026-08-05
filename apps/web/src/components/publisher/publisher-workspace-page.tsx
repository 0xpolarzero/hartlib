import { useIntl, useLocale } from "@hartlib/i18n";
import type { PublisherIssueDescriptor } from "@hartlib/shared";
import {
  Button,
  Input,
  Label,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@hartlib/ui";
import { useForm } from "@tanstack/react-form";
import { useLiveQuery } from "@tanstack/react-db";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useState } from "react";

import {
  WorkspacePage,
  WorkspaceSection,
  WorkspaceState,
  StateBadge,
} from "@/components/layout/workspace-page";
import {
  publisherClientAccessCollection,
  publisherIssueCollection,
  publisherSubscriptionCollection,
} from "@/lib/db";
import { validateSubscriptionName } from "@/lib/form-validation";
import {
  createPublisherIssue,
  createPublisherSubscription,
  getPublisherAiPullMetrics,
  invitePublisherClientAccess,
  pausePublisherClientAccess,
  type PublisherSubscriptionClientAccess,
} from "@/lib/platform-api";
import { workspaceErrorLabel, workspaceStateLabel } from "@/lib/workspace-labels";

const formatDate = (value: string | null, locale: string): string =>
  value === null
    ? "—"
    : new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
        new Date(value),
      );

const issueState = (
  issue: PublisherIssueDescriptor,
): "positive" | "pending" | "paused" | "failed" | "neutral" =>
  issue.status === "published"
    ? "positive"
    : issue.indexingStatus === "failed"
      ? "failed"
      : issue.status === "scheduled"
        ? "pending"
        : "neutral";

export function PublisherWorkspacePage({ companyId }: { readonly companyId: string }) {
  const intl = useIntl();
  const locale = useLocale();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const subscriptionsCollection = publisherSubscriptionCollection(companyId);
  const subscriptions = useLiveQuery(subscriptionsCollection);
  const create = useMutation({
    mutationFn: (name: string) => createPublisherSubscription(companyId, { name }),
    onSuccess: (subscription) => {
      setCreating(false);
      void queryClient.invalidateQueries({ queryKey: ["publisher-subscriptions", companyId] });
      window.location.assign(
        `/${locale}/publisher/${encodeURIComponent(companyId)}/subscriptions/${encodeURIComponent(subscription.id)}`,
      );
    },
  });
  const subscriptionForm = useForm({
    defaultValues: { name: "" },
    onSubmit: ({ value }) => create.mutate(value.name.trim()),
  });

  return (
    <WorkspacePage
      eyebrow={intl.formatMessage({ id: "workspace.publisher.eyebrow" })}
      title={intl.formatMessage({ id: "workspace.publisher.title" })}
      navigation={publisherNavigation(companyId, "subscriptions", (id) =>
        intl.formatMessage({ id }),
      )}
    >
      <WorkspaceSection
        title={intl.formatMessage({ id: "workspace.publisher.subscriptions.title" })}
        description={intl.formatMessage({ id: "workspace.publisher.subscriptions.description" })}
        action={
          <Button onClick={() => setCreating(true)} disabled={creating}>
            <Plus className="size-4" aria-hidden="true" />
            {intl.formatMessage({ id: "workspace.publisher.subscriptions.create" })}
          </Button>
        }
      >
        {creating ? (
          <form
            className="flex flex-col gap-3 rounded-sm border border-rule bg-paper p-4 sm:flex-row sm:items-end"
            onSubmit={(event) => {
              event.preventDefault();
              void subscriptionForm.handleSubmit();
            }}
          >
            <div className="min-w-0 flex-1 space-y-1.5">
              <Label htmlFor="subscription-name">
                {intl.formatMessage({ id: "workspace.publisher.subscriptions.name" })}
              </Label>
              <subscriptionForm.Field
                name="name"
                validators={{
                  onChange: ({ value }) => validateSubscriptionName(value),
                }}
              >
                {(field) => (
                  <Input
                    id="subscription-name"
                    name={field.name}
                    value={field.state.value}
                    maxLength={200}
                    autoFocus
                    required
                    onBlur={field.handleBlur}
                    onChange={(event) => field.handleChange(event.target.value)}
                  />
                )}
              </subscriptionForm.Field>
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  subscriptionForm.reset();
                  setCreating(false);
                }}
              >
                {intl.formatMessage({ id: "action.cancel" })}
              </Button>
              <subscriptionForm.Subscribe
                selector={(state) => [state.canSubmit, state.values.name] as const}
              >
                {([canSubmit, name]) => (
                  <Button
                    type="submit"
                    disabled={create.isPending || !canSubmit || name.trim() === ""}
                  >
                    {intl.formatMessage({ id: "action.create" })}
                  </Button>
                )}
              </subscriptionForm.Subscribe>
            </div>
          </form>
        ) : null}
        {create.isError ? (
          <WorkspaceState
            tone="danger"
            title={intl.formatMessage({ id: "workspace.actionFailed" })}
            body={workspaceErrorLabel(intl, create.error)}
          />
        ) : subscriptions.isLoading ? (
          <WorkspaceState title={intl.formatMessage({ id: "workspace.loading" })} />
        ) : subscriptions.isError ? (
          <WorkspaceState
            tone="danger"
            title={intl.formatMessage({ id: "workspace.unavailable" })}
            action={
              <Button
                variant="outline"
                onClick={() => void subscriptionsCollection.utils.clearError()}
              >
                {intl.formatMessage({ id: "action.retry" })}
              </Button>
            }
          />
        ) : subscriptions.data.length === 0 ? (
          <WorkspaceState
            title={intl.formatMessage({ id: "workspace.publisher.subscriptions.empty" })}
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>
                  {intl.formatMessage({ id: "workspace.publisher.subscriptions.name" })}
                </TableHead>
                <TableHead>{intl.formatMessage({ id: "workspace.status" })}</TableHead>
                <TableHead className="text-right">
                  {intl.formatMessage({ id: "workspace.updated" })}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {subscriptions.data.map((subscription) => (
                <TableRow key={subscription.id}>
                  <TableCell className="font-medium">
                    <a
                      className="text-ink hover:text-accent"
                      href={`/${locale}/publisher/${encodeURIComponent(companyId)}/subscriptions/${encodeURIComponent(subscription.id)}`}
                    >
                      {subscription.name}
                    </a>
                  </TableCell>
                  <TableCell>
                    <StateBadge
                      state={subscription.deliveryEnabled ? "positive" : "paused"}
                      label={intl.formatMessage({
                        id: subscription.deliveryEnabled
                          ? "workspace.delivery.enabled"
                          : "workspace.delivery.disabled",
                      })}
                    />
                  </TableCell>
                  <TableCell className="text-right font-mono text-[11px] text-faint">
                    {formatDate(subscription.updatedAt, locale)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </WorkspaceSection>
    </WorkspacePage>
  );
}

export function PublisherSubscriptionPage({
  companyId,
  subscriptionId,
}: {
  readonly companyId: string;
  readonly subscriptionId: string;
}) {
  const intl = useIntl();
  const locale = useLocale();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [historical, setHistorical] = useState(false);
  const [publicationAt, setPublicationAt] = useState("");
  const [invitingClient, setInvitingClient] = useState(false);
  const [clientCompanyName, setClientCompanyName] = useState("");
  const [clientAdminEmail, setClientAdminEmail] = useState("");
  const issues = useLiveQuery(publisherIssueCollection(subscriptionId));
  const clientAccesses = useLiveQuery(publisherClientAccessCollection(subscriptionId));
  const pullMetrics = useQuery({
    queryKey: ["publisher-ai-pull-metrics", subscriptionId],
    queryFn: () => getPublisherAiPullMetrics(subscriptionId),
  });
  const create = useMutation({
    mutationFn: () =>
      createPublisherIssue(subscriptionId, {
        title: title.trim(),
        historical,
        publicationAt: publicationAt === "" ? null : new Date(publicationAt).toISOString(),
      }),
    onSuccess: (issue) => {
      setCreating(false);
      setTitle("");
      setHistorical(false);
      setPublicationAt("");
      void queryClient.invalidateQueries({ queryKey: ["publisher-issues", subscriptionId] });
      window.location.assign(
        `/${locale}/publisher/${encodeURIComponent(companyId)}/issues/${encodeURIComponent(issue.id)}`,
      );
    },
  });
  const inviteClient = useMutation({
    mutationFn: () =>
      invitePublisherClientAccess(subscriptionId, {
        clientCompanyName: clientCompanyName.trim(),
        firstAdminEmail: clientAdminEmail.trim().toLowerCase(),
        idempotencyKey: `publisher-client-invite:${crypto.randomUUID()}`,
      }),
    onSuccess: () => {
      setInvitingClient(false);
      setClientCompanyName("");
      setClientAdminEmail("");
      void queryClient.invalidateQueries({
        queryKey: ["publisher-client-accesses", subscriptionId],
      });
    },
  });

  return (
    <WorkspacePage
      eyebrow={intl.formatMessage({ id: "workspace.publisher.eyebrow" })}
      title={intl.formatMessage({ id: "workspace.publisher.title" })}
      navigation={publisherNavigation(companyId, "subscriptions", (id) =>
        intl.formatMessage({ id }),
      )}
    >
      <div className="space-y-9">
        <WorkspaceSection
          title={intl.formatMessage({ id: "workspace.publisher.issues.title" })}
          description={intl.formatMessage({ id: "workspace.publisher.issues.description" })}
          action={
            <Button onClick={() => setCreating(true)} disabled={creating}>
              <Plus className="size-4" aria-hidden="true" />
              {intl.formatMessage({ id: "workspace.publisher.issues.create" })}
            </Button>
          }
        >
          {creating ? (
            <form
              className="grid gap-4 rounded-sm border border-rule bg-paper p-4 sm:grid-cols-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (title.trim() !== "" && (!historical || publicationAt !== "")) create.mutate();
              }}
            >
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="issue-title">
                  {intl.formatMessage({ id: "workspace.publisher.issues.issueTitle" })}
                </Label>
                <Input
                  id="issue-title"
                  value={title}
                  maxLength={300}
                  required
                  autoFocus
                  onChange={(event) => setTitle(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="publication-at">
                  {intl.formatMessage({ id: "workspace.publisher.issues.publicationAt" })}
                </Label>
                <Input
                  id="publication-at"
                  type="datetime-local"
                  value={publicationAt}
                  required={historical}
                  onChange={(event) => setPublicationAt(event.target.value)}
                />
              </div>
              <label className="flex items-center gap-2 self-end pb-2 text-sm text-muted">
                <input
                  type="checkbox"
                  checked={historical}
                  onChange={(event) => setHistorical(event.target.checked)}
                />
                {intl.formatMessage({ id: "workspace.publisher.issues.historical" })}
              </label>
              <div className="flex justify-end gap-2 sm:col-span-2">
                <Button type="button" variant="ghost" onClick={() => setCreating(false)}>
                  {intl.formatMessage({ id: "action.cancel" })}
                </Button>
                <Button
                  type="submit"
                  disabled={
                    create.isPending || title.trim() === "" || (historical && publicationAt === "")
                  }
                >
                  {intl.formatMessage({ id: "action.create" })}
                </Button>
              </div>
            </form>
          ) : null}
          {create.isError ? (
            <WorkspaceState
              tone="danger"
              title={intl.formatMessage({ id: "workspace.actionFailed" })}
              body={workspaceErrorLabel(intl, create.error)}
            />
          ) : issues.isLoading ? (
            <WorkspaceState title={intl.formatMessage({ id: "workspace.loading" })} />
          ) : issues.isError ? (
            <WorkspaceState
              tone="danger"
              title={intl.formatMessage({ id: "workspace.unavailable" })}
            />
          ) : issues.data.length === 0 ? (
            <WorkspaceState
              title={intl.formatMessage({ id: "workspace.publisher.issues.empty" })}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{intl.formatMessage({ id: "column.title" })}</TableHead>
                  <TableHead>{intl.formatMessage({ id: "workspace.status" })}</TableHead>
                  <TableHead>{intl.formatMessage({ id: "workspace.indexing" })}</TableHead>
                  <TableHead className="text-right">
                    {intl.formatMessage({ id: "column.date" })}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {issues.data.map((issue) => (
                  <TableRow key={issue.id}>
                    <TableCell className="font-medium">
                      <a
                        className="text-ink hover:text-accent"
                        href={`/${locale}/publisher/${encodeURIComponent(companyId)}/issues/${encodeURIComponent(issue.id)}`}
                      >
                        {issue.title}
                      </a>
                      {issue.historical ? (
                        <span className="ml-2 text-xs text-faint">
                          {intl.formatMessage({ id: "workspace.publisher.issues.historicalShort" })}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <StateBadge
                        state={issueState(issue)}
                        label={intl.formatMessage({ id: `workspace.issueStatus.${issue.status}` })}
                      />
                    </TableCell>
                    <TableCell className="text-sm text-muted">
                      {intl.formatMessage({
                        id: `workspace.indexingStatus.${issue.indexingStatus}`,
                      })}
                    </TableCell>
                    <TableCell className="text-right font-mono text-[11px] text-faint">
                      {formatDate(issue.publicationAt, locale)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </WorkspaceSection>

        <WorkspaceSection
          title={intl.formatMessage({ id: "workspace.publisher.clients.title" })}
          description={intl.formatMessage({ id: "workspace.publisher.clients.description" })}
          action={
            <Button onClick={() => setInvitingClient(true)} disabled={invitingClient}>
              <Plus className="size-4" aria-hidden="true" />
              {intl.formatMessage({ id: "workspace.publisher.clients.invite" })}
            </Button>
          }
        >
          {invitingClient ? (
            <form
              className="grid gap-4 rounded-sm border border-rule bg-paper p-4 sm:grid-cols-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (clientCompanyName.trim() !== "" && clientAdminEmail.trim() !== "") {
                  inviteClient.mutate();
                }
              }}
            >
              <div className="space-y-1.5">
                <Label htmlFor="client-company-name">
                  {intl.formatMessage({ id: "workspace.publisher.clients.companyName" })}
                </Label>
                <Input
                  id="client-company-name"
                  value={clientCompanyName}
                  maxLength={200}
                  required
                  onChange={(event) => setClientCompanyName(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="client-admin-email">
                  {intl.formatMessage({ id: "workspace.publisher.clients.adminEmail" })}
                </Label>
                <Input
                  id="client-admin-email"
                  type="email"
                  value={clientAdminEmail}
                  maxLength={320}
                  required
                  onChange={(event) => setClientAdminEmail(event.target.value)}
                />
              </div>
              <div className="flex justify-end gap-2 sm:col-span-2">
                <Button type="button" variant="ghost" onClick={() => setInvitingClient(false)}>
                  {intl.formatMessage({ id: "action.cancel" })}
                </Button>
                <Button
                  type="submit"
                  disabled={
                    inviteClient.isPending ||
                    clientCompanyName.trim() === "" ||
                    clientAdminEmail.trim() === ""
                  }
                >
                  {intl.formatMessage({ id: "workspace.publisher.clients.send" })}
                </Button>
              </div>
            </form>
          ) : null}
          {inviteClient.isError ? (
            <WorkspaceState
              tone="danger"
              title={intl.formatMessage({ id: "workspace.actionFailed" })}
              body={workspaceErrorLabel(intl, inviteClient.error)}
            />
          ) : clientAccesses.isLoading ? (
            <WorkspaceState title={intl.formatMessage({ id: "workspace.loading" })} />
          ) : clientAccesses.isError ? (
            <WorkspaceState
              tone="danger"
              title={intl.formatMessage({ id: "workspace.unavailable" })}
            />
          ) : clientAccesses.data.length === 0 ? (
            <WorkspaceState
              title={intl.formatMessage({ id: "workspace.publisher.clients.empty" })}
            />
          ) : (
            <div className="space-y-3">
              {clientAccesses.data.map((access) => (
                <PublisherClientAccessRow
                  key={access.id}
                  access={access}
                  locale={locale}
                  onUpdated={() =>
                    queryClient.invalidateQueries({
                      queryKey: ["publisher-client-accesses", subscriptionId],
                    })
                  }
                />
              ))}
            </div>
          )}
        </WorkspaceSection>

        <WorkspaceSection
          title={intl.formatMessage({ id: "workspace.publisher.metrics.title" })}
          description={intl.formatMessage({ id: "workspace.publisher.metrics.description" })}
        >
          {pullMetrics.isPending ? (
            <WorkspaceState title={intl.formatMessage({ id: "workspace.loading" })} />
          ) : pullMetrics.isError ? (
            <WorkspaceState
              tone="danger"
              title={intl.formatMessage({ id: "workspace.unavailable" })}
            />
          ) : pullMetrics.data.metrics.length === 0 ? (
            <WorkspaceState
              title={intl.formatMessage({ id: "workspace.publisher.metrics.empty" })}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>
                    {intl.formatMessage({ id: "workspace.publisher.metrics.issue" })}
                  </TableHead>
                  <TableHead>
                    {intl.formatMessage({ id: "workspace.publisher.metrics.document" })}
                  </TableHead>
                  <TableHead className="text-right">
                    {intl.formatMessage({ id: "workspace.publisher.metrics.runs" })}
                  </TableHead>
                  <TableHead className="text-right">
                    {intl.formatMessage({ id: "workspace.publisher.metrics.issueRuns" })}
                  </TableHead>
                  <TableHead className="text-right">
                    {intl.formatMessage({ id: "workspace.publisher.metrics.tokens" })}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pullMetrics.data.metrics.map((metric) => (
                  <TableRow key={`${metric.issueId}:${metric.documentId ?? "issue"}`}>
                    <TableCell className="font-mono text-xs">{metric.issueId}</TableCell>
                    <TableCell className="font-mono text-xs">{metric.documentId ?? "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">{metric.runPullCount}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {pullMetrics.data.issueTotals.find(
                        (total) => total.issueId === metric.issueId,
                      )?.runPullCount ?? 0}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {metric.visibleTokenCount}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </WorkspaceSection>
      </div>
    </WorkspacePage>
  );
}

function PublisherClientAccessRow({
  access,
  locale,
  onUpdated,
}: {
  readonly access: PublisherSubscriptionClientAccess;
  readonly locale: string;
  readonly onUpdated: () => Promise<unknown>;
}) {
  const intl = useIntl();
  const [pausing, setPausing] = useState(false);
  const [deliveryEndAt, setDeliveryEndAt] = useState("");
  const pause = useMutation({
    mutationFn: () =>
      pausePublisherClientAccess(
        access.id,
        deliveryEndAt === "" ? null : new Date(deliveryEndAt).toISOString(),
      ),
    onSuccess: () => {
      setPausing(false);
      void onUpdated();
    },
  });
  return (
    <article className="rounded-sm border border-rule bg-paper p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-ink">{access.clientCompanyName}</p>
          <p className="mt-1 text-xs text-muted">{access.firstAdminEmail}</p>
          <p className="mt-1 text-xs text-muted">
            {intl.formatMessage(
              { id: "workspace.publisher.clients.employees" },
              { count: access.employeeCount },
            )}
            {" · "}
            {intl.formatMessage(
              { id: "workspace.publisher.clients.subscribed" },
              { date: formatDate(access.subscribedAt ?? access.invitedAt, locale) },
            )}
          </p>
        </div>
        <StateBadge
          state={
            access.state === "active"
              ? "positive"
              : access.state === "ending" || access.state === "invited"
                ? "pending"
                : "paused"
          }
          label={workspaceStateLabel(intl, access.state)}
        />
      </div>
      {access.deliveryEndAt ? (
        <p className="mt-3 text-xs text-muted">
          {intl.formatMessage(
            { id: "workspace.publisher.clients.deliveryEnds" },
            { date: formatDate(access.deliveryEndAt, locale) },
          )}
        </p>
      ) : null}
      {access.state === "active" ? (
        pausing ? (
          <div className="mt-4 space-y-3 border-t border-rule pt-4">
            <div className="space-y-1.5">
              <Label htmlFor={`pause-${access.id}`}>
                {intl.formatMessage({ id: "workspace.publisher.clients.pauseDate" })}
              </Label>
              <Input
                id={`pause-${access.id}`}
                type="datetime-local"
                value={deliveryEndAt}
                onChange={(event) => setDeliveryEndAt(event.target.value)}
              />
              <p className="text-xs text-muted">
                {intl.formatMessage({ id: "workspace.publisher.clients.pauseDateHelp" })}
              </p>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setPausing(false)}>
                {intl.formatMessage({ id: "action.cancel" })}
              </Button>
              <Button variant="outline" disabled={pause.isPending} onClick={() => pause.mutate()}>
                {intl.formatMessage({ id: "workspace.publisher.clients.confirmPause" })}
              </Button>
            </div>
          </div>
        ) : (
          <Button className="mt-3" size="sm" variant="outline" onClick={() => setPausing(true)}>
            {intl.formatMessage({ id: "workspace.publisher.clients.pause" })}
          </Button>
        )
      ) : null}
      {pause.isError ? (
        <WorkspaceState
          tone="danger"
          title={intl.formatMessage({ id: "workspace.actionFailed" })}
          body={workspaceErrorLabel(intl, pause.error)}
        />
      ) : null}
    </article>
  );
}

export function publisherNavigation(
  companyId: string,
  active: "subscriptions" | "team" | "settings",
  format: (id: string) => string,
) {
  return [
    {
      href: `/publisher/${companyId}`,
      label: format("workspace.nav.subscriptions"),
      active: active === "subscriptions",
    },
    {
      href: `/publisher/${companyId}/team`,
      label: format("workspace.nav.team"),
      active: active === "team",
    },
    {
      href: `/publisher/${companyId}/settings`,
      label: format("workspace.nav.settings"),
      active: active === "settings",
    },
  ];
}
