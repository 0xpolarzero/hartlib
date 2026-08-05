import type {
  NotificationPreferences,
  RequestCompanyDeletionRequest,
  UpdateClientPublicSourceRequest,
  UpdateClientWebPolicyRequest,
} from "@hartlib/shared";
import {
  createCompanyDeletionRequest,
  getClientIssue,
  getClientWebPolicy,
  getNotificationPreferences,
  listClientNotifications,
  listClientPublicSources,
  listClientSubscriptionAccesses,
  listCompanyDeletionRequests,
  listDeliveredArchive,
  markClientNotificationRead,
  normalizeWorkspaceDomainAllowlist,
  updateClientPublicSource,
  updateClientWebPolicy,
  updateNotificationPreferences,
  WorkspaceAuthorizationError,
  WorkspaceRuleError,
} from "@hartlib/workspace";
import { requestIdForAudit } from "@hartlib/workspace";
import { Effect } from "effect";

import { resolveRequestIdentity } from "../auth";
import { loadApiConfig } from "../config";
import {
  ApiDatabaseLayer,
  type ApiDatabaseLayer as ApiDatabaseLayerType,
  type ApiDatabaseService,
} from "../database";
import { json, type Route } from "../http";
import { withAdministrativeAuditing } from "./administrative-audit";

type PgLayer = ApiDatabaseLayerType;
const PgLayer = ApiDatabaseLayer;

const authenticate = (request: Request) =>
  Effect.gen(function* () {
    const config = yield* loadApiConfig;
    return yield* resolveRequestIdentity(request, config);
  });

const provided = <A, E>(effect: Effect.Effect<A, E, ApiDatabaseService>, pgLayer: PgLayer) =>
  effect.pipe(
    Effect.provide(pgLayer),
    Effect.match({
      onFailure: (error) => ({ ok: false as const, error }),
      onSuccess: (value) => ({ ok: true as const, value }),
    }),
  );

const authResponse = (error: unknown) =>
  error instanceof WorkspaceAuthorizationError
    ? json({ code: error.code }, { status: error.code === "mfa_required" ? 403 : 404 })
    : null;

const page = (query: Readonly<Record<string, unknown>>) => {
  const rawLimit = Number(query.limit ?? "25");
  if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 50) return null;
  const rawCursor = query.cursor;
  if (rawCursor === undefined) return { limit: rawLimit, offset: 0 };
  try {
    const offset = Number(atob(String(rawCursor)));
    return Number.isSafeInteger(offset) && offset >= 0 ? { limit: rawLimit, offset } : null;
  } catch {
    return null;
  }
};

const nextCursor = (offset: number, count: number, limit: number) =>
  count < limit ? null : btoa(String(offset + count));

const domainFailure = (error: unknown) => {
  const authorization = authResponse(error);
  if (authorization !== null) return authorization;
  if (error instanceof WorkspaceRuleError) {
    const status =
      error.code === "idempotency_conflict"
        ? 409
        : error.code === "web_research_deployment_unavailable"
          ? 409
          : 400;
    return json({ code: error.code }, { status });
  }
  return null;
};

export const makeClientWorkspaceRoutes = (pgLayer: PgLayer = PgLayer): readonly Route[] =>
  withAdministrativeAuditing(
    [
      {
        method: "GET",
        path: "/v1/client-companies/:companyId/subscription-accesses",
        execute: (request, _url, pathParameters) =>
          Effect.gen(function* () {
            const authentication = yield* authenticate(request);
            if (!authentication.authenticated)
              return json({ code: "unauthorized" }, { status: 401 });
            const result = yield* provided(
              listClientSubscriptionAccesses(authentication.identity, pathParameters.companyId!),
              pgLayer,
            );
            if (!result.ok) return authResponse(result.error) ?? (yield* Effect.fail(result.error));
            return json({ accesses: result.value });
          }),
      },
      ...(["GET", "PUT"] as const).map(
        (method): Route => ({
          method,
          path:
            method === "GET"
              ? "/v1/client-companies/:companyId/public-sources"
              : "/v1/client-companies/:companyId/public-sources/:sourceId",
          execute: (request, _url, pathParameters, input) =>
            Effect.gen(function* () {
              const authentication = yield* authenticate(request);
              if (!authentication.authenticated)
                return json({ code: "unauthorized" }, { status: 401 });
              const companyId = pathParameters.companyId!;
              if (method === "GET") {
                const result = yield* provided(
                  listClientPublicSources(authentication.identity, companyId),
                  pgLayer,
                );
                if (!result.ok)
                  return authResponse(result.error) ?? (yield* Effect.fail(result.error));
                return json({ sources: result.value });
              }
              const requestId = requestIdForAudit(request);
              if (requestId === null) return json({ code: "request_id_invalid" }, { status: 400 });
              const body = input.body as UpdateClientPublicSourceRequest;
              const sourceId = pathParameters.sourceId!;
              if (sourceId.trim() === "" || sourceId.length > 200) {
                return json({ code: "invalid_body" }, { status: 400 });
              }
              const result = yield* provided(
                updateClientPublicSource({
                  identity: authentication.identity,
                  companyId,
                  sourceId,
                  enabled: body.enabled,
                  requestId,
                }),
                pgLayer,
              );
              if (!result.ok) {
                return domainFailure(result.error) ?? (yield* Effect.fail(result.error));
              }
              return json({ source: result.value });
            }),
        }),
      ),
      ...(["GET", "PUT"] as const).map(
        (method): Route => ({
          method,
          path: "/v1/client-companies/:companyId/web-policy",
          execute: (request, _url, pathParameters, input) =>
            Effect.gen(function* () {
              const authentication = yield* authenticate(request);
              if (!authentication.authenticated)
                return json({ code: "unauthorized" }, { status: 401 });
              const companyId = pathParameters.companyId!;
              if (method === "GET") {
                const result = yield* provided(
                  getClientWebPolicy(authentication.identity, companyId),
                  pgLayer,
                );
                if (!result.ok)
                  return authResponse(result.error) ?? (yield* Effect.fail(result.error));
                return json({ settings: result.value });
              }
              const requestId = requestIdForAudit(request);
              if (requestId === null) return json({ code: "request_id_invalid" }, { status: 400 });
              const body = input.body as UpdateClientWebPolicyRequest;
              if (!normalizeWorkspaceDomainAllowlist(body.allowedDomains).ok) {
                return json({ code: "invalid_body" }, { status: 400 });
              }
              const config = yield* loadApiConfig;
              const result = yield* provided(
                updateClientWebPolicy({
                  identity: authentication.identity,
                  companyId,
                  enabled: body.enabled,
                  allowedDomains: body.allowedDomains,
                  deploymentAvailable: config.webResearchProvider === "tinyfish",
                  requestId,
                }),
                pgLayer,
              );
              if (!result.ok) {
                return domainFailure(result.error) ?? (yield* Effect.fail(result.error));
              }
              return json({ settings: result.value });
            }),
        }),
      ),
      ...(["GET", "POST"] as const).map(
        (method): Route => ({
          method,
          path: "/v1/client-companies/:companyId/deletion-requests",
          execute: (request, _url, pathParameters, input) =>
            Effect.gen(function* () {
              const authentication = yield* authenticate(request);
              if (!authentication.authenticated)
                return json({ code: "unauthorized" }, { status: 401 });
              const companyId = pathParameters.companyId!;
              if (method === "GET") {
                const result = yield* provided(
                  listCompanyDeletionRequests(authentication.identity, companyId),
                  pgLayer,
                );
                if (!result.ok)
                  return authResponse(result.error) ?? (yield* Effect.fail(result.error));
                return json({ requests: result.value });
              }
              const requestId = requestIdForAudit(request);
              if (requestId === null) return json({ code: "request_id_invalid" }, { status: 400 });
              const body = input.body as RequestCompanyDeletionRequest;
              if (
                body.reason.trim() === "" ||
                body.reason.length > 1_000 ||
                !/^[A-Za-z0-9._:-]{16,200}$/u.test(body.idempotencyKey)
              ) {
                return json({ code: "invalid_body" }, { status: 400 });
              }
              const result = yield* provided(
                createCompanyDeletionRequest({
                  identity: authentication.identity,
                  companyId,
                  reason: body.reason.trim(),
                  idempotencyKey: body.idempotencyKey,
                  requestId,
                }),
                pgLayer,
              );
              if (!result.ok) {
                return domainFailure(result.error) ?? (yield* Effect.fail(result.error));
              }
              return json({ requests: result.value }, { status: 201 });
            }),
        }),
      ),
      {
        method: "GET",
        path: "/v1/client-companies/:companyId/archive",
        execute: (request, _url, pathParameters, input) =>
          Effect.gen(function* () {
            const authentication = yield* authenticate(request);
            if (!authentication.authenticated)
              return json({ code: "unauthorized" }, { status: 401 });
            const pagination = page(input.query);
            const query = typeof input.query.q === "string" ? input.query.q.trim() : "";
            const sourceFilter =
              input.query.sourceKind === "publisher" && typeof input.query.sourceId === "string"
                ? ({ kind: "publisher", subscriptionId: input.query.sourceId } as const)
                : input.query.sourceKind === "public" && typeof input.query.sourceId === "string"
                  ? ({ kind: "public", sourceId: input.query.sourceId } as const)
                  : null;
            if (pagination === null) {
              return json({ code: "invalid_query" }, { status: 400 });
            }
            const result = yield* provided(
              listDeliveredArchive({
                identity: authentication.identity,
                companyId: pathParameters.companyId!,
                query,
                sourceFilter,
                offset: pagination.offset,
                limit: pagination.limit,
              }),
              pgLayer,
            );
            if (!result.ok) return authResponse(result.error) ?? (yield* Effect.fail(result.error));
            return json({
              items: result.value,
              nextCursor: nextCursor(pagination.offset, result.value.length, pagination.limit),
            });
          }),
      },
      {
        method: "GET",
        path: "/v1/issues/:issueId",
        execute: (request, _url, pathParameters) =>
          Effect.gen(function* () {
            const authentication = yield* authenticate(request);
            if (!authentication.authenticated)
              return json({ code: "unauthorized" }, { status: 401 });
            const result = yield* provided(
              getClientIssue(authentication.identity, pathParameters.issueId!),
              pgLayer,
            );
            if (!result.ok) return authResponse(result.error) ?? (yield* Effect.fail(result.error));
            return json(result.value);
          }),
      },
      {
        method: "GET",
        path: "/v1/client-companies/:companyId/notifications",
        execute: (request, _url, pathParameters, input) =>
          Effect.gen(function* () {
            const authentication = yield* authenticate(request);
            if (!authentication.authenticated)
              return json({ code: "unauthorized" }, { status: 401 });
            const pagination = page(input.query);
            if (pagination === null) return json({ code: "invalid_query" }, { status: 400 });
            const result = yield* provided(
              listClientNotifications({
                identity: authentication.identity,
                companyId: pathParameters.companyId!,
                offset: pagination.offset,
                limit: pagination.limit,
              }),
              pgLayer,
            );
            if (!result.ok) return authResponse(result.error) ?? (yield* Effect.fail(result.error));
            return json({
              notifications: result.value,
              nextCursor: nextCursor(pagination.offset, result.value.length, pagination.limit),
            });
          }),
      },
      {
        method: "POST",
        path: "/v1/notifications/:notificationId/read",
        execute: (request, _url, pathParameters) =>
          Effect.gen(function* () {
            const authentication = yield* authenticate(request);
            if (!authentication.authenticated)
              return json({ code: "unauthorized" }, { status: 401 });
            const result = yield* provided(
              markClientNotificationRead(authentication.identity, pathParameters.notificationId!),
              pgLayer,
            );
            if (!result.ok) return yield* Effect.fail(result.error);
            return result.value === null
              ? json({ code: "not_found" }, { status: 404 })
              : json({ status: "read", readAt: result.value });
          }),
      },
      ...(["GET", "PUT"] as const).map(
        (method): Route => ({
          method,
          path: "/v1/client-companies/:companyId/notification-preferences",
          execute: (request, _url, pathParameters, input) =>
            Effect.gen(function* () {
              const authentication = yield* authenticate(request);
              if (!authentication.authenticated)
                return json({ code: "unauthorized" }, { status: 401 });
              const companyId = pathParameters.companyId!;
              if (method === "GET") {
                const result = yield* provided(
                  getNotificationPreferences(authentication.identity, companyId),
                  pgLayer,
                );
                if (!result.ok)
                  return authResponse(result.error) ?? (yield* Effect.fail(result.error));
                return json({ preferences: result.value });
              }
              const requestId = requestIdForAudit(request);
              if (requestId === null) return json({ code: "request_id_invalid" }, { status: 400 });
              const body = input.body as NotificationPreferences;
              const result = yield* provided(
                updateNotificationPreferences({
                  identity: authentication.identity,
                  companyId,
                  preferences: body,
                  requestId,
                }),
                pgLayer,
              );
              if (!result.ok) {
                return domainFailure(result.error) ?? (yield* Effect.fail(result.error));
              }
              return json({ preferences: result.value });
            }),
        }),
      ),
    ],
    pgLayer,
  );

export const clientWorkspaceRoutes = makeClientWorkspaceRoutes();
