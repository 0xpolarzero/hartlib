import { Schema } from "effect";

import { DemoSessionResponse, HealthResponse, UuidPathParameter } from "./api";
import {
  ActiveAiRunConflict,
  CreateProductChatRequest,
  CreateProductChatResponse,
  GetChatResponse,
  ListMemoriesResponse,
  MemoryRecord,
  MemoryRevisionResponse,
  MemorySnapshot,
  ProductChatListResponse,
  ResetProductChatRequest,
  ResetProductChatResponse,
  RevertMemoryRequest,
  SendChatMessageAccepted,
  SendChatMessageRequest,
  SourceRange,
  WebPolicyDisabledReason,
} from "./chat";
import { MarketSchema, PublicSourcesResponse } from "./content";
import {
  ActiveSupportGrantsResponse,
  AiUsageRequestResponse,
  AiUsageResponse,
  ArchiveResponse,
  BriefDocumentResponse,
  ChangeMonthlyPlanRequest,
  ChangeMonthlyPlanResponse,
  ClientInvitationResponse,
  ClientMemberListResponse,
  ClientPublicSourceResponse,
  ClientPublicSourcesResponse,
  ClientSubscriptionAccessListResponse,
  ClientWebPolicyResponse,
  CompanyDeletionRequestsResponse,
  CreateAiUsageRequest,
  CreateBillingCheckoutRequest,
  CreateExportRequest,
  CreateExportResponse,
  CreatePublisherCompanyOnboardingRequest,
  CreatePublisherIssueRequest,
  CreatePublisherSubscriptionRequest,
  CreateRestrictedSupportGrantRequest,
  CurrentUserWorkspacesResponse,
  ExportResponse,
  ExternalNavigationResponse,
  GrantClientSubscriptionRequest,
  InviteClientMemberRequest,
  InvitePublisherClientAccessRequest,
  InvitePublisherMemberRequest,
  IssueDetailResponse,
  NotificationListResponse,
  NotificationPreferences,
  NotificationPreferencesResponse,
  PausePublisherClientAccessRequest,
  PausePublisherClientAccessResponse,
  PlatformCompanyDeletionDecisionResponse,
  PlatformCompanyDeletionRequestsResponse,
  PlatformOperationsResponse,
  PublisherAiPullMetricsResponse,
  PublisherClientAccessListResponse,
  PublisherClientAccessResponse,
  PublisherCompanyOnboardingResponse,
  PublisherInvitationResponse,
  PublisherIssueListResponse,
  PublisherIssueResponse,
  PublisherMemberListResponse,
  PublisherSubscriptionListResponse,
  PublisherSubscriptionResponse,
  RequestCompanyDeletionRequest,
  ResolveAiUsageRequest,
  ResolveCompanyDeletionRequest,
  RestrictedAccessListResponse,
  RestrictedSupportReviewResponse,
  RestrictIssueRequest,
  ReviewRestrictedSupportAccessRequest,
  SchedulePublisherIssueRequest,
  SupportGrantResponse,
  UpdateClientMemberRequest,
  UpdateClientPublicSourceRequest,
  UpdateClientWebPolicyRequest,
  UpdateCompanyAiLimitRequest,
  UpdateEmployeeAiLimitRequest,
  UpdatePublisherIssueRequest,
  UpdatePublisherMemberRequest,
} from "./platform";

export type SharedHttpSchema = Schema.Codec<unknown, unknown, never, never>;

export type HttpRequestBodyContract =
  | { readonly kind: "none" }
  | { readonly kind: "empty" }
  | { readonly kind: "json"; readonly schema: SharedHttpSchema; readonly maxBytes: number }
  | { readonly kind: "raw"; readonly maxBytes: number }
  | {
      readonly kind: "binary";
      readonly mediaTypes: ReadonlyArray<string>;
      readonly maxBytes: number;
    };

export type HttpSuccessContract =
  | {
      readonly kind: "json";
      readonly schema: SharedHttpSchema;
      readonly statuses: ReadonlyArray<number>;
    }
  | { readonly kind: "empty"; readonly statuses: ReadonlyArray<number> }
  | { readonly kind: "sse"; readonly statuses: ReadonlyArray<number> }
  | { readonly kind: "redirect"; readonly statuses: ReadonlyArray<number> }
  | {
      readonly kind: "binary";
      readonly mediaTypes: ReadonlyArray<string>;
      readonly statuses: ReadonlyArray<number>;
    };

export interface HttpFailureResponse {
  readonly status: number;
  readonly body: Readonly<Record<string, string>>;
}

export interface HttpRequestRejections {
  readonly invalid: HttpFailureResponse;
  readonly tooLarge: HttpFailureResponse;
  readonly unsupportedMediaType: HttpFailureResponse;
  readonly invalidQuery: HttpFailureResponse;
  readonly invalidHeaders: HttpFailureResponse;
}

export interface HttpRouteContract {
  readonly requestBody: HttpRequestBodyContract;
  readonly requestRejections?: HttpRequestRejections;
  readonly query?: SharedHttpSchema;
  readonly headers?: {
    readonly names: ReadonlyArray<string>;
    readonly schema: SharedHttpSchema;
  };
  readonly success: ReadonlyArray<HttpSuccessContract>;
  readonly error: SharedHttpSchema;
}

const BoundedErrorCode = Schema.String.pipe(
  Schema.check(Schema.isLengthBetween(1, 128)),
  Schema.check(Schema.isPattern(/^[a-z][a-z0-9_]*$/u)),
);
// The generic { error: ... } arm below must not shadow the dedicated
// chat_already_reset arm, which requires archivedChatId. The negative lookahead
// keeps every other bounded code while rejecting the one that has its own arm,
// so strict decoding guarantees the lineage id is present.
const GenericErrorCode = Schema.String.pipe(
  Schema.check(Schema.isLengthBetween(1, 128)),
  Schema.check(Schema.isPattern(/^(?!chat_already_reset$)[a-z][a-z0-9_]*$/u)),
);

export const HttpErrorResponse = Schema.Union([
  Schema.Struct({
    error: Schema.Literal("chat_already_reset"),
    archivedChatId: Schema.String,
  }),
  Schema.Struct({ code: BoundedErrorCode }),
  Schema.Struct({ error: GenericErrorCode }),
  Schema.Struct({ code: Schema.Literal("active_ai_run"), runId: Schema.String }),
  ActiveAiRunConflict,
  Schema.Struct({
    code: Schema.Literal("web_research_unavailable"),
    reason: WebPolicyDisabledReason,
  }),
]);

const noBody = { kind: "none" } as const;
const emptyBody = { kind: "empty" } as const;
const jsonBody = (schema: SharedHttpSchema, maxBytes = 64 * 1024) =>
  ({ kind: "json", schema, maxBytes }) as const;
const rawBody = (maxBytes: number) => ({ kind: "raw", maxBytes }) as const;
const binaryBody = (mediaTypes: ReadonlyArray<string>, maxBytes: number) =>
  ({ kind: "binary", mediaTypes, maxBytes }) as const;
const jsonSuccess = (schema: SharedHttpSchema, statuses: ReadonlyArray<number> = [200]) =>
  ({ kind: "json", schema, statuses }) as const;
const emptySuccess = { kind: "empty", statuses: [204] } as const;
const sseSuccess = { kind: "sse", statuses: [200] } as const;
const redirectSuccess = { kind: "redirect", statuses: [302] } as const;
const binarySuccess = (mediaTypes: ReadonlyArray<string>) =>
  ({ kind: "binary", mediaTypes, statuses: [200] }) as const;
const codeInvalidBody = { status: 400, body: { code: "invalid_body" } } as const;
const errorInvalidBody = { status: 400, body: { error: "invalid_body" } } as const;
const defaultRejections: HttpRequestRejections = {
  invalid: codeInvalidBody,
  tooLarge: codeInvalidBody,
  unsupportedMediaType: codeInvalidBody,
  invalidQuery: { status: 400, body: { code: "invalid_query" } },
  invalidHeaders: { status: 400, body: { code: "invalid_headers" } },
};
const contract = (
  requestBody: HttpRequestBodyContract,
  ...success: ReadonlyArray<HttpSuccessContract>
): HttpRouteContract => ({
  requestBody,
  ...(requestBody.kind === "none" ? {} : { requestRejections: defaultRejections }),
  success,
  error: HttpErrorResponse,
});
const contractWithRejections = (
  requestBody: HttpRequestBodyContract,
  requestRejections: HttpRequestRejections,
  ...success: ReadonlyArray<HttpSuccessContract>
): HttpRouteContract => ({ requestBody, requestRejections, success, error: HttpErrorResponse });
const errorBodyContract = (
  requestBody: HttpRequestBodyContract,
  ...success: ReadonlyArray<HttpSuccessContract>
): HttpRouteContract =>
  contractWithRejections(
    requestBody,
    {
      invalid: errorInvalidBody,
      tooLarge: { status: 413, body: { error: "request_too_large" } },
      unsupportedMediaType: errorInvalidBody,
      invalidQuery: { status: 400, body: { error: "invalid_query" } },
      invalidHeaders: { status: 400, body: { error: "invalid_headers" } },
    },
    ...success,
  );

const withQuery = (route: HttpRouteContract, query: SharedHttpSchema): HttpRouteContract => ({
  ...route,
  requestRejections: route.requestRejections ?? defaultRejections,
  query,
});
const withHeaders = (
  route: HttpRouteContract,
  names: ReadonlyArray<string>,
  schema: SharedHttpSchema,
): HttpRouteContract => ({ ...route, headers: { names, schema } });
const withQueryAndHeaders = (
  route: HttpRouteContract,
  query: SharedHttpSchema,
  names: ReadonlyArray<string>,
  headers: SharedHttpSchema,
): HttpRouteContract => ({
  ...route,
  requestRejections: route.requestRejections ?? defaultRejections,
  query,
  headers: { names, schema: headers },
});

const safeDecimalSequence = (minimum: number) =>
  Schema.String.pipe(
    Schema.check(Schema.isPattern(/^(?:0|[1-9]\d*)$/u)),
    Schema.check(Schema.isMaxLength(16)),
    Schema.check(
      Schema.makeFilter<string>((value) => {
        const parsed = Number(value);
        return Number.isSafeInteger(parsed) && parsed >= minimum
          ? undefined
          : `sequence must be a safe integer greater than or equal to ${minimum}`;
      }),
    ),
  );
const NonnegativeSequence = safeDecimalSequence(0);
const PositiveSequence = safeDecimalSequence(1);
export const EmptyQuery = Schema.Struct({});
export const PublicSourcesQuery = Schema.Struct({ market: Schema.optional(MarketSchema) });
export const ProductChatsQuery = Schema.Struct({
  view: Schema.optional(Schema.Literals(["mine", "shared", "archived"])),
});
export const AiRunStreamQuery = Schema.Struct({ afterSeq: Schema.optional(NonnegativeSequence) });
export const AiRunStreamHeaders = Schema.Struct({
  "last-event-id": Schema.optional(PositiveSequence),
});
const PageLimit = Schema.String.pipe(Schema.check(Schema.isPattern(/^(?:[1-9]|[1-4]\d|50)$/u)));
const PageCursor = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z0-9+/]+={0,2}$/u)),
  Schema.check(Schema.isMaxLength(128)),
  Schema.check(
    Schema.makeFilter<string>((value) => {
      try {
        const decoded = atob(value);
        if (!/^(?:0|[1-9]\d*)$/u.test(decoded)) return "cursor payload is not canonical";
        const offset = Number(decoded);
        if (!Number.isSafeInteger(offset) || offset < 0) return "cursor offset is unsafe";
        return btoa(decoded) === value ? undefined : "cursor base64 is not canonical";
      } catch {
        return "cursor is not valid base64";
      }
    }),
  ),
);
const ArchiveQueryFields = {
  limit: Schema.optional(PageLimit),
  cursor: Schema.optional(PageCursor),
  q: Schema.optional(Schema.String.pipe(Schema.check(Schema.isMaxLength(500)))),
};
const PublicArchiveSourceId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-z0-9](?:[a-z0-9_-]{0,127})$/u)),
);
/**
 * Archive filtering is deliberately discriminated. Publisher subscription UUIDs
 * and public-source slugs are different identifier domains and must never share
 * a query field or rely on a synthetic `public:` prefix.
 */
export const ArchiveQuery = Schema.Union([
  Schema.Struct(ArchiveQueryFields),
  Schema.Struct({
    ...ArchiveQueryFields,
    sourceKind: Schema.Literal("publisher"),
    sourceId: UuidPathParameter,
  }),
  Schema.Struct({
    ...ArchiveQueryFields,
    sourceKind: Schema.Literal("public"),
    sourceId: PublicArchiveSourceId,
  }),
]);
export const NotificationQuery = Schema.Struct({
  limit: Schema.optional(PageLimit),
  cursor: Schema.optional(PageCursor),
});
const WebhookHeaderValue = Schema.String.pipe(Schema.check(Schema.isLengthBetween(1, 8_192)));
export const StripeWebhookHeaders = Schema.Struct({
  "stripe-signature": WebhookHeaderValue,
});
export const ClerkWebhookHeaders = Schema.Union([
  Schema.Struct({
    "svix-id": WebhookHeaderValue,
    "svix-timestamp": WebhookHeaderValue,
    "svix-signature": WebhookHeaderValue,
    "webhook-id": Schema.optional(WebhookHeaderValue),
    "webhook-timestamp": Schema.optional(WebhookHeaderValue),
    "webhook-signature": Schema.optional(WebhookHeaderValue),
  }),
  Schema.Struct({
    "svix-id": Schema.optional(WebhookHeaderValue),
    "svix-timestamp": Schema.optional(WebhookHeaderValue),
    "svix-signature": Schema.optional(WebhookHeaderValue),
    "webhook-id": WebhookHeaderValue,
    "webhook-timestamp": WebhookHeaderValue,
    "webhook-signature": WebhookHeaderValue,
  }),
]);
export const PublisherPdfUploadHeaders = Schema.Struct({
  "idempotency-key": Schema.String.pipe(
    Schema.check(Schema.isPattern(/^[A-Za-z0-9._:-]{16,200}$/u)),
  ),
  "x-brief-title": Schema.String.pipe(Schema.check(Schema.isLengthBetween(1, 300))),
  "x-file-name": Schema.String.pipe(
    Schema.check(Schema.isLengthBetween(1, 255)),
    Schema.check(Schema.isPattern(/^[^/\\\r\n]+$/u)),
  ),
  "x-content-sha256": Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/u))),
});

const WebhookProcessedResponse = Schema.Struct({
  status: Schema.Literals(["processed", "duplicate"]),
});
const StripeWebhookResponse = Schema.Struct({
  received: Schema.Literal(true),
  duplicate: Schema.Boolean,
});
const StatusUpdatedResponse = Schema.Struct({ status: Schema.Literal("updated") });
const AiUsageResolutionResponse = Schema.Struct({
  status: Schema.Literals(["approved", "denied"]),
});
const SourceAccessListResponse = ClientSubscriptionAccessListResponse;
const NotificationReadResponse = Schema.Struct({
  status: Schema.Literal("read"),
  readAt: Schema.String,
});
const ShareChatResponse = Schema.Struct({ status: Schema.Literal("shared") });
const UnshareChatResponse = Schema.Struct({ status: Schema.Literal("private") });
const RestrictionChangedResponse = emptySuccess;
const ScheduledIssueResponse = Schema.Struct({
  status: Schema.Literal("scheduled"),
  publicationAt: Schema.String,
});
const PublishedIssueResponse = Schema.Struct({
  status: Schema.Literals(["published", "queued"]),
});
const SubscriptionGrantResponse = Schema.Struct({ status: Schema.Literal("granted") });

const SupportPageRange = Schema.Struct({
  pageNumber: Schema.Number,
  charStart: Schema.Number,
  charEnd: Schema.Number,
});
const SupportPublisherTextContent = Schema.Struct({
  accessLogId: Schema.String,
  scopeKind: Schema.Literal("publisher_text"),
  content: Schema.Struct({
    id: Schema.String,
    language: Schema.String,
    canonicalText: Schema.String,
    pageRanges: Schema.Array(SupportPageRange),
  }),
});
const SupportClientChatContent = Schema.Struct({
  accessLogId: Schema.String,
  scopeKind: Schema.Literal("client_chat"),
  content: Schema.Struct({
    id: Schema.String,
    messages: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        author: Schema.String,
        content: Schema.String,
        createdAt: Schema.String,
      }),
    ),
  }),
});
const SupportMemoryRevision = Schema.Struct({
  id: Schema.String,
  action: Schema.Literals(["create", "update", "delete", "revert"]),
  stateBefore: Schema.NullOr(MemorySnapshot),
  stateAfter: MemorySnapshot,
  createdAt: Schema.String,
});
const SupportClientMemoryContent = Schema.Struct({
  accessLogId: Schema.String,
  scopeKind: Schema.Literal("client_memory"),
  content: Schema.Struct({
    id: Schema.String,
    userId: Schema.String,
    kind: Schema.NullOr(Schema.String),
    content: Schema.NullOr(Schema.String),
    deletedAt: Schema.NullOr(Schema.String),
    revisions: Schema.Array(SupportMemoryRevision),
  }),
});
const RestrictedSupportContentResponse = Schema.Union([
  SupportPublisherTextContent,
  SupportClientChatContent,
  SupportClientMemoryContent,
]);

/**
 * Complete canonical route matrix. Its keys are intentionally the same stable
 * `METHOD path-template` identifiers used by Effect HTTP registration.
 */
export const httpRouteContracts: Readonly<Record<string, HttpRouteContract>> = {
  "GET /health": contract(noBody, jsonSuccess(HealthResponse)),
  "GET /v1/public-sources": withQuery(
    contract(noBody, jsonSuccess(PublicSourcesResponse)),
    PublicSourcesQuery,
  ),
  "PUT /v1/public-sources/:sourceId": withQuery(
    contract(
      jsonBody(UpdateClientPublicSourceRequest, 16 * 1024),
      jsonSuccess(PublicSourcesResponse),
    ),
    PublicSourcesQuery,
  ),
  "GET /public-source-documents/:documentId/content": contract(
    noBody,
    binarySuccess(["application/pdf", "text/html"]),
  ),
  "POST /v1/identity/clerk/webhook": withHeaders(
    contract(rawBody(1024 * 1024), jsonSuccess(WebhookProcessedResponse)),
    [
      "svix-id",
      "svix-timestamp",
      "svix-signature",
      "webhook-id",
      "webhook-timestamp",
      "webhook-signature",
    ],
    ClerkWebhookHeaders,
  ),
  "POST /v1/billing/stripe/webhook": withHeaders(
    contract(rawBody(1024 * 1024), jsonSuccess(StripeWebhookResponse)),
    ["stripe-signature"],
    StripeWebhookHeaders,
  ),
  "POST /v1/client-companies/:companyId/billing/checkout": contract(
    jsonBody(CreateBillingCheckoutRequest, 32 * 1024),
    jsonSuccess(ExternalNavigationResponse, [201]),
  ),
  "POST /v1/client-companies/:companyId/billing/plan-change": contract(
    jsonBody(ChangeMonthlyPlanRequest, 32 * 1024),
    jsonSuccess(ChangeMonthlyPlanResponse),
  ),
  "POST /v1/client-companies/:companyId/billing/portal": contract(
    emptyBody,
    jsonSuccess(ExternalNavigationResponse, [201]),
  ),
  "GET /v1/client-companies/:companyId/ai-usage": contract(noBody, jsonSuccess(AiUsageResponse)),
  "PUT /v1/client-companies/:companyId/ai-limit": contract(
    jsonBody(UpdateCompanyAiLimitRequest, 32 * 1024),
    jsonSuccess(StatusUpdatedResponse),
  ),
  "PUT /v1/client-companies/:companyId/members/:userId/ai-limit": contract(
    jsonBody(UpdateEmployeeAiLimitRequest, 32 * 1024),
    jsonSuccess(StatusUpdatedResponse),
  ),
  "POST /v1/client-companies/:companyId/ai-usage-requests": contract(
    jsonBody(CreateAiUsageRequest, 32 * 1024),
    jsonSuccess(AiUsageRequestResponse, [201]),
  ),
  "POST /v1/client-companies/:companyId/ai-usage-requests/:requestId/resolve": contract(
    jsonBody(ResolveAiUsageRequest, 32 * 1024),
    jsonSuccess(AiUsageResolutionResponse),
  ),
  "GET /v1/chat": contract(noBody, jsonSuccess(GetChatResponse)),
  "POST /v1/demo/session": contract(emptyBody, jsonSuccess(DemoSessionResponse)),
  "POST /v1/chat/messages": errorBodyContract(
    jsonBody(SendChatMessageRequest),
    jsonSuccess(SendChatMessageAccepted, [202]),
  ),
  "GET /v1/chats/:chatId": contract(noBody, jsonSuccess(GetChatResponse)),
  "POST /v1/chats/:chatId/messages": errorBodyContract(
    jsonBody(SendChatMessageRequest),
    jsonSuccess(SendChatMessageAccepted, [202]),
  ),
  "GET /v1/ai-runs/:runId/stream": withQueryAndHeaders(
    contract(noBody, sseSuccess),
    AiRunStreamQuery,
    ["last-event-id"],
    AiRunStreamHeaders,
  ),
  "GET /v1/client-companies/:companyId/subscription-accesses": contract(
    noBody,
    jsonSuccess(SourceAccessListResponse),
  ),
  "GET /v1/client-companies/:companyId/public-sources": contract(
    noBody,
    jsonSuccess(ClientPublicSourcesResponse),
  ),
  "PUT /v1/client-companies/:companyId/public-sources/:sourceId": contract(
    jsonBody(UpdateClientPublicSourceRequest, 16 * 1024),
    jsonSuccess(ClientPublicSourceResponse),
  ),
  "GET /v1/client-companies/:companyId/web-policy": contract(
    noBody,
    jsonSuccess(ClientWebPolicyResponse),
  ),
  "PUT /v1/client-companies/:companyId/web-policy": contract(
    jsonBody(UpdateClientWebPolicyRequest, 16 * 1024),
    jsonSuccess(ClientWebPolicyResponse),
  ),
  "GET /v1/client-companies/:companyId/deletion-requests": contract(
    noBody,
    jsonSuccess(CompanyDeletionRequestsResponse),
  ),
  "POST /v1/client-companies/:companyId/deletion-requests": contract(
    jsonBody(RequestCompanyDeletionRequest, 16 * 1024),
    jsonSuccess(CompanyDeletionRequestsResponse, [201]),
  ),
  "GET /v1/client-companies/:companyId/archive": withQuery(
    contract(noBody, jsonSuccess(ArchiveResponse)),
    ArchiveQuery,
  ),
  "GET /v1/issues/:issueId": contract(noBody, jsonSuccess(IssueDetailResponse)),
  "GET /v1/client-companies/:companyId/notifications": withQuery(
    contract(noBody, jsonSuccess(NotificationListResponse)),
    NotificationQuery,
  ),
  "POST /v1/notifications/:notificationId/read": contract(
    emptyBody,
    jsonSuccess(NotificationReadResponse),
  ),
  "GET /v1/client-companies/:companyId/notification-preferences": contract(
    noBody,
    jsonSuccess(NotificationPreferencesResponse),
  ),
  "PUT /v1/client-companies/:companyId/notification-preferences": contract(
    jsonBody(NotificationPreferences, 16 * 1024),
    jsonSuccess(NotificationPreferencesResponse),
  ),
  "POST /v1/exports": contract(
    jsonBody(CreateExportRequest, 16 * 1024),
    jsonSuccess(CreateExportResponse, [202]),
  ),
  "GET /v1/exports/:exportId": contract(noBody, jsonSuccess(ExportResponse)),
  "GET /v1/exports/:exportId/download": contract(noBody, redirectSuccess),
  "GET /v1/memories": contract(noBody, jsonSuccess(ListMemoriesResponse)),
  "GET /v1/memories/:memoryId/revisions/:revisionId": contract(
    noBody,
    jsonSuccess(MemoryRevisionResponse),
  ),
  "POST /v1/memories/:memoryId/revert": errorBodyContract(
    jsonBody(RevertMemoryRequest),
    jsonSuccess(MemoryRecord),
  ),
  "DELETE /v1/memories/:memoryId": errorBodyContract(emptyBody, jsonSuccess(MemoryRecord)),
  "GET /v1/chats": withQuery(
    contract(noBody, jsonSuccess(ProductChatListResponse)),
    ProductChatsQuery,
  ),
  "POST /v1/chats": errorBodyContract(
    jsonBody(CreateProductChatRequest),
    jsonSuccess(CreateProductChatResponse, [201]),
  ),
  "POST /v1/chats/:chatId/share": errorBodyContract(emptyBody, jsonSuccess(ShareChatResponse)),
  "POST /v1/chats/:chatId/unshare": errorBodyContract(emptyBody, jsonSuccess(UnshareChatResponse)),
  "DELETE /v1/chats/:chatId": errorBodyContract(emptyBody, emptySuccess),
  "POST /v1/chats/:chatId/reset": errorBodyContract(
    jsonBody(ResetProductChatRequest),
    jsonSuccess(ResetProductChatResponse),
  ),
  "GET /v1/platform/company-deletion-requests": contract(
    noBody,
    jsonSuccess(PlatformCompanyDeletionRequestsResponse),
  ),
  "POST /v1/platform/company-deletion-requests/:requestId/decision": contract(
    jsonBody(ResolveCompanyDeletionRequest, 32 * 1024),
    jsonSuccess(PlatformCompanyDeletionDecisionResponse),
  ),
  "GET /v1/platform/operations": contract(noBody, jsonSuccess(PlatformOperationsResponse)),
  "GET /v1/platform/support/grants": contract(noBody, jsonSuccess(ActiveSupportGrantsResponse)),
  "POST /v1/platform/support/grants": contract(
    jsonBody(CreateRestrictedSupportGrantRequest, 32 * 1024),
    jsonSuccess(SupportGrantResponse, [201]),
  ),
  "GET /v1/platform/support/grants/:grantId/content": contract(
    noBody,
    jsonSuccess(RestrictedSupportContentResponse),
    redirectSuccess,
  ),
  "POST /v1/platform/support/access/:accessId/review": contract(
    jsonBody(ReviewRestrictedSupportAccessRequest, 32 * 1024),
    jsonSuccess(RestrictedSupportReviewResponse, [201]),
  ),
  "GET /v1/platform/support/access": contract(noBody, jsonSuccess(RestrictedAccessListResponse)),
  "POST /v1/platform/issues/:issueId/restriction": contract(
    jsonBody(RestrictIssueRequest, 32 * 1024),
    RestrictionChangedResponse,
  ),
  "DELETE /v1/platform/issues/:issueId/restriction": contract(
    emptyBody,
    RestrictionChangedResponse,
  ),
  "GET /v1/publisher-companies/:companyId/subscriptions": contract(
    noBody,
    jsonSuccess(PublisherSubscriptionListResponse),
  ),
  "POST /v1/publisher-companies/:companyId/subscriptions": contract(
    jsonBody(CreatePublisherSubscriptionRequest),
    jsonSuccess(PublisherSubscriptionResponse, [201]),
  ),
  "GET /v1/publisher-subscriptions/:subscriptionId/issues": contract(
    noBody,
    jsonSuccess(PublisherIssueListResponse),
  ),
  "POST /v1/publisher-subscriptions/:subscriptionId/issues": contract(
    jsonBody(CreatePublisherIssueRequest),
    jsonSuccess(PublisherIssueResponse, [201]),
  ),
  "GET /v1/publisher-issues/:issueId": contract(noBody, jsonSuccess(IssueDetailResponse)),
  "PATCH /v1/publisher-issues/:issueId": contract(
    jsonBody(UpdatePublisherIssueRequest),
    jsonSuccess(PublisherIssueResponse),
  ),
  "DELETE /v1/publisher-issues/:issueId": contract(emptyBody, emptySuccess),
  "POST /v1/publisher-issues/:issueId/schedule": contract(
    jsonBody(SchedulePublisherIssueRequest),
    jsonSuccess(ScheduledIssueResponse, [202]),
  ),
  "POST /v1/publisher-issues/:issueId/publish": contract(
    emptyBody,
    jsonSuccess(PublishedIssueResponse, [200, 202]),
  ),
  "POST /v1/publisher-issues/:issueId/documents": withHeaders(
    contract(
      binaryBody(["application/pdf"], 50 * 1024 * 1024),
      jsonSuccess(BriefDocumentResponse, [201]),
    ),
    ["idempotency-key", "x-brief-title", "x-file-name", "x-content-sha256"],
    PublisherPdfUploadHeaders,
  ),
  "DELETE /v1/publisher-issues/:issueId/documents/:documentId": contract(emptyBody, emptySuccess),
  "GET /v1/publisher-subscriptions/:subscriptionId/client-accesses": contract(
    noBody,
    jsonSuccess(PublisherClientAccessListResponse),
  ),
  "POST /v1/publisher-subscriptions/:subscriptionId/client-accesses": contract(
    jsonBody(InvitePublisherClientAccessRequest),
    jsonSuccess(PublisherClientAccessResponse, [200, 201]),
  ),
  "POST /v1/client-subscription-accesses/:accessId/pause": contract(
    jsonBody(PausePublisherClientAccessRequest),
    jsonSuccess(PausePublisherClientAccessResponse),
  ),
  "GET /v1/publisher-subscriptions/:subscriptionId/ai-pull-metrics": contract(
    noBody,
    jsonSuccess(PublisherAiPullMetricsResponse),
  ),
  "POST /v1/platform/publisher-companies": contract(
    jsonBody(CreatePublisherCompanyOnboardingRequest, 16 * 1024),
    jsonSuccess(PublisherCompanyOnboardingResponse, [200, 201]),
  ),
  "GET /v1/me/workspaces": contract(noBody, jsonSuccess(CurrentUserWorkspacesResponse)),
  "GET /v1/publisher-companies/:companyId/members": contract(
    noBody,
    jsonSuccess(PublisherMemberListResponse),
  ),
  "POST /v1/publisher-companies/:companyId/members": contract(
    jsonBody(InvitePublisherMemberRequest, 32 * 1024),
    jsonSuccess(PublisherInvitationResponse, [200, 201]),
  ),
  "GET /v1/client-companies/:companyId/members": contract(
    noBody,
    jsonSuccess(ClientMemberListResponse),
  ),
  "POST /v1/client-companies/:companyId/members": contract(
    jsonBody(InviteClientMemberRequest, 32 * 1024),
    jsonSuccess(ClientInvitationResponse, [200, 201]),
  ),
  "PATCH /v1/publisher-companies/:companyId/members/:userId": contract(
    jsonBody(UpdatePublisherMemberRequest, 32 * 1024),
    jsonSuccess(StatusUpdatedResponse),
  ),
  "DELETE /v1/publisher-companies/:companyId/members/:userId": contract(emptyBody, emptySuccess),
  "PATCH /v1/client-companies/:companyId/members/:userId": contract(
    jsonBody(UpdateClientMemberRequest, 32 * 1024),
    jsonSuccess(StatusUpdatedResponse),
  ),
  "DELETE /v1/client-companies/:companyId/members/:userId": contract(emptyBody, emptySuccess),
  "POST /v1/client-companies/:companyId/members/:userId/subscription-grants": contract(
    jsonBody(GrantClientSubscriptionRequest, 32 * 1024),
    jsonSuccess(SubscriptionGrantResponse, [201]),
  ),
  "DELETE /v1/client-companies/:companyId/members/:userId/subscription-grants/:accessId": contract(
    emptyBody,
    emptySuccess,
  ),
  "GET /v1/issues/:issueId/documents/:documentId/content": contract(noBody, redirectSuccess),
};

export const httpRouteContract = (method: string, path: string): HttpRouteContract | undefined =>
  httpRouteContracts[`${method} ${path}`];

// Re-exported to make the exact support-document range contract available to
// support tooling without broad JSON/unknown escape hatches.
export const RestrictedSupportPageRange = SupportPageRange;
export const PublicDocumentSourceRange = SourceRange;
