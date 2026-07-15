import { PgClient } from "@effect/sql-pg";
import { Effect, Layer, Redacted } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "../db/migrate";
import type { JobKind, JobRecord } from "../jobs/types";
import {
  makeInMemoryPlatformFileStore,
  PlatformFileStore,
  type InMemoryPlatformFileStore,
} from "./file-store";
import {
  canonicalizeExtractedPages,
  handlePlatformJob,
  normalizeSearchablePageText,
  PLATFORM_FILE_PURGE_DELETE_TIMEOUT_MS,
  PUBLISHER_UPLOAD_RECONCILE_DELETE_TIMEOUT_MS,
} from "./jobs";
import { makePdfTextExtractorLayer } from "./pdf-text";
import { ExportObjectStoreService, NotificationEmailService } from "./adapters";

const isBun = typeof process.versions.bun === "string";
const databaseUrl = process.env.WORKER_POSTGRES_TEST_DATABASE_URL;
const isolatedDatabaseName = `brief_platform_jobs_test_${process.pid}_${crypto
  .randomUUID()
  .replaceAll("-", "")
  .slice(0, 8)}`;
const previousDatabaseUrl = process.env.DATABASE_URL;

const sourceDatabaseUrl = (): string => {
  if (databaseUrl === undefined) {
    throw new Error("WORKER_POSTGRES_TEST_DATABASE_URL is required");
  }
  return databaseUrl;
};

const databaseUrlForName = (name: string): string => {
  const url = new URL(sourceDatabaseUrl());
  url.pathname = `/${name}`;
  return url.toString();
};

const adminDatabaseUrl = (): string => databaseUrlForName("postgres");
const isolatedDatabaseUrl = (): string => databaseUrlForName(isolatedDatabaseName);
const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;

const runDb = <A, E>(effect: Effect.Effect<A, E, PgClient.PgClient>): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        PgClient.layer({
          url: Redacted.make(isolatedDatabaseUrl()),
          applicationName: "brief-platform-jobs-test",
        }),
      ),
    ),
  );

const runAdminDb = <A, E>(effect: Effect.Effect<A, E, PgClient.PgClient>): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        PgClient.layer({
          url: Redacted.make(adminDatabaseUrl()),
          applicationName: "brief-platform-jobs-test-admin",
        }),
      ),
    ),
  );

const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

interface PlatformFixture {
  readonly userId: string;
  readonly publisherCompanyId: string;
  readonly clientCompanyId: string;
  readonly subscriptionId: string;
  readonly accessId: string;
  readonly issueId: string;
  readonly documentId: string;
  readonly objectKey: string;
  readonly bytes: Uint8Array;
}

const provisionFixture = (options: {
  readonly status: "draft" | "scheduled";
  readonly publicationAt?: Date;
  readonly bytes?: Uint8Array;
}) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const suffix = crypto.randomUUID();
    const userId = `platform-user-${suffix}`;
    const publisherUserId = `publisher-user-${suffix}`;
    const publisherCompanyId = crypto.randomUUID();
    const clientCompanyId = crypto.randomUUID();
    const subscriptionId = crypto.randomUUID();
    const accessId = crypto.randomUUID();
    const issueId = crypto.randomUUID();
    const documentId = crypto.randomUUID();
    const objectKey = `publisher/${publisherCompanyId}/${documentId}.pdf`;
    const bytes = options.bytes ?? new TextEncoder().encode(`pdf-${suffix}`);
    const hash = yield* Effect.promise(() => sha256Hex(bytes));

    yield* sql`
      insert into platform_users (id, primary_email, display_name, clerk_user_id)
      values
        (${userId}, ${`${userId}@example.test`}, 'Client user', ${`clerk-${userId}`}),
        (${publisherUserId}, ${`${publisherUserId}@example.test`}, 'Publisher user', ${`clerk-${publisherUserId}`})
    `;
    yield* sql`
      insert into publisher_companies (id, name)
      values (${publisherCompanyId}, 'Platform publisher')
    `;
    yield* sql`
      insert into publisher_company_memberships (
        publisher_company_id, user_id, role, accepted_at
      )
      values (${publisherCompanyId}, ${publisherUserId}, 'admin', now())
    `;
    yield* sql`
      insert into publisher_subscriptions (
        id, publisher_company_id, name, created_by_user_id
      )
      values (${subscriptionId}, ${publisherCompanyId}, 'Canonical subscription', ${publisherUserId})
    `;
    yield* sql`
      insert into client_companies (id, name)
      values (${clientCompanyId}, 'Platform client')
    `;
    yield* sql`
      insert into client_company_memberships (company_id, user_id, role)
      values (${clientCompanyId}, ${userId}, 'admin')
    `;
    yield* sql`
      insert into client_company_ai_settings (company_id)
      values (${clientCompanyId})
    `;
    yield* sql`
      insert into client_subscription_accesses (
        id,
        subscription_id,
        client_company_id,
        state,
        first_admin_email,
        accepted_at,
        subscribed_at,
        created_by_user_id
      )
      values (
        ${accessId},
        ${subscriptionId},
        ${clientCompanyId},
        'active',
        ${`${userId}@example.test`},
        now() - interval '2 days',
        now() - interval '2 days',
        ${publisherUserId}
      )
    `;
    yield* sql`
      insert into client_employee_subscription_grants (
        access_id, client_company_id, user_id, granted_by_user_id
      )
      values (${accessId}, ${clientCompanyId}, ${userId}, ${userId})
    `;
    yield* sql`
      insert into publisher_issues (
        id,
        subscription_id,
        title,
        status,
        publication_at,
        created_by_user_id
      )
      values (
        ${issueId},
        ${subscriptionId},
        'Canonical issue',
        ${options.status},
        ${options.publicationAt ?? null},
        ${publisherUserId}
      )
    `;
    yield* sql`
      insert into brief_documents (
        id,
        issue_id,
        title,
        original_file_name,
        object_key,
        media_type,
        byte_size,
        sha256_hex,
        upload_completed_at,
        created_by_user_id,
        language
      )
      values (
        ${documentId},
        ${issueId},
        'Canonical PDF',
        'canonical.pdf',
        ${objectKey},
        'application/pdf',
        ${bytes.byteLength},
        ${hash},
        now(),
        ${publisherUserId},
        'en-US'
      )
    `;

    return {
      userId,
      publisherCompanyId,
      clientCompanyId,
      subscriptionId,
      accessId,
      issueId,
      documentId,
      objectKey,
      bytes,
    } satisfies PlatformFixture;
  });

const createJob = (kind: JobKind, payload: unknown) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const id = crypto.randomUUID();
    yield* sql`
      insert into jobs (id, kind, payload)
      values (${id}, ${kind}, ${sql.json(payload)})
    `;
    return { id, kind, payload, attempts: 0 } satisfies JobRecord;
  });

const findJob = (kind: JobKind, payloadKey: string, payloadValue: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<{
      readonly id: string;
      readonly kind: JobKind;
      readonly payload: unknown;
      readonly attempts: number;
    }>`
      select id::text, kind, payload, attempts
      from jobs
      where kind = ${kind}
        and payload->>${payloadKey} = ${payloadValue}
      order by created_at desc
      limit 1
    `;
    const row = rows[0];
    if (row === undefined) throw new Error(`missing ${kind} job`);
    return row satisfies JobRecord;
  });

const runPlatformJob = (
  job: JobRecord,
  fileStore: Pick<InMemoryPlatformFileStore, "layer">,
  pages: ReadonlyArray<{ readonly pageNumber: number; readonly text: string }> = [],
) =>
  Effect.runPromise(
    handlePlatformJob(job).pipe(
      Effect.provide(fileStore.layer),
      Effect.provide(makePdfTextExtractorLayer(() => Effect.succeed(pages))),
      Effect.provideService(
        NotificationEmailService,
        NotificationEmailService.of({ send: () => Promise.reject(new Error("unused")) }),
      ),
      Effect.provideService(
        ExportObjectStoreService,
        ExportObjectStoreService.of({
          verifyPhysicalDeletionSafety: () => Promise.reject(new Error("unused")),
          get: () => Promise.reject(new Error("unused")),
          head: () => Promise.reject(new Error("unused")),
          delete: () => Promise.reject(new Error("unused")),
          put: () => Promise.reject(new Error("unused")),
        }),
      ),
    ),
  );

describe("publisher text normalization", () => {
  it("normalizes Unicode, whitespace, page order, and stable offsets", () => {
    expect(normalizeSearchablePageText("  A\t\tB\r\n\r\n\r\n C  ")).toBe("A B\n\nC");
    expect(
      canonicalizeExtractedPages([
        { pageNumber: 2, text: " Second\tpage " },
        { pageNumber: 1, text: " First page " },
        { pageNumber: 3, text: "  " },
      ]),
    ).toEqual({
      text: "First page\n\nSecond page",
      pageRanges: [
        { pageNumber: 1, charStart: 0, charEnd: 10 },
        { pageNumber: 2, charStart: 12, charEnd: 23 },
      ],
    });
    expect(() =>
      canonicalizeExtractedPages([
        { pageNumber: 1, text: "one" },
        { pageNumber: 1, text: "duplicate" },
      ]),
    ).toThrow(/duplicate/i);
    expect(() => canonicalizeExtractedPages([{ pageNumber: 0, text: "invalid" }])).toThrow(
      /positive integers/i,
    );
  });
});

describe.skipIf(!isBun || !databaseUrl)("canonical platform jobs", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = isolatedDatabaseUrl();
    await runAdminDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const existing = yield* sql<{ readonly exists: boolean }>`
          select exists(select 1 from pg_database where datname = ${isolatedDatabaseName}) as exists
        `;
        if (existing[0]?.exists !== true) {
          yield* sql.unsafe(`create database ${quoteIdentifier(isolatedDatabaseName)}`);
        }
      }),
    );
    await runDb(runMigrations);
  }, 120_000);

  afterAll(async () => {
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    await runAdminDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          select pg_terminate_backend(pid)
          from pg_stat_activity
          where datname = ${isolatedDatabaseName}
            and pid <> pg_backend_pid()
        `;
        yield* sql.unsafe(`drop database if exists ${quoteIdentifier(isolatedDatabaseName)}`);
      }),
    );
  }, 60_000);

  it("publishes scheduled and historical issues durably without coupling publication to indexing", async () => {
    const scheduled = await runDb(
      provisionFixture({ status: "scheduled", publicationAt: new Date(Date.now() - 60_000) }),
    );
    const fileStore = makeInMemoryPlatformFileStore({ [scheduled.objectKey]: scheduled.bytes });
    const publishJob = await runDb(
      createJob("publish_scheduled_issue", { issueId: scheduled.issueId }),
    );
    const competingPublishJob = await runDb(
      createJob("publish_scheduled_issue", { issueId: scheduled.issueId }),
    );

    await expect(
      Promise.all([
        runPlatformJob(publishJob, fileStore),
        runPlatformJob(competingPublishJob, fileStore),
      ]),
    ).resolves.toHaveLength(2);
    await expect(runPlatformJob(publishJob, fileStore)).resolves.toMatchObject({
      status: "completed",
    });

    const publishedState = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const [issue] = yield* sql<{
          readonly status: string;
          readonly indexingStatus: string;
          readonly publishedAt: Date | null;
        }>`
          select
            status,
            indexing_status as "indexingStatus",
            published_at as "publishedAt"
          from publisher_issues
          where id = ${scheduled.issueId}
        `;
        const [counts] = yield* sql<{
          readonly deliveries: number;
          readonly notifications: number;
          readonly extractions: number;
        }>`
          select
            (select count(*)::int from issue_deliveries where issue_id = ${scheduled.issueId}) as deliveries,
            (
              select count(*)::int from jobs
              where kind = 'send_platform_notification'
                and payload->>'issueId' = ${scheduled.issueId}
            ) as notifications,
            (
              select count(*)::int from jobs
              where kind = 'extract_pdf_text'
                and payload->>'documentId' = ${scheduled.documentId}
            ) as extractions
        `;
        return { issue, counts };
      }),
    );
    expect(publishedState.issue).toMatchObject({ status: "published", indexingStatus: "pending" });
    expect(publishedState.issue?.publishedAt).toBeInstanceOf(Date);
    expect(publishedState.counts).toEqual({ deliveries: 1, notifications: 1, extractions: 1 });

    const notificationJob = await runDb(
      findJob("send_platform_notification", "issueId", scheduled.issueId),
    );
    await runPlatformJob(notificationJob, fileStore);
    await runPlatformJob(notificationJob, fileStore);
    const notificationCount = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const [row] = yield* sql<{ readonly count: number }>`
          select count(*)::int as count
          from platform_notifications
          where issue_id = ${scheduled.issueId}
            and user_id = ${scheduled.userId}
        `;
        return row!.count;
      }),
    );
    expect(notificationCount).toBe(1);

    await expect(
      runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            update issue_deliveries set historical = true where issue_id = ${scheduled.issueId}
          `;
        }),
      ),
    ).rejects.toBeDefined();

    const historical = await runDb(provisionFixture({ status: "draft" }));
    const historicalStore = makeInMemoryPlatformFileStore({
      [historical.objectKey]: historical.bytes,
    });
    const importJob = await runDb(
      createJob("import_historical_issues", { issueId: historical.issueId }),
    );
    await runPlatformJob(importJob, historicalStore);
    const historicalState = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const [row] = yield* sql<{
          readonly historical: boolean;
          readonly deliveries: number;
          readonly notifications: number;
        }>`
          select
            issues.historical,
            (select count(*)::int from issue_deliveries where issue_id = issues.id) as deliveries,
            (
              select count(*)::int from jobs
              where kind = 'send_platform_notification'
                and payload->>'issueId' = issues.id::text
            ) as notifications
          from publisher_issues issues
          where issues.id = ${historical.issueId}
        `;
        return row;
      }),
    );
    expect(historicalState).toEqual({ historical: true, deliveries: 1, notifications: 0 });
  });

  it("enforces schedule, payload, and delivery-end gates", async () => {
    const fileStore = makeInMemoryPlatformFileStore();
    const future = await runDb(
      provisionFixture({ status: "scheduled", publicationAt: new Date(Date.now() + 60_000) }),
    );
    const futureJob = await runDb(
      createJob("publish_scheduled_issue", { issueId: future.issueId }),
    );
    await expect(runPlatformJob(futureJob, fileStore)).rejects.toThrow(/not due/i);

    const invalidPayloadJob = await runDb(
      createJob("publish_scheduled_issue", { issueId: future.issueId, ignored: true }),
    );
    await expect(runPlatformJob(invalidPayloadJob, fileStore)).rejects.toThrow(/exactly/i);

    const ended = await runDb(
      provisionFixture({ status: "scheduled", publicationAt: new Date(Date.now() - 60_000) }),
    );
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update client_subscription_accesses
          set state = 'ending', delivery_end_at = now() - interval '1 day'
          where id = ${ended.accessId}
        `;
      }),
    );
    const endedJob = await runDb(createJob("publish_scheduled_issue", { issueId: ended.issueId }));
    await runPlatformJob(endedJob, fileStore);

    const continuing = await runDb(
      provisionFixture({ status: "scheduled", publicationAt: new Date(Date.now() - 60_000) }),
    );
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update client_subscription_accesses
          set state = 'ending', delivery_end_at = now() + interval '1 day'
          where id = ${continuing.accessId}
        `;
      }),
    );
    const continuingJob = await runDb(
      createJob("publish_scheduled_issue", { issueId: continuing.issueId }),
    );
    await runPlatformJob(continuingJob, fileStore);

    const deliveryCounts = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const [row] = yield* sql<{ readonly ended: number; readonly continuing: number }>`
          select
            (select count(*)::int from issue_deliveries where issue_id = ${ended.issueId}) as ended,
            (
              select count(*)::int from issue_deliveries where issue_id = ${continuing.issueId}
            ) as continuing
        `;
        return row;
      }),
    );
    expect(deliveryCounts).toEqual({ ended: 0, continuing: 1 });
  });

  it("extracts, verifies, normalizes, indexes, and replays immutable outcomes", async () => {
    const fixture = await runDb(provisionFixture({ status: "draft" }));
    const fileStore = makeInMemoryPlatformFileStore({ [fixture.objectKey]: fixture.bytes });
    const extractionJob = await runDb(
      createJob("extract_pdf_text", { documentId: fixture.documentId }),
    );
    const competingExtractionJob = await runDb(
      createJob("extract_pdf_text", { documentId: fixture.documentId }),
    );
    const pages = [
      { pageNumber: 2, text: " Second\tpage " },
      { pageNumber: 1, text: " First page " },
      { pageNumber: 3, text: " " },
    ] as const;

    await Promise.all([
      runPlatformJob(extractionJob, fileStore, pages),
      runPlatformJob(competingExtractionJob, fileStore, pages),
    ]);
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          delete from jobs
          where kind = 'normalize_searchable_text'
            and payload->>'extractionId' = (
              select id::text from brief_document_extractions
              where brief_document_id = ${fixture.documentId}
            )
        `;
      }),
    );
    // A retry after an extraction outcome but before its downstream enqueue
    // recreates the missing normalization job instead of silently stopping.
    await runPlatformJob(extractionJob, fileStore, pages);
    const normalizationJob = await runDb(
      findJob(
        "normalize_searchable_text",
        "extractionId",
        await runDb(
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            const [row] = yield* sql<{ readonly id: string }>`
              select id::text from brief_document_extractions
              where brief_document_id = ${fixture.documentId}
            `;
            return row!.id;
          }),
        ),
      ),
    );
    await runPlatformJob(normalizationJob, fileStore, pages);
    await runPlatformJob(normalizationJob, fileStore, pages);
    const indexingJob = await runDb(
      findJob("update_ai_indexing_status", "issueId", fixture.issueId),
    );
    await runPlatformJob(indexingJob, fileStore, pages);

    const indexed = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const [row] = yield* sql<{
          readonly text: string;
          readonly pageRanges: unknown;
          readonly issueStatus: string;
          readonly extractionCount: number;
          readonly versionCount: number;
          readonly searchable: boolean;
        }>`
          select
            versions.canonical_text as text,
            versions.page_ranges as "pageRanges",
            issues.indexing_status as "issueStatus",
            (
              select count(*)::int from brief_document_extractions
              where brief_document_id = documents.id
            ) as "extractionCount",
            (
              select count(*)::int from brief_document_versions
              where brief_document_id = documents.id
            ) as "versionCount",
            versions.search_vector @@ plainto_tsquery(
              language_to_regconfig(versions.language),
              'First'
            ) as searchable
          from brief_documents documents
          join brief_document_versions versions on versions.id = documents.current_version_id
          join publisher_issues issues on issues.id = documents.issue_id
          where documents.id = ${fixture.documentId}
        `;
        return row;
      }),
    );
    expect(indexed).toEqual({
      text: "First page\n\nSecond page",
      pageRanges: [
        { pageNumber: 1, charStart: 0, charEnd: 10 },
        { pageNumber: 2, charStart: 12, charEnd: 23 },
      ],
      issueStatus: "ready",
      extractionCount: 1,
      versionCount: 1,
      searchable: true,
    });

    await expect(
      runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
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
              ${fixture.documentId},
              ${crypto.randomUUID().replaceAll("-", "")},
              'en-US',
              'invalid ranges',
              14,
              '[{"pageNumber":1,"charStart":1,"charEnd":14}]'::jsonb,
              ${normalizationJob.id}
            )
          `;
        }),
      ),
    ).rejects.toBeDefined();

    await expect(
      runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              const [chat] = yield* sql<{ readonly id: string }>`
                insert into chats (company_id, user_id)
                values (${fixture.clientCompanyId}, ${fixture.userId})
                returning id::text
              `;
              const [assistant] = yield* sql<{ readonly id: string }>`
                insert into chat_messages (chat_id, author, content)
                values (${chat!.id}, 'assistant', 'answer')
                returning id::text
              `;
              const missingVersionId = crypto.randomUUID();
              yield* sql`
                insert into assistant_message_sources (
                  assistant_message_id,
                  source_key,
                  kind,
                  locator,
                  document_version_id,
                  public_provenance
                )
                values (
                  ${assistant!.id},
                  'doc-missing',
                  'document',
                  ${sql.json({ kind: "document", documentVersionId: missingVersionId })},
                  ${missingVersionId},
                  '{}'::jsonb
                )
              `;
            }),
          );
        }),
      ),
    ).rejects.toBeDefined();

    const badFixture = await runDb(provisionFixture({ status: "draft" }));
    const badStore = makeInMemoryPlatformFileStore({
      [badFixture.objectKey]: new TextEncoder().encode("tampered"),
    });
    const badJob = await runDb(
      createJob("extract_pdf_text", { documentId: badFixture.documentId }),
    );
    await expect(runPlatformJob(badJob, badStore, pages)).rejects.toThrow(/SHA-256/i);
    const failure = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const [row] = yield* sql<{
          readonly status: string;
          readonly code: string;
          readonly documentCode: string;
        }>`
          select
            issues.indexing_status as status,
            issues.indexing_error_code as code,
            documents.indexing_error_code as "documentCode"
          from publisher_issues issues
          join brief_documents documents on documents.issue_id = issues.id
          where issues.id = ${badFixture.issueId}
        `;
        return row;
      }),
    );
    expect(failure).toEqual({
      status: "failed",
      code: "pdf_extraction_failed",
      documentCode: "pdf_extraction_failed",
    });

    const repairedStore = makeInMemoryPlatformFileStore({
      [badFixture.objectKey]: badFixture.bytes,
    });
    await runPlatformJob(badJob, repairedStore, pages);
    const repairedExtraction = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const [row] = yield* sql<{ readonly id: string }>`
          select id::text from brief_document_extractions
          where brief_document_id = ${badFixture.documentId}
        `;
        return row!.id;
      }),
    );
    const repairedNormalization = await runDb(
      findJob("normalize_searchable_text", "extractionId", repairedExtraction),
    );
    await runPlatformJob(repairedNormalization, repairedStore, pages);
    const repairedIndexing = await runDb(
      findJob("update_ai_indexing_status", "issueId", badFixture.issueId),
    );
    await runPlatformJob(repairedIndexing, repairedStore, pages);
    const repaired = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const [row] = yield* sql<{
          readonly status: string;
          readonly issueCode: string | null;
          readonly documentCode: string | null;
        }>`
          select
            issues.indexing_status as status,
            issues.indexing_error_code as "issueCode",
            documents.indexing_error_code as "documentCode"
          from publisher_issues issues
          join brief_documents documents on documents.issue_id = issues.id
          where issues.id = ${badFixture.issueId}
        `;
        return row;
      }),
    );
    expect(repaired).toEqual({ status: "ready", issueCode: null, documentCode: null });
  });

  it("honors legal holds and retains only content-free chat purge accounting", async () => {
    const fixture = await runDb(provisionFixture({ status: "draft" }));
    const chatState = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const chatId = crypto.randomUUID();
        const messageId = crypto.randomUUID();
        const runId = crypto.randomUUID();
        yield* sql`
          insert into chats (
            id, company_id, user_id, deleted_at, deleted_by_user_id, purge_after
          )
          values (
            ${chatId},
            ${fixture.clientCompanyId},
            ${fixture.userId},
            now() - interval '1 day',
            ${fixture.userId},
            now() - interval '1 second'
          )
        `;
        yield* sql`
          insert into chat_subscription_sources (
            chat_id, access_id, client_company_id, subscription_id
          )
          values (
            ${chatId}, ${fixture.accessId}, ${fixture.clientCompanyId}, ${fixture.subscriptionId}
          )
        `;
        yield* sql`
          insert into chat_messages (id, chat_id, author, content)
          values (${messageId}, ${chatId}, 'user', 'sensitive chat content')
        `;
        yield* sql`
          insert into ai_runs (
            id, chat_id, user_message_id, locale, market, finished_at
          )
          values (${runId}, ${chatId}, ${messageId}, 'en-US', 'US', now())
        `;
        yield* sql`
          insert into ai_run_usage (
            run_id,
            task_id,
            loop_iteration,
            attempt,
            provider_request_index,
            agent_role,
            model_id,
            provider_service_id,
            input_tokens,
            output_tokens,
            cached_tokens,
            reasoning_tokens,
            total_tokens,
            stop_reason
          )
          values (
            ${runId}, 'answer', 0, 0, 0, 'answer', 'test-model',
            'deterministic_test', 11, 7, 0, 0, 18, 'stop'
          )
        `;
        yield* sql`
          insert into ai_external_tool_usage (
            run_id,
            task_id,
            loop_iteration,
            attempt,
            tool_request_index,
            provider_service_id,
            operation,
            status,
            result_count,
            response_bytes,
            duration_ms
          )
          values
            (${runId}, 'research', 0, 0, 0, 'test-web', 'web_search', 'ok', 1, 10, 2),
            (${runId}, 'research', 0, 0, 1, 'test-web', 'web_fetch', 'ok', 1, 20, 3)
        `;
        yield* sql`
          insert into ai_source_exposures (
            run_id,
            task_id,
            loop_iteration,
            attempt,
            provider_request_index,
            source_kind,
            logical_source_identity,
            content_item_identity,
            exposure_stage,
            visible_token_count
          )
          values (${runId}, 'answer', 0, 0, 0, 'web', 'https://example.test', 'quote-1', 'provider', 4)
        `;
        yield* sql`
          insert into legal_holds (scope_kind, scope_id, reason, placed_by_user_id)
          values ('chat', ${chatId}::text, 'litigation hold', 'legal-admin')
        `;
        return { chatId, runId };
      }),
    );
    const purgeJob = await runDb(createJob("purge_deleted_chats", {}));
    const fileStore = makeInMemoryPlatformFileStore();
    expect((await runPlatformJob(purgeJob, fileStore)).message).toContain("purged 0");

    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update legal_holds
          set released_at = now(), released_by_user_id = 'legal-admin'
          where scope_kind = 'chat' and scope_id = ${chatState.chatId}
        `;
      }),
    );
    expect((await runPlatformJob(purgeJob, fileStore)).message).toContain("purged 1");
    expect((await runPlatformJob(purgeJob, fileStore)).message).toContain("purged 0");

    const retained = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const [row] = yield* sql<{
          readonly chats: number;
          readonly messages: number;
          readonly runs: number;
          readonly inputTokens: number;
          readonly outputTokens: number;
          readonly requests: number;
          readonly searches: number;
          readonly fetches: number;
          readonly exposed: number;
          readonly hasContentColumn: boolean;
        }>`
          select
            (select count(*)::int from chats where id = ${chatState.chatId}) as chats,
            (select count(*)::int from chat_messages where chat_id = ${chatState.chatId}) as messages,
            (select count(*)::int from ai_runs where id = ${chatState.runId}) as runs,
            tombstones.model_input_tokens::int as "inputTokens",
            tombstones.model_output_tokens::int as "outputTokens",
            tombstones.model_request_count::int as requests,
            tombstones.web_search_count::int as searches,
            tombstones.web_fetch_count::int as fetches,
            tombstones.exposed_item_count::int as exposed,
            exists (
              select 1 from information_schema.columns
              where table_name = 'deleted_chat_tombstones'
                and column_name in ('content', 'messages', 'prompt', 'response')
            ) as "hasContentColumn"
          from deleted_chat_tombstones tombstones
          where tombstones.chat_id = ${chatState.chatId}
        `;
        return row;
      }),
    );
    expect(retained).toEqual({
      chats: 0,
      messages: 0,
      runs: 0,
      inputTokens: 11,
      outputTokens: 7,
      requests: 1,
      searches: 1,
      fetches: 1,
      exposed: 1,
      hasContentColumn: false,
    });
  });

  it("purges only expired, held-free, unpublished files and leaves a content-free tombstone", async () => {
    const fixture = await runDb(provisionFixture({ status: "draft" }));
    const fileStore = makeInMemoryPlatformFileStore({ [fixture.objectKey]: fixture.bytes });
    const pages = [{ pageNumber: 1, text: "Retained until purge" }] as const;
    const extractionJob = await runDb(
      createJob("extract_pdf_text", { documentId: fixture.documentId }),
    );
    await runPlatformJob(extractionJob, fileStore, pages);
    const [extraction] = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql<{ readonly id: string }>`
          select id::text from brief_document_extractions
          where brief_document_id = ${fixture.documentId}
        `;
      }),
    );
    const normalizationJob = await runDb(
      findJob("normalize_searchable_text", "extractionId", extraction!.id),
    );
    await runPlatformJob(normalizationJob, fileStore, pages);

    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update brief_documents
          set
            deleted_at = now() - interval '1 day',
            deleted_by_user_id = ${fixture.userId},
            purge_after = now() - interval '1 second'
          where id = ${fixture.documentId}
        `;
        yield* sql`
          insert into legal_holds (scope_kind, scope_id, reason, placed_by_user_id)
          values ('issue', ${fixture.issueId}::text, 'publisher litigation', 'legal-admin')
        `;
      }),
    );
    const purgeJob = await runDb(createJob("purge_deleted_files", {}));
    expect((await runPlatformJob(purgeJob, fileStore)).message).toContain("purged 0");
    expect(fileStore.files.has(fixture.objectKey)).toBe(true);

    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update legal_holds
          set released_at = now(), released_by_user_id = 'legal-admin'
          where scope_kind = 'issue' and scope_id = ${fixture.issueId}
        `;
      }),
    );
    expect((await runPlatformJob(purgeJob, fileStore)).message).toContain("purged 1");
    expect((await runPlatformJob(purgeJob, fileStore)).message).toContain("purged 0");
    expect(fileStore.files.has(fixture.objectKey)).toBe(false);
    expect(fileStore.deletedKeys).toEqual([fixture.objectKey]);

    const state = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const [row] = yield* sql<{
          readonly documents: number;
          readonly extractions: number;
          readonly versions: number;
          readonly tombstones: number;
        }>`
          select
            (select count(*)::int from brief_documents where id = ${fixture.documentId}) as documents,
            (
              select count(*)::int from brief_document_extractions
              where brief_document_id = ${fixture.documentId}
            ) as extractions,
            (
              select count(*)::int from brief_document_versions
              where brief_document_id = ${fixture.documentId}
            ) as versions,
            (
              select count(*)::int from purged_brief_document_tombstones
              where brief_document_id = ${fixture.documentId}
            ) as tombstones
        `;
        return row;
      }),
    );
    expect(state).toEqual({ documents: 0, extractions: 0, versions: 0, tombstones: 1 });
  });

  it("purges a recoverably deleted issue only after every object is deleted", async () => {
    const fixture = await runDb(provisionFixture({ status: "draft" }));
    const fileStore = makeInMemoryPlatformFileStore({ [fixture.objectKey]: fixture.bytes });
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update publisher_issues
          set deleted_at = now() - interval '1 day',
              deleted_by_user_id = ${fixture.userId}, purge_after = now() - interval '1 second'
          where id = ${fixture.issueId}
        `;
        yield* sql`
          update brief_documents
          set deleted_at = now() - interval '1 day',
              deleted_by_user_id = ${fixture.userId}, purge_after = now() - interval '1 second'
          where id = ${fixture.documentId}
        `;
      }),
    );
    const job = await runDb(createJob("purge_deleted_files", {}));
    expect((await runPlatformJob(job, fileStore)).message).toContain("purged 1");
    const state = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{
          readonly issues: number;
          readonly documents: number;
          readonly issueTombstones: number;
          readonly documentTombstones: number;
        }>`
          select
            (select count(*)::int from publisher_issues where id = ${fixture.issueId}) as issues,
            (select count(*)::int from brief_documents where id = ${fixture.documentId}) as documents,
            (select count(*)::int from purged_publisher_issue_tombstones
             where issue_id = ${fixture.issueId}) as "issueTombstones",
            (select count(*)::int from purged_brief_document_tombstones
             where brief_document_id = ${fixture.documentId}) as "documentTombstones"
        `)[0]!;
      }),
    );
    expect(state).toEqual({
      issues: 0,
      documents: 0,
      issueTombstones: 1,
      documentTombstones: 1,
    });
  });

  it(
    "cancels a hung normal file purge delete while retaining the durable row",
    async () => {
      const fixture = await runDb(provisionFixture({ status: "draft" }));
      await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            update brief_documents
            set deleted_at = now() - interval '1 day',
                deleted_by_user_id = ${fixture.userId}, purge_after = now() - interval '1 second'
            where id = ${fixture.documentId}
          `;
        }),
      );
      let providerAborted = false;
      const layer = Layer.succeed(
        PlatformFileStore,
        PlatformFileStore.of({
          get: () => Effect.fail(new Error("unused")),
          delete: () =>
            Effect.tryPromise({
              try: (signal) =>
                new Promise<void>((_resolve, reject) => {
                  signal.addEventListener(
                    "abort",
                    () => {
                      providerAborted = true;
                      reject(signal.reason);
                    },
                    { once: true },
                  );
                }),
              catch: (cause) => new Error("normal purge delete interrupted", { cause }),
            }),
        }),
      );
      const job = await runDb(createJob("purge_deleted_files", {}));
      await expect(runPlatformJob(job, { layer })).rejects.toThrow();
      expect(providerAborted).toBe(true);
      const state = await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return (yield* sql<{ readonly documents: number; readonly tombstones: number }>`
            select
              (select count(*)::int from brief_documents where id = ${fixture.documentId}) as documents,
              (select count(*)::int from purged_brief_document_tombstones
               where brief_document_id = ${fixture.documentId}) as tombstones
          `)[0]!;
        }),
      );
      expect(state).toEqual({ documents: 1, tombstones: 0 });
    },
    PLATFORM_FILE_PURGE_DELETE_TIMEOUT_MS + 10_000,
  );

  it("retries durable orphan-upload cleanup idempotently", async () => {
    const fixture = await runDb(provisionFixture({ status: "draft" }));
    const operationId = crypto.randomUUID();
    const documentId = crypto.randomUUID();
    const objectKey = `publisher-issues/${fixture.issueId}/documents/${documentId}.pdf`;
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          insert into publisher_document_upload_intents (
            id, document_id, issue_id, idempotency_key, object_key, expected_sha256_hex,
            byte_size, actor_user_id, actor_organization_id, actor_session_id, actor_mode,
            title, original_file_name, media_type, request_id, attempt, lease_token, lease_expires_at, state,
            created_at, reconcile_after
          ) values (
            ${operationId}, ${documentId}, ${fixture.issueId}, 'reconcile-upload-key-0001', ${objectKey}, ${"d".repeat(64)},
            8, ${fixture.userId}, null, 'reconcile-session', 'demo',
            'Orphaned upload', 'orphaned.pdf', 'application/pdf', ${crypto.randomUUID()}, 1, ${crypto.randomUUID()},
            now() - interval '2 seconds', 'processing',
            now() - interval '2 seconds', now() - interval '1 second'
          )
        `;
        yield* sql`
          update publisher_document_upload_intents
          set state = 'retryable'
          where id = ${operationId}
        `;
        yield* sql`
          insert into publisher_document_upload_events (
            operation_id, event_kind, error_code
          ) values (${operationId}, 'cleanup_required', 'object_delete_failed')
        `;
      }),
    );
    const bytes = new TextEncoder().encode("orphaned");
    const fileStore = makeInMemoryPlatformFileStore({ [objectKey]: bytes });
    const job = await runDb(createJob("reconcile_publisher_uploads", {}));
    expect((await runPlatformJob(job, fileStore)).message).toContain("reconciled 1");
    expect((await runPlatformJob(job, fileStore)).message).toContain("reconciled 0");
    expect(fileStore.files.has(objectKey)).toBe(false);
    expect(fileStore.deletedKeys).toEqual([objectKey]);
    // A later retry owns a new attempt. Its replacement object must remain
    // eligible even though attempt 1 already recorded object_deleted.
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update publisher_document_upload_intents
          set state = 'processing', attempt = attempt + 1,
              lease_token = gen_random_uuid(), lease_expires_at = now() - interval '1 second',
              reconcile_after = now() - interval '1 second'
          where id = ${operationId}
        `;
      }),
    );
    await expect(
      runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            insert into publisher_document_upload_events (
              operation_id, attempt, event_kind
            ) values (${operationId}, 1, 'finalized')
          `;
        }),
      ),
    ).rejects.toThrow();
    const staleEvidenceCount = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{ readonly count: number }>`
          select count(*)::int as count
          from publisher_document_upload_events
          where operation_id = ${operationId}
            and attempt = 1
            and event_kind = 'finalized'
        `)[0]!.count;
      }),
    );
    expect(staleEvidenceCount).toBe(0);
    fileStore.files.set(objectKey, bytes);
    const retryJob = await runDb(createJob("reconcile_publisher_uploads", {}));
    expect((await runPlatformJob(retryJob, fileStore)).message).toContain("reconciled 1");
    expect(fileStore.files.has(objectKey)).toBe(false);
    expect(fileStore.deletedKeys).toEqual([objectKey, objectKey]);
    const events = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql<{ readonly eventKind: string; readonly attempt: number }>`
          select event_kind as "eventKind", attempt from publisher_document_upload_events
          where operation_id = ${operationId} order by id
        `;
      }),
    );
    expect(events).toEqual([
      { eventKind: "cleanup_required", attempt: 1 },
      { eventKind: "object_deleted", attempt: 1 },
      { eventKind: "object_deleted", attempt: 2 },
    ]);
  });

  it(
    "interrupts an orphan-upload provider delete at the exact reconciliation timeout",
    async () => {
      const fixture = await runDb(provisionFixture({ status: "draft" }));
      const operationId = crypto.randomUUID();
      const documentId = crypto.randomUUID();
      const objectKey = `publisher-issues/${fixture.issueId}/documents/${documentId}.pdf`;
      await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            insert into publisher_document_upload_intents (
              id, document_id, issue_id, idempotency_key, object_key, expected_sha256_hex,
              byte_size, actor_user_id, actor_organization_id, actor_session_id, actor_mode,
              title, original_file_name, media_type, request_id, attempt, lease_token,
              lease_expires_at, state, created_at, reconcile_after
            ) values (
              ${operationId}, ${documentId}, ${fixture.issueId},
              'reconcile-upload-timeout-0001', ${objectKey}, ${"e".repeat(64)}, 8,
              ${fixture.userId}, null, 'reconcile-timeout-session', 'demo',
              'Timed-out orphan', 'timed-out.pdf', 'application/pdf', ${crypto.randomUUID()},
              1, ${crypto.randomUUID()}, now() - interval '2 seconds', 'processing',
              now() - interval '2 seconds', now() - interval '1 second'
            )
          `;
          yield* sql`
            update publisher_document_upload_intents
            set state = 'retryable'
            where id = ${operationId}
          `;
        }),
      );

      let providerAborted = false;
      const layer = Layer.succeed(
        PlatformFileStore,
        PlatformFileStore.of({
          get: () => Effect.fail(new Error("unused")),
          delete: () =>
            Effect.tryPromise({
              try: (signal) =>
                new Promise<void>((_resolve, reject) => {
                  signal.addEventListener(
                    "abort",
                    () => {
                      providerAborted = true;
                      reject(signal.reason);
                    },
                    { once: true },
                  );
                }),
              catch: (cause) => new Error("provider delete interrupted", { cause }),
            }),
        }),
      );
      const job = await runDb(createJob("reconcile_publisher_uploads", {}));
      const startedAt = Date.now();
      await expect(runPlatformJob(job, { layer })).rejects.toThrow(
        /publisher_upload_cleanup_failed/,
      );
      const elapsedMs = Date.now() - startedAt;

      expect(providerAborted).toBe(true);
      expect(elapsedMs).toBeGreaterThanOrEqual(PUBLISHER_UPLOAD_RECONCILE_DELETE_TIMEOUT_MS - 500);
      expect(elapsedMs).toBeLessThan(PUBLISHER_UPLOAD_RECONCILE_DELETE_TIMEOUT_MS + 5_000);
      const events = await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return yield* sql<{ readonly eventKind: string; readonly errorCode: string | null }>`
            select event_kind as "eventKind", error_code as "errorCode"
            from publisher_document_upload_events
            where operation_id = ${operationId}
            order by id
          `;
        }),
      );
      expect(events).toEqual([
        { eventKind: "cleanup_required", errorCode: "object_delete_failed" },
      ]);
    },
    PUBLISHER_UPLOAD_RECONCILE_DELETE_TIMEOUT_MS + 10_000,
  );

  it("purges support and authorization audit records only after the exact 24-month window", async () => {
    const fixture = await runDb(provisionFixture({ status: "draft" }));
    const ids = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          insert into platform_admins (user_id, role)
          values ('retention-support', 'support'), ('retention-security', 'security')
        `;
        const chats = yield* sql<{ readonly id: string }>`
          insert into chats (company_id, user_id, memory_mode)
          values (${fixture.clientCompanyId}, ${fixture.userId}, 'disabled')
          returning id::text
        `;
        const chatId = chats[0]!.id;
        const grants = yield* sql<{ readonly id: string }>`
          insert into restricted_support_grants (
            actor_user_id, reason, scope_kind, scope_id, client_company_id,
            affected_user_id, approval_skipped_reason, granted_by_user_id,
            granted_at, expires_at
          ) values (
            'retention-support', 'Historical security investigation', 'client_chat',
            ${chatId}, ${fixture.clientCompanyId}, ${fixture.userId},
            'Security incident required prompt response', 'retention-security',
            now() - interval '25 months', now() - interval '25 months' + interval '1 hour'
          )
          returning id::text
        `;
        yield* sql`
          insert into restricted_support_access_log (
            grant_id, actor_user_id, reason, scope_kind, scope_id, client_company_id,
            affected_user_id, approval_skipped_reason, accessed_at
          ) values (
            ${grants[0]!.id}, 'retention-support', 'Historical security investigation',
            'client_chat', ${chatId}, ${fixture.clientCompanyId}, ${fixture.userId},
            'Security incident required prompt response',
            now() - interval '25 months' + interval '30 minutes'
          )
        `;
        yield* sql`
          insert into platform_authorization_audit_log (
            actor_user_id, session_id, request_id, action, scope_kind, scope_id,
            outcome, occurred_at
          ) values (
            'retention-security', 'retention-session', ${crypto.randomUUID()},
            'platform.issue.restrict', 'issue', ${fixture.issueId}, 'succeeded',
            now() - interval '25 months'
          )
        `;
        return { grantId: grants[0]!.id, chatId };
      }),
    );
    const job = await runDb(createJob("purge_operational_audit_retention", {}));
    const result = await runPlatformJob(job, makeInMemoryPlatformFileStore());
    expect(result.message).toContain(
      "purged 1 support accesses, 1 support grants, and 1 authorization audit records",
    );

    const counts = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{
          readonly accesses: number;
          readonly grants: number;
          readonly audits: number;
        }>`
          select
            (select count(*)::int from restricted_support_access_log
             where grant_id = ${ids.grantId}) accesses,
            (select count(*)::int from restricted_support_grants
             where id = ${ids.grantId}) grants,
            (select count(*)::int from platform_authorization_audit_log
             where scope_id = ${fixture.issueId}) audits
        `)[0]!;
      }),
    );
    expect(counts).toEqual({ accesses: 0, grants: 0, audits: 0 });
  });
});
