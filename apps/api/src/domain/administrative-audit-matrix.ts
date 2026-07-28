import type { Route } from "../http";

const deniedReasonCodes = [
  "invalid_body",
  "invalid_request",
  "forbidden",
  "mfa_required",
  "not_found",
  "immutable_state",
  "idempotency_conflict",
  "provider_failure",
  "request_failed",
] as const;

export interface AdministrativeMutationAuditPolicy {
  readonly method: Route["method"];
  readonly path: Route["path"];
  /** All bounded actions the domain service may append for this route. */
  readonly actions: readonly [string, ...string[]];
  /** Stable action used only when a rejected/failed branch omitted its domain audit. */
  readonly fallbackAction: string;
  readonly scopeKind: string;
  readonly scopeParam?: string;
  readonly scopeId?: string;
  readonly succeededOutcome: "required";
  readonly deniedReasonCodes: typeof deniedReasonCodes;
}

const policy = (
  method: AdministrativeMutationAuditPolicy["method"],
  path: AdministrativeMutationAuditPolicy["path"],
  actions: AdministrativeMutationAuditPolicy["actions"],
  scopeKind: string,
  scopeParam?: string,
  scopeId?: string,
): AdministrativeMutationAuditPolicy => ({
  method,
  path,
  actions,
  fallbackAction: actions[0],
  scopeKind,
  ...(scopeParam === undefined ? {} : { scopeParam }),
  ...(scopeId === undefined ? {} : { scopeId }),
  succeededOutcome: "required",
  deniedReasonCodes,
});

/**
 * Canonical, machine-checked inventory of authenticated administrative
 * mutations. The HTTP boundary uses the same matrix as a fail-safe: if a
 * domain branch returns without its durable outcome, it appends one before the
 * response is released.
 */
export const administrativeMutationAuditMatrix = [
  policy(
    "POST",
    "/v1/client-companies/:companyId/billing/checkout",
    [
      "client.billing.checkout",
      "client.billing.checkout.monthly",
      "client.billing.checkout.additional",
    ],
    "client_company",
    "companyId",
  ),
  policy(
    "POST",
    "/v1/client-companies/:companyId/billing/plan-change",
    [
      "client.billing.plan_change",
      "client.billing.plan_change.unchanged",
      "client.billing.plan_change.upgraded",
      "client.billing.plan_change.downgrade_scheduled",
    ],
    "client_company",
    "companyId",
  ),
  policy(
    "POST",
    "/v1/client-companies/:companyId/billing/portal",
    ["client.billing.portal.create"],
    "client_company",
    "companyId",
  ),
  policy(
    "PUT",
    "/v1/client-companies/:companyId/ai-limit",
    ["client.ai_limit.company.update"],
    "client_company",
    "companyId",
  ),
  policy(
    "PUT",
    "/v1/client-companies/:companyId/members/:userId/ai-limit",
    ["client.ai_limit.employee.update"],
    "platform_user",
    "userId",
  ),
  policy(
    "POST",
    "/v1/client-companies/:companyId/ai-usage-requests",
    ["client.ai_usage_request.create"],
    "client_company",
    "companyId",
  ),
  policy(
    "POST",
    "/v1/client-companies/:companyId/ai-usage-requests/:requestId/resolve",
    [
      "client.ai_usage_request.resolve",
      "client.ai_usage_request.approved",
      "client.ai_usage_request.denied",
    ],
    "ai_usage_request",
    "requestId",
  ),
  policy(
    "PUT",
    "/v1/client-companies/:companyId/public-sources/:sourceId",
    ["client.public_source.update"],
    "public_source",
    "sourceId",
  ),
  policy(
    "PUT",
    "/v1/public-sources/:sourceId",
    ["client.public_source.update"],
    "public_source",
    "sourceId",
  ),
  policy(
    "PUT",
    "/v1/client-companies/:companyId/web-policy",
    ["client.web_policy.update"],
    "client_company",
    "companyId",
  ),
  policy(
    "POST",
    "/v1/client-companies/:companyId/deletion-requests",
    ["client.company_deletion.request"],
    "client_company",
    "companyId",
  ),
  policy(
    "PUT",
    "/v1/client-companies/:companyId/notification-preferences",
    ["client.notification_preferences.update"],
    "client_company",
    "companyId",
  ),
  policy("POST", "/v1/exports", ["export.create"], "export_request", undefined, "request"),
  policy(
    "POST",
    "/v1/platform/company-deletion-requests/:requestId/decision",
    ["platform.company_deletion.resolve"],
    "company_deletion_request",
    "requestId",
  ),
  policy(
    "POST",
    "/v1/platform/support/grants",
    ["platform.support.grant_create"],
    "restricted_support_grant",
    undefined,
    "request",
  ),
  policy(
    "POST",
    "/v1/platform/support/access/:accessId/review",
    ["platform.support.access_review"],
    "support_access_log",
    "accessId",
  ),
  policy(
    "POST",
    "/v1/platform/issues/:issueId/restriction",
    ["platform.issue.restrict"],
    "issue",
    "issueId",
  ),
  policy(
    "DELETE",
    "/v1/platform/issues/:issueId/restriction",
    ["platform.issue.restriction_remove"],
    "issue",
    "issueId",
  ),
  policy(
    "POST",
    "/v1/publisher-companies/:companyId/subscriptions",
    ["publisher.subscription.create"],
    "publisher_company",
    "companyId",
  ),
  policy(
    "POST",
    "/v1/publisher-subscriptions/:subscriptionId/issues",
    ["publisher.issue.create"],
    "publisher_subscription",
    "subscriptionId",
  ),
  policy(
    "PATCH",
    "/v1/publisher-issues/:issueId",
    ["publisher.issue.update"],
    "publisher_issue",
    "issueId",
  ),
  policy(
    "DELETE",
    "/v1/publisher-issues/:issueId",
    ["publisher.issue.delete"],
    "publisher_issue",
    "issueId",
  ),
  policy(
    "POST",
    "/v1/publisher-issues/:issueId/schedule",
    ["publisher.issue.schedule"],
    "publisher_issue",
    "issueId",
  ),
  policy(
    "POST",
    "/v1/publisher-issues/:issueId/publish",
    ["publisher.issue.publish", "publisher.issue.schedule", "publisher.issue.publish_historical"],
    "publisher_issue",
    "issueId",
  ),
  policy(
    "POST",
    "/v1/publisher-issues/:issueId/documents",
    ["publisher.document.upload"],
    "publisher_issue",
    "issueId",
  ),
  policy(
    "DELETE",
    "/v1/publisher-issues/:issueId/documents/:documentId",
    ["publisher.document.delete"],
    "publisher_document",
    "documentId",
  ),
  policy(
    "POST",
    "/v1/publisher-subscriptions/:subscriptionId/client-accesses",
    ["publisher.client_access.invite"],
    "publisher_subscription",
    "subscriptionId",
  ),
  policy(
    "POST",
    "/v1/client-subscription-accesses/:accessId/pause",
    ["publisher.client_access.pause"],
    "client_subscription_access",
    "accessId",
  ),
  policy(
    "POST",
    "/v1/platform/publisher-companies",
    ["platform.publisher_company.onboard"],
    "publisher_company",
    undefined,
    "new",
  ),
  policy(
    "POST",
    "/v1/publisher-companies/:companyId/members",
    ["publisher.member.invite"],
    "publisher_company",
    "companyId",
  ),
  policy(
    "POST",
    "/v1/client-companies/:companyId/members",
    ["client.member.invite"],
    "client_company",
    "companyId",
  ),
  policy(
    "PATCH",
    "/v1/publisher-companies/:companyId/members/:userId",
    ["publisher.member.update"],
    "publisher_company",
    "companyId",
  ),
  policy(
    "DELETE",
    "/v1/publisher-companies/:companyId/members/:userId",
    ["publisher.member.delete"],
    "publisher_company",
    "companyId",
  ),
  policy(
    "PATCH",
    "/v1/client-companies/:companyId/members/:userId",
    ["client.member.update"],
    "client_company",
    "companyId",
  ),
  policy(
    "DELETE",
    "/v1/client-companies/:companyId/members/:userId",
    ["client.member.delete"],
    "client_company",
    "companyId",
  ),
  policy(
    "POST",
    "/v1/client-companies/:companyId/members/:userId/subscription-grants",
    ["client.subscription_grant.upsert"],
    "client_subscription_access",
    "accessId",
  ),
  policy(
    "DELETE",
    "/v1/client-companies/:companyId/members/:userId/subscription-grants/:accessId",
    ["client.subscription_grant.revoke"],
    "client_subscription_access",
    "accessId",
  ),
] as const satisfies ReadonlyArray<AdministrativeMutationAuditPolicy>;

export interface AuthenticatedMutationExemption {
  readonly method: Route["method"];
  readonly path: Route["path"];
  readonly reason:
    | "provider_webhook"
    | "user_chat_content"
    | "personal_memory"
    | "personal_chat_lifecycle"
    | "personal_notification_state"
    | "demo_session";
}

export const authenticatedMutationAuditExemptions = [
  { method: "POST", path: "/v1/identity/clerk/webhook", reason: "provider_webhook" },
  { method: "POST", path: "/v1/billing/stripe/webhook", reason: "provider_webhook" },
  { method: "POST", path: "/v1/chat/messages", reason: "user_chat_content" },
  { method: "POST", path: "/v1/chats/:chatId/messages", reason: "user_chat_content" },
  {
    method: "POST",
    path: "/v1/notifications/:notificationId/read",
    reason: "personal_notification_state",
  },
  { method: "POST", path: "/v1/memories/:memoryId/revert", reason: "personal_memory" },
  { method: "DELETE", path: "/v1/memories/:memoryId", reason: "personal_memory" },
  { method: "POST", path: "/v1/chats", reason: "personal_chat_lifecycle" },
  { method: "POST", path: "/v1/demo/session", reason: "demo_session" },
  {
    method: "POST",
    path: "/v1/chats/:chatId/share",
    reason: "personal_chat_lifecycle",
  },
  {
    method: "POST",
    path: "/v1/chats/:chatId/unshare",
    reason: "personal_chat_lifecycle",
  },
  { method: "DELETE", path: "/v1/chats/:chatId", reason: "personal_chat_lifecycle" },
] as const satisfies ReadonlyArray<AuthenticatedMutationExemption>;

export const mutationRouteKey = (method: string, path: string): string => `${method} ${path}`;

const policyByRoute = new Map(
  administrativeMutationAuditMatrix.map((entry) => [
    mutationRouteKey(entry.method, entry.path),
    entry,
  ]),
);

export const administrativeAuditPolicyFor = (
  method: string,
  path: string,
): AdministrativeMutationAuditPolicy | undefined =>
  policyByRoute.get(mutationRouteKey(method, path));
