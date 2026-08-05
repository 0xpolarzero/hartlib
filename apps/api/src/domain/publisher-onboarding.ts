import { createClerkClient } from "@clerk/backend";
import type { CreatePublisherCompanyOnboardingRequest } from "@hartlib/shared";
import {
  normalizeWorkspaceEmail,
  onboardPublisherCompany,
  WorkspaceAuthorizationError,
  WorkspaceRuleError,
  type PublisherOnboardingProvider,
} from "@hartlib/workspace";
import { requestIdForAudit } from "@hartlib/workspace";
import { Effect } from "effect";

import { resolveRequestIdentity } from "../auth";
import { loadApiConfig } from "../config";
import { ApiDatabaseLayer, type ApiDatabaseLayer as ApiDatabaseLayerType } from "../database";
import { json, type Route } from "../http";
import { withAdministrativeAuditing } from "./administrative-audit";
import { createOrRecoverClerkOrganizationInvitation } from "./clerk-invitation-provider";

export type { PublisherOnboardingProvider } from "@hartlib/workspace";

type PgLayer = ApiDatabaseLayerType;
const PgLayer = ApiDatabaseLayer;

const liveProvider = (secretKey: string): PublisherOnboardingProvider => {
  const clerk = createClerkClient({ secretKey });
  return {
    ensureOrganization: async (input) => {
      const slug = `hartlib-publisher-${input.companyId}`;
      try {
        return (await clerk.organizations.getOrganization({ slug })).id;
      } catch {
        try {
          return (
            await clerk.organizations.createOrganization({
              name: input.name,
              slug,
              createdBy: input.creatorUserId,
            })
          ).id;
        } catch (error) {
          try {
            return (await clerk.organizations.getOrganization({ slug })).id;
          } catch {
            throw error;
          }
        }
      }
    },
    inviteAdmin: async (input) => {
      return createOrRecoverClerkOrganizationInvitation(clerk.organizations, {
        organizationId: input.organizationId,
        email: input.email,
        role: "org:admin",
        inviterUserId: input.inviterUserId,
        redirectUrl: input.redirectUrl,
        workspaceInvitationId: input.workspaceInvitationId,
      });
    },
  };
};

export const makePublisherOnboardingRoute = (
  pgLayer: PgLayer = PgLayer,
  injectedProvider?: PublisherOnboardingProvider,
): Route =>
  withAdministrativeAuditing(
    [
      {
        method: "POST",
        path: "/v1/platform/publisher-companies",
        execute: (request, _url, _pathParameters, input) =>
          Effect.gen(function* () {
            const config = yield* loadApiConfig;
            const authentication = yield* resolveRequestIdentity(request, config);
            if (!authentication.authenticated)
              return json({ code: "unauthorized" }, { status: 401 });
            const requestId = requestIdForAudit(request);
            if (requestId === null) return json({ code: "request_id_invalid" }, { status: 400 });
            const body = input.body as CreatePublisherCompanyOnboardingRequest;
            if (
              body.companyName.trim() === "" ||
              body.companyName.length > 200 ||
              normalizeWorkspaceEmail(body.firstAdminEmail) === null ||
              !/^[A-Za-z0-9._:-]{16,200}$/u.test(body.idempotencyKey)
            ) {
              return json({ code: "invalid_body" }, { status: 400 });
            }
            const provider =
              injectedProvider ??
              (config.clerkSecretKey === "" ? null : liveProvider(config.clerkSecretKey));
            const result = yield* onboardPublisherCompany({
              identity: authentication.identity,
              companyName: body.companyName,
              firstAdminEmail: body.firstAdminEmail,
              idempotencyKey: body.idempotencyKey,
              requestId,
              provider,
              redirectUrl: config.clerkInvitationRedirectUrl,
            }).pipe(
              Effect.provide(pgLayer),
              Effect.match({
                onFailure: (error) => ({ ok: false as const, error }),
                onSuccess: (value) => ({ ok: true as const, value }),
              }),
            );
            if (!result.ok) {
              if (result.error instanceof WorkspaceAuthorizationError) {
                return json(
                  { code: result.error.code },
                  { status: result.error.code === "mfa_required" ? 403 : 404 },
                );
              }
              if (result.error instanceof WorkspaceRuleError) {
                if (
                  result.error.code === "idempotency_conflict" ||
                  result.error.code === "invite_conflict" ||
                  result.error.code === "invitation_delivery_in_progress"
                ) {
                  return json({ code: result.error.code }, { status: 409 });
                }
                if (
                  result.error.code === "invitation_provider_unavailable" ||
                  result.error.code === "invitation_delivery_failed"
                ) {
                  return json({ code: result.error.code }, { status: 503 });
                }
                if (result.error.code === "invalid_body") {
                  return json({ code: result.error.code }, { status: 400 });
                }
              }
              return yield* Effect.fail(result.error);
            }
            return json(result.value, { status: result.value.duplicate ? 200 : 201 });
          }),
      },
    ],
    pgLayer,
  )[0]!;

export const publisherOnboardingRoute = makePublisherOnboardingRoute();
