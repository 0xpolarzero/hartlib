import { PgClient } from "@effect/sql-pg";
import { Effect } from "effect";
import { loadDatabaseUrl, loadPlatformJobConfig } from "@brief/config";

import { runAiProductState } from "../ai/product-state/database";
import type { JobRecord, JobResult } from "../jobs/types";
import { ExportObjectStoreService, NotificationEmailService } from "./adapters";
import { expireMonthlyCreditLots, processStripeWebhookEvent } from "./billing";
import { failExportRequest, generateExport, purgeExpiredExportObjects } from "./exports";
import { PlatformFileStore } from "./file-store";
import {
  createPlatformNotification,
  sendEmailNotification,
  type CreatePlatformNotificationInput,
  type PlatformNotificationKind,
} from "./notifications";
import { PdfTextExtractor, type ExtractedPdfPage } from "./pdf-text";

const PLATFORM_PURGE_BATCH_SIZE = 500;
export const PUBLISHER_UPLOAD_RECONCILE_DELETE_TIMEOUT_MS = 20_000;
/** Every normal publisher-file purge gets the same code-owned cancellation boundary. */
export const PLATFORM_FILE_PURGE_DELETE_TIMEOUT_MS = 20_000;

interface PlatformPurgeCandidateBudget {
  remaining: number;
}

const makePlatformPurgeCandidateBudget = (): PlatformPurgeCandidateBudget => ({
  remaining: PLATFORM_PURGE_BATCH_SIZE,
});

const consumePlatformPurgeCandidates = (
  budget: PlatformPurgeCandidateBudget,
  count: number,
): void => {
  if (!Number.isSafeInteger(count) || count < 0 || count > budget.remaining) {
    throw new Error("platform_purge_candidate_budget_exceeded");
  }
  budget.remaining -= count;
};

const normalizedLegalHoldScopeKeys = (scopeKeys: readonly string[]): readonly string[] =>
  [...new Set(scopeKeys.filter((scopeKey) => scopeKey.trim() !== ""))].sort();

const sameLegalHoldScopeKeys = (left: readonly string[], right: readonly string[]): boolean => {
  const normalizedLeft = normalizedLegalHoldScopeKeys(left);
  const normalizedRight = normalizedLegalHoldScopeKeys(right);
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((scopeKey, index) => scopeKey === normalizedRight[index])
  );
};

const sameOrderedIds = (
  left: readonly { readonly id: string }[],
  right: readonly { readonly id: string }[],
): boolean =>
  left.length === right.length && left.every((row, index) => row.id === right[index]?.id);

type MembershipLaneKey = `client:${string}` | `publisher:${string}`;

interface AccountRetentionChatScope {
  readonly id: string;
  readonly companyId: string;
  readonly userId: string;
}

const accountRetentionChatScopeKeys = (
  parentScopeKey: string,
  chats: readonly AccountRetentionChatScope[],
): readonly string[] =>
  normalizedLegalHoldScopeKeys([
    parentScopeKey,
    ...chats.map((chat) => `chat:${chat.id}`),
    ...chats.map((chat) => `client_company:${chat.companyId}`),
    ...chats.map((chat) => `user:${chat.userId}`),
  ]);

const lockMembershipLanes = (laneKeys: readonly MembershipLaneKey[]) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    // This is the global membership-lane comparator used by mixed-scope
    // readers: sort the complete typed key, not each company kind separately.
    for (const laneKey of [...new Set(laneKeys)].sort()) {
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

const lockLegalHoldScopes = (scopeKeys: readonly string[]) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    for (const scopeKey of normalizedLegalHoldScopeKeys(scopeKeys)) {
      yield* sql`
        select pg_advisory_xact_lock(
          hashtextextended(${`brief:legal-hold:${scopeKey}`}, 0)
        )
      `;
    }
  });

const chatMemoryProvenanceUsers = (chatId: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql<{ readonly id: string }>`
      select affected.user_id as id
      from (
        select memories.user_id
        from user_memories memories
        join chat_messages messages on messages.id = memories.source_message_id
        where messages.chat_id = ${chatId}

        union

        select memories.user_id
        from user_memories memories
        join user_memory_revisions revisions on revisions.memory_id = memories.id
        join ai_runs runs on runs.id = revisions.run_id
        where runs.chat_id = ${chatId}
      ) affected
      order by affected.user_id
    `;
  });

const lockUserMemoryLanes = (users: readonly { readonly id: string }[]) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    for (const userId of [...new Set(users.map((user) => user.id))].sort()) {
      yield* sql`
        select pg_advisory_xact_lock(hashtext(${`brief:user-memory:${userId}`}))
      `;
    }
  });

const lockEmbeddedLegalHoldRows = (scopeKeys: readonly string[]) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const normalized = normalizedLegalHoldScopeKeys(scopeKeys);
    yield* sql`
      select users.id from platform_users users
      where ('user:' || users.id) = any(${normalized})
      order by users.id for share
    `;
    yield* sql`
      select companies.id from client_companies companies
      where ('client_company:' || companies.id::text) = any(${normalized})
      order by companies.id for share
    `;
    yield* sql`
      select chats.id from chats
      where ('chat:' || chats.id::text) = any(${normalized})
      order by chats.id for share
    `;
    yield* sql`
      select documents.id from brief_documents documents
      where ('issue:' || documents.issue_id::text) = any(${normalized})
      order by documents.id for share
    `;
  });

const hasLegalHoldForScopes = (scopeKeys: readonly string[]) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<{ readonly held: boolean }>`
      select brief_has_active_legal_hold(${normalizedLegalHoldScopeKeys(scopeKeys)})
        or brief_has_embedded_legal_hold(${normalizedLegalHoldScopeKeys(scopeKeys)}) as held
    `;
    return rows[0]?.held !== false;
  });

type PlatformJobKind =
  | "publish_scheduled_issue"
  | "extract_pdf_text"
  | "normalize_searchable_text"
  | "update_ai_indexing_status"
  | "import_historical_issues"
  | "send_platform_notification"
  | "send_email_notification"
  | "process_stripe_webhook"
  | "sync_billing_credit_state"
  | "reset_monthly_credit_counters"
  | "generate_export"
  | "purge_expired_exports"
  | "purge_deleted_chats"
  | "purge_deleted_files"
  | "reconcile_publisher_uploads"
  | "purge_operational_audit_retention"
  | "purge_deleted_accounts"
  | "finalize_subscription_pause";

const platformJobKinds = new Set<PlatformJobKind>([
  "publish_scheduled_issue",
  "extract_pdf_text",
  "normalize_searchable_text",
  "update_ai_indexing_status",
  "import_historical_issues",
  "send_platform_notification",
  "send_email_notification",
  "process_stripe_webhook",
  "sync_billing_credit_state",
  "reset_monthly_credit_counters",
  "generate_export",
  "purge_expired_exports",
  "purge_deleted_chats",
  "purge_deleted_files",
  "reconcile_publisher_uploads",
  "purge_operational_audit_retention",
  "purge_deleted_accounts",
  "finalize_subscription_pause",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseIdPayload = (payload: unknown, field: string, kind: string): string => {
  if (
    !isRecord(payload) ||
    Object.keys(payload).length !== 1 ||
    typeof payload[field] !== "string"
  ) {
    throw new Error(`${kind} payload must be exactly { ${field}: string }`);
  }
  const value = payload[field].trim();
  if (value === "") throw new Error(`${kind} payload has an empty ${field}`);
  return value;
};

const parseEmptyPayload = (payload: unknown, kind: string): void => {
  if (payload === null || payload === undefined) return;
  if (!isRecord(payload) || Object.keys(payload).length !== 0) {
    throw new Error(`${kind} payload must be an empty object`);
  }
};

const notificationKinds = new Set<PlatformNotificationKind>([
  "issue_published",
  "delivery_end_scheduled",
  "delivery_ends_in_7_days",
  "delivery_ended",
  "usage_approaching_limit",
  "usage_limit_reached",
]);

const parseNotificationPayload = (payload: unknown): CreatePlatformNotificationInput => {
  if (!isRecord(payload)) {
    throw new Error("send_platform_notification payload must be an object");
  }
  const allowed = new Set([
    "clientCompanyId",
    "userId",
    "kind",
    "deduplicationKey",
    "issueId",
    "accessId",
    "billingEventId",
  ]);
  if (Object.keys(payload).some((key) => !allowed.has(key))) {
    throw new Error("send_platform_notification payload has unknown fields");
  }
  const required = ["clientCompanyId", "userId", "deduplicationKey"] as const;
  if (required.some((key) => typeof payload[key] !== "string" || payload[key].trim() === "")) {
    throw new Error("send_platform_notification payload has invalid required fields");
  }
  if (
    typeof payload.kind !== "string" ||
    !notificationKinds.has(payload.kind as PlatformNotificationKind)
  ) {
    throw new Error("send_platform_notification payload has invalid kind");
  }
  for (const key of ["issueId", "accessId", "billingEventId"] as const) {
    if (key in payload && (typeof payload[key] !== "string" || payload[key].trim() === "")) {
      throw new Error(`send_platform_notification payload has invalid ${key}`);
    }
  }
  return {
    clientCompanyId: payload.clientCompanyId as string,
    userId: payload.userId as string,
    kind: payload.kind as PlatformNotificationKind,
    deduplicationKey: payload.deduplicationKey as string,
    ...(typeof payload.issueId === "string" ? { issueId: payload.issueId } : {}),
    ...(typeof payload.accessId === "string" ? { accessId: payload.accessId } : {}),
    ...(typeof payload.billingEventId === "string"
      ? { billingEventId: payload.billingEventId }
      : {}),
  };
};

type StaleNotificationAuthorizationCode =
  | "notification_recipient_not_authorized"
  | "issue_notification_not_delivered_to_recipient"
  | "notification_access_not_authorized";

class StaleNotificationAuthorizationError extends Error {
  readonly _tag = "StaleNotificationAuthorizationError";

  constructor(readonly reasonCode: StaleNotificationAuthorizationCode) {
    super(reasonCode);
  }
}

const staleNotificationAuthorizationCode = (
  error: unknown,
): StaleNotificationAuthorizationCode | null => {
  if (!(error instanceof Error)) return null;
  switch (error.message) {
    case "notification_recipient_not_authorized":
    case "issue_notification_not_delivered_to_recipient":
    case "notification_access_not_authorized":
      return error.message;
    default:
      return null;
  }
};

const createPlatformNotificationForJob = (input: CreatePlatformNotificationInput) =>
  createPlatformNotification(input).pipe(
    Effect.map((result) => ({ _tag: "created" as const, result })),
    Effect.catchIf(
      (error): error is Error => staleNotificationAuthorizationCode(error) !== null,
      (error) =>
        Effect.succeed({
          _tag: "stale" as const,
          error: new StaleNotificationAuthorizationError(
            staleNotificationAuthorizationCode(error)!,
          ),
        }),
    ),
  );

const connectionString = loadDatabaseUrl;

const runDb = <A, E>(url: string, effect: Effect.Effect<A, E, PgClient.PgClient>) =>
  Effect.tryPromise({
    try: () => runAiProductState(url, effect),
    catch: (error) => error,
  });

const sha256Hex = (bytes: Uint8Array): Effect.Effect<string> =>
  Effect.promise(async () => {
    const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  });

const sha256Text = (value: string): Effect.Effect<string> =>
  sha256Hex(new TextEncoder().encode(value));

export const normalizeSearchablePageText = (value: string): string =>
  value
    .normalize("NFKC")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n")
    .map((line) => line.replace(/[\t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

interface CanonicalDocumentText {
  readonly text: string;
  readonly pageRanges: ReadonlyArray<{
    readonly pageNumber: number;
    readonly charStart: number;
    readonly charEnd: number;
  }>;
}

export const canonicalizeExtractedPages = (
  pages: readonly ExtractedPdfPage[],
): CanonicalDocumentText => {
  const pageNumbers = new Set<number>();
  for (const page of pages) {
    if (!Number.isSafeInteger(page.pageNumber) || page.pageNumber <= 0) {
      throw new Error("extracted PDF page numbers must be positive integers");
    }
    if (pageNumbers.has(page.pageNumber)) {
      throw new Error(`duplicate extracted PDF page number: ${page.pageNumber}`);
    }
    pageNumbers.add(page.pageNumber);
  }
  const normalized = pages
    .map((page) => ({ pageNumber: page.pageNumber, text: normalizeSearchablePageText(page.text) }))
    .filter((page) => page.text !== "")
    .sort((left, right) => left.pageNumber - right.pageNumber);
  const parts: string[] = [];
  const pageRanges: CanonicalDocumentText["pageRanges"][number][] = [];
  let offset = 0;
  for (const page of normalized) {
    if (parts.length > 0) {
      parts.push("\n\n");
      offset += 2;
    }
    const charStart = offset;
    parts.push(page.text);
    offset += page.text.length;
    pageRanges.push({ pageNumber: page.pageNumber, charStart, charEnd: offset });
  }
  return { text: parts.join(""), pageRanges };
};

interface IssueRow {
  readonly id: string;
  readonly subscriptionId: string;
  readonly status: "draft" | "scheduled" | "published";
  readonly historical: boolean;
  readonly publicationAt: Date | null;
  readonly due: boolean;
  readonly publisherEnabled: boolean;
  readonly subscriptionEnabled: boolean;
  readonly deletedAt: Date | null;
}

interface CountRow {
  readonly count: number;
}

const enqueueDocumentPipeline = (issueId: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    yield* sql`
      insert into jobs (kind, payload, unique_key, priority)
      select
        'extract_pdf_text',
        jsonb_build_object('documentId', documents.id::text),
        'extract_pdf_text:' || documents.id::text || ':' || documents.sha256_hex,
        50
      from brief_documents documents
      where documents.issue_id = ${issueId}
        and documents.deleted_at is null
        and not exists (
          select 1
          from brief_document_extractions extractions
          where extractions.brief_document_id = documents.id
            and extractions.input_sha256_hex = documents.sha256_hex
        )
      on conflict (unique_key) where unique_key is not null do nothing
    `;
    yield* sql`
      insert into jobs (kind, payload, unique_key, priority)
      values (
        'update_ai_indexing_status',
        jsonb_build_object('issueId', ${issueId}::text),
        ${`update_ai_indexing_status:${issueId}`},
        40
      )
      on conflict (unique_key) where unique_key is not null do update
      set payload = excluded.payload,
          status = case when jobs.status in ('completed', 'failed') then 'queued' else jobs.status end,
          attempts = case when jobs.status in ('completed', 'failed') then 0 else jobs.attempts end,
          completed_at = case when jobs.status in ('completed', 'failed') then null else jobs.completed_at end,
          last_error = case when jobs.status in ('completed', 'failed') then null else jobs.last_error end,
          available_at = case when jobs.status in ('completed', 'failed') then now() else jobs.available_at end,
          updated_at = now()
    `;
  });

const publishIssue = (
  issueId: string,
  jobId: string,
  historical: boolean,
): Effect.Effect<
  { readonly delivered: number; readonly alreadyPublished: boolean; readonly cancelled: boolean },
  unknown,
  PgClient.PgClient
> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const rows = yield* sql<IssueRow>`
          select
            issues.id::text,
            issues.subscription_id::text as "subscriptionId",
            issues.status,
            issues.historical,
            issues.publication_at as "publicationAt",
            (issues.publication_at is null or issues.publication_at <= now()) as due,
            publishers.delivery_enabled as "publisherEnabled",
            subscriptions.delivery_enabled as "subscriptionEnabled"
            , issues.deleted_at as "deletedAt"
          from publisher_issues issues
          join publisher_subscriptions subscriptions on subscriptions.id = issues.subscription_id
          join publisher_companies publishers on publishers.id = subscriptions.publisher_company_id
          where issues.id = ${issueId}
          for update of issues
        `;
        const issue = rows[0];
        if (issue === undefined)
          return yield* Effect.fail(new Error(`issue not found: ${issueId}`));
        if (issue.deletedAt !== null) {
          return { delivered: 0, alreadyPublished: false, cancelled: true };
        }
        if (issue.status === "published") {
          if (issue.historical !== historical) {
            return yield* Effect.fail(new Error("published issue mode does not match job kind"));
          }
          const [count] = yield* sql<CountRow>`
            select count(*)::int as count from issue_deliveries where issue_id = ${issueId}
          `;
          return { delivered: count?.count ?? 0, alreadyPublished: true, cancelled: false };
        }
        if (historical) {
          if (!issue.due) {
            return yield* Effect.fail(
              new Error("historical issue publication time must be in the past"),
            );
          }
        } else {
          if (issue.status !== "scheduled" || issue.publicationAt === null) {
            return yield* Effect.fail(
              new Error("scheduled publication requires a scheduled issue"),
            );
          }
          if (!issue.due) {
            return yield* Effect.fail(new Error("scheduled issue is not due yet"));
          }
        }

        // Delivery snapshots must linearize with client membership and grant
        // changes. Discover every company attached to this subscription and
        // hold its lane before inserting the delivery or reading recipients;
        // otherwise a revoke can commit between those two statements and
        // erase a user who was entitled at delivered_at.
        const deliveryCompanies = yield* sql<{ readonly id: string }>`
          select distinct client_company_id::text as id
          from client_subscription_accesses
          where subscription_id = ${issue.subscriptionId}
          order by client_company_id::text
        `;
        yield* lockMembershipLanes(
          deliveryCompanies.map(({ id }) => `client:${id}` as MembershipLaneKey),
        );

        if (historical) {
          yield* sql`
            update publisher_issues
            set historical = true,
                publication_at = coalesce(publication_at, now()),
                status = 'published',
                updated_at = now()
            where id = ${issueId}
          `;
        } else {
          yield* sql`
            update publisher_issues
            set status = 'published', updated_at = now()
            where id = ${issueId}
          `;
        }

        const deliveries =
          issue.publisherEnabled && issue.subscriptionEnabled
            ? yield* sql<{
                readonly id: string;
                readonly accessId: string;
                readonly clientCompanyId: string;
              }>`
                insert into issue_deliveries (
                  issue_id,
                  subscription_id,
                  access_id,
                  client_company_id,
                  historical,
                  created_by_job_id
                )
                select
                  ${issueId},
                  ${issue.subscriptionId},
                  accesses.id,
                  accesses.client_company_id,
                  ${historical},
                  ${jobId}
                from client_subscription_accesses accesses
                where accesses.subscription_id = ${issue.subscriptionId}
                  and (
                    accesses.state = 'active'
                    or (
                      accesses.state = 'ending'
                      and accesses.delivery_end_at > now()
                    )
                  )
                on conflict (issue_id, client_company_id) do nothing
                returning
                  id::text,
                  access_id::text as "accessId",
                  client_company_id::text as "clientCompanyId"
              `
            : [];

        // Freeze the user recipients at delivery time. Later grant, source,
        // or subscription changes must not revoke a delivered publication.
        for (const delivery of deliveries) {
          yield* sql`
            insert into issue_delivery_recipients (
              issue_id, client_company_id, user_id, delivered_at
            )
            select
              ${issueId}::uuid,
              ${delivery.clientCompanyId}::uuid,
              grants.user_id,
              deliveries.delivered_at
            from issue_deliveries deliveries
            join client_employee_subscription_grants grants
              on grants.access_id = deliveries.access_id
             and grants.client_company_id = deliveries.client_company_id
             and grants.granted_at <= deliveries.delivered_at
             and (grants.revoked_at is null or grants.revoked_at > deliveries.delivered_at)
            join client_company_memberships memberships
              on memberships.company_id = deliveries.client_company_id
             and memberships.user_id = grants.user_id
             and memberships.created_at <= deliveries.delivered_at
             and (memberships.revoked_at is null or memberships.revoked_at > deliveries.delivered_at)
            where deliveries.issue_id = ${issueId}::uuid
              and deliveries.client_company_id = ${delivery.clientCompanyId}::uuid
            on conflict (issue_id, client_company_id, user_id) do nothing
          `;
        }

        if (!historical) {
          for (const delivery of deliveries) {
            yield* sql`
              insert into jobs (kind, payload, unique_key, priority)
              select
                'send_platform_notification',
                jsonb_build_object(
                  'clientCompanyId', ${delivery.clientCompanyId}::text,
                  'userId', recipients.user_id,
                  'kind', 'issue_published',
                  'deduplicationKey',
                    'issue-published:' || ${issueId}::text || ':' || recipients.user_id,
                  'issueId', ${issueId}::text,
                  'accessId', ${delivery.accessId}::text
                ),
                'send_platform_notification:issue-published:'
                  || ${issueId}::text || ':' || recipients.user_id,
                20
              from issue_delivery_recipients recipients
              where recipients.issue_id = ${issueId}::uuid
                and recipients.client_company_id = ${delivery.clientCompanyId}::uuid
              on conflict (unique_key) where unique_key is not null do nothing
            `;
          }
        }
        yield* enqueueDocumentPipeline(issueId);
        return { delivered: deliveries.length, alreadyPublished: false, cancelled: false };
      }),
    );
  });

interface DocumentRow {
  readonly id: string;
  readonly issueId: string;
  readonly objectKey: string;
  readonly sha256Hex: string;
  readonly language: string;
  readonly deletedAt: Date | null;
  readonly issueDeletedAt: Date | null;
}

const markDocumentFailure = (documentId: string, code: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    yield* sql`
      update brief_documents
      set indexing_error_code = ${code}, updated_at = now()
      where id = ${documentId} and deleted_at is null
    `;
    yield* sql`
      update publisher_issues issues
      set indexing_status = 'failed',
          indexing_error_code = ${code},
          updated_at = now()
      from brief_documents documents
      where documents.id = ${documentId}
        and issues.id = documents.issue_id
        and documents.deleted_at is null and issues.deleted_at is null
    `;
  });

const markExtractionFailure = (extractionId: string, code: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    yield* sql`
      update brief_documents documents
      set indexing_error_code = ${code}, updated_at = now()
      from brief_document_extractions extractions
      where extractions.id = ${extractionId}
        and documents.id = extractions.brief_document_id
        and documents.deleted_at is null
    `;
    yield* sql`
      update publisher_issues issues
      set indexing_status = 'failed',
          indexing_error_code = ${code},
          updated_at = now()
      from brief_documents documents
      join brief_document_extractions extractions
        on extractions.brief_document_id = documents.id
      where extractions.id = ${extractionId}
        and issues.id = documents.issue_id
        and documents.deleted_at is null and issues.deleted_at is null
    `;
  });

const enqueueNormalization = (extractionId: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    yield* sql`
      insert into jobs (kind, payload, unique_key, priority)
      values (
        'normalize_searchable_text',
        ${sql.json({ extractionId })},
        ${`normalize_searchable_text:${extractionId}`},
        45
      )
      on conflict (unique_key) where unique_key is not null do update
      set status = case when jobs.status = 'failed' then 'queued' else jobs.status end,
          attempts = case when jobs.status = 'failed' then 0 else jobs.attempts end,
          completed_at = case when jobs.status = 'failed' then null else jobs.completed_at end,
          last_error = case when jobs.status = 'failed' then null else jobs.last_error end,
          available_at = case when jobs.status = 'failed' then now() else jobs.available_at end,
          updated_at = now()
    `;
  });

const extractPdfText = (
  documentId: string,
  jobId: string,
): Effect.Effect<
  string | null,
  unknown,
  PgClient.PgClient | PlatformFileStore | PdfTextExtractor
> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const fileStore = yield* PlatformFileStore;
    const extractor = yield* PdfTextExtractor;
    const rows = yield* sql<DocumentRow>`
      select
        documents.id::text,
        documents.issue_id::text as "issueId",
        documents.object_key as "objectKey",
        documents.sha256_hex as "sha256Hex",
        documents.language,
        documents.deleted_at as "deletedAt",
        issues.deleted_at as "issueDeletedAt"
      from brief_documents documents
      join publisher_issues issues on issues.id = documents.issue_id
      where documents.id = ${documentId}
    `;
    const document = rows[0];
    if (document === undefined)
      return yield* Effect.fail(new Error(`document not found: ${documentId}`));
    if (document.deletedAt !== null || document.issueDeletedAt !== null) return null;
    const existing = yield* sql<{ readonly id: string }>`
      select id::text
      from brief_document_extractions
      where brief_document_id = ${documentId}
        and input_sha256_hex = ${document.sha256Hex}
      limit 1
    `;
    if (existing[0] !== undefined) {
      yield* sql`
        update brief_documents
        set indexing_error_code = null, updated_at = now()
        where id = ${documentId}
      `;
      yield* enqueueNormalization(existing[0].id);
      return existing[0].id;
    }

    yield* sql`
      update publisher_issues
      set indexing_status = 'extracting', indexing_error_code = null, updated_at = now()
      where id = ${document.issueId} and indexing_status <> 'ready'
    `;
    const bytes = yield* fileStore.get(document.objectKey);
    const actualHash = yield* sha256Hex(bytes);
    if (actualHash !== document.sha256Hex) {
      return yield* Effect.fail(new Error("publisher file SHA-256 does not match stored metadata"));
    }
    const pages = yield* extractor.extract(bytes);
    const canonical = canonicalizeExtractedPages(pages);
    if (canonical.text === "") {
      return yield* Effect.fail(
        new Error("PDF contains no extractable text and OCR is not enabled"),
      );
    }
    const normalizedPages = pages
      .map((page) => ({
        pageNumber: page.pageNumber,
        text: normalizeSearchablePageText(page.text),
      }))
      .filter((page) => page.text !== "");
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const activeIssue = yield* sql<{ readonly id: string }>`
          select id::text from publisher_issues
          where id = ${document.issueId} and deleted_at is null
          for update
        `;
        if (activeIssue[0] === undefined) return null;
        const activeDocument = yield* sql<{ readonly id: string }>`
          select id::text from brief_documents
          where id = ${documentId} and deleted_at is null and sha256_hex = ${document.sha256Hex}
          for update
        `;
        if (activeDocument[0] === undefined) return null;
        const inserted = yield* sql<{ readonly id: string }>`
          insert into brief_document_extractions (
        brief_document_id,
        input_sha256_hex,
        pages,
        extracted_char_count,
        created_by_job_id
      )
      values (
        ${documentId},
        ${document.sha256Hex},
        ${JSON.stringify(normalizedPages)}::jsonb,
        ${canonical.text.length},
        ${jobId}
      )
      on conflict (brief_document_id, input_sha256_hex) do nothing
      returning id::text
        `;
        const extractionId =
          inserted[0]?.id ??
          (yield* sql<{ readonly id: string }>`
          select id::text
          from brief_document_extractions
          where brief_document_id = ${documentId}
            and input_sha256_hex = ${document.sha256Hex}
          `)[0]!.id;
        yield* sql`
      update brief_documents
      set indexing_error_code = null, updated_at = now()
      where id = ${documentId}
        `;
        yield* sql`
      update publisher_issues
      set indexing_status = 'indexing', indexing_error_code = null, updated_at = now()
      where id = ${document.issueId}
        `;
        yield* enqueueNormalization(extractionId);
        return extractionId;
      }),
    );
  });

interface ExtractionRow {
  readonly id: string;
  readonly documentId: string;
  readonly issueId: string;
  readonly language: string;
  readonly pages: readonly ExtractedPdfPage[];
}

const normalizeSearchableText = (extractionId: string, jobId: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<ExtractionRow>`
      select
        extractions.id::text,
        extractions.brief_document_id::text as "documentId",
        documents.issue_id::text as "issueId",
        documents.language,
        extractions.pages
      from brief_document_extractions extractions
      join brief_documents documents on documents.id = extractions.brief_document_id
      join publisher_issues issues on issues.id = documents.issue_id
      where extractions.id = ${extractionId}
        and documents.deleted_at is null
        and issues.deleted_at is null
    `;
    const extraction = rows[0];
    if (extraction === undefined) {
      return null;
    }
    const canonical = canonicalizeExtractedPages(extraction.pages);
    if (canonical.text === "") return yield* Effect.fail(new Error("canonical text is empty"));
    const contentHash = yield* sha256Text(canonical.text);
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const activeIssue = yield* sql<{ readonly id: string }>`
          select id::text from publisher_issues
          where id = ${extraction.issueId} and deleted_at is null
          for update
        `;
        if (activeIssue[0] === undefined) return null;
        const activeDocument = yield* sql<{ readonly id: string }>`
          select id::text from brief_documents
          where id = ${extraction.documentId} and deleted_at is null
          for update
        `;
        if (activeDocument[0] === undefined) return null;
        const versions = yield* sql<{ readonly id: string }>`
          insert into brief_document_versions (
            brief_document_id,
            content_hash,
            language,
            canonical_text,
            text_char_count,
            page_ranges,
            created_by_job_id
          )
          values (
            ${extraction.documentId},
            ${contentHash},
            ${extraction.language},
            ${canonical.text},
            ${canonical.text.length},
            ${JSON.stringify(canonical.pageRanges)}::jsonb,
            ${jobId}
          )
          on conflict (brief_document_id, content_hash) do nothing
          returning id::text
        `;
        const versionId =
          versions[0]?.id ??
          (yield* sql<{ readonly id: string }>`
              select id::text
              from brief_document_versions
              where brief_document_id = ${extraction.documentId}
                and content_hash = ${contentHash}
            `)[0]!.id;
        yield* sql`
          update brief_documents
          set current_version_id = ${versionId},
              indexing_error_code = null,
              updated_at = now()
          where id = ${extraction.documentId}
        `;
        yield* sql`
          insert into jobs (kind, payload, unique_key, priority)
          values (
            'update_ai_indexing_status',
            ${sql.json({ issueId: extraction.issueId })},
            ${`update_ai_indexing_status:${extraction.issueId}`},
            40
          )
          on conflict (unique_key) where unique_key is not null do update
          set payload = excluded.payload,
              status = case when jobs.status in ('completed', 'failed') then 'queued' else jobs.status end,
              attempts = case when jobs.status in ('completed', 'failed') then 0 else jobs.attempts end,
              completed_at = case when jobs.status in ('completed', 'failed') then null else jobs.completed_at end,
              last_error = case when jobs.status in ('completed', 'failed') then null else jobs.last_error end,
              available_at = case when jobs.status in ('completed', 'failed') then now() else jobs.available_at end,
              updated_at = now()
        `;
        return versionId;
      }),
    );
  });

const updateAiIndexingStatus = (issueId: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const [counts] = yield* sql<{
      readonly documents: number;
      readonly missing: number;
      readonly failed: number;
    }>`
      select
        count(*)::int as documents,
        count(*) filter (where current_version_id is null)::int as missing,
        count(*) filter (where indexing_error_code is not null)::int as failed
      from brief_documents
      where issue_id = ${issueId} and deleted_at is null
    `;
    if (counts === undefined || counts.documents === 0) {
      return yield* Effect.fail(new Error("issue has no active documents"));
    }
    const rows = yield* sql<{ readonly status: string }>`
      update publisher_issues
      set indexing_status = case
            when ${counts.failed} > 0 then 'failed'
            when ${counts.missing} = 0 then 'ready'
            else 'indexing'
          end,
          indexing_error_code = case
            when ${counts.failed} > 0 then (
              select min(documents.indexing_error_code)
              from brief_documents documents
              where documents.issue_id = ${issueId}
                and documents.deleted_at is null
                and documents.indexing_error_code is not null
            )
            else null
          end,
          updated_at = now()
      where id = ${issueId} and deleted_at is null
      returning indexing_status as status
    `;
    if (rows[0] === undefined) return yield* Effect.fail(new Error(`issue not found: ${issueId}`));
    return rows[0].status;
  });

const finalizeSubscriptionPause = (accessId: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const rows = yield* sql<{
          readonly state: "invited" | "active" | "ending" | "paused";
          readonly clientCompanyId: string;
          readonly deliveryEndAt: Date | null;
        }>`
          select state, client_company_id::text as "clientCompanyId",
                 delivery_end_at as "deliveryEndAt"
          from client_subscription_accesses where id = ${accessId}
          for update
        `;
        const access = rows[0];
        if (access === undefined)
          return yield* Effect.fail(new Error("subscription access not found"));
        if (access.state === "paused") return false;
        if (
          access.state !== "ending" ||
          access.deliveryEndAt === null ||
          access.deliveryEndAt > new Date()
        ) {
          return yield* Effect.fail(new Error("subscription pause is not due"));
        }
        yield* sql`
          update client_subscription_accesses
          set state = 'paused', paused_at = now(), updated_at = now()
          where id = ${accessId}
        `;
        yield* sql`
          insert into jobs (kind, payload, unique_key, priority, max_attempts)
          select 'send_platform_notification',
                 jsonb_build_object(
                   'clientCompanyId', ${access.clientCompanyId}::text,
                   'userId', grants.user_id,
                   'kind', 'delivery_ended',
                   'deduplicationKey', 'delivery-ended:' || ${accessId}::text || ':' || grants.user_id,
                   'accessId', ${accessId}::text
                 ),
                 'send_platform_notification:delivery-ended:' || ${accessId}::text || ':' || grants.user_id,
                 20, 8
          from client_employee_subscription_grants grants
          where grants.access_id = ${accessId} and grants.revoked_at is null
          on conflict (unique_key) where unique_key is not null do nothing
        `;
        return true;
      }),
    );
  });

export const purgeDeletedChats = (
  budget: PlatformPurgeCandidateBudget = makePlatformPurgeCandidateBudget(),
) =>
  Effect.gen(function* () {
    if (budget.remaining === 0) return 0;
    const sql = yield* PgClient.PgClient;
    const candidates = yield* sql<{
      readonly id: string;
      readonly companyId: string;
      readonly userId: string;
    }>`
      select
        chats.id::text,
        chats.company_id::text as "companyId",
        chats.user_id as "userId"
      from chats
      join client_companies companies on companies.id = chats.company_id
      left join platform_users users on users.id = chats.user_id
      where chats.deleted_at is not null
        and chats.purge_after <= now()
        and chats.legal_hold = false
        and companies.legal_hold = false
        and coalesce(users.legal_hold, false) = false
        and not exists (
          select 1 from legal_holds holds
          where holds.released_at is null
            and (
              (holds.scope_kind = 'chat' and holds.scope_id = chats.id::text)
              or (holds.scope_kind = 'client_company' and holds.scope_id = chats.company_id::text)
              or (holds.scope_kind = 'user' and holds.scope_id = chats.user_id)
            )
        )
      order by chats.purge_after, chats.id
      limit ${budget.remaining}
    `;
    consumePlatformPurgeCandidates(budget, candidates.length);
    let purged = 0;
    for (const candidate of candidates) {
      const deleted = yield* sql.withTransaction(
        Effect.gen(function* () {
          // Keep the purge lane on the same canonical comparator as account
          // preparation and legal-hold placement (chat, company, user).
          yield* lockLegalHoldScopes([
            `chat:${candidate.id}`,
            `client_company:${candidate.companyId}`,
            `user:${candidate.userId}`,
          ]);
          // Deleting a chat cascades through chat messages and AI runs. Those
          // foreign keys clear memory source-message and revision/run
          // provenance, so discover the complete owner set from both
          // relationships and join every user-memory lane before the chat row.
          const memoryUsers = yield* chatMemoryProvenanceUsers(candidate.id);
          yield* lockUserMemoryLanes(memoryUsers);
          const locked = yield* sql<{
            readonly id: string;
            readonly companyId: string;
            readonly userId: string;
          }>`
            select
              chats.id::text,
              chats.company_id::text as "companyId",
              chats.user_id as "userId"
            from chats
            where chats.id = ${candidate.id}
            for update
          `;
          const chat = locked[0];
          if (chat === undefined) return false;
          const currentMemoryUsers = yield* chatMemoryProvenanceUsers(candidate.id);
          if (!sameOrderedIds(currentMemoryUsers, memoryUsers)) return false;
          yield* sql`select id from client_companies where id = ${chat.companyId} for share`;
          yield* sql`select id from platform_users where id = ${chat.userId} for share`;
          const eligible = yield* sql<{ readonly id: string }>`
            select chats.id::text
            from chats
            join client_companies companies on companies.id = chats.company_id
            left join platform_users users on users.id = chats.user_id
            where chats.id = ${candidate.id}
              and chats.deleted_at is not null
              and chats.purge_after <= now()
              and chats.legal_hold = false
              and companies.legal_hold = false
              and coalesce(users.legal_hold, false) = false
              and not exists (
                select 1 from legal_holds holds
                where holds.released_at is null
                  and (
                    (holds.scope_kind = 'chat' and holds.scope_id = chats.id::text)
                    or (
                      holds.scope_kind = 'client_company'
                      and holds.scope_id = chats.company_id::text
                    )
                    or (holds.scope_kind = 'user' and holds.scope_id = chats.user_id)
                  )
              )
          `;
          if (eligible[0] === undefined) return false;
          const inserted = yield* sql<{ readonly chatId: string }>`
            insert into deleted_chat_tombstones (
              chat_id,
              client_company_id,
              creator_user_id,
              subscription_source_ids,
              deleted_at,
              deleted_by_user_id,
              terminal_error_codes,
              model_input_tokens,
              model_output_tokens,
              model_request_count,
              web_search_count,
              web_fetch_count,
              exposed_item_count
            )
            select
              chats.id,
              chats.company_id,
              chats.user_id,
              array(
                select sources.subscription_id
                from chat_subscription_sources sources
                where sources.chat_id = chats.id
                order by sources.subscription_id
              ),
              chats.deleted_at,
              chats.deleted_by_user_id,
              array(
                select distinct runs.error_code
                from ai_runs runs
                where runs.chat_id = chats.id and runs.error_code is not null
                order by runs.error_code
              ),
              coalesce((select sum(usage.input_tokens) from ai_run_usage usage join ai_runs runs on runs.id = usage.run_id where runs.chat_id = chats.id), 0),
              coalesce((select sum(usage.output_tokens) from ai_run_usage usage join ai_runs runs on runs.id = usage.run_id where runs.chat_id = chats.id), 0),
              (select count(*) from ai_run_usage usage join ai_runs runs on runs.id = usage.run_id where runs.chat_id = chats.id),
              (select count(*) from ai_external_tool_usage usage join ai_runs runs on runs.id = usage.run_id where runs.chat_id = chats.id and usage.operation = 'web_search'),
              (select count(*) from ai_external_tool_usage usage join ai_runs runs on runs.id = usage.run_id where runs.chat_id = chats.id and usage.operation = 'web_fetch'),
              (
                select count(distinct (exposures.run_id, exposures.source_kind, exposures.content_item_identity))
                from ai_source_exposures exposures
                join ai_runs runs on runs.id = exposures.run_id
                where runs.chat_id = chats.id
              )
            from chats
            where chats.id = ${candidate.id}
            on conflict (chat_id) do nothing
            returning chat_id::text as "chatId"
          `;
          const removed = yield* sql<{ readonly id: string }>`
            delete from chats
            where id = ${candidate.id}
            returning id::text
          `;
          return inserted.length > 0 || removed.length > 0;
        }),
      );
      if (deleted) purged += 1;
    }
    return purged;
  });

interface AccountingPurgeCandidate {
  readonly id: string;
  readonly holdScopeKeys: readonly string[];
}

interface StripeEventPurgeCandidate extends AccountingPurgeCandidate {
  readonly customerId: string | null;
  readonly subscriptionId: string | null;
  readonly scheduleId: string | null;
  readonly paymentId: string | null;
  readonly invoiceId: string | null;
}

const purgeExpiredCreditUsage = (budget: PlatformPurgeCandidateBudget) =>
  Effect.gen(function* () {
    if (budget.remaining === 0) return 0;
    const sql = yield* PgClient.PgClient;
    const candidates = yield* sql<AccountingPurgeCandidate>`
      select usage.id::text,
             array[
               'client_company:' || usage.client_company_id::text,
               'user:' || usage.user_id
             ]::text[] as "holdScopeKeys"
      from client_credit_usage usage
      join client_companies companies on companies.id = usage.client_company_id
      left join platform_users users on users.id = usage.user_id
      where usage.retained_until <= now()
        and companies.legal_hold = false
        and coalesce(users.legal_hold, false) = false
        and not brief_has_active_legal_hold(array[
          'client_company:' || usage.client_company_id::text,
          'user:' || usage.user_id
        ]::text[])
      order by usage.retained_until, usage.id
      limit ${budget.remaining}
    `;
    consumePlatformPurgeCandidates(budget, candidates.length);
    let purged = 0;
    for (const candidate of candidates) {
      const deleted = yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* lockLegalHoldScopes(candidate.holdScopeKeys);
          const rows = yield* sql<AccountingPurgeCandidate>`
            select usage.id::text,
                   array[
                     'client_company:' || usage.client_company_id::text,
                     'user:' || usage.user_id
                   ]::text[] as "holdScopeKeys"
            from client_credit_usage usage
            join client_companies companies on companies.id = usage.client_company_id
            left join platform_users users on users.id = usage.user_id
            where usage.id = ${candidate.id}
              and usage.retained_until <= now()
              and companies.legal_hold = false
              and coalesce(users.legal_hold, false) = false
              and not brief_has_active_legal_hold(array[
                'client_company:' || usage.client_company_id::text,
                'user:' || usage.user_id
              ]::text[])
            for update of usage
          `;
          const current = rows[0];
          if (
            current === undefined ||
            !sameLegalHoldScopeKeys(current.holdScopeKeys, candidate.holdScopeKeys)
          ) {
            return false;
          }
          yield* lockEmbeddedLegalHoldRows(current.holdScopeKeys);
          if (yield* hasLegalHoldForScopes(current.holdScopeKeys)) return false;
          yield* sql`select set_config('brief.allow_accounting_retention_purge', 'on', true)`;
          yield* sql`delete from client_credit_usage_allocations where usage_id = ${candidate.id}`;
          const removed = yield* sql<{ readonly id: string }>`
            delete from client_credit_usage where id = ${candidate.id} returning id::text
          `;
          return removed.length === 1;
        }),
      );
      if (deleted) purged += 1;
    }
    return purged;
  });

const purgeExpiredCreditLots = (budget: PlatformPurgeCandidateBudget) =>
  Effect.gen(function* () {
    if (budget.remaining === 0) return 0;
    const sql = yield* PgClient.PgClient;
    const candidates = yield* sql<AccountingPurgeCandidate>`
      select lots.id::text,
             array['client_company:' || lots.client_company_id::text]::text[]
               as "holdScopeKeys"
      from client_credit_lots lots
      join client_companies companies on companies.id = lots.client_company_id
      where lots.retained_until <= now()
        and companies.legal_hold = false
        and not brief_has_active_legal_hold(
          array['client_company:' || lots.client_company_id::text]::text[]
        )
        and not exists (
          select 1 from client_credit_usage_allocations allocation
          where allocation.credit_lot_id = lots.id
        )
      order by lots.retained_until, lots.id
      limit ${budget.remaining}
    `;
    consumePlatformPurgeCandidates(budget, candidates.length);
    let purged = 0;
    for (const candidate of candidates) {
      const deleted = yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* lockLegalHoldScopes(candidate.holdScopeKeys);
          const rows = yield* sql<AccountingPurgeCandidate>`
            select lots.id::text,
                   array['client_company:' || lots.client_company_id::text]::text[]
                     as "holdScopeKeys"
            from client_credit_lots lots
            join client_companies companies on companies.id = lots.client_company_id
            where lots.id = ${candidate.id}
              and lots.retained_until <= now()
              and companies.legal_hold = false
              and not brief_has_active_legal_hold(
                array['client_company:' || lots.client_company_id::text]::text[]
              )
              and not exists (
                select 1 from client_credit_usage_allocations allocation
                where allocation.credit_lot_id = lots.id
              )
            for update of lots
          `;
          const current = rows[0];
          if (
            current === undefined ||
            !sameLegalHoldScopeKeys(current.holdScopeKeys, candidate.holdScopeKeys)
          ) {
            return false;
          }
          yield* lockEmbeddedLegalHoldRows(current.holdScopeKeys);
          if (yield* hasLegalHoldForScopes(current.holdScopeKeys)) return false;
          yield* sql`select set_config('brief.allow_accounting_retention_purge', 'on', true)`;
          const removed = yield* sql<{ readonly id: string }>`
            delete from client_credit_lots where id = ${candidate.id} returning id::text
          `;
          return removed.length === 1;
        }),
      );
      if (deleted) purged += 1;
    }
    return purged;
  });

const purgeExpiredStripeEvents = (budget: PlatformPurgeCandidateBudget) =>
  Effect.gen(function* () {
    if (budget.remaining === 0) return 0;
    const sql = yield* PgClient.PgClient;
    const candidates = yield* sql<StripeEventPurgeCandidate>`
      select events.stripe_event_id as id,
             events.stripe_customer_id as "customerId",
             events.stripe_subscription_id as "subscriptionId",
             events.stripe_schedule_id as "scheduleId",
             events.stripe_payment_id as "paymentId",
             events.stripe_invoice_id as "invoiceId",
             brief_stripe_event_legal_hold_scope_keys(
               events.stripe_customer_id,
               events.stripe_subscription_id,
               events.stripe_schedule_id,
               events.stripe_payment_id,
               events.stripe_invoice_id
             ) as "holdScopeKeys"
      from stripe_webhook_events events
      where events.retained_until <= now()
        and not brief_has_active_legal_hold(
          brief_stripe_event_legal_hold_scope_keys(
            events.stripe_customer_id,
            events.stripe_subscription_id,
            events.stripe_schedule_id,
            events.stripe_payment_id,
            events.stripe_invoice_id
          )
        )
        and not exists (
          select 1 from client_companies companies
          where companies.legal_hold
            and ('client_company:' || companies.id::text) = any(
              brief_stripe_event_legal_hold_scope_keys(
                events.stripe_customer_id,
                events.stripe_subscription_id,
                events.stripe_schedule_id,
                events.stripe_payment_id,
                events.stripe_invoice_id
              )
            )
        )
        and not exists (
          select 1 from platform_users users
          where users.legal_hold
            and ('user:' || users.id) = any(
              brief_stripe_event_legal_hold_scope_keys(
                events.stripe_customer_id,
                events.stripe_subscription_id,
                events.stripe_schedule_id,
                events.stripe_payment_id,
                events.stripe_invoice_id
              )
            )
        )
      order by events.retained_until, events.stripe_event_id
      limit ${budget.remaining}
    `;
    consumePlatformPurgeCandidates(budget, candidates.length);
    let purged = 0;
    for (const candidate of candidates) {
      const deleted = yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* lockLegalHoldScopes(candidate.holdScopeKeys);
          const rows = yield* sql<StripeEventPurgeCandidate>`
            select events.stripe_event_id as id,
                   events.stripe_customer_id as "customerId",
                   events.stripe_subscription_id as "subscriptionId",
                   events.stripe_schedule_id as "scheduleId",
                   events.stripe_payment_id as "paymentId",
                   events.stripe_invoice_id as "invoiceId",
                   brief_stripe_event_legal_hold_scope_keys(
                     events.stripe_customer_id,
                     events.stripe_subscription_id,
                     events.stripe_schedule_id,
                     events.stripe_payment_id,
                     events.stripe_invoice_id
                   ) as "holdScopeKeys"
            from stripe_webhook_events events
            where events.stripe_event_id = ${candidate.id}
              and events.retained_until <= now()
            for update
          `;
          const current = rows[0];
          if (
            current === undefined ||
            !sameLegalHoldScopeKeys(current.holdScopeKeys, candidate.holdScopeKeys)
          ) {
            return false;
          }
          yield* sql`
            select companies.id
            from client_companies companies
            where ('client_company:' || companies.id::text) = any(${current.holdScopeKeys})
            for share
          `;
          yield* sql`
            select users.id
            from platform_users users
            where ('user:' || users.id) = any(${current.holdScopeKeys})
            for share
          `;
          const held = yield* sql<{ readonly held: boolean }>`
            select brief_has_active_legal_hold(${current.holdScopeKeys})
              or exists (
                select 1 from client_companies companies
                where companies.legal_hold
                  and ('client_company:' || companies.id::text) = any(${current.holdScopeKeys})
              )
              or exists (
                select 1 from platform_users users
                where users.legal_hold
                  and ('user:' || users.id) = any(${current.holdScopeKeys})
              ) as held
          `;
          if (held[0]?.held !== false) return false;
          yield* sql`select set_config('brief.allow_accounting_retention_purge', 'on', true)`;
          const removed = yield* sql<{ readonly id: string }>`
            delete from stripe_webhook_events
            where stripe_event_id = ${candidate.id}
            returning stripe_event_id as id
          `;
          return removed.length === 1;
        }),
      );
      if (deleted) purged += 1;
    }
    return purged;
  });

const purgeExpiredPlanChangeRequests = (budget: PlatformPurgeCandidateBudget) =>
  Effect.gen(function* () {
    if (budget.remaining === 0) return 0;
    const sql = yield* PgClient.PgClient;
    const candidates = yield* sql<AccountingPurgeCandidate>`
      select requests.id::text,
             array[
               'client_company:' || requests.client_company_id::text,
               'user:' || requests.requested_by_user_id
             ]::text[] as "holdScopeKeys"
      from client_ai_plan_change_requests requests
      join client_companies companies on companies.id = requests.client_company_id
      left join platform_users users on users.id = requests.requested_by_user_id
      where requests.retained_until <= now()
        and requests.status in ('succeeded', 'failed')
        and companies.legal_hold = false
        and coalesce(users.legal_hold, false) = false
        and not brief_has_active_legal_hold(array[
          'client_company:' || requests.client_company_id::text,
          'user:' || requests.requested_by_user_id
        ]::text[])
      order by requests.retained_until, requests.id
      limit ${budget.remaining}
    `;
    consumePlatformPurgeCandidates(budget, candidates.length);
    let purged = 0;
    for (const candidate of candidates) {
      const deleted = yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* lockLegalHoldScopes(candidate.holdScopeKeys);
          const rows = yield* sql<AccountingPurgeCandidate>`
            select requests.id::text,
                   array[
                     'client_company:' || requests.client_company_id::text,
                     'user:' || requests.requested_by_user_id
                   ]::text[] as "holdScopeKeys"
            from client_ai_plan_change_requests requests
            join client_companies companies on companies.id = requests.client_company_id
            left join platform_users users on users.id = requests.requested_by_user_id
            where requests.id = ${candidate.id}
              and requests.retained_until <= now()
              and requests.status in ('succeeded', 'failed')
              and companies.legal_hold = false
              and coalesce(users.legal_hold, false) = false
              and not brief_has_active_legal_hold(array[
                'client_company:' || requests.client_company_id::text,
                'user:' || requests.requested_by_user_id
              ]::text[])
            for update of requests
          `;
          const current = rows[0];
          if (
            current === undefined ||
            !sameLegalHoldScopeKeys(current.holdScopeKeys, candidate.holdScopeKeys)
          ) {
            return false;
          }
          yield* lockEmbeddedLegalHoldRows(current.holdScopeKeys);
          if (yield* hasLegalHoldForScopes(current.holdScopeKeys)) return false;
          yield* sql`select set_config('brief.allow_accounting_retention_purge', 'on', true)`;
          const removed = yield* sql<{ readonly id: string }>`
            delete from client_ai_plan_change_requests
            where id = ${candidate.id} returning id::text
          `;
          return removed.length === 1;
        }),
      );
      if (deleted) purged += 1;
    }
    return purged;
  });

const purgeExpiredCheckoutRequests = (budget: PlatformPurgeCandidateBudget) =>
  Effect.gen(function* () {
    if (budget.remaining === 0) return 0;
    const sql = yield* PgClient.PgClient;
    const candidates = yield* sql<AccountingPurgeCandidate>`
      select requests.id::text,
             array[
               'client_company:' || requests.client_company_id::text,
               'user:' || requests.requested_by_user_id
             ]::text[] as "holdScopeKeys"
      from client_ai_checkout_requests requests
      join client_companies companies on companies.id = requests.client_company_id
      left join platform_users users on users.id = requests.requested_by_user_id
      where requests.retained_until <= now()
        and requests.status in ('succeeded', 'failed')
        and companies.legal_hold = false
        and coalesce(users.legal_hold, false) = false
        and not brief_has_active_legal_hold(array[
          'client_company:' || requests.client_company_id::text,
          'user:' || requests.requested_by_user_id
        ]::text[])
      order by requests.retained_until, requests.id
      limit ${budget.remaining}
    `;
    consumePlatformPurgeCandidates(budget, candidates.length);
    let purged = 0;
    for (const candidate of candidates) {
      const deleted = yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* lockLegalHoldScopes(candidate.holdScopeKeys);
          const rows = yield* sql<AccountingPurgeCandidate>`
            select requests.id::text,
                   array[
                     'client_company:' || requests.client_company_id::text,
                     'user:' || requests.requested_by_user_id
                   ]::text[] as "holdScopeKeys"
            from client_ai_checkout_requests requests
            join client_companies companies on companies.id = requests.client_company_id
            left join platform_users users on users.id = requests.requested_by_user_id
            where requests.id = ${candidate.id}
              and requests.retained_until <= now()
              and requests.status in ('succeeded', 'failed')
              and companies.legal_hold = false
              and coalesce(users.legal_hold, false) = false
              and not brief_has_active_legal_hold(array[
                'client_company:' || requests.client_company_id::text,
                'user:' || requests.requested_by_user_id
              ]::text[])
            for update of requests
          `;
          const current = rows[0];
          if (
            current === undefined ||
            !sameLegalHoldScopeKeys(current.holdScopeKeys, candidate.holdScopeKeys)
          ) {
            return false;
          }
          yield* lockEmbeddedLegalHoldRows(current.holdScopeKeys);
          if (yield* hasLegalHoldForScopes(current.holdScopeKeys)) return false;
          yield* sql`select set_config('brief.allow_accounting_retention_purge', 'on', true)`;
          const removed = yield* sql<{ readonly id: string }>`
            delete from client_ai_checkout_requests
            where id = ${candidate.id}
            returning id::text
          `;
          return removed.length === 1;
        }),
      );
      if (deleted) purged += 1;
    }
    return purged;
  });

const purgeExpiredBillingAccounts = (budget: PlatformPurgeCandidateBudget) =>
  Effect.gen(function* () {
    if (budget.remaining === 0) return 0;
    const sql = yield* PgClient.PgClient;
    const candidates = yield* sql<AccountingPurgeCandidate>`
      select accounts.client_company_id::text as id,
             brief_normalize_legal_hold_scope_keys(
               array['client_company:' || accounts.client_company_id::text]::text[]
               || coalesce(
                 array(
                   select 'user:' || requests.requested_by_user_id
                   from client_ai_plan_change_requests requests
                   where requests.client_company_id = accounts.client_company_id
                   union
                   select 'user:' || requests.requested_by_user_id
                   from client_ai_checkout_requests requests
                   where requests.client_company_id = accounts.client_company_id
                   order by 1
                 ),
                 array[]::text[]
               )
             ) as "holdScopeKeys"
      from client_ai_billing_accounts accounts
      join client_companies companies on companies.id = accounts.client_company_id
      where accounts.retained_until <= now()
        and accounts.status in ('inactive', 'cancelled')
        and accounts.pending_downgrade_tier is null
        and accounts.pending_downgrade_schedule_id is null
        and companies.legal_hold = false
        and not exists (
          select 1 from client_ai_plan_change_requests requests
          where requests.client_company_id = accounts.client_company_id
            and requests.status = 'processing'
        )
        and not exists (
          select 1 from client_ai_checkout_requests requests
          where requests.client_company_id = accounts.client_company_id
            and requests.status = 'processing'
        )
        and not brief_has_active_legal_hold(
          brief_normalize_legal_hold_scope_keys(
            array['client_company:' || accounts.client_company_id::text]::text[]
            || coalesce(
              array(
                select 'user:' || requests.requested_by_user_id
                from client_ai_plan_change_requests requests
                where requests.client_company_id = accounts.client_company_id
                union
                select 'user:' || requests.requested_by_user_id
                from client_ai_checkout_requests requests
                where requests.client_company_id = accounts.client_company_id
              ),
              array[]::text[]
            )
          )
        )
        and not exists (
          select 1 from platform_users users
          where users.legal_hold
            and ('user:' || users.id) = any(
              brief_normalize_legal_hold_scope_keys(
                array['client_company:' || accounts.client_company_id::text]::text[]
                || coalesce(
                  array(
                    select 'user:' || requests.requested_by_user_id
                    from client_ai_plan_change_requests requests
                    where requests.client_company_id = accounts.client_company_id
                    union
                    select 'user:' || requests.requested_by_user_id
                    from client_ai_checkout_requests requests
                    where requests.client_company_id = accounts.client_company_id
                  ),
                  array[]::text[]
                )
              )
            )
        )
      order by accounts.retained_until, accounts.client_company_id
      limit ${budget.remaining}
    `;
    consumePlatformPurgeCandidates(budget, candidates.length);
    let purged = 0;
    for (const candidate of candidates) {
      const deleted = yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* lockLegalHoldScopes(candidate.holdScopeKeys);
          const rows = yield* sql<AccountingPurgeCandidate>`
            select accounts.client_company_id::text as id,
                   brief_normalize_legal_hold_scope_keys(
                     array['client_company:' || accounts.client_company_id::text]::text[]
                     || coalesce(
                       array(
                         select 'user:' || requests.requested_by_user_id
                         from client_ai_plan_change_requests requests
                         where requests.client_company_id = accounts.client_company_id
                         union
                         select 'user:' || requests.requested_by_user_id
                         from client_ai_checkout_requests requests
                         where requests.client_company_id = accounts.client_company_id
                       ),
                       array[]::text[]
                     )
                   ) as "holdScopeKeys"
            from client_ai_billing_accounts accounts
            join client_companies companies on companies.id = accounts.client_company_id
            where accounts.client_company_id = ${candidate.id}
              and accounts.retained_until <= now()
              and accounts.status in ('inactive', 'cancelled')
              and accounts.pending_downgrade_tier is null
              and accounts.pending_downgrade_schedule_id is null
              and companies.legal_hold = false
              and not exists (
                select 1 from client_ai_plan_change_requests requests
                where requests.client_company_id = accounts.client_company_id
                  and requests.status = 'processing'
              )
              and not exists (
                select 1 from client_ai_checkout_requests requests
                where requests.client_company_id = accounts.client_company_id
                  and requests.status = 'processing'
              )
            for update of accounts
          `;
          const current = rows[0];
          if (
            current === undefined ||
            !sameLegalHoldScopeKeys(current.holdScopeKeys, candidate.holdScopeKeys)
          ) {
            return false;
          }
          yield* sql`
            select companies.id from client_companies companies
            where ('client_company:' || companies.id::text) = any(${current.holdScopeKeys})
            for share
          `;
          yield* sql`
            select users.id from platform_users users
            where ('user:' || users.id) = any(${current.holdScopeKeys})
            for share
          `;
          const held = yield* sql<{ readonly held: boolean }>`
            select brief_has_active_legal_hold(${current.holdScopeKeys})
              or exists (
                select 1 from client_companies companies
                where companies.legal_hold
                  and ('client_company:' || companies.id::text) = any(${current.holdScopeKeys})
              )
              or exists (
                select 1 from platform_users users
                where users.legal_hold
                  and ('user:' || users.id) = any(${current.holdScopeKeys})
              ) as held
          `;
          if (held[0]?.held !== false) return false;
          yield* sql`select set_config('brief.allow_accounting_retention_purge', 'on', true)`;
          const removed = yield* sql<{ readonly id: string }>`
            delete from client_ai_billing_accounts
            where client_company_id = ${candidate.id}
            returning client_company_id::text as id
          `;
          return removed.length === 1;
        }),
      );
      if (deleted) purged += 1;
    }
    return purged;
  });

const purgeExpiredAccountingRecords = (
  budget: PlatformPurgeCandidateBudget = makePlatformPurgeCandidateBudget(),
) =>
  Effect.gen(function* () {
    const usage = yield* purgeExpiredCreditUsage(budget);
    const lots = yield* purgeExpiredCreditLots(budget);
    const stripeEvents = yield* purgeExpiredStripeEvents(budget);
    const planChangeRequests = yield* purgeExpiredPlanChangeRequests(budget);
    const checkoutRequests = yield* purgeExpiredCheckoutRequests(budget);
    const billingAccounts = yield* purgeExpiredBillingAccounts(budget);
    return { usage, lots, stripeEvents, planChangeRequests, checkoutRequests, billingAccounts };
  });

export const purgeDeletedAccounts = () =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const budget = makePlatformPurgeCandidateBudget();
    // Already-prepared chat deletions run first so account candidates cannot
    // consume every later batch while waiting for their chats to disappear.
    let purgedChats = yield* purgeDeletedChats(budget);
    if (budget.remaining === 0) {
      return {
        purgedUsers: 0,
        purgedCompanies: 0,
        purgedChats,
        accounting: {
          usage: 0,
          lots: 0,
          stripeEvents: 0,
          planChangeRequests: 0,
          checkoutRequests: 0,
          billingAccounts: 0,
        },
      };
    }
    const users = yield* sql<{ readonly id: string; readonly clerkUserId: string }>`
      select users.id, users.clerk_user_id as "clerkUserId"
      from platform_users users
      where users.recovery_deleted_at is not null
        and users.purge_after <= now()
        and users.purged_at is null
        and users.legal_hold = false
        and not exists (
          select 1 from legal_holds holds
          where holds.scope_kind = 'user' and holds.scope_id = users.id
            and holds.released_at is null
        )
        and not exists (
          select 1 from chats held_chat
          where held_chat.user_id = users.id and held_chat.shared_at is null
            and (
              held_chat.legal_hold
              or exists (
                select 1 from legal_holds holds
                where holds.scope_kind = 'chat'
                  and holds.scope_id = held_chat.id::text
                  and holds.released_at is null
              )
            )
        )
        and (
          not exists (
            select 1 from chats remaining_chat
            where remaining_chat.user_id = users.id and remaining_chat.shared_at is null
          )
          or exists (
            select 1 from chats unprepared_chat
            where unprepared_chat.user_id = users.id
              and unprepared_chat.shared_at is null
              and unprepared_chat.deleted_at is null
          )
        )
      order by users.purge_after, users.id
      limit ${budget.remaining}
    `;
    consumePlatformPurgeCandidates(budget, users.length);
    for (const user of users) {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          // Account preparation must take the same complete legal-hold scope
          // set as hold placement. Discover every private child chat and its
          // company/user parents, canonicalize the complete set, and acquire
          // every advisory key before touching any row. A later re-read under
          // the lease makes discovery drift an all-or-nothing skip.
          const discoveredChats = yield* sql<AccountRetentionChatScope>`
            select chats.id::text,
                   chats.company_id::text as "companyId",
                   chats.user_id as "userId"
            from chats
            where chats.user_id = ${user.id} and chats.shared_at is null
            order by chats.id
          `;
          const discoveredHoldScopeKeys = accountRetentionChatScopeKeys(
            `user:${user.id}`,
            discoveredChats,
          );
          yield* lockLegalHoldScopes(discoveredHoldScopeKeys);

          const lockedUser = yield* sql<{
            readonly id: string;
            readonly clerkUserId: string;
          }>`
            select users.id, users.clerk_user_id as "clerkUserId"
            from platform_users users
            where users.id = ${user.id}
              and users.recovery_deleted_at is not null
              and users.purge_after <= now()
              and users.purged_at is null
            for update
          `;
          if (lockedUser[0] === undefined) return false;

          const discoveredCompanyIds = [...new Set(discoveredChats.map((chat) => chat.companyId))];
          if (discoveredCompanyIds.length > 0) {
            yield* sql`
              select companies.id
              from client_companies companies
              where ${sql.in("id", discoveredCompanyIds)}
              order by companies.id
              for update
            `;
          }

          const currentChats = yield* sql<AccountRetentionChatScope>`
            select chats.id::text,
                   chats.company_id::text as "companyId",
                   chats.user_id as "userId"
            from chats
            where chats.user_id = ${user.id} and chats.shared_at is null
            order by chats.id
          `;
          const currentHoldScopeKeys = accountRetentionChatScopeKeys(
            `user:${user.id}`,
            currentChats,
          );
          if (!sameLegalHoldScopeKeys(currentHoldScopeKeys, discoveredHoldScopeKeys)) {
            return false;
          }

          yield* sql`
            select chats.id
            from chats
            where chats.user_id = ${user.id} and chats.shared_at is null
            order by chats.id
            for update
          `;
          const recheckedChats = yield* sql<AccountRetentionChatScope>`
            select chats.id::text,
                   chats.company_id::text as "companyId",
                   chats.user_id as "userId"
            from chats
            where chats.user_id = ${user.id} and chats.shared_at is null
            order by chats.id
          `;
          const recheckedHoldScopeKeys = accountRetentionChatScopeKeys(
            `user:${user.id}`,
            recheckedChats,
          );
          if (!sameLegalHoldScopeKeys(recheckedHoldScopeKeys, discoveredHoldScopeKeys)) {
            return false;
          }
          if (yield* hasLegalHoldForScopes(recheckedHoldScopeKeys)) return false;

          yield* sql`
            update chats
            set deleted_at = coalesce(deleted_at, now()),
                deleted_by_user_id = coalesce(deleted_by_user_id, ${user.id}),
                purge_after = coalesce(purge_after, now())
            where user_id = ${user.id} and shared_at is null and deleted_at is null
          `;
        }),
      );
    }

    const companies =
      budget.remaining === 0
        ? []
        : yield* sql<{ readonly id: string }>`
      select companies.id::text
      from client_companies companies
      where companies.recovery_deleted_at is not null
        and companies.purge_after <= now()
        and companies.purged_at is null
        and companies.legal_hold = false
        and not exists (
          select 1 from legal_holds holds
          where holds.scope_kind = 'client_company' and holds.scope_id = companies.id::text
            and holds.released_at is null
        )
        and not exists (
          select 1 from chats held_chat
          where held_chat.company_id = companies.id
            and (
              held_chat.legal_hold
              or exists (
                select 1 from legal_holds holds
                where holds.scope_kind = 'chat'
                  and holds.scope_id = held_chat.id::text
                  and holds.released_at is null
              )
            )
        )
        and (
          not exists (
            select 1 from chats remaining_chat
            where remaining_chat.company_id = companies.id
          )
          or exists (
            select 1 from chats unprepared_chat
            where unprepared_chat.company_id = companies.id
              and unprepared_chat.deleted_at is null
          )
        )
      order by companies.purge_after, companies.id
      limit ${budget.remaining}
    `;
    consumePlatformPurgeCandidates(budget, companies.length);
    for (const company of companies) {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          // Company preparation has the same lease as user preparation, but
          // its scope fans out to every chat and every owning user. This also
          // makes a user hold on one child chat linearize the whole
          // preparation instead of allowing a partial deleted_at transition.
          const discoveredChats = yield* sql<AccountRetentionChatScope>`
            select chats.id::text,
                   chats.company_id::text as "companyId",
                   chats.user_id as "userId"
            from chats
            where chats.company_id = ${company.id}
            order by chats.id
          `;
          const discoveredHoldScopeKeys = accountRetentionChatScopeKeys(
            `client_company:${company.id}`,
            discoveredChats,
          );
          yield* lockLegalHoldScopes(discoveredHoldScopeKeys);

          const lockedCompany = yield* sql<{ readonly id: string }>`
            select companies.id::text
            from client_companies companies
            where companies.id = ${company.id}
              and companies.recovery_deleted_at is not null
              and companies.purge_after <= now()
              and companies.purged_at is null
            for update
          `;
          if (lockedCompany[0] === undefined) return false;

          const discoveredUserIds = [...new Set(discoveredChats.map((chat) => chat.userId))];
          if (discoveredUserIds.length > 0) {
            yield* sql`
              select users.id
              from platform_users users
              where ${sql.in("id", discoveredUserIds)}
              order by users.id
              for update
            `;
          }

          const currentChats = yield* sql<AccountRetentionChatScope>`
            select chats.id::text,
                   chats.company_id::text as "companyId",
                   chats.user_id as "userId"
            from chats
            where chats.company_id = ${company.id}
            order by chats.id
          `;
          const currentHoldScopeKeys = accountRetentionChatScopeKeys(
            `client_company:${company.id}`,
            currentChats,
          );
          if (!sameLegalHoldScopeKeys(currentHoldScopeKeys, discoveredHoldScopeKeys)) {
            return false;
          }

          yield* sql`
            select chats.id
            from chats
            where chats.company_id = ${company.id}
            order by chats.id
            for update
          `;
          const recheckedChats = yield* sql<AccountRetentionChatScope>`
            select chats.id::text,
                   chats.company_id::text as "companyId",
                   chats.user_id as "userId"
            from chats
            where chats.company_id = ${company.id}
            order by chats.id
          `;
          const recheckedHoldScopeKeys = accountRetentionChatScopeKeys(
            `client_company:${company.id}`,
            recheckedChats,
          );
          if (!sameLegalHoldScopeKeys(recheckedHoldScopeKeys, discoveredHoldScopeKeys)) {
            return false;
          }
          if (yield* hasLegalHoldForScopes(recheckedHoldScopeKeys)) return false;

          yield* sql`
            update chats
            set deleted_at = coalesce(deleted_at, now()),
                deleted_by_user_id = coalesce(deleted_by_user_id, user_id),
                purge_after = coalesce(purge_after, now())
            where company_id = ${company.id} and deleted_at is null
          `;
        }),
      );
    }

    // Account discovery above may prepare previously-active chats. Use the
    // same aggregate candidate budget to purge those newly prepared rows so a
    // small account can complete in this run; already-prepared rows still had
    // first priority at the start of the run.
    if (budget.remaining > 0) {
      purgedChats += yield* purgeDeletedChats(budget);
    }

    let purgedUsers = 0;
    for (const user of users) {
      const purged = yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`
            select pg_advisory_xact_lock(hashtextextended(${`brief:legal-hold:user:${user.id}`}, 0))
          `;
          // Account purge deletes the complete memory/revision aggregate. It
          // must join the same user-memory lane as finalization, explicit
          // mutations, product projections, and tombstone GC. Take it before
          // discovering/acquiring membership lanes to preserve the canonical
          // memory -> membership ordering used by finalization.
          yield* sql`
            select pg_advisory_xact_lock(hashtext(${`brief:user-memory:${user.id}`}))
          `;
          const publisherCompanies = yield* sql<{ readonly id: string }>`
            select publisher_company_id::text as id
            from publisher_company_memberships
            where user_id = ${user.id}
            order by publisher_company_id::text
          `;
          const clientCompanies = yield* sql<{ readonly id: string }>`
            select company_id::text as id
            from client_company_memberships
            where user_id = ${user.id}
            order by company_id::text
          `;
          yield* lockMembershipLanes([
            ...publisherCompanies.map((company): MembershipLaneKey => `publisher:${company.id}`),
            ...clientCompanies.map((company): MembershipLaneKey => `client:${company.id}`),
          ]);
          const eligible = yield* sql<{ readonly id: string; readonly clerkUserId: string }>`
            select users.id, users.clerk_user_id as "clerkUserId"
            from platform_users users
            where users.id = ${user.id}
              and users.recovery_deleted_at is not null and users.purge_after <= now()
              and users.purged_at is null and users.legal_hold = false
              and not exists (
                select 1 from legal_holds holds
                where holds.scope_kind = 'user' and holds.scope_id = users.id
                  and holds.released_at is null
              )
              and not exists (
                select 1 from chats
                where chats.user_id = users.id and chats.shared_at is null
              )
            for update
          `;
          const current = eligible[0];
          if (current === undefined) return false;
          const currentPublisherCompanies = yield* sql<{ readonly id: string }>`
            select publisher_company_id::text as id
            from publisher_company_memberships
            where user_id = ${user.id}
            order by publisher_company_id::text
          `;
          const currentClientCompanies = yield* sql<{ readonly id: string }>`
            select company_id::text as id
            from client_company_memberships
            where user_id = ${user.id}
            order by company_id::text
          `;
          if (
            !sameOrderedIds(currentPublisherCompanies, publisherCompanies) ||
            !sameOrderedIds(currentClientCompanies, clientCompanies)
          ) {
            return false;
          }
          yield* sql`select set_config('brief.allow_account_purge', 'on', true)`;
          yield* sql`delete from user_memories where user_id = ${user.id}`;
          yield* sql`delete from platform_notifications where user_id = ${user.id}`;
          yield* sql`delete from notification_preferences where user_id = ${user.id}`;
          yield* sql`delete from client_employee_subscription_grants where user_id = ${user.id}`;
          yield* sql`delete from client_employee_ai_limits where user_id = ${user.id}`;
          yield* sql`delete from client_ai_usage_requests where user_id = ${user.id}`;
          yield* sql`delete from workspace_invitations where accepted_user_id = ${user.id}`;
          yield* sql`delete from publisher_company_memberships where user_id = ${user.id}`;
          yield* sql`
            delete from client_company_memberships memberships
            where memberships.user_id = ${user.id}
              and not exists (
                select 1 from chats
                where chats.company_id = memberships.company_id
                  and chats.user_id = memberships.user_id
              )
          `;
          yield* sql`
            insert into identity_deletion_tombstones (clerk_user_id, platform_user_id)
            values (${current.clerkUserId}, ${user.id})
            on conflict (clerk_user_id) do nothing
          `;
          yield* sql`
            update platform_users
            set primary_email = ${`deleted+${user.id}@deleted.invalid`},
                display_name = 'Deleted user',
                clerk_user_id = ${`deleted:${user.id}`},
                mfa_required = false,
                purged_at = now(),
                updated_at = now()
            where id = ${user.id}
          `;
          return true;
        }),
      );
      if (purged) purgedUsers += 1;
    }

    let purgedCompanies = 0;
    for (const company of companies) {
      const purged = yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`
            select pg_advisory_xact_lock(
              hashtextextended(${`brief:legal-hold:client_company:${company.id}`}, 0)
            )
          `;
          const eligible = yield* sql<{ readonly id: string }>`
            select companies.id::text
            from client_companies companies
            where companies.id = ${company.id}
              and companies.recovery_deleted_at is not null and companies.purge_after <= now()
              and companies.purged_at is null and companies.legal_hold = false
              and not exists (
                select 1 from legal_holds holds
                where holds.scope_kind = 'client_company'
                  and holds.scope_id = companies.id::text and holds.released_at is null
              )
              and not exists (select 1 from chats where chats.company_id = companies.id)
            for update
          `;
          if (eligible[0] === undefined) return false;
          yield* sql`select set_config('brief.allow_account_purge', 'on', true)`;
          yield* sql`delete from client_company_memberships where company_id = ${company.id}`;
          yield* sql`delete from issue_deliveries where client_company_id = ${company.id}`;
          yield* sql`delete from client_subscription_accesses where client_company_id = ${company.id}`;
          yield* sql`delete from workspace_invitations where client_company_id = ${company.id}`;
          yield* sql`
            update client_company_ai_settings
            set web_search_enabled = false, web_domain_allowlist = null, updated_at = now()
            where company_id = ${company.id}
          `;
          yield* sql`
            update company_deletion_requests
            set reason = 'company deletion completed', status = 'completed',
                resolved_at = coalesce(resolved_at, now())
            where client_company_id = ${company.id} and status <> 'completed'
          `;
          yield* sql`
            insert into client_company_deletion_tombstones (client_company_id)
            values (${company.id}) on conflict do nothing
          `;
          yield* sql`
            update client_companies
            set name = ${`Deleted client company ${company.id}`},
                clerk_organization_id = null,
                legal_name = null,
                purged_at = now(),
                updated_at = now()
            where id = ${company.id}
          `;
          return true;
        }),
      );
      if (purged) purgedCompanies += 1;
    }

    const accounting = yield* purgeExpiredAccountingRecords(budget);
    return { purgedUsers, purgedCompanies, purgedChats, accounting };
  });

interface OperationalAuditPurgeCandidate {
  readonly id: string;
  readonly holdScopeKeys: readonly string[];
}

const purgeExpiredRestrictedSupportAccessLogs = (budget: PlatformPurgeCandidateBudget) =>
  Effect.gen(function* () {
    if (budget.remaining === 0) return 0;
    const sql = yield* PgClient.PgClient;
    const candidates = yield* sql<OperationalAuditPurgeCandidate>`
      select access.id::text,
             access.hold_scope_keys as "holdScopeKeys"
      from restricted_support_access_log access
      where access.accessed_at <= now() - interval '24 months'
        and not brief_has_active_legal_hold(access.hold_scope_keys)
        and not brief_has_embedded_legal_hold(access.hold_scope_keys)
      order by access.accessed_at, access.id
      limit ${budget.remaining}
    `;
    consumePlatformPurgeCandidates(budget, candidates.length);
    let purged = 0;
    for (const candidate of candidates) {
      const deleted = yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* lockLegalHoldScopes(candidate.holdScopeKeys);
          yield* sql`select pg_advisory_xact_lock(hashtext('brief:restricted-support-access-log'))`;
          const rows = yield* sql<OperationalAuditPurgeCandidate>`
            select access.id::text,
                   access.hold_scope_keys as "holdScopeKeys"
            from restricted_support_access_log access
            where access.id = ${candidate.id}
              and access.accessed_at <= now() - interval '24 months'
            for update
          `;
          const current = rows[0];
          if (
            current === undefined ||
            !sameLegalHoldScopeKeys(current.holdScopeKeys, candidate.holdScopeKeys)
          ) {
            return false;
          }
          yield* lockEmbeddedLegalHoldRows(current.holdScopeKeys);
          const held = yield* sql<{ readonly held: boolean }>`
            select brief_has_active_legal_hold(${current.holdScopeKeys})
              or brief_has_embedded_legal_hold(${current.holdScopeKeys}) as held
          `;
          if (held[0]?.held !== false) return false;
          yield* sql`select set_config('brief.allow_audit_retention_purge', 'on', true)`;
          yield* sql`
            delete from restricted_support_access_reviews
            where access_log_id = ${candidate.id}
          `;
          const removed = yield* sql<{ readonly id: string }>`
            delete from restricted_support_access_log
            where id = ${candidate.id}
            returning id::text
          `;
          return removed.length === 1;
        }),
      );
      if (deleted) purged += 1;
    }
    return purged;
  });

const purgeExpiredRestrictedSupportGrants = (budget: PlatformPurgeCandidateBudget) =>
  Effect.gen(function* () {
    if (budget.remaining === 0) return 0;
    const sql = yield* PgClient.PgClient;
    const candidates = yield* sql<OperationalAuditPurgeCandidate>`
      select grants.id::text,
             grants.hold_scope_keys as "holdScopeKeys"
      from restricted_support_grants grants
      where grants.expires_at <= now() - interval '24 months'
        and not exists (
          select 1 from restricted_support_access_log access
          where access.grant_id = grants.id
        )
        and not brief_has_active_legal_hold(grants.hold_scope_keys)
        and not brief_has_embedded_legal_hold(grants.hold_scope_keys)
      order by grants.expires_at, grants.id
      limit ${budget.remaining}
    `;
    consumePlatformPurgeCandidates(budget, candidates.length);
    let purged = 0;
    for (const candidate of candidates) {
      const deleted = yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* lockLegalHoldScopes(candidate.holdScopeKeys);
          const rows = yield* sql<OperationalAuditPurgeCandidate>`
            select grants.id::text,
                   grants.hold_scope_keys as "holdScopeKeys"
            from restricted_support_grants grants
            where grants.id = ${candidate.id}
              and grants.expires_at <= now() - interval '24 months'
              and not exists (
                select 1 from restricted_support_access_log access
                where access.grant_id = grants.id
              )
            for update
          `;
          const current = rows[0];
          if (
            current === undefined ||
            !sameLegalHoldScopeKeys(current.holdScopeKeys, candidate.holdScopeKeys)
          ) {
            return false;
          }
          yield* lockEmbeddedLegalHoldRows(current.holdScopeKeys);
          const held = yield* sql<{ readonly held: boolean }>`
            select brief_has_active_legal_hold(${current.holdScopeKeys})
              or brief_has_embedded_legal_hold(${current.holdScopeKeys}) as held
          `;
          if (held[0]?.held !== false) return false;
          const removed = yield* sql<{ readonly id: string }>`
            delete from restricted_support_grants
            where id = ${candidate.id}
            returning id::text
          `;
          return removed.length === 1;
        }),
      );
      if (deleted) purged += 1;
    }
    return purged;
  });

const purgeExpiredAuthorizationAuditLogs = (budget: PlatformPurgeCandidateBudget) =>
  Effect.gen(function* () {
    if (budget.remaining === 0) return 0;
    const sql = yield* PgClient.PgClient;
    const candidates = yield* sql<OperationalAuditPurgeCandidate>`
      select audit.id::text,
             audit.hold_scope_keys as "holdScopeKeys"
      from platform_authorization_audit_log audit
      where audit.purge_after <= now()
        and not brief_has_active_legal_hold(audit.hold_scope_keys)
        and not brief_has_embedded_legal_hold(audit.hold_scope_keys)
      order by audit.purge_after, audit.id
      limit ${budget.remaining}
    `;
    consumePlatformPurgeCandidates(budget, candidates.length);
    let purged = 0;
    for (const candidate of candidates) {
      const deleted = yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* lockLegalHoldScopes(candidate.holdScopeKeys);
          yield* sql`
            select pg_advisory_xact_lock(hashtext('brief:platform-authorization-audit-log'))
          `;
          const rows = yield* sql<OperationalAuditPurgeCandidate>`
            select audit.id::text,
                   audit.hold_scope_keys as "holdScopeKeys"
            from platform_authorization_audit_log audit
            where audit.id = ${candidate.id}
              and audit.purge_after <= now()
            for update
          `;
          const current = rows[0];
          if (
            current === undefined ||
            !sameLegalHoldScopeKeys(current.holdScopeKeys, candidate.holdScopeKeys)
          ) {
            return false;
          }
          yield* lockEmbeddedLegalHoldRows(current.holdScopeKeys);
          const held = yield* sql<{ readonly held: boolean }>`
            select brief_has_active_legal_hold(${current.holdScopeKeys})
              or brief_has_embedded_legal_hold(${current.holdScopeKeys}) as held
          `;
          if (held[0]?.held !== false) return false;
          yield* sql`select set_config('brief.allow_audit_retention_purge', 'on', true)`;
          const removed = yield* sql<{ readonly id: string }>`
            delete from platform_authorization_audit_log
            where id = ${candidate.id}
            returning id::text
          `;
          return removed.length === 1;
        }),
      );
      if (deleted) purged += 1;
    }
    return purged;
  });

export const purgeOperationalAuditRetention = () =>
  Effect.gen(function* () {
    const budget = makePlatformPurgeCandidateBudget();
    const supportAccessLogs = yield* purgeExpiredRestrictedSupportAccessLogs(budget);
    const supportGrants = yield* purgeExpiredRestrictedSupportGrants(budget);
    const authorizationAuditLogs = yield* purgeExpiredAuthorizationAuditLogs(budget);
    return { supportAccessLogs, supportGrants, authorizationAuditLogs };
  });

interface PurgeDocumentRow {
  readonly id: string;
  readonly issueId: string;
  readonly publisherCompanyId: string;
  readonly objectKey: string;
  readonly sha256Hex: string;
  readonly byteSize: number;
  readonly deletedAt: Date;
  readonly deletedByUserId: string;
}

const reconcilePublisherUploads = (): Effect.Effect<
  number,
  unknown,
  PgClient.PgClient | PlatformFileStore
> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const fileStore = yield* PlatformFileStore;
    const candidates = yield* sql<{
      readonly id: string;
      readonly issueId: string;
      readonly idempotencyKey: string;
      readonly objectKey: string;
      readonly attempt: number;
    }>`
      select intents.id::text, intents.issue_id::text as "issueId",
             intents.idempotency_key as "idempotencyKey", intents.object_key as "objectKey",
             intents.attempt
      from publisher_document_upload_intents intents
      where intents.reconcile_after <= now()
        and intents.state <> 'finalized'
        and intents.lease_expires_at <= now()
        and not exists (
          select 1 from publisher_document_upload_events events
            where events.operation_id = intents.id
              and events.attempt = intents.attempt
            and events.event_kind in ('finalized', 'object_deleted')
        )
      order by intents.reconcile_after, intents.id
      limit ${PLATFORM_PURGE_BATCH_SIZE}
    `;
    let deleted = 0;
    let failed = 0;
    for (const candidate of candidates) {
      const outcome = yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`
            select pg_advisory_xact_lock(
              hashtextextended(
                ${`brief:publisher-upload-reservation:${candidate.issueId}:${candidate.idempotencyKey}`}, 0
              )
            )
          `;
          const current = yield* sql<{
            readonly objectKey: string;
            readonly state: string;
            readonly leaseExpired: boolean;
            readonly attempt: number;
          }>`
            select intents.object_key as "objectKey", intents.state, intents.attempt,
                   intents.lease_expires_at <= now() as "leaseExpired"
            from publisher_document_upload_intents intents
            where intents.id = ${candidate.id} and intents.reconcile_after <= now()
              and intents.state <> 'finalized'
              and intents.lease_expires_at <= now()
              and not exists (
                select 1 from publisher_document_upload_events events
                where events.operation_id = intents.id
                  and events.attempt = intents.attempt
                  and events.event_kind in ('finalized', 'object_deleted')
              )
          `;
          if (current[0] === undefined || !current[0].leaseExpired) {
            return "skipped" as const;
          }
          const removed = yield* fileStore
            .delete(current[0]!.objectKey)
            .pipe(Effect.timeout(`${PUBLISHER_UPLOAD_RECONCILE_DELETE_TIMEOUT_MS} millis`))
            .pipe(Effect.match({ onFailure: () => false, onSuccess: () => true }));
          yield* sql`
            insert into publisher_document_upload_events (
              operation_id, attempt, event_kind, error_code
            ) values (
              ${candidate.id}, ${current[0]!.attempt},
              ${removed ? "object_deleted" : "cleanup_required"},
              ${removed ? null : "object_delete_failed"}
            )
            on conflict (operation_id, attempt, event_kind) do nothing
          `;
          return removed ? ("deleted" as const) : ("failed" as const);
        }),
      );
      if (outcome === "deleted") deleted += 1;
      if (outcome === "failed") failed += 1;
    }
    if (failed > 0) return yield* Effect.fail(new Error("publisher_upload_cleanup_failed"));
    return deleted;
  });

const purgeDeletedFiles = (): Effect.Effect<
  number,
  unknown,
  PgClient.PgClient | PlatformFileStore
> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const fileStore = yield* PlatformFileStore;
    const budget = makePlatformPurgeCandidateBudget();
    const candidates = yield* sql<PurgeDocumentRow>`
      select
        documents.id::text,
        documents.issue_id::text as "issueId",
        subscriptions.publisher_company_id::text as "publisherCompanyId",
        documents.object_key as "objectKey",
        documents.sha256_hex as "sha256Hex",
        documents.byte_size::float8 as "byteSize",
        documents.deleted_at as "deletedAt",
        documents.deleted_by_user_id as "deletedByUserId"
      from brief_documents documents
      join publisher_issues issues on issues.id = documents.issue_id
      join publisher_subscriptions subscriptions on subscriptions.id = issues.subscription_id
      where documents.deleted_at is not null
        and documents.purge_after <= now()
        and documents.legal_hold = false
        and issues.status <> 'published'
        and not exists (
          select 1 from legal_holds holds
          where holds.released_at is null
            and (
              (holds.scope_kind = 'issue' and holds.scope_id = issues.id::text)
              or (
                holds.scope_kind = 'publisher_company'
                and holds.scope_id = subscriptions.publisher_company_id::text
              )
            )
        )
      order by documents.purge_after, documents.id
      limit ${budget.remaining}
    `;
    consumePlatformPurgeCandidates(budget, candidates.length);
    let purged = 0;
    for (const candidate of candidates) {
      const removed = yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`
            select pg_advisory_xact_lock(
              hashtextextended(${`brief:legal-hold:issue:${candidate.issueId}`}, 0)
            )
          `;
          yield* sql`
            select pg_advisory_xact_lock(
              hashtextextended(
                ${`brief:legal-hold:publisher_company:${candidate.publisherCompanyId}`},
                0
              )
            )
          `;
          yield* sql`select id from publisher_issues where id = ${candidate.issueId} for share`;
          const currentRows = yield* sql<PurgeDocumentRow>`
            select
              documents.id::text,
              documents.issue_id::text as "issueId",
              subscriptions.publisher_company_id::text as "publisherCompanyId",
              documents.object_key as "objectKey",
              documents.sha256_hex as "sha256Hex",
              documents.byte_size::float8 as "byteSize",
              documents.deleted_at as "deletedAt",
              documents.deleted_by_user_id as "deletedByUserId"
            from brief_documents documents
            join publisher_issues issues on issues.id = documents.issue_id
            join publisher_subscriptions subscriptions on subscriptions.id = issues.subscription_id
            where documents.id = ${candidate.id}
              and documents.deleted_at is not null
              and documents.purge_after <= now()
              and documents.legal_hold = false
              and issues.status <> 'published'
              and not exists (
                select 1 from legal_holds holds
                where holds.released_at is null
                  and (
                    (holds.scope_kind = 'issue' and holds.scope_id = issues.id::text)
                    or (
                      holds.scope_kind = 'publisher_company'
                      and holds.scope_id = subscriptions.publisher_company_id::text
                    )
                  )
              )
            for update of documents
          `;
          const current = currentRows[0];
          if (current === undefined) return null;
          // Lock the full publisher tuple in the documented order before the
          // purge flag is enabled. This keeps a concurrent extraction or
          // pointer update from racing the legal-purge delete.
          yield* sql`
            select id
            from brief_document_versions
            where brief_document_id = ${current.id}::uuid
            order by id
            for update
          `;
          yield* sql`
            select id
            from brief_document_extractions
            where brief_document_id = ${current.id}::uuid
            order by id
            for update
          `;
          const retainedReferences = yield* sql<{ readonly count: number }>`
            select (
              (select count(*) from ai_source_exposures
               where source_kind = 'document'
                 and document_id = ${current.id})
              +
              (select count(*) from assistant_message_sources
               where kind = 'document'
                 and (version_id = ${current.id}
                      or publisher_extraction_id in (
                        select id from brief_document_extractions
                        where brief_document_id = ${current.id}::uuid
                      )))
            )::int as count
          `;
          // A retained answer or exposure keeps the immutable tuple alive. Do
          // not delete the external object until every database reference is
          // gone; the next legal-purge pass can retry after retention clears.
          if ((retainedReferences[0]?.count ?? 0) > 0) return false;
          yield* sql`select set_config('brief.allow_file_purge', 'on', true)`;
          // Keep the database rows and object-store delete in one abortable
          // boundary. A timed-out provider call must leave the tombstone and
          // every immutable content row available for a later retry.
          yield* fileStore
            .delete(current.objectKey)
            .pipe(Effect.timeout(`${PLATFORM_FILE_PURGE_DELETE_TIMEOUT_MS} millis`));
          yield* sql`
            insert into purged_brief_document_tombstones (
              brief_document_id,
              issue_id,
              publisher_company_id,
              sha256_hex,
              byte_size,
              deleted_at,
              deleted_by_user_id
            )
            values (
              ${current.id},
              ${current.issueId},
              ${current.publisherCompanyId},
              ${current.sha256Hex},
              ${current.byteSize},
              ${current.deletedAt},
              ${current.deletedByUserId}
            )
            on conflict (brief_document_id) do nothing
          `;
          yield* sql`
            update brief_documents set current_version_id = null where id = ${current.id}
          `;
          yield* sql`
            delete from brief_document_extractions where brief_document_id = ${current.id}
          `;
          yield* sql`
            delete from brief_document_versions where brief_document_id = ${current.id}
          `;
          const rows = yield* sql<{ readonly id: string }>`
            delete from brief_documents
            where id = ${current.id}
            returning id::text
          `;
          return rows.length > 0;
        }),
      );
      if (removed) purged += 1;
    }
    let deletedIssues: ReadonlyArray<{
      readonly id: string;
      readonly subscriptionId: string;
      readonly publisherCompanyId: string;
      readonly deletedAt: Date;
      readonly deletedByUserId: string;
    }> = [];
    if (budget.remaining > 0) {
      deletedIssues = yield* sql<{
        readonly id: string;
        readonly subscriptionId: string;
        readonly publisherCompanyId: string;
        readonly deletedAt: Date;
        readonly deletedByUserId: string;
      }>`
        select issues.id::text, issues.subscription_id::text as "subscriptionId",
               subscriptions.publisher_company_id::text as "publisherCompanyId",
               issues.deleted_at as "deletedAt",
               issues.deleted_by_user_id as "deletedByUserId"
        from publisher_issues issues
        join publisher_subscriptions subscriptions on subscriptions.id = issues.subscription_id
        where issues.deleted_at is not null and issues.purge_after <= now()
          and not exists (
            select 1 from brief_documents documents where documents.issue_id = issues.id
          )
          and not exists (
            select 1 from legal_holds holds
            where holds.released_at is null
              and (
                (holds.scope_kind = 'issue' and holds.scope_id = issues.id::text)
                or (
                  holds.scope_kind = 'publisher_company'
                  and holds.scope_id = subscriptions.publisher_company_id::text
                )
              )
          )
        order by issues.purge_after, issues.id
        limit ${budget.remaining}
      `;
      consumePlatformPurgeCandidates(budget, deletedIssues.length);
    }
    for (const candidate of deletedIssues) {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`
            select pg_advisory_xact_lock(
              hashtextextended(${`brief:legal-hold:issue:${candidate.id}`}, 0)
            )
          `;
          yield* sql`
            select pg_advisory_xact_lock(
              hashtextextended(
                ${`brief:legal-hold:publisher_company:${candidate.publisherCompanyId}`},
                0
              )
            )
          `;
          const current = yield* sql<{
            readonly id: string;
            readonly subscriptionId: string;
            readonly deletedAt: Date;
            readonly deletedByUserId: string;
          }>`
            select issues.id::text, issues.subscription_id::text as "subscriptionId",
                   issues.deleted_at as "deletedAt",
                   issues.deleted_by_user_id as "deletedByUserId"
            from publisher_issues issues
            join publisher_subscriptions subscriptions on subscriptions.id = issues.subscription_id
            where issues.id = ${candidate.id}
              and issues.deleted_at is not null and issues.purge_after <= now()
              and not exists (
                select 1 from brief_documents documents where documents.issue_id = issues.id
              )
              and not exists (
                select 1 from legal_holds holds
                where holds.released_at is null
                  and (
                    (holds.scope_kind = 'issue' and holds.scope_id = issues.id::text)
                    or (
                      holds.scope_kind = 'publisher_company'
                      and holds.scope_id = subscriptions.publisher_company_id::text
                    )
                  )
              )
            for update of issues
          `;
          if (current[0] === undefined) return;
          yield* sql`
            insert into purged_publisher_issue_tombstones (
              issue_id, subscription_id, deleted_at, deleted_by_user_id
            ) values (
              ${current[0].id}, ${current[0].subscriptionId},
              ${current[0].deletedAt}, ${current[0].deletedByUserId}
            )
            on conflict (issue_id) do nothing
          `;
          yield* sql`select set_config('brief.allow_issue_purge', 'on', true)`;
          yield* sql`delete from publisher_issues where id = ${current[0].id}`;
        }),
      );
    }
    return purged;
  });

export const isPlatformJobKind = (kind: string): kind is PlatformJobKind =>
  platformJobKinds.has(kind as PlatformJobKind);

export const handlePlatformJob = (
  job: JobRecord,
): Effect.Effect<
  JobResult,
  unknown,
  PlatformFileStore | PdfTextExtractor | NotificationEmailService | ExportObjectStoreService
> =>
  Effect.gen(function* () {
    if (!isPlatformJobKind(job.kind)) {
      return yield* Effect.fail(new Error(`not a platform job: ${job.kind}`));
    }
    const url = yield* connectionString;
    if (job.kind === "publish_scheduled_issue") {
      const issueId = parseIdPayload(job.payload, "issueId", job.kind);
      const result = yield* runDb(url, publishIssue(issueId, job.id, false));
      return {
        status: "completed",
        message: result.cancelled
          ? `cancelled deleted issue ${issueId}`
          : `published issue ${issueId}; ${result.delivered} durable deliveries`,
      };
    }
    if (job.kind === "import_historical_issues") {
      const issueId = parseIdPayload(job.payload, "issueId", job.kind);
      const result = yield* runDb(url, publishIssue(issueId, job.id, true));
      return {
        status: "completed",
        message: result.cancelled
          ? `cancelled deleted issue ${issueId}`
          : `imported historical issue ${issueId}; ${result.delivered} durable deliveries`,
      };
    }
    if (job.kind === "extract_pdf_text") {
      const documentId = parseIdPayload(job.payload, "documentId", job.kind);
      const fileStore = yield* PlatformFileStore;
      const extractor = yield* PdfTextExtractor;
      const result = yield* runDb(
        url,
        extractPdfText(documentId, job.id).pipe(
          Effect.provideService(PlatformFileStore, fileStore),
          Effect.provideService(PdfTextExtractor, extractor),
          Effect.tapError(() => markDocumentFailure(documentId, "pdf_extraction_failed")),
        ),
      );
      return {
        status: "completed",
        message:
          result === null ? `skipped deleted PDF ${documentId}` : `extracted PDF text ${result}`,
      };
    }
    if (job.kind === "normalize_searchable_text") {
      const extractionId = parseIdPayload(job.payload, "extractionId", job.kind);
      const versionId = yield* runDb(
        url,
        normalizeSearchableText(extractionId, job.id).pipe(
          Effect.tapError(() => markExtractionFailure(extractionId, "text_normalization_failed")),
        ),
      );
      return {
        status: "completed",
        message:
          versionId === null
            ? `skipped deleted extraction ${extractionId}`
            : `normalized document version ${versionId}`,
      };
    }
    if (job.kind === "update_ai_indexing_status") {
      const issueId = parseIdPayload(job.payload, "issueId", job.kind);
      const status = yield* runDb(url, updateAiIndexingStatus(issueId));
      return { status: "completed", message: `issue ${issueId} indexing status ${status}` };
    }
    if (job.kind === "send_platform_notification") {
      const payload = parseNotificationPayload(job.payload);
      const outcome = yield* runDb(url, createPlatformNotificationForJob(payload));
      if (outcome._tag === "stale") {
        return {
          status: "completed",
          message: `platform notification ${payload.deduplicationKey} skipped stale authorization ${outcome.error.reasonCode}`,
        };
      }
      const { result } = outcome;
      return {
        status: "completed",
        message: `platform notification ${result.notificationId} ${result.inserted ? "created" : "deduplicated"}`,
      };
    }
    if (job.kind === "send_email_notification") {
      const deliveryId = parseIdPayload(job.payload, "deliveryId", job.kind);
      const adapter = yield* NotificationEmailService;
      const { appBaseUrl } = yield* loadPlatformJobConfig;
      const result = yield* runDb(url, sendEmailNotification({ deliveryId, adapter, appBaseUrl }));
      return { status: "completed", message: `email notification ${deliveryId} ${result.status}` };
    }
    if (job.kind === "process_stripe_webhook" || job.kind === "sync_billing_credit_state") {
      const stripeEventId = parseIdPayload(job.payload, "stripeEventId", job.kind);
      const result = yield* runDb(url, processStripeWebhookEvent(stripeEventId));
      return { status: "completed", message: `Stripe event ${stripeEventId} ${result.status}` };
    }
    if (job.kind === "reset_monthly_credit_counters") {
      parseEmptyPayload(job.payload, job.kind);
      const count = yield* runDb(url, expireMonthlyCreditLots());
      return { status: "completed", message: `expired ${count} monthly credit lots` };
    }
    if (job.kind === "finalize_subscription_pause") {
      const accessId = parseIdPayload(job.payload, "accessId", job.kind);
      const changed = yield* runDb(url, finalizeSubscriptionPause(accessId));
      return {
        status: "completed",
        message: `subscription access ${accessId} ${changed ? "paused" : "already paused"}`,
      };
    }
    if (job.kind === "generate_export") {
      const exportRequestId = parseIdPayload(job.payload, "exportRequestId", job.kind);
      const store = yield* ExportObjectStoreService;
      const publisherStore = yield* PlatformFileStore;
      const { exportDownloadTtlMs: expiresInMs } = yield* loadPlatformJobConfig;
      const result = yield* runDb(
        url,
        generateExport({ exportRequestId, store, publisherStore, expiresInMs }).pipe(
          Effect.tapError((error) =>
            job.attempts >= (job.maxAttempts ?? 5)
              ? failExportRequest(exportRequestId, error)
              : Effect.void,
          ),
        ),
      );
      return { status: "completed", message: `export ${exportRequestId} ${result.status}` };
    }
    if (job.kind === "purge_expired_exports") {
      parseEmptyPayload(job.payload, job.kind);
      const store = yield* ExportObjectStoreService;
      const count = yield* runDb(url, purgeExpiredExportObjects(store));
      return { status: "completed", message: `purged ${count} expired export objects` };
    }
    if (job.kind === "purge_deleted_chats") {
      parseEmptyPayload(job.payload, job.kind);
      const count = yield* runDb(url, purgeDeletedChats());
      return { status: "completed", message: `purged ${count} deleted chats` };
    }
    if (job.kind === "purge_deleted_accounts") {
      parseEmptyPayload(job.payload, job.kind);
      const result = yield* runDb(url, purgeDeletedAccounts());
      return {
        status: "completed",
        message: `purged ${result.purgedUsers} users, ${result.purgedCompanies} companies, ${result.purgedChats} account chats, ${result.accounting.usage} usage ledgers, ${result.accounting.lots} credit lots, ${result.accounting.stripeEvents} Stripe events, ${result.accounting.planChangeRequests} plan-change requests, ${result.accounting.checkoutRequests} Checkout requests, and ${result.accounting.billingAccounts} billing accounts`,
      };
    }
    if (job.kind === "purge_operational_audit_retention") {
      parseEmptyPayload(job.payload, job.kind);
      const result = yield* runDb(url, purgeOperationalAuditRetention());
      return {
        status: "completed",
        message: `purged ${result.supportAccessLogs} support accesses, ${result.supportGrants} support grants, and ${result.authorizationAuditLogs} authorization audit records`,
      };
    }
    if (job.kind === "reconcile_publisher_uploads") {
      parseEmptyPayload(job.payload, job.kind);
      const fileStore = yield* PlatformFileStore;
      const count = yield* runDb(
        url,
        reconcilePublisherUploads().pipe(Effect.provideService(PlatformFileStore, fileStore)),
      );
      return { status: "completed", message: `reconciled ${count} publisher uploads` };
    }
    parseEmptyPayload(job.payload, job.kind);
    const fileStore = yield* PlatformFileStore;
    const count = yield* runDb(
      url,
      purgeDeletedFiles().pipe(Effect.provideService(PlatformFileStore, fileStore)),
    );
    return { status: "completed", message: `purged ${count} deleted publisher files` };
  });
