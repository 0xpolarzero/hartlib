import { useIntl, useLocale } from "@hartlib/i18n";
import { Button, Input, Label, Textarea } from "@hartlib/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CreditCard } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { clientNavigation } from "@/components/client/client-archive-page";
import { useCurrentWorkspaces } from "@/components/layout/workspace-switcher";
import {
  MetricGrid,
  StateBadge,
  WorkspacePage,
  WorkspaceSection,
  WorkspaceState,
} from "@/components/layout/workspace-page";
import {
  createAiUsageRequest,
  createBillingCheckout,
  createBillingPortal,
  changeClientMonthlyPlan,
  getClientAiUsage,
  listClientArchive,
  resolveAiUsageRequest,
  updateCompanyAiLimit,
  updateEmployeeAiLimit,
} from "@/lib/platform-api";
import { memberAiUsageIsLimited } from "@/lib/billing-usage";
import { workspaceStateLabel } from "@/lib/workspace-labels";

const planTiers = ["light", "team", "intensive"] as const;
type PlanTier = (typeof planTiers)[number];

const formatNumber = (value: number, locale: string): string =>
  new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value);

const formatDate = (value: string | null, locale: string): string =>
  value === null
    ? "—"
    : new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(value));

export function ClientBillingPage({ companyId }: { readonly companyId: string }) {
  const intl = useIntl();
  const locale = useLocale();
  const queryClient = useQueryClient();
  const workspaces = useCurrentWorkspaces();
  const isAdmin =
    workspaces.data?.clientWorkspaces.find((workspace) => workspace.companyId === companyId)
      ?.role === "admin";
  const usage = useQuery({
    queryKey: ["client-ai-usage", companyId],
    queryFn: () => getClientAiUsage(companyId),
  });
  const archivePresence = useQuery({
    queryKey: ["client-archive-presence", companyId],
    queryFn: () => listClientArchive(companyId, { limit: 1 }),
  });
  const [planIndex, setPlanIndex] = useState(1);
  const [lastPlanChange, setLastPlanChange] = useState<Awaited<
    ReturnType<typeof changeClientMonthlyPlan>
  > | null>(null);
  const planChangeKeys = useRef(new Map<PlanTier, string>());
  const checkoutKeys = useRef(new Map<string, string>());
  const [additionalCredits, setAdditionalCredits] = useState(1_000);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["client-ai-usage", companyId] });
  const checkout = useMutation({
    mutationFn: (
      input:
        | { readonly kind: "monthly"; readonly planTier: PlanTier }
        | { readonly kind: "additional"; readonly credits: number },
    ) => {
      const logicalKey =
        input.kind === "monthly" ? `monthly:${input.planTier}` : `additional:${input.credits}`;
      const idempotencyKey =
        checkoutKeys.current.get(logicalKey) ?? `checkout_${crypto.randomUUID()}`;
      checkoutKeys.current.set(logicalKey, idempotencyKey);
      return createBillingCheckout(companyId, { ...input, idempotencyKey });
    },
    onSuccess: (url) => window.location.assign(url),
  });
  const portal = useMutation({
    mutationFn: () => createBillingPortal(companyId),
    onSuccess: (url) => window.location.assign(url),
  });
  const planChange = useMutation({
    onMutate: () => setLastPlanChange(null),
    mutationFn: (planTier: PlanTier) => {
      const idempotencyKey = planChangeKeys.current.get(planTier) ?? `plan_${crypto.randomUUID()}`;
      planChangeKeys.current.set(planTier, idempotencyKey);
      return changeClientMonthlyPlan(companyId, { planTier, idempotencyKey });
    },
    onSuccess: (change, planTier) => {
      planChangeKeys.current.delete(planTier);
      setLastPlanChange(change);
      void refresh();
    },
  });
  const resolve = useMutation({
    mutationFn: (input: { readonly id: string; readonly decision: "approved" | "denied" }) =>
      resolveAiUsageRequest(companyId, input.id, input.decision),
    onSettled: refresh,
  });
  useEffect(() => {
    if (usage.data?.planTier !== null && usage.data?.planTier !== undefined) {
      setPlanIndex(planTiers.indexOf(usage.data.planTier));
    }
  }, [usage.data?.planTier]);

  return (
    <WorkspacePage
      eyebrow={intl.formatMessage({ id: "workspace.client.eyebrow" })}
      title={intl.formatMessage({ id: "workspace.billing.title" })}
      navigation={clientNavigation(companyId, "billing", (id) => intl.formatMessage({ id }))}
    >
      {usage.isPending ? (
        <WorkspaceState title={intl.formatMessage({ id: "workspace.loading" })} />
      ) : usage.isError ? (
        <WorkspaceState
          tone="danger"
          title={intl.formatMessage({ id: "workspace.unavailable" })}
          action={
            <Button variant="outline" onClick={() => void usage.refetch()}>
              {intl.formatMessage({ id: "action.retry" })}
            </Button>
          }
        />
      ) : (
        <div className="space-y-9">
          {archivePresence.isSuccess && archivePresence.data.items.length === 0 ? (
            <WorkspaceState
              title={intl.formatMessage({ id: "workspace.billing.noArchive.title" })}
              body={intl.formatMessage({ id: "workspace.billing.noArchive.body" })}
            />
          ) : null}
          <WorkspaceSection
            title={intl.formatMessage({ id: "workspace.billing.usage.title" })}
            description={intl.formatMessage({ id: "workspace.billing.usage.description" })}
          >
            <div className="flex flex-wrap items-center gap-3">
              <StateBadge
                state={["active", "trialing"].includes(usage.data.status) ? "positive" : "paused"}
                label={workspaceStateLabel(intl, usage.data.status)}
              />
              <span className="text-sm text-muted">
                {usage.data.planTier
                  ? intl.formatMessage({
                      id: `workspace.billing.plan.${usage.data.planTier}.title`,
                    })
                  : intl.formatMessage({ id: "workspace.billing.noPlan" })}
              </span>
              {usage.data.periodEnd ? (
                <span className="font-mono text-[11px] text-faint">
                  {intl.formatMessage(
                    { id: "workspace.billing.periodEnd" },
                    { date: formatDate(usage.data.periodEnd, locale) },
                  )}
                </span>
              ) : null}
              {usage.data.pendingDowngradeTier !== null && usage.data.periodEnd !== null ? (
                <span className="text-xs font-medium text-accent">
                  {intl.formatMessage(
                    { id: "workspace.billing.plan.pendingDowngrade" },
                    {
                      plan: intl.formatMessage({
                        id: `workspace.billing.plan.${usage.data.pendingDowngradeTier}.title`,
                      }),
                      date: formatDate(usage.data.periodEnd, locale),
                    },
                  )}
                </span>
              ) : null}
            </div>
            <MetricGrid
              metrics={[
                {
                  label: intl.formatMessage({ id: "workspace.billing.available" }),
                  value: formatNumber(usage.data.availableCredits, locale),
                },
                {
                  label: intl.formatMessage({ id: "workspace.billing.used" }),
                  value: formatNumber(usage.data.companyUsedCredits, locale),
                },
                {
                  label: intl.formatMessage({ id: "workspace.billing.companyLimit" }),
                  value:
                    usage.data.companyMonthlyLimit === null
                      ? "—"
                      : formatNumber(usage.data.companyMonthlyLimit, locale),
                },
              ]}
            />
          </WorkspaceSection>

          {isAdmin ? (
            <>
              <WorkspaceSection
                title={intl.formatMessage({ id: "workspace.billing.plan.title" })}
                description={intl.formatMessage({ id: "workspace.billing.plan.description" })}
              >
                <div className="rounded-sm border border-rule bg-paper p-5">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <p className="text-lg font-semibold capitalize text-ink">
                        {intl.formatMessage({
                          id: `workspace.billing.plan.${planTiers[planIndex]}.title`,
                        })}
                      </p>
                      <p className="mt-1 text-sm text-muted">
                        {intl.formatMessage({
                          id: `workspace.billing.plan.${planTiers[planIndex]}.description`,
                        })}
                      </p>
                    </div>
                    {planIndex === 1 ? (
                      <StateBadge
                        state="positive"
                        label={intl.formatMessage({ id: "workspace.billing.recommended" })}
                      />
                    ) : null}
                  </div>
                  <Label className="mt-5 block" htmlFor="monthly-plan-tier">
                    {intl.formatMessage({ id: "workspace.billing.plan.select" })}
                  </Label>
                  <input
                    id="monthly-plan-tier"
                    className="mt-3 w-full accent-[var(--color-accent)]"
                    type="range"
                    min={0}
                    max={2}
                    step={1}
                    value={planIndex}
                    onChange={(event) => setPlanIndex(Number(event.target.value))}
                  />
                  <div className="mt-1 flex justify-between text-xs text-faint">
                    {planTiers.map((tier) => (
                      <span key={tier}>
                        {intl.formatMessage({ id: `workspace.billing.plan.${tier}.short` })}
                      </span>
                    ))}
                  </div>
                  <div className="mt-5 flex flex-wrap justify-end gap-2">
                    {usage.data.status !== "inactive" ? (
                      <Button
                        variant="outline"
                        disabled={portal.isPending}
                        onClick={() => portal.mutate()}
                      >
                        {intl.formatMessage({ id: "workspace.billing.portal" })}
                      </Button>
                    ) : null}
                    {usage.data.status === "inactive" ? (
                      <Button
                        disabled={checkout.isPending}
                        onClick={() =>
                          checkout.mutate({ kind: "monthly", planTier: planTiers[planIndex]! })
                        }
                      >
                        <CreditCard className="size-4" aria-hidden="true" />
                        {intl.formatMessage({ id: "workspace.billing.checkout" })}
                      </Button>
                    ) : null}
                    {["active", "trialing"].includes(usage.data.status) &&
                    usage.data.pendingDowngradeTier === null ? (
                      <Button
                        disabled={
                          planChange.isPending || usage.data.planTier === planTiers[planIndex]
                        }
                        onClick={() => planChange.mutate(planTiers[planIndex]!)}
                      >
                        {planChange.isPending
                          ? intl.formatMessage({ id: "workspace.billing.plan.changing" })
                          : intl.formatMessage({ id: "workspace.billing.plan.change" })}
                      </Button>
                    ) : null}
                  </div>
                  {usage.data.planTier !== null &&
                  usage.data.planTier !== planTiers[planIndex] &&
                  usage.data.pendingDowngradeTier === null ? (
                    <p className="mt-3 text-xs text-muted">
                      {intl.formatMessage({
                        id:
                          planIndex > planTiers.indexOf(usage.data.planTier)
                            ? "workspace.billing.plan.upgradeNotice"
                            : "workspace.billing.plan.downgradeNotice",
                      })}
                    </p>
                  ) : null}
                  {lastPlanChange !== null ? (
                    <p className="mt-3 text-sm font-medium text-accent">
                      {intl.formatMessage(
                        { id: `workspace.billing.plan.result.${lastPlanChange.status}` },
                        {
                          date:
                            lastPlanChange.effectiveAt === null
                              ? ""
                              : formatDate(lastPlanChange.effectiveAt, locale),
                        },
                      )}
                    </p>
                  ) : null}
                  {planChange.isError ? (
                    <p className="mt-3 text-sm text-danger" role="alert">
                      {intl.formatMessage({ id: "workspace.billing.plan.changeFailed" })}
                    </p>
                  ) : null}
                </div>
              </WorkspaceSection>

              <WorkspaceSection
                title={intl.formatMessage({ id: "workspace.billing.additional.title" })}
                description={intl.formatMessage({ id: "workspace.billing.additional.description" })}
              >
                <div className="rounded-sm border border-rule bg-paper p-5">
                  <p className="text-2xl font-semibold text-ink">
                    {formatNumber(additionalCredits, locale)}{" "}
                    {intl.formatMessage({ id: "workspace.billing.credits" })}
                  </p>
                  <p className="mt-1 text-sm text-muted">
                    {intl.formatMessage({ id: "workspace.billing.additional.estimate" })}
                  </p>
                  <input
                    className="mt-5 w-full accent-[var(--color-accent)]"
                    type="range"
                    min={100}
                    max={10_000_000}
                    step={100}
                    value={additionalCredits}
                    aria-label={intl.formatMessage({ id: "workspace.billing.additional.amount" })}
                    onChange={(event) => setAdditionalCredits(Number(event.target.value))}
                  />
                  <div className="mt-5 flex justify-end">
                    <Button
                      disabled={checkout.isPending}
                      onClick={() =>
                        checkout.mutate({ kind: "additional", credits: additionalCredits })
                      }
                    >
                      {intl.formatMessage({ id: "workspace.billing.additional.buy" })}
                    </Button>
                  </div>
                </div>
              </WorkspaceSection>

              <WorkspaceSection
                title={intl.formatMessage({ id: "workspace.billing.limits.title" })}
                description={intl.formatMessage({ id: "workspace.billing.limits.description" })}
              >
                <div className="space-y-3">
                  <LimitEditor
                    label={intl.formatMessage({ id: "workspace.billing.companyLimit" })}
                    current={usage.data.companyMonthlyLimit}
                    onSave={(value) => updateCompanyAiLimit(companyId, value).then(refresh)}
                  />
                  {usage.data.employees.map((employee) => (
                    <LimitEditor
                      key={employee.userId}
                      label={`${employee.userId} · ${formatNumber(employee.usedCredits, locale)} ${intl.formatMessage({ id: "workspace.billing.usedShort" })}`}
                      current={employee.monthlyLimit}
                      onSave={(value) =>
                        updateEmployeeAiLimit(companyId, employee.userId, value).then(refresh)
                      }
                    />
                  ))}
                </div>
              </WorkspaceSection>
            </>
          ) : workspaces.isPending || !memberAiUsageIsLimited(usage.data) ? null : (
            <UsageRequestForm companyId={companyId} onSuccess={refresh} />
          )}

          <WorkspaceSection
            title={intl.formatMessage({ id: "workspace.billing.requests.title" })}
            description={intl.formatMessage({ id: "workspace.billing.requests.description" })}
          >
            {usage.data.requests.length === 0 ? (
              <WorkspaceState
                title={intl.formatMessage({ id: "workspace.billing.requests.empty" })}
              />
            ) : (
              <div className="divide-y divide-rule rounded-sm border border-rule bg-paper">
                {usage.data.requests.map((request) => (
                  <article
                    key={request.id}
                    className="flex flex-wrap items-start justify-between gap-4 p-4"
                  >
                    <div>
                      <p className="text-sm font-medium text-ink">
                        {request.userId} · {formatNumber(request.requestedCredits, locale)}{" "}
                        {intl.formatMessage({ id: "workspace.billing.credits" })}
                      </p>
                      <p className="mt-1 text-sm text-muted">{request.reason}</p>
                      <p className="mt-1 font-mono text-[11px] text-faint">
                        {formatDate(request.createdAt, locale)}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <StateBadge
                        state={
                          request.status === "denied"
                            ? "failed"
                            : request.status === "approved"
                              ? "positive"
                              : "pending"
                        }
                        label={workspaceStateLabel(intl, request.status)}
                      />
                      {isAdmin && request.status === "pending" ? (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={resolve.isPending}
                            onClick={() => resolve.mutate({ id: request.id, decision: "denied" })}
                          >
                            {intl.formatMessage({ id: "workspace.billing.requests.deny" })}
                          </Button>
                          <Button
                            size="sm"
                            disabled={resolve.isPending}
                            onClick={() => resolve.mutate({ id: request.id, decision: "approved" })}
                          >
                            {intl.formatMessage({ id: "workspace.billing.requests.approve" })}
                          </Button>
                        </>
                      ) : null}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </WorkspaceSection>

          {checkout.isError || portal.isError || resolve.isError ? (
            <WorkspaceState
              tone="danger"
              title={intl.formatMessage({ id: "workspace.actionFailed" })}
            />
          ) : null}
        </div>
      )}
    </WorkspacePage>
  );
}

function LimitEditor({
  label,
  current,
  onSave,
}: {
  readonly label: string;
  readonly current: number | null;
  readonly onSave: (value: number | null) => Promise<unknown>;
}) {
  const intl = useIntl();
  const [value, setValue] = useState(current === null ? "" : String(current));
  const save = useMutation({ mutationFn: () => onSave(value === "" ? null : Number(value)) });
  return (
    <div className="flex flex-col gap-3 rounded-sm border border-rule bg-paper p-4 sm:flex-row sm:items-end">
      <div className="min-w-0 flex-1 space-y-1.5">
        <Label htmlFor={`limit-${label}`}>{label}</Label>
        <Input
          id={`limit-${label}`}
          type="number"
          min={0}
          step={1}
          value={value}
          placeholder={intl.formatMessage({ id: "workspace.billing.unlimited" })}
          onChange={(event) => setValue(event.target.value)}
        />
      </div>
      <Button
        variant="outline"
        disabled={
          save.isPending ||
          (value !== "" && (!Number.isSafeInteger(Number(value)) || Number(value) < 0))
        }
        onClick={() => save.mutate()}
      >
        {intl.formatMessage({ id: "workspace.team.save" })}
      </Button>
    </div>
  );
}

function UsageRequestForm({
  companyId,
  onSuccess,
}: {
  readonly companyId: string;
  readonly onSuccess: () => Promise<unknown>;
}) {
  const intl = useIntl();
  const [credits, setCredits] = useState("1000");
  const [reason, setReason] = useState("");
  const request = useMutation({
    mutationFn: () =>
      createAiUsageRequest(companyId, { requestedCredits: Number(credits), reason: reason.trim() }),
    onSuccess: () => {
      setReason("");
      void onSuccess();
    },
  });
  return (
    <WorkspaceSection
      title={intl.formatMessage({ id: "workspace.billing.request.title" })}
      description={intl.formatMessage({ id: "workspace.billing.request.description" })}
    >
      <form
        className="grid gap-4 rounded-sm border border-rule bg-paper p-5 sm:grid-cols-[12rem_minmax(0,1fr)_auto] sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          if (Number.isSafeInteger(Number(credits)) && Number(credits) > 0 && reason.trim() !== "")
            request.mutate();
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="requested-credits">
            {intl.formatMessage({ id: "workspace.billing.request.credits" })}
          </Label>
          <Input
            id="requested-credits"
            type="number"
            min={1}
            step={1}
            value={credits}
            onChange={(event) => setCredits(event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="usage-request-reason">
            {intl.formatMessage({ id: "workspace.billing.request.reason" })}
          </Label>
          <Textarea
            id="usage-request-reason"
            value={reason}
            maxLength={500}
            required
            onChange={(event) => setReason(event.target.value)}
          />
        </div>
        <Button type="submit" disabled={request.isPending || reason.trim() === ""}>
          {intl.formatMessage({ id: "workspace.billing.request.submit" })}
        </Button>
      </form>
    </WorkspaceSection>
  );
}
