import { PgClient } from "@effect/sql-pg";
import type {
  ClientInvitationDescriptor,
  ClientMemberDescriptor,
  ClientRole,
  PublisherInvitationDescriptor,
  PublisherMemberDescriptor,
  PublisherRole,
} from "@hartlib/shared";
import { Effect } from "effect";

import {
  appendAuthorizationAudit,
  auditDeniedThenFail,
  requireClientCompanyAdmin,
  requirePublisherCompanyAdmin,
  WorkspaceRuleError,
  type WorkspaceIdentity,
} from "./common";
import {
  INVITATION_DELIVERY_LEASE_INTERVAL,
  releaseInvitationDelivery,
  validInvitationDelivery,
} from "./invitation-delivery";

export interface WorkspaceInvitationProvider {
  readonly create: (input: {
    readonly organizationId: string;
    readonly email: string;
    readonly organizationRole: "org:admin" | "org:member";
    readonly inviterUserId: string;
    readonly redirectUrl: string;
    readonly invitationId: string;
  }) => Promise<{ readonly externalId: string; readonly expiresAt: Date }>;
}

export const normalizeWorkspaceEmail = (value: string): string | null => {
  const normalized = value.trim().toLowerCase();
  return normalized.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalized)
    ? normalized
    : null;
};

interface InvitationRow {
  readonly id: string;
  readonly email: string;
  readonly role: string;
  readonly publisherSubscriptionIds: readonly string[];
  readonly clientSubscriptionAccessIds: readonly string[];
  readonly state: "creating" | "pending" | "accepted" | "revoked" | "expired" | "failed";
  readonly expiresAt: Date | null;
  readonly externalId: string | null;
  readonly deliveryLeaseToken: string | null;
  readonly deliveryLeaseExpiresAt: Date | null;
  readonly createdAt: Date;
}

const sameIds = (left: readonly string[], right: readonly string[]): boolean => {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
};

const publisherInvitationDescriptor = (row: InvitationRow): PublisherInvitationDescriptor => ({
  id: row.id,
  email: row.email,
  role: row.role as PublisherInvitationDescriptor["role"],
  subscriptionIds: row.publisherSubscriptionIds,
  state: row.state,
  expiresAt: row.expiresAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
});

const clientInvitationDescriptor = (row: InvitationRow): ClientInvitationDescriptor => ({
  id: row.id,
  email: row.email,
  role: row.role as ClientInvitationDescriptor["role"],
  subscriptionAccessIds: row.clientSubscriptionAccessIds,
  state: row.state,
  expiresAt: row.expiresAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
});

const publisherMembers = (companyId: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<{
      userId: string;
      role: PublisherMemberDescriptor["role"];
      invitedEmail: string | null;
      acceptedAt: Date | null;
      subscriptionId: string | null;
    }>`
      select membership.user_id as "userId", membership.role,
             membership.invited_email as "invitedEmail", membership.accepted_at as "acceptedAt",
             grants.subscription_id::text as "subscriptionId"
      from publisher_company_memberships membership
      join platform_users users
        on users.id = membership.user_id
       and users.recovery_deleted_at is null
       and users.purged_at is null
      left join publisher_membership_subscription_grants grants
        on grants.publisher_company_id = membership.publisher_company_id
       and grants.user_id = membership.user_id
      where membership.publisher_company_id = ${companyId}
      order by membership.created_at, membership.user_id, grants.subscription_id
    `;
    const grouped = new Map<
      string,
      Omit<PublisherMemberDescriptor, "subscriptionIds"> & { subscriptionIds: string[] }
    >();
    for (const row of rows) {
      const current = grouped.get(row.userId) ?? {
        userId: row.userId,
        role: row.role,
        invitedEmail: row.invitedEmail,
        acceptedAt: row.acceptedAt?.toISOString() ?? null,
        subscriptionIds: [],
      };
      if (row.subscriptionId !== null) current.subscriptionIds.push(row.subscriptionId);
      grouped.set(row.userId, current);
    }
    return [...grouped.values()];
  });

const clientMembers = (companyId: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<{
      userId: string;
      role: ClientMemberDescriptor["role"];
      accessId: string | null;
    }>`
      select membership.user_id as "userId", membership.role,
             grants.access_id::text as "accessId"
      from client_company_memberships membership
      join platform_users users
        on users.id = membership.user_id
       and users.recovery_deleted_at is null
       and users.purged_at is null
      left join client_employee_subscription_grants grants
        on grants.client_company_id = membership.company_id
       and grants.user_id = membership.user_id
       and grants.revoked_at is null
      where membership.company_id = ${companyId}
        and membership.revoked_at is null
      order by membership.created_at, membership.user_id, grants.access_id
    `;
    const grouped = new Map<
      string,
      Omit<ClientMemberDescriptor, "subscriptionAccessIds"> & { subscriptionAccessIds: string[] }
    >();
    for (const row of rows) {
      const current = grouped.get(row.userId) ?? {
        userId: row.userId,
        role: row.role,
        subscriptionAccessIds: [],
      };
      if (row.accessId !== null) current.subscriptionAccessIds.push(row.accessId);
      grouped.set(row.userId, current);
    }
    return [...grouped.values()];
  });

const publisherInvitations = (companyId: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    yield* sql`
      update workspace_invitations set state = 'expired', updated_at = now()
      where publisher_company_id = ${companyId} and state = 'pending' and expires_at <= now()
    `;
    const rows = yield* sql<InvitationRow>`
      select id::text, normalized_email as email, role,
             publisher_subscription_ids::text[] as "publisherSubscriptionIds",
             client_subscription_access_ids::text[] as "clientSubscriptionAccessIds",
             clerk_invitation_id as "externalId", state, expires_at as "expiresAt",
             delivery_lease_token::text as "deliveryLeaseToken",
             delivery_lease_expires_at as "deliveryLeaseExpiresAt", created_at as "createdAt"
      from workspace_invitations
      where publisher_company_id = ${companyId} and state in ('creating', 'pending', 'failed')
      order by created_at, id
    `;
    return rows.map(publisherInvitationDescriptor);
  });

const clientInvitations = (companyId: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    yield* sql`
      update workspace_invitations set state = 'expired', updated_at = now()
      where client_company_id = ${companyId} and state = 'pending' and expires_at <= now()
    `;
    const rows = yield* sql<InvitationRow>`
      select id::text, normalized_email as email, role,
             publisher_subscription_ids::text[] as "publisherSubscriptionIds",
             client_subscription_access_ids::text[] as "clientSubscriptionAccessIds",
             clerk_invitation_id as "externalId", state, expires_at as "expiresAt",
             delivery_lease_token::text as "deliveryLeaseToken",
             delivery_lease_expires_at as "deliveryLeaseExpiresAt", created_at as "createdAt"
      from workspace_invitations
      where client_company_id = ${companyId} and state in ('creating', 'pending', 'failed')
      order by created_at, id
    `;
    return rows.map(clientInvitationDescriptor);
  });

export const listIdentityWorkspaces = (identity: WorkspaceIdentity) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const publisherWorkspaces = yield* sql<{
      companyId: string;
      companyName: string;
      role: PublisherMemberDescriptor["role"];
    }>`
      select company.id::text as "companyId", company.name as "companyName", membership.role
      from publisher_company_memberships membership
      join publisher_companies company on company.id = membership.publisher_company_id
      join platform_users users on users.id = membership.user_id
      where membership.user_id = ${identity.userId}
        and membership.accepted_at is not null
        and users.recovery_deleted_at is null and users.purged_at is null
      order by lower(company.name), company.id
    `;
    const clientWorkspaces = yield* sql<{
      companyId: string;
      companyName: string;
      role: ClientMemberDescriptor["role"];
    }>`
      select company.id::text as "companyId", company.name as "companyName", membership.role
      from client_company_memberships membership
      join client_companies company on company.id = membership.company_id
      join platform_users users on users.id = membership.user_id
      where membership.user_id = ${identity.userId}
        and membership.revoked_at is null
        and company.recovery_deleted_at is null
        and users.recovery_deleted_at is null and users.purged_at is null
      order by lower(company.name), company.id
    `;
    return {
      publisherWorkspaces: publisherWorkspaces.map((workspace) => ({
        kind: "publisher" as const,
        ...workspace,
        landingPath: `/publisher/${workspace.companyId}`,
      })),
      clientWorkspaces: clientWorkspaces.map((workspace) => ({
        kind: "client" as const,
        ...workspace,
        landingPath: `/client/${workspace.companyId}`,
      })),
    };
  });

export const listPublisherMemberships = (identity: WorkspaceIdentity, companyId: string) =>
  Effect.gen(function* () {
    yield* requirePublisherCompanyAdmin(identity, companyId);
    return {
      members: yield* publisherMembers(companyId),
      invitations: yield* publisherInvitations(companyId),
    };
  });

export const listClientMemberships = (identity: WorkspaceIdentity, companyId: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          select pg_advisory_xact_lock(hashtext(${`hartlib:client-members:${companyId}`}))
        `;
        yield* requireClientCompanyAdmin(identity, companyId);
        return {
          members: yield* clientMembers(companyId),
          invitations: yield* clientInvitations(companyId),
        };
      }),
    );
  });

interface PreparedInvitation {
  readonly row: InvitationRow;
  readonly organizationId: string;
  readonly deliver: boolean;
  readonly inProgress: boolean;
}

const finalizeInvitation = (input: {
  readonly prepared: PreparedInvitation;
  readonly delivery: { readonly externalId: string; readonly expiresAt: Date };
  readonly identity: WorkspaceIdentity;
  readonly requestId: string;
  readonly action: string;
  readonly scopeKind: string;
  readonly scopeId: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const rows = yield* sql<InvitationRow>`
          update workspace_invitations
          set state = 'pending', clerk_invitation_id = ${input.delivery.externalId},
              expires_at = ${input.delivery.expiresAt}, delivery_lease_token = null,
              delivery_lease_expires_at = null, delivery_last_error_code = null,
              updated_at = now()
          where id = ${input.prepared.row.id} and state = 'creating'
            and delivery_lease_token = ${input.prepared.row.deliveryLeaseToken}
          returning id::text, normalized_email as email, role,
                    publisher_subscription_ids::text[] as "publisherSubscriptionIds",
                    client_subscription_access_ids::text[] as "clientSubscriptionAccessIds",
                    clerk_invitation_id as "externalId", state, expires_at as "expiresAt",
                    delivery_lease_token::text as "deliveryLeaseToken",
                    delivery_lease_expires_at as "deliveryLeaseExpiresAt",
                    created_at as "createdAt"
        `;
        let finalized = rows[0];
        if (finalized === undefined) {
          const reconciled = yield* sql<InvitationRow>`
            select id::text, normalized_email as email, role,
                   publisher_subscription_ids::text[] as "publisherSubscriptionIds",
                   client_subscription_access_ids::text[] as "clientSubscriptionAccessIds",
                   clerk_invitation_id as "externalId", state, expires_at as "expiresAt",
                   delivery_lease_token::text as "deliveryLeaseToken",
                   delivery_lease_expires_at as "deliveryLeaseExpiresAt",
                   created_at as "createdAt"
            from workspace_invitations where id = ${input.prepared.row.id} for update
          `;
          const candidate = reconciled[0];
          if (
            candidate?.state !== "pending" ||
            candidate.externalId !== input.delivery.externalId ||
            candidate.expiresAt?.getTime() !== input.delivery.expiresAt.getTime()
          ) {
            return yield* Effect.fail(new WorkspaceRuleError("invite_conflict"));
          }
          finalized = candidate;
        }
        yield* appendAuthorizationAudit({
          identity: input.identity,
          requestId: input.requestId,
          action: input.action,
          scopeKind: input.scopeKind,
          scopeId: input.scopeId,
          outcome: "succeeded",
        });
        return finalized;
      }),
    );
  });

export const invitePublisherMember = (input: {
  readonly identity: WorkspaceIdentity;
  readonly companyId: string;
  readonly email: string;
  readonly role: PublisherRole;
  readonly subscriptionIds: readonly string[];
  readonly requestId: string;
  readonly provider: WorkspaceInvitationProvider | null;
  readonly redirectUrl: string;
}) => {
  const operation = Effect.gen(function* () {
    const email = normalizeWorkspaceEmail(input.email);
    if (email === null || new Set(input.subscriptionIds).size !== input.subscriptionIds.length) {
      return yield* Effect.fail(new WorkspaceRuleError("invalid_body"));
    }
    const sql = yield* PgClient.PgClient;
    const prepared = yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* requirePublisherCompanyAdmin(input.identity, input.companyId);
        yield* sql`
          select pg_advisory_xact_lock(hashtext(${`hartlib:publisher-invites:${input.companyId}`}))
        `;
        if (input.subscriptionIds.length > 0) {
          const subscriptions = yield* sql<{ count: number }>`
            select count(*)::int count from publisher_subscriptions
            where publisher_company_id = ${input.companyId}
              and ${sql.in("id", input.subscriptionIds)}
          `;
          if (subscriptions[0]!.count !== input.subscriptionIds.length) {
            return yield* Effect.fail(new WorkspaceRuleError("subscription_not_found"));
          }
        }
        const companies = yield* sql<{ organizationId: string | null }>`
          select clerk_organization_id as "organizationId"
          from publisher_companies where id = ${input.companyId}
        `;
        const organizationId = companies[0]?.organizationId;
        if (organizationId === null || organizationId === undefined) {
          return yield* Effect.fail(new WorkspaceRuleError("clerk_organization_unavailable"));
        }
        yield* sql`
          update workspace_invitations
          set state = 'expired', updated_at = now()
          where publisher_company_id = ${input.companyId} and normalized_email = ${email}
            and state = 'pending' and expires_at <= now()
        `;
        const extant = yield* sql<InvitationRow>`
          select id::text, normalized_email as email, role,
                 publisher_subscription_ids::text[] as "publisherSubscriptionIds",
                 client_subscription_access_ids::text[] as "clientSubscriptionAccessIds",
                 clerk_invitation_id as "externalId", state, expires_at as "expiresAt",
                 delivery_lease_token::text as "deliveryLeaseToken",
                 delivery_lease_expires_at as "deliveryLeaseExpiresAt",
                 created_at as "createdAt"
          from workspace_invitations
          where publisher_company_id = ${input.companyId} and normalized_email = ${email}
            and state in ('creating', 'pending')
          for update
        `;
        if (extant[0] !== undefined) {
          const row = extant[0];
          if (
            row.role !== input.role ||
            !sameIds(row.publisherSubscriptionIds, input.subscriptionIds)
          ) {
            return yield* Effect.fail(new WorkspaceRuleError("invite_conflict"));
          }
          if (row.state === "pending") {
            return { row, organizationId, deliver: false, inProgress: false };
          }
          if (
            row.deliveryLeaseToken !== null &&
            row.deliveryLeaseExpiresAt !== null &&
            row.deliveryLeaseExpiresAt > new Date()
          ) {
            return { row, organizationId, deliver: false, inProgress: true };
          }
          const claimed = yield* sql<InvitationRow>`
            update workspace_invitations
            set delivery_lease_token = gen_random_uuid(),
                delivery_lease_expires_at = now() + ${INVITATION_DELIVERY_LEASE_INTERVAL}::interval,
                delivery_attempt_count = delivery_attempt_count + 1,
                delivery_last_attempt_at = now(), delivery_last_error_code = null,
                updated_at = now()
            where id = ${row.id} and state = 'creating'
              and (delivery_lease_expires_at is null or delivery_lease_expires_at <= now())
            returning id::text, normalized_email as email, role,
                      publisher_subscription_ids::text[] as "publisherSubscriptionIds",
                      client_subscription_access_ids::text[] as "clientSubscriptionAccessIds",
                      clerk_invitation_id as "externalId", state, expires_at as "expiresAt",
                      delivery_lease_token::text as "deliveryLeaseToken",
                      delivery_lease_expires_at as "deliveryLeaseExpiresAt",
                      created_at as "createdAt"
          `;
          if (claimed[0] === undefined) {
            return yield* Effect.fail(new WorkspaceRuleError("invitation_delivery_in_progress"));
          }
          return { row: claimed[0], organizationId, deliver: true, inProgress: false };
        }
        const inserted = yield* sql<InvitationRow>`
          insert into workspace_invitations (
            workspace_kind, publisher_company_id, normalized_email, role,
            publisher_subscription_ids, invited_by_user_id, delivery_attempt_count,
            delivery_lease_token, delivery_lease_expires_at, delivery_last_attempt_at
          ) values (
            'publisher', ${input.companyId}, ${email}, ${input.role},
            ${input.subscriptionIds}::uuid[], ${input.identity.userId}, 1,
            gen_random_uuid(), now() + ${INVITATION_DELIVERY_LEASE_INTERVAL}::interval, now()
          )
          returning id::text, normalized_email as email, role,
                    publisher_subscription_ids::text[] as "publisherSubscriptionIds",
                    client_subscription_access_ids::text[] as "clientSubscriptionAccessIds",
                    clerk_invitation_id as "externalId", state, expires_at as "expiresAt",
                    delivery_lease_token::text as "deliveryLeaseToken",
                    delivery_lease_expires_at as "deliveryLeaseExpiresAt",
                    created_at as "createdAt"
        `;
        return { row: inserted[0]!, organizationId, deliver: true, inProgress: false };
      }),
    );
    if (!prepared.deliver) {
      if (prepared.inProgress) {
        return yield* Effect.fail(new WorkspaceRuleError("invitation_delivery_in_progress"));
      }
      yield* appendAuthorizationAudit({
        identity: input.identity,
        requestId: input.requestId,
        action: "publisher.member.invite",
        scopeKind: "publisher_company",
        scopeId: input.companyId,
        outcome: "succeeded",
      });
      return { invitation: publisherInvitationDescriptor(prepared.row), delivered: false };
    }
    const leaseToken = prepared.row.deliveryLeaseToken;
    if (leaseToken === null) {
      return yield* Effect.fail(new WorkspaceRuleError("invite_conflict"));
    }
    if (input.provider === null || input.redirectUrl === "") {
      yield* releaseInvitationDelivery(
        prepared.row.id,
        leaseToken,
        "invitation_provider_unavailable",
      );
      return yield* Effect.fail(new WorkspaceRuleError("invitation_provider_unavailable"));
    }
    const delivery = yield* Effect.tryPromise({
      try: () =>
        input.provider!.create({
          organizationId: prepared.organizationId,
          email,
          organizationRole: input.role === "admin" ? "org:admin" : "org:member",
          inviterUserId: input.identity.userId,
          redirectUrl: input.redirectUrl,
          invitationId: prepared.row.id,
        }),
      catch: () => new WorkspaceRuleError("invitation_delivery_failed"),
    }).pipe(
      Effect.catch((error) =>
        releaseInvitationDelivery(prepared.row.id, leaseToken, "invitation_delivery_failed").pipe(
          Effect.andThen(Effect.fail(error)),
        ),
      ),
    );
    if (!validInvitationDelivery(delivery)) {
      yield* releaseInvitationDelivery(prepared.row.id, leaseToken, "invitation_delivery_invalid");
      return yield* Effect.fail(new WorkspaceRuleError("invitation_delivery_failed"));
    }
    const finalized = yield* finalizeInvitation({
      prepared,
      delivery,
      identity: input.identity,
      requestId: input.requestId,
      action: "publisher.member.invite",
      scopeKind: "publisher_company",
      scopeId: input.companyId,
    });
    return { invitation: publisherInvitationDescriptor(finalized), delivered: true };
  });
  return operation.pipe(
    Effect.catch((error) =>
      auditDeniedThenFail(
        input.identity,
        input.requestId,
        "publisher.member.invite",
        "publisher_company",
        input.companyId,
        error,
      ),
    ),
  );
};

export const inviteClientMember = (input: {
  readonly identity: WorkspaceIdentity;
  readonly companyId: string;
  readonly email: string;
  readonly role: ClientRole;
  readonly subscriptionAccessIds: readonly string[];
  readonly requestId: string;
  readonly provider: WorkspaceInvitationProvider | null;
  readonly redirectUrl: string;
}) => {
  const operation = Effect.gen(function* () {
    const email = normalizeWorkspaceEmail(input.email);
    if (
      email === null ||
      new Set(input.subscriptionAccessIds).size !== input.subscriptionAccessIds.length
    ) {
      return yield* Effect.fail(new WorkspaceRuleError("invalid_body"));
    }
    const sql = yield* PgClient.PgClient;
    const prepared = yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          select pg_advisory_xact_lock(hashtext(${`hartlib:client-members:${input.companyId}`}))
        `;
        yield* requireClientCompanyAdmin(input.identity, input.companyId);
        yield* sql`
          select pg_advisory_xact_lock(hashtext(${`hartlib:client-invites:${input.companyId}`}))
        `;
        if (input.subscriptionAccessIds.length > 0) {
          const accesses = yield* sql<{ count: number }>`
            select count(*)::int count from client_subscription_accesses
            where client_company_id = ${input.companyId}
              and state in ('active', 'ending', 'paused')
              and ${sql.in("id", input.subscriptionAccessIds)}
          `;
          if (accesses[0]!.count !== input.subscriptionAccessIds.length) {
            return yield* Effect.fail(new WorkspaceRuleError("access_not_found"));
          }
        }
        const companies = yield* sql<{ organizationId: string | null }>`
          select clerk_organization_id as "organizationId"
          from client_companies where id = ${input.companyId}
            and recovery_deleted_at is null and purged_at is null
        `;
        const organizationId = companies[0]?.organizationId;
        if (organizationId === null || organizationId === undefined) {
          return yield* Effect.fail(new WorkspaceRuleError("clerk_organization_unavailable"));
        }
        yield* sql`
          update workspace_invitations
          set state = 'expired', updated_at = now()
          where client_company_id = ${input.companyId} and normalized_email = ${email}
            and state = 'pending' and expires_at <= now()
        `;
        const extant = yield* sql<InvitationRow>`
          select id::text, normalized_email as email, role,
                 publisher_subscription_ids::text[] as "publisherSubscriptionIds",
                 client_subscription_access_ids::text[] as "clientSubscriptionAccessIds",
                 clerk_invitation_id as "externalId", state, expires_at as "expiresAt",
                 delivery_lease_token::text as "deliveryLeaseToken",
                 delivery_lease_expires_at as "deliveryLeaseExpiresAt",
                 created_at as "createdAt"
          from workspace_invitations
          where client_company_id = ${input.companyId} and normalized_email = ${email}
            and state in ('creating', 'pending')
          for update
        `;
        if (extant[0] !== undefined) {
          const row = extant[0];
          if (
            row.role !== input.role ||
            !sameIds(row.clientSubscriptionAccessIds, input.subscriptionAccessIds)
          ) {
            return yield* Effect.fail(new WorkspaceRuleError("invite_conflict"));
          }
          if (row.state === "pending") {
            return { row, organizationId, deliver: false, inProgress: false };
          }
          if (
            row.deliveryLeaseToken !== null &&
            row.deliveryLeaseExpiresAt !== null &&
            row.deliveryLeaseExpiresAt > new Date()
          ) {
            return { row, organizationId, deliver: false, inProgress: true };
          }
          const claimed = yield* sql<InvitationRow>`
            update workspace_invitations
            set delivery_lease_token = gen_random_uuid(),
                delivery_lease_expires_at = now() + ${INVITATION_DELIVERY_LEASE_INTERVAL}::interval,
                delivery_attempt_count = delivery_attempt_count + 1,
                delivery_last_attempt_at = now(), delivery_last_error_code = null,
                updated_at = now()
            where id = ${row.id} and state = 'creating'
              and (delivery_lease_expires_at is null or delivery_lease_expires_at <= now())
            returning id::text, normalized_email as email, role,
                      publisher_subscription_ids::text[] as "publisherSubscriptionIds",
                      client_subscription_access_ids::text[] as "clientSubscriptionAccessIds",
                      clerk_invitation_id as "externalId", state, expires_at as "expiresAt",
                      delivery_lease_token::text as "deliveryLeaseToken",
                      delivery_lease_expires_at as "deliveryLeaseExpiresAt",
                      created_at as "createdAt"
          `;
          if (claimed[0] === undefined) {
            return yield* Effect.fail(new WorkspaceRuleError("invitation_delivery_in_progress"));
          }
          return { row: claimed[0], organizationId, deliver: true, inProgress: false };
        }
        const inserted = yield* sql<InvitationRow>`
          insert into workspace_invitations (
            workspace_kind, client_company_id, normalized_email, role,
            client_subscription_access_ids, invited_by_user_id, delivery_attempt_count,
            delivery_lease_token, delivery_lease_expires_at, delivery_last_attempt_at
          ) values (
            'client', ${input.companyId}, ${email}, ${input.role},
            ${input.subscriptionAccessIds}::uuid[], ${input.identity.userId}, 1,
            gen_random_uuid(), now() + ${INVITATION_DELIVERY_LEASE_INTERVAL}::interval, now()
          )
          returning id::text, normalized_email as email, role,
                    publisher_subscription_ids::text[] as "publisherSubscriptionIds",
                    client_subscription_access_ids::text[] as "clientSubscriptionAccessIds",
                    clerk_invitation_id as "externalId", state, expires_at as "expiresAt",
                    delivery_lease_token::text as "deliveryLeaseToken",
                    delivery_lease_expires_at as "deliveryLeaseExpiresAt",
                    created_at as "createdAt"
        `;
        return { row: inserted[0]!, organizationId, deliver: true, inProgress: false };
      }),
    );
    if (!prepared.deliver) {
      if (prepared.inProgress) {
        return yield* Effect.fail(new WorkspaceRuleError("invitation_delivery_in_progress"));
      }
      yield* appendAuthorizationAudit({
        identity: input.identity,
        requestId: input.requestId,
        action: "client.member.invite",
        scopeKind: "client_company",
        scopeId: input.companyId,
        outcome: "succeeded",
      });
      return { invitation: clientInvitationDescriptor(prepared.row), delivered: false };
    }
    const leaseToken = prepared.row.deliveryLeaseToken;
    if (leaseToken === null) {
      return yield* Effect.fail(new WorkspaceRuleError("invite_conflict"));
    }
    if (input.provider === null || input.redirectUrl === "") {
      yield* releaseInvitationDelivery(
        prepared.row.id,
        leaseToken,
        "invitation_provider_unavailable",
      );
      return yield* Effect.fail(new WorkspaceRuleError("invitation_provider_unavailable"));
    }
    const delivery = yield* Effect.tryPromise({
      try: () =>
        input.provider!.create({
          organizationId: prepared.organizationId,
          email,
          organizationRole: input.role === "admin" ? "org:admin" : "org:member",
          inviterUserId: input.identity.userId,
          redirectUrl: input.redirectUrl,
          invitationId: prepared.row.id,
        }),
      catch: () => new WorkspaceRuleError("invitation_delivery_failed"),
    }).pipe(
      Effect.catch((error) =>
        releaseInvitationDelivery(prepared.row.id, leaseToken, "invitation_delivery_failed").pipe(
          Effect.andThen(Effect.fail(error)),
        ),
      ),
    );
    if (!validInvitationDelivery(delivery)) {
      yield* releaseInvitationDelivery(prepared.row.id, leaseToken, "invitation_delivery_invalid");
      return yield* Effect.fail(new WorkspaceRuleError("invitation_delivery_failed"));
    }
    const finalized = yield* finalizeInvitation({
      prepared,
      delivery,
      identity: input.identity,
      requestId: input.requestId,
      action: "client.member.invite",
      scopeKind: "client_company",
      scopeId: input.companyId,
    });
    return { invitation: clientInvitationDescriptor(finalized), delivered: true };
  });
  return operation.pipe(
    Effect.catch((error) =>
      auditDeniedThenFail(
        input.identity,
        input.requestId,
        "client.member.invite",
        "client_company",
        input.companyId,
        error,
      ),
    ),
  );
};

export type PublisherMemberMutation =
  | { readonly method: "DELETE" }
  | {
      readonly method: "PATCH";
      readonly role: PublisherRole;
      readonly subscriptionIds: readonly string[];
    };

export type ClientMemberMutation =
  | { readonly method: "DELETE" }
  | { readonly method: "PATCH"; readonly role: ClientRole };

export const mutatePublisherMember = (input: {
  readonly identity: WorkspaceIdentity;
  readonly companyId: string;
  readonly userId: string;
  readonly mutation: PublisherMemberMutation;
  readonly requestId: string;
}) => {
  const action = `publisher.member.${input.mutation.method === "DELETE" ? "delete" : "update"}`;
  const operation = Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          select pg_advisory_xact_lock(hashtext(${`hartlib:publisher-members:${input.companyId}`}))
        `;
        yield* requirePublisherCompanyAdmin(input.identity, input.companyId);
        const target = yield* sql<{ role: PublisherRole }>`
          select membership.role
          from publisher_company_memberships membership
          join platform_users users
            on users.id = membership.user_id
           and users.recovery_deleted_at is null
           and users.purged_at is null
          where membership.publisher_company_id = ${input.companyId}
            and membership.user_id = ${input.userId}
          for update of membership
        `;
        if (target[0] === undefined) {
          return yield* Effect.fail(new WorkspaceRuleError("member_not_found"));
        }
        const removesAdmin =
          target[0].role === "admin" &&
          (input.mutation.method === "DELETE" || input.mutation.role !== "admin");
        if (removesAdmin) {
          const others = yield* sql<{ count: number }>`
            select count(*)::int count
            from publisher_company_memberships membership
            join platform_users users
              on users.id = membership.user_id
             and users.recovery_deleted_at is null
             and users.purged_at is null
            where membership.publisher_company_id = ${input.companyId}
              and membership.user_id <> ${input.userId}
              and membership.role = 'admin'
          `;
          if (others[0]!.count === 0) {
            return yield* Effect.fail(new WorkspaceRuleError("last_admin_required"));
          }
        }
        if (input.mutation.method === "DELETE") {
          const deleted = yield* sql<{ userId: string }>`
            delete from publisher_company_memberships
            where publisher_company_id = ${input.companyId} and user_id = ${input.userId}
            returning user_id as "userId"
          `;
          if (deleted[0] === undefined) {
            return yield* Effect.fail(new WorkspaceRuleError("member_not_found"));
          }
        } else {
          if (
            new Set(input.mutation.subscriptionIds).size !== input.mutation.subscriptionIds.length
          ) {
            return yield* Effect.fail(new WorkspaceRuleError("subscription_not_found"));
          }
          if (input.mutation.subscriptionIds.length > 0) {
            const subscriptions = yield* sql<{ count: number }>`
              select count(*)::int count from publisher_subscriptions
              where publisher_company_id = ${input.companyId}
                and ${sql.in("id", input.mutation.subscriptionIds)}
            `;
            if (subscriptions[0]!.count !== input.mutation.subscriptionIds.length) {
              return yield* Effect.fail(new WorkspaceRuleError("subscription_not_found"));
            }
          }
          const updated = yield* sql<{ userId: string }>`
            update publisher_company_memberships
            set role = ${input.mutation.role}, updated_at = now()
            where publisher_company_id = ${input.companyId} and user_id = ${input.userId}
            returning user_id as "userId"
          `;
          if (updated[0] === undefined) {
            return yield* Effect.fail(new WorkspaceRuleError("member_not_found"));
          }
          yield* sql`
            delete from publisher_membership_subscription_grants
            where publisher_company_id = ${input.companyId} and user_id = ${input.userId}
          `;
          for (const subscriptionId of input.mutation.subscriptionIds) {
            yield* sql`
              insert into publisher_membership_subscription_grants (
                publisher_company_id, user_id, subscription_id, granted_by_user_id
              ) values (
                ${input.companyId}, ${input.userId}, ${subscriptionId}, ${input.identity.userId}
              )
            `;
          }
        }
        yield* appendAuthorizationAudit({
          identity: input.identity,
          requestId: input.requestId,
          action,
          scopeKind: "publisher_company",
          scopeId: input.companyId,
          outcome: "succeeded",
        });
      }),
    );
  });
  return operation.pipe(
    Effect.catch((error) =>
      auditDeniedThenFail(
        input.identity,
        input.requestId,
        action,
        "publisher_company",
        input.companyId,
        error,
      ),
    ),
  );
};

export const mutateClientMember = (input: {
  readonly identity: WorkspaceIdentity;
  readonly companyId: string;
  readonly userId: string;
  readonly mutation: ClientMemberMutation;
  readonly requestId: string;
}) => {
  const action = `client.member.${input.mutation.method === "DELETE" ? "delete" : "update"}`;
  const operation = Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          select pg_advisory_xact_lock(hashtext(${`hartlib:client-members:${input.companyId}`}))
        `;
        yield* requireClientCompanyAdmin(input.identity, input.companyId);
        const target = yield* sql<{ role: ClientRole }>`
          select membership.role
          from client_company_memberships membership
          join platform_users users
            on users.id = membership.user_id
           and users.recovery_deleted_at is null
           and users.purged_at is null
          where membership.company_id = ${input.companyId}
            and membership.user_id = ${input.userId}
            and membership.revoked_at is null
          for update of membership
        `;
        if (target[0] === undefined) {
          return yield* Effect.fail(new WorkspaceRuleError("member_not_found"));
        }
        const removesAdmin =
          target[0].role === "admin" &&
          (input.mutation.method === "DELETE" || input.mutation.role !== "admin");
        if (removesAdmin) {
          const others = yield* sql<{ count: number }>`
            select count(*)::int count
            from client_company_memberships membership
            join platform_users users
              on users.id = membership.user_id
             and users.recovery_deleted_at is null
             and users.purged_at is null
            where membership.company_id = ${input.companyId}
              and membership.user_id <> ${input.userId}
              and membership.role = 'admin'
              and membership.revoked_at is null
          `;
          if (others[0]!.count === 0) {
            return yield* Effect.fail(new WorkspaceRuleError("last_admin_required"));
          }
        }
        if (input.mutation.method === "DELETE") {
          const deleted = yield* sql<{ userId: string }>`
            update client_company_memberships
            set revoked_at = now(), revoked_by_user_id = ${input.identity.userId}
            where company_id = ${input.companyId} and user_id = ${input.userId}
              and revoked_at is null
            returning user_id as "userId"
          `;
          if (deleted[0] === undefined) {
            return yield* Effect.fail(new WorkspaceRuleError("member_not_found"));
          }
          yield* sql`
            update client_employee_subscription_grants
            set revoked_at = coalesce(revoked_at, now()),
                revoked_by_user_id = coalesce(revoked_by_user_id, ${input.identity.userId})
            where client_company_id = ${input.companyId} and user_id = ${input.userId}
          `;
        } else {
          const updated = yield* sql<{ userId: string }>`
            update client_company_memberships set role = ${input.mutation.role}
            where company_id = ${input.companyId} and user_id = ${input.userId}
              and revoked_at is null
            returning user_id as "userId"
          `;
          if (updated[0] === undefined) {
            return yield* Effect.fail(new WorkspaceRuleError("member_not_found"));
          }
        }
        yield* appendAuthorizationAudit({
          identity: input.identity,
          requestId: input.requestId,
          action,
          scopeKind: "client_company",
          scopeId: input.companyId,
          outcome: "succeeded",
        });
      }),
    );
  });
  return operation.pipe(
    Effect.catch((error) =>
      auditDeniedThenFail(
        input.identity,
        input.requestId,
        action,
        "client_company",
        input.companyId,
        error,
      ),
    ),
  );
};

export const grantClientSubscription = (input: {
  readonly identity: WorkspaceIdentity;
  readonly companyId: string;
  readonly userId: string;
  readonly accessId: string;
  readonly requestId: string;
}) => {
  const operation = Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          select pg_advisory_xact_lock(hashtext(${`hartlib:client-members:${input.companyId}`}))
        `;
        yield* requireClientCompanyAdmin(input.identity, input.companyId);
        yield* sql`
          insert into client_employee_subscription_grants (
            access_id, client_company_id, user_id, granted_by_user_id,
            granted_at, revoked_at, revoked_by_user_id
          )
          select access.id, access.client_company_id, membership.user_id,
                 ${input.identity.userId}, now(), null, null
          from client_subscription_accesses access
          join client_company_memberships membership
            on membership.company_id = access.client_company_id
           and membership.user_id = ${input.userId}
           and membership.revoked_at is null
          join platform_users users
            on users.id = membership.user_id
           and users.recovery_deleted_at is null and users.purged_at is null
          where access.id = ${input.accessId} and access.client_company_id = ${input.companyId}
          on conflict (access_id, user_id) do update set
            revoked_at = null, revoked_by_user_id = null,
            granted_at = now(), granted_by_user_id = excluded.granted_by_user_id
        `;
        const exists = yield* sql<{ exists: boolean }>`
          select exists(
            select 1 from client_employee_subscription_grants
            where access_id = ${input.accessId} and user_id = ${input.userId} and revoked_at is null
          ) as exists
        `;
        if (exists[0]?.exists !== true) {
          return yield* Effect.fail(new WorkspaceRuleError("access_not_found"));
        }
        yield* appendAuthorizationAudit({
          identity: input.identity,
          requestId: input.requestId,
          action: "client.subscription_grant.upsert",
          scopeKind: "client_subscription_access",
          scopeId: input.accessId,
          outcome: "succeeded",
        });
      }),
    );
  });
  return operation.pipe(
    Effect.catch((error) =>
      auditDeniedThenFail(
        input.identity,
        input.requestId,
        "client.subscription_grant.upsert",
        "client_subscription_access",
        input.accessId,
        error,
      ),
    ),
  );
};

export const revokeClientSubscription = (input: {
  readonly identity: WorkspaceIdentity;
  readonly companyId: string;
  readonly userId: string;
  readonly accessId: string;
  readonly requestId: string;
}) => {
  const operation = Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          select pg_advisory_xact_lock(hashtext(${`hartlib:client-members:${input.companyId}`}))
        `;
        yield* requireClientCompanyAdmin(input.identity, input.companyId);
        const rows = yield* sql<{ accessId: string }>`
          update client_employee_subscription_grants
          set revoked_at = coalesce(revoked_at, now()),
              revoked_by_user_id = coalesce(revoked_by_user_id, ${input.identity.userId})
          where access_id = ${input.accessId} and client_company_id = ${input.companyId}
            and user_id = ${input.userId}
          returning access_id::text as "accessId"
        `;
        if (rows[0] === undefined) {
          return yield* Effect.fail(new WorkspaceRuleError("access_not_found"));
        }
        yield* appendAuthorizationAudit({
          identity: input.identity,
          requestId: input.requestId,
          action: "client.subscription_grant.revoke",
          scopeKind: "client_subscription_access",
          scopeId: input.accessId,
          outcome: "succeeded",
        });
      }),
    );
  });
  return operation.pipe(
    Effect.catch((error) =>
      auditDeniedThenFail(
        input.identity,
        input.requestId,
        "client.subscription_grant.revoke",
        "client_subscription_access",
        input.accessId,
        error,
      ),
    ),
  );
};
