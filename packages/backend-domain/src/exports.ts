import { PgClient } from "@effect/sql-pg";
import type { CreateExportRequest, ExportRequestDescriptor, ExportScopeKind } from "@brief/shared";
import { Effect } from "effect";

type SqlEffect<A = void> = Effect.Effect<A, unknown, PgClient.PgClient>;

interface ExportAuthorizationSnapshot {
  readonly version: 1;
  readonly authorizedAt: string;
  readonly requesterUserId: string;
  readonly scopeKind: ExportScopeKind;
  readonly scopeId: string;
  readonly role: string;
  readonly clientCompanyIds: readonly string[];
  readonly accessIds: readonly string[];
  readonly issueIds: readonly string[];
  readonly documentIds: readonly string[];
  readonly chatIds: readonly string[];
  readonly chatMessageIds: readonly string[];
}

export interface ExportRow {
  readonly id: string;
  readonly requesterUserId: string;
  readonly scopeKind: ExportScopeKind;
  readonly scopeId: string;
  readonly status: "queued" | "running" | "completed" | "failed";
  readonly objectKey: string | null;
  readonly expiresAt: Date | null;
  readonly errorCode: string | null;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
  readonly downloadAvailable: boolean;
}

export const exportDescriptor = (row: ExportRow): ExportRequestDescriptor => ({
  id: row.id,
  scopeKind: row.scopeKind,
  scopeId: row.scopeId,
  status: row.status,
  createdAt: row.createdAt.toISOString(),
  completedAt: row.completedAt?.toISOString() ?? null,
  expiresAt: row.expiresAt?.toISOString() ?? null,
  errorCode: row.errorCode,
  downloadPath: row.downloadAvailable ? `/v1/exports/${row.id}/download` : null,
});

const idRows = (rows: readonly { readonly id: string }[]) => rows.map((row) => row.id);

const authorizeExport = (input: {
  readonly requesterUserId: string;
  readonly mfaVerified: boolean;
  readonly organizationId: string | null;
  readonly scopeKind: ExportScopeKind;
  readonly scopeId: string;
  readonly lockedClientCompanyIds: readonly string[];
}) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const authorizedAt = new Date();
    if (input.scopeKind === "user_chats") {
      if (input.scopeId !== "me") return yield* Effect.fail(new Error("export_forbidden"));
      if (input.lockedClientCompanyIds.length === 0) {
        return yield* Effect.fail(new Error("export_subscription_required"));
      }
      const grants = yield* sql<{ readonly accessId: string; readonly clientCompanyId: string }>`
        select grants.access_id::text as "accessId",
               grants.client_company_id::text as "clientCompanyId"
        from client_employee_subscription_grants grants
        join client_company_memberships membership
          on membership.company_id = grants.client_company_id
         and membership.user_id = grants.user_id
         and membership.revoked_at is null
        join client_companies company
          on company.id = grants.client_company_id
         and company.recovery_deleted_at is null
         and (
           ${input.organizationId}::text is null
           or company.clerk_organization_id = ${input.organizationId}
         )
        join client_subscription_accesses accesses
          on accesses.id = grants.access_id
         and accesses.client_company_id = grants.client_company_id
        where grants.user_id = ${input.requesterUserId}
          and grants.revoked_at is null
          and accesses.state in ('active', 'ending', 'paused')
          and ${sql.in("grants.client_company_id", input.lockedClientCompanyIds)}
        order by grants.access_id
      `;
      if (grants.length === 0) return yield* Effect.fail(new Error("export_subscription_required"));
      const grantBackedClientCompanyIds = [
        ...new Set(grants.map((row) => row.clientCompanyId)),
      ].sort();
      const chats = yield* sql<{ readonly id: string }>`
        select chats.id::text
        from chats
        join client_companies chat_company on chat_company.id = chats.company_id
        join client_company_memberships membership
          on membership.company_id = chats.company_id
         and membership.user_id = chats.user_id
         and membership.revoked_at is null
        where chats.user_id = ${input.requesterUserId}
          and chats.deleted_at is null
          and chat_company.recovery_deleted_at is null
          and (
            ${input.organizationId}::text is null
            or chat_company.clerk_organization_id = ${input.organizationId}
          )
          and ${sql.in("chats.company_id", grantBackedClientCompanyIds)}
          and not exists (
            select 1
            from chat_subscription_sources source
            where source.chat_id = chats.id
              and not exists (
                select 1
                from client_employee_subscription_grants grant_row
                join client_subscription_accesses access
                  on access.id = grant_row.access_id
                 and access.client_company_id = grant_row.client_company_id
                where grant_row.access_id = source.access_id
                  and grant_row.client_company_id = source.client_company_id
                  and grant_row.user_id = chats.user_id
                  and grant_row.revoked_at is null
                  and access.state in ('active', 'ending', 'paused')
              )
          )
        order by chats.id::text
      `;
      const chatIds = idRows(chats);
      const chatMessages =
        chatIds.length === 0
          ? []
          : yield* sql<{ readonly id: string }>`
              select messages.id::text
              from chat_messages messages
              where ${sql.in("messages.chat_id", chatIds)}
              order by messages.chat_id::text, messages.created_at, messages.id::text
            `;
      return {
        version: 1,
        authorizedAt: authorizedAt.toISOString(),
        requesterUserId: input.requesterUserId,
        scopeKind: input.scopeKind,
        scopeId: input.scopeId,
        role: "self",
        clientCompanyIds: grantBackedClientCompanyIds,
        accessIds: grants.map((row) => row.accessId),
        issueIds: [],
        documentIds: [],
        chatIds,
        chatMessageIds: idRows(chatMessages),
      } satisfies ExportAuthorizationSnapshot;
    }

    if (input.scopeKind === "publisher_company") {
      const membership = yield* sql<{ readonly role: string }>`
      select role from publisher_company_memberships
        join publisher_companies company
          on company.id = publisher_company_memberships.publisher_company_id
        where publisher_company_id = ${input.scopeId} and user_id = ${input.requesterUserId}
          and accepted_at is not null
          and (
            ${input.organizationId}::text is null
            or company.clerk_organization_id = ${input.organizationId}
          )
      `;
      if (membership[0] === undefined) return yield* Effect.fail(new Error("export_forbidden"));
      if (membership[0].role === "admin" && !input.mfaVerified) {
        return yield* Effect.fail(new Error("mfa_required"));
      }
      const issues = yield* sql<{ readonly id: string }>`
        select issues.id::text
        from publisher_issues issues
        join publisher_subscriptions subscriptions on subscriptions.id = issues.subscription_id
        where subscriptions.publisher_company_id = ${input.scopeId}
          and issues.created_at <= ${authorizedAt}
          and issues.deleted_at is null
          and issues.restricted_at is null
          and (
            ${membership[0].role} = 'admin'
            or exists (
              select 1
              from publisher_membership_subscription_grants grant_row
              where grant_row.publisher_company_id = subscriptions.publisher_company_id
                and grant_row.user_id = ${input.requesterUserId}
                and grant_row.subscription_id = subscriptions.id
            )
          )
        order by issues.id::text
      `;
      const documents = yield* sql<{ readonly id: string }>`
        select documents.id::text
        from brief_documents documents
        join publisher_issues issues on issues.id = documents.issue_id
        join publisher_subscriptions subscriptions on subscriptions.id = issues.subscription_id
        where subscriptions.publisher_company_id = ${input.scopeId}
          and documents.created_at <= ${authorizedAt}
          and documents.deleted_at is null
          and issues.deleted_at is null
          and issues.restricted_at is null
          and (
            ${membership[0].role} = 'admin'
            or exists (
              select 1
              from publisher_membership_subscription_grants grant_row
              where grant_row.publisher_company_id = subscriptions.publisher_company_id
                and grant_row.user_id = ${input.requesterUserId}
                and grant_row.subscription_id = subscriptions.id
            )
          )
        order by documents.id::text
      `;
      return {
        version: 1,
        authorizedAt: authorizedAt.toISOString(),
        requesterUserId: input.requesterUserId,
        scopeKind: input.scopeKind,
        scopeId: input.scopeId,
        role: membership[0].role,
        clientCompanyIds: [],
        accessIds: [],
        issueIds: idRows(issues),
        documentIds: idRows(documents),
        chatIds: [],
        chatMessageIds: [],
      } satisfies ExportAuthorizationSnapshot;
    }

    const membership = yield* sql<{ readonly role: string }>`
      select membership.role
      from client_company_memberships membership
      join client_companies company on company.id = membership.company_id
      join platform_users users
        on users.id = membership.user_id
       and users.recovery_deleted_at is null and users.purged_at is null
      where membership.company_id = ${input.scopeId}
        and membership.user_id = ${input.requesterUserId}
        and membership.revoked_at is null
        and company.recovery_deleted_at is null
        and (
          ${input.organizationId}::text is null
          or company.clerk_organization_id = ${input.organizationId}
        )
    `;
    if (membership[0]?.role !== "admin") return yield* Effect.fail(new Error("export_forbidden"));
    if (!input.mfaVerified) return yield* Effect.fail(new Error("mfa_required"));
    const accesses = yield* sql<{ readonly id: string }>`
      select id::text from client_subscription_accesses
      where client_company_id = ${input.scopeId} and state in ('active', 'ending', 'paused')
      order by id::text
    `;
    const issues = yield* sql<{ readonly id: string }>`
      select distinct delivery.issue_id::text as id
      from issue_deliveries delivery
      join publisher_issues issue on issue.id = delivery.issue_id
      where delivery.client_company_id = ${input.scopeId}
        and delivery.delivered_at <= ${authorizedAt}
        and issue.deleted_at is null
        and issue.restricted_at is null
      order by delivery.issue_id::text
    `;
    const documents = yield* sql<{ readonly id: string }>`
      select distinct documents.id::text
      from issue_deliveries deliveries
      join brief_documents documents on documents.issue_id = deliveries.issue_id
      join publisher_issues issues on issues.id = deliveries.issue_id
      where deliveries.client_company_id = ${input.scopeId}
        and deliveries.delivered_at <= ${authorizedAt}
        and documents.deleted_at is null
        and issues.restricted_at is null
        and issues.deleted_at is null
      order by documents.id::text
    `;
    const chats = yield* sql<{ readonly id: string }>`
      select id::text from chats
      where company_id = ${input.scopeId}
        and shared_at is not null
        and deleted_at is null
        and created_at <= ${authorizedAt}
      order by id::text
    `;
    const chatIds = idRows(chats);
    const chatMessages =
      chatIds.length === 0
        ? []
        : yield* sql<{ readonly id: string }>`
            select messages.id::text
            from chat_messages messages
            where ${sql.in("messages.chat_id", chatIds)}
            order by messages.chat_id::text, messages.created_at, messages.id::text
          `;
    return {
      version: 1,
      authorizedAt: authorizedAt.toISOString(),
      requesterUserId: input.requesterUserId,
      scopeKind: input.scopeKind,
      scopeId: input.scopeId,
      role: membership[0].role,
      clientCompanyIds: [input.scopeId],
      accessIds: idRows(accesses),
      issueIds: idRows(issues),
      documentIds: idRows(documents),
      chatIds,
      chatMessageIds: idRows(chatMessages),
    } satisfies ExportAuthorizationSnapshot;
  });

const lockExportAuthorizationScope = (input: {
  readonly requesterUserId: string;
  readonly organizationId: string | null;
  readonly scopeKind: ExportScopeKind;
  readonly scopeId: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const lockLiveRequester = Effect.gen(function* () {
      const users = yield* sql<{ readonly live: boolean }>`
        select recovery_deleted_at is null and purged_at is null as live
        from platform_users
        where id = ${input.requesterUserId}
        for share
      `;
      if (users[0]?.live !== true) return yield* Effect.fail(new Error("export_forbidden"));
    });
    if (input.scopeKind === "publisher_company") {
      yield* sql`
        select pg_advisory_xact_lock(
          hashtext(${`brief:publisher-members:${input.scopeId}`})
        )
      `;
      yield* lockLiveRequester;
      const companies = yield* sql<{ readonly id: string }>`
        select id::text
        from publisher_companies
        where id = ${input.scopeId}
          and (
            ${input.organizationId}::text is null
            or clerk_organization_id = ${input.organizationId}
          )
        for key share
      `;
      if (companies[0] === undefined) return yield* Effect.fail(new Error("export_forbidden"));
      return [] as readonly string[];
    }
    if (input.scopeKind === "client_company") {
      yield* sql`
        select pg_advisory_xact_lock(hashtext(${`brief:client-members:${input.scopeId}`}))
      `;
      yield* lockLiveRequester;
      const companies = yield* sql<{ readonly id: string }>`
      select id::text
      from client_companies
      where id = ${input.scopeId} and recovery_deleted_at is null and purged_at is null
        and (
          ${input.organizationId}::text is null
          or clerk_organization_id = ${input.organizationId}
        )
        for key share
      `;
      if (companies[0] === undefined) return yield* Effect.fail(new Error("export_forbidden"));
      return [input.scopeId] as readonly string[];
    }
    if (input.scopeId !== "me") return yield* Effect.fail(new Error("export_forbidden"));
    const candidates = yield* sql<{ readonly id: string }>`
      select membership.company_id::text as id
      from client_company_memberships membership
      join client_companies company
        on company.id = membership.company_id
       and company.recovery_deleted_at is null and company.purged_at is null
       and (
         ${input.organizationId}::text is null
         or company.clerk_organization_id = ${input.organizationId}
       )
      where membership.user_id = ${input.requesterUserId}
        and membership.revoked_at is null
      order by membership.company_id::text
    `;
    const ids = idRows(candidates);
    for (const companyId of ids) {
      yield* sql`
        select pg_advisory_xact_lock(hashtext(${`brief:client-members:${companyId}`}))
      `;
    }
    yield* lockLiveRequester;
    if (ids.length > 0) {
      yield* sql`
        select id
        from client_companies
        where ${sql.in("id", ids)}
          and recovery_deleted_at is null and purged_at is null
          and (
            ${input.organizationId}::text is null
            or clerk_organization_id = ${input.organizationId}
          )
        order by id::text
        for key share
      `;
    }
    return ids;
  });

export type CreateExportResult =
  | { readonly kind: "conflict" }
  | { readonly kind: "accepted"; readonly row: ExportRow; readonly duplicate: boolean };

export const createExportRequest = (input: {
  readonly requesterUserId: string;
  readonly mfaVerified: boolean;
  readonly organizationId: string | null;
  readonly request: CreateExportRequest;
  readonly auditSucceeded: SqlEffect;
}) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          select pg_advisory_xact_lock(
            hashtext(${`brief:export:${input.requesterUserId}:${input.request.idempotencyKey}`})
          )
        `;
        const existing = yield* sql<ExportRow>`
          select id::text, requester_user_id as "requesterUserId",
                 scope_kind as "scopeKind", scope_id as "scopeId", status,
                 object_key as "objectKey", expires_at as "expiresAt",
                 error_code as "errorCode", created_at as "createdAt",
                 completed_at as "completedAt",
                 (
                   status = 'completed' and object_key is not null
                   and object_deleted_at is null and expires_at > now()
                 ) as "downloadAvailable"
          from export_requests
          where idempotency_key = ${input.request.idempotencyKey}
        `;
        if (
          existing[0] !== undefined &&
          (existing[0].requesterUserId !== input.requesterUserId ||
            existing[0].scopeKind !== input.request.scopeKind ||
            existing[0].scopeId !== input.request.scopeId)
        ) {
          return { kind: "conflict" } as const;
        }
        const lockedClientCompanyIds = yield* lockExportAuthorizationScope({
          requesterUserId: input.requesterUserId,
          organizationId: input.organizationId,
          scopeKind: input.request.scopeKind,
          scopeId: input.request.scopeId,
        });
        const snapshot = yield* authorizeExport({
          requesterUserId: input.requesterUserId,
          mfaVerified: input.mfaVerified,
          organizationId: input.organizationId,
          scopeKind: input.request.scopeKind,
          scopeId: input.request.scopeId,
          lockedClientCompanyIds,
        });
        if (existing[0] !== undefined) {
          yield* input.auditSucceeded;
          return { kind: "accepted", row: existing[0], duplicate: true } as const;
        }
        const rows = yield* sql<ExportRow>`
          insert into export_requests (
            requester_user_id, scope_kind, scope_id, authorization_snapshot, idempotency_key
          ) values (
            ${input.requesterUserId}, ${input.request.scopeKind}, ${input.request.scopeId},
            ${sql.json(snapshot)}, ${input.request.idempotencyKey}
          )
          returning id::text, requester_user_id as "requesterUserId",
                    scope_kind as "scopeKind", scope_id as "scopeId", status,
                    object_key as "objectKey", expires_at as "expiresAt",
                    error_code as "errorCode", created_at as "createdAt",
                    completed_at as "completedAt", false as "downloadAvailable"
        `;
        const row = rows[0]!;
        yield* sql`
          insert into jobs (kind, payload, unique_key, max_attempts)
          values (
            'generate_export', ${sql.json({ exportRequestId: row.id })},
            ${`generate-export:${row.id}`}, 5
          )
          on conflict (unique_key) where unique_key is not null do nothing
        `;
        yield* input.auditSucceeded;
        return { kind: "accepted", row, duplicate: false } as const;
      }),
    );
  });

export const selectExport = (id: string, requesterUserId: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<ExportRow>`
      select id::text, requester_user_id as "requesterUserId",
             scope_kind as "scopeKind", scope_id as "scopeId", status,
             object_key as "objectKey", expires_at as "expiresAt",
             error_code as "errorCode", created_at as "createdAt",
             completed_at as "completedAt",
             (
               status = 'completed' and object_key is not null
               and object_deleted_at is null and expires_at > now()
             ) as "downloadAvailable"
      from export_requests
      where id = ${id} and requester_user_id = ${requesterUserId}
        and exists (
          select 1
          from platform_users users
          where users.id = export_requests.requester_user_id
            and users.recovery_deleted_at is null
            and users.purged_at is null
        )
    `;
    return rows[0] ?? null;
  });

export const withExportDownloadLease = <A, E, R>(
  id: string,
  requesterUserId: string,
  operation: (row: ExportRow) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const candidates = yield* sql<ExportRow>`
          select id::text, requester_user_id as "requesterUserId",
                 scope_kind as "scopeKind", scope_id as "scopeId", status,
                 object_key as "objectKey", expires_at as "expiresAt",
                 error_code as "errorCode", created_at as "createdAt",
                 completed_at as "completedAt", true as "downloadAvailable"
          from export_requests
          where id = ${id} and requester_user_id = ${requesterUserId}
            and status = 'completed'
            and object_key is not null
            and object_deleted_at is null
            and expires_at > now()
          for share
        `;
        const row = candidates[0];
        if (row === undefined) return null;
        const users = yield* sql<{ readonly id: string }>`
          select id
          from platform_users
          where id = ${requesterUserId}
            and recovery_deleted_at is null
            and purged_at is null
          for share
        `;
        if (users[0] === undefined) return null;
        return yield* operation(row);
      }),
    );
  });
