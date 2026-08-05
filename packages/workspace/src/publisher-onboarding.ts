import { PgClient } from "@effect/sql-pg";
import type { PublisherCompanyOnboardingDescriptor } from "@hartlib/shared";
import { Effect } from "effect";

import {
  appendAuthorizationAudit,
  auditDeniedThenFail,
  requirePlatformAdminRole,
  WorkspaceRuleError,
  type WorkspaceIdentity,
} from "./common";
import {
  INVITATION_DELIVERY_LEASE_INTERVAL,
  releaseInvitationDelivery,
  validInvitationDelivery,
} from "./invitation-delivery";
import { normalizeWorkspaceEmail } from "./memberships";

export interface PublisherOnboardingProvider {
  readonly ensureOrganization: (input: {
    readonly companyId: string;
    readonly name: string;
    readonly creatorUserId: string;
  }) => Promise<string>;
  readonly inviteAdmin: (input: {
    readonly organizationId: string;
    readonly email: string;
    readonly inviterUserId: string;
    readonly redirectUrl: string;
    readonly workspaceInvitationId: string;
  }) => Promise<{ readonly externalId: string; readonly expiresAt: Date }>;
}

export interface PublisherOnboardingResult {
  readonly onboarding: PublisherCompanyOnboardingDescriptor;
  readonly duplicate: boolean;
}

interface PreparedOnboarding {
  readonly companyId: string;
  readonly companyName: string;
  readonly organizationId: string | null;
  readonly invitationId: string;
  readonly invitationState: PublisherCompanyOnboardingDescriptor["invitationState"];
  readonly invitationExternalId: string | null;
  readonly invitationExpiresAt: Date | null;
  readonly deliveryLeaseToken: string | null;
  readonly deliver: boolean;
  readonly inProgress: boolean;
  readonly duplicate: boolean;
}

export const onboardPublisherCompany = (input: {
  readonly identity: WorkspaceIdentity;
  readonly companyName: string;
  readonly firstAdminEmail: string;
  readonly idempotencyKey: string;
  readonly requestId: string;
  readonly provider: PublisherOnboardingProvider | null;
  readonly redirectUrl: string;
}) => {
  const operation = Effect.gen(function* () {
    const companyName = input.companyName.trim();
    const email = normalizeWorkspaceEmail(input.firstAdminEmail);
    if (
      companyName === "" ||
      companyName.length > 200 ||
      email === null ||
      !/^[A-Za-z0-9._:-]{16,200}$/u.test(input.idempotencyKey)
    ) {
      return yield* Effect.fail(new WorkspaceRuleError("invalid_body"));
    }
    const sql = yield* PgClient.PgClient;
    const prepared: PreparedOnboarding = yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* requirePlatformAdminRole(input.identity, new Set(["admin"]));
        yield* sql`
          select pg_advisory_xact_lock(
            hashtext(${`hartlib:publisher-onboarding:${input.idempotencyKey}`})
          )
        `;
        yield* sql`
          update workspace_invitations invitation
          set state = 'expired', updated_at = now()
          where invitation.publisher_company_id = (
            select id from publisher_companies
            where onboarding_idempotency_key = ${input.idempotencyKey}
          )
            and invitation.state = 'pending' and invitation.expires_at <= now()
        `;
        const prior = yield* sql<{
          companyId: string;
          companyName: string;
          organizationId: string | null;
          invitationId: string;
          invitationEmail: string;
          invitationState: PublisherCompanyOnboardingDescriptor["invitationState"];
          invitationExternalId: string | null;
          invitationExpiresAt: Date | null;
          deliveryLeaseToken: string | null;
          deliveryLeaseExpiresAt: Date | null;
        }>`
          select company.id::text as "companyId", company.name as "companyName",
                 company.clerk_organization_id as "organizationId",
                 invitation.id::text as "invitationId",
                 invitation.normalized_email as "invitationEmail",
                 invitation.state as "invitationState",
                 invitation.clerk_invitation_id as "invitationExternalId",
                 invitation.expires_at as "invitationExpiresAt",
                 invitation.delivery_lease_token::text as "deliveryLeaseToken",
                 invitation.delivery_lease_expires_at as "deliveryLeaseExpiresAt"
          from publisher_companies company
          join workspace_invitations invitation on invitation.publisher_company_id = company.id
          where company.onboarding_idempotency_key = ${input.idempotencyKey}
          order by invitation.created_at desc, invitation.id desc
          limit 1 for update of company, invitation
        `;
        const existing = prior[0];
        if (existing !== undefined) {
          if (existing.companyName !== companyName || existing.invitationEmail !== email) {
            return yield* Effect.fail(new WorkspaceRuleError("idempotency_conflict"));
          }
          if (existing.invitationState === "pending" || existing.invitationState === "accepted") {
            return {
              ...existing,
              deliver: false,
              inProgress: false,
              duplicate: true,
            };
          }
          if (existing.invitationState === "creating") {
            if (
              existing.deliveryLeaseToken !== null &&
              existing.deliveryLeaseExpiresAt !== null &&
              existing.deliveryLeaseExpiresAt > new Date()
            ) {
              return {
                ...existing,
                deliver: false,
                inProgress: true,
                duplicate: true,
              };
            }
            const claimed = yield* sql<{
              invitationId: string;
              deliveryLeaseToken: string;
            }>`
              update workspace_invitations
              set delivery_lease_token = gen_random_uuid(),
                  delivery_lease_expires_at = now() + ${INVITATION_DELIVERY_LEASE_INTERVAL}::interval,
                  delivery_attempt_count = delivery_attempt_count + 1,
                  delivery_last_attempt_at = now(), delivery_last_error_code = null,
                  updated_at = now()
              where id = ${existing.invitationId} and state = 'creating'
                and (delivery_lease_expires_at is null or delivery_lease_expires_at <= now())
              returning id::text as "invitationId",
                        delivery_lease_token::text as "deliveryLeaseToken"
            `;
            if (claimed[0] === undefined) {
              return yield* Effect.fail(new WorkspaceRuleError("invitation_delivery_in_progress"));
            }
            return {
              ...existing,
              deliveryLeaseToken: claimed[0].deliveryLeaseToken,
              deliver: true,
              inProgress: false,
              duplicate: true,
            };
          }
          const reinvitation = yield* sql<{
            invitationId: string;
            deliveryLeaseToken: string;
          }>`
            insert into workspace_invitations (
              workspace_kind, publisher_company_id, normalized_email, role,
              invited_by_user_id, delivery_attempt_count, delivery_lease_token,
              delivery_lease_expires_at, delivery_last_attempt_at
            ) values (
              'publisher', ${existing.companyId}, ${email}, 'admin', ${input.identity.userId}, 1,
              gen_random_uuid(), now() + ${INVITATION_DELIVERY_LEASE_INTERVAL}::interval, now()
            ) returning id::text as "invitationId",
                        delivery_lease_token::text as "deliveryLeaseToken"
          `;
          return {
            ...existing,
            invitationId: reinvitation[0]!.invitationId,
            invitationState: "creating" as const,
            invitationExternalId: null,
            invitationExpiresAt: null,
            deliveryLeaseToken: reinvitation[0]!.deliveryLeaseToken,
            deliver: true,
            inProgress: false,
            duplicate: true,
          };
        }
        const company = yield* sql<{ companyId: string }>`
          insert into publisher_companies (name, onboarding_idempotency_key)
          values (${companyName}, ${input.idempotencyKey})
          returning id::text as "companyId"
        `;
        const invitation = yield* sql<{
          invitationId: string;
          deliveryLeaseToken: string;
        }>`
          insert into workspace_invitations (
            workspace_kind, publisher_company_id, normalized_email, role, invited_by_user_id,
            delivery_attempt_count, delivery_lease_token, delivery_lease_expires_at,
            delivery_last_attempt_at
          ) values (
            'publisher', ${company[0]!.companyId}, ${email}, 'admin', ${input.identity.userId}, 1,
            gen_random_uuid(), now() + ${INVITATION_DELIVERY_LEASE_INTERVAL}::interval, now()
          ) returning id::text as "invitationId",
                      delivery_lease_token::text as "deliveryLeaseToken"
        `;
        return {
          companyId: company[0]!.companyId,
          companyName,
          organizationId: null,
          invitationId: invitation[0]!.invitationId,
          invitationState: "creating" as const,
          invitationExternalId: null,
          invitationExpiresAt: null,
          deliveryLeaseToken: invitation[0]!.deliveryLeaseToken,
          deliver: true,
          inProgress: false,
          duplicate: false,
        };
      }),
    );

    if (!prepared.deliver) {
      if (prepared.inProgress) {
        return yield* Effect.fail(new WorkspaceRuleError("invitation_delivery_in_progress"));
      }
      yield* appendAuthorizationAudit({
        identity: input.identity,
        requestId: input.requestId,
        action: "platform.publisher_company.onboard",
        scopeKind: "publisher_company",
        scopeId: prepared.companyId,
        outcome: "succeeded",
      });
      return {
        onboarding: {
          companyId: prepared.companyId,
          companyName: prepared.companyName,
          firstAdminEmail: email,
          invitationState: prepared.invitationState,
        },
        duplicate: true,
      } satisfies PublisherOnboardingResult;
    }
    const leaseToken = prepared.deliveryLeaseToken;
    if (leaseToken === null) {
      return yield* Effect.fail(new WorkspaceRuleError("invite_conflict"));
    }
    if (input.provider === null || input.redirectUrl === "") {
      yield* releaseInvitationDelivery(
        prepared.invitationId,
        leaseToken,
        "invitation_provider_unavailable",
      );
      return yield* Effect.fail(new WorkspaceRuleError("invitation_provider_unavailable"));
    }
    const organizationId = yield* Effect.tryPromise({
      try: () =>
        prepared.organizationId === null
          ? input.provider!.ensureOrganization({
              companyId: prepared.companyId,
              name: prepared.companyName,
              creatorUserId: input.identity.userId,
            })
          : Promise.resolve(prepared.organizationId),
      catch: () => new WorkspaceRuleError("invitation_delivery_failed"),
    }).pipe(
      Effect.catch((error) =>
        releaseInvitationDelivery(
          prepared.invitationId,
          leaseToken,
          "organization_delivery_failed",
        ).pipe(Effect.andThen(Effect.fail(error))),
      ),
    );
    if (organizationId.trim() === "") {
      yield* releaseInvitationDelivery(
        prepared.invitationId,
        leaseToken,
        "organization_identity_invalid",
      );
      return yield* Effect.fail(new WorkspaceRuleError("invitation_delivery_failed"));
    }
    const organizationPersisted = yield* sql<{
      organizationId: string;
    }>`
      update publisher_companies
      set clerk_organization_id = ${organizationId}, updated_at = now()
      where id = ${prepared.companyId}
        and (clerk_organization_id is null or clerk_organization_id = ${organizationId})
      returning clerk_organization_id as "organizationId"
    `;
    if (organizationPersisted[0]?.organizationId !== organizationId) {
      yield* releaseInvitationDelivery(
        prepared.invitationId,
        leaseToken,
        "organization_identity_conflict",
      );
      return yield* Effect.fail(new WorkspaceRuleError("invitation_delivery_failed"));
    }
    const delivery = yield* Effect.tryPromise({
      try: () =>
        input.provider!.inviteAdmin({
          organizationId,
          email,
          inviterUserId: input.identity.userId,
          redirectUrl: input.redirectUrl,
          workspaceInvitationId: prepared.invitationId,
        }),
      catch: () => new WorkspaceRuleError("invitation_delivery_failed"),
    }).pipe(
      Effect.catch((error) =>
        releaseInvitationDelivery(
          prepared.invitationId,
          leaseToken,
          "invitation_delivery_failed",
        ).pipe(Effect.andThen(Effect.fail(error))),
      ),
    );
    if (!validInvitationDelivery(delivery)) {
      yield* releaseInvitationDelivery(
        prepared.invitationId,
        leaseToken,
        "invitation_delivery_invalid",
      );
      return yield* Effect.fail(new WorkspaceRuleError("invitation_delivery_failed"));
    }
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const finalized = yield* sql<{ invitationState: string }>`
          update workspace_invitations
          set state = 'pending', clerk_invitation_id = ${delivery.externalId},
              expires_at = ${delivery.expiresAt}, delivery_lease_token = null,
              delivery_lease_expires_at = null, delivery_last_error_code = null,
              updated_at = now()
          where id = ${prepared.invitationId} and state = 'creating'
            and delivery_lease_token = ${leaseToken}
          returning state as "invitationState"
        `;
        if (finalized[0] === undefined) {
          const reconciled = yield* sql<{
            state: string;
            externalId: string | null;
            expiresAt: Date | null;
          }>`
            select state, clerk_invitation_id as "externalId", expires_at as "expiresAt"
            from workspace_invitations where id = ${prepared.invitationId} for update
          `;
          const row = reconciled[0];
          if (
            row?.state !== "pending" ||
            row.externalId !== delivery.externalId ||
            row.expiresAt?.getTime() !== delivery.expiresAt.getTime()
          ) {
            return yield* Effect.fail(new WorkspaceRuleError("invite_conflict"));
          }
        }
        yield* appendAuthorizationAudit({
          identity: input.identity,
          requestId: input.requestId,
          action: "platform.publisher_company.onboard",
          scopeKind: "publisher_company",
          scopeId: prepared.companyId,
          outcome: "succeeded",
        });
      }),
    );
    return {
      onboarding: {
        companyId: prepared.companyId,
        companyName: prepared.companyName,
        firstAdminEmail: email,
        invitationState: "pending",
      },
      duplicate: prepared.duplicate,
    } satisfies PublisherOnboardingResult;
  });
  return operation.pipe(
    Effect.catch((error) =>
      auditDeniedThenFail(
        input.identity,
        input.requestId,
        "platform.publisher_company.onboard",
        "publisher_company",
        "new",
        error,
      ),
    ),
  );
};
