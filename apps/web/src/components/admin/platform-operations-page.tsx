import { useIntl, useLocale } from "@brief/i18n";
import type { RestrictedSupportScopeKind } from "@brief/shared";
import { Button, Input, Label, Textarea } from "@brief/ui";
import { useForm } from "@tanstack/react-form";
import { useLiveQuery } from "@tanstack/react-db";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { useState } from "react";

import {
  MetricGrid,
  StateBadge,
  WorkspacePage,
  WorkspaceSection,
  WorkspaceState,
} from "@/components/layout/workspace-page";
import {
  activeSupportGrantCollection,
  companyDeletionCollection,
  platformIssueCollection,
  platformSummaryCollection,
  restrictedAccessCollection,
} from "@/lib/db";
import { validateEmailAddress, validatePublisherOnboarding } from "@/lib/form-validation";
import {
  createRestrictedSupportGrant,
  createPublisherCompanyOnboarding,
  openRestrictedSupportGrantContent,
  removePlatformIssueRestriction,
  restrictPlatformIssue,
  reviewRestrictedSupportAccess,
  resolvePlatformCompanyDeletionRequest,
} from "@/lib/platform-api";
import {
  workspaceErrorLabel,
  workspaceRoleLabel,
  workspaceScopeLabel,
  workspaceStateLabel,
} from "@/lib/workspace-labels";

const formatNumber = (value: number, locale: string): string =>
  new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value);

const formatDate = (value: string, locale: string): string =>
  new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );

export function PlatformOperationsPage() {
  const intl = useIntl();
  const locale = useLocale();
  const queryClient = useQueryClient();
  const summary = useLiveQuery(platformSummaryCollection());
  const issues = useLiveQuery(platformIssueCollection());
  const operationsData = summary.data[0]
    ? { ...summary.data[0], publishedIssues: issues.data }
    : undefined;
  const operations = {
    data: operationsData!,
    isPending: summary.isLoading || issues.isLoading,
    isError: summary.isError || issues.isError,
  };
  const accesses = useLiveQuery(restrictedAccessCollection());
  const mayReviewDeletion = operationsData?.role === "admin" || operationsData?.role === "legal";
  const deletionRequests = useLiveQuery(
    (query) =>
      mayReviewDeletion ? query.from({ request: companyDeletionCollection() }) : undefined,
    [mayReviewDeletion],
  );
  const deletionRows = deletionRequests.data ?? [];
  const [reviewTarget, setReviewTarget] = useState<string | null>(null);
  const [reviewNotes, setReviewNotes] = useState("");
  const [restrictionTarget, setRestrictionTarget] = useState<string | null>(null);
  const [restrictionReason, setRestrictionReason] = useState("");
  const review = useMutation({
    mutationFn: (input: { readonly id: string; readonly decision: "approved" | "flagged" }) =>
      reviewRestrictedSupportAccess(input.id, { decision: input.decision, notes: reviewNotes }),
    onSuccess: () => {
      setReviewTarget(null);
      setReviewNotes("");
      void queryClient.invalidateQueries({ queryKey: ["restricted-support-access"] });
    },
  });
  const restriction = useMutation({
    mutationFn: (input: { readonly issueId: string; readonly restricted: boolean }) =>
      input.restricted
        ? removePlatformIssueRestriction(input.issueId)
        : restrictPlatformIssue(input.issueId, restrictionReason.trim()),
    onSuccess: () => {
      setRestrictionTarget(null);
      setRestrictionReason("");
      void queryClient.invalidateQueries({ queryKey: ["platform-operations"] });
    },
  });
  const onboardPublisher = useMutation({
    mutationFn: (input: { readonly companyName: string; readonly firstAdminEmail: string }) =>
      createPublisherCompanyOnboarding({
        companyName: input.companyName,
        firstAdminEmail: input.firstAdminEmail,
        idempotencyKey: `publisher-onboarding:${crypto.randomUUID()}`,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["platform-operations"] });
    },
  });
  const onboardingForm = useForm({
    defaultValues: { companyName: "", firstAdminEmail: "" },
    validators: {
      onSubmit: ({ value }) => validatePublisherOnboarding(value),
    },
    onSubmit: async ({ value }) => {
      await onboardPublisher.mutateAsync({
        companyName: value.companyName.trim(),
        firstAdminEmail: value.firstAdminEmail.trim().toLowerCase(),
      });
      onboardingForm.reset();
    },
  });
  const resolveDeletion = useMutation({
    mutationFn: (input: {
      readonly requestId: string;
      readonly decision: "approved" | "rejected";
    }) =>
      resolvePlatformCompanyDeletionRequest(input.requestId, {
        decision: input.decision,
        idempotencyKey: `company-deletion-decision:${crypto.randomUUID()}`,
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["platform-company-deletion-requests"] }),
  });

  return (
    <WorkspacePage
      eyebrow={intl.formatMessage({ id: "workspace.admin.eyebrow" })}
      title={intl.formatMessage({ id: "workspace.admin.title" })}
      navigation={[
        {
          href: "/platform",
          label: intl.formatMessage({ id: "workspace.nav.overview" }),
          active: true,
        },
        {
          href: "/platform/support",
          label: intl.formatMessage({ id: "workspace.nav.support" }),
        },
      ]}
    >
      <div className="space-y-9">
        <WorkspaceSection
          title={intl.formatMessage({ id: "workspace.admin.overview.title" })}
          description={intl.formatMessage({ id: "workspace.admin.overview.description" })}
        >
          {operations.isPending ? (
            <WorkspaceState title={intl.formatMessage({ id: "workspace.loading" })} />
          ) : operations.isError ? (
            <WorkspaceState
              tone="danger"
              title={intl.formatMessage({ id: "workspace.unavailable" })}
            />
          ) : (
            <>
              <p className="text-sm text-muted">
                {intl.formatMessage(
                  { id: "workspace.admin.role" },
                  { role: workspaceRoleLabel(intl, operations.data.role) },
                )}
              </p>
              <MetricGrid
                metrics={[
                  {
                    label: intl.formatMessage({ id: "workspace.admin.publisherCompanies" }),
                    value: formatNumber(operations.data.overview.publisherCompanies, locale),
                  },
                  {
                    label: intl.formatMessage({ id: "workspace.admin.clientCompanies" }),
                    value: formatNumber(operations.data.overview.clientCompanies, locale),
                  },
                  {
                    label: intl.formatMessage({ id: "workspace.admin.currentAccesses" }),
                    value: formatNumber(operations.data.overview.currentAccesses, locale),
                  },
                  {
                    label: intl.formatMessage({ id: "workspace.admin.notificationFailures" }),
                    value: formatNumber(operations.data.overview.notificationFailures, locale),
                  },
                  {
                    label: intl.formatMessage({ id: "workspace.admin.aiRuns" }),
                    value: formatNumber(operations.data.overview.aiRuns, locale),
                  },
                  {
                    label: intl.formatMessage({ id: "workspace.admin.webOperations" }),
                    value: formatNumber(operations.data.overview.webOperations, locale),
                  },
                  {
                    label: intl.formatMessage({ id: "workspace.admin.inputTokens" }),
                    value: formatNumber(operations.data.overview.modelInputTokens, locale),
                  },
                  {
                    label: intl.formatMessage({ id: "workspace.admin.credits" }),
                    value: formatNumber(operations.data.overview.creditsConsumed, locale),
                  },
                ]}
              />
            </>
          )}
        </WorkspaceSection>

        {operations.data?.role === "admin" ? (
          <WorkspaceSection
            title={intl.formatMessage({ id: "workspace.admin.publisherOnboarding.title" })}
            description={intl.formatMessage({
              id: "workspace.admin.publisherOnboarding.description",
            })}
          >
            <form
              className="grid gap-4 rounded-sm border border-rule bg-paper p-5 sm:grid-cols-2"
              onSubmit={(event) => {
                event.preventDefault();
                void onboardingForm.handleSubmit();
              }}
            >
              <onboardingForm.Field
                name="companyName"
                validators={{
                  onChange: ({ value }) =>
                    value.trim().length > 0 && value.trim().length <= 200
                      ? undefined
                      : "publisher_company_name_invalid",
                }}
              >
                {(field) => (
                  <Field
                    id="publisher-onboarding-name"
                    label={intl.formatMessage({ id: "workspace.admin.publisherOnboarding.name" })}
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={field.handleChange}
                  />
                )}
              </onboardingForm.Field>
              <onboardingForm.Field
                name="firstAdminEmail"
                validators={{ onChange: ({ value }) => validateEmailAddress(value) }}
              >
                {(field) => (
                  <Field
                    id="publisher-onboarding-email"
                    label={intl.formatMessage({ id: "workspace.admin.publisherOnboarding.email" })}
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={field.handleChange}
                    type="email"
                  />
                )}
              </onboardingForm.Field>
              <div className="flex justify-end sm:col-span-2">
                <onboardingForm.Subscribe selector={(state) => state.canSubmit}>
                  {(canSubmit) => (
                    <Button type="submit" disabled={onboardPublisher.isPending || !canSubmit}>
                      {intl.formatMessage({ id: "workspace.admin.publisherOnboarding.create" })}
                    </Button>
                  )}
                </onboardingForm.Subscribe>
              </div>
            </form>
            {onboardPublisher.data ? (
              <WorkspaceState
                title={intl.formatMessage({ id: "workspace.admin.publisherOnboarding.created" })}
                body={`${onboardPublisher.data.companyName} · ${workspaceStateLabel(intl, onboardPublisher.data.invitationState)}`}
              />
            ) : null}
            {onboardPublisher.isError ? (
              <WorkspaceState
                tone="danger"
                title={intl.formatMessage({ id: "workspace.actionFailed" })}
                body={workspaceErrorLabel(intl, onboardPublisher.error)}
              />
            ) : null}
          </WorkspaceSection>
        ) : null}

        {operations.data?.role === "admin" || operations.data?.role === "legal" ? (
          <WorkspaceSection
            title={intl.formatMessage({ id: "workspace.admin.deletion.title" })}
            description={intl.formatMessage({ id: "workspace.admin.deletion.description" })}
          >
            {deletionRequests.isLoading ? (
              <WorkspaceState title={intl.formatMessage({ id: "workspace.loading" })} />
            ) : deletionRequests.isError ? (
              <WorkspaceState
                tone="danger"
                title={intl.formatMessage({ id: "workspace.unavailable" })}
              />
            ) : deletionRows.length === 0 ? (
              <WorkspaceState
                title={intl.formatMessage({ id: "workspace.admin.deletion.empty" })}
              />
            ) : (
              <div className="divide-y divide-rule rounded-sm border border-rule bg-paper">
                {deletionRows.map((deletion) => (
                  <article key={deletion.id} className="p-4">
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div>
                        <p className="font-medium text-ink">{deletion.clientCompanyName}</p>
                        <p className="mt-1 font-mono text-xs text-faint">
                          {deletion.clientCompanyId}
                        </p>
                        <p className="mt-2 text-sm text-muted">{deletion.reason}</p>
                        <p className="mt-1 text-xs text-muted">
                          {formatDate(deletion.requestedAt, locale)} · {deletion.requestedByUserId}
                        </p>
                      </div>
                      <StateBadge
                        state={
                          deletion.status === "requested"
                            ? "pending"
                            : deletion.status === "rejected"
                              ? "failed"
                              : "positive"
                        }
                        label={workspaceStateLabel(intl, deletion.status)}
                      />
                    </div>
                    {deletion.status === "requested" ? (
                      <div className="mt-4 flex justify-end gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={resolveDeletion.isPending}
                          onClick={() =>
                            resolveDeletion.mutate({ requestId: deletion.id, decision: "rejected" })
                          }
                        >
                          {intl.formatMessage({ id: "workspace.admin.deletion.reject" })}
                        </Button>
                        <Button
                          size="sm"
                          disabled={resolveDeletion.isPending}
                          onClick={() =>
                            resolveDeletion.mutate({ requestId: deletion.id, decision: "approved" })
                          }
                        >
                          {intl.formatMessage({ id: "workspace.admin.deletion.approve" })}
                        </Button>
                      </div>
                    ) : null}
                  </article>
                ))}
              </div>
            )}
            {resolveDeletion.isError ? (
              <WorkspaceState
                tone="danger"
                title={intl.formatMessage({ id: "workspace.actionFailed" })}
                body={workspaceErrorLabel(intl, resolveDeletion.error)}
              />
            ) : null}
          </WorkspaceSection>
        ) : null}

        <WorkspaceSection
          title={intl.formatMessage({ id: "workspace.admin.issues.title" })}
          description={intl.formatMessage({ id: "workspace.admin.issues.description" })}
        >
          {operations.isPending ? (
            <WorkspaceState title={intl.formatMessage({ id: "workspace.loading" })} />
          ) : operations.isError ? (
            <WorkspaceState
              tone="danger"
              title={intl.formatMessage({ id: "workspace.unavailable" })}
            />
          ) : operations.data.publishedIssues.length === 0 ? (
            <WorkspaceState title={intl.formatMessage({ id: "workspace.admin.issues.empty" })} />
          ) : (
            <div className="divide-y divide-rule rounded-sm border border-rule bg-paper">
              {operations.data.publishedIssues.map((issue) => (
                <article key={issue.issueId} className="p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="font-mono text-xs text-ink">{issue.issueId}</p>
                      <p className="mt-1 font-mono text-[11px] text-faint">
                        {issue.publisherCompanyId} · {issue.subscriptionId}
                      </p>
                      <p className="mt-1 text-xs text-muted">
                        {formatDate(issue.publishedAt, locale)} ·{" "}
                        {workspaceStateLabel(intl, issue.indexingStatus)}
                        {issue.indexingErrorCode
                          ? ` · ${intl.formatMessage({ id: "workspace.state.failed" })}`
                          : ""}
                      </p>
                    </div>
                    <StateBadge
                      state={issue.restrictedAt === null ? "neutral" : "failed"}
                      label={intl.formatMessage({
                        id:
                          issue.restrictedAt === null
                            ? "workspace.admin.issues.available"
                            : "workspace.admin.issues.restricted",
                      })}
                    />
                  </div>
                  {issue.restrictedAt !== null ? (
                    <div className="mt-3 text-xs text-muted">
                      <p>{formatDate(issue.restrictedAt, locale)}</p>
                      {issue.restrictedReason ? (
                        <p className="mt-1">{issue.restrictedReason}</p>
                      ) : null}
                    </div>
                  ) : null}
                  {["admin", "security", "legal"].includes(operations.data.role) ? (
                    restrictionTarget === issue.issueId ? (
                      <div className="mt-4 space-y-3 border-t border-rule pt-4">
                        {issue.restrictedAt === null ? (
                          <>
                            <Label htmlFor={`restriction-${issue.issueId}`}>
                              {intl.formatMessage({ id: "workspace.admin.issues.reason" })}
                            </Label>
                            <Textarea
                              id={`restriction-${issue.issueId}`}
                              minLength={8}
                              maxLength={2000}
                              value={restrictionReason}
                              onChange={(event) => setRestrictionReason(event.target.value)}
                            />
                          </>
                        ) : null}
                        <div className="flex justify-end gap-2">
                          <Button variant="ghost" onClick={() => setRestrictionTarget(null)}>
                            {intl.formatMessage({ id: "action.cancel" })}
                          </Button>
                          <Button
                            variant={issue.restrictedAt === null ? "outline" : "default"}
                            disabled={
                              restriction.isPending ||
                              (issue.restrictedAt === null && restrictionReason.trim().length < 8)
                            }
                            onClick={() =>
                              restriction.mutate({
                                issueId: issue.issueId,
                                restricted: issue.restrictedAt !== null,
                              })
                            }
                          >
                            {intl.formatMessage({
                              id:
                                issue.restrictedAt === null
                                  ? "workspace.admin.issues.restrict"
                                  : "workspace.admin.issues.restore",
                            })}
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <Button
                        className="mt-3"
                        size="sm"
                        variant="outline"
                        onClick={() => setRestrictionTarget(issue.issueId)}
                      >
                        {intl.formatMessage({
                          id:
                            issue.restrictedAt === null
                              ? "workspace.admin.issues.restrict"
                              : "workspace.admin.issues.restore",
                        })}
                      </Button>
                    )
                  ) : null}
                </article>
              ))}
            </div>
          )}
          {restriction.isError ? (
            <WorkspaceState
              tone="danger"
              title={intl.formatMessage({ id: "workspace.actionFailed" })}
            />
          ) : null}
        </WorkspaceSection>

        <WorkspaceSection
          title={intl.formatMessage({ id: "workspace.admin.accessReview.title" })}
          description={intl.formatMessage({ id: "workspace.admin.accessReview.description" })}
        >
          {accesses.isLoading ? (
            <WorkspaceState title={intl.formatMessage({ id: "workspace.loading" })} />
          ) : accesses.isError ? (
            <WorkspaceState
              tone="danger"
              title={intl.formatMessage({ id: "workspace.unavailable" })}
            />
          ) : accesses.data.length === 0 ? (
            <WorkspaceState
              title={intl.formatMessage({ id: "workspace.admin.accessReview.empty" })}
            />
          ) : (
            <div className="divide-y divide-rule rounded-sm border border-rule bg-paper">
              {accesses.data.map((access) => (
                <article key={access.id} className="p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium text-ink">
                        {workspaceScopeLabel(intl, access.scopeKind)} · {access.scopeId}
                      </p>
                      <p className="mt-1 font-mono text-[11px] text-faint">
                        {access.actorUserId} · {formatDate(access.accessedAt, locale)}
                      </p>
                    </div>
                    <StateBadge
                      state={access.reviewDecision === "flagged" ? "failed" : "neutral"}
                      label={
                        (access.reviewDecision
                          ? workspaceStateLabel(intl, access.reviewDecision)
                          : null) ??
                        intl.formatMessage({ id: "workspace.admin.accessReview.pending" })
                      }
                    />
                  </div>
                  {access.reviewDecision === null ? (
                    reviewTarget === access.id ? (
                      <div className="mt-4 space-y-3 border-t border-rule pt-4">
                        <Label htmlFor={`review-${access.id}`}>
                          {intl.formatMessage({ id: "workspace.admin.accessReview.notes" })}
                        </Label>
                        <Textarea
                          id={`review-${access.id}`}
                          value={reviewNotes}
                          minLength={4}
                          maxLength={2000}
                          onChange={(event) => setReviewNotes(event.target.value)}
                        />
                        <div className="flex justify-end gap-2">
                          <Button variant="ghost" onClick={() => setReviewTarget(null)}>
                            {intl.formatMessage({ id: "action.cancel" })}
                          </Button>
                          <Button
                            variant="outline"
                            disabled={reviewNotes.trim().length < 4 || review.isPending}
                            onClick={() => review.mutate({ id: access.id, decision: "flagged" })}
                          >
                            {intl.formatMessage({ id: "workspace.admin.accessReview.flag" })}
                          </Button>
                          <Button
                            disabled={reviewNotes.trim().length < 4 || review.isPending}
                            onClick={() => review.mutate({ id: access.id, decision: "approved" })}
                          >
                            {intl.formatMessage({ id: "workspace.admin.accessReview.approve" })}
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <Button
                        className="mt-3"
                        size="sm"
                        variant="outline"
                        onClick={() => setReviewTarget(access.id)}
                      >
                        {intl.formatMessage({ id: "workspace.admin.accessReview.review" })}
                      </Button>
                    )
                  ) : null}
                </article>
              ))}
            </div>
          )}
        </WorkspaceSection>
      </div>
    </WorkspacePage>
  );
}

export function PlatformSupportPage() {
  const intl = useIntl();
  const locale = useLocale();
  const queryClient = useQueryClient();
  const [actorUserId, setActorUserId] = useState("");
  const [scopeKind, setScopeKind] = useState<RestrictedSupportScopeKind>("publisher_file");
  const [scopeId, setScopeId] = useState("");
  const [reason, setReason] = useState("");
  const [publisherCompanyId, setPublisherCompanyId] = useState("");
  const [clientCompanyId, setClientCompanyId] = useState("");
  const [affectedUserId, setAffectedUserId] = useState("");
  const [approval, setApproval] = useState("");
  const [skippedReason, setSkippedReason] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const grants = useLiveQuery(activeSupportGrantCollection());
  const create = useMutation({
    mutationFn: () =>
      createRestrictedSupportGrant({
        actorUserId: actorUserId.trim(),
        reason: reason.trim(),
        scopeKind,
        scopeId: scopeId.trim(),
        publisherCompanyId: publisherCompanyId.trim() || null,
        clientCompanyId: clientCompanyId.trim() || null,
        affectedUserId: affectedUserId.trim() || null,
        customerApprovalReference: approval.trim() || null,
        approvalSkippedReason: skippedReason.trim() || null,
        expiresAt: new Date(expiresAt).toISOString(),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["active-restricted-support-grants"] });
    },
  });
  const openContent = useMutation({
    mutationFn: openRestrictedSupportGrantContent,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["restricted-support-access"] });
    },
  });
  const approvalValid = (approval.trim() === "") !== (skippedReason.trim() === "");

  return (
    <WorkspacePage
      eyebrow={intl.formatMessage({ id: "workspace.admin.eyebrow" })}
      title={intl.formatMessage({ id: "workspace.admin.title" })}
      navigation={[
        { href: "/platform", label: intl.formatMessage({ id: "workspace.nav.overview" }) },
        {
          href: "/platform/support",
          label: intl.formatMessage({ id: "workspace.nav.support" }),
          active: true,
        },
      ]}
    >
      <div className="space-y-9">
        <WorkspaceSection
          title={intl.formatMessage({ id: "workspace.admin.grant.activeTitle" })}
          description={intl.formatMessage({ id: "workspace.admin.grant.activeDescription" })}
        >
          {grants.isLoading ? (
            <WorkspaceState title={intl.formatMessage({ id: "workspace.loading" })} />
          ) : grants.isError ? (
            <WorkspaceState
              tone="danger"
              title={intl.formatMessage({ id: "workspace.unavailable" })}
            />
          ) : grants.data.length === 0 ? (
            <WorkspaceState
              title={intl.formatMessage({ id: "workspace.admin.grant.activeEmpty" })}
            />
          ) : (
            <div className="divide-y divide-rule rounded-sm border border-rule bg-paper">
              {grants.data.map((grant) => (
                <article
                  key={grant.id}
                  className="flex flex-wrap items-start justify-between gap-4 p-4"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-ink">
                      {workspaceScopeLabel(intl, grant.scopeKind)} ·{" "}
                      <span className="font-mono text-xs">{grant.scopeId}</span>
                    </p>
                    <p className="mt-1 text-xs leading-5 text-muted">{grant.reason}</p>
                    <p className="mt-1 text-[11px] text-faint">
                      {intl.formatMessage(
                        { id: "workspace.admin.grant.activeExpiry" },
                        { date: formatDate(grant.expiresAt, locale) },
                      )}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={openContent.isPending}
                    onClick={() => openContent.mutate(grant.id)}
                  >
                    {intl.formatMessage({ id: "workspace.admin.grant.open" })}
                  </Button>
                </article>
              ))}
            </div>
          )}
          {openContent.isError ? (
            <WorkspaceState
              tone="danger"
              title={intl.formatMessage({ id: "workspace.actionFailed" })}
              body={workspaceErrorLabel(intl, openContent.error)}
            />
          ) : null}
        </WorkspaceSection>

        <WorkspaceSection
          title={intl.formatMessage({ id: "workspace.admin.grant.title" })}
          description={intl.formatMessage({ id: "workspace.admin.grant.description" })}
        >
          {create.data ? (
            <WorkspaceState
              title={intl.formatMessage({ id: "workspace.admin.grant.created" })}
              body={`${create.data.id} · ${create.data.expiresAt}`}
            />
          ) : null}
          {create.isError ? (
            <WorkspaceState
              tone="danger"
              title={intl.formatMessage({ id: "workspace.actionFailed" })}
              body={workspaceErrorLabel(intl, create.error)}
            />
          ) : null}
          <form
            className="grid gap-4 rounded-sm border border-rule bg-paper p-5 sm:grid-cols-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (approvalValid) create.mutate();
            }}
          >
            <Field
              id="support-actor"
              label={intl.formatMessage({ id: "workspace.admin.grant.actor" })}
              value={actorUserId}
              onChange={setActorUserId}
            />
            <div className="space-y-1.5">
              <Label htmlFor="support-kind">
                {intl.formatMessage({ id: "workspace.admin.grant.scopeKind" })}
              </Label>
              <select
                id="support-kind"
                value={scopeKind}
                className="h-9 w-full rounded-sm border border-input bg-canvas px-3 text-sm"
                onChange={(event) => setScopeKind(event.target.value as RestrictedSupportScopeKind)}
              >
                {(
                  ["publisher_file", "publisher_text", "client_chat", "client_memory"] as const
                ).map((kind) => (
                  <option key={kind} value={kind}>
                    {workspaceScopeLabel(intl, kind)}
                  </option>
                ))}
              </select>
            </div>
            <Field
              id="support-scope"
              label={intl.formatMessage({ id: "workspace.admin.grant.scopeId" })}
              value={scopeId}
              onChange={setScopeId}
            />
            <Field
              id="support-expiry"
              label={intl.formatMessage({ id: "workspace.admin.grant.expiresAt" })}
              value={expiresAt}
              onChange={setExpiresAt}
              type="datetime-local"
            />
            <Field
              id="support-publisher"
              label={intl.formatMessage({ id: "workspace.admin.grant.publisherCompany" })}
              value={publisherCompanyId}
              onChange={setPublisherCompanyId}
              required={false}
            />
            <Field
              id="support-client"
              label={intl.formatMessage({ id: "workspace.admin.grant.clientCompany" })}
              value={clientCompanyId}
              onChange={setClientCompanyId}
              required={false}
            />
            <Field
              id="support-user"
              label={intl.formatMessage({ id: "workspace.admin.grant.affectedUser" })}
              value={affectedUserId}
              onChange={setAffectedUserId}
              required={false}
            />
            <Field
              id="support-approval"
              label={intl.formatMessage({ id: "workspace.admin.grant.approval" })}
              value={approval}
              onChange={setApproval}
              required={false}
            />
            <Field
              id="support-skipped"
              label={intl.formatMessage({ id: "workspace.admin.grant.skippedReason" })}
              value={skippedReason}
              onChange={setSkippedReason}
              required={false}
            />
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="support-reason">
                {intl.formatMessage({ id: "workspace.admin.grant.reason" })}
              </Label>
              <Textarea
                id="support-reason"
                value={reason}
                minLength={8}
                maxLength={2000}
                required
                onChange={(event) => setReason(event.target.value)}
              />
            </div>
            <p className="text-xs leading-5 text-muted sm:col-span-2">
              {intl.formatMessage({ id: "workspace.admin.grant.approvalHelp" })}
            </p>
            <div className="flex justify-end sm:col-span-2">
              <Button
                type="submit"
                disabled={
                  create.isPending ||
                  actorUserId.trim() === "" ||
                  scopeId.trim() === "" ||
                  reason.trim().length < 8 ||
                  expiresAt === "" ||
                  !approvalValid
                }
              >
                <ShieldCheck className="size-4" aria-hidden="true" />
                {intl.formatMessage({ id: "workspace.admin.grant.create" })}
              </Button>
            </div>
          </form>
        </WorkspaceSection>
      </div>
    </WorkspacePage>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
  type = "text",
  required = true,
  onBlur,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly type?: string;
  readonly required?: boolean;
  readonly onBlur?: () => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={type}
        value={value}
        required={required}
        onBlur={onBlur}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}
