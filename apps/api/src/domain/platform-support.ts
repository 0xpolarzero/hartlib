import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  changeIssueRestriction,
  companyDeletionDescriptor,
  createRestrictedSupportGrant,
  createRestrictedSupportReview,
  listActiveSupportGrants,
  listRestrictedSupportAccess,
  loadPlatformOperations,
  loadRestrictedSupportContent,
  resolveCompanyDeletionRequest,
  recordRestrictedSupportAccess,
  selectCompanyDeletionRequests,
  selectRestrictedSupportGrant,
  type RestrictedFileRow,
} from "@brief/backend-domain/platform-support";
import { loadObjectStorageConfig } from "@brief/config";
import type {
  CreateRestrictedSupportGrantRequest,
  RestrictIssueRequest,
  ResolveCompanyDeletionRequest,
  ReviewRestrictedSupportAccessRequest,
} from "@brief/shared";
import {
  WorkspaceAuthorizationError as AuthorizationError,
  requirePlatformAdminRole,
  type WorkspacePlatformAdminRole as PlatformAdminRole,
} from "@brief/workspace";
import { Effect } from "effect";

import { resolveRequestIdentity, type RequestIdentity } from "../auth";
import { loadApiConfig } from "../config";
import { ApiDatabaseLayer, type ApiDatabaseLayer as ApiDatabaseLayerType } from "../database";
import { json, type Route } from "../http";
import {
  appendAuthorizationAudit,
  appendDeniedAuthorizationAudit,
  requestIdForAudit,
} from "@brief/workspace";
import { withAdministrativeAuditing } from "./administrative-audit";

const allPlatformRoles = new Set<PlatformAdminRole>(["admin", "support", "security", "legal"]);
const elevatedPlatformRoles = new Set<PlatformAdminRole>(["admin", "security", "legal"]);
const deletionDecisionRoles = new Set<PlatformAdminRole>(["admin", "legal"]);

const authenticate = (request: Request) =>
  Effect.gen(function* () {
    const config = yield* loadApiConfig;
    return yield* resolveRequestIdentity(request, config);
  });

const requireRole = (
  identity: RequestIdentity,
  roles: ReadonlySet<PlatformAdminRole>,
  databaseLayer: ApiDatabaseLayerType,
) =>
  requirePlatformAdminRole(identity, roles).pipe(
    Effect.provide(databaseLayer),
    Effect.match({
      onFailure: (error) => ({ ok: false as const, error }),
      onSuccess: (role) => ({ ok: true as const, role }),
    }),
  );

const forbidden = (error: unknown): Response =>
  json(
    {
      code:
        error instanceof AuthorizationError && error.code === "mfa_required"
          ? "mfa_required"
          : "forbidden",
    },
    { status: 403 },
  );

interface RestrictedFileSignerInput extends RestrictedFileRow {
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly expiresInSeconds: number;
}

export type RestrictedFileSigner = (input: RestrictedFileSignerInput) => Promise<string>;

const signRestrictedFile: RestrictedFileSigner = async (input) => {
  const client = new S3Client({
    endpoint: input.endpoint,
    region: "auto",
    forcePathStyle: true,
    credentials: { accessKeyId: input.accessKeyId, secretAccessKey: input.secretAccessKey },
  });
  const fileName = input.fileName.replace(/["\r\n]/gu, "_");
  return getSignedUrl(
    client,
    new GetObjectCommand({
      Bucket: input.bucket,
      Key: input.objectKey,
      ResponseContentType: input.mediaType,
      ResponseContentDisposition: `inline; filename="${fileName}"`,
    }),
    { expiresIn: input.expiresInSeconds },
  );
};

const storageConfig = Effect.gen(function* () {
  const storage = yield* loadObjectStorageConfig;
  return storage.configured ? storage : null;
});

const audit = (
  databaseLayer: ApiDatabaseLayerType,
  identity: RequestIdentity,
  input: {
    readonly requestId: string;
    readonly action: string;
    readonly scopeKind: string;
    readonly scopeId: string;
    readonly outcome: "succeeded" | "denied";
    readonly reasonCode?: string;
  },
) => appendAuthorizationAudit({ identity, ...input }).pipe(Effect.provide(databaseLayer));

const auditDenied = (
  databaseLayer: ApiDatabaseLayerType,
  identity: RequestIdentity,
  input: {
    readonly requestId: string;
    readonly action: string;
    readonly scopeKind: string;
    readonly scopeId: string;
    readonly error: unknown;
  },
) => appendDeniedAuthorizationAudit({ identity, ...input }).pipe(Effect.provide(databaseLayer));

export const makePlatformSupportRoutes = (
  databaseLayer: ApiDatabaseLayerType = ApiDatabaseLayer,
  signer: RestrictedFileSigner = signRestrictedFile,
): readonly Route[] =>
  withAdministrativeAuditing(
    [
      {
        method: "GET",
        path: "/v1/platform/company-deletion-requests",
        execute: (request) =>
          Effect.gen(function* () {
            const authentication = yield* authenticate(request);
            if (!authentication.authenticated)
              return json({ code: "unauthorized" }, { status: 401 });
            const role = yield* requireRole(
              authentication.identity,
              deletionDecisionRoles,
              databaseLayer,
            );
            if (!role.ok) return forbidden(role.error);
            const requests = yield* selectCompanyDeletionRequests().pipe(
              Effect.provide(databaseLayer),
            );
            return json(
              { requests: requests.map(companyDeletionDescriptor) },
              { headers: { "cache-control": "private, no-store" } },
            );
          }),
      },
      {
        method: "POST",
        path: "/v1/platform/company-deletion-requests/:requestId/decision",
        execute: (request, _url, pathParameters, input) =>
          Effect.gen(function* () {
            const authentication = yield* authenticate(request);
            if (!authentication.authenticated)
              return json({ code: "unauthorized" }, { status: 401 });
            const auditRequestId = requestIdForAudit(request);
            if (auditRequestId === null)
              return json({ code: "request_id_invalid" }, { status: 400 });
            const deletionRequestId = pathParameters.requestId!;
            const role = yield* requireRole(
              authentication.identity,
              deletionDecisionRoles,
              databaseLayer,
            );
            if (!role.ok) {
              yield* auditDenied(databaseLayer, authentication.identity, {
                requestId: auditRequestId,
                action: "platform.company_deletion.resolve",
                scopeKind: "company_deletion_request",
                scopeId: deletionRequestId,
                error: role.error,
              });
              return forbidden(role.error);
            }
            const body = input.body as ResolveCompanyDeletionRequest;
            if (!/^[A-Za-z0-9._:-]{16,200}$/u.test(body.idempotencyKey)) {
              yield* auditDenied(databaseLayer, authentication.identity, {
                requestId: auditRequestId,
                action: "platform.company_deletion.resolve",
                scopeKind: "company_deletion_request",
                scopeId: deletionRequestId,
                error: new Error("invalid_request"),
              });
              return json({ code: "invalid_request" }, { status: 400 });
            }
            const result = yield* resolveCompanyDeletionRequest({
              deletionRequestId,
              decision: body.decision,
              idempotencyKey: body.idempotencyKey,
              actorUserId: authentication.identity.userId,
              auditSucceeded: (companyId) =>
                appendAuthorizationAudit({
                  identity: authentication.identity,
                  requestId: auditRequestId,
                  action: "platform.company_deletion.resolve",
                  scopeKind: "client_company",
                  scopeId: companyId,
                  outcome: "succeeded",
                }),
            }).pipe(
              Effect.provide(databaseLayer),
              Effect.match({
                onFailure: (error) => ({ ok: false as const, error }),
                onSuccess: (value) => ({ ok: true as const, value }),
              }),
            );
            if (!result.ok) {
              yield* auditDenied(databaseLayer, authentication.identity, {
                requestId: auditRequestId,
                action: "platform.company_deletion.resolve",
                scopeKind: "company_deletion_request",
                scopeId: deletionRequestId,
                error: result.error,
              });
              const code = result.error instanceof Error ? result.error.message : "decision_failed";
              if (code === "deletion_request_not_found")
                return json({ code: "not_found" }, { status: 404 });
              if (
                [
                  "deletion_request_already_resolved",
                  "company_deletion_already_scheduled",
                ].includes(code)
              ) {
                return json({ code }, { status: 409 });
              }
              return yield* Effect.fail(result.error);
            }
            return json({
              request: companyDeletionDescriptor(result.value.row),
              duplicate: result.value.duplicate,
            });
          }),
      },
      {
        method: "GET",
        path: "/v1/platform/operations",
        execute: (request) =>
          Effect.gen(function* () {
            const authentication = yield* authenticate(request);
            if (!authentication.authenticated)
              return json({ code: "unauthorized" }, { status: 401 });
            const role = yield* requireRole(
              authentication.identity,
              allPlatformRoles,
              databaseLayer,
            );
            if (!role.ok) return forbidden(role.error);
            const operations = yield* loadPlatformOperations(role.role).pipe(
              Effect.provide(databaseLayer),
            );
            return json(
              { role: role.role, ...operations },
              { headers: { "cache-control": "no-store" } },
            );
          }),
      },
      {
        method: "GET",
        path: "/v1/platform/support/grants",
        execute: (request) =>
          Effect.gen(function* () {
            const authentication = yield* authenticate(request);
            if (!authentication.authenticated)
              return json({ code: "unauthorized" }, { status: 401 });
            const role = yield* requireRole(
              authentication.identity,
              allPlatformRoles,
              databaseLayer,
            );
            if (!role.ok) return forbidden(role.error);
            const grants = yield* listActiveSupportGrants(authentication.identity.userId).pipe(
              Effect.provide(databaseLayer),
            );
            return json({ grants }, { headers: { "cache-control": "private, no-store" } });
          }),
      },
      {
        method: "POST",
        path: "/v1/platform/support/grants",
        execute: (request, _url, _pathParameters, input) =>
          Effect.gen(function* () {
            const authentication = yield* authenticate(request);
            if (!authentication.authenticated)
              return json({ code: "unauthorized" }, { status: 401 });
            const auditRequestId = requestIdForAudit(request);
            if (auditRequestId === null)
              return json({ code: "request_id_invalid" }, { status: 400 });
            const body = input.body as CreateRestrictedSupportGrantRequest;
            const role = yield* requireRole(
              authentication.identity,
              elevatedPlatformRoles,
              databaseLayer,
            );
            if (!role.ok) {
              yield* auditDenied(databaseLayer, authentication.identity, {
                requestId: auditRequestId,
                action: "platform.support.grant_create",
                scopeKind: body.scopeKind,
                scopeId: body.scopeId,
                error: role.error,
              });
              return forbidden(role.error);
            }
            const expiry = new Date(body.expiresAt);
            const now = new Date();
            const approval = body.customerApprovalReference?.trim() ?? "";
            const skipped = body.approvalSkippedReason?.trim() ?? "";
            if (
              body.reason.trim().length < 8 ||
              body.reason.length > 2_000 ||
              body.scopeId.trim() === "" ||
              !Number.isFinite(expiry.getTime()) ||
              expiry <= now ||
              expiry.getTime() > now.getTime() + 8 * 60 * 60 * 1_000 ||
              (approval === "") === (skipped === "")
            ) {
              yield* auditDenied(databaseLayer, authentication.identity, {
                requestId: auditRequestId,
                action: "platform.support.grant_create",
                scopeKind: body.scopeKind,
                scopeId: body.scopeId,
                error: new Error("invalid_request"),
              });
              return json({ code: "invalid_request" }, { status: 400 });
            }
            const created = yield* createRestrictedSupportGrant({
              request: body,
              approvalReference: approval || null,
              approvalSkippedReason: skipped || null,
              grantedByUserId: authentication.identity.userId,
              expiresAt: expiry,
              auditSucceeded: appendAuthorizationAudit({
                identity: authentication.identity,
                requestId: auditRequestId,
                action: "platform.support.grant_create",
                scopeKind: body.scopeKind,
                scopeId: body.scopeId,
                outcome: "succeeded",
              }),
            }).pipe(
              Effect.provide(databaseLayer),
              Effect.match({
                onFailure: (error) => ({ ok: false as const, error }),
                onSuccess: (id) => ({ ok: true as const, id }),
              }),
            );
            if (!created.ok) {
              if (
                !(created.error instanceof Error) ||
                created.error.message !== "invalid_support_scope"
              ) {
                return yield* Effect.fail(created.error);
              }
              yield* auditDenied(databaseLayer, authentication.identity, {
                requestId: auditRequestId,
                action: "platform.support.grant_create",
                scopeKind: body.scopeKind,
                scopeId: body.scopeId,
                error: new Error("invalid_support_scope"),
              });
              return json({ code: "invalid_support_scope" }, { status: 400 });
            }
            return json(
              { grant: { id: created.id, expiresAt: expiry.toISOString() } },
              { status: 201 },
            );
          }),
      },
      {
        method: "GET",
        path: "/v1/platform/support/grants/:grantId/content",
        execute: (request, _url, pathParameters) =>
          Effect.gen(function* () {
            const authentication = yield* authenticate(request);
            if (!authentication.authenticated)
              return json({ code: "unauthorized" }, { status: 401 });
            const auditRequestId = requestIdForAudit(request);
            if (auditRequestId === null)
              return json({ code: "request_id_invalid" }, { status: 400 });
            const role = yield* requireRole(
              authentication.identity,
              allPlatformRoles,
              databaseLayer,
            );
            if (!role.ok) return forbidden(role.error);
            const grantId = pathParameters.grantId!;
            const grant = yield* selectRestrictedSupportGrant(
              grantId,
              authentication.identity.userId,
            ).pipe(Effect.provide(databaseLayer));
            if (grant === null) return json({ code: "not_found" }, { status: 404 });
            const log = yield* recordRestrictedSupportAccess(authentication.identity, {
              grantId,
              scopeKind: grant.scopeKind,
              scopeId: grant.scopeId,
            }).pipe(
              Effect.provide(databaseLayer),
              Effect.match({ onFailure: () => null, onSuccess: (value) => value }),
            );
            if (log === null) return json({ code: "support_grant_required" }, { status: 403 });
            const content = yield* loadRestrictedSupportContent(grant).pipe(
              Effect.provide(databaseLayer),
            );
            if (content === null) return json({ code: "not_found" }, { status: 404 });
            yield* audit(databaseLayer, authentication.identity, {
              requestId: auditRequestId,
              action: "platform.support.content_open",
              scopeKind: grant.scopeKind,
              scopeId: grant.scopeId,
              outcome: "succeeded",
            });
            if (grant.scopeKind !== "publisher_file") {
              return json(
                { accessLogId: log, scopeKind: grant.scopeKind, content },
                { headers: { "cache-control": "private, no-store" } },
              );
            }
            const config = yield* storageConfig;
            if (config === null)
              return json({ code: "document_storage_unavailable" }, { status: 503 });
            const file = content as RestrictedFileRow;
            const location = yield* Effect.tryPromise(() =>
              signer({ ...config, ...file, expiresInSeconds: 300 }),
            );
            return new Response(null, {
              status: 302,
              headers: {
                location,
                "cache-control": "private, no-store",
                "referrer-policy": "no-referrer",
                "x-support-access-log-id": log,
              },
            });
          }),
      },
      {
        method: "POST",
        path: "/v1/platform/support/access/:accessId/review",
        execute: (request, _url, pathParameters, input) =>
          Effect.gen(function* () {
            const authentication = yield* authenticate(request);
            if (!authentication.authenticated)
              return json({ code: "unauthorized" }, { status: 401 });
            const auditRequestId = requestIdForAudit(request);
            if (auditRequestId === null)
              return json({ code: "request_id_invalid" }, { status: 400 });
            const accessLogId = pathParameters.accessId!;
            const role = yield* requireRole(
              authentication.identity,
              elevatedPlatformRoles,
              databaseLayer,
            );
            if (!role.ok) {
              yield* auditDenied(databaseLayer, authentication.identity, {
                requestId: auditRequestId,
                action: "platform.support.access_review",
                scopeKind: "support_access_log",
                scopeId: accessLogId,
                error: role.error,
              });
              return forbidden(role.error);
            }
            const decoded = input.body as ReviewRestrictedSupportAccessRequest;
            if (decoded.notes.trim().length < 4 || decoded.notes.length > 2_000) {
              yield* auditDenied(databaseLayer, authentication.identity, {
                requestId: auditRequestId,
                action: "platform.support.access_review",
                scopeKind: "support_access_log",
                scopeId: accessLogId,
                error: new Error("invalid_request"),
              });
              return json({ code: "invalid_request" }, { status: 400 });
            }
            const reviewed = yield* createRestrictedSupportReview({
              accessLogId,
              reviewerUserId: authentication.identity.userId,
              decision: decoded.decision,
              notes: decoded.notes,
              auditSucceeded: appendAuthorizationAudit({
                identity: authentication.identity,
                requestId: auditRequestId,
                action: "platform.support.access_review",
                scopeKind: "support_access_log",
                scopeId: accessLogId,
                outcome: "succeeded",
              }),
            }).pipe(
              Effect.provide(databaseLayer),
              Effect.match({
                onFailure: (error) => ({ ok: false as const, error }),
                onSuccess: (id) => ({ ok: true as const, id }),
              }),
            );
            if (!reviewed.ok) return yield* Effect.fail(reviewed.error);
            if (reviewed.id === null) {
              yield* auditDenied(databaseLayer, authentication.identity, {
                requestId: auditRequestId,
                action: "platform.support.access_review",
                scopeKind: "support_access_log",
                scopeId: accessLogId,
                error: new Error("review_conflict"),
              });
              return json({ code: "review_conflict" }, { status: 409 });
            }
            return json(
              { review: { id: reviewed.id, decision: decoded.decision } },
              { status: 201 },
            );
          }),
      },
      {
        method: "GET",
        path: "/v1/platform/support/access",
        execute: (request) =>
          Effect.gen(function* () {
            const authentication = yield* authenticate(request);
            if (!authentication.authenticated)
              return json({ code: "unauthorized" }, { status: 401 });
            const role = yield* requireRole(
              authentication.identity,
              allPlatformRoles,
              databaseLayer,
            );
            if (!role.ok) return forbidden(role.error);
            const accesses = yield* listRestrictedSupportAccess.pipe(Effect.provide(databaseLayer));
            return json({ accesses });
          }),
      },
      ...(["POST", "DELETE"] as const).map(
        (method): Route => ({
          method,
          path: "/v1/platform/issues/:issueId/restriction",
          execute: (request, _url, pathParameters, input) =>
            Effect.gen(function* () {
              const authentication = yield* authenticate(request);
              if (!authentication.authenticated)
                return json({ code: "unauthorized" }, { status: 401 });
              const auditRequestId = requestIdForAudit(request);
              if (auditRequestId === null)
                return json({ code: "request_id_invalid" }, { status: 400 });
              const issueId = pathParameters.issueId!;
              const action =
                method === "POST" ? "platform.issue.restrict" : "platform.issue.restriction_remove";
              const role = yield* requireRole(
                authentication.identity,
                elevatedPlatformRoles,
                databaseLayer,
              );
              if (!role.ok) {
                yield* auditDenied(databaseLayer, authentication.identity, {
                  requestId: auditRequestId,
                  action,
                  scopeKind: "issue",
                  scopeId: issueId,
                  error: role.error,
                });
                return forbidden(role.error);
              }
              let reason: string | null = null;
              if (method === "POST") {
                const body = input.body as RestrictIssueRequest;
                if (body.reason.trim().length < 8 || body.reason.length > 2_000) {
                  yield* auditDenied(databaseLayer, authentication.identity, {
                    requestId: auditRequestId,
                    action,
                    scopeKind: "issue",
                    scopeId: issueId,
                    error: new Error("invalid_request"),
                  });
                  return json({ code: "invalid_request" }, { status: 400 });
                }
                reason = body.reason.trim();
              }
              const changed = yield* changeIssueRestriction({
                issueId,
                actorUserId: authentication.identity.userId,
                reason,
                restrict: method === "POST",
                auditSucceeded: appendAuthorizationAudit({
                  identity: authentication.identity,
                  requestId: auditRequestId,
                  action,
                  scopeKind: "issue",
                  scopeId: issueId,
                  outcome: "succeeded",
                }),
              }).pipe(Effect.provide(databaseLayer));
              if (!changed) {
                yield* auditDenied(databaseLayer, authentication.identity, {
                  requestId: auditRequestId,
                  action,
                  scopeKind: "issue",
                  scopeId: issueId,
                  error: new Error("not_found_or_unchanged"),
                });
                return json({ code: "not_found_or_unchanged" }, { status: 404 });
              }
              return new Response(null, { status: 204 });
            }),
        }),
      ),
    ],
    databaseLayer,
  );

export const platformSupportRoutes = makePlatformSupportRoutes();
