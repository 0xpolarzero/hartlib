import { PgClient } from "@effect/sql-pg";
import { Effect } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";

export interface WorkspaceIdentity {
  readonly userId: string;
  readonly organizationId: string | null;
  readonly sessionId: string;
  readonly mfaVerified: boolean;
  readonly mode: "demo" | "clerk";
}

export type WorkspaceAuthorizationErrorCode =
  | "not_authenticated"
  | "mfa_required"
  | "forbidden"
  | "not_found"
  | "support_grant_required";

export class WorkspaceAuthorizationError extends Error {
  readonly name = "WorkspaceAuthorizationError";

  constructor(readonly code: WorkspaceAuthorizationErrorCode) {
    super(code);
  }
}

export class WorkspaceRuleError extends Error {
  readonly name = "WorkspaceRuleError";

  constructor(readonly code: string) {
    super(code);
  }
}

const requestIdUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Resolve the bounded request correlation ID used by authorization audits. */
export const requestIdForAudit = (request: Request): string | null => {
  const supplied = request.headers.get("x-request-id");
  if (supplied === null) return crypto.randomUUID();
  return requestIdUuidPattern.test(supplied) ? supplied : null;
};

type ExistsRow = { readonly exists: boolean };

export type WorkspacePlatformAdminRole = "admin" | "support" | "security" | "legal";

const requireMfa = (
  identity: WorkspaceIdentity,
): Effect.Effect<void, WorkspaceAuthorizationError> =>
  identity.mfaVerified ? Effect.void : Effect.fail(new WorkspaceAuthorizationError("mfa_required"));

export const requirePlatformAdminRole = (
  identity: WorkspaceIdentity,
  allowedRoles: ReadonlySet<WorkspacePlatformAdminRole>,
): Effect.Effect<
  WorkspacePlatformAdminRole,
  WorkspaceAuthorizationError | SqlError,
  PgClient.PgClient
> =>
  Effect.gen(function* () {
    yield* requireMfa(identity);
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<{ readonly role: WorkspacePlatformAdminRole }>`
      select admins.role
      from platform_admins admins
      join platform_users users
        on users.id = admins.user_id
       and users.recovery_deleted_at is null
       and users.purged_at is null
      where admins.user_id = ${identity.userId}
      limit 1
    `;
    const role = rows[0]?.role;
    if (role === undefined || !allowedRoles.has(role)) {
      return yield* Effect.fail(new WorkspaceAuthorizationError("forbidden"));
    }
    return role;
  });

export const requireClientCompanyMembership = (
  identity: WorkspaceIdentity,
  companyId: string,
): Effect.Effect<void, WorkspaceAuthorizationError | SqlError, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<ExistsRow>`
      select exists (
        select 1
        from client_company_memberships membership
        join client_companies company on company.id = membership.company_id
        join platform_users users
          on users.id = membership.user_id
         and users.recovery_deleted_at is null
         and users.purged_at is null
        where membership.company_id = ${companyId}
          and membership.user_id = ${identity.userId}
          and membership.revoked_at is null
          and company.recovery_deleted_at is null
          and company.purged_at is null
          and (
            ${identity.organizationId}::text is null
            or company.clerk_organization_id = ${identity.organizationId}
          )
      ) as exists
    `;
    if (rows[0]?.exists !== true) {
      return yield* Effect.fail(new WorkspaceAuthorizationError("forbidden"));
    }
  });

export const requireClientCompanyAdmin = (
  identity: WorkspaceIdentity,
  companyId: string,
): Effect.Effect<void, WorkspaceAuthorizationError | SqlError, PgClient.PgClient> =>
  Effect.gen(function* () {
    yield* requireMfa(identity);
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<ExistsRow>`
      select exists (
        select 1
        from client_company_memberships membership
        join client_companies company on company.id = membership.company_id
        join platform_users users
          on users.id = membership.user_id
         and users.recovery_deleted_at is null
         and users.purged_at is null
        where membership.company_id = ${companyId}
          and membership.user_id = ${identity.userId}
          and membership.role = 'admin'
          and membership.revoked_at is null
          and company.recovery_deleted_at is null
          and company.purged_at is null
          and (
            ${identity.organizationId}::text is null
            or company.clerk_organization_id = ${identity.organizationId}
          )
      ) as exists
    `;
    if (rows[0]?.exists !== true) {
      return yield* Effect.fail(new WorkspaceAuthorizationError("forbidden"));
    }
  });

export const requirePublisherCompanyMembership = (
  identity: WorkspaceIdentity,
  companyId: string,
): Effect.Effect<void, WorkspaceAuthorizationError | SqlError, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<ExistsRow>`
      select exists (
        select 1 from publisher_company_memberships membership
        join publisher_companies company on company.id = membership.publisher_company_id
        join platform_users users
          on users.id = membership.user_id
         and users.recovery_deleted_at is null
         and users.purged_at is null
        where membership.publisher_company_id = ${companyId}
          and membership.user_id = ${identity.userId}
          and membership.accepted_at is not null
          and (
            ${identity.organizationId}::text is null
            or company.clerk_organization_id = ${identity.organizationId}
          )
      ) as exists
    `;
    if (rows[0]?.exists !== true) {
      return yield* Effect.fail(new WorkspaceAuthorizationError("forbidden"));
    }
  });

export const requirePublisherCompanyAdmin = (
  identity: WorkspaceIdentity,
  companyId: string,
): Effect.Effect<void, WorkspaceAuthorizationError | SqlError, PgClient.PgClient> =>
  Effect.gen(function* () {
    yield* requireMfa(identity);
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<ExistsRow>`
      select exists (
        select 1 from publisher_company_memberships membership
        join publisher_companies company on company.id = membership.publisher_company_id
        join platform_users users
          on users.id = membership.user_id
         and users.recovery_deleted_at is null
         and users.purged_at is null
        where membership.publisher_company_id = ${companyId}
          and membership.user_id = ${identity.userId}
          and membership.role = 'admin'
          and membership.accepted_at is not null
          and (
            ${identity.organizationId}::text is null
            or company.clerk_organization_id = ${identity.organizationId}
          )
      ) as exists
    `;
    if (rows[0]?.exists !== true) {
      return yield* Effect.fail(new WorkspaceAuthorizationError("forbidden"));
    }
  });

export const requirePublisherSubscriptionAccess = (
  identity: WorkspaceIdentity,
  subscriptionId: string,
  operation: "read" | "content_manage" | "client_read" | "client_manage" | "analytics",
): Effect.Effect<void, WorkspaceAuthorizationError | SqlError, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<{ readonly role: "admin" | "manager" | "member" }>`
      select membership.role
      from publisher_subscriptions subscription
      join publisher_companies company
        on company.id = subscription.publisher_company_id
      join publisher_company_memberships membership
        on membership.publisher_company_id = subscription.publisher_company_id
       and membership.user_id = ${identity.userId}
      join platform_users users
        on users.id = membership.user_id
       and users.recovery_deleted_at is null
       and users.purged_at is null
      where subscription.id = ${subscriptionId}
        and (
          ${identity.organizationId}::text is null
          or company.clerk_organization_id = ${identity.organizationId}
        )
        and membership.accepted_at is not null
        and (
          membership.role = 'admin'
          or exists (
            select 1
            from publisher_membership_subscription_grants grant_row
            where grant_row.publisher_company_id = membership.publisher_company_id
              and grant_row.user_id = membership.user_id
              and grant_row.subscription_id = subscription.id
          )
        )
      limit 1
    `;
    const membership = rows[0];
    if (membership === undefined) {
      return yield* Effect.fail(new WorkspaceAuthorizationError("forbidden"));
    }
    if (
      (operation === "client_read" || operation === "client_manage" || operation === "analytics") &&
      membership.role === "member"
    ) {
      return yield* Effect.fail(new WorkspaceAuthorizationError("forbidden"));
    }
    if (
      membership.role === "admin" &&
      (operation === "content_manage" || operation === "client_manage")
    ) {
      yield* requireMfa(identity);
    }
  });

/**
 * Authorize a product-chat operation against the current workspace snapshot.
 *
 * Chat access is kept in the workspace package so HTTP adapters cannot grow a
 * second, subtly different SQL/RBAC implementation.  A caller must hold the
 * returned Effect through the same database layer as its chat operation.
 */
export const requireChatAccess = (
  identity: WorkspaceIdentity,
  chatId: string,
  operation: "read" | "write" | "share" | "delete",
): Effect.Effect<void, WorkspaceAuthorizationError | SqlError, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<ExistsRow>`
      select exists (
        select 1
        from chats chat
        join client_companies company on company.id = chat.company_id
        where chat.id = ${chatId}
          and chat.deleted_at is null
          and company.recovery_deleted_at is null
          and company.purged_at is null
          and (
            ${identity.organizationId}::text is null
            or company.clerk_organization_id = ${identity.organizationId}
          )
          and exists (
            select 1 from platform_users users
            where users.id = ${identity.userId}
              and users.recovery_deleted_at is null
              and users.purged_at is null
          )
          and exists (
            select 1
            from client_company_memberships membership
            where membership.company_id = chat.company_id
              and membership.user_id = ${identity.userId}
              and membership.revoked_at is null
          )
          and not exists (
            select 1
            from chat_subscription_sources selected
            where selected.chat_id = chat.id
              and not exists (
                select 1
                from client_employee_subscription_grants employee_grant
                join client_subscription_accesses access_row
                  on access_row.id = employee_grant.access_id
                where employee_grant.access_id = selected.access_id
                  and employee_grant.user_id = ${identity.userId}
                  and employee_grant.client_company_id = chat.company_id
                  and employee_grant.revoked_at is null
                  and access_row.state in ('active', 'ending', 'paused')
              )
          )
          and (
            chat.user_id = ${identity.userId}
            or (
              ${operation} = 'read'
              and chat.shared_at is not null
              and chat.memory_mode = 'disabled'
            )
          )
      ) as exists
    `;
    if (rows[0]?.exists !== true) {
      return yield* Effect.fail(new WorkspaceAuthorizationError("forbidden"));
    }
  });

export const requireIssueReadAccess = (
  identity: WorkspaceIdentity,
  issueId: string,
): Effect.Effect<void, WorkspaceAuthorizationError | SqlError, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<ExistsRow>`
      select exists (
        select 1
        from publisher_issues issue
        where issue.id = ${issueId}
          and issue.restricted_at is null and issue.deleted_at is null
          and exists (
            select 1 from platform_users users
            where users.id = ${identity.userId}
              and users.recovery_deleted_at is null and users.purged_at is null
          )
          and (
            exists (
              select 1
              from publisher_subscriptions subscription
              join publisher_company_memberships membership
                on membership.publisher_company_id = subscription.publisher_company_id
               and membership.user_id = ${identity.userId}
              join publisher_companies publisher_company
                on publisher_company.id = subscription.publisher_company_id
              where subscription.id = issue.subscription_id
                and membership.accepted_at is not null
                and (
                  ${identity.organizationId}::text is null
                  or publisher_company.clerk_organization_id = ${identity.organizationId}
                )
                and (
                  membership.role = 'admin'
                  or exists (
                    select 1
                    from publisher_membership_subscription_grants grant_row
                    where grant_row.publisher_company_id = membership.publisher_company_id
                      and grant_row.user_id = membership.user_id
                      and grant_row.subscription_id = subscription.id
                  )
                )
            )
            or exists (
              select 1
              from issue_deliveries delivery
              join client_companies company on company.id = delivery.client_company_id
              join client_company_memberships client_membership
                on client_membership.company_id = delivery.client_company_id
               and client_membership.user_id = ${identity.userId}
               and client_membership.revoked_at is null
              join client_subscription_accesses access_row
                on access_row.id = delivery.access_id
               and access_row.client_company_id = delivery.client_company_id
               and access_row.state in ('active', 'ending', 'paused')
              join client_employee_subscription_grants employee_grant
                on employee_grant.access_id = delivery.access_id
               and employee_grant.client_company_id = delivery.client_company_id
              where delivery.issue_id = issue.id
                and employee_grant.user_id = ${identity.userId}
                and employee_grant.revoked_at is null
                and company.recovery_deleted_at is null
                and company.purged_at is null
                and (
                  ${identity.organizationId}::text is null
                  or company.clerk_organization_id = ${identity.organizationId}
                )
            )
          )
      ) as exists
    `;
    if (rows[0]?.exists !== true) {
      return yield* Effect.fail(new WorkspaceAuthorizationError("forbidden"));
    }
  });

export const boundedAuthorizationReasonCode = (
  error: unknown,
  fallback = "authorization_denied",
): string => {
  const candidate =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : error instanceof Error
        ? error.message
        : fallback;
  return /^[a-z][a-z0-9_]{1,127}$/u.test(candidate) ? candidate : fallback;
};

export const appendAuthorizationAudit = (input: {
  readonly identity: WorkspaceIdentity;
  readonly requestId: string;
  readonly action: string;
  readonly scopeKind: string;
  readonly scopeId: string;
  readonly outcome: "succeeded" | "denied";
  readonly reasonCode?: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    yield* sql`
      insert into platform_authorization_audit_log (
        actor_user_id, session_id, request_id, action, scope_kind, scope_id,
        outcome, reason_code
      ) values (
        ${input.identity.userId}, ${input.identity.sessionId}, ${input.requestId},
        ${input.action}, ${input.scopeKind}, ${input.scopeId}, ${input.outcome},
        ${input.reasonCode ?? null}
      )
      on conflict (request_id, action, scope_kind, scope_id) do nothing
    `;
  });

export const appendDeniedAuthorizationAudit = (input: {
  readonly identity: WorkspaceIdentity;
  readonly requestId: string;
  readonly action: string;
  readonly scopeKind: string;
  readonly scopeId: string;
  readonly error: unknown;
}) =>
  appendAuthorizationAudit({
    identity: input.identity,
    requestId: input.requestId,
    action: input.action,
    scopeKind: input.scopeKind,
    scopeId: input.scopeId,
    outcome: "denied",
    reasonCode: boundedAuthorizationReasonCode(input.error),
  });

export const auditDeniedThenFail = <E>(
  identity: WorkspaceIdentity,
  requestId: string,
  action: string,
  scopeKind: string,
  scopeId: string,
  error: E,
) =>
  appendDeniedAuthorizationAudit({
    identity,
    requestId,
    action,
    scopeKind,
    scopeId,
    error,
  }).pipe(Effect.andThen(Effect.fail(error)));
