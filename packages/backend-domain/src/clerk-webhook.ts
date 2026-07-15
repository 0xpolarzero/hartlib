import type { WebhookEvent } from "@clerk/backend/webhooks";
import { PgClient } from "@effect/sql-pg";
import { Effect } from "effect";

const LOCAL_INVITATION_METADATA_KEY = "briefWorkspaceInvitationId";

const normalizedEmail = (value: string): string => value.trim().toLowerCase();

type UserUpsertEvent = Extract<WebhookEvent, { type: "user.created" | "user.updated" }>;
type InvitationEvent = Extract<
  WebhookEvent,
  {
    type:
      | "organizationInvitation.created"
      | "organizationInvitation.revoked"
      | "organizationInvitation.accepted";
  }
>;

interface InvitationRow {
  readonly id: string;
  readonly workspaceKind: "publisher" | "client";
  readonly publisherCompanyId: string | null;
  readonly clientCompanyId: string | null;
  readonly email: string;
  readonly role: "admin" | "manager" | "member";
  readonly publisherSubscriptionIds: readonly string[];
  readonly clientSubscriptionAccessIds: readonly string[];
  readonly externalId: string | null;
  readonly state: "creating" | "pending" | "accepted" | "revoked" | "expired" | "failed";
  readonly acceptedUserId: string | null;
  readonly expiresAt: Date | null;
  readonly invitedByUserId: string;
}

type MembershipLaneKey = `client:${string}` | `publisher:${string}`;

const invitationMembershipLaneKey = (
  invitation: Pick<InvitationRow, "workspaceKind" | "publisherCompanyId" | "clientCompanyId">,
): MembershipLaneKey | null => {
  if (invitation.workspaceKind === "publisher" && invitation.publisherCompanyId !== null) {
    return `publisher:${invitation.publisherCompanyId}`;
  }
  if (invitation.workspaceKind === "client" && invitation.clientCompanyId !== null) {
    return `client:${invitation.clientCompanyId}`;
  }
  return null;
};

const canonicalMembershipLaneKeys = (
  laneKeys: readonly MembershipLaneKey[],
): readonly MembershipLaneKey[] => [...new Set(laneKeys)].sort();

const sameMembershipLaneKeys = (
  left: readonly MembershipLaneKey[],
  right: readonly MembershipLaneKey[],
): boolean => {
  const canonicalLeft = canonicalMembershipLaneKeys(left);
  const canonicalRight = canonicalMembershipLaneKeys(right);
  return (
    canonicalLeft.length === canonicalRight.length &&
    canonicalLeft.every((laneKey, index) => laneKey === canonicalRight[index])
  );
};

const lockMembershipLanes = (laneKeys: readonly MembershipLaneKey[]) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    // Mixed client/publisher operations use the complete typed key as the
    // global comparator. Default lexical ordering puts client:* before
    // publisher:* and matches publisher-document authorization and purge.
    for (const laneKey of canonicalMembershipLaneKeys(laneKeys)) {
      const separator = laneKey.indexOf(":");
      const kind = laneKey.slice(0, separator);
      const companyId = laneKey.slice(separator + 1);
      yield* sql`
        select pg_advisory_xact_lock(
          hashtext(${kind === "client" ? `brief:client-members:${companyId}` : `brief:publisher-members:${companyId}`})
        )
      `;
    }
  });

const acceptedInvitationMembershipLanes = (userId: string, email: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<
      Pick<InvitationRow, "workspaceKind" | "publisherCompanyId" | "clientCompanyId">
    >`
      select workspace_kind as "workspaceKind",
             publisher_company_id::text as "publisherCompanyId",
             client_company_id::text as "clientCompanyId"
      from workspace_invitations
      where accepted_user_id = ${userId} and normalized_email = ${email}
        and state = 'accepted'
      order by workspace_kind, publisher_company_id::text, client_company_id::text
    `;
    const laneKeys: MembershipLaneKey[] = [];
    for (const row of rows) {
      const laneKey = invitationMembershipLaneKey(row);
      if (laneKey === null) {
        return yield* Effect.fail(new Error("workspace_invitation_scope_invalid"));
      }
      laneKeys.push(laneKey);
    }
    return canonicalMembershipLaneKeys(laneKeys);
  });

const invitationMetadataId = (event: InvitationEvent): string | null => {
  const value = event.data.private_metadata[LOCAL_INVITATION_METADATA_KEY];
  return typeof value === "string" && value.trim() !== "" ? value : null;
};

const providerExpiry = (event: InvitationEvent): Date => {
  if (!Number.isSafeInteger(event.data.expires_at) || event.data.expires_at < 0) {
    throw new Error("workspace_invitation_expiry_invalid");
  }
  const expiresAt = new Date(event.data.expires_at);
  if (Number.isNaN(expiresAt.getTime())) {
    throw new Error("workspace_invitation_expiry_invalid");
  }
  return expiresAt;
};

const loadProviderInvitation = (event: InvitationEvent) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const metadataId = invitationMetadataId(event);
    const snapshots = yield* sql<
      Pick<InvitationRow, "id" | "workspaceKind" | "publisherCompanyId" | "clientCompanyId">
    >`
      select id::text, workspace_kind as "workspaceKind",
             publisher_company_id::text as "publisherCompanyId",
             client_company_id::text as "clientCompanyId"
      from workspace_invitations
      where clerk_invitation_id = ${event.data.id}
         or (${metadataId}::text is not null and id::text = ${metadataId})
      order by id
      limit 2
    `;
    if (snapshots.length === 0) return null;
    if (metadataId === null) {
      return yield* Effect.fail(new Error("workspace_invitation_metadata_required"));
    }
    if (snapshots.length !== 1 || snapshots[0]!.id !== metadataId) {
      return yield* Effect.fail(new Error("workspace_invitation_identity_conflict"));
    }
    const snapshot = snapshots[0]!;
    const membershipLaneKey = invitationMembershipLaneKey(snapshot);
    if (membershipLaneKey !== null) yield* lockMembershipLanes([membershipLaneKey]);
    const organizations =
      snapshot.workspaceKind === "publisher"
        ? yield* sql<{ organizationId: string | null; active: boolean }>`
            select clerk_organization_id as "organizationId", true as active
            from publisher_companies where id = ${snapshot.publisherCompanyId}
            for update
          `
        : yield* sql<{ organizationId: string | null; active: boolean }>`
            select clerk_organization_id as "organizationId",
                   (recovery_deleted_at is null and purged_at is null) as active
            from client_companies where id = ${snapshot.clientCompanyId}
            for update
          `;
    const organization = organizations[0];
    if (organization === undefined) return null;
    const rows = yield* sql<InvitationRow>`
      select id::text, workspace_kind as "workspaceKind",
             publisher_company_id::text as "publisherCompanyId",
             client_company_id::text as "clientCompanyId", normalized_email as email, role,
             publisher_subscription_ids::text[] as "publisherSubscriptionIds",
             client_subscription_access_ids::text[] as "clientSubscriptionAccessIds",
             clerk_invitation_id as "externalId", state,
             accepted_user_id as "acceptedUserId", expires_at as "expiresAt",
             invited_by_user_id as "invitedByUserId"
      from workspace_invitations where id = ${snapshot.id} for update
    `;
    const invitation = rows[0];
    if (invitation === undefined) return null;
    const expectedOrganizationRole = invitation.role === "admin" ? "org:admin" : "org:member";
    if (
      organization.organizationId === null ||
      event.data.organization_id !== organization.organizationId ||
      normalizedEmail(event.data.email_address) !== invitation.email ||
      event.data.role !== expectedOrganizationRole ||
      (invitation.externalId !== null && invitation.externalId !== event.data.id)
    ) {
      return yield* Effect.fail(new Error("workspace_invitation_identity_mismatch"));
    }
    return { invitation, activeCompany: organization.active, membershipLaneKey };
  });

const linkAcceptedInvitation = (
  invitationId: string,
  heldMembershipLaneKeys?: readonly MembershipLaneKey[],
) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const scopes = yield* sql<
      Pick<InvitationRow, "workspaceKind" | "publisherCompanyId" | "clientCompanyId">
    >`
      select workspace_kind as "workspaceKind",
             publisher_company_id::text as "publisherCompanyId",
             client_company_id::text as "clientCompanyId"
      from workspace_invitations
      where id = ${invitationId} and state = 'accepted'
    `;
    const scope = scopes[0];
    if (scope === undefined) return;
    const membershipLaneKey = invitationMembershipLaneKey(scope);
    if (membershipLaneKey === null) {
      return yield* Effect.fail(new Error("workspace_invitation_scope_invalid"));
    }
    if (heldMembershipLaneKeys === undefined) {
      yield* lockMembershipLanes([membershipLaneKey]);
    } else if (!heldMembershipLaneKeys.includes(membershipLaneKey)) {
      return yield* Effect.fail(new Error("workspace_invitation_membership_lane_not_held"));
    }
    const invitations = yield* sql<InvitationRow>`
      select invitation.id::text, invitation.workspace_kind as "workspaceKind",
             invitation.publisher_company_id::text as "publisherCompanyId",
             invitation.client_company_id::text as "clientCompanyId",
             invitation.normalized_email as email, invitation.role,
             invitation.publisher_subscription_ids::text[] as "publisherSubscriptionIds",
             invitation.client_subscription_access_ids::text[] as "clientSubscriptionAccessIds",
             invitation.clerk_invitation_id as "externalId", invitation.state,
             invitation.accepted_user_id as "acceptedUserId",
             invitation.expires_at as "expiresAt",
             invitation.invited_by_user_id as "invitedByUserId"
      from workspace_invitations invitation
      left join client_companies client_company
        on client_company.id = invitation.client_company_id
      where invitation.id = ${invitationId} and invitation.state = 'accepted'
        and (
          invitation.workspace_kind = 'publisher'
          or (
            client_company.recovery_deleted_at is null
            and client_company.purged_at is null
          )
        )
      for update of invitation
    `;
    const invitation = invitations[0];
    if (invitation === undefined || invitation.acceptedUserId === null) return;
    if (invitationMembershipLaneKey(invitation) !== membershipLaneKey) {
      return yield* Effect.fail(new Error("workspace_invitation_scope_changed"));
    }
    const users = yield* sql<{ email: string; deletedAt: Date | null; purgedAt: Date | null }>`
      select lower(primary_email) as email, recovery_deleted_at as "deletedAt",
             purged_at as "purgedAt"
      from platform_users where id = ${invitation.acceptedUserId}
      for share
    `;
    const user = users[0];
    if (user === undefined) return;
    if (
      user.deletedAt !== null ||
      user.purgedAt !== null ||
      normalizedEmail(user.email) !== invitation.email
    ) {
      return yield* Effect.fail(new Error("invitation_identity_mismatch"));
    }
    if (invitation.workspaceKind === "publisher") {
      yield* sql`
        insert into publisher_company_memberships (
          publisher_company_id, user_id, role, invited_email, accepted_at
        ) values (
          ${invitation.publisherCompanyId}, ${invitation.acceptedUserId}, ${invitation.role},
          ${invitation.email}, now()
        )
        on conflict (publisher_company_id, user_id) do update set
          role = excluded.role, invited_email = excluded.invited_email,
          accepted_at = coalesce(publisher_company_memberships.accepted_at, excluded.accepted_at),
          updated_at = now()
      `;
      for (const subscriptionId of invitation.publisherSubscriptionIds) {
        yield* sql`
          insert into publisher_membership_subscription_grants (
            publisher_company_id, user_id, subscription_id, granted_by_user_id
          ) values (
            ${invitation.publisherCompanyId}, ${invitation.acceptedUserId}, ${subscriptionId},
            ${invitation.invitedByUserId}
          ) on conflict do nothing
        `;
      }
      return;
    }
    yield* sql`
      insert into client_company_memberships (
        company_id, user_id, role, revoked_at, revoked_by_user_id
      ) values (
        ${invitation.clientCompanyId}, ${invitation.acceptedUserId}, ${invitation.role}, null, null
      )
      on conflict (company_id, user_id) do update set
        role = excluded.role, revoked_at = null, revoked_by_user_id = null
    `;
    for (const accessId of invitation.clientSubscriptionAccessIds) {
      yield* sql`
        update client_subscription_accesses
        set state = 'active', accepted_at = coalesce(accepted_at, now()),
            subscribed_at = coalesce(subscribed_at, now()), updated_at = now()
        where id = ${accessId} and client_company_id = ${invitation.clientCompanyId}
          and state = 'invited' and lower(first_admin_email) = ${invitation.email}
      `;
      yield* sql`
        insert into client_employee_subscription_grants (
          access_id, client_company_id, user_id, granted_by_user_id
        )
        select access.id, access.client_company_id, ${invitation.acceptedUserId},
               ${invitation.invitedByUserId}
        from client_subscription_accesses access
        where access.id = ${accessId} and access.client_company_id = ${invitation.clientCompanyId}
          and access.state in ('active', 'ending', 'paused')
        on conflict (access_id, user_id) do update set
          revoked_at = null, revoked_by_user_id = null,
          granted_at = now(), granted_by_user_id = excluded.granted_by_user_id
      `;
    }
  });

const lifecycleRank = (kind: "user.created" | "user.updated" | "user.deleted"): number =>
  kind === "user.deleted" ? 3 : kind === "user.created" ? 2 : 1;

const isNewerLifecycleEvent = (
  incoming: {
    readonly timestamp: number;
    readonly kind: "user.created" | "user.updated" | "user.deleted";
    readonly id: string;
  },
  current: {
    readonly timestamp: number;
    readonly kind: "user.created" | "user.updated" | "user.deleted";
    readonly id: string;
  },
): boolean =>
  incoming.timestamp > current.timestamp ||
  (incoming.timestamp === current.timestamp &&
    (lifecycleRank(incoming.kind) > lifecycleRank(current.kind) ||
      (lifecycleRank(incoming.kind) === lifecycleRank(current.kind) && incoming.id > current.id)));

const projectUserLifecycle = (input: {
  readonly userId: string;
  readonly eventId: string;
  readonly eventTimestamp: number;
  readonly kind: "user.created" | "user.updated" | "user.deleted";
}) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    yield* sql`
      insert into clerk_user_lifecycle_state (
        clerk_user_id, state, event_timestamp, event_kind, event_id
      ) values (
        ${input.userId}, ${input.kind === "user.deleted" ? "deleted" : "active"},
        ${input.eventTimestamp}, ${input.kind}, ${input.eventId}
      ) on conflict (clerk_user_id) do nothing
    `;
    const rows = yield* sql<{
      state: "active" | "deleted";
      timestamp: number;
      kind: "user.created" | "user.updated" | "user.deleted";
      id: string;
    }>`
      select state, event_timestamp::float8 as timestamp, event_kind as kind, event_id as id
      from clerk_user_lifecycle_state where clerk_user_id = ${input.userId} for update
    `;
    const current = rows[0]!;
    const exactCurrent =
      current.timestamp === input.eventTimestamp &&
      current.kind === input.kind &&
      current.id === input.eventId;
    if (exactCurrent) {
      return { state: current.state, applied: true, restored: false } as const;
    }
    if (
      !isNewerLifecycleEvent(
        { timestamp: input.eventTimestamp, kind: input.kind, id: input.eventId },
        current,
      ) ||
      (current.state === "deleted" && input.kind === "user.updated")
    ) {
      return { state: current.state, applied: false, restored: false } as const;
    }
    const state = input.kind === "user.deleted" ? "deleted" : "active";
    yield* sql`
      update clerk_user_lifecycle_state
      set state = ${state}, event_timestamp = ${input.eventTimestamp},
          event_kind = ${input.kind}, event_id = ${input.eventId}, updated_at = now()
      where clerk_user_id = ${input.userId}
    `;
    return {
      state,
      applied: true,
      restored: current.state === "deleted" && input.kind === "user.created",
    } as const;
  });

const profileRank = (kind: "user.created" | "user.updated"): number =>
  kind === "user.updated" ? 2 : 1;

const processUserUpsert = (input: {
  readonly event: UserUpsertEvent;
  readonly eventId: string;
  readonly eventTimestamp: number;
}) =>
  Effect.gen(function* () {
    const { event } = input;
    const primary = event.data.email_addresses.find(
      (email) => email.id === event.data.primary_email_address_id,
    );
    if (primary === undefined || primary.verification?.status !== "verified") {
      return yield* Effect.fail(new Error("verified_primary_email_required"));
    }
    if (!Number.isSafeInteger(event.data.updated_at) || event.data.updated_at < 0) {
      return yield* Effect.fail(new Error("clerk_profile_version_invalid"));
    }
    const email = normalizedEmail(primary.email_address);
    const displayName =
      [event.data.first_name, event.data.last_name]
        .filter((value) => value !== null)
        .join(" ")
        .trim() || email;
    const sql = yield* PgClient.PgClient;
    const acceptedMembershipLaneKeys = yield* acceptedInvitationMembershipLanes(
      event.data.id,
      email,
    );
    yield* lockMembershipLanes(acceptedMembershipLaneKeys);
    const currentAcceptedMembershipLaneKeys = yield* acceptedInvitationMembershipLanes(
      event.data.id,
      email,
    );
    if (!sameMembershipLaneKeys(currentAcceptedMembershipLaneKeys, acceptedMembershipLaneKeys)) {
      return yield* Effect.fail(new Error("workspace_invitation_scope_changed"));
    }
    const lifecycle = yield* projectUserLifecycle({
      userId: event.data.id,
      eventId: input.eventId,
      eventTimestamp: input.eventTimestamp,
      kind: event.type,
    });
    if (lifecycle.state === "deleted") return;
    // User lifecycle projection also locks its per-user state row. Preserve
    // lifecycle-row -> platform-user ordering, but take every invitation lane
    // before either can lead to membership writes.
    yield* sql`
      select id
      from platform_users
      where id = ${event.data.id}
      for update
    `;
    const permanentlyDeleted = yield* sql<{ exists: boolean }>`
      select exists(
        select 1 from identity_deletion_tombstones where clerk_user_id = ${event.data.id}
      ) as exists
    `;
    if (permanentlyDeleted[0]?.exists === true) return;
    const profileEventWins = yield* sql<{ wins: boolean }>`
      select not exists(
        select 1 from platform_users
        where id = ${event.data.id}
          and clerk_profile_version is not null
          and (
            clerk_profile_version > ${event.data.updated_at}
            or (
              clerk_profile_version = ${event.data.updated_at}
              and (
                case clerk_profile_event_kind when 'user.updated' then 2 else 1 end
                  > ${profileRank(event.type)}
                or (
                  case clerk_profile_event_kind when 'user.updated' then 2 else 1 end
                    = ${profileRank(event.type)}
                  and clerk_profile_event_id >= ${input.eventId}
                )
              )
            )
          )
      ) as wins
    `;
    const updateProfile = profileEventWins[0]?.wins === true;
    yield* sql`
      insert into platform_users (
        id, primary_email, display_name, clerk_user_id, mfa_required,
        clerk_profile_version, clerk_profile_event_kind, clerk_profile_event_id
      ) values (
        ${event.data.id}, ${email}, ${displayName}, ${event.data.id},
        ${event.data.two_factor_enabled}, ${event.data.updated_at}, ${event.type}, ${input.eventId}
      )
      on conflict (id) do update set
        primary_email = case when ${updateProfile} then excluded.primary_email
          else platform_users.primary_email end,
        display_name = case when ${updateProfile} then excluded.display_name
          else platform_users.display_name end,
        clerk_user_id = case when ${updateProfile} then excluded.clerk_user_id
          else platform_users.clerk_user_id end,
        mfa_required = case when ${updateProfile} then excluded.mfa_required
          else platform_users.mfa_required end,
        clerk_profile_version = case when ${updateProfile} then excluded.clerk_profile_version
          else platform_users.clerk_profile_version end,
        clerk_profile_event_kind = case when ${updateProfile} then excluded.clerk_profile_event_kind
          else platform_users.clerk_profile_event_kind end,
        clerk_profile_event_id = case when ${updateProfile} then excluded.clerk_profile_event_id
          else platform_users.clerk_profile_event_id end,
        recovery_deleted_at = case
          when ${lifecycle.restored}
            and platform_users.clerk_recovery_deleted_at is not null
            and platform_users.recovery_deleted_at = platform_users.clerk_recovery_deleted_at
          then null else platform_users.recovery_deleted_at end,
        purge_after = case
          when ${lifecycle.restored}
            and platform_users.clerk_recovery_deleted_at is not null
            and platform_users.recovery_deleted_at = platform_users.clerk_recovery_deleted_at
          then null else platform_users.purge_after end,
        clerk_recovery_deleted_at = case when ${lifecycle.restored} then null
          else platform_users.clerk_recovery_deleted_at end,
        updated_at = case when ${updateProfile} or ${lifecycle.restored} then now()
          else platform_users.updated_at end
    `;
    const accepted = yield* sql<{ id: string }>`
      select id::text from workspace_invitations
      where accepted_user_id = ${event.data.id} and normalized_email = ${email}
        and state = 'accepted'
      order by created_at, id
    `;
    for (const invitation of accepted) {
      yield* linkAcceptedInvitation(invitation.id, acceptedMembershipLaneKeys);
    }
  });

const processUserDeletion = (input: {
  readonly userId: string;
  readonly eventId: string;
  readonly eventTimestamp: number;
}) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const lifecycle = yield* projectUserLifecycle({
      ...input,
      kind: "user.deleted",
    });
    if (!lifecycle.applied || lifecycle.state !== "deleted") return;
    const deletedAt = new Date(input.eventTimestamp * 1_000);
    yield* sql`
      update platform_users
      set clerk_recovery_deleted_at = case
            when recovery_deleted_at is null then ${deletedAt}
            else clerk_recovery_deleted_at
          end,
          recovery_deleted_at = coalesce(recovery_deleted_at, ${deletedAt}),
          purge_after = coalesce(
            purge_after,
            ${deletedAt}::timestamptz + interval '180 days'
          ),
          updated_at = now()
      where clerk_user_id = ${input.userId} and purged_at is null
    `;
  });

const processInvitationEvent = (event: InvitationEvent, eventTimestamp: number) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const loaded = yield* loadProviderInvitation(event);
    if (loaded === null) return;
    const { invitation, activeCompany, membershipLaneKey } = loaded;
    if (invitation.workspaceKind === "client" && invitation.clientCompanyId !== null) {
      yield* sql`
        select pg_advisory_xact_lock(
          hashtext(${`brief:client-members:${invitation.clientCompanyId}`})
        )
      `;
    }
    const expiresAt = providerExpiry(event);
    if (invitation.expiresAt !== null && invitation.expiresAt.getTime() !== expiresAt.getTime()) {
      return yield* Effect.fail(new Error("workspace_invitation_expiry_mismatch"));
    }
    if (!activeCompany) {
      if (invitation.state === "creating" || invitation.state === "pending") {
        yield* sql`
          update workspace_invitations
          set state = 'revoked', delivery_lease_token = null,
              delivery_lease_expires_at = null, updated_at = now()
          where id = ${invitation.id}
        `;
      }
      return;
    }
    if (event.type === "organizationInvitation.revoked") {
      if (invitation.state === "creating" || invitation.state === "pending") {
        yield* sql`
          update workspace_invitations
          set state = 'revoked', clerk_invitation_id = coalesce(clerk_invitation_id, ${event.data.id}),
              expires_at = coalesce(expires_at, ${expiresAt}), delivery_lease_token = null,
              delivery_lease_expires_at = null, updated_at = now()
          where id = ${invitation.id}
        `;
      }
      return;
    }
    const acceptedLate = eventTimestamp * 1_000 >= expiresAt.getTime();
    if (
      acceptedLate ||
      (event.type === "organizationInvitation.created" && expiresAt <= new Date())
    ) {
      if (invitation.state === "creating" || invitation.state === "pending") {
        yield* sql`
          update workspace_invitations
          set state = 'expired', clerk_invitation_id = coalesce(clerk_invitation_id, ${event.data.id}),
              expires_at = coalesce(expires_at, ${expiresAt}), delivery_lease_token = null,
              delivery_lease_expires_at = null, updated_at = now()
          where id = ${invitation.id}
        `;
      }
      return;
    }
    if (event.type === "organizationInvitation.created") {
      if (invitation.state === "creating") {
        yield* sql`
          update workspace_invitations
          set state = 'pending', clerk_invitation_id = ${event.data.id}, expires_at = ${expiresAt},
              delivery_lease_token = null, delivery_lease_expires_at = null,
              delivery_last_error_code = null, updated_at = now()
          where id = ${invitation.id} and state = 'creating'
        `;
      }
      return;
    }
    if (!("user_id" in event.data) || typeof event.data.user_id !== "string") {
      return yield* Effect.fail(new Error("workspace_invitation_acceptance_identity_missing"));
    }
    const acceptedUserId = event.data.user_id;
    if (invitation.state === "accepted") {
      if (invitation.acceptedUserId !== acceptedUserId) {
        return yield* Effect.fail(new Error("workspace_invitation_acceptance_conflict"));
      }
      yield* linkAcceptedInvitation(
        invitation.id,
        membershipLaneKey === null ? undefined : [membershipLaneKey],
      );
      return;
    }
    if (invitation.state !== "creating" && invitation.state !== "pending") return;
    const acceptedAt = new Date(eventTimestamp * 1_000);
    yield* sql`
      update workspace_invitations
      set state = 'accepted', clerk_invitation_id = coalesce(clerk_invitation_id, ${event.data.id}),
          expires_at = coalesce(expires_at, ${expiresAt}), accepted_user_id = ${acceptedUserId},
          accepted_at = ${acceptedAt}, delivery_lease_token = null,
          delivery_lease_expires_at = null, delivery_last_error_code = null, updated_at = now()
      where id = ${invitation.id} and state in ('creating', 'pending')
    `;
    yield* linkAcceptedInvitation(
      invitation.id,
      membershipLaneKey === null ? undefined : [membershipLaneKey],
    );
  });

const processEvent = (input: {
  readonly event: WebhookEvent;
  readonly eventId: string;
  readonly eventTimestamp: number;
}) =>
  Effect.gen(function* () {
    const { event } = input;
    if (event.type === "user.created" || event.type === "user.updated") {
      return yield* processUserUpsert({ ...input, event });
    }
    if (event.type === "user.deleted") {
      if (event.data.id !== undefined) {
        yield* processUserDeletion({
          userId: event.data.id,
          eventId: input.eventId,
          eventTimestamp: input.eventTimestamp,
        });
      }
      return;
    }
    if (
      event.type === "organizationInvitation.created" ||
      event.type === "organizationInvitation.revoked" ||
      event.type === "organizationInvitation.accepted"
    ) {
      yield* processInvitationEvent(event, input.eventTimestamp);
    }
  });

export const acceptClerkWebhook = (input: {
  readonly eventId: string;
  readonly eventTimestamp: number;
  readonly payloadHash: string;
  readonly event: WebhookEvent;
}) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`select pg_advisory_xact_lock(hashtext(${`brief:clerk-webhook:${input.eventId}`}))`;
        const extant = yield* sql<{ eventType: string; payloadHash: string }>`
          select event_type as "eventType", payload_sha256 as "payloadHash"
          from clerk_webhook_events where webhook_event_id = ${input.eventId}
        `;
        if (extant[0] !== undefined) {
          return extant[0].eventType === input.event.type &&
            extant[0].payloadHash === input.payloadHash
            ? ("duplicate" as const)
            : ("conflict" as const);
        }
        yield* processEvent(input);
        yield* sql`
          insert into clerk_webhook_events (webhook_event_id, event_type, payload_sha256)
          values (${input.eventId}, ${input.event.type}, ${input.payloadHash})
        `;
        return "processed" as const;
      }),
    );
  });
