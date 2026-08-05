import { createClerkClient } from "@clerk/backend";
import type {
  GrantClientSubscriptionRequest,
  InviteClientMemberRequest,
  InvitePublisherMemberRequest,
  UpdateClientMemberRequest,
  UpdatePublisherMemberRequest,
} from "@hartlib/shared";
import {
  grantClientSubscription,
  inviteClientMember,
  invitePublisherMember,
  listClientMemberships,
  listIdentityWorkspaces,
  listPublisherMemberships,
  mutateClientMember,
  mutatePublisherMember,
  normalizeWorkspaceEmail,
  revokeClientSubscription,
  WorkspaceAuthorizationError,
  WorkspaceRuleError,
} from "@hartlib/workspace";
import type { WorkspaceInvitationProvider } from "@hartlib/workspace";
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
import { createOrRecoverClerkOrganizationInvitation } from "./clerk-invitation-provider";

export type { WorkspaceInvitationProvider } from "@hartlib/workspace";

type PgLayer = ApiDatabaseLayerType;
const PgLayer = ApiDatabaseLayer;

const authenticate = (request: Request) =>
  Effect.gen(function* () {
    const config = yield* loadApiConfig;
    return yield* resolveRequestIdentity(request, config);
  });

const resultOf = <A, E>(effect: Effect.Effect<A, E, ApiDatabaseService>, pgLayer: PgLayer) =>
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

const ruleResponse = (error: unknown): Response | null => {
  if (!(error instanceof WorkspaceRuleError)) return null;
  if (
    error.code === "subscription_not_found" ||
    error.code === "access_not_found" ||
    error.code === "member_not_found"
  ) {
    return json({ code: error.code }, { status: 404 });
  }
  if (error.code === "last_admin_required") {
    return json({ code: error.code }, { status: 409 });
  }
  if (error.code === "invite_conflict" || error.code === "invitation_delivery_in_progress") {
    return json({ code: error.code }, { status: 409 });
  }
  if (
    error.code === "clerk_organization_unavailable" ||
    error.code === "invitation_provider_unavailable" ||
    error.code === "invitation_delivery_failed"
  ) {
    return json({ code: error.code }, { status: 503 });
  }
  if (error.code === "invalid_body") return json({ code: error.code }, { status: 400 });
  return null;
};

const liveInvitationProvider = (secretKey: string): WorkspaceInvitationProvider => {
  const clerk = createClerkClient({ secretKey });
  return {
    create: async (input) => {
      return createOrRecoverClerkOrganizationInvitation(clerk.organizations, {
        organizationId: input.organizationId,
        email: input.email,
        role: input.organizationRole,
        inviterUserId: input.inviterUserId,
        redirectUrl: input.redirectUrl,
        workspaceInvitationId: input.invitationId,
      });
    },
  };
};

export const makeWorkspaceMembershipRoutes = (
  pgLayer: PgLayer = PgLayer,
  injectedInvitationProvider?: WorkspaceInvitationProvider,
): readonly Route[] => {
  const routes: Route[] = [];

  routes.push({
    method: "GET",
    path: "/v1/me/workspaces",
    execute: (request) =>
      Effect.gen(function* () {
        const authentication = yield* authenticate(request);
        if (!authentication.authenticated) return json({ code: "unauthorized" }, { status: 401 });
        const result = yield* resultOf(listIdentityWorkspaces(authentication.identity), pgLayer);
        if (!result.ok) return yield* Effect.fail(result.error);
        return json(result.value);
      }),
  });

  for (const workspace of ["publisher", "client"] as const) {
    routes.push({
      method: "GET",
      path: `/v1/${workspace}-companies/:companyId/members`,
      execute: (request, _url, pathParameters) =>
        Effect.gen(function* () {
          const authentication = yield* authenticate(request);
          if (!authentication.authenticated) return json({ code: "unauthorized" }, { status: 401 });
          if (workspace === "publisher") {
            const result = yield* resultOf(
              listPublisherMemberships(authentication.identity, pathParameters.companyId!),
              pgLayer,
            );
            if (!result.ok) return authResponse(result.error) ?? (yield* Effect.fail(result.error));
            return json(result.value);
          }
          const result = yield* resultOf(
            listClientMemberships(authentication.identity, pathParameters.companyId!),
            pgLayer,
          );
          if (!result.ok) return authResponse(result.error) ?? (yield* Effect.fail(result.error));
          return json(result.value);
        }),
    });
  }

  routes.push({
    method: "POST",
    path: "/v1/publisher-companies/:companyId/members",
    execute: (request, _url, pathParameters, input) =>
      Effect.gen(function* () {
        const authentication = yield* authenticate(request);
        if (!authentication.authenticated) return json({ code: "unauthorized" }, { status: 401 });
        const requestId = requestIdForAudit(request);
        if (requestId === null) return json({ code: "request_id_invalid" }, { status: 400 });
        const body = input.body as InvitePublisherMemberRequest;
        if (
          normalizeWorkspaceEmail(body.email) === null ||
          new Set(body.subscriptionIds).size !== body.subscriptionIds.length
        ) {
          return json({ code: "invalid_body" }, { status: 400 });
        }
        const config = yield* loadApiConfig;
        const provider =
          injectedInvitationProvider ??
          (config.clerkSecretKey === "" ? null : liveInvitationProvider(config.clerkSecretKey));
        const result = yield* resultOf(
          invitePublisherMember({
            identity: authentication.identity,
            companyId: pathParameters.companyId!,
            email: body.email,
            role: body.role,
            subscriptionIds: body.subscriptionIds,
            requestId,
            provider,
            redirectUrl: config.clerkInvitationRedirectUrl,
          }),
          pgLayer,
        );
        if (!result.ok) {
          return (
            authResponse(result.error) ??
            ruleResponse(result.error) ??
            (yield* Effect.fail(result.error))
          );
        }
        return json(
          { invitation: result.value.invitation },
          { status: result.value.delivered ? 201 : 200 },
        );
      }),
  });

  routes.push({
    method: "POST",
    path: "/v1/client-companies/:companyId/members",
    execute: (request, _url, pathParameters, input) =>
      Effect.gen(function* () {
        const authentication = yield* authenticate(request);
        if (!authentication.authenticated) return json({ code: "unauthorized" }, { status: 401 });
        const requestId = requestIdForAudit(request);
        if (requestId === null) return json({ code: "request_id_invalid" }, { status: 400 });
        const body = input.body as InviteClientMemberRequest;
        if (
          normalizeWorkspaceEmail(body.email) === null ||
          new Set(body.subscriptionAccessIds).size !== body.subscriptionAccessIds.length
        ) {
          return json({ code: "invalid_body" }, { status: 400 });
        }
        const config = yield* loadApiConfig;
        const provider =
          injectedInvitationProvider ??
          (config.clerkSecretKey === "" ? null : liveInvitationProvider(config.clerkSecretKey));
        const result = yield* resultOf(
          inviteClientMember({
            identity: authentication.identity,
            companyId: pathParameters.companyId!,
            email: body.email,
            role: body.role,
            subscriptionAccessIds: body.subscriptionAccessIds,
            requestId,
            provider,
            redirectUrl: config.clerkInvitationRedirectUrl,
          }),
          pgLayer,
        );
        if (!result.ok) {
          return (
            authResponse(result.error) ??
            ruleResponse(result.error) ??
            (yield* Effect.fail(result.error))
          );
        }
        return json(
          { invitation: result.value.invitation },
          { status: result.value.delivered ? 201 : 200 },
        );
      }),
  });

  const memberMutation = (
    workspace: "publisher" | "client",
    method: "PATCH" | "DELETE",
  ): Route => ({
    method,
    path: `/v1/${workspace}-companies/:companyId/members/:userId`,
    execute: (request, _url, pathParameters, input) =>
      Effect.gen(function* () {
        const authentication = yield* authenticate(request);
        if (!authentication.authenticated) return json({ code: "unauthorized" }, { status: 401 });
        const requestId = requestIdForAudit(request);
        if (requestId === null) return json({ code: "request_id_invalid" }, { status: 400 });
        const body = method === "PATCH" ? input.body : null;
        const common = {
          identity: authentication.identity,
          companyId: pathParameters.companyId!,
          userId: pathParameters.userId!,
          requestId,
        };
        const operation =
          workspace === "publisher"
            ? mutatePublisherMember({
                ...common,
                mutation:
                  method === "DELETE"
                    ? { method }
                    : {
                        method,
                        role: (body as UpdatePublisherMemberRequest).role,
                        subscriptionIds: (body as UpdatePublisherMemberRequest).subscriptionIds,
                      },
              })
            : mutateClientMember({
                ...common,
                mutation:
                  method === "DELETE"
                    ? { method }
                    : {
                        method,
                        role: (body as UpdateClientMemberRequest).role,
                      },
              });
        const result = yield* resultOf(operation, pgLayer);
        if (!result.ok) {
          return (
            authResponse(result.error) ??
            ruleResponse(result.error) ??
            (yield* Effect.fail(result.error))
          );
        }
        return method === "DELETE"
          ? new Response(null, { status: 204 })
          : json({ status: "updated" });
      }),
  });
  routes.push(memberMutation("publisher", "PATCH"));
  routes.push(memberMutation("publisher", "DELETE"));
  routes.push(memberMutation("client", "PATCH"));
  routes.push(memberMutation("client", "DELETE"));

  routes.push({
    method: "POST",
    path: "/v1/client-companies/:companyId/members/:userId/subscription-grants",
    execute: (request, _url, pathParameters, input) =>
      Effect.gen(function* () {
        const authentication = yield* authenticate(request);
        if (!authentication.authenticated) return json({ code: "unauthorized" }, { status: 401 });
        const requestId = requestIdForAudit(request);
        if (requestId === null) return json({ code: "request_id_invalid" }, { status: 400 });
        const body = input.body as GrantClientSubscriptionRequest;
        const result = yield* resultOf(
          grantClientSubscription({
            identity: authentication.identity,
            companyId: pathParameters.companyId!,
            userId: pathParameters.userId!,
            accessId: body.accessId,
            requestId,
          }),
          pgLayer,
        );
        if (!result.ok) {
          return (
            authResponse(result.error) ??
            ruleResponse(result.error) ??
            (yield* Effect.fail(result.error))
          );
        }
        return json({ status: "granted" }, { status: 201 });
      }),
  });

  routes.push({
    method: "DELETE",
    path: "/v1/client-companies/:companyId/members/:userId/subscription-grants/:accessId",
    execute: (request, _url, pathParameters) =>
      Effect.gen(function* () {
        const authentication = yield* authenticate(request);
        if (!authentication.authenticated) return json({ code: "unauthorized" }, { status: 401 });
        const requestId = requestIdForAudit(request);
        if (requestId === null) return json({ code: "request_id_invalid" }, { status: 400 });
        const result = yield* resultOf(
          revokeClientSubscription({
            identity: authentication.identity,
            companyId: pathParameters.companyId!,
            userId: pathParameters.userId!,
            accessId: pathParameters.accessId!,
            requestId,
          }),
          pgLayer,
        );
        if (!result.ok) {
          return (
            authResponse(result.error) ??
            ruleResponse(result.error) ??
            (yield* Effect.fail(result.error))
          );
        }
        return new Response(null, { status: 204 });
      }),
  });

  return withAdministrativeAuditing(routes, pgLayer);
};

export const workspaceMembershipRoutes = makeWorkspaceMembershipRoutes();
