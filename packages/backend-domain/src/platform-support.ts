import { PgClient } from "@effect/sql-pg";
import type {
  CreateRestrictedSupportGrantRequest,
  PlatformCompanyDeletionRequestDescriptor,
} from "@hartlib/shared";
import { publisherIssueAdvisoryLockKey } from "@hartlib/shared";
import { WorkspaceAuthorizationError, type WorkspaceIdentity } from "@hartlib/workspace/common";
import { Effect } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";

type SqlEffect<A = void> = Effect.Effect<A, unknown, PgClient.PgClient>;

/**
 * Consume a currently valid restricted-support grant before content access.
 *
 * This is deliberately a domain operation: the grant actor/scope/expiry
 * checks and immutable access-log insert must stay next to the support SQL,
 * rather than being reimplemented by an HTTP adapter.
 */
export const recordRestrictedSupportAccess = (
  identity: WorkspaceIdentity,
  input: { readonly grantId: string; readonly scopeKind: string; readonly scopeId: string },
): Effect.Effect<string, WorkspaceAuthorizationError | SqlError, PgClient.PgClient> =>
  Effect.gen(function* () {
    if (!identity.mfaVerified) {
      return yield* Effect.fail(new WorkspaceAuthorizationError("mfa_required"));
    }
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<{ readonly id: string }>`
      insert into restricted_support_access_log (
        grant_id, actor_user_id, reason, scope_kind, scope_id,
        publisher_company_id, client_company_id, affected_user_id,
        customer_approval_reference, approval_skipped_reason
      )
      select
        grant_row.id,
        grant_row.actor_user_id,
        grant_row.reason,
        grant_row.scope_kind,
        grant_row.scope_id,
        grant_row.publisher_company_id,
        grant_row.client_company_id,
        grant_row.affected_user_id,
        grant_row.customer_approval_reference,
        grant_row.approval_skipped_reason
      from restricted_support_grants grant_row
      where grant_row.id = ${input.grantId}
        and grant_row.actor_user_id = ${identity.userId}
        and grant_row.scope_kind = ${input.scopeKind}
        and grant_row.scope_id = ${input.scopeId}
        and grant_row.revoked_at is null
        and grant_row.expires_at > now()
      for share
      returning id::text
    `;
    const row = rows[0];
    if (row === undefined) {
      return yield* Effect.fail(new WorkspaceAuthorizationError("support_grant_required"));
    }
    return row.id;
  });

export interface CompanyDeletionDecisionRow {
  readonly id: string;
  readonly clientCompanyId: string;
  readonly clientCompanyName: string;
  readonly requestedByUserId: string;
  readonly reason: string;
  readonly status: "requested" | "approved" | "rejected" | "completed";
  readonly requestedAt: Date;
  readonly resolvedAt: Date | null;
  readonly purgeAfter: Date | null;
  readonly resolutionIdempotencyKey: string | null;
}

export const companyDeletionDescriptor = (
  row: CompanyDeletionDecisionRow,
): PlatformCompanyDeletionRequestDescriptor => ({
  id: row.id,
  clientCompanyId: row.clientCompanyId,
  clientCompanyName: row.clientCompanyName,
  requestedByUserId: row.requestedByUserId,
  reason: row.reason,
  status: row.status,
  requestedAt: row.requestedAt.toISOString(),
  resolvedAt: row.resolvedAt?.toISOString() ?? null,
  purgeAfter: row.purgeAfter?.toISOString() ?? null,
});

export const selectCompanyDeletionRequests = (requestId?: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql<CompanyDeletionDecisionRow>`
      select requests.id::text, requests.client_company_id::text as "clientCompanyId",
             companies.name as "clientCompanyName",
             requests.requested_by_user_id as "requestedByUserId", requests.reason,
             requests.status, requests.requested_at as "requestedAt",
             requests.resolved_at as "resolvedAt", companies.purge_after as "purgeAfter",
             requests.resolution_idempotency_key as "resolutionIdempotencyKey"
      from company_deletion_requests requests
      join client_companies companies on companies.id = requests.client_company_id
      where (${requestId ?? null}::uuid is null or requests.id = ${requestId ?? null})
      order by case when requests.status = 'requested' then 0 else 1 end,
               requests.requested_at, requests.id
      limit 200
    `;
  });

export const resolveCompanyDeletionRequest = (input: {
  readonly deletionRequestId: string;
  readonly decision: "approved" | "rejected";
  readonly idempotencyKey: string;
  readonly actorUserId: string;
  readonly auditSucceeded: (companyId: string) => SqlEffect;
}) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const rows = yield* sql<CompanyDeletionDecisionRow>`
          select requests.id::text, requests.client_company_id::text as "clientCompanyId",
                 companies.name as "clientCompanyName",
                 requests.requested_by_user_id as "requestedByUserId", requests.reason,
                 requests.status, requests.requested_at as "requestedAt",
                 requests.resolved_at as "resolvedAt", companies.purge_after as "purgeAfter",
                 requests.resolution_idempotency_key as "resolutionIdempotencyKey"
          from company_deletion_requests requests
          join client_companies companies on companies.id = requests.client_company_id
          where requests.id = ${input.deletionRequestId}
          for update of requests, companies
        `;
        const current = rows[0];
        if (current === undefined)
          return yield* Effect.fail(new Error("deletion_request_not_found"));
        if (current.status !== "requested") {
          if (
            current.status === input.decision &&
            current.resolutionIdempotencyKey === input.idempotencyKey
          ) {
            yield* input.auditSucceeded(current.clientCompanyId);
            return { row: current, duplicate: true } as const;
          }
          return yield* Effect.fail(new Error("deletion_request_already_resolved"));
        }
        const resolvedAt = new Date();
        if (input.decision === "approved") {
          if (current.purgeAfter !== null) {
            return yield* Effect.fail(new Error("company_deletion_already_scheduled"));
          }
          yield* sql`
            update client_companies
            set deletion_requested_at = coalesce(deletion_requested_at, ${current.requestedAt}),
                recovery_deleted_at = now(),
                purge_after = now() + interval '180 days',
                updated_at = now()
            where id = ${current.clientCompanyId} and recovery_deleted_at is null
          `;
          yield* sql`
            update company_deletion_requests
            set status = 'rejected', resolved_at = now(),
                resolved_by_user_id = ${input.actorUserId}
            where client_company_id = ${current.clientCompanyId}
              and id <> ${input.deletionRequestId} and status = 'requested'
          `;
        }
        const updated = yield* sql<CompanyDeletionDecisionRow>`
          update company_deletion_requests requests
          set status = ${input.decision}, resolved_at = ${resolvedAt},
              resolved_by_user_id = ${input.actorUserId},
              resolution_idempotency_key = ${input.idempotencyKey}
          from client_companies companies
          where requests.id = ${input.deletionRequestId}
            and companies.id = requests.client_company_id
          returning requests.id::text,
                    requests.client_company_id::text as "clientCompanyId",
                    companies.name as "clientCompanyName",
                    requests.requested_by_user_id as "requestedByUserId", requests.reason,
                    requests.status, requests.requested_at as "requestedAt",
                    requests.resolved_at as "resolvedAt", companies.purge_after as "purgeAfter",
                    requests.resolution_idempotency_key as "resolutionIdempotencyKey"
        `;
        yield* input.auditSucceeded(current.clientCompanyId);
        return { row: updated[0]!, duplicate: false } as const;
      }),
    );
  });

export const loadPlatformOperations = (role: "admin" | "support" | "security" | "legal") =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const overview = (yield* sql<{
      readonly publisherCompanies: number;
      readonly clientCompanies: number;
      readonly subscriptions: number;
      readonly currentAccesses: number;
      readonly issues: number;
      readonly notificationFailures: number;
      readonly aiRuns: number;
      readonly modelInputTokens: number;
      readonly modelOutputTokens: number;
      readonly webOperations: number;
      readonly creditsConsumed: number;
    }>`
      select
        (select count(*)::int from publisher_companies) as "publisherCompanies",
        (select count(*)::int from client_companies where recovery_deleted_at is null) as "clientCompanies",
        (select count(*)::int from publisher_subscriptions) as subscriptions,
        (select count(*)::int from client_subscription_accesses where state in ('active', 'ending', 'paused')) as "currentAccesses",
        (select count(*)::int from publisher_issues where deleted_at is null) as issues,
        (select count(*)::int from email_notification_deliveries where status = 'failed') as "notificationFailures",
        (select count(*)::int from ai_runs) as "aiRuns",
        (select coalesce(sum(input_tokens), 0)::float8 from ai_run_usage) as "modelInputTokens",
        (select coalesce(sum(output_tokens), 0)::float8 from ai_run_usage) as "modelOutputTokens",
        (select count(*)::int from ai_external_tool_usage) as "webOperations",
        (select coalesce(sum(credits), 0)::float8 from client_credit_usage) as "creditsConsumed"
    `)[0]!;
    const publishedIssues = yield* sql<{
      readonly issueId: string;
      readonly publisherCompanyId: string;
      readonly subscriptionId: string;
      readonly publishedAt: Date;
      readonly indexingStatus: string;
      readonly indexingErrorCode: string | null;
      readonly restrictedAt: Date | null;
      readonly restrictedReason: string | null;
    }>`
      select issues.id::text as "issueId",
             subscriptions.publisher_company_id::text as "publisherCompanyId",
             issues.subscription_id::text as "subscriptionId",
             issues.published_at as "publishedAt", issues.indexing_status as "indexingStatus",
             issues.indexing_error_code as "indexingErrorCode",
             issues.restricted_at as "restrictedAt",
             case when ${role} in ('admin', 'security', 'legal')
                  then issues.restricted_reason else null end as "restrictedReason"
      from publisher_issues issues
      join publisher_subscriptions subscriptions on subscriptions.id = issues.subscription_id
      where issues.status = 'published'
        and issues.deleted_at is null
      order by issues.published_at desc, issues.id
      limit 200
    `;
    return {
      overview,
      publishedIssues: publishedIssues.map((issue) => ({
        ...issue,
        publishedAt: issue.publishedAt.toISOString(),
        restrictedAt: issue.restrictedAt?.toISOString() ?? null,
      })),
    };
  });

export const listActiveSupportGrants = (actorUserId: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const grants = yield* sql<{
      readonly id: string;
      readonly reason: string;
      readonly scopeKind: string;
      readonly scopeId: string;
      readonly expiresAt: Date;
      readonly customerApprovalReference: string | null;
      readonly approvalSkippedReason: string | null;
    }>`
      select id::text, reason, scope_kind as "scopeKind", scope_id as "scopeId",
             expires_at as "expiresAt",
             customer_approval_reference as "customerApprovalReference",
             approval_skipped_reason as "approvalSkippedReason"
      from restricted_support_grants
      where actor_user_id = ${actorUserId} and revoked_at is null and expires_at > now()
      order by expires_at, id
    `;
    return grants.map((grant) => ({ ...grant, expiresAt: grant.expiresAt.toISOString() }));
  });

export const createRestrictedSupportGrant = (input: {
  readonly request: CreateRestrictedSupportGrantRequest;
  readonly approvalReference: string | null;
  readonly approvalSkippedReason: string | null;
  readonly grantedByUserId: string;
  readonly expiresAt: Date;
  readonly auditSucceeded: SqlEffect;
}) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const body = input.request;
        if (body.scopeKind === "client_chat") {
          const active = yield* sql<{ readonly exists: boolean }>`
            select exists (
              select 1
              from chats chat
              join client_companies company on company.id = chat.company_id
              where chat.id::text = ${body.scopeId}
                and chat.deleted_at is null
                and company.recovery_deleted_at is null
                and company.purged_at is null
            ) as exists
          `;
          if (active[0]?.exists !== true) {
            return yield* Effect.fail(new Error("invalid_support_scope"));
          }
        }
        const rows = yield* sql<{ readonly id: string }>`
          insert into restricted_support_grants (
            actor_user_id, reason, scope_kind, scope_id, publisher_company_id,
            client_company_id, affected_user_id, customer_approval_reference,
            approval_skipped_reason, granted_by_user_id, expires_at
          ) values (
            ${body.actorUserId}, ${body.reason.trim()}, ${body.scopeKind}, ${body.scopeId},
            ${body.publisherCompanyId}, ${body.clientCompanyId}, ${body.affectedUserId},
            ${input.approvalReference}, ${input.approvalSkippedReason},
            ${input.grantedByUserId}, ${input.expiresAt}
          )
          returning id::text
        `;
        yield* input.auditSucceeded;
        return rows[0]!.id;
      }),
    );
  });

export interface RestrictedSupportGrantScope {
  readonly scopeKind: string;
  readonly scopeId: string;
  readonly publisherCompanyId?: string | null;
  readonly clientCompanyId?: string | null;
  readonly affectedUserId?: string | null;
}

export const selectRestrictedSupportGrant = (grantId: string, actorUserId: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<RestrictedSupportGrantScope>`
      select scope_kind as "scopeKind", scope_id as "scopeId",
             publisher_company_id::text as "publisherCompanyId",
             client_company_id::text as "clientCompanyId",
             affected_user_id as "affectedUserId"
      from restricted_support_grants
      where id = ${grantId} and actor_user_id = ${actorUserId}
        and revoked_at is null and expires_at > now()
    `;
    return rows[0] ?? null;
  });

export interface RestrictedFileRow {
  readonly objectKey: string;
  readonly mediaType: string;
  readonly fileName: string;
}

export const loadRestrictedSupportContent = (grant: RestrictedSupportGrantScope) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    if (grant.scopeKind === "publisher_file") {
      const rows = yield* sql<RestrictedFileRow>`
        select object_key as "objectKey", media_type as "mediaType",
               original_file_name as "fileName"
        from hartlib_documents document
        join publisher_issues issue
          on issue.id = document.issue_id
         and issue.deleted_at is null
        join publisher_subscriptions subscription
          on subscription.id = issue.subscription_id
         and subscription.publisher_company_id = ${grant.publisherCompanyId ?? null}::uuid
        where document.id::text = ${grant.scopeId}
          and document.deleted_at is null
      `;
      return rows[0] ?? null;
    }
    if (grant.scopeKind === "publisher_text") {
      const rows = yield* sql<{
        readonly id: string;
        readonly language: string;
        readonly canonicalText: string;
        readonly pageRanges: unknown;
      }>`
        select versions.id::text, versions.language,
               versions.canonical_text as "canonicalText", versions.page_ranges as "pageRanges"
        from hartlib_document_versions versions
        join hartlib_documents document
          on document.id = versions.hartlib_document_id
         and document.deleted_at is null
        join publisher_issues issue
          on issue.id = document.issue_id
         and issue.deleted_at is null
        join publisher_subscriptions subscription
          on subscription.id = issue.subscription_id
         and subscription.publisher_company_id = ${grant.publisherCompanyId ?? null}::uuid
        where versions.id::text = ${grant.scopeId}
      `;
      return rows[0] ?? null;
    }
    if (grant.scopeKind === "client_chat") {
      const active = yield* sql<{ readonly exists: boolean }>`
          select exists (
            select 1
            from chats chat
            join client_companies company on company.id = chat.company_id
            join platform_users owner
              on owner.id = chat.user_id
             and owner.recovery_deleted_at is null
             and owner.purged_at is null
            where chat.id::text = ${grant.scopeId}
              and chat.deleted_at is null
              and company.recovery_deleted_at is null
              and company.purged_at is null
              and chat.user_id = ${grant.affectedUserId ?? null}
        ) as exists
      `;
      if (active[0]?.exists !== true) return null;
      const messages = yield* sql<{
        readonly id: string;
        readonly author: string;
        readonly content: string;
        readonly createdAt: Date;
      }>`
        select id::text, author, content, created_at as "createdAt"
        from chat_messages where chat_id::text = ${grant.scopeId}
        order by created_at, id
      `;
      return {
        id: grant.scopeId,
        messages: messages.map((message) => ({
          ...message,
          createdAt: message.createdAt.toISOString(),
        })),
      };
    }
    const rows = yield* sql<{
      readonly id: string;
      readonly userId: string;
      readonly kind: string | null;
      readonly content: string | null;
      readonly deletedAt: Date | null;
      readonly revisions: unknown;
    }>`
      select memories.id::text, memories.user_id as "userId", memories.kind,
             memories.content, memories.deleted_at as "deletedAt",
             coalesce(jsonb_agg(jsonb_build_object(
               'id', revisions.id::text, 'action', revisions.action,
               'stateBefore', revisions.state_before, 'stateAfter', revisions.state_after,
               'createdAt', revisions.created_at
             ) order by revisions.created_at, revisions.id)
             filter (where revisions.id is not null), '[]'::jsonb) as revisions
      from user_memories memories
      left join user_memory_revisions revisions on revisions.memory_id = memories.id
      join client_company_memberships membership
        on membership.user_id = memories.user_id
       and membership.company_id = ${grant.clientCompanyId ?? null}::uuid
       and membership.revoked_at is null
      join client_companies company
        on company.id = membership.company_id
       and company.recovery_deleted_at is null
       and company.purged_at is null
      join platform_users owner
        on owner.id = memories.user_id
       and owner.recovery_deleted_at is null
       and owner.purged_at is null
      where memories.id::text = ${grant.scopeId}
        and memories.user_id = ${grant.affectedUserId ?? null}
      group by memories.id
    `;
    return rows[0] ?? null;
  });

export const createRestrictedSupportReview = (input: {
  readonly accessLogId: string;
  readonly reviewerUserId: string;
  readonly decision: "approved" | "flagged";
  readonly notes: string;
  readonly auditSucceeded: SqlEffect;
}) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const rows = yield* sql<{ readonly id: string }>`
          insert into restricted_support_access_reviews (
            access_log_id, reviewer_user_id, decision, notes
          ) values (
            ${input.accessLogId}, ${input.reviewerUserId}, ${input.decision}, ${input.notes.trim()}
          )
          on conflict (access_log_id, reviewer_user_id) do nothing
          returning id::text
        `;
        if (rows[0] === undefined) return null;
        yield* input.auditSucceeded;
        return rows[0].id;
      }),
    );
  });

export const listRestrictedSupportAccess = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  const rows = yield* sql<{
    readonly id: string;
    readonly actorUserId: string;
    readonly scopeKind: string;
    readonly scopeId: string;
    readonly accessedAt: Date;
    readonly reviewDecision: string | null;
  }>`
    select access.id::text, access.actor_user_id as "actorUserId",
           access.scope_kind as "scopeKind", access.scope_id as "scopeId",
           access.accessed_at as "accessedAt", reviews.decision as "reviewDecision"
    from restricted_support_access_log access
    left join lateral (
      select decision from restricted_support_access_reviews
      where access_log_id = access.id order by reviewed_at desc limit 1
    ) reviews on true
    order by access.accessed_at desc, access.id desc
    limit 200
  `;
  return rows.map((row) => ({ ...row, accessedAt: row.accessedAt.toISOString() }));
});

export const changeIssueRestriction = (input: {
  readonly issueId: string;
  readonly actorUserId: string;
  readonly reason: string | null;
  readonly restrict: boolean;
  readonly auditSucceeded: SqlEffect;
}) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        // This is the same lane held by AI finalization while it rechecks
        // publisher-source authorization and writes its terminal answer.
        // Holding it through the update, audit, and commit gives restriction
        // changes a single linearization point with finalization.
        yield* sql`
          select pg_advisory_xact_lock(
            hashtextextended(${publisherIssueAdvisoryLockKey(input.issueId)}, 0)
          )
        `;
        const rows = input.restrict
          ? yield* sql<{ readonly id: string }>`
              update publisher_issues
              set restricted_at = now(), restricted_by_user_id = ${input.actorUserId},
                  restricted_reason = ${input.reason}, updated_at = now()
              where id = ${input.issueId} and status = 'published' and restricted_at is null
              returning id::text
            `
          : yield* sql<{ readonly id: string }>`
              update publisher_issues
              set restricted_at = null, restricted_by_user_id = null,
                  restricted_reason = null, updated_at = now()
              where id = ${input.issueId} and restricted_at is not null
              returning id::text
            `;
        if (rows.length !== 1) return false;
        yield* input.auditSucceeded;
        return true;
      }),
    );
  });
