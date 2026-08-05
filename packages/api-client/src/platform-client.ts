import * as Shared from "@hartlib/shared";
import { EXPORT_ARCHIVE_MEDIA_TYPE } from "@hartlib/shared/export-contract";
import { Schema } from "effect";

import { ApiResponseError, createApiTransport, type ApiTransportOptions } from "./transport";

export type CurrentUserWorkspaces = Schema.Schema.Type<typeof Shared.CurrentUserWorkspacesResponse>;
export type PublisherSubscription = Shared.PublisherSubscriptionDescriptor;
export type PublisherIssue = Shared.PublisherIssueDescriptor;
export type PublisherSubscriptionClientAccess = Shared.PublisherClientAccessDescriptor;
export type PublisherSubscriptionAiPullMetric = Shared.PublisherAiPullMetric;
export type PublisherIssuePullMetric = Shared.PublisherAiPullIssueMetric;
export type HartlibDocument = Shared.HartlibDocumentDescriptor;
export type ArchiveItem = Shared.DeliveredArchiveResult;
export type IssueDetail = Schema.Schema.Type<typeof Shared.IssueDetailResponse>;
export type PlatformNotification = Shared.PlatformNotificationDescriptor;
export type NotificationPreferenceState = Shared.NotificationPreferences;
export type PlatformOperations = Schema.Schema.Type<typeof Shared.PlatformOperationsResponse>;
export type RestrictedAccessList = Schema.Schema.Type<typeof Shared.RestrictedAccessListResponse>;
export type ActiveSupportGrants = Schema.Schema.Type<typeof Shared.ActiveSupportGrantsResponse>;
export type PlatformCompanyDeletionRequest = Shared.PlatformCompanyDeletionRequestDescriptor;
export type PublisherCompanyOnboarding = Shared.PublisherCompanyOnboardingDescriptor;
export type PublisherMember = Shared.PublisherMemberDescriptor;
export type PublisherInvitation = Shared.PublisherInvitationDescriptor;
export type ClientMember = Shared.ClientMemberDescriptor;
export type ClientInvitation = Shared.ClientInvitationDescriptor;
export type ClientSubscriptionAccess = Shared.ClientSubscriptionAccessDescriptor;
export type ClientAiUsage = Shared.AiUsageOverview;
export type ClientAiUsageRequest = Shared.AiUsageRequestDescriptor;
export type ClientMonthlyPlanChange = Shared.MonthlyPlanChangeDescriptor;
export type ProductExportRequest = Shared.ExportRequestDescriptor;
export type ClientCompanyWebPolicy = Shared.ClientWebPolicySettings;
export type ClientCompanyDeletionRequest = Shared.CompanyDeletionRequestDescriptor;
export type ClientCompanyPublicSource = Shared.ClientPublicSourceSetting;

export interface ArchivePage {
  readonly items: readonly ArchiveItem[];
  readonly nextCursor: string | null;
}

export type ArchiveSourceFilter =
  | { readonly kind: "publisher"; readonly subscriptionId: string }
  | { readonly kind: "public"; readonly sourceId: string };

export interface NotificationPage {
  readonly notifications: readonly PlatformNotification[];
  readonly nextCursor: string | null;
}

export interface PublisherTeam {
  readonly members: readonly PublisherMember[];
  readonly invitations: readonly PublisherInvitation[];
}

export interface ClientTeam {
  readonly members: readonly ClientMember[];
  readonly invitations: readonly ClientInvitation[];
}

const externalHttpsUrl = (value: string, code = "billing_navigation_invalid"): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ApiResponseError(502, code);
  }
  if (url.protocol !== "https:") throw new ApiResponseError(502, code);
  return url.toString();
};

const sha256Hex = async (bytes: ArrayBuffer): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

export const validateProductExportDownloadPath = (downloadPath: string): string => {
  if (
    !/^\/v1\/exports\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/download$/iu.test(
      downloadPath,
    )
  ) {
    throw new ApiResponseError(0, "export_download_path_invalid");
  }
  return downloadPath;
};

export const createPlatformApiClient = (options: ApiTransportOptions) => {
  const transport = createApiTransport(options);

  return {
    getCurrentUserWorkspaces: (): Promise<CurrentUserWorkspaces> =>
      transport.json(
        "GET /v1/me/workspaces",
        "/v1/me/workspaces",
        Shared.CurrentUserWorkspacesResponse,
      ),

    listPublisherSubscriptions: async (
      companyId: string,
    ): Promise<readonly PublisherSubscription[]> =>
      (
        await transport.json(
          "GET /v1/publisher-companies/:companyId/subscriptions",
          `/v1/publisher-companies/${encodeURIComponent(companyId)}/subscriptions`,
          Shared.PublisherSubscriptionListResponse,
        )
      ).subscriptions,

    createPublisherSubscription: async (
      companyId: string,
      input: Shared.CreatePublisherSubscriptionRequest,
    ): Promise<PublisherSubscription> =>
      (
        await transport.json(
          "POST /v1/publisher-companies/:companyId/subscriptions",
          `/v1/publisher-companies/${encodeURIComponent(companyId)}/subscriptions`,
          Shared.PublisherSubscriptionResponse,
          { json: input },
        )
      ).subscription,

    listPublisherIssues: async (subscriptionId: string): Promise<readonly PublisherIssue[]> =>
      (
        await transport.json(
          "GET /v1/publisher-subscriptions/:subscriptionId/issues",
          `/v1/publisher-subscriptions/${encodeURIComponent(subscriptionId)}/issues`,
          Shared.PublisherIssueListResponse,
        )
      ).issues,

    createPublisherIssue: async (
      subscriptionId: string,
      input: Shared.CreatePublisherIssueRequest,
    ): Promise<PublisherIssue> =>
      (
        await transport.json(
          "POST /v1/publisher-subscriptions/:subscriptionId/issues",
          `/v1/publisher-subscriptions/${encodeURIComponent(subscriptionId)}/issues`,
          Shared.PublisherIssueResponse,
          { json: input },
        )
      ).issue,

    getPublisherIssue: (issueId: string): Promise<IssueDetail> =>
      transport.json(
        "GET /v1/publisher-issues/:issueId",
        `/v1/publisher-issues/${encodeURIComponent(issueId)}`,
        Shared.IssueDetailResponse,
      ),

    listPublisherClientAccesses: async (
      subscriptionId: string,
    ): Promise<readonly PublisherSubscriptionClientAccess[]> =>
      (
        await transport.json(
          "GET /v1/publisher-subscriptions/:subscriptionId/client-accesses",
          `/v1/publisher-subscriptions/${encodeURIComponent(subscriptionId)}/client-accesses`,
          Shared.PublisherClientAccessListResponse,
        )
      ).accesses,

    invitePublisherClientAccess: async (
      subscriptionId: string,
      input: Shared.InvitePublisherClientAccessRequest,
    ): Promise<PublisherSubscriptionClientAccess> =>
      (
        await transport.json(
          "POST /v1/publisher-subscriptions/:subscriptionId/client-accesses",
          `/v1/publisher-subscriptions/${encodeURIComponent(subscriptionId)}/client-accesses`,
          Shared.PublisherClientAccessResponse,
          { json: input },
        )
      ).access,

    pausePublisherClientAccess: async (
      accessId: string,
      deliveryEndAt: string | null,
    ): Promise<string> =>
      (
        await transport.json(
          "POST /v1/client-subscription-accesses/:accessId/pause",
          `/v1/client-subscription-accesses/${encodeURIComponent(accessId)}/pause`,
          Shared.PausePublisherClientAccessResponse,
          { json: { deliveryEndAt } },
        )
      ).deliveryEndAt,

    getPublisherAiPullMetrics: (
      subscriptionId: string,
    ): Promise<{
      readonly metrics: readonly PublisherSubscriptionAiPullMetric[];
      readonly issueTotals: readonly PublisherIssuePullMetric[];
    }> =>
      transport.json(
        "GET /v1/publisher-subscriptions/:subscriptionId/ai-pull-metrics",
        `/v1/publisher-subscriptions/${encodeURIComponent(subscriptionId)}/ai-pull-metrics`,
        Shared.PublisherAiPullMetricsResponse,
      ),

    updatePublisherIssue: async (issueId: string, title: string): Promise<void> => {
      await transport.json(
        "PATCH /v1/publisher-issues/:issueId",
        `/v1/publisher-issues/${encodeURIComponent(issueId)}`,
        Shared.PublisherIssueResponse,
        { json: { title } },
      );
    },

    deletePublisherIssue: (issueId: string): Promise<void> =>
      transport.empty(
        "DELETE /v1/publisher-issues/:issueId",
        `/v1/publisher-issues/${encodeURIComponent(issueId)}`,
      ),

    publishPublisherIssue: async (issueId: string): Promise<void> => {
      await transport.jsonUnknown(
        "POST /v1/publisher-issues/:issueId/publish",
        `/v1/publisher-issues/${encodeURIComponent(issueId)}/publish`,
      );
    },

    schedulePublisherIssue: async (issueId: string, publicationAt: string): Promise<void> => {
      await transport.jsonUnknown(
        "POST /v1/publisher-issues/:issueId/schedule",
        `/v1/publisher-issues/${encodeURIComponent(issueId)}/schedule`,
        { json: { publicationAt } },
      );
    },

    uploadPublisherDocument: async (
      issueId: string,
      input: { readonly title: string; readonly file: File; readonly idempotencyKey: string },
    ): Promise<HartlibDocument> => {
      const bytes = await input.file.arrayBuffer();
      return (
        await transport.json(
          "POST /v1/publisher-issues/:issueId/documents",
          `/v1/publisher-issues/${encodeURIComponent(issueId)}/documents`,
          Shared.HartlibDocumentResponse,
          {
            body: bytes,
            headers: {
              "content-type": "application/pdf",
              "idempotency-key": input.idempotencyKey,
              "x-hartlib-title": input.title,
              "x-file-name": input.file.name,
              "x-content-sha256": await sha256Hex(bytes),
            },
          },
        )
      ).document;
    },

    deletePublisherDocument: (issueId: string, documentId: string): Promise<void> =>
      transport.empty(
        "DELETE /v1/publisher-issues/:issueId/documents/:documentId",
        `/v1/publisher-issues/${encodeURIComponent(issueId)}/documents/${encodeURIComponent(documentId)}`,
      ),

    listClientArchive: (
      companyId: string,
      input: {
        readonly query?: string;
        readonly source?: ArchiveSourceFilter;
        readonly cursor?: string | null;
        readonly limit?: number;
      } = {},
    ): Promise<ArchivePage> => {
      const search = new URLSearchParams({ limit: String(input.limit ?? 25) });
      if (input.query?.trim()) search.set("q", input.query.trim());
      if (input.source?.kind === "publisher") {
        search.set("sourceKind", "publisher");
        search.set("sourceId", input.source.subscriptionId);
      } else if (input.source?.kind === "public") {
        search.set("sourceKind", "public");
        search.set("sourceId", input.source.sourceId);
      }
      if (input.cursor) search.set("cursor", input.cursor);
      return transport.json(
        "GET /v1/client-companies/:companyId/archive",
        `/v1/client-companies/${encodeURIComponent(companyId)}/archive?${search.toString()}`,
        Shared.ArchiveResponse,
      );
    },

    getIssueDetail: (issueId: string): Promise<IssueDetail> =>
      transport.json(
        "GET /v1/issues/:issueId",
        `/v1/issues/${encodeURIComponent(issueId)}`,
        Shared.IssueDetailResponse,
      ),

    listNotifications: (
      companyId: string,
      cursor: string | null = null,
    ): Promise<NotificationPage> => {
      const search = new URLSearchParams({ limit: "25" });
      if (cursor !== null) search.set("cursor", cursor);
      return transport.json(
        "GET /v1/client-companies/:companyId/notifications",
        `/v1/client-companies/${encodeURIComponent(companyId)}/notifications?${search.toString()}`,
        Shared.NotificationListResponse,
      );
    },

    markNotificationRead: async (notificationId: string): Promise<void> => {
      await transport.jsonUnknown(
        "POST /v1/notifications/:notificationId/read",
        `/v1/notifications/${encodeURIComponent(notificationId)}/read`,
      );
    },

    getNotificationPreferences: async (companyId: string): Promise<NotificationPreferenceState> =>
      (
        await transport.json(
          "GET /v1/client-companies/:companyId/notification-preferences",
          `/v1/client-companies/${encodeURIComponent(companyId)}/notification-preferences`,
          Shared.NotificationPreferencesResponse,
        )
      ).preferences,

    updateNotificationPreferences: async (
      companyId: string,
      preferences: NotificationPreferenceState,
    ): Promise<NotificationPreferenceState> =>
      (
        await transport.json(
          "PUT /v1/client-companies/:companyId/notification-preferences",
          `/v1/client-companies/${encodeURIComponent(companyId)}/notification-preferences`,
          Shared.NotificationPreferencesResponse,
          { json: preferences },
        )
      ).preferences,

    getPlatformOperations: (): Promise<PlatformOperations> =>
      transport.json(
        "GET /v1/platform/operations",
        "/v1/platform/operations",
        Shared.PlatformOperationsResponse,
      ),

    listPlatformCompanyDeletionRequests: async (): Promise<
      readonly PlatformCompanyDeletionRequest[]
    > =>
      (
        await transport.json(
          "GET /v1/platform/company-deletion-requests",
          "/v1/platform/company-deletion-requests",
          Shared.PlatformCompanyDeletionRequestsResponse,
        )
      ).requests,

    resolvePlatformCompanyDeletionRequest: async (
      requestId: string,
      input: Shared.ResolveCompanyDeletionRequest,
    ): Promise<PlatformCompanyDeletionRequest> =>
      (
        await transport.json(
          "POST /v1/platform/company-deletion-requests/:requestId/decision",
          `/v1/platform/company-deletion-requests/${encodeURIComponent(requestId)}/decision`,
          Shared.PlatformCompanyDeletionDecisionResponse,
          { json: input },
        )
      ).request,

    createPublisherCompanyOnboarding: async (
      input: Shared.CreatePublisherCompanyOnboardingRequest,
    ): Promise<PublisherCompanyOnboarding> =>
      (
        await transport.json(
          "POST /v1/platform/publisher-companies",
          "/v1/platform/publisher-companies",
          Shared.PublisherCompanyOnboardingResponse,
          { json: input },
        )
      ).onboarding,

    listRestrictedSupportAccess: (): Promise<RestrictedAccessList> =>
      transport.json(
        "GET /v1/platform/support/access",
        "/v1/platform/support/access",
        Shared.RestrictedAccessListResponse,
      ),

    listActiveRestrictedSupportGrants: (): Promise<ActiveSupportGrants> =>
      transport.json(
        "GET /v1/platform/support/grants",
        "/v1/platform/support/grants",
        Shared.ActiveSupportGrantsResponse,
      ),

    createRestrictedSupportGrant: async (
      input: Shared.CreateRestrictedSupportGrantRequest,
    ): Promise<{ readonly id: string; readonly expiresAt: string }> =>
      (
        await transport.json(
          "POST /v1/platform/support/grants",
          "/v1/platform/support/grants",
          Shared.SupportGrantResponse,
          { json: input },
        )
      ).grant,

    getRestrictedSupportGrantContent: (grantId: string) =>
      transport.jsonOrRedirectedBinary(
        "GET /v1/platform/support/grants/:grantId/content",
        `/v1/platform/support/grants/${encodeURIComponent(grantId)}/content`,
        ["application/pdf"],
        { headers: { "x-request-id": crypto.randomUUID() } },
      ),

    reviewRestrictedSupportAccess: async (
      accessLogId: string,
      input: Shared.ReviewRestrictedSupportAccessRequest,
    ): Promise<void> => {
      await transport.json(
        "POST /v1/platform/support/access/:accessId/review",
        `/v1/platform/support/access/${encodeURIComponent(accessLogId)}/review`,
        Shared.RestrictedSupportReviewResponse,
        { json: input },
      );
    },

    restrictPlatformIssue: (issueId: string, reason: string): Promise<void> =>
      transport.empty(
        "POST /v1/platform/issues/:issueId/restriction",
        `/v1/platform/issues/${encodeURIComponent(issueId)}/restriction`,
        { json: { reason } },
      ),

    removePlatformIssueRestriction: (issueId: string): Promise<void> =>
      transport.empty(
        "DELETE /v1/platform/issues/:issueId/restriction",
        `/v1/platform/issues/${encodeURIComponent(issueId)}/restriction`,
      ),

    listPublisherMembers: (companyId: string): Promise<PublisherTeam> =>
      transport.json(
        "GET /v1/publisher-companies/:companyId/members",
        `/v1/publisher-companies/${encodeURIComponent(companyId)}/members`,
        Shared.PublisherMemberListResponse,
      ),

    invitePublisherMember: async (
      companyId: string,
      input: Shared.InvitePublisherMemberRequest,
    ): Promise<PublisherInvitation> =>
      (
        await transport.json(
          "POST /v1/publisher-companies/:companyId/members",
          `/v1/publisher-companies/${encodeURIComponent(companyId)}/members`,
          Shared.PublisherInvitationResponse,
          { json: input },
        )
      ).invitation,

    updatePublisherMember: async (
      companyId: string,
      userId: string,
      input: Shared.UpdatePublisherMemberRequest,
    ): Promise<void> => {
      await transport.jsonUnknown(
        "PATCH /v1/publisher-companies/:companyId/members/:userId",
        `/v1/publisher-companies/${encodeURIComponent(companyId)}/members/${encodeURIComponent(userId)}`,
        { json: input },
      );
    },

    deletePublisherMember: (companyId: string, userId: string): Promise<void> =>
      transport.empty(
        "DELETE /v1/publisher-companies/:companyId/members/:userId",
        `/v1/publisher-companies/${encodeURIComponent(companyId)}/members/${encodeURIComponent(userId)}`,
      ),

    listClientMembers: (companyId: string): Promise<ClientTeam> =>
      transport.json(
        "GET /v1/client-companies/:companyId/members",
        `/v1/client-companies/${encodeURIComponent(companyId)}/members`,
        Shared.ClientMemberListResponse,
      ),

    inviteClientMember: async (
      companyId: string,
      input: Shared.InviteClientMemberRequest,
    ): Promise<ClientInvitation> =>
      (
        await transport.json(
          "POST /v1/client-companies/:companyId/members",
          `/v1/client-companies/${encodeURIComponent(companyId)}/members`,
          Shared.ClientInvitationResponse,
          { json: input },
        )
      ).invitation,

    updateClientMember: async (
      companyId: string,
      userId: string,
      role: "admin" | "member",
    ): Promise<void> => {
      await transport.jsonUnknown(
        "PATCH /v1/client-companies/:companyId/members/:userId",
        `/v1/client-companies/${encodeURIComponent(companyId)}/members/${encodeURIComponent(userId)}`,
        { json: { role } },
      );
    },

    deleteClientMember: (companyId: string, userId: string): Promise<void> =>
      transport.empty(
        "DELETE /v1/client-companies/:companyId/members/:userId",
        `/v1/client-companies/${encodeURIComponent(companyId)}/members/${encodeURIComponent(userId)}`,
      ),

    listClientSubscriptionAccesses: async (
      companyId: string,
    ): Promise<readonly ClientSubscriptionAccess[]> =>
      (
        await transport.json(
          "GET /v1/client-companies/:companyId/subscription-accesses",
          `/v1/client-companies/${encodeURIComponent(companyId)}/subscription-accesses`,
          Shared.ClientSubscriptionAccessListResponse,
        )
      ).accesses,

    setClientMemberSubscriptionGrant: async (
      companyId: string,
      userId: string,
      accessId: string,
      granted: boolean,
    ): Promise<void> => {
      const base = `/v1/client-companies/${encodeURIComponent(companyId)}/members/${encodeURIComponent(userId)}/subscription-grants`;
      if (granted) {
        await transport.jsonUnknown(
          "POST /v1/client-companies/:companyId/members/:userId/subscription-grants",
          base,
          { json: { accessId } },
        );
      } else {
        await transport.empty(
          "DELETE /v1/client-companies/:companyId/members/:userId/subscription-grants/:accessId",
          `${base}/${encodeURIComponent(accessId)}`,
        );
      }
    },

    getClientAiUsage: async (companyId: string): Promise<ClientAiUsage> =>
      (
        await transport.json(
          "GET /v1/client-companies/:companyId/ai-usage",
          `/v1/client-companies/${encodeURIComponent(companyId)}/ai-usage`,
          Shared.AiUsageResponse,
        )
      ).usage,

    createBillingCheckout: async (
      companyId: string,
      input: Shared.CreateBillingCheckoutRequest,
    ): Promise<string> =>
      externalHttpsUrl(
        (
          await transport.json(
            "POST /v1/client-companies/:companyId/billing/checkout",
            `/v1/client-companies/${encodeURIComponent(companyId)}/billing/checkout`,
            Shared.ExternalNavigationResponse,
            { json: input },
          )
        ).url,
      ),

    changeClientMonthlyPlan: async (
      companyId: string,
      input: Shared.ChangeMonthlyPlanRequest,
    ): Promise<ClientMonthlyPlanChange> =>
      (
        await transport.json(
          "POST /v1/client-companies/:companyId/billing/plan-change",
          `/v1/client-companies/${encodeURIComponent(companyId)}/billing/plan-change`,
          Shared.ChangeMonthlyPlanResponse,
          { json: input },
        )
      ).change,

    createBillingPortal: async (companyId: string): Promise<string> =>
      externalHttpsUrl(
        (
          await transport.json(
            "POST /v1/client-companies/:companyId/billing/portal",
            `/v1/client-companies/${encodeURIComponent(companyId)}/billing/portal`,
            Shared.ExternalNavigationResponse,
          )
        ).url,
      ),

    updateCompanyAiLimit: async (
      companyId: string,
      companyMonthlyLimit: number | null,
    ): Promise<void> => {
      await transport.jsonUnknown(
        "PUT /v1/client-companies/:companyId/ai-limit",
        `/v1/client-companies/${encodeURIComponent(companyId)}/ai-limit`,
        { json: { companyMonthlyLimit } },
      );
    },

    updateEmployeeAiLimit: async (
      companyId: string,
      userId: string,
      monthlyLimit: number | null,
    ): Promise<void> => {
      await transport.jsonUnknown(
        "PUT /v1/client-companies/:companyId/members/:userId/ai-limit",
        `/v1/client-companies/${encodeURIComponent(companyId)}/members/${encodeURIComponent(userId)}/ai-limit`,
        { json: { monthlyLimit } },
      );
    },

    createAiUsageRequest: async (
      companyId: string,
      input: Shared.CreateAiUsageRequest,
    ): Promise<ClientAiUsageRequest> =>
      (
        await transport.json(
          "POST /v1/client-companies/:companyId/ai-usage-requests",
          `/v1/client-companies/${encodeURIComponent(companyId)}/ai-usage-requests`,
          Shared.AiUsageRequestResponse,
          { json: input },
        )
      ).request,

    resolveAiUsageRequest: async (
      companyId: string,
      requestId: string,
      decision: "approved" | "denied",
    ): Promise<void> => {
      await transport.jsonUnknown(
        "POST /v1/client-companies/:companyId/ai-usage-requests/:requestId/resolve",
        `/v1/client-companies/${encodeURIComponent(companyId)}/ai-usage-requests/${encodeURIComponent(requestId)}/resolve`,
        { json: { decision } },
      );
    },

    createClientCompanyExport: async (
      companyId: string,
      idempotencyKey: string,
    ): Promise<ProductExportRequest> =>
      (
        await transport.json("POST /v1/exports", "/v1/exports", Shared.CreateExportResponse, {
          json: { scopeKind: "client_company", scopeId: companyId, idempotencyKey },
        })
      ).export,

    createPublisherCompanyExport: async (
      companyId: string,
      idempotencyKey: string,
    ): Promise<ProductExportRequest> =>
      (
        await transport.json("POST /v1/exports", "/v1/exports", Shared.CreateExportResponse, {
          json: { scopeKind: "publisher_company", scopeId: companyId, idempotencyKey },
        })
      ).export,

    createUserChatsExport: async (idempotencyKey: string): Promise<ProductExportRequest> =>
      (
        await transport.json("POST /v1/exports", "/v1/exports", Shared.CreateExportResponse, {
          json: { scopeKind: "user_chats", scopeId: "me", idempotencyKey },
        })
      ).export,

    getProductExport: async (exportId: string): Promise<ProductExportRequest> =>
      (
        await transport.json(
          "GET /v1/exports/:exportId",
          `/v1/exports/${encodeURIComponent(exportId)}`,
          Shared.ExportResponse,
        )
      ).export,

    getProductExportDownload: async (downloadPath: string): Promise<Response> => {
      validateProductExportDownloadPath(downloadPath);
      return transport.redirectedBinary("GET /v1/exports/:exportId/download", downloadPath, [
        EXPORT_ARCHIVE_MEDIA_TYPE,
      ]);
    },

    listClientPublicSources: async (
      companyId: string,
    ): Promise<readonly ClientCompanyPublicSource[]> =>
      (
        await transport.json(
          "GET /v1/client-companies/:companyId/public-sources",
          `/v1/client-companies/${encodeURIComponent(companyId)}/public-sources`,
          Shared.ClientPublicSourcesResponse,
        )
      ).sources,

    updateClientPublicSource: async (
      companyId: string,
      sourceId: string,
      enabled: boolean,
    ): Promise<ClientCompanyPublicSource> =>
      (
        await transport.json(
          "PUT /v1/client-companies/:companyId/public-sources/:sourceId",
          `/v1/client-companies/${encodeURIComponent(companyId)}/public-sources/${encodeURIComponent(sourceId)}`,
          Shared.ClientPublicSourceResponse,
          { json: { enabled } },
        )
      ).source,

    getClientWebPolicy: async (companyId: string): Promise<ClientCompanyWebPolicy> =>
      (
        await transport.json(
          "GET /v1/client-companies/:companyId/web-policy",
          `/v1/client-companies/${encodeURIComponent(companyId)}/web-policy`,
          Shared.ClientWebPolicyResponse,
        )
      ).settings,

    updateClientWebPolicy: async (
      companyId: string,
      input: Shared.UpdateClientWebPolicyRequest,
    ): Promise<ClientCompanyWebPolicy> =>
      (
        await transport.json(
          "PUT /v1/client-companies/:companyId/web-policy",
          `/v1/client-companies/${encodeURIComponent(companyId)}/web-policy`,
          Shared.ClientWebPolicyResponse,
          { json: input },
        )
      ).settings,

    listCompanyDeletionRequests: async (
      companyId: string,
    ): Promise<readonly ClientCompanyDeletionRequest[]> =>
      (
        await transport.json(
          "GET /v1/client-companies/:companyId/deletion-requests",
          `/v1/client-companies/${encodeURIComponent(companyId)}/deletion-requests`,
          Shared.CompanyDeletionRequestsResponse,
        )
      ).requests,

    requestCompanyDeletion: async (
      companyId: string,
      input: Shared.RequestCompanyDeletionRequest,
    ): Promise<readonly ClientCompanyDeletionRequest[]> =>
      (
        await transport.json(
          "POST /v1/client-companies/:companyId/deletion-requests",
          `/v1/client-companies/${encodeURIComponent(companyId)}/deletion-requests`,
          Shared.CompanyDeletionRequestsResponse,
          { json: input },
        )
      ).requests,
  };
};

export type PlatformApiClient = ReturnType<typeof createPlatformApiClient>;
