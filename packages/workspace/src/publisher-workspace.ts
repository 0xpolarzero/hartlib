import { PgClient } from "@effect/sql-pg";
import type {
  BriefDocumentDescriptor,
  PublisherAiPullIssueMetric,
  PublisherAiPullMetric,
  PublisherClientAccessDescriptor,
  PublisherIssueDescriptor,
  PublisherSubscriptionDescriptor,
} from "@brief/shared";
import { Effect } from "effect";

import {
  appendAuthorizationAudit,
  auditDeniedThenFail,
  requirePublisherCompanyAdmin,
  requirePublisherCompanyMembership,
  requirePublisherSubscriptionAccess,
  WorkspaceAuthorizationError,
  WorkspaceRuleError,
  type WorkspaceIdentity,
} from "./common";
import {
  INVITATION_DELIVERY_LEASE_INTERVAL,
  releaseInvitationDelivery,
  validInvitationDelivery,
} from "./invitation-delivery";

export const MAX_PUBLISHER_PDF_BYTES = 50 * 1024 * 1024;

interface IssueRow {
  readonly id: string;
  readonly subscriptionId: string;
  readonly title: string;
  readonly status: "draft" | "scheduled" | "published";
  readonly publicationAt: Date | null;
  readonly publishedAt: Date | null;
  readonly historical: boolean;
  readonly indexingStatus: "pending" | "extracting" | "indexing" | "ready" | "failed";
  readonly indexingErrorCode: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const issueDescriptor = (row: IssueRow): PublisherIssueDescriptor => ({
  ...row,
  publicationAt: row.publicationAt?.toISOString() ?? null,
  publishedAt: row.publishedAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

interface SubscriptionRow {
  readonly id: string;
  readonly publisherCompanyId: string;
  readonly name: string;
  readonly deliveryEnabled: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const subscriptionDescriptor = (row: SubscriptionRow): PublisherSubscriptionDescriptor => ({
  ...row,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

interface ClientAccessRow {
  readonly id: string;
  readonly subscriptionId: string;
  readonly clientCompanyId: string;
  readonly clientCompanyName: string;
  readonly state: PublisherClientAccessDescriptor["state"];
  readonly firstAdminEmail: string;
  readonly employeeCount: string | number | bigint;
  readonly invitedAt: Date;
  readonly acceptedAt: Date | null;
  readonly subscribedAt: Date | null;
  readonly deliveryEndAt: Date | null;
}

const clientAccessDescriptor = (row: ClientAccessRow): PublisherClientAccessDescriptor => ({
  ...row,
  employeeCount: Number(row.employeeCount),
  invitedAt: row.invitedAt.toISOString(),
  acceptedAt: row.acceptedAt?.toISOString() ?? null,
  subscribedAt: row.subscribedAt?.toISOString() ?? null,
  deliveryEndAt: row.deliveryEndAt?.toISOString() ?? null,
});

interface DocumentRow {
  readonly id: string;
  readonly issueId: string;
  readonly title: string;
  readonly originalFileName: string;
  readonly mediaType: "application/pdf";
  readonly byteSize: string | number | bigint;
  readonly sha256Hex: string;
  readonly createdAt: Date;
}

interface StoredDocumentRow extends DocumentRow {
  readonly objectKey: string;
  readonly createdByUserId: string;
}

const documentDescriptor = (row: DocumentRow): BriefDocumentDescriptor => ({
  ...row,
  byteSize: Number(row.byteSize),
  createdAt: row.createdAt.toISOString(),
});

const publicDocumentRow = (row: StoredDocumentRow): DocumentRow => ({
  id: row.id,
  issueId: row.issueId,
  title: row.title,
  originalFileName: row.originalFileName,
  mediaType: row.mediaType,
  byteSize: row.byteSize,
  sha256Hex: row.sha256Hex,
  createdAt: row.createdAt,
});

const selectIssue = (issueId: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<IssueRow>`
      select id::text, subscription_id::text as "subscriptionId", title, status,
             publication_at as "publicationAt", published_at as "publishedAt",
             historical, indexing_status as "indexingStatus",
             indexing_error_code as "indexingErrorCode", created_at as "createdAt",
             updated_at as "updatedAt"
      from publisher_issues
      where id = ${issueId} and restricted_at is null and deleted_at is null
    `;
    return rows[0] ?? null;
  });

const selectIssueForUpdate = (issueId: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<IssueRow>`
      select id::text, subscription_id::text as "subscriptionId", title, status,
             publication_at as "publicationAt", published_at as "publishedAt",
             historical, indexing_status as "indexingStatus",
             indexing_error_code as "indexingErrorCode", created_at as "createdAt",
             updated_at as "updatedAt"
      from publisher_issues
      where id = ${issueId} and restricted_at is null and deleted_at is null
      for update
    `;
    return rows[0] ?? null;
  });

const selectClientAccesses = (subscriptionId: string, accessId?: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql<ClientAccessRow>`
      select access.id::text, access.subscription_id::text as "subscriptionId",
             access.client_company_id::text as "clientCompanyId",
             company.name as "clientCompanyName", access.state,
             access.first_admin_email as "firstAdminEmail",
             (select count(distinct grants.user_id)
              from client_employee_subscription_grants grants
              where grants.access_id = access.id and grants.revoked_at is null) as "employeeCount",
             access.invited_at as "invitedAt", access.accepted_at as "acceptedAt",
             access.subscribed_at as "subscribedAt", access.delivery_end_at as "deliveryEndAt"
      from client_subscription_accesses access
      join client_companies company on company.id = access.client_company_id
      where access.subscription_id = ${subscriptionId}
        and (${accessId ?? null}::uuid is null or access.id = ${accessId ?? null})
      order by lower(company.name), access.id
    `;
  });

const enqueuePublication = (
  issue: IssueRow,
  publicationAt: Date,
  identity: WorkspaceIdentity,
  requestId: string,
) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const jobKind = issue.historical ? "import_historical_issues" : "publish_scheduled_issue";
    yield* sql`
      update publisher_issues
      set status = ${issue.historical ? "draft" : "scheduled"},
          publication_at = ${publicationAt}, updated_at = now()
      where id = ${issue.id} and status <> 'published'
    `;
    yield* sql`
      insert into jobs (kind, payload, unique_key, available_at, priority, max_attempts)
      values (
        ${jobKind}, ${sql.json({ issueId: issue.id })},
        ${`${jobKind}:${issue.id}`}, ${publicationAt}, 30, 8
      )
      on conflict (unique_key) where unique_key is not null do update set
        payload = excluded.payload,
        available_at = excluded.available_at,
        status = case when jobs.status in ('completed', 'failed') then 'queued' else jobs.status end,
        attempts = case when jobs.status in ('completed', 'failed') then 0 else jobs.attempts end,
        completed_at = case when jobs.status in ('completed', 'failed') then null else jobs.completed_at end,
        last_error = case when jobs.status in ('completed', 'failed') then null else jobs.last_error end,
        updated_at = now()
    `;
    yield* appendAuthorizationAudit({
      identity,
      requestId,
      action: issue.historical ? "publisher.issue.publish_historical" : "publisher.issue.schedule",
      scopeKind: "publisher_issue",
      scopeId: issue.id,
      outcome: "succeeded",
    });
  });

const withDeniedAudit = <A, E>(
  effect: Effect.Effect<A, E, PgClient.PgClient>,
  identity: WorkspaceIdentity,
  requestId: string,
  action: string,
  scopeKind: string,
  scopeId: string,
) =>
  effect.pipe(
    Effect.catch((error) =>
      auditDeniedThenFail(identity, requestId, action, scopeKind, scopeId, error),
    ),
  );

export const listPublisherSubscriptions = (identity: WorkspaceIdentity, companyId: string) =>
  Effect.gen(function* () {
    yield* requirePublisherCompanyMembership(identity, companyId);
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<SubscriptionRow>`
      select subscription.id::text,
             subscription.publisher_company_id::text as "publisherCompanyId",
             subscription.name, subscription.delivery_enabled as "deliveryEnabled",
             subscription.created_at as "createdAt", subscription.updated_at as "updatedAt"
      from publisher_subscriptions subscription
      join publisher_company_memberships membership
        on membership.publisher_company_id = subscription.publisher_company_id
       and membership.user_id = ${identity.userId}
      where subscription.publisher_company_id = ${companyId}
        and (
          membership.role = 'admin'
          or exists (
            select 1 from publisher_membership_subscription_grants grant_row
            where grant_row.publisher_company_id = membership.publisher_company_id
              and grant_row.user_id = membership.user_id
              and grant_row.subscription_id = subscription.id
          )
        )
      order by subscription.created_at, subscription.id
    `;
    return rows.map(subscriptionDescriptor);
  });

export const createPublisherSubscription = (input: {
  readonly identity: WorkspaceIdentity;
  readonly companyId: string;
  readonly name: string;
  readonly requestId: string;
  readonly auditSucceeded?: (
    subscriptionId: string,
  ) => Effect.Effect<void, unknown, PgClient.PgClient>;
}) =>
  withDeniedAudit(
    Effect.gen(function* () {
      if (input.name.trim() === "" || input.name.length > 200) {
        return yield* Effect.fail(new WorkspaceRuleError("invalid_body"));
      }
      const sql = yield* PgClient.PgClient;
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* requirePublisherCompanyAdmin(input.identity, input.companyId);
          const rows = yield* sql<SubscriptionRow>`
            insert into publisher_subscriptions (publisher_company_id, name, created_by_user_id)
            values (${input.companyId}, ${input.name.trim()}, ${input.identity.userId})
            returning id::text, publisher_company_id::text as "publisherCompanyId", name,
                      delivery_enabled as "deliveryEnabled", created_at as "createdAt",
                      updated_at as "updatedAt"
          `;
          const row = rows[0]!;
          yield* (
            input.auditSucceeded?.(row.id) ??
              appendAuthorizationAudit({
                identity: input.identity,
                requestId: input.requestId,
                action: "publisher.subscription.create",
                scopeKind: "publisher_subscription",
                scopeId: row.id,
                outcome: "succeeded",
              })
          );
          return subscriptionDescriptor(row);
        }),
      );
    }),
    input.identity,
    input.requestId,
    "publisher.subscription.create",
    "publisher_company",
    input.companyId,
  );

export const listPublisherIssues = (identity: WorkspaceIdentity, subscriptionId: string) =>
  Effect.gen(function* () {
    yield* requirePublisherSubscriptionAccess(identity, subscriptionId, "read");
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<IssueRow>`
      select id::text, subscription_id::text as "subscriptionId", title, status,
             publication_at as "publicationAt", published_at as "publishedAt", historical,
             indexing_status as "indexingStatus", indexing_error_code as "indexingErrorCode",
             created_at as "createdAt", updated_at as "updatedAt"
      from publisher_issues
      where subscription_id = ${subscriptionId}
        and restricted_at is null and deleted_at is null
      order by publication_at desc nulls first, created_at desc, id
    `;
    return rows.map(issueDescriptor);
  });

export const createPublisherIssue = (input: {
  readonly identity: WorkspaceIdentity;
  readonly subscriptionId: string;
  readonly title: string;
  readonly publicationAt: Date | null;
  readonly historical: boolean;
  readonly requestId: string;
  readonly auditSucceeded?: (issueId: string) => Effect.Effect<void, unknown, PgClient.PgClient>;
}) =>
  withDeniedAudit(
    Effect.gen(function* () {
      if (
        input.title.trim() === "" ||
        input.title.length > 300 ||
        (input.publicationAt !== null && Number.isNaN(input.publicationAt.getTime())) ||
        (input.historical && (input.publicationAt === null || input.publicationAt >= new Date()))
      ) {
        return yield* Effect.fail(new WorkspaceRuleError("invalid_body"));
      }
      const sql = yield* PgClient.PgClient;
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* requirePublisherSubscriptionAccess(
            input.identity,
            input.subscriptionId,
            "content_manage",
          );
          const rows = yield* sql<IssueRow>`
            insert into publisher_issues (
              subscription_id, title, publication_at, historical, created_by_user_id
            ) values (
              ${input.subscriptionId}, ${input.title.trim()}, ${input.publicationAt},
              ${input.historical}, ${input.identity.userId}
            )
            returning id::text, subscription_id::text as "subscriptionId", title, status,
                      publication_at as "publicationAt", published_at as "publishedAt", historical,
                      indexing_status as "indexingStatus", indexing_error_code as "indexingErrorCode",
                      created_at as "createdAt", updated_at as "updatedAt"
          `;
          const row = rows[0]!;
          yield* (
            input.auditSucceeded?.(row.id) ??
              appendAuthorizationAudit({
                identity: input.identity,
                requestId: input.requestId,
                action: "publisher.issue.create",
                scopeKind: "publisher_issue",
                scopeId: row.id,
                outcome: "succeeded",
              })
          );
          return issueDescriptor(row);
        }),
      );
    }),
    input.identity,
    input.requestId,
    "publisher.issue.create",
    "publisher_subscription",
    input.subscriptionId,
  );

export const getPublisherIssue = (identity: WorkspaceIdentity, issueId: string) =>
  Effect.gen(function* () {
    const issue = yield* selectIssue(issueId);
    if (issue === null) return yield* Effect.fail(new WorkspaceAuthorizationError("not_found"));
    yield* requirePublisherSubscriptionAccess(identity, issue.subscriptionId, "read");
    const sql = yield* PgClient.PgClient;
    const documents = yield* sql<DocumentRow>`
      select id::text, issue_id::text as "issueId", title,
             original_file_name as "originalFileName", media_type as "mediaType",
             byte_size as "byteSize", sha256_hex as "sha256Hex", created_at as "createdAt"
      from brief_documents
      where issue_id = ${issueId} and deleted_at is null
      order by created_at, id
    `;
    return { issue: issueDescriptor(issue), documents: documents.map(documentDescriptor) };
  });

export const updatePublisherIssue = (input: {
  readonly identity: WorkspaceIdentity;
  readonly issueId: string;
  readonly title: string;
  readonly requestId: string;
}) =>
  withDeniedAudit(
    Effect.gen(function* () {
      if (input.title.trim() === "" || input.title.length > 300) {
        return yield* Effect.fail(new WorkspaceRuleError("invalid_body"));
      }
      const sql = yield* PgClient.PgClient;
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const issue = yield* selectIssueForUpdate(input.issueId);
          if (issue === null) {
            return yield* Effect.fail(new WorkspaceAuthorizationError("not_found"));
          }
          yield* requirePublisherSubscriptionAccess(
            input.identity,
            issue.subscriptionId,
            "content_manage",
          );
          if (issue.status === "published") {
            return yield* Effect.fail(new WorkspaceRuleError("published_issue_immutable"));
          }
          const rows = yield* sql<IssueRow>`
            update publisher_issues set title = ${input.title.trim()}, updated_at = now()
            where id = ${input.issueId} and status <> 'published'
            returning id::text, subscription_id::text as "subscriptionId", title, status,
                      publication_at as "publicationAt", published_at as "publishedAt", historical,
                      indexing_status as "indexingStatus", indexing_error_code as "indexingErrorCode",
                      created_at as "createdAt", updated_at as "updatedAt"
          `;
          if (rows[0] === undefined) {
            return yield* Effect.fail(new WorkspaceRuleError("published_issue_immutable"));
          }
          yield* appendAuthorizationAudit({
            identity: input.identity,
            requestId: input.requestId,
            action: "publisher.issue.update",
            scopeKind: "publisher_issue",
            scopeId: input.issueId,
            outcome: "succeeded",
          });
          return issueDescriptor(rows[0]);
        }),
      );
    }),
    input.identity,
    input.requestId,
    "publisher.issue.update",
    "publisher_issue",
    input.issueId,
  );

export const deletePublisherIssue = (input: {
  readonly identity: WorkspaceIdentity;
  readonly issueId: string;
  readonly requestId: string;
}) =>
  withDeniedAudit(
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const issue = yield* selectIssueForUpdate(input.issueId);
          if (issue === null) {
            return yield* Effect.fail(new WorkspaceAuthorizationError("not_found"));
          }
          yield* requirePublisherSubscriptionAccess(
            input.identity,
            issue.subscriptionId,
            "content_manage",
          );
          if (issue.status === "published") {
            return yield* Effect.fail(new WorkspaceRuleError("published_issue_immutable"));
          }
          const deletedAt = new Date();
          const purgeAfter = new Date(deletedAt.getTime() + 30 * 86_400_000);
          const deleted = yield* sql<{ readonly id: string }>`
            update publisher_issues
            set deleted_at = ${deletedAt}, deleted_by_user_id = ${input.identity.userId},
                purge_after = ${purgeAfter}, updated_at = now()
            where id = ${input.issueId} and status <> 'published' and deleted_at is null
            returning id::text
          `;
          if (deleted[0] === undefined) {
            return yield* Effect.fail(new WorkspaceRuleError("published_issue_immutable"));
          }
          yield* sql`
            update brief_documents
            set deleted_at = ${deletedAt}, deleted_by_user_id = ${input.identity.userId},
                purge_after = ${purgeAfter}, updated_at = now()
            where issue_id = ${input.issueId} and deleted_at is null
          `;
          yield* sql`
            update jobs
            set status = 'completed', completed_at = now(),
                last_error = 'cancelled_publisher_issue_deleted', updated_at = now()
            where status in ('queued', 'retrying')
              and (
                (kind in ('publish_scheduled_issue', 'import_historical_issues',
                          'update_ai_indexing_status')
                 and payload->>'issueId' = ${input.issueId})
                or
                (kind = 'extract_pdf_text' and payload->>'documentId' in (
                  select id::text from brief_documents where issue_id = ${input.issueId}
                ))
                or
                (kind = 'normalize_searchable_text' and payload->>'extractionId' in (
                  select extractions.id::text
                  from brief_document_extractions extractions
                  join brief_documents documents
                    on documents.id = extractions.brief_document_id
                  where documents.issue_id = ${input.issueId}
                ))
              )
          `;
          yield* sql`
            insert into jobs (kind, payload, unique_key, available_at, max_attempts)
            values (
              'purge_deleted_files', '{}'::jsonb, 'purge-deleted-files', ${purgeAfter}, 8
            )
            on conflict (unique_key) where unique_key is not null do update set
              available_at = least(jobs.available_at, excluded.available_at),
              status = case when jobs.status in ('completed', 'failed')
                            then 'queued' else jobs.status end,
              attempts = case when jobs.status in ('completed', 'failed')
                              then 0 else jobs.attempts end,
              completed_at = case when jobs.status in ('completed', 'failed')
                                  then null else jobs.completed_at end,
              last_error = case when jobs.status in ('completed', 'failed')
                                then null else jobs.last_error end,
              updated_at = now()
          `;
          yield* appendAuthorizationAudit({
            identity: input.identity,
            requestId: input.requestId,
            action: "publisher.issue.delete",
            scopeKind: "publisher_issue",
            scopeId: input.issueId,
            outcome: "succeeded",
          });
        }),
      );
    }),
    input.identity,
    input.requestId,
    "publisher.issue.delete",
    "publisher_issue",
    input.issueId,
  );

export const schedulePublisherIssue = (input: {
  readonly identity: WorkspaceIdentity;
  readonly issueId: string;
  readonly publicationAt: Date;
  readonly requestId: string;
}) =>
  withDeniedAudit(
    Effect.gen(function* () {
      if (Number.isNaN(input.publicationAt.getTime()) || input.publicationAt <= new Date()) {
        return yield* Effect.fail(new WorkspaceRuleError("invalid_body"));
      }
      const sql = yield* PgClient.PgClient;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const issue = yield* selectIssueForUpdate(input.issueId);
          if (issue === null)
            return yield* Effect.fail(new WorkspaceAuthorizationError("not_found"));
          yield* requirePublisherSubscriptionAccess(
            input.identity,
            issue.subscriptionId,
            "content_manage",
          );
          if (issue.status === "published" || issue.historical) {
            return yield* Effect.fail(new WorkspaceRuleError("issue_not_schedulable"));
          }
          const documents = yield* sql<{ count: number }>`
            select count(*)::int count from brief_documents
            where issue_id = ${input.issueId} and deleted_at is null
              and upload_completed_at is not null
          `;
          if ((documents[0]?.count ?? 0) === 0) {
            return yield* Effect.fail(new WorkspaceRuleError("issue_requires_pdf"));
          }
          yield* enqueuePublication(issue, input.publicationAt, input.identity, input.requestId);
        }),
      );
      return input.publicationAt.toISOString();
    }),
    input.identity,
    input.requestId,
    "publisher.issue.schedule",
    "publisher_issue",
    input.issueId,
  );

export const publishPublisherIssue = (input: {
  readonly identity: WorkspaceIdentity;
  readonly issueId: string;
  readonly requestId: string;
}) =>
  withDeniedAudit(
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const issue = yield* selectIssueForUpdate(input.issueId);
          if (issue === null)
            return yield* Effect.fail(new WorkspaceAuthorizationError("not_found"));
          yield* requirePublisherSubscriptionAccess(
            input.identity,
            issue.subscriptionId,
            "content_manage",
          );
          if (issue.status === "published") return "published" as const;
          if (
            issue.historical &&
            (issue.publicationAt === null || issue.publicationAt > new Date())
          ) {
            return yield* Effect.fail(
              new WorkspaceRuleError("historical_publication_time_invalid"),
            );
          }
          const documents = yield* sql<{ count: number }>`
            select count(*)::int count from brief_documents
            where issue_id = ${input.issueId} and deleted_at is null
          `;
          if ((documents[0]?.count ?? 0) === 0) {
            return yield* Effect.fail(new WorkspaceRuleError("issue_requires_pdf"));
          }
          yield* enqueuePublication(issue, new Date(), input.identity, input.requestId);
          return "queued" as const;
        }),
      );
    }),
    input.identity,
    input.requestId,
    "publisher.issue.publish",
    "publisher_issue",
    input.issueId,
  );

export interface PublisherPdfObjectStore {
  readonly put: (input: {
    readonly objectKey: string;
    readonly body: Uint8Array;
    readonly sha256Hex: string;
    readonly signal: AbortSignal;
  }) => Promise<void>;
  readonly head: (input: {
    readonly objectKey: string;
    readonly signal: AbortSignal;
  }) => Promise<PublisherPdfObjectMetadata | null>;
  readonly delete: (input: {
    readonly objectKey: string;
    readonly signal: AbortSignal;
  }) => Promise<void>;
}

export interface PublisherPdfObjectMetadata {
  readonly byteSize: number;
  readonly sha256Hex: string;
  readonly mediaType: string;
}

export const PUBLISHER_UPLOAD_STORAGE_TIMEOUT_MS = 20_000;
/** Five bounded PUT/HEAD calls can take 100 seconds; the lease spans that
 * complete provider attempt with margin and is always checked against the
 * PostgreSQL clock before a state transition. */
export const PUBLISHER_UPLOAD_RESERVATION_LEASE_MS = 120_000;
export const PUBLISHER_UPLOAD_RESERVATION_LEASE_INTERVAL = "2 minutes";

const boundedObjectStoreOperation = <A>(
  operation: (signal: AbortSignal) => Promise<A>,
  requestSignal?: AbortSignal,
): Effect.Effect<A, unknown> =>
  Effect.tryPromise({
    try: (effectSignal) => {
      const controller = new AbortController();
      const abort = () => controller.abort(requestSignal?.reason ?? effectSignal.reason);
      if (effectSignal.aborted || requestSignal?.aborted) abort();
      effectSignal.addEventListener("abort", abort, { once: true });
      requestSignal?.addEventListener("abort", abort, { once: true });
      return operation(controller.signal).finally(() => {
        effectSignal.removeEventListener("abort", abort);
        requestSignal?.removeEventListener("abort", abort);
      });
    },
    catch: (error) => error,
  }).pipe(Effect.timeout(`${PUBLISHER_UPLOAD_STORAGE_TIMEOUT_MS} millis`));

const sha256Hex = (bytes: Uint8Array) =>
  Effect.promise(async () => {
    const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  });

export const uploadPublisherDocument = (input: {
  readonly identity: WorkspaceIdentity;
  readonly issueId: string;
  readonly idempotencyKey: string;
  readonly title: string;
  readonly fileName: string;
  readonly expectedHash: string;
  readonly declaredBytes: number;
  readonly body: Uint8Array;
  readonly requestId: string;
  readonly store: PublisherPdfObjectStore | null;
  readonly requestSignal?: AbortSignal;
  readonly auditSucceeded?: (documentId: string) => Effect.Effect<void, unknown, PgClient.PgClient>;
}) => {
  const operation = Effect.gen(function* () {
    const title = input.title.trim();
    const fileName = input.fileName.trim();
    const expectedHash = input.expectedHash.trim().toLowerCase();
    const idempotencyKey = input.idempotencyKey.trim();
    if (
      !/^[A-Za-z0-9._:-]{16,200}$/u.test(idempotencyKey) ||
      title === "" ||
      title.length > 300 ||
      fileName === "" ||
      fileName.length > 255 ||
      /[/\\\r\n]/u.test(fileName) ||
      !/^[0-9a-f]{64}$/u.test(expectedHash) ||
      !Number.isSafeInteger(input.declaredBytes) ||
      input.declaredBytes <= 0 ||
      input.declaredBytes > MAX_PUBLISHER_PDF_BYTES
    ) {
      return yield* Effect.fail(new WorkspaceRuleError("upload_metadata_invalid"));
    }
    const currentIssue = yield* selectIssue(input.issueId);
    if (currentIssue === null) {
      return yield* Effect.fail(new WorkspaceAuthorizationError("not_found"));
    }
    yield* requirePublisherSubscriptionAccess(
      input.identity,
      currentIssue.subscriptionId,
      "content_manage",
    );
    const sql = yield* PgClient.PgClient;
    type Reservation = {
      readonly id: string;
      readonly documentId: string;
      readonly issueId: string;
      readonly idempotencyKey: string;
      readonly objectKey: string;
      readonly requestId: string;
      readonly state: "processing" | "object_put" | "retryable" | "finalized";
      readonly attempt: number;
      readonly leaseExpiresAt: Date;
      readonly leaseToken: string;
    };
    type ExistingIntent = Reservation & {
      readonly leaseFresh: boolean;
      readonly expectedHash: string;
      readonly byteSize: number;
      readonly actorUserId: string;
      readonly actorOrganizationId: string | null;
      readonly actorSessionId: string;
      readonly actorMode: "demo" | "clerk";
      readonly title: string;
      readonly fileName: string;
      readonly mediaType: "application/pdf";
    };
    const reservation = (row: ExistingIntent): ExistingIntent => row;
    const matchesBoundInput = (row: ExistingIntent) =>
      row.expectedHash === expectedHash &&
      row.byteSize === input.declaredBytes &&
      row.actorUserId === input.identity.userId &&
      row.actorOrganizationId === input.identity.organizationId &&
      row.actorSessionId === input.identity.sessionId &&
      row.actorMode === input.identity.mode &&
      row.title === title &&
      row.fileName === fileName &&
      row.mediaType === "application/pdf";
    const selectStoredDocument = (documentId: string) =>
      sql<StoredDocumentRow>`
        select id::text, issue_id::text as "issueId", title,
               original_file_name as "originalFileName", object_key as "objectKey",
               media_type as "mediaType", byte_size::float8 as "byteSize",
               sha256_hex as "sha256Hex", created_by_user_id as "createdByUserId",
               created_at as "createdAt"
        from brief_documents
        where id = ${documentId} and issue_id = ${input.issueId}
      `;
    const exactStoredDocument = (
      row: Pick<
        ExistingIntent,
        | "objectKey"
        | "issueId"
        | "title"
        | "fileName"
        | "mediaType"
        | "byteSize"
        | "expectedHash"
        | "actorUserId"
      >,
      stored: StoredDocumentRow,
    ) =>
      stored.objectKey === row.objectKey &&
      stored.issueId === row.issueId &&
      stored.title === row.title &&
      stored.originalFileName === row.fileName &&
      stored.mediaType === row.mediaType &&
      stored.byteSize === row.byteSize &&
      stored.sha256Hex === row.expectedHash &&
      stored.createdByUserId === row.actorUserId;
    const selectExisting = (key: string) =>
      sql<ExistingIntent>`
        select id::text, document_id::text as "documentId", issue_id::text as "issueId",
               idempotency_key as "idempotencyKey",
               object_key as "objectKey", expected_sha256_hex as "expectedHash",
               byte_size::float8 as "byteSize", actor_user_id as "actorUserId",
               actor_organization_id as "actorOrganizationId",
               actor_session_id as "actorSessionId", actor_mode as "actorMode",
               title, original_file_name as "fileName", media_type as "mediaType",
               request_id as "requestId",
               state, attempt, lease_token::text as "leaseToken", lease_expires_at as "leaseExpiresAt",
               lease_expires_at > now() as "leaseFresh"
        from publisher_document_upload_intents
        where issue_id = ${input.issueId} and idempotency_key = ${key}
        for update
      `;
    const preexisting = yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          select pg_advisory_xact_lock(
            hashtextextended(${`brief:publisher-upload-reservation:${input.issueId}:${idempotencyKey}`}, 0)
          )
        `;
        const existing = yield* selectExisting(idempotencyKey);
        const row = existing[0];
        if (row !== undefined && !matchesBoundInput(row)) {
          return yield* Effect.fail(new WorkspaceRuleError("idempotency_conflict"));
        }
        return row ?? null;
      }),
    );
    if (preexisting === null && currentIssue.status === "published") {
      return yield* Effect.fail(new WorkspaceRuleError("published_issue_immutable"));
    }
    // A finalized exact replay is authorized by the immutable reservation and
    // returns its stored document without re-validating the request body. The
    // body is not part of the replay identity: changed bound fields were
    // rejected above, while an exact replay may arrive with an empty or
    // otherwise unavailable body. Keep the replay audit in a transaction under
    // the reservation lane so it cannot race a terminal reservation change.
    if (preexisting?.state === "finalized") {
      const replay = yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`
            select pg_advisory_xact_lock(
              hashtextextended(
                ${`brief:publisher-upload-reservation:${input.issueId}:${idempotencyKey}`}, 0
              )
            )
          `;
          const existing = yield* selectExisting(idempotencyKey);
          const row = existing[0];
          if (row === undefined || !matchesBoundInput(row) || row.state !== "finalized") {
            return null;
          }
          const documents = yield* selectStoredDocument(row.documentId);
          const stored = documents[0];
          if (stored === undefined || !exactStoredDocument(row, stored)) {
            return yield* Effect.fail(new WorkspaceRuleError("idempotency_conflict"));
          }
          yield* appendAuthorizationAudit({
            identity: input.identity,
            requestId: input.requestId,
            action: "publisher.document.upload",
            scopeKind: "brief_document",
            scopeId: stored.id,
            outcome: "succeeded",
          });
          return publicDocumentRow(stored);
        }),
      );
      if (replay !== null) return documentDescriptor(replay);
    }
    if (
      input.body.byteLength !== input.declaredBytes ||
      input.body.byteLength > MAX_PUBLISHER_PDF_BYTES
    ) {
      return yield* Effect.fail(new WorkspaceRuleError("upload_size_mismatch"));
    }
    const actualHash = yield* sha256Hex(input.body);
    if (actualHash !== expectedHash) {
      return yield* Effect.fail(new WorkspaceRuleError("upload_hash_mismatch"));
    }
    if (
      input.body.byteLength < 5 ||
      new TextDecoder().decode(input.body.subarray(0, 5)) !== "%PDF-"
    ) {
      return yield* Effect.fail(new WorkspaceRuleError("pdf_signature_invalid"));
    }
    if (input.store === null && preexisting === null) {
      return yield* Effect.fail(new WorkspaceRuleError("document_storage_unavailable"));
    }
    const reserve = () =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`
            select pg_advisory_xact_lock(
              hashtextextended(${`brief:publisher-upload-reservation:${input.issueId}:${idempotencyKey}`}, 0)
            )
          `;
          const existing = yield* selectExisting(idempotencyKey);
          if (existing[0] !== undefined) {
            const row = reservation(existing[0]);
            if (!matchesBoundInput(row))
              return yield* Effect.fail(new WorkspaceRuleError("idempotency_conflict"));
            const documents = yield* selectStoredDocument(row.documentId);
            if (documents[0] !== undefined) {
              const stored = documents[0];
              if (!exactStoredDocument(row, stored)) {
                return yield* Effect.fail(new WorkspaceRuleError("idempotency_conflict"));
              }
              yield* appendAuthorizationAudit({
                identity: input.identity,
                requestId: input.requestId,
                action: "publisher.document.upload",
                scopeKind: "brief_document",
                scopeId: stored.id,
                outcome: "succeeded",
              });
              return { kind: "replay" as const, document: publicDocumentRow(stored) };
            }
            const issue = yield* selectIssueForUpdate(input.issueId);
            if (issue === null)
              return yield* Effect.fail(new WorkspaceAuthorizationError("not_found"));
            yield* requirePublisherSubscriptionAccess(
              input.identity,
              issue.subscriptionId,
              "content_manage",
            );
            if (issue.status === "published") {
              return yield* Effect.fail(new WorkspaceRuleError("published_issue_immutable"));
            }
            if (input.store === null) {
              return yield* Effect.fail(new WorkspaceRuleError("document_storage_unavailable"));
            }
            if (row.state === "processing" && row.leaseFresh) {
              return { kind: "wait" as const };
            }
            const leaseToken = crypto.randomUUID();
            const claimedRows = yield* sql<{ readonly leaseExpiresAt: Date }>`
              update publisher_document_upload_intents
              set state = 'processing', attempt = attempt + 1,
                  lease_token = ${leaseToken}, lease_expires_at = now() + ${PUBLISHER_UPLOAD_RESERVATION_LEASE_INTERVAL}::interval,
                  reconcile_after = now() + interval '15 minutes'
              where id = ${row.id}
              returning lease_expires_at as "leaseExpiresAt"
            `;
            return {
              kind: "claimed" as const,
              reservation: {
                ...row,
                state: "processing",
                attempt: row.attempt + 1,
                leaseToken,
                leaseExpiresAt: claimedRows[0]?.leaseExpiresAt ?? row.leaseExpiresAt,
              },
            };
          }
          const issue = yield* selectIssueForUpdate(input.issueId);
          if (issue === null)
            return yield* Effect.fail(new WorkspaceAuthorizationError("not_found"));
          yield* requirePublisherSubscriptionAccess(
            input.identity,
            issue.subscriptionId,
            "content_manage",
          );
          if (issue.status === "published")
            return yield* Effect.fail(new WorkspaceRuleError("published_issue_immutable"));
          if (input.store === null)
            return yield* Effect.fail(new WorkspaceRuleError("document_storage_unavailable"));
          const id = crypto.randomUUID();
          const objectKey = `publisher-issues/${input.issueId}/documents/${id}.pdf`;
          const leaseToken = crypto.randomUUID();
          const insertedRows = yield* sql<{ readonly leaseExpiresAt: Date }>`
            insert into publisher_document_upload_intents (
              id, document_id, issue_id, idempotency_key, object_key, expected_sha256_hex,
              byte_size, actor_user_id, actor_organization_id, actor_session_id, actor_mode,
              title, original_file_name, media_type, request_id, attempt, lease_token,
              lease_expires_at, state, reconcile_after
            ) values (
              ${id}, ${id}, ${input.issueId}, ${idempotencyKey}, ${objectKey}, ${actualHash},
              ${input.body.byteLength}, ${input.identity.userId}, ${input.identity.organizationId},
              ${input.identity.sessionId}, ${input.identity.mode}, ${title}, ${fileName},
              'application/pdf', ${input.requestId}, 1, ${leaseToken},
              now() + ${PUBLISHER_UPLOAD_RESERVATION_LEASE_INTERVAL}::interval, 'processing', now() + interval '15 minutes'
            )
            returning lease_expires_at as "leaseExpiresAt"
          `;
          const inserted = insertedRows[0];
          if (inserted === undefined) {
            return yield* Effect.fail(new WorkspaceRuleError("document_upload_failed"));
          }
          yield* sql`
            insert into jobs (kind, payload, unique_key, available_at, priority, max_attempts)
            values (
              'reconcile_publisher_uploads', '{}'::jsonb, 'reconcile-publisher-uploads',
              now() + interval '15 minutes', -50, 8
            )
            on conflict (unique_key) where unique_key is not null do update set
              available_at = least(jobs.available_at, excluded.available_at),
              status = case when jobs.status in ('completed', 'failed') then 'queued' else jobs.status end,
              attempts = case when jobs.status in ('completed', 'failed') then 0 else jobs.attempts end,
              completed_at = case when jobs.status in ('completed', 'failed') then null else jobs.completed_at end,
              last_error = case when jobs.status in ('completed', 'failed') then null else jobs.last_error end,
              updated_at = now()
          `;
          return {
            kind: "claimed" as const,
            reservation: {
              id,
              documentId: id,
              issueId: input.issueId,
              idempotencyKey,
              objectKey,
              requestId: input.requestId,
              expectedHash: actualHash,
              byteSize: input.body.byteLength,
              actorUserId: input.identity.userId,
              actorOrganizationId: input.identity.organizationId,
              actorSessionId: input.identity.sessionId,
              actorMode: input.identity.mode,
              title,
              fileName,
              mediaType: "application/pdf" as const,
              state: "processing" as const,
              attempt: 1,
              leaseToken,
              leaseExpiresAt: inserted.leaseExpiresAt,
            },
          };
        }),
      );

    const waitForReservation = () =>
      Effect.tryPromise({
        try: (signal) =>
          new Promise<void>((resolve, reject) => {
            const finish = () => {
              clearTimeout(timer);
              signal.removeEventListener("abort", abort);
              input.requestSignal?.removeEventListener("abort", abort);
            };
            const abort = () => {
              finish();
              reject(new Error("publisher_upload_request_aborted"));
            };
            const timer = setTimeout(() => {
              finish();
              resolve();
            }, 100);
            signal.addEventListener("abort", abort, { once: true });
            input.requestSignal?.addEventListener("abort", abort, { once: true });
            if (signal.aborted || input.requestSignal?.aborted) abort();
          }),
        catch: (error) => error,
      });
    let reserved = yield* reserve();
    for (let waitAttempt = 0; reserved.kind === "wait" && waitAttempt < 250; waitAttempt += 1) {
      yield* waitForReservation();
      reserved = yield* reserve();
    }
    if (reserved.kind === "wait")
      return yield* Effect.fail(new WorkspaceRuleError("document_upload_in_progress"));
    if (reserved.kind === "replay") return documentDescriptor(reserved.document);
    const current = reserved.reservation;
    const put = () =>
      boundedObjectStoreOperation(
        (signal) =>
          input.store!.put({
            objectKey: current.objectKey,
            body: input.body,
            sha256Hex: actualHash,
            signal,
          }),
        input.requestSignal,
      );
    const head = () =>
      boundedObjectStoreOperation(
        (signal) => input.store!.head({ objectKey: current.objectKey, signal }),
        input.requestSignal,
      );
    const assertLeaseFresh = () =>
      sql.withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{ readonly id: string }>`
            select id::text
            from publisher_document_upload_intents
            where id = ${current.id}
              and lease_token = ${current.leaseToken}
              and attempt = ${current.attempt}
              and state = 'processing'
              and lease_expires_at > clock_timestamp()
            for update
          `;
          if (rows[0] === undefined) {
            return yield* Effect.fail(new WorkspaceRuleError("document_upload_failed"));
          }
        }),
      );
    const exact = (metadata: PublisherPdfObjectMetadata | null) =>
      metadata !== null &&
      metadata.byteSize === input.body.byteLength &&
      metadata.sha256Hex === actualHash &&
      metadata.mediaType === "application/pdf";
    let objectReady = false;
    let metadata: PublisherPdfObjectMetadata | null = null;
    yield* assertLeaseFresh();
    const firstPut = yield* put().pipe(
      Effect.match({ onFailure: () => false, onSuccess: () => true }),
    );
    if (firstPut) objectReady = true;
    yield* assertLeaseFresh();
    if (!objectReady) {
      metadata = yield* head().pipe(
        Effect.match({ onFailure: () => null, onSuccess: (value) => value }),
      );
      if (exact(metadata)) objectReady = true;
      yield* assertLeaseFresh();
    }
    if (!objectReady) {
      const secondPut = yield* put().pipe(
        Effect.match({ onFailure: () => false, onSuccess: () => true }),
      );
      objectReady = secondPut;
      yield* assertLeaseFresh();
      if (!objectReady) {
        metadata = yield* head().pipe(
          Effect.match({ onFailure: () => null, onSuccess: (value) => value }),
        );
        if (exact(metadata)) objectReady = true;
        yield* assertLeaseFresh();
      }
    }
    if (!objectReady) {
      if (metadata !== null && !exact(metadata)) {
        // Cleanup mutates the immutable object key shared by every retry.
        // Hold the reservation lane across the exact owner fence, bounded
        // DELETE, and retryable transition. If the lease expires during the
        // provider call, the post-operation fence fails closed; the next
        // attempt can claim only after this transaction releases the lane.
        const cleanupOutcome = yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              select pg_advisory_xact_lock(
                hashtextextended(
                  ${`brief:publisher-upload-reservation:${current.issueId}:${current.idempotencyKey}`}, 0
                )
              )
            `;
            const owner = yield* sql<{ readonly id: string }>`
              select id::text
              from publisher_document_upload_intents
              where id = ${current.id}
                and attempt = ${current.attempt}
                and lease_token = ${current.leaseToken}
                and state = 'processing'
                and lease_expires_at > clock_timestamp()
              for update
            `;
            if (owner[0] === undefined) return "lost" as const;

            // A failed or timed-out DELETE leaves durable retryable state
            // only while this owner is still current. Recheck after the
            // provider boundary because it may outlive the remaining lease.
            const deleted = yield* boundedObjectStoreOperation(
              (signal) => input.store!.delete({ objectKey: current.objectKey, signal }),
              input.requestSignal,
            ).pipe(
              Effect.match({
                onFailure: () => false,
                onSuccess: () => true,
              }),
            );
            const stillOwner = yield* sql<{ readonly id: string }>`
              select id::text
              from publisher_document_upload_intents
              where id = ${current.id}
                and attempt = ${current.attempt}
                and lease_token = ${current.leaseToken}
                and state = 'processing'
                and lease_expires_at > clock_timestamp()
              for update
            `;
            if (stillOwner[0] === undefined) return "lost" as const;

            // The evidence and retryable transition are both fenced to this
            // exact attempt owner. A stale owner may have waited through the
            // provider boundary, but it cannot leave evidence that applies to
            // a later retry or transition that retryable row.
            const evidence = deleted ? "object_deleted" : "cleanup_required";
            const errorCode = deleted ? null : "object_delete_failed";
            const evidenceRows = yield* sql<{ readonly id: string }>`
              insert into publisher_document_upload_events (
                operation_id, attempt, event_kind, error_code
              )
              select id, attempt, ${evidence}, ${errorCode}
              from publisher_document_upload_intents
              where id = ${current.id}
                and attempt = ${current.attempt}
                and lease_token = ${current.leaseToken}
                and state = 'processing'
                and lease_expires_at > clock_timestamp()
              on conflict (operation_id, attempt, event_kind) do nothing
              returning operation_id::text as id
            `;
            if (evidenceRows[0] === undefined) return "lost" as const;

            const retryable = yield* sql<{ readonly id: string }>`
              update publisher_document_upload_intents
              set state = 'retryable', lease_expires_at = clock_timestamp()
              where id = ${current.id}
                and attempt = ${current.attempt}
                and lease_token = ${current.leaseToken}
                and state = 'processing'
                and lease_expires_at > clock_timestamp()
              returning id::text
            `;
            return retryable[0] === undefined ? ("lost" as const) : ("retryable" as const);
          }),
        );
        if (cleanupOutcome === "lost") {
          return yield* Effect.fail(new WorkspaceRuleError("document_upload_failed"));
        }
        return yield* Effect.fail(new WorkspaceRuleError("document_upload_failed"));
      }
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`
            select pg_advisory_xact_lock(
              hashtextextended(
                ${`brief:publisher-upload-reservation:${current.issueId}:${current.idempotencyKey}`}, 0
              )
            )
          `;
          yield* sql`
            update publisher_document_upload_intents
            set state = 'retryable', lease_expires_at = clock_timestamp()
            where id = ${current.id}
              and attempt = ${current.attempt}
              and lease_token = ${current.leaseToken}
              and state = 'processing'
              and lease_expires_at > clock_timestamp()
          `;
        }),
      );
      return yield* Effect.fail(new WorkspaceRuleError("document_upload_failed"));
    }
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const fenced = yield* sql<{ readonly id: string }>`
          update publisher_document_upload_intents
          set state = 'object_put', lease_expires_at = clock_timestamp() + ${PUBLISHER_UPLOAD_RESERVATION_LEASE_INTERVAL}::interval
          where id = ${current.id}
            and attempt = ${current.attempt}
            and lease_token = ${current.leaseToken}
            and state = 'processing' and lease_expires_at > clock_timestamp()
          returning id::text
        `;
        if (fenced[0] === undefined)
          return yield* Effect.fail(new WorkspaceRuleError("document_upload_failed"));
        yield* sql`
        insert into publisher_document_upload_events (operation_id, attempt, event_kind)
          values (${current.id}, ${current.attempt}, 'object_put')
          on conflict (operation_id, attempt, event_kind) do nothing
        `;
      }),
    );
    const finalized = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
          select pg_advisory_xact_lock(
            hashtextextended(
              ${`brief:publisher-upload-reservation:${current.issueId}:${current.idempotencyKey}`}, 0
            )
          )
        `;
          // Finalization is fenced by the current database-clock lease and a
          // fresh object-store observation while this reservation lock is
          // held. Reconciliation uses the same lock, so it cannot delete the
          // object between the HEAD evidence and the terminal transition.
          const liveLease = yield* sql<{ readonly id: string }>`
            select id::text
            from publisher_document_upload_intents
            where id = ${current.id}
              and attempt = ${current.attempt}
              and lease_token = ${current.leaseToken}
              and state = 'object_put'
              and lease_expires_at > clock_timestamp()
            for update
          `;
          if (liveLease[0] === undefined) {
            return yield* Effect.fail(new WorkspaceRuleError("document_upload_failed"));
          }
          const finalHead = yield* head().pipe(
            Effect.match({ onFailure: () => null, onSuccess: (value) => value }),
          );
          if (!exact(finalHead)) {
            return yield* Effect.fail(new WorkspaceRuleError("document_upload_failed"));
          }
          const documents = yield* selectStoredDocument(current.documentId);
          if (documents[0] !== undefined) {
            const stored = documents[0];
            if (!exactStoredDocument(current, stored)) {
              return yield* Effect.fail(new WorkspaceRuleError("idempotency_conflict"));
            }
            const fenced = yield* sql<{ readonly id: string }>`
            update publisher_document_upload_intents
            set state = 'finalized', lease_expires_at = clock_timestamp()
            where id = ${current.id}
              and attempt = ${current.attempt}
              and lease_token = ${current.leaseToken}
              and state = 'object_put' and lease_expires_at > clock_timestamp()
            returning id::text
          `;
            if (fenced[0] === undefined)
              return yield* Effect.fail(new WorkspaceRuleError("document_upload_failed"));
            return publicDocumentRow(stored);
          }
          const issue = yield* selectIssueForUpdate(input.issueId);
          if (issue === null)
            return yield* Effect.fail(new WorkspaceAuthorizationError("not_found"));
          yield* requirePublisherSubscriptionAccess(
            input.identity,
            issue.subscriptionId,
            "content_manage",
          );
          if (issue.status === "published")
            return yield* Effect.fail(new WorkspaceRuleError("published_issue_immutable"));
          const rows = yield* sql<DocumentRow>`
          insert into brief_documents (
            id, issue_id, title, original_file_name, object_key, media_type,
            byte_size, sha256_hex, upload_completed_at, created_by_user_id
          ) values (
            ${current.documentId}, ${input.issueId}, ${title}, ${fileName}, ${current.objectKey},
            'application/pdf', ${input.body.byteLength}, ${actualHash}, now(), ${input.identity.userId}
          )
          returning id::text, issue_id::text as "issueId", title,
                    original_file_name as "originalFileName", media_type as "mediaType",
                    byte_size::float8 as "byteSize", sha256_hex as "sha256Hex", created_at as "createdAt"
        `;
          yield* sql`
          insert into jobs (kind, payload, unique_key, priority, max_attempts)
          values ('extract_pdf_text', ${sql.json({ documentId: current.documentId })}, ${`extract-pdf:${current.documentId}:${actualHash}`}, 20, 8)
          on conflict (unique_key) where unique_key is not null do nothing
        `;
          yield* (
            input.auditSucceeded?.(current.documentId) ??
              appendAuthorizationAudit({
                identity: input.identity,
                requestId: current.requestId,
                action: "publisher.document.upload",
                scopeKind: "brief_document",
                scopeId: current.documentId,
                outcome: "succeeded",
              })
          );
          yield* sql`
          insert into publisher_document_upload_events (operation_id, attempt, event_kind)
          values (${current.id}, ${current.attempt}, 'finalized')
          on conflict (operation_id, attempt, event_kind) do nothing
        `;
          const fenced = yield* sql<{ readonly id: string }>`
          update publisher_document_upload_intents
          set state = 'finalized', lease_expires_at = clock_timestamp()
          where id = ${current.id}
            and attempt = ${current.attempt}
            and lease_token = ${current.leaseToken}
            and state = 'object_put' and lease_expires_at > clock_timestamp()
          returning id::text
        `;
          if (fenced[0] === undefined)
            return yield* Effect.fail(new WorkspaceRuleError("document_upload_failed"));
          return rows[0]!;
        }),
      )
      .pipe(
        Effect.catch((error) =>
          sql
            .withTransaction(sql`
          update publisher_document_upload_intents
          set state = 'object_put', lease_expires_at = clock_timestamp()
          where id = ${current.id}
            and attempt = ${current.attempt}
            and lease_token = ${current.leaseToken}
            and state <> 'finalized'
        `)
            .pipe(Effect.ignore, Effect.andThen(Effect.fail(error))),
        ),
      );
    return documentDescriptor(finalized);
  });
  return withDeniedAudit(
    operation,
    input.identity,
    input.requestId,
    "publisher.document.upload",
    "publisher_issue",
    input.issueId,
  );
};

export const deletePublisherDocument = (input: {
  readonly identity: WorkspaceIdentity;
  readonly issueId: string;
  readonly documentId: string;
  readonly requestId: string;
  readonly auditSucceeded?: Effect.Effect<void, unknown, PgClient.PgClient>;
}) =>
  withDeniedAudit(
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const issue = yield* selectIssueForUpdate(input.issueId);
          if (issue === null) {
            return yield* Effect.fail(new WorkspaceAuthorizationError("not_found"));
          }
          yield* requirePublisherSubscriptionAccess(
            input.identity,
            issue.subscriptionId,
            "content_manage",
          );
          if (issue.status === "published") {
            return yield* Effect.fail(new WorkspaceRuleError("published_issue_immutable"));
          }
          const rows = yield* sql<{ id: string }>`
            update brief_documents
            set deleted_at = now(), deleted_by_user_id = ${input.identity.userId},
                purge_after = now() + interval '30 days', updated_at = now()
            where id = ${input.documentId} and issue_id = ${input.issueId} and deleted_at is null
            returning id::text
          `;
          if (rows[0] === undefined) {
            return yield* Effect.fail(new WorkspaceAuthorizationError("not_found"));
          }
          yield* sql`
            insert into jobs (kind, payload, unique_key, available_at, max_attempts)
            values (
              'purge_deleted_files', '{}'::jsonb, 'purge-deleted-files',
              now() + interval '30 days', 8
            )
            on conflict (unique_key) where unique_key is not null do nothing
          `;
          yield* (
            input.auditSucceeded ??
              appendAuthorizationAudit({
                identity: input.identity,
                requestId: input.requestId,
                action: "publisher.document.delete",
                scopeKind: "brief_document",
                scopeId: input.documentId,
                outcome: "succeeded",
              })
          );
        }),
      );
    }),
    input.identity,
    input.requestId,
    "publisher.document.delete",
    "brief_document",
    input.documentId,
  );

export const listPublisherClientAccesses = (identity: WorkspaceIdentity, subscriptionId: string) =>
  Effect.gen(function* () {
    yield* requirePublisherSubscriptionAccess(identity, subscriptionId, "client_read");
    const rows = yield* selectClientAccesses(subscriptionId);
    return rows.map(clientAccessDescriptor);
  });

export interface PublisherClientOnboardingProvider {
  readonly ensureOrganization: (input: {
    readonly companyId: string;
    readonly name: string;
    readonly creatorUserId: string;
  }) => Promise<string>;
  readonly createInvitation: (input: {
    readonly organizationId: string;
    readonly email: string;
    readonly inviterUserId: string;
    readonly redirectUrl: string;
    readonly workspaceInvitationId: string;
  }) => Promise<{ readonly externalId: string; readonly expiresAt: Date }>;
}

export const invitePublisherClientAccess = (input: {
  readonly identity: WorkspaceIdentity;
  readonly subscriptionId: string;
  readonly clientCompanyName: string;
  readonly firstAdminEmail: string;
  readonly idempotencyKey: string;
  readonly requestId: string;
  readonly provider: PublisherClientOnboardingProvider | null;
  readonly redirectUrl: string;
}) => {
  const operation = Effect.gen(function* () {
    const clientCompanyName = input.clientCompanyName.trim();
    const email = input.firstAdminEmail.trim().toLowerCase();
    if (
      clientCompanyName === "" ||
      clientCompanyName.length > 200 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) ||
      !/^[A-Za-z0-9._:-]{16,200}$/u.test(input.idempotencyKey)
    ) {
      return yield* Effect.fail(new WorkspaceRuleError("invalid_body"));
    }
    const sql = yield* PgClient.PgClient;
    const prepared = yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* requirePublisherSubscriptionAccess(
          input.identity,
          input.subscriptionId,
          "client_manage",
        );
        yield* sql`
          select pg_advisory_xact_lock(
            hashtext(${`brief:publisher-client-access:${input.subscriptionId}:${input.idempotencyKey}`})
          )
        `;
        yield* sql`
          update workspace_invitations invitation
          set state = 'expired', updated_at = now()
          from client_subscription_accesses access
          where access.subscription_id = ${input.subscriptionId}
            and access.idempotency_key = ${input.idempotencyKey}
            and invitation.client_company_id = access.client_company_id
            and access.id = any(invitation.client_subscription_access_ids)
            and invitation.state = 'pending' and invitation.expires_at <= now()
        `;
        const prior = yield* sql<{
          accessId: string;
          companyId: string;
          organizationId: string | null;
          invitationId: string | null;
          invitationState: string | null;
          invitationExternalId: string | null;
          invitationExpiresAt: Date | null;
          deliveryLeaseToken: string | null;
          deliveryLeaseExpiresAt: Date | null;
          clientCompanyName: string;
          firstAdminEmail: string;
        }>`
          select access.id::text as "accessId", access.client_company_id::text as "companyId",
                 company.clerk_organization_id as "organizationId",
                 invitation.id::text as "invitationId", invitation.state as "invitationState",
                 invitation.clerk_invitation_id as "invitationExternalId",
                 invitation.expires_at as "invitationExpiresAt",
                 invitation.delivery_lease_token::text as "deliveryLeaseToken",
                 invitation.delivery_lease_expires_at as "deliveryLeaseExpiresAt",
                 company.name as "clientCompanyName",
                 access.first_admin_email as "firstAdminEmail"
          from client_subscription_accesses access
          join client_companies company on company.id = access.client_company_id
          left join workspace_invitations invitation
            on invitation.client_company_id = access.client_company_id
           and invitation.normalized_email = access.first_admin_email
           and access.id = any(invitation.client_subscription_access_ids)
          where access.subscription_id = ${input.subscriptionId}
            and access.idempotency_key = ${input.idempotencyKey}
          order by invitation.created_at desc nulls last limit 1
          for update of access
        `;
        if (prior[0] !== undefined) {
          if (
            prior[0].clientCompanyName !== clientCompanyName ||
            prior[0].firstAdminEmail !== email
          ) {
            return yield* Effect.fail(new WorkspaceRuleError("idempotency_conflict"));
          }
          const existing = prior[0];
          if (existing.invitationState === "pending" || existing.invitationState === "accepted") {
            return { ...existing, deliver: false, inProgress: false, duplicate: true };
          }
          if (existing.invitationState === "creating" && existing.invitationId !== null) {
            if (
              existing.deliveryLeaseToken !== null &&
              existing.deliveryLeaseExpiresAt !== null &&
              existing.deliveryLeaseExpiresAt > new Date()
            ) {
              return { ...existing, deliver: false, inProgress: true, duplicate: true };
            }
            const claimed = yield* sql<{ deliveryLeaseToken: string }>`
              update workspace_invitations
              set delivery_lease_token = gen_random_uuid(),
                  delivery_lease_expires_at = now() + ${INVITATION_DELIVERY_LEASE_INTERVAL}::interval,
                  delivery_attempt_count = delivery_attempt_count + 1,
                  delivery_last_attempt_at = now(), delivery_last_error_code = null,
                  updated_at = now()
              where id = ${existing.invitationId} and state = 'creating'
                and (delivery_lease_expires_at is null or delivery_lease_expires_at <= now())
              returning delivery_lease_token::text as "deliveryLeaseToken"
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
          const invitation = yield* sql<{ id: string; deliveryLeaseToken: string }>`
            insert into workspace_invitations (
              workspace_kind, client_company_id, normalized_email, role,
              client_subscription_access_ids, invited_by_user_id, delivery_attempt_count,
              delivery_lease_token, delivery_lease_expires_at, delivery_last_attempt_at
            ) values (
              'client', ${existing.companyId}, ${email}, 'admin', ${[existing.accessId]}::uuid[],
              ${input.identity.userId}, 1, gen_random_uuid(),
              now() + ${INVITATION_DELIVERY_LEASE_INTERVAL}::interval, now()
            ) returning id::text, delivery_lease_token::text as "deliveryLeaseToken"
          `;
          return {
            ...existing,
            invitationId: invitation[0]!.id,
            invitationState: "creating",
            invitationExternalId: null,
            invitationExpiresAt: null,
            deliveryLeaseToken: invitation[0]!.deliveryLeaseToken,
            deliver: true,
            inProgress: false,
            duplicate: true,
          };
        }
        const matches = yield* sql<{ companyId: string; organizationId: string | null }>`
          select company.id::text as "companyId",
                 company.clerk_organization_id as "organizationId"
          from platform_users users
          join client_company_memberships membership
            on membership.user_id = users.id and membership.role = 'admin'
           and membership.revoked_at is null
          join client_companies company on company.id = membership.company_id
          where lower(users.primary_email) = ${email}
            and users.recovery_deleted_at is null and users.purged_at is null
            and company.recovery_deleted_at is null
          order by company.id limit 2
        `;
        if (matches.length > 1) {
          return yield* Effect.fail(new WorkspaceRuleError("client_company_ambiguous"));
        }
        let companyId = matches[0]?.companyId;
        const organizationId = matches[0]?.organizationId ?? null;
        if (companyId === undefined) {
          const insertedCompany = yield* sql<{ id: string }>`
            insert into client_companies (name)
            values (${clientCompanyName}) returning id::text
          `;
          companyId = insertedCompany[0]!.id;
          yield* sql`insert into client_company_ai_settings (company_id) values (${companyId})`;
        }
        const duplicateCompany = yield* sql<{ exists: boolean }>`
          select exists(
            select 1 from client_subscription_accesses
            where subscription_id = ${input.subscriptionId} and client_company_id = ${companyId}
          ) as exists
        `;
        if (duplicateCompany[0]?.exists === true) {
          return yield* Effect.fail(new WorkspaceRuleError("client_access_exists"));
        }
        const access = yield* sql<{ id: string }>`
          insert into client_subscription_accesses (
            subscription_id, client_company_id, state, first_admin_email,
            created_by_user_id, idempotency_key
          ) values (
            ${input.subscriptionId}, ${companyId}, 'invited', ${email},
            ${input.identity.userId}, ${input.idempotencyKey}
          ) returning id::text
        `;
        const invitation = yield* sql<{ id: string; deliveryLeaseToken: string }>`
          insert into workspace_invitations (
            workspace_kind, client_company_id, normalized_email, role,
            client_subscription_access_ids, invited_by_user_id, delivery_attempt_count,
            delivery_lease_token, delivery_lease_expires_at, delivery_last_attempt_at
          ) values (
            'client', ${companyId}, ${email}, 'admin', ${[access[0]!.id]}::uuid[],
            ${input.identity.userId}, 1, gen_random_uuid(),
            now() + ${INVITATION_DELIVERY_LEASE_INTERVAL}::interval, now()
          ) returning id::text, delivery_lease_token::text as "deliveryLeaseToken"
        `;
        return {
          accessId: access[0]!.id,
          companyId,
          organizationId,
          invitationId: invitation[0]!.id,
          invitationState: "creating",
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
        action: "publisher.client_access.invite",
        scopeKind: "publisher_subscription",
        scopeId: input.subscriptionId,
        outcome: "succeeded",
      });
    } else {
      const invitationId = prepared.invitationId;
      const leaseToken = prepared.deliveryLeaseToken;
      if (invitationId === null || leaseToken === null) {
        return yield* Effect.fail(new WorkspaceRuleError("invite_conflict"));
      }
      if (input.provider === null || input.redirectUrl === "") {
        yield* releaseInvitationDelivery(
          invitationId,
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
                name: clientCompanyName,
                creatorUserId: input.identity.userId,
              })
            : Promise.resolve(prepared.organizationId),
        catch: () => new WorkspaceRuleError("invitation_delivery_failed"),
      }).pipe(
        Effect.catch((error) =>
          releaseInvitationDelivery(invitationId, leaseToken, "organization_delivery_failed").pipe(
            Effect.andThen(Effect.fail(error)),
          ),
        ),
      );
      if (organizationId.trim() === "") {
        yield* releaseInvitationDelivery(invitationId, leaseToken, "organization_identity_invalid");
        return yield* Effect.fail(new WorkspaceRuleError("invitation_delivery_failed"));
      }
      const organizationPersisted = yield* sql<{ organizationId: string }>`
        update client_companies
        set clerk_organization_id = ${organizationId}, updated_at = now()
        where id = ${prepared.companyId}
          and recovery_deleted_at is null and purged_at is null
          and (clerk_organization_id is null or clerk_organization_id = ${organizationId})
        returning clerk_organization_id as "organizationId"
      `;
      if (organizationPersisted[0]?.organizationId !== organizationId) {
        yield* releaseInvitationDelivery(
          invitationId,
          leaseToken,
          "organization_identity_conflict",
        );
        return yield* Effect.fail(new WorkspaceRuleError("invitation_delivery_failed"));
      }
      const delivery = yield* Effect.tryPromise({
        try: () =>
          input.provider!.createInvitation({
            organizationId,
            email,
            inviterUserId: input.identity.userId,
            redirectUrl: input.redirectUrl,
            workspaceInvitationId: invitationId,
          }),
        catch: () => new WorkspaceRuleError("invitation_delivery_failed"),
      }).pipe(
        Effect.catch((error) =>
          releaseInvitationDelivery(invitationId, leaseToken, "invitation_delivery_failed").pipe(
            Effect.andThen(Effect.fail(error)),
          ),
        ),
      );
      if (!validInvitationDelivery(delivery)) {
        yield* releaseInvitationDelivery(invitationId, leaseToken, "invitation_delivery_invalid");
        return yield* Effect.fail(new WorkspaceRuleError("invitation_delivery_failed"));
      }
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const finalized = yield* sql<{ state: string }>`
            update workspace_invitations
            set state = 'pending', clerk_invitation_id = ${delivery.externalId},
                expires_at = ${delivery.expiresAt}, delivery_lease_token = null,
                delivery_lease_expires_at = null, delivery_last_error_code = null,
                updated_at = now()
            where id = ${invitationId} and state = 'creating'
              and delivery_lease_token = ${leaseToken}
            returning state
          `;
          if (finalized[0] === undefined) {
            const reconciled = yield* sql<{
              state: string;
              externalId: string | null;
              expiresAt: Date | null;
            }>`
              select state, clerk_invitation_id as "externalId", expires_at as "expiresAt"
              from workspace_invitations where id = ${invitationId} for update
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
            action: "publisher.client_access.invite",
            scopeKind: "publisher_subscription",
            scopeId: input.subscriptionId,
            outcome: "succeeded",
          });
        }),
      );
    }
    const access = yield* selectClientAccesses(input.subscriptionId, prepared.accessId);
    return { access: clientAccessDescriptor(access[0]!), duplicate: prepared.duplicate };
  });
  return withDeniedAudit(
    operation,
    input.identity,
    input.requestId,
    "publisher.client_access.invite",
    "publisher_subscription",
    input.subscriptionId,
  );
};

export const pausePublisherClientAccess = (input: {
  readonly identity: WorkspaceIdentity;
  readonly accessId: string;
  readonly deliveryEndAt: string | null;
  readonly requestId: string;
}) =>
  withDeniedAudit(
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{
            subscriptionId: string;
            clientCompanyId: string;
            state: string;
          }>`
            select subscription_id::text as "subscriptionId",
                   client_company_id::text as "clientCompanyId", state
            from client_subscription_accesses where id = ${input.accessId} for update
          `;
          const access = rows[0];
          if (access === undefined) {
            return yield* Effect.fail(new WorkspaceAuthorizationError("not_found"));
          }
          yield* requirePublisherSubscriptionAccess(
            input.identity,
            access.subscriptionId,
            "client_manage",
          );
          if (access.state !== "active") {
            return yield* Effect.fail(new WorkspaceRuleError("client_access_not_active"));
          }
          let deliveryEndAt: Date;
          let currentPeriodStart: Date | null = null;
          if (input.deliveryEndAt === null) {
            const periods = yield* sql<{
              readonly periodStart: Date | null;
              readonly periodEnd: Date | null;
            }>`
              select current_period_start as "periodStart", current_period_end as "periodEnd"
              from client_ai_billing_accounts
              where client_company_id = ${access.clientCompanyId}
              for update
            `;
            const period = periods[0];
            if (period === undefined || period.periodStart === null || period.periodEnd === null) {
              return yield* Effect.fail(new WorkspaceRuleError("delivery_end_invalid"));
            }
            currentPeriodStart = period.periodStart;
            deliveryEndAt = period.periodEnd;
          } else {
            deliveryEndAt = new Date(input.deliveryEndAt);
            if (
              Number.isNaN(deliveryEndAt.getTime()) ||
              deliveryEndAt.toISOString() !== input.deliveryEndAt
            ) {
              return yield* Effect.fail(new WorkspaceRuleError("delivery_end_invalid"));
            }
          }
          const clock = yield* sql<{ readonly databaseNow: Date }>`
            select clock_timestamp() as "databaseNow"
          `;
          const databaseNow = clock[0]!.databaseNow;
          if (
            deliveryEndAt <= databaseNow ||
            (currentPeriodStart !== null && currentPeriodStart > databaseNow)
          ) {
            return yield* Effect.fail(new WorkspaceRuleError("delivery_end_invalid"));
          }
          yield* sql`
            update client_subscription_accesses
            set state = 'ending', delivery_end_at = ${deliveryEndAt}, updated_at = now()
            where id = ${input.accessId}
          `;
          yield* sql`
            insert into jobs (kind, payload, unique_key, available_at, priority, max_attempts)
            values (
              'finalize_subscription_pause', ${sql.json({ accessId: input.accessId })},
              ${`finalize-subscription-pause:${input.accessId}`}, ${deliveryEndAt}, 30, 8
            )
            on conflict (unique_key) where unique_key is not null do update set
              available_at = excluded.available_at, payload = excluded.payload,
              status = case when jobs.status in ('completed', 'failed') then 'queued' else jobs.status end,
              attempts = case when jobs.status in ('completed', 'failed') then 0 else jobs.attempts end,
              updated_at = now()
          `;
          for (const reminder of [
            { kind: "delivery_end_scheduled", at: databaseNow },
            {
              kind: "delivery_ends_in_7_days",
              at: new Date(deliveryEndAt.getTime() - 7 * 86_400_000),
            },
          ] as const) {
            if (reminder.at <= databaseNow && reminder.kind !== "delivery_end_scheduled") continue;
            yield* sql`
              insert into jobs (kind, payload, unique_key, available_at, priority, max_attempts)
              select 'send_platform_notification',
                     jsonb_build_object(
                       'clientCompanyId', ${access.clientCompanyId}::text,
                       'userId', grants.user_id,
                       'kind', ${reminder.kind}::text,
                       'deduplicationKey', ${`${reminder.kind}:${input.accessId}:`}::text || grants.user_id,
                       'accessId', ${input.accessId}::text
                     ),
                     ${`send_platform_notification:${reminder.kind}:${input.accessId}:`}::text || grants.user_id,
                     ${reminder.at}, 20, 8
              from client_employee_subscription_grants grants
              where grants.access_id = ${input.accessId} and grants.revoked_at is null
              on conflict (unique_key) where unique_key is not null do nothing
            `;
          }
          yield* appendAuthorizationAudit({
            identity: input.identity,
            requestId: input.requestId,
            action: "publisher.client_access.pause",
            scopeKind: "client_subscription_access",
            scopeId: input.accessId,
            outcome: "succeeded",
          });
          return deliveryEndAt.toISOString();
        }),
      );
    }),
    input.identity,
    input.requestId,
    "publisher.client_access.pause",
    "client_subscription_access",
    input.accessId,
  );

export const getPublisherAiPullMetrics = (identity: WorkspaceIdentity, subscriptionId: string) =>
  Effect.gen(function* () {
    yield* requirePublisherSubscriptionAccess(identity, subscriptionId, "analytics");
    const sql = yield* PgClient.PgClient;
    const metrics = yield* sql<PublisherAiPullMetric>`
      select exposures.publisher_issue_id as "issueId",
             exposures.publisher_document_id as "documentId",
             count(distinct exposures.run_id)::int as "runPullCount",
             coalesce(sum(exposures.visible_token_count), 0)::int as "visibleTokenCount"
      from ai_source_exposures exposures
      join publisher_issues issue on issue.id::text = exposures.publisher_issue_id
      where issue.subscription_id = ${subscriptionId} and issue.deleted_at is null
        and exposures.source_kind = 'document'
        and exposures.publisher_issue_id is not null
      group by exposures.publisher_issue_id, exposures.publisher_document_id
      order by exposures.publisher_issue_id, exposures.publisher_document_id nulls first
    `;
    const issueTotals = yield* sql<PublisherAiPullIssueMetric>`
      select exposures.publisher_issue_id as "issueId",
             count(distinct exposures.run_id)::int as "runPullCount"
      from ai_source_exposures exposures
      join publisher_issues issue on issue.id::text = exposures.publisher_issue_id
      where issue.subscription_id = ${subscriptionId} and issue.deleted_at is null
        and exposures.source_kind = 'document'
        and exposures.publisher_issue_id is not null
      group by exposures.publisher_issue_id
      order by exposures.publisher_issue_id
    `;
    return { metrics, issueTotals };
  });
