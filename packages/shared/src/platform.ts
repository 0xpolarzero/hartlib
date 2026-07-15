import { Schema } from "effect";

import { LocaleSchema } from "./content";

/**
 * Canonical transaction advisory-lane identity for a publisher issue.
 *
 * AI finalization and platform restriction changes must acquire this exact
 * lane before checking or mutating `publisher_issues.restricted_at`, so a
 * restriction cannot commit between authorization and the terminal answer
 * write.
 */
export const publisherIssueAdvisoryLockKey = (issueId: string): string =>
  `brief:publisher-issue:${issueId}`;

export const ExportScopeKind = Schema.Literals([
  "user_chats",
  "publisher_company",
  "client_company",
]);
export type ExportScopeKind = Schema.Schema.Type<typeof ExportScopeKind>;

export const CreateExportRequest = Schema.Union([
  Schema.Struct({
    scopeKind: Schema.Literal("user_chats"),
    scopeId: Schema.Literal("me"),
    idempotencyKey: Schema.String,
  }),
  Schema.Struct({
    scopeKind: Schema.Literals(["publisher_company", "client_company"]),
    scopeId: Schema.String,
    idempotencyKey: Schema.String,
  }),
]);
export type CreateExportRequest = Schema.Schema.Type<typeof CreateExportRequest>;

export const ExportRequestStatus = Schema.Literals(["queued", "running", "completed", "failed"]);
export type ExportRequestStatus = Schema.Schema.Type<typeof ExportRequestStatus>;

export const ExportRequestDescriptor = Schema.Struct({
  id: Schema.String,
  scopeKind: ExportScopeKind,
  scopeId: Schema.String,
  status: ExportRequestStatus,
  createdAt: Schema.String,
  completedAt: Schema.NullOr(Schema.String),
  expiresAt: Schema.NullOr(Schema.String),
  errorCode: Schema.NullOr(Schema.String),
  downloadPath: Schema.NullOr(Schema.String),
});
export type ExportRequestDescriptor = Schema.Schema.Type<typeof ExportRequestDescriptor>;

export const RestrictedSupportScopeKind = Schema.Literals([
  "publisher_file",
  "publisher_text",
  "client_chat",
  "client_memory",
]);
export type RestrictedSupportScopeKind = Schema.Schema.Type<typeof RestrictedSupportScopeKind>;

export const CreateRestrictedSupportGrantRequest = Schema.Struct({
  actorUserId: Schema.String,
  reason: Schema.String,
  scopeKind: RestrictedSupportScopeKind,
  scopeId: Schema.String,
  publisherCompanyId: Schema.NullOr(Schema.String),
  clientCompanyId: Schema.NullOr(Schema.String),
  affectedUserId: Schema.NullOr(Schema.String),
  customerApprovalReference: Schema.NullOr(Schema.String),
  approvalSkippedReason: Schema.NullOr(Schema.String),
  expiresAt: Schema.String,
});
export type CreateRestrictedSupportGrantRequest = Schema.Schema.Type<
  typeof CreateRestrictedSupportGrantRequest
>;

export const ReviewRestrictedSupportAccessRequest = Schema.Struct({
  decision: Schema.Literals(["approved", "flagged"]),
  notes: Schema.String,
});
export type ReviewRestrictedSupportAccessRequest = Schema.Schema.Type<
  typeof ReviewRestrictedSupportAccessRequest
>;

export const RestrictIssueRequest = Schema.Struct({
  reason: Schema.String,
});
export type RestrictIssueRequest = Schema.Schema.Type<typeof RestrictIssueRequest>;

export const PublisherRole = Schema.Literals(["admin", "manager", "member"]);
export type PublisherRole = Schema.Schema.Type<typeof PublisherRole>;

export const ClientRole = Schema.Literals(["admin", "member"]);
export type ClientRole = Schema.Schema.Type<typeof ClientRole>;

export const SubscriptionAccessState = Schema.Literals(["invited", "active", "ending", "paused"]);
export type SubscriptionAccessState = Schema.Schema.Type<typeof SubscriptionAccessState>;

export const PublisherSubscriptionDescriptor = Schema.Struct({
  id: Schema.String,
  publisherCompanyId: Schema.String,
  name: Schema.String,
  deliveryEnabled: Schema.Boolean,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type PublisherSubscriptionDescriptor = Schema.Schema.Type<
  typeof PublisherSubscriptionDescriptor
>;

export const CreatePublisherSubscriptionRequest = Schema.Struct({ name: Schema.String });
export type CreatePublisherSubscriptionRequest = Schema.Schema.Type<
  typeof CreatePublisherSubscriptionRequest
>;

export const PublisherIssueStatus = Schema.Literals(["draft", "scheduled", "published"]);
export const PublisherIssueDescriptor = Schema.Struct({
  id: Schema.String,
  subscriptionId: Schema.String,
  title: Schema.String,
  status: PublisherIssueStatus,
  publicationAt: Schema.NullOr(Schema.String),
  publishedAt: Schema.NullOr(Schema.String),
  historical: Schema.Boolean,
  indexingStatus: Schema.Literals(["pending", "extracting", "indexing", "ready", "failed"]),
  indexingErrorCode: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type PublisherIssueDescriptor = Schema.Schema.Type<typeof PublisherIssueDescriptor>;

export const CreatePublisherIssueRequest = Schema.Struct({
  title: Schema.String,
  publicationAt: Schema.NullOr(Schema.String),
  historical: Schema.Boolean,
});
export type CreatePublisherIssueRequest = Schema.Schema.Type<typeof CreatePublisherIssueRequest>;

export const UpdatePublisherIssueRequest = Schema.Struct({ title: Schema.String });
export type UpdatePublisherIssueRequest = Schema.Schema.Type<typeof UpdatePublisherIssueRequest>;

export const SchedulePublisherIssueRequest = Schema.Struct({ publicationAt: Schema.String });
export type SchedulePublisherIssueRequest = Schema.Schema.Type<
  typeof SchedulePublisherIssueRequest
>;

export const BriefDocumentDescriptor = Schema.Struct({
  id: Schema.String,
  issueId: Schema.String,
  title: Schema.String,
  originalFileName: Schema.String,
  mediaType: Schema.Literal("application/pdf"),
  byteSize: Schema.Number,
  sha256Hex: Schema.String,
  createdAt: Schema.String,
});
export type BriefDocumentDescriptor = Schema.Schema.Type<typeof BriefDocumentDescriptor>;

const DeliveredArchiveFields = {
  subscriptionName: Schema.String,
  publisherName: Schema.String,
  issueTitle: Schema.String,
  publicationAt: Schema.String,
  deliveredAt: Schema.String,
  documentId: Schema.String,
  documentTitle: Schema.String,
  snippet: Schema.NullOr(Schema.String),
  contentPath: Schema.String,
  mediaType: Schema.Literals(["application/pdf", "text/html"]),
  canonicalUrl: Schema.NullOr(Schema.String),
};
export const DeliveredArchiveResult = Schema.Union([
  Schema.Struct({
    ...DeliveredArchiveFields,
    sourceKind: Schema.Literal("publisher"),
    subscriptionId: Schema.String,
    issueId: Schema.String,
  }),
  Schema.Struct({
    ...DeliveredArchiveFields,
    sourceKind: Schema.Literal("public"),
    sourceId: Schema.String,
  }),
]);
export type DeliveredArchiveResult = Schema.Schema.Type<typeof DeliveredArchiveResult>;

export const PlatformNotificationDescriptor = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals([
    "issue_published",
    "delivery_end_scheduled",
    "delivery_ends_in_7_days",
    "delivery_ended",
    "usage_approaching_limit",
    "usage_limit_reached",
  ]),
  issueId: Schema.NullOr(Schema.String),
  accessId: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  readAt: Schema.NullOr(Schema.String),
});
export type PlatformNotificationDescriptor = Schema.Schema.Type<
  typeof PlatformNotificationDescriptor
>;

export const NotificationPreferences = Schema.Struct({
  locale: LocaleSchema,
  emailIssuePublished: Schema.Boolean,
  emailDeliveryReminders: Schema.Boolean,
  emailUsageLimits: Schema.Boolean,
});
export type NotificationPreferences = Schema.Schema.Type<typeof NotificationPreferences>;

export const PublisherMemberDescriptor = Schema.Struct({
  userId: Schema.String,
  role: PublisherRole,
  invitedEmail: Schema.NullOr(Schema.String),
  acceptedAt: Schema.NullOr(Schema.String),
  subscriptionIds: Schema.Array(Schema.String),
});
export type PublisherMemberDescriptor = Schema.Schema.Type<typeof PublisherMemberDescriptor>;

export const ClientMemberDescriptor = Schema.Struct({
  userId: Schema.String,
  role: ClientRole,
  subscriptionAccessIds: Schema.Array(Schema.String),
});
export type ClientMemberDescriptor = Schema.Schema.Type<typeof ClientMemberDescriptor>;

export const InvitePublisherMemberRequest = Schema.Struct({
  email: Schema.String,
  role: PublisherRole,
  subscriptionIds: Schema.Array(Schema.String),
});
export type InvitePublisherMemberRequest = Schema.Schema.Type<typeof InvitePublisherMemberRequest>;

export const UpdatePublisherMemberRequest = Schema.Struct({
  role: PublisherRole,
  subscriptionIds: Schema.Array(Schema.String),
});
export type UpdatePublisherMemberRequest = Schema.Schema.Type<typeof UpdatePublisherMemberRequest>;

export const InviteClientMemberRequest = Schema.Struct({
  email: Schema.String,
  role: ClientRole,
  subscriptionAccessIds: Schema.Array(Schema.String),
});
export type InviteClientMemberRequest = Schema.Schema.Type<typeof InviteClientMemberRequest>;

export const WorkspaceInvitationState = Schema.Literals([
  "creating",
  "pending",
  "accepted",
  "revoked",
  "expired",
  "failed",
]);
export type WorkspaceInvitationState = Schema.Schema.Type<typeof WorkspaceInvitationState>;

export const PublisherInvitationDescriptor = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  role: PublisherRole,
  subscriptionIds: Schema.Array(Schema.String),
  state: WorkspaceInvitationState,
  expiresAt: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});
export type PublisherInvitationDescriptor = Schema.Schema.Type<
  typeof PublisherInvitationDescriptor
>;

export const ClientInvitationDescriptor = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  role: ClientRole,
  subscriptionAccessIds: Schema.Array(Schema.String),
  state: WorkspaceInvitationState,
  expiresAt: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});
export type ClientInvitationDescriptor = Schema.Schema.Type<typeof ClientInvitationDescriptor>;

export const UpdateClientMemberRequest = Schema.Struct({ role: ClientRole });
export type UpdateClientMemberRequest = Schema.Schema.Type<typeof UpdateClientMemberRequest>;

export const GrantClientSubscriptionRequest = Schema.Struct({ accessId: Schema.String });
export type GrantClientSubscriptionRequest = Schema.Schema.Type<
  typeof GrantClientSubscriptionRequest
>;

export const PublisherWorkspaceDescriptor = Schema.Struct({
  kind: Schema.Literal("publisher"),
  companyId: Schema.String,
  companyName: Schema.String,
  role: PublisherRole,
  landingPath: Schema.String,
});
export type PublisherWorkspaceDescriptor = Schema.Schema.Type<typeof PublisherWorkspaceDescriptor>;

export const ClientWorkspaceDescriptor = Schema.Struct({
  kind: Schema.Literal("client"),
  companyId: Schema.String,
  companyName: Schema.String,
  role: ClientRole,
  landingPath: Schema.String,
});
export type ClientWorkspaceDescriptor = Schema.Schema.Type<typeof ClientWorkspaceDescriptor>;

export const ClientSubscriptionAccessDescriptor = Schema.Struct({
  accessId: Schema.String,
  subscriptionId: Schema.String,
  subscriptionName: Schema.String,
  publisherCompanyId: Schema.String,
  publisherName: Schema.String,
  state: SubscriptionAccessState,
  deliveryEndAt: Schema.NullOr(Schema.String),
});
export type ClientSubscriptionAccessDescriptor = Schema.Schema.Type<
  typeof ClientSubscriptionAccessDescriptor
>;

export const CurrentUserWorkspacesResponse = Schema.Struct({
  publisherWorkspaces: Schema.Array(PublisherWorkspaceDescriptor),
  clientWorkspaces: Schema.Array(ClientWorkspaceDescriptor),
});
export type CurrentUserWorkspacesResponse = Schema.Schema.Type<
  typeof CurrentUserWorkspacesResponse
>;

export const AiPlanTier = Schema.Literals(["light", "team", "intensive"]);
export type AiPlanTier = Schema.Schema.Type<typeof AiPlanTier>;

export const BillingPlanChangeIdempotencyKey = Schema.String.pipe(
  Schema.check(Schema.isLengthBetween(8, 180)),
  Schema.check(Schema.isPattern(/^[A-Za-z0-9:_-]+$/u)),
);
export type BillingPlanChangeIdempotencyKey = Schema.Schema.Type<
  typeof BillingPlanChangeIdempotencyKey
>;

export const BillingCheckoutIdempotencyKey = Schema.String.pipe(
  Schema.check(Schema.isLengthBetween(8, 180)),
  Schema.check(Schema.isPattern(/^[A-Za-z0-9:_-]+$/u)),
);
export type BillingCheckoutIdempotencyKey = Schema.Schema.Type<
  typeof BillingCheckoutIdempotencyKey
>;

export const CreateBillingCheckoutRequest = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("monthly"),
    planTier: AiPlanTier,
    idempotencyKey: BillingCheckoutIdempotencyKey,
  }),
  Schema.Struct({
    kind: Schema.Literal("additional"),
    credits: Schema.Number.pipe(
      Schema.check(
        Schema.makeFilter<number>((value) =>
          Number.isSafeInteger(value) && value > 0 && value <= 10_000_000
            ? undefined
            : "credits must be a positive safe integer no greater than 10000000",
        ),
      ),
    ),
    idempotencyKey: BillingCheckoutIdempotencyKey,
  }),
]);
export type CreateBillingCheckoutRequest = Schema.Schema.Type<typeof CreateBillingCheckoutRequest>;

export const ChangeMonthlyPlanRequest = Schema.Struct({
  planTier: AiPlanTier,
  idempotencyKey: BillingPlanChangeIdempotencyKey,
});
export type ChangeMonthlyPlanRequest = Schema.Schema.Type<typeof ChangeMonthlyPlanRequest>;

export const MonthlyPlanChangeDescriptor = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("unchanged"),
    previousTier: AiPlanTier,
    planTier: AiPlanTier,
    effectiveAt: Schema.Null,
  }),
  Schema.Struct({
    status: Schema.Literal("upgraded"),
    previousTier: AiPlanTier,
    planTier: AiPlanTier,
    effectiveAt: Schema.String,
  }),
  Schema.Struct({
    status: Schema.Literal("downgrade_scheduled"),
    previousTier: AiPlanTier,
    planTier: AiPlanTier,
    effectiveAt: Schema.String,
  }),
]);
export type MonthlyPlanChangeDescriptor = Schema.Schema.Type<typeof MonthlyPlanChangeDescriptor>;

export const ChangeMonthlyPlanResponse = Schema.Struct({
  change: MonthlyPlanChangeDescriptor,
});
export type ChangeMonthlyPlanResponse = Schema.Schema.Type<typeof ChangeMonthlyPlanResponse>;

const AiLimit = Schema.NullOr(
  Schema.Number.pipe(
    Schema.check(
      Schema.makeFilter<number>((value) =>
        Number.isSafeInteger(value) && value >= 0
          ? undefined
          : "limit must be a safe nonnegative integer",
      ),
    ),
  ),
);
export const UpdateCompanyAiLimitRequest = Schema.Struct({ companyMonthlyLimit: AiLimit });
export type UpdateCompanyAiLimitRequest = Schema.Schema.Type<typeof UpdateCompanyAiLimitRequest>;

export const UpdateEmployeeAiLimitRequest = Schema.Struct({ monthlyLimit: AiLimit });
export type UpdateEmployeeAiLimitRequest = Schema.Schema.Type<typeof UpdateEmployeeAiLimitRequest>;

export const CreateAiUsageRequest = Schema.Struct({
  requestedCredits: Schema.Number.pipe(
    Schema.check(
      Schema.makeFilter<number>((value) =>
        Number.isSafeInteger(value) && value > 0
          ? undefined
          : "requestedCredits must be a positive safe integer",
      ),
    ),
  ),
  reason: Schema.String.pipe(
    Schema.check(Schema.isMaxLength(500)),
    Schema.check(
      Schema.makeFilter<string>((value) =>
        value.trim().length > 0 ? undefined : "reason must not be blank",
      ),
    ),
  ),
});
export type CreateAiUsageRequest = Schema.Schema.Type<typeof CreateAiUsageRequest>;

export const ResolveAiUsageRequest = Schema.Struct({
  decision: Schema.Literals(["approved", "denied"]),
});
export type ResolveAiUsageRequest = Schema.Schema.Type<typeof ResolveAiUsageRequest>;

export const AiUsageRequestDescriptor = Schema.Struct({
  id: Schema.String,
  userId: Schema.String,
  requestedCredits: Schema.Number,
  reason: Schema.String,
  status: Schema.Literals(["pending", "approved", "denied"]),
  createdAt: Schema.String,
  resolvedAt: Schema.NullOr(Schema.String),
});
export type AiUsageRequestDescriptor = Schema.Schema.Type<typeof AiUsageRequestDescriptor>;

export const EmployeeAiUsageDescriptor = Schema.Struct({
  userId: Schema.String,
  usedCredits: Schema.Number,
  monthlyLimit: Schema.NullOr(Schema.Number),
});
export type EmployeeAiUsageDescriptor = Schema.Schema.Type<typeof EmployeeAiUsageDescriptor>;

export const AiUsageOverview = Schema.Struct({
  status: Schema.Literals(["inactive", "trialing", "active", "past_due", "paused", "cancelled"]),
  planTier: Schema.NullOr(AiPlanTier),
  pendingDowngradeTier: Schema.NullOr(AiPlanTier),
  periodStart: Schema.NullOr(Schema.String),
  periodEnd: Schema.NullOr(Schema.String),
  companyMonthlyLimit: Schema.NullOr(Schema.Number),
  companyUsedCredits: Schema.Number,
  availableCredits: Schema.Number,
  employees: Schema.Array(EmployeeAiUsageDescriptor),
  requests: Schema.Array(AiUsageRequestDescriptor),
});
export type AiUsageOverview = Schema.Schema.Type<typeof AiUsageOverview>;

export const UpdateClientWebPolicyRequest = Schema.Struct({
  enabled: Schema.Boolean,
  allowedDomains: Schema.NullOr(Schema.Array(Schema.String)),
});
export type UpdateClientWebPolicyRequest = Schema.Schema.Type<typeof UpdateClientWebPolicyRequest>;

export const ClientWebPolicySettings = Schema.Struct({
  enabled: Schema.Boolean,
  allowedDomains: Schema.NullOr(Schema.Array(Schema.String)),
});
export type ClientWebPolicySettings = Schema.Schema.Type<typeof ClientWebPolicySettings>;

export const UpdateClientPublicSourceRequest = Schema.Struct({ enabled: Schema.Boolean });
export type UpdateClientPublicSourceRequest = Schema.Schema.Type<
  typeof UpdateClientPublicSourceRequest
>;

export const ClientPublicSourceSetting = Schema.Struct({
  sourceId: Schema.String,
  displayName: Schema.String,
  publisherName: Schema.String,
  description: Schema.String,
  country: Schema.String,
  language: Schema.String,
  enabled: Schema.Boolean,
});
export type ClientPublicSourceSetting = Schema.Schema.Type<typeof ClientPublicSourceSetting>;

export const RequestCompanyDeletionRequest = Schema.Struct({
  reason: Schema.String,
  idempotencyKey: Schema.String,
});
export type RequestCompanyDeletionRequest = Schema.Schema.Type<
  typeof RequestCompanyDeletionRequest
>;

export const CompanyDeletionRequestDescriptor = Schema.Struct({
  id: Schema.String,
  status: Schema.Literals(["requested", "approved", "rejected", "completed"]),
  requestedAt: Schema.String,
  resolvedAt: Schema.NullOr(Schema.String),
});
export type CompanyDeletionRequestDescriptor = Schema.Schema.Type<
  typeof CompanyDeletionRequestDescriptor
>;

export const ResolveCompanyDeletionRequest = Schema.Struct({
  decision: Schema.Literals(["approved", "rejected"]),
  idempotencyKey: Schema.String,
});
export type ResolveCompanyDeletionRequest = Schema.Schema.Type<
  typeof ResolveCompanyDeletionRequest
>;

export const PlatformCompanyDeletionRequestDescriptor = Schema.Struct({
  id: Schema.String,
  clientCompanyId: Schema.String,
  clientCompanyName: Schema.String,
  requestedByUserId: Schema.String,
  reason: Schema.String,
  status: Schema.Literals(["requested", "approved", "rejected", "completed"]),
  requestedAt: Schema.String,
  resolvedAt: Schema.NullOr(Schema.String),
  purgeAfter: Schema.NullOr(Schema.String),
});
export type PlatformCompanyDeletionRequestDescriptor = Schema.Schema.Type<
  typeof PlatformCompanyDeletionRequestDescriptor
>;

export const InvitePublisherClientAccessRequest = Schema.Struct({
  clientCompanyName: Schema.String,
  firstAdminEmail: Schema.String,
  idempotencyKey: Schema.String,
});
export type InvitePublisherClientAccessRequest = Schema.Schema.Type<
  typeof InvitePublisherClientAccessRequest
>;

export const PublisherClientAccessDescriptor = Schema.Struct({
  id: Schema.String,
  subscriptionId: Schema.String,
  clientCompanyId: Schema.String,
  clientCompanyName: Schema.String,
  state: SubscriptionAccessState,
  firstAdminEmail: Schema.String,
  employeeCount: Schema.Number,
  invitedAt: Schema.String,
  acceptedAt: Schema.NullOr(Schema.String),
  subscribedAt: Schema.NullOr(Schema.String),
  deliveryEndAt: Schema.NullOr(Schema.String),
});
export type PublisherClientAccessDescriptor = Schema.Schema.Type<
  typeof PublisherClientAccessDescriptor
>;

export const PausePublisherClientAccessRequest = Schema.Struct({
  deliveryEndAt: Schema.NullOr(Schema.String),
});
export type PausePublisherClientAccessRequest = Schema.Schema.Type<
  typeof PausePublisherClientAccessRequest
>;

export const PublisherAiPullMetric = Schema.Struct({
  issueId: Schema.String,
  documentId: Schema.NullOr(Schema.String),
  runPullCount: Schema.Number,
  visibleTokenCount: Schema.Number,
});
export type PublisherAiPullMetric = Schema.Schema.Type<typeof PublisherAiPullMetric>;

export const PublisherAiPullIssueMetric = Schema.Struct({
  issueId: Schema.String,
  runPullCount: Schema.Number,
});
export type PublisherAiPullIssueMetric = Schema.Schema.Type<typeof PublisherAiPullIssueMetric>;

export const CreatePublisherCompanyOnboardingRequest = Schema.Struct({
  companyName: Schema.String,
  firstAdminEmail: Schema.String,
  idempotencyKey: Schema.String,
});
export type CreatePublisherCompanyOnboardingRequest = Schema.Schema.Type<
  typeof CreatePublisherCompanyOnboardingRequest
>;

export const PublisherCompanyOnboardingDescriptor = Schema.Struct({
  companyId: Schema.String,
  companyName: Schema.String,
  firstAdminEmail: Schema.String,
  invitationState: WorkspaceInvitationState,
});
export type PublisherCompanyOnboardingDescriptor = Schema.Schema.Type<
  typeof PublisherCompanyOnboardingDescriptor
>;

// Canonical HTTP response contracts. API response validation and every client
// decoder import these exact schemas; application-local equivalents are not
// permitted because they can drift independently.
export const PublisherSubscriptionListResponse = Schema.Struct({
  subscriptions: Schema.Array(PublisherSubscriptionDescriptor),
});
export const PublisherSubscriptionResponse = Schema.Struct({
  subscription: PublisherSubscriptionDescriptor,
});
export const PublisherIssueListResponse = Schema.Struct({
  issues: Schema.Array(PublisherIssueDescriptor),
});
export const PublisherIssueResponse = Schema.Struct({ issue: PublisherIssueDescriptor });
export const PublisherClientAccessListResponse = Schema.Struct({
  accesses: Schema.Array(PublisherClientAccessDescriptor),
});
export const PublisherClientAccessResponse = Schema.Struct({
  access: PublisherClientAccessDescriptor,
  duplicate: Schema.Boolean,
});
export const PublisherAiPullMetricsResponse = Schema.Struct({
  metrics: Schema.Array(PublisherAiPullMetric),
  issueTotals: Schema.Array(PublisherAiPullIssueMetric),
});
export const PausePublisherClientAccessResponse = Schema.Struct({
  status: Schema.Literal("ending"),
  deliveryEndAt: Schema.String,
});
export const BriefDocumentResponse = Schema.Struct({ document: BriefDocumentDescriptor });
export const ArchiveResponse = Schema.Struct({
  items: Schema.Array(DeliveredArchiveResult),
  nextCursor: Schema.NullOr(Schema.String),
});
export const IssueDetailResponse = Schema.Struct({
  issue: PublisherIssueDescriptor,
  documents: Schema.Array(BriefDocumentDescriptor),
});
export const NotificationListResponse = Schema.Struct({
  notifications: Schema.Array(PlatformNotificationDescriptor),
  nextCursor: Schema.NullOr(Schema.String),
});
export const NotificationPreferencesResponse = Schema.Struct({
  preferences: NotificationPreferences,
});
export const PlatformOperationsResponse = Schema.Struct({
  role: Schema.Literals(["admin", "support", "security", "legal"]),
  overview: Schema.Struct({
    publisherCompanies: Schema.Number,
    clientCompanies: Schema.Number,
    subscriptions: Schema.Number,
    currentAccesses: Schema.Number,
    issues: Schema.Number,
    notificationFailures: Schema.Number,
    aiRuns: Schema.Number,
    modelInputTokens: Schema.Number,
    modelOutputTokens: Schema.Number,
    webOperations: Schema.Number,
    creditsConsumed: Schema.Number,
  }),
  publishedIssues: Schema.Array(
    Schema.Struct({
      issueId: Schema.String,
      publisherCompanyId: Schema.String,
      subscriptionId: Schema.String,
      publishedAt: Schema.String,
      indexingStatus: Schema.String,
      indexingErrorCode: Schema.NullOr(Schema.String),
      restrictedAt: Schema.NullOr(Schema.String),
      restrictedReason: Schema.NullOr(Schema.String),
    }),
  ),
});
export const RestrictedAccessListResponse = Schema.Struct({
  accesses: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      actorUserId: Schema.String,
      scopeKind: Schema.String,
      scopeId: Schema.String,
      accessedAt: Schema.String,
      reviewDecision: Schema.NullOr(Schema.String),
    }),
  ),
});
export const RestrictedSupportReviewResponse = Schema.Struct({
  review: Schema.Struct({
    id: Schema.String,
    decision: Schema.Literals(["approved", "flagged"]),
  }),
});
export const SupportGrantResponse = Schema.Struct({
  grant: Schema.Struct({ id: Schema.String, expiresAt: Schema.String }),
});
export const ActiveSupportGrantsResponse = Schema.Struct({
  grants: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      reason: Schema.String,
      scopeKind: Schema.String,
      scopeId: Schema.String,
      expiresAt: Schema.String,
      customerApprovalReference: Schema.NullOr(Schema.String),
      approvalSkippedReason: Schema.NullOr(Schema.String),
    }),
  ),
});
export const PublisherMemberListResponse = Schema.Struct({
  members: Schema.Array(PublisherMemberDescriptor),
  invitations: Schema.Array(PublisherInvitationDescriptor),
});
export const ClientMemberListResponse = Schema.Struct({
  members: Schema.Array(ClientMemberDescriptor),
  invitations: Schema.Array(ClientInvitationDescriptor),
});
export const PublisherInvitationResponse = Schema.Struct({
  invitation: PublisherInvitationDescriptor,
});
export const ClientInvitationResponse = Schema.Struct({ invitation: ClientInvitationDescriptor });
export const ClientSubscriptionAccessListResponse = Schema.Struct({
  accesses: Schema.Array(ClientSubscriptionAccessDescriptor),
});
export const AiUsageResponse = Schema.Struct({ usage: AiUsageOverview });
export const AiUsageRequestResponse = Schema.Struct({ request: AiUsageRequestDescriptor });
export const ExternalNavigationResponse = Schema.Struct({ url: Schema.String });
export const ExportResponse = Schema.Struct({ export: ExportRequestDescriptor });
export const CreateExportResponse = Schema.Struct({
  export: ExportRequestDescriptor,
  duplicate: Schema.Boolean,
});
export const ClientWebPolicyResponse = Schema.Struct({ settings: ClientWebPolicySettings });
export const ClientPublicSourcesResponse = Schema.Struct({
  sources: Schema.Array(ClientPublicSourceSetting),
});
export const ClientPublicSourceResponse = Schema.Struct({ source: ClientPublicSourceSetting });
export const CompanyDeletionRequestsResponse = Schema.Struct({
  requests: Schema.Array(CompanyDeletionRequestDescriptor),
});
export const PublisherCompanyOnboardingResponse = Schema.Struct({
  onboarding: PublisherCompanyOnboardingDescriptor,
  duplicate: Schema.Boolean,
});
export const PlatformCompanyDeletionRequestsResponse = Schema.Struct({
  requests: Schema.Array(PlatformCompanyDeletionRequestDescriptor),
});
export const PlatformCompanyDeletionDecisionResponse = Schema.Struct({
  request: PlatformCompanyDeletionRequestDescriptor,
  duplicate: Schema.Boolean,
});
