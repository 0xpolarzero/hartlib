import { findAdministrativeAuditOutcomes } from "@hartlib/backend-domain/administrative-audit";
import { appendAuthorizationAudit, boundedAuthorizationReasonCode } from "@hartlib/workspace";
import { Effect } from "effect";

import { resolveRequestIdentity } from "../auth";
import { loadApiConfig } from "../config";
import type { ApiDatabaseLayer } from "../database";
import type { DecodedRouteInput, Route } from "../http";
import type { DecodedPathParameters } from "./path-parameter-policy";
import {
  administrativeAuditPolicyFor,
  type AdministrativeMutationAuditPolicy,
} from "./administrative-audit-matrix";

export type AdministrativeAuditPgLayer = ApiDatabaseLayer;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const requestId = (request: Request): string => {
  const supplied = request.headers.get("x-request-id");
  return supplied !== null && uuidPattern.test(supplied) ? supplied : crypto.randomUUID();
};

const pathParameter = (
  policy: AdministrativeMutationAuditPolicy,
  pathParameters: DecodedPathParameters,
): string | null => {
  if (policy.scopeParam === undefined) return null;
  return pathParameters[policy.scopeParam] ?? null;
};

interface AdministrativeAuditScope {
  readonly scopeKind: string;
  readonly scopeId: string;
}

const record = (value: unknown): Readonly<Record<string, unknown>> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;

const nestedString = (value: unknown, parent: string, field: string): string | null => {
  const outer = record(value);
  const inner = record(outer?.[parent]);
  return typeof inner?.[field] === "string" ? inner[field] : null;
};

const responseBody = (response: Response) =>
  Effect.tryPromise(() => response.clone().json() as Promise<unknown>).pipe(
    Effect.catch(() => Effect.succeed(null)),
  );

const requiredScope = (
  scopeKind: string,
  scopeId: string | null,
): Effect.Effect<AdministrativeAuditScope, Error> =>
  scopeId === null || scopeId.trim() === ""
    ? Effect.fail(new Error("administrative_audit_scope_unresolvable"))
    : Effect.succeed({ scopeKind, scopeId });

const fallbackScope = (
  policy: AdministrativeMutationAuditPolicy,
  pathParameters: DecodedPathParameters,
): AdministrativeAuditScope => ({
  scopeKind: policy.scopeKind,
  scopeId: pathParameter(policy, pathParameters) ?? policy.scopeId ?? "request",
});

const expectedScope = (
  route: Route,
  policy: AdministrativeMutationAuditPolicy,
  response: Response,
  pathParameters: DecodedPathParameters,
  input: DecodedRouteInput | null,
  outcome: "succeeded" | "denied",
): Effect.Effect<AdministrativeAuditScope, Error> =>
  Effect.gen(function* () {
    const body = record(input?.body);
    switch (`${route.method} ${route.path}`) {
      case "POST /v1/exports":
        if (
          response.status !== 400 &&
          typeof body?.scopeKind === "string" &&
          typeof body.scopeId === "string"
        ) {
          return { scopeKind: body.scopeKind, scopeId: body.scopeId };
        }
        return fallbackScope(policy, pathParameters);
      case "POST /v1/platform/support/grants":
        if (typeof body?.scopeKind === "string" && typeof body.scopeId === "string") {
          return { scopeKind: body.scopeKind, scopeId: body.scopeId };
        }
        return fallbackScope(policy, pathParameters);
      case "POST /v1/client-companies/:companyId/ai-usage-requests":
        if (outcome === "succeeded") {
          return yield* requiredScope(
            "ai_usage_request",
            nestedString(yield* responseBody(response), "request", "id"),
          );
        }
        return fallbackScope(policy, pathParameters);
      case "POST /v1/platform/company-deletion-requests/:requestId/decision":
        if (outcome === "succeeded") {
          return yield* requiredScope(
            "client_company",
            nestedString(yield* responseBody(response), "request", "clientCompanyId"),
          );
        }
        return fallbackScope(policy, pathParameters);
      case "POST /v1/publisher-companies/:companyId/subscriptions":
        if (outcome === "succeeded") {
          return yield* requiredScope(
            "publisher_subscription",
            nestedString(yield* responseBody(response), "subscription", "id"),
          );
        }
        return fallbackScope(policy, pathParameters);
      case "POST /v1/publisher-subscriptions/:subscriptionId/issues":
        if (outcome === "succeeded") {
          return yield* requiredScope(
            "publisher_issue",
            nestedString(yield* responseBody(response), "issue", "id"),
          );
        }
        return fallbackScope(policy, pathParameters);
      case "POST /v1/publisher-issues/:issueId/documents":
        if (outcome === "succeeded") {
          return yield* requiredScope(
            "hartlib_document",
            nestedString(yield* responseBody(response), "document", "id"),
          );
        }
        return fallbackScope(policy, pathParameters);
      case "POST /v1/platform/publisher-companies":
        if (outcome === "succeeded") {
          return yield* requiredScope(
            "publisher_company",
            nestedString(yield* responseBody(response), "onboarding", "companyId"),
          );
        }
        return fallbackScope(policy, pathParameters);
      default:
        return fallbackScope(policy, pathParameters);
    }
  });

const responseReason = (response: Response) =>
  Effect.gen(function* () {
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
    if (contentType === "application/json") {
      const body = yield* Effect.tryPromise(() => response.clone().json()).pipe(
        Effect.catch(() => Effect.succeed(null)),
      );
      if (typeof body === "object" && body !== null) {
        const record = body as Record<string, unknown>;
        const value = typeof record.code === "string" ? record.code : record.error;
        if (typeof value === "string") {
          return boundedAuthorizationReasonCode(new Error(value), `http_${response.status}`);
        }
      }
    }
    return `http_${response.status}`;
  });

export const withCanonicalAuditRequestId = (route: Route, request: Request): Request => {
  if (administrativeAuditPolicyFor(route.method, route.path) === undefined) {
    return request;
  }
  // Mutation audit identity is server-owned and unique per dispatch. A valid
  // client correlation id must never be reusable to suppress a later outcome
  // through the audit table's uniqueness constraint.
  request.headers.set("x-request-id", crypto.randomUUID());
  return request;
};

/**
 * Guarantees a durable outcome for every authenticated administrative branch.
 * Domain services still append their exact transactional outcome; this boundary
 * only fills a missing branch (malformed input, provider failure, or an
 * unexpected defect) before releasing the response.
 */
export const ensureAdministrativeMutationAudit = (
  route: Route,
  request: Request,
  response: Response,
  pathParameters: DecodedPathParameters,
  input: DecodedRouteInput | null,
  pgLayer: AdministrativeAuditPgLayer,
) => {
  const policy = administrativeAuditPolicyFor(route.method, route.path);
  if (policy === undefined) return Effect.void;

  return Effect.gen(function* () {
    const config = yield* loadApiConfig;
    const authentication = yield* resolveRequestIdentity(request, config);
    if (!authentication.authenticated) return;

    const id = requestId(request);
    const succeeded = response.status >= 200 && response.status < 400;
    const expectedOutcome = succeeded ? "succeeded" : "denied";
    const expected = yield* expectedScope(
      route,
      policy,
      response,
      pathParameters,
      input,
      expectedOutcome,
    );
    const existing = yield* findAdministrativeAuditOutcomes(id, policy.actions).pipe(
      Effect.provide(pgLayer),
    );
    if (existing.length > 1) {
      return yield* Effect.fail(new Error("administrative_audit_outcome_ambiguous"));
    }
    if (existing[0] !== undefined) {
      if (
        existing[0].outcome !== expectedOutcome ||
        existing[0].scopeKind !== expected.scopeKind ||
        existing[0].scopeId !== expected.scopeId
      ) {
        return yield* Effect.fail(new Error("administrative_audit_outcome_mismatch"));
      }
      return;
    }

    const reasonCode = succeeded ? undefined : yield* responseReason(response);
    yield* appendAuthorizationAudit({
      identity: authentication.identity,
      requestId: id,
      action: policy.fallbackAction,
      scopeKind: expected.scopeKind,
      scopeId: expected.scopeId,
      outcome: expectedOutcome,
      ...(reasonCode === undefined ? {} : { reasonCode }),
    }).pipe(Effect.provide(pgLayer));
  });
};

export const withAdministrativeAuditing = (
  routes: ReadonlyArray<Route>,
  pgLayer: AdministrativeAuditPgLayer,
): readonly Route[] =>
  routes.map((route) =>
    administrativeAuditPolicyFor(route.method, route.path) === undefined
      ? route
      : {
          ...route,
          administrativeAudit: (
            request: Request,
            response: Response,
            pathParameters: DecodedPathParameters,
            input: DecodedRouteInput | null,
          ) =>
            ensureAdministrativeMutationAudit(
              route,
              request,
              response,
              pathParameters,
              input,
              pgLayer,
            ),
        },
  );
