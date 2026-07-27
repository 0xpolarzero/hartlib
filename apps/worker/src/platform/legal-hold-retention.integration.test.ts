import { PgClient } from "@effect/sql-pg";
import { Effect, Redacted } from "effect";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeRunAcceptanceScope } from "@brief/shared/chat";

import { purgeUserMemoryTombstones } from "../ai/product-state/retention";
import { runMigrations } from "../db/migrate";
import type { JobRecord } from "../jobs/types";
import {
  ExportObjectStoreService,
  NotificationEmailService,
  type ExportObjectStore,
} from "./adapters";
import { purgeExpiredExportObjects } from "./exports";
import { makeInMemoryPlatformFileStore } from "./file-store";
import { handlePlatformJob, purgeDeletedAccounts, purgeOperationalAuditRetention } from "./jobs";
import { makePdfTextExtractorLayer } from "./pdf-text";

const isBun = typeof process.versions.bun === "string";
const databaseUrl = process.env.WORKER_POSTGRES_TEST_DATABASE_URL;
const databaseName = `brief_legal_hold_retention_${process.pid}_${crypto
  .randomUUID()
  .replaceAll("-", "")
  .slice(0, 8)}`;
const priorDatabaseUrl = process.env.DATABASE_URL;

const sourceUrl = (): string => {
  if (databaseUrl === undefined) {
    throw new Error("WORKER_POSTGRES_TEST_DATABASE_URL is required");
  }
  return databaseUrl;
};

const databaseUrlFor = (name: string): string => {
  const url = new URL(sourceUrl());
  url.pathname = `/${name}`;
  return url.toString();
};

const testUrl = () => databaseUrlFor(databaseName);
const adminUrl = () => databaseUrlFor("postgres");
const quoted = (value: string): string => `"${value.replaceAll('"', '""')}"`;

const runDb = <A, E>(
  effect: Effect.Effect<A, E, PgClient.PgClient>,
  applicationName = "brief-legal-hold-retention-test",
  url = testUrl(),
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        PgClient.layer({
          url: Redacted.make(url),
          applicationName,
        }),
      ),
    ),
  );

const waitForAdvisoryWait = async (applicationName: string): Promise<void> => {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const waiting = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const rows = yield* sql<{ readonly waiting: boolean }>`
          select exists (
            select 1 from pg_stat_activity
            where datname = current_database()
              and application_name = ${applicationName}
              and wait_event_type = 'Lock'
              and wait_event = 'advisory'
          ) as waiting
        `;
        return rows[0]?.waiting === true;
      }),
      "brief-legal-hold-race-inspector",
    );
    if (waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${applicationName} did not reach the legal-hold advisory lock`);
};

interface PlatformFixture {
  readonly userId: string;
  readonly publisherCompanyId: string;
  readonly clientCompanyId: string;
  readonly subscriptionId: string;
  readonly issueId: string;
  readonly documentId: string;
  readonly chatId: string;
}

const seedPlatformFixture = (label: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const suffix = `${label}-${crypto.randomUUID()}`;
    const userId = `held-user-${suffix}`;
    const publisherUserId = `publisher-user-${suffix}`;
    const publisherCompanyId = crypto.randomUUID();
    const clientCompanyId = crypto.randomUUID();
    const subscriptionId = crypto.randomUUID();
    const issueId = crypto.randomUUID();
    const documentId = crypto.randomUUID();
    const chatId = crypto.randomUUID();

    yield* sql`
      insert into platform_users (id, primary_email, display_name, clerk_user_id)
      values
        (${userId}, ${`${userId}@example.test`}, 'Held user', ${`clerk-${userId}`}),
        (
          ${publisherUserId}, ${`${publisherUserId}@example.test`}, 'Publisher user',
          ${`clerk-${publisherUserId}`}
        )
    `;
    yield* sql`
      insert into publisher_companies (id, name)
      values (${publisherCompanyId}, ${`Publisher ${label}`})
    `;
    yield* sql`
      insert into publisher_company_memberships (
        publisher_company_id, user_id, role, accepted_at
      ) values (${publisherCompanyId}, ${publisherUserId}, 'admin', now())
    `;
    yield* sql`
      insert into publisher_subscriptions (
        id, publisher_company_id, name, created_by_user_id
      ) values (
        ${subscriptionId}, ${publisherCompanyId}, ${`Subscription ${label}`}, ${publisherUserId}
      )
    `;
    yield* sql`
      insert into publisher_issues (
        id, subscription_id, title, status, created_by_user_id
      ) values (${issueId}, ${subscriptionId}, ${`Issue ${label}`}, 'draft', ${publisherUserId})
    `;
    yield* sql`
      insert into brief_documents (
        id, issue_id, title, original_file_name, object_key, media_type,
        byte_size, sha256_hex, upload_completed_at, created_by_user_id, language
      ) values (
        ${documentId}, ${issueId}, ${`Document ${label}`}, 'document.pdf',
        ${`publisher/${publisherCompanyId}/${documentId}.pdf`}, 'application/pdf',
        1, ${createHash("sha256").update("Cited publisher evidence", "utf8").digest("hex")}, now(), ${publisherUserId}, 'en-US'
      )
    `;
    yield* sql`
      insert into client_companies (id, name)
      values (${clientCompanyId}, ${`Client ${label}`})
    `;
    yield* sql`
      insert into client_company_memberships (company_id, user_id, role)
      values (${clientCompanyId}, ${userId}, 'admin')
    `;
    yield* sql`
      insert into chats (id, company_id, user_id)
      values (${chatId}, ${clientCompanyId}, ${userId})
    `;
    return {
      userId,
      publisherCompanyId,
      clientCompanyId,
      subscriptionId,
      issueId,
      documentId,
      chatId,
    } satisfies PlatformFixture;
  });

const releaseHolds = (scopeIds: readonly string[]) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    for (const scopeId of scopeIds) {
      yield* sql`
        update legal_holds
        set released_at = now(), released_by_user_id = 'legal-admin'
        where scope_id = ${scopeId} and released_at is null
      `;
    }
  });

const markUserRetentionDue = (userId: string) =>
  runDb(
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      yield* sql`
        update platform_users
        set recovery_deleted_at = now() - interval '181 days',
            purge_after = now() - interval '1 day'
        where id = ${userId}
      `;
    }),
  );

const markCompanyRetentionDue = (companyId: string) =>
  runDb(
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      yield* sql`
        update client_companies
        set recovery_deleted_at = now() - interval '181 days',
            purge_after = now() - interval '1 day'
        where id = ${companyId}
      `;
    }),
  );

const readChatPresence = (chatId: string) =>
  runDb(
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      const rows = yield* sql<{ readonly deletedAt: Date | null }>`
        select deleted_at as "deletedAt"
        from chats
        where id = ${chatId}
      `;
      return { exists: rows.length === 1, deletedAt: rows[0]?.deletedAt ?? null };
    }),
  );

const runPlatformJob = (job: JobRecord) => {
  const fileStore = makeInMemoryPlatformFileStore();
  return Effect.runPromise(
    handlePlatformJob(job).pipe(
      Effect.provide(fileStore.layer),
      Effect.provide(makePdfTextExtractorLayer(() => Effect.succeed([]))),
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
};

describe.skipIf(!isBun || !databaseUrl)("legal-hold retention serialization", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = testUrl();
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const rows = yield* sql<{ readonly exists: boolean }>`
          select exists(select 1 from pg_database where datname = ${databaseName}) as exists
        `;
        if (rows[0]?.exists !== true) {
          yield* sql.unsafe(`create database ${quoted(databaseName)}`);
        }
      }),
      "brief-legal-hold-retention-admin",
      adminUrl(),
    );
    await runDb(runMigrations);
  }, 120_000);

  afterAll(async () => {
    if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = priorDatabaseUrl;
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          select pg_terminate_backend(pid)
          from pg_stat_activity
          where datname = ${databaseName} and pid <> pg_backend_pid()
        `;
        yield* sql.unsafe(`drop database if exists ${quoted(databaseName)}`);
      }),
      "brief-legal-hold-retention-admin",
      adminUrl(),
    );
  }, 60_000);

  it("keeps legal-hold placement identity and release history append-only", async () => {
    const hold = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const scopeId = crypto.randomUUID();
        const rows = yield* sql<{ readonly id: string }>`
          insert into legal_holds (scope_kind, scope_id, reason, placed_by_user_id)
          values ('chat', ${scopeId}::text, 'Immutable litigation hold', 'legal-admin')
          returning id::text
        `;
        return { id: rows[0]!.id, scopeId };
      }),
    );
    await expect(
      runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`delete from legal_holds where id = ${hold.id}`;
        }),
      ),
    ).rejects.toThrow();
    await runDb(releaseHolds([hold.scopeId]));
    await expect(
      runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            update legal_holds
            set released_at = null, released_by_user_id = null
            where id = ${hold.id}
          `;
        }),
      ),
    ).rejects.toThrow();
    await expect(
      runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            update legal_holds set reason = 'Rewritten reason' where id = ${hold.id}
          `;
        }),
      ),
    ).rejects.toThrow();
  });

  it("serializes export-object GC with immutable normalized legal-hold scopes in both race orders", async () => {
    const fixture = await runDb(seedPlatformFixture("export-object-gc"));
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const versionId = crypto.randomUUID();
        const contentHash = createHash("sha256")
          .update("Cited publisher evidence", "utf8")
          .digest("hex");
        const assistantMessageId = crypto.randomUUID();
        const [job] = yield* sql<{ readonly id: string }>`
          insert into jobs (kind, payload) values ('extract_pdf_text', '{}'::jsonb)
          returning id::text
        `;
        const [extraction] = yield* sql<{ readonly id: string }>`
          insert into brief_document_extractions (
            brief_document_id, input_sha256_hex, pages, extracted_char_count, created_by_job_id
          ) values (
            ${fixture.documentId}, ${contentHash},
            '[{"pageNumber":1,"text":"Cited publisher evidence"}]'::jsonb,
            24, ${job!.id}
          )
          returning id::text
        `;
        yield* sql`
          insert into brief_document_versions (
            id, brief_document_id, publisher_extraction_id, content_hash, language, canonical_text,
            text_char_count, page_ranges
          ) values (
            ${versionId}, ${fixture.documentId}, ${extraction!.id}, encode(digest(convert_to('Cited publisher evidence', 'UTF8'), 'sha256'), 'hex'), 'en-US',
            'Cited publisher evidence', 24,
            '[{"pageNumber":1,"charStart":0,"charEnd":24}]'::jsonb
          )
        `;
        yield* sql`
          update brief_documents set current_version_id = ${versionId}
          where id = ${fixture.documentId}
        `;
        yield* sql`
          insert into chat_messages (chat_id, author, content)
          values (${fixture.chatId}, 'user', 'Cited publisher question')
        `;
        const acceptanceScope = makeRunAcceptanceScope({
          userId: fixture.userId,
          chatId: fixture.chatId,
          companyId: fixture.clientCompanyId,
          subscriptionIds: [],
          accessIds: [],
          memoryMode: "private_owner",
        });
        const [run] = yield* sql<{ readonly id: string; readonly citationNamespace: string }>`
          insert into ai_runs (
            chat_id, initiating_user_id, user_message_id, locale, market,
            acceptance_scope, finished_at
          )
          select ${fixture.chatId}, ${fixture.userId}, messages.id, 'en-US', 'US',
                 ${sql.json(acceptanceScope)}, now()
          from chat_messages messages
          where messages.chat_id = ${fixture.chatId} and messages.author = 'user'
          order by messages.created_at desc, messages.id desc
          limit 1
          returning id::text, citation_namespace as "citationNamespace"
        `;
        yield* sql`
          insert into chat_messages (id, chat_id, author, content)
          values (${assistantMessageId}, ${fixture.chatId}, 'assistant', 'Cited answer')
        `;
        yield* sql`
          update chat_messages set assistant_ai_run_id = ${run!.id}
          where id = ${assistantMessageId}
        `;
        yield* sql`
          update ai_runs set assistant_message_id = ${assistantMessageId}
          where id = ${run!.id}
        `;
        yield* sql`
            insert into assistant_message_sources (
              assistant_message_id, source_key, kind, locator,
            version_id, publisher_extraction_id, document_source_id, document_id, content_hash,
            display_label, public_provenance
          ) values (
            ${assistantMessageId}, ${`k_${run!.citationNamespace}_1`}, 'document',
            ${sql.json({
              kind: "document",
              sourceId: `publisher:${fixture.subscriptionId}`,
              documentId: fixture.documentId,
              versionId: versionId,
              contentHash: createHash("sha256")
                .update("Cited publisher evidence", "utf8")
                .digest("hex"),
              publisherIssueId: fixture.issueId,
              publisherDocumentId: fixture.documentId,
              publisherExtractionId: extraction!.id,
              ranges: [{ charStart: 0, charEnd: 24 }],
            })},
              ${versionId}, (select id from brief_document_extractions where brief_document_id = ${fixture.documentId} limit 1),
              ${`publisher:${fixture.subscriptionId}`}, ${fixture.documentId}, ${contentHash},
              'Cited publisher evidence',
            ${sql.json({
              citationUrl: `/v1/issues/${fixture.issueId}/documents/${fixture.documentId}/content`,
              documentTitle: "Cited publisher evidence",
            })}
          )
        `;
      }),
    );
    const insertExpiredExport = (input: {
      readonly scopeKind: "user_chats" | "publisher_company" | "client_company";
      readonly scopeId: string;
      readonly clientCompanyIds: readonly string[];
      readonly issueIds: readonly string[];
      readonly chatIds: readonly string[];
    }) =>
      runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const id = crypto.randomUUID();
          const objectKey = `exports/${id}/attempt-1.tar`;
          const authorizedAt = new Date().toISOString();
          const chatMessages =
            input.chatIds.length === 0
              ? []
              : yield* sql<{ readonly id: string }>`
                  select id::text
                  from chat_messages
                  where ${sql.in("chat_id", input.chatIds)}
                  order by chat_id::text, created_at, id
                `;
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`
                insert into export_requests (
                  id, requester_user_id, scope_kind, scope_id, authorization_snapshot,
                  idempotency_key
                ) values (
                  ${id}, ${fixture.userId}, ${input.scopeKind}, ${input.scopeId},
                  ${sql.json({
                    version: 1,
                    authorizedAt,
                    requesterUserId: fixture.userId,
                    scopeKind: input.scopeKind,
                    scopeId: input.scopeId,
                    role:
                      input.scopeKind === "publisher_company"
                        ? "member"
                        : input.scopeKind === "client_company"
                          ? "admin"
                          : "self",
                    clientCompanyIds: input.clientCompanyIds,
                    accessIds: [],
                    issueIds: input.issueIds,
                    documentIds: [],
                    chatIds: input.chatIds,
                    chatMessageIds: chatMessages.map((message) => message.id),
                  })},
                  ${`export-legal-hold-${id}`}
                )
              `;
              yield* sql`
                insert into export_object_generations (
                  export_request_id, generation, object_key, purge_after,
                  next_delete_attempt_at
                ) values (
                  ${id}, 1, ${objectKey},
                  now() + interval '1 millisecond',
                  now() + interval '1 millisecond'
                )
              `;
              yield* sql`
                update export_object_generations
                set writer_state = 'in_flight', expected_sha256 = ${"0".repeat(64)},
                    byte_size = 0, writer_started_at = now()
                where export_request_id = ${id} and generation = 1
              `;
              yield* sql`
                update export_object_generations
                set writer_state = 'succeeded', writer_succeeded_at = now()
                where export_request_id = ${id} and generation = 1
              `;
              yield* sql`
                update export_object_generations
                set promoted_at = now()
                where export_request_id = ${id} and generation = 1
              `;
              yield* sql`
                update export_requests
                set status = 'completed', object_generation = 1, object_key = ${objectKey},
                    completed_at = now(),
                    expires_at = now() + interval '1 millisecond',
                    object_purge_after = now() + interval '1 millisecond'
                where id = ${id}
              `;
            }),
          );
          yield* Effect.sleep("5 millis");
          const holdScopeKeys = (yield* sql<{ readonly holdScopeKeys: string[] }>`
            select hold_scope_keys as "holdScopeKeys"
            from export_requests where id = ${id}
          `)[0]!.holdScopeKeys;
          return { id, objectKey, holdScopeKeys };
        }),
      );

    const holdWins = await insertExpiredExport({
      scopeKind: "user_chats",
      scopeId: "me",
      clientCompanyIds: [fixture.clientCompanyId],
      issueIds: [],
      chatIds: [fixture.chatId],
    });
    expect(holdWins.holdScopeKeys).toEqual(
      [
        `chat:${fixture.chatId}`,
        `client_company:${fixture.clientCompanyId}`,
        `issue:${fixture.issueId}`,
        `publisher_company:${fixture.publisherCompanyId}`,
        `user:${fixture.userId}`,
      ].sort(),
    );
    let signalHoldInserted!: () => void;
    const holdInserted = new Promise<void>((resolve) => {
      signalHoldInserted = resolve;
    });
    let releaseHoldTransaction!: () => void;
    const holdTransactionReleased = new Promise<void>((resolve) => {
      releaseHoldTransaction = resolve;
    });
    const holdPlacement = runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              insert into legal_holds (scope_kind, scope_id, reason, placed_by_user_id)
              values (
                'publisher_company', ${fixture.publisherCompanyId}::text,
                'Publisher hold wins export GC race', 'legal-admin'
              )
            `;
            yield* Effect.sync(signalHoldInserted);
            yield* Effect.promise(() => holdTransactionReleased);
          }),
        );
      }),
      "brief-export-object-hold-holder",
    );
    await holdInserted;
    const holdWinsDeletes: string[] = [];
    const holdWinsStore: ExportObjectStore = {
      verifyPhysicalDeletionSafety: async () => undefined,
      get: async () => new Uint8Array(),
      head: async () => null,
      put: async () => undefined,
      delete: async (objectKey) => {
        holdWinsDeletes.push(objectKey);
      },
    };
    const heldPurge = runDb(
      purgeExpiredExportObjects(holdWinsStore),
      "brief-export-object-hold-purger",
    );
    await waitForAdvisoryWait("brief-export-object-hold-purger");
    releaseHoldTransaction();
    await holdPlacement;
    await expect(heldPurge).resolves.toBe(0);
    expect(holdWinsDeletes).toEqual([]);
    await runDb(releaseHolds([fixture.publisherCompanyId]));
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          insert into legal_holds (scope_kind, scope_id, reason, placed_by_user_id)
          values ('issue', ${fixture.issueId}::text, 'Issue holds cited chat export', 'legal-admin')
        `;
      }),
    );
    await expect(runDb(purgeExpiredExportObjects(holdWinsStore))).resolves.toBe(0);
    expect(holdWinsDeletes).toEqual([]);
    await runDb(releaseHolds([fixture.issueId]));
    await expect(runDb(purgeExpiredExportObjects(holdWinsStore))).resolves.toBe(1);
    expect(holdWinsDeletes).toEqual([holdWins.objectKey]);

    const clientExport = await insertExpiredExport({
      scopeKind: "client_company",
      scopeId: fixture.clientCompanyId,
      clientCompanyIds: [fixture.clientCompanyId],
      issueIds: [fixture.issueId],
      chatIds: [],
    });
    expect(clientExport.holdScopeKeys).toContain(`publisher_company:${fixture.publisherCompanyId}`);
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          insert into legal_holds (scope_kind, scope_id, reason, placed_by_user_id)
          values (
            'publisher_company', ${fixture.publisherCompanyId}::text,
            'Publisher hold blocks client export GC', 'legal-admin'
          )
        `;
      }),
    );
    const clientDeletes: string[] = [];
    const clientStore: ExportObjectStore = {
      verifyPhysicalDeletionSafety: async () => undefined,
      get: async () => new Uint8Array(),
      head: async () => null,
      put: async () => undefined,
      delete: async (objectKey) => {
        clientDeletes.push(objectKey);
      },
    };
    await expect(runDb(purgeExpiredExportObjects(clientStore))).resolves.toBe(0);
    expect(clientDeletes).toEqual([]);
    await runDb(releaseHolds([fixture.publisherCompanyId]));
    await expect(runDb(purgeExpiredExportObjects(clientStore))).resolves.toBe(1);
    expect(clientDeletes).toEqual([clientExport.objectKey]);

    const gcWins = await insertExpiredExport({
      scopeKind: "publisher_company",
      scopeId: fixture.publisherCompanyId,
      clientCompanyIds: [],
      issueIds: [fixture.issueId],
      chatIds: [],
    });
    expect(gcWins.holdScopeKeys).toEqual(
      [
        `issue:${fixture.issueId}`,
        `publisher_company:${fixture.publisherCompanyId}`,
        `user:${fixture.userId}`,
      ].sort(),
    );
    let signalDeleteStarted!: () => void;
    const deleteStarted = new Promise<void>((resolve) => {
      signalDeleteStarted = resolve;
    });
    let releaseDelete!: () => void;
    const deleteReleased = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    const gcWinsDeletes: string[] = [];
    const gcWinsStore: ExportObjectStore = {
      verifyPhysicalDeletionSafety: async () => undefined,
      get: async () => new Uint8Array(),
      head: async () => null,
      put: async () => undefined,
      delete: async (objectKey) => {
        signalDeleteStarted();
        await deleteReleased;
        gcWinsDeletes.push(objectKey);
      },
    };
    const deleting = runDb(purgeExpiredExportObjects(gcWinsStore), "brief-export-object-gc-winner");
    await deleteStarted;
    const lateHold = runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          insert into legal_holds (scope_kind, scope_id, reason, placed_by_user_id)
          values ('issue', ${fixture.issueId}::text, 'GC wins export hold race', 'legal-admin')
        `;
      }),
      "brief-export-object-hold-placer",
    );
    await lateHold;
    const fenceCommitted = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{ readonly fenced: boolean; readonly deleted: boolean }>`
          select delete_fenced_at is not null as fenced,
                 deleted_at is not null as deleted
          from export_object_generations
          where export_request_id = ${gcWins.id} and generation = 1
        `)[0]!;
      }),
    );
    expect(fenceCommitted).toEqual({ fenced: true, deleted: false });
    releaseDelete();
    await expect(deleting).resolves.toBe(1);
    expect(gcWinsDeletes).toEqual([gcWins.objectKey]);
    await runDb(releaseHolds([fixture.issueId]));
  });

  it("does not let more than 500 held export generations starve a later unheld object", async () => {
    const fixture = await runDb(seedPlatformFixture("export-gc-held-fairness"));
    const keyPrefix = `export-held-fairness-${crypto.randomUUID()}`;
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              insert into export_requests (
                id, requester_user_id, scope_kind, scope_id,
                authorization_snapshot, idempotency_key
              )
              select candidate.id, ${fixture.userId}, 'user_chats', 'me',
                     jsonb_build_object(
                       'version', 1,
                       'authorizedAt', now(),
                       'requesterUserId', ${fixture.userId}::text,
                       'scopeKind', 'user_chats',
                       'scopeId', 'me',
                       'role', 'self',
                       'clientCompanyIds', case
                         when candidate.position <= 500
                         then jsonb_build_array(${fixture.clientCompanyId}::text)
                         else '[]'::jsonb
                       end,
                       'accessIds', '[]'::jsonb,
                       'issueIds', '[]'::jsonb,
                       'documentIds', '[]'::jsonb,
                       'chatIds', '[]'::jsonb,
                       'chatMessageIds', '[]'::jsonb
                     ),
                     ${keyPrefix}::text || ':' || candidate.position::text
              from (
                select position, gen_random_uuid() as id
                from generate_series(1, 501) position
              ) candidate
            `;
            yield* sql`
              insert into export_object_generations (
                export_request_id, generation, object_key, purge_after,
                next_delete_attempt_at
              )
              select request.id, 1,
                     'exports/' || request.id::text || '/attempt-1.tar',
                     now() + case
                       when request.idempotency_key = ${`${keyPrefix}:501`}
                       then interval '2 milliseconds'
                       else interval '1 millisecond'
                     end,
                     now() + case
                       when request.idempotency_key = ${`${keyPrefix}:501`}
                       then interval '2 milliseconds'
                       else interval '1 millisecond'
                     end
              from export_requests request
              where request.idempotency_key like ${`${keyPrefix}:%`}
            `;
            yield* sql`
              update export_requests
              set status = 'running', object_generation = 1
              where idempotency_key like ${`${keyPrefix}:%`}
            `;
          }),
        );
        yield* sql`
          insert into legal_holds (scope_kind, scope_id, reason, placed_by_user_id)
          values (
            'client_company', ${fixture.clientCompanyId}::text,
            'Held export batch must not starve later unheld GC work', 'legal-admin'
          )
        `;
      }),
    );
    await Bun.sleep(5);

    const deletedKeys: string[] = [];
    const store: ExportObjectStore = {
      verifyPhysicalDeletionSafety: async () => undefined,
      get: async () => new Uint8Array(),
      put: async () => undefined,
      head: async () => null,
      delete: async (objectKey) => {
        deletedKeys.push(objectKey);
      },
    };
    await expect(runDb(purgeExpiredExportObjects(store))).resolves.toBe(1);
    const state = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{
          readonly heldFenced: number;
          readonly heldAttempts: number;
          readonly unheldObjectKey: string;
          readonly unheldFenced: boolean;
          readonly unheldDeleted: boolean;
        }>`
          select
            count(*) filter (
              where request.idempotency_key <> ${`${keyPrefix}:501`}
                and generation.delete_fenced_at is not null
            )::int as "heldFenced",
            coalesce(sum(generation.delete_attempts) filter (
              where request.idempotency_key <> ${`${keyPrefix}:501`}
            ), 0)::int as "heldAttempts",
            max(generation.object_key) filter (
              where request.idempotency_key = ${`${keyPrefix}:501`}
            ) as "unheldObjectKey",
            bool_or(generation.delete_fenced_at is not null) filter (
              where request.idempotency_key = ${`${keyPrefix}:501`}
            ) as "unheldFenced",
            bool_or(generation.deleted_at is not null) filter (
              where request.idempotency_key = ${`${keyPrefix}:501`}
            ) as "unheldDeleted"
          from export_requests request
          join export_object_generations generation
            on generation.export_request_id = request.id
          where request.idempotency_key like ${`${keyPrefix}:%`}
        `)[0]!;
      }),
    );
    expect(state).toMatchObject({
      heldFenced: 0,
      heldAttempts: 0,
      unheldFenced: true,
      unheldDeleted: true,
    });
    expect(deletedKeys).toEqual([state.unheldObjectKey]);
  });

  it("keeps a fenced ambiguous export eligible for reprobe after a later hold", async () => {
    const fixture = await runDb(seedPlatformFixture("export-gc-late-hold-reprobe"));
    const exportId = crypto.randomUUID();
    const objectKey = `exports/${exportId}/attempt-1.tar`;
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              insert into export_requests (
                id, requester_user_id, scope_kind, scope_id,
                authorization_snapshot, idempotency_key
              ) values (
                ${exportId}, ${fixture.userId}, 'user_chats', 'me',
                ${sql.json({
                  version: 1,
                  authorizedAt: new Date().toISOString(),
                  requesterUserId: fixture.userId,
                  scopeKind: "user_chats",
                  scopeId: "me",
                  role: "self",
                  clientCompanyIds: [fixture.clientCompanyId],
                  accessIds: [],
                  issueIds: [],
                  documentIds: [],
                  chatIds: [],
                  chatMessageIds: [],
                })},
                ${`export-gc-late-hold-reprobe-${exportId}`}
              )
            `;
            yield* sql`
              insert into export_object_generations (
                export_request_id, generation, object_key, purge_after,
                next_delete_attempt_at
              ) values (
                ${exportId}, 1, ${objectKey},
                now() + interval '1 hour', now() + interval '1 hour'
              )
            `;
            yield* sql`
              update export_requests
              set status = 'running', object_generation = 1
              where id = ${exportId}
            `;
          }),
        );
        yield* sql`
          update export_object_generations
          set writer_state = 'in_flight', expected_sha256 = ${"a".repeat(64)},
              byte_size = 1, writer_started_at = now()
          where export_request_id = ${exportId} and generation = 1
        `;
        yield* sql`
          update export_object_generations
          set writer_state = 'unknown', purge_after = now() - interval '1 second',
              next_delete_attempt_at = now() - interval '1 second'
          where export_request_id = ${exportId} and generation = 1
        `;
      }),
    );

    const deletedKeys: string[] = [];
    const store: ExportObjectStore = {
      verifyPhysicalDeletionSafety: async () => undefined,
      get: async () => new Uint8Array(),
      put: async () => undefined,
      head: async () => null,
      delete: async (key) => {
        deletedKeys.push(key);
      },
    };
    await expect(runDb(purgeExpiredExportObjects(store))).resolves.toBe(0);
    const firstProbe = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{
          readonly attempts: number;
          readonly fenced: boolean;
          readonly deletedAt: Date | null;
          readonly nextDeleteAttemptAt: Date;
        }>`
          select delete_attempts as attempts,
                 delete_fenced_at is not null as fenced,
                 deleted_at as "deletedAt",
                 next_delete_attempt_at as "nextDeleteAttemptAt"
          from export_object_generations
          where export_request_id = ${exportId} and generation = 1
        `)[0]!;
      }),
    );
    expect(firstProbe).toMatchObject({ attempts: 1, fenced: true, deletedAt: null });
    expect(deletedKeys).toEqual([objectKey]);

    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          insert into legal_holds (scope_kind, scope_id, reason, placed_by_user_id)
          values (
            'client_company', ${fixture.clientCompanyId}::text,
            'Late hold cannot revoke a committed export delete fence', 'legal-admin'
          )
        `;
      }),
    );
    const activeHoldVisible = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{ readonly held: boolean }>`
          select brief_has_active_legal_hold(request.hold_scope_keys) as held
          from export_requests request
          where request.id = ${exportId}
        `)[0]!.held;
      }),
    );
    expect(activeHoldVisible).toBe(true);

    await expect(
      runDb(purgeExpiredExportObjects(store, new Date(Date.now() + 10 * 60 * 1_000))),
    ).resolves.toBe(0);
    const secondProbe = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{
          readonly attempts: number;
          readonly fenced: boolean;
          readonly deletedAt: Date | null;
          readonly nextDeleteAttemptAt: Date;
        }>`
          select delete_attempts as attempts,
                 delete_fenced_at is not null as fenced,
                 deleted_at as "deletedAt",
                 next_delete_attempt_at as "nextDeleteAttemptAt"
          from export_object_generations
          where export_request_id = ${exportId} and generation = 1
        `)[0]!;
      }),
    );
    expect(secondProbe).toMatchObject({ attempts: 2, fenced: true, deletedAt: null });
    expect(secondProbe.nextDeleteAttemptAt.getTime()).toBeGreaterThanOrEqual(
      firstProbe.nextDeleteAttemptAt.getTime(),
    );
    expect(deletedKeys).toEqual([objectKey, objectKey]);
  });

  it("snapshots every handled Stripe event identity and maps holds through every immutable ID", async () => {
    const state = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const companyId = crypto.randomUUID();
        const userId = `stripe-held-user-${crypto.randomUUID()}`;
        const customerId = `cus_${crypto.randomUUID()}`;
        const subscriptionId = `sub_${crypto.randomUUID()}`;
        const scheduleId = `sub_sched_${crypto.randomUUID()}`;
        const paymentId = `pi_${crypto.randomUUID()}`;
        const invoiceId = `in_${crypto.randomUUID()}`;

        yield* sql`
          insert into platform_users (id, primary_email, display_name, clerk_user_id)
          values (${userId}, ${`${userId}@example.test`}, 'Stripe requester', ${`clerk-${userId}`})
        `;
        yield* sql`
          insert into client_companies (id, name, stripe_customer_id)
          values (${companyId}, 'Stripe held company', ${customerId})
        `;
        yield* sql`
          insert into client_ai_billing_accounts (
            client_company_id, plan_tier, stripe_subscription_id, stripe_price_id,
            status, current_period_start, current_period_end
          ) values (
            ${companyId}, 'team', ${subscriptionId}, 'price_team', 'active',
            now() - interval '1 month', now() + interval '1 month'
          )
        `;
        yield* sql`
          insert into client_credit_lots (
            client_company_id, kind, credits_granted, credits_remaining,
            available_at, expires_at, stripe_payment_id
          ) values (
            ${companyId}, 'additional', 2, 2, now(), now() + interval '12 months',
            ${`payment:${paymentId}`}
          )
        `;
        yield* sql`
          insert into client_ai_plan_change_requests (
            client_company_id, idempotency_key, requested_by_user_id,
            authorization_request_id, authorization_session_id,
            previous_tier, target_tier, stripe_customer_id, stripe_subscription_id,
            previous_price_id, target_price_id, current_period_end,
            status, outcome, effective_at, external_operation_id
          ) values
          (
            ${companyId}, 'schedule-hold-request', ${userId}, ${crypto.randomUUID()}, 'session-1',
            'team', 'light', ${customerId}, ${subscriptionId}, 'price_team', 'price_light',
            now() + interval '1 month', 'succeeded', 'downgrade_scheduled', now(), ${scheduleId}
          ),
          (
            ${companyId}, 'invoice-hold-request', ${userId}, ${crypto.randomUUID()}, 'session-2',
            'light', 'team', ${customerId}, ${subscriptionId}, 'price_light', 'price_team',
            now() + interval '1 month', 'succeeded', 'upgraded', now(), ${invoiceId}
          )
        `;
        const eventTypes = [
          "customer.subscription.created",
          "customer.subscription.updated",
          "customer.subscription.deleted",
          "subscription_schedule.created",
          "subscription_schedule.updated",
          "subscription_schedule.completed",
          "subscription_schedule.released",
          "subscription_schedule.canceled",
          "subscription_schedule.aborted",
          "invoice.paid",
          "checkout.session.completed",
          "checkout.session.async_payment_succeeded",
          "checkout.session.async_payment_failed",
          "checkout.session.expired",
        ] as const;
        for (const [index, eventType] of eventTypes.entries()) {
          const object = eventType.startsWith("customer.subscription.")
            ? { id: subscriptionId, customer: customerId }
            : eventType.startsWith("subscription_schedule.")
              ? { id: scheduleId, customer: customerId, subscription: subscriptionId }
              : eventType === "invoice.paid"
                ? {
                    id: invoiceId,
                    customer: customerId,
                    payment_intent: paymentId,
                    parent: { subscription_details: { subscription: subscriptionId } },
                  }
                : {
                    id: `cs_${index}`,
                    customer: customerId,
                    subscription: subscriptionId,
                    payment_intent: paymentId,
                  };
          const payload = { data: { object } };
          yield* sql`
            insert into stripe_webhook_events (
              stripe_event_id, event_type, payload, signed_payload, retained_until
            ) values (
              ${`evt_handled_${index}_${crypto.randomUUID()}`}, ${eventType},
              ${sql.json(payload)}, ${JSON.stringify(payload)}, now() - interval '1 second'
            )
          `;
        }

        const identityRows = yield* sql<{
          readonly eventType: string;
          readonly customerId: string | null;
          readonly subscriptionId: string | null;
          readonly scheduleId: string | null;
          readonly paymentId: string | null;
          readonly invoiceId: string | null;
          readonly checkoutSessionId: string | null;
        }>`
          select event_type as "eventType", stripe_customer_id as "customerId",
                 stripe_subscription_id as "subscriptionId",
                 stripe_schedule_id as "scheduleId", stripe_payment_id as "paymentId",
                 stripe_invoice_id as "invoiceId",
                 stripe_checkout_session_id as "checkoutSessionId"
          from stripe_webhook_events where stripe_event_id like 'evt_handled_%'
          order by event_type
        `;

        yield* sql`
          insert into legal_holds (scope_kind, scope_id, reason, placed_by_user_id)
          values
            ('client_company', ${companyId}::text, 'Stripe company evidence', 'legal-admin'),
            ('user', ${userId}, 'Stripe requester evidence', 'legal-admin')
        `;
        return {
          companyId,
          userId,
          customerId,
          subscriptionId,
          scheduleId,
          paymentId,
          invoiceId,
          identityRows,
        };
      }),
    );

    expect(state.identityRows).toHaveLength(14);
    expect(
      state.identityRows
        .filter((row) => row.eventType.startsWith("customer.subscription."))
        .every(
          (row) =>
            row.customerId === state.customerId && row.subscriptionId === state.subscriptionId,
        ),
    ).toBe(true);
    expect(
      state.identityRows
        .filter((row) => row.eventType.startsWith("subscription_schedule."))
        .every(
          (row) =>
            row.customerId === state.customerId &&
            row.subscriptionId === state.subscriptionId &&
            row.scheduleId === state.scheduleId,
        ),
    ).toBe(true);
    expect(state.identityRows.find((row) => row.eventType === "invoice.paid")).toMatchObject({
      customerId: state.customerId,
      subscriptionId: state.subscriptionId,
      paymentId: state.paymentId,
      invoiceId: state.invoiceId,
    });
    expect(
      state.identityRows
        .filter((row) => row.eventType.startsWith("checkout.session."))
        .every(
          (row) =>
            row.customerId === state.customerId &&
            row.subscriptionId === state.subscriptionId &&
            row.paymentId === state.paymentId &&
            row.checkoutSessionId !== null,
        ),
    ).toBe(true);

    const heldResult = await runDb(purgeDeletedAccounts());
    expect(heldResult.accounting.stripeEvents).toBe(0);
    const heldCount = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{ readonly count: number }>`
            select count(*)::int as count from stripe_webhook_events
            where stripe_event_id like 'evt_handled_%'
          `)[0]!.count;
      }),
    );
    expect(heldCount).toBe(14);

    await runDb(releaseHolds([state.companyId, state.userId]));
    expect((await runDb(purgeDeletedAccounts())).accounting.stripeEvents).toBe(14);
  });

  it("maps Stripe retention independently through subscription, schedule, payment, invoice, and requester identities", async () => {
    const state = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const companyHeldId = crypto.randomUUID();
        const requesterCompanyId = crypto.randomUUID();
        const requesterUserId = `stripe-requester-only-${crypto.randomUUID()}`;
        const subscriptionId = `sub_only_${crypto.randomUUID()}`;
        const scheduleId = `sched_only_${crypto.randomUUID()}`;
        const paymentId = `pi_only_${crypto.randomUUID()}`;
        const invoiceId = `in_only_${crypto.randomUUID()}`;
        yield* sql`
          insert into platform_users (id, primary_email, display_name, clerk_user_id)
          values (
            ${requesterUserId}, ${`${requesterUserId}@example.test`}, 'Held requester',
            ${`clerk-${requesterUserId}`}
          )
        `;
        yield* sql`
          insert into client_companies (id, name)
          values
            (${companyHeldId}, 'Immutable identity company'),
            (${requesterCompanyId}, 'Requester identity company')
        `;
        yield* sql`
          insert into client_ai_billing_accounts (
            client_company_id, plan_tier, stripe_subscription_id, stripe_price_id,
            status, current_period_start, current_period_end
          ) values (
            ${companyHeldId}, 'team', ${subscriptionId}, 'price_team', 'active',
            now() - interval '1 month', now() + interval '1 month'
          )
        `;
        yield* sql`
          insert into client_credit_lots (
            client_company_id, kind, credits_granted, credits_remaining,
            available_at, expires_at, stripe_payment_id
          ) values (
            ${companyHeldId}, 'additional', 1, 1, now(), now() + interval '12 months',
            ${`payment:${paymentId}`}
          )
        `;
        yield* sql`
          insert into client_ai_plan_change_requests (
            client_company_id, idempotency_key, requested_by_user_id,
            authorization_request_id, authorization_session_id,
            previous_tier, target_tier, stripe_customer_id, stripe_subscription_id,
            previous_price_id, target_price_id, current_period_end,
            status, outcome, effective_at, external_operation_id
          ) values
          (
            ${requesterCompanyId}, 'schedule-identity-only', ${requesterUserId},
            ${crypto.randomUUID()}, 'schedule-session', 'team', 'light',
            'cus_requester_only', 'sub_requester_only', 'price_team', 'price_light',
            now() + interval '1 month', 'succeeded', 'downgrade_scheduled', now(), ${scheduleId}
          ),
          (
            ${requesterCompanyId}, 'invoice-identity-only', ${requesterUserId},
            ${crypto.randomUUID()}, 'invoice-session', 'light', 'team',
            'cus_requester_only', 'sub_requester_only', 'price_light', 'price_team',
            now() + interval '1 month', 'succeeded', 'upgraded', now(), ${invoiceId}
          )
        `;

        const checkoutKey = `checkout-retention-${crypto.randomUUID().slice(0, 8)}`;
        yield* sql`
          insert into client_ai_checkout_requests (
            client_company_id, idempotency_key, requested_by_user_id,
            authorization_request_id, authorization_session_id,
            authorization_mode, authorization_mfa_verified, kind, credits,
            stripe_customer_id, stripe_price_id, success_url, cancel_url,
            stripe_operation_key, stripe_checkout_session_id, checkout_url,
            status, retained_until
          ) values (
            ${requesterCompanyId}, ${checkoutKey}, ${requesterUserId},
            ${crypto.randomUUID()}, 'checkout-retention-session',
            'clerk', true, 'additional', 10,
            'cus_requester_only', 'price_additional',
            'https://brief.test/success', 'https://brief.test/cancel',
            ${`brief-checkout:${requesterCompanyId}:${checkoutKey}:session`},
            'cs_checkout_retention', 'https://checkout.stripe.test/retention',
            'succeeded', now() - interval '1 second'
          )
        `;
        yield* sql`alter table client_ai_checkout_requests disable trigger client_ai_checkout_requests_retention`;
        yield* sql`
          update client_ai_checkout_requests
          set retained_until = now() - interval '1 second'
          where client_company_id = ${requesterCompanyId} and idempotency_key = ${checkoutKey}
        `;
        yield* sql`alter table client_ai_checkout_requests enable trigger client_ai_checkout_requests_retention`;

        const eventPayloads = [
          [
            "evt_subscription_only",
            "customer.subscription.updated",
            { data: { object: { id: subscriptionId } } },
          ],
          [
            "evt_schedule_only",
            "subscription_schedule.updated",
            { data: { object: { id: scheduleId, subscription: "sub_not_mapped" } } },
          ],
          [
            "evt_payment_only",
            "checkout.session.completed",
            { data: { object: { id: "cs_only", payment_intent: paymentId } } },
          ],
          [
            "evt_invoice_only",
            "invoice.paid",
            {
              data: {
                object: {
                  id: invoiceId,
                  parent: { subscription_details: { subscription: "sub_not_mapped" } },
                },
              },
            },
          ],
        ] as const;
        const suffix = crypto.randomUUID();
        for (const [name, eventType, payload] of eventPayloads) {
          yield* sql`
            insert into stripe_webhook_events (
              stripe_event_id, event_type, payload, signed_payload, retained_until
            ) values (
              ${`${name}_${suffix}`}, ${eventType}, ${sql.json(payload)},
              ${JSON.stringify(payload)}, now() - interval '1 second'
            )
          `;
        }
        yield* sql`
          insert into legal_holds (scope_kind, scope_id, reason, placed_by_user_id)
          values
            (
              'client_company', ${companyHeldId}::text,
              'Company identity evidence', 'legal-admin'
            ),
            ('user', ${requesterUserId}, 'Requester identity evidence', 'legal-admin')
        `;
        const scopeRows = yield* sql<{
          readonly id: string;
          readonly holdScopeKeys: readonly string[];
        }>`
          select stripe_event_id as id,
                 brief_stripe_event_legal_hold_scope_keys(
                   stripe_customer_id, stripe_subscription_id, stripe_schedule_id,
                   stripe_payment_id, stripe_invoice_id
                 ) as "holdScopeKeys"
          from stripe_webhook_events
          where stripe_event_id like ${`%_only_${suffix}`}
          order by stripe_event_id
        `;
        return {
          companyHeldId,
          requesterUserId,
          suffix,
          scopeRows,
        };
      }),
    );

    expect(state.scopeRows).toHaveLength(4);
    expect(
      state.scopeRows
        .filter((row) => row.id.includes("subscription_only") || row.id.includes("payment_only"))
        .every((row) => row.holdScopeKeys.includes(`client_company:${state.companyHeldId}`)),
    ).toBe(true);
    expect(
      state.scopeRows
        .filter((row) => row.id.includes("schedule_only") || row.id.includes("invoice_only"))
        .every((row) => row.holdScopeKeys.includes(`user:${state.requesterUserId}`)),
    ).toBe(true);
    expect((await runDb(purgeDeletedAccounts())).accounting.stripeEvents).toBe(0);

    await runDb(releaseHolds([state.companyHeldId]));
    expect((await runDb(purgeDeletedAccounts())).accounting.stripeEvents).toBe(2);
    await runDb(releaseHolds([state.requesterUserId]));
    const released = await runDb(purgeDeletedAccounts());
    expect(released.accounting.stripeEvents).toBe(2);
    expect(released.accounting.checkoutRequests).toBe(1);
  });

  it("purges an expired billing account after checkout retention and requester holds permit it", async () => {
    const state = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const companyId = crypto.randomUUID();
        const expiredRequesterId = `expired-checkout-requester-${crypto.randomUUID()}`;
        const retainedRequesterId = `retained-checkout-requester-${crypto.randomUUID()}`;
        const expiredCheckoutKey = `expired-checkout-${crypto.randomUUID().slice(0, 8)}`;
        const retainedCheckoutKey = `retained-checkout-${crypto.randomUUID().slice(0, 8)}`;

        yield* sql`
          insert into platform_users (id, primary_email, display_name, clerk_user_id)
          values
            (
              ${expiredRequesterId}, ${`${expiredRequesterId}@example.test`},
              'Expired checkout requester', ${`clerk-${expiredRequesterId}`}
            ),
            (
              ${retainedRequesterId}, ${`${retainedRequesterId}@example.test`},
              'Retained checkout requester', ${`clerk-${retainedRequesterId}`}
            )
        `;
        yield* sql`
          insert into client_companies (id, name)
          values (${companyId}, 'Checkout-scoped billing retention')
        `;
        yield* sql`
          insert into client_ai_billing_accounts (client_company_id, status)
          values (${companyId}, 'cancelled')
        `;

        for (const [idempotencyKey, requesterId, suffix] of [
          [expiredCheckoutKey, expiredRequesterId, "expired"],
          [retainedCheckoutKey, retainedRequesterId, "retained"],
        ] as const) {
          yield* sql`
            insert into client_ai_checkout_requests (
              client_company_id, idempotency_key, requested_by_user_id,
              authorization_request_id, authorization_session_id,
              authorization_mode, authorization_mfa_verified, kind, credits,
              stripe_customer_id, stripe_price_id, success_url, cancel_url,
              stripe_operation_key, stripe_checkout_session_id, checkout_url,
              status
            ) values (
              ${companyId}, ${idempotencyKey}, ${requesterId},
              ${crypto.randomUUID()}, ${`checkout-retention-${suffix}`},
              'clerk', true, 'additional', 10,
              ${`cus_checkout_retention_${suffix}`}, 'price_additional',
              'https://brief.test/success', 'https://brief.test/cancel',
              ${`brief-checkout:${companyId}:${idempotencyKey}:session`},
              ${`cs_checkout_retention_${suffix}`},
              ${`https://checkout.stripe.test/${suffix}`}, 'succeeded'
            )
          `;
        }

        yield* sql`
          alter table client_ai_checkout_requests
          disable trigger client_ai_checkout_requests_retention
        `;
        yield* sql`
          update client_ai_checkout_requests
          set retained_until = now() - interval '1 second'
          where client_company_id = ${companyId}
            and idempotency_key = ${expiredCheckoutKey}
        `;
        yield* sql`
          alter table client_ai_checkout_requests
          enable trigger client_ai_checkout_requests_retention
        `;
        yield* sql`
          alter table client_ai_billing_accounts
          disable trigger client_ai_billing_accounts_retention
        `;
        yield* sql`
          update client_ai_billing_accounts
          set retained_until = now() - interval '1 second'
          where client_company_id = ${companyId}
        `;
        yield* sql`
          alter table client_ai_billing_accounts
          enable trigger client_ai_billing_accounts_retention
        `;
        yield* sql`
          insert into legal_holds (scope_kind, scope_id, reason, placed_by_user_id)
          values (
            'user', ${retainedRequesterId}, 'Retained checkout requester evidence',
            'legal-admin'
          )
        `;

        return {
          companyId,
          retainedCheckoutKey,
          retainedRequesterId,
        };
      }),
    );

    const held = await runDb(purgeDeletedAccounts());
    expect(held.accounting.checkoutRequests).toBe(1);
    expect(held.accounting.billingAccounts).toBe(0);
    const heldRows = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const billing = yield* sql<{ readonly count: number }>`
          select count(*)::int count from client_ai_billing_accounts
          where client_company_id = ${state.companyId}
        `;
        const checkouts = yield* sql<{
          readonly idempotencyKey: string;
        }>`
          select idempotency_key as "idempotencyKey"
          from client_ai_checkout_requests
          where client_company_id = ${state.companyId}
          order by idempotency_key
        `;
        return { billing: billing[0]!.count, checkouts };
      }),
    );
    expect(heldRows).toEqual({
      billing: 1,
      checkouts: [{ idempotencyKey: state.retainedCheckoutKey }],
    });

    await runDb(releaseHolds([state.retainedRequesterId]));
    const released = await runDb(purgeDeletedAccounts());
    expect(released.accounting.checkoutRequests).toBe(0);
    expect(released.accounting.billingAccounts).toBe(1);
    const releasedRows = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const billing = yield* sql<{ readonly count: number }>`
          select count(*)::int count from client_ai_billing_accounts
          where client_company_id = ${state.companyId}
        `;
        const checkouts = yield* sql<{ readonly idempotencyKey: string }>`
          select idempotency_key as "idempotencyKey"
          from client_ai_checkout_requests
          where client_company_id = ${state.companyId}
        `;
        return { billing: billing[0]!.count, checkouts };
      }),
    );
    expect(releasedRows).toEqual({
      billing: 0,
      checkouts: [{ idempotencyKey: state.retainedCheckoutKey }],
    });
  });

  it("retains support and authorization evidence for publisher, client, user, issue, and chat holds", async () => {
    const fixture = await runDb(seedPlatformFixture("operational-scopes"));
    const ids = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const supportActor = `support-${crypto.randomUUID()}`;
        const legalActor = `legal-${crypto.randomUUID()}`;
        yield* sql`
          insert into platform_admins (user_id, role)
          values (${supportActor}, 'support'), (${legalActor}, 'legal')
        `;
        const grants = yield* sql<{
          readonly id: string;
          readonly scopeKind: string;
          readonly reason: string;
        }>`
          insert into restricted_support_grants (
            actor_user_id, reason, scope_kind, scope_id,
            publisher_company_id, client_company_id, affected_user_id,
            approval_skipped_reason, granted_by_user_id, granted_at, expires_at
          ) values
          (
            ${supportActor}, 'Historical publisher investigation', 'publisher_file',
            ${fixture.documentId}, ${fixture.publisherCompanyId}, null, null,
            'Security response', ${legalActor}, now() - interval '25 months',
            now() - interval '25 months' + interval '1 hour'
          ),
          (
            ${supportActor}, 'Historical client investigation', 'client_chat',
            ${fixture.chatId}, null, ${fixture.clientCompanyId}, ${fixture.userId},
            'Security response', ${legalActor}, now() - interval '25 months',
            now() - interval '25 months' + interval '1 hour'
          )
          returning id::text, scope_kind as "scopeKind", reason
        `;
        for (const grant of grants) {
          const publisher = grant.scopeKind === "publisher_file";
          yield* sql`
            insert into restricted_support_access_log (
              grant_id, actor_user_id, reason, scope_kind, scope_id,
              publisher_company_id, client_company_id, affected_user_id,
              approval_skipped_reason, accessed_at
            ) values (
              ${grant.id}, ${supportActor}, ${grant.reason}, ${grant.scopeKind},
              ${publisher ? fixture.documentId : fixture.chatId},
              ${publisher ? fixture.publisherCompanyId : null},
              ${publisher ? null : fixture.clientCompanyId},
              ${publisher ? null : fixture.userId},
              'Security response', now() - interval '25 months' + interval '30 minutes'
            )
          `;
        }

        const auditScopes = [
          ["publisher_company", fixture.publisherCompanyId],
          ["client_company", fixture.clientCompanyId],
          ["user", fixture.userId],
          ["issue", fixture.issueId],
          ["chat", fixture.chatId],
        ] as const;
        for (const [scopeKind, scopeId] of auditScopes) {
          yield* sql`
            insert into platform_authorization_audit_log (
              actor_user_id, session_id, request_id, action, scope_kind, scope_id,
              outcome, occurred_at
            ) values (
              ${legalActor}, 'retention-session', ${crypto.randomUUID()},
              ${`platform.retention.${scopeKind}`}, ${scopeKind}, ${scopeId},
              'succeeded', now() - interval '25 months'
            )
          `;
        }
        yield* sql`
          insert into legal_holds (scope_kind, scope_id, reason, placed_by_user_id)
          values
            (
              'publisher_company', ${fixture.publisherCompanyId}::text,
              'Publisher evidence', ${legalActor}
            ),
            ('client_company', ${fixture.clientCompanyId}::text, 'Client evidence', ${legalActor}),
            ('user', ${fixture.userId}, 'User evidence', ${legalActor}),
            ('issue', ${fixture.issueId}::text, 'Issue evidence', ${legalActor}),
            ('chat', ${fixture.chatId}::text, 'Chat evidence', ${legalActor})
        `;
        return { grants };
      }),
    );

    expect(await runDb(purgeOperationalAuditRetention())).toEqual({
      supportAccessLogs: 0,
      supportGrants: 0,
      authorizationAuditLogs: 0,
    });
    const snapshots = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql<{ readonly holdScopeKeys: readonly string[] }>`
          select hold_scope_keys as "holdScopeKeys"
          from restricted_support_grants
          where id in (${ids.grants[0]!.id}, ${ids.grants[1]!.id})
          order by scope_kind
        `;
      }),
    );
    expect(snapshots.flatMap((row) => row.holdScopeKeys)).toEqual(
      expect.arrayContaining([
        `publisher_company:${fixture.publisherCompanyId}`,
        `client_company:${fixture.clientCompanyId}`,
        `user:${fixture.userId}`,
        `issue:${fixture.issueId}`,
        `chat:${fixture.chatId}`,
      ]),
    );

    await runDb(
      releaseHolds([
        fixture.publisherCompanyId,
        fixture.clientCompanyId,
        fixture.userId,
        fixture.issueId,
        fixture.chatId,
      ]),
    );
    expect(await runDb(purgeOperationalAuditRetention())).toEqual({
      supportAccessLogs: 2,
      supportGrants: 2,
      authorizationAuditLogs: 5,
    });
  }, 30_000);

  it("linearizes a user hold placed after accounting candidate discovery", async () => {
    const state = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const companyId = crypto.randomUUID();
        const userId = `accounting-race-${crypto.randomUUID()}`;
        const requestId = crypto.randomUUID();
        yield* sql`
          insert into platform_users (id, primary_email, display_name, clerk_user_id)
          values (${userId}, ${`${userId}@example.test`}, 'Race requester', ${`clerk-${userId}`})
        `;
        yield* sql`
          insert into client_companies (id, name) values (${companyId}, 'Accounting race')
        `;
        yield* sql`
          insert into client_ai_plan_change_requests (
            id, client_company_id, idempotency_key, requested_by_user_id,
            authorization_request_id, authorization_session_id,
            previous_tier, target_tier, status, error_code
          ) values (
            ${requestId}, ${companyId}, 'accounting-race-request', ${userId},
            ${crypto.randomUUID()}, 'race-session', 'light', 'light', 'failed',
            'provider_failed'
          )
        `;
        yield* sql`
          alter table client_ai_plan_change_requests
          disable trigger client_ai_plan_change_requests_retention
        `;
        yield* sql`
          update client_ai_plan_change_requests
          set retained_until = now() - interval '1 second'
          where id = ${requestId}
        `;
        yield* sql`
          alter table client_ai_plan_change_requests
          enable trigger client_ai_plan_change_requests_retention
        `;
        return { companyId, userId, requestId };
      }),
    );

    let releaseHolder!: () => void;
    let placementVisible!: () => void;
    const holderGate = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    const placementReady = new Promise<void>((resolve) => {
      placementVisible = resolve;
    });
    const holder = runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              insert into legal_holds (scope_kind, scope_id, reason, placed_by_user_id)
              values ('user', ${state.userId}, 'Accounting race evidence', 'legal-admin')
            `;
            yield* Effect.sync(placementVisible);
            yield* Effect.promise(() => holderGate);
          }),
        );
      }),
      "brief-accounting-hold-holder",
    );
    await placementReady;
    const purge = runDb(purgeDeletedAccounts(), "brief-accounting-hold-purger");
    try {
      await waitForAdvisoryWait("brief-accounting-hold-purger");
    } finally {
      releaseHolder();
    }
    await holder;
    expect((await purge).accounting.planChangeRequests).toBe(0);

    const retained = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{ readonly count: number }>`
            select count(*)::int count from client_ai_plan_change_requests
            where id = ${state.requestId}
          `)[0]!.count;
      }),
    );
    expect(retained).toBe(1);
    await runDb(releaseHolds([state.userId]));
    expect((await runDb(purgeDeletedAccounts())).accounting.planChangeRequests).toBe(1);
  }, 30_000);

  it("linearizes an issue hold placed after operational-audit candidate discovery", async () => {
    const fixture = await runDb(seedPlatformFixture("audit-race"));
    const auditId = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const rows = yield* sql<{ readonly id: string }>`
          insert into platform_authorization_audit_log (
            actor_user_id, session_id, request_id, action, scope_kind, scope_id,
            outcome, occurred_at
          ) values (
            'audit-race-actor', 'audit-race-session', ${crypto.randomUUID()},
            'platform.issue.restrict', 'issue', ${fixture.issueId}, 'succeeded',
            now() - interval '25 months'
          ) returning id::text
        `;
        return rows[0]!.id;
      }),
    );

    let releaseHolder!: () => void;
    let placementVisible!: () => void;
    const holderGate = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    const placementReady = new Promise<void>((resolve) => {
      placementVisible = resolve;
    });
    const holder = runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              insert into legal_holds (scope_kind, scope_id, reason, placed_by_user_id)
              values ('issue', ${fixture.issueId}::text, 'Audit race evidence', 'legal-admin')
            `;
            yield* Effect.sync(placementVisible);
            yield* Effect.promise(() => holderGate);
          }),
        );
      }),
      "brief-audit-hold-holder",
    );
    await placementReady;
    const purge = runDb(purgeOperationalAuditRetention(), "brief-operational-audit-hold-purger");
    try {
      await waitForAdvisoryWait("brief-operational-audit-hold-purger");
    } finally {
      releaseHolder();
    }
    await holder;
    expect((await purge).authorizationAuditLogs).toBe(0);

    await runDb(releaseHolds([fixture.issueId]));
    expect((await runDb(purgeOperationalAuditRetention())).authorizationAuditLogs).toBe(1);
    const count = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{ readonly count: number }>`
            select count(*)::int count from platform_authorization_audit_log
            where id = ${auditId}
          `)[0]!.count;
      }),
    );
    expect(count).toBe(0);
  }, 30_000);

  it("keeps memory tombstones under platform and user holds, then purges after release", async () => {
    const state = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const userId = `memory-hold-${crypto.randomUUID()}`;
        const memoryId = crypto.randomUUID();
        const revisionId = crypto.randomUUID();
        yield* sql`
          insert into platform_users (
            id, primary_email, display_name, clerk_user_id, legal_hold
          ) values (
            ${userId}, ${`${userId}@example.test`}, 'Memory hold', ${`clerk-${userId}`}, true
          )
        `;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              insert into user_memories (
                id, user_id, kind, content, head_revision_id, deleted_at
              ) values (
                ${memoryId}, ${userId}, 'fact', 'Held memory', ${revisionId},
                now() - interval '31 days'
              )
            `;
            yield* sql`
              insert into user_memory_revisions (
                id, memory_id, action, state_before, state_after
              ) values (
                ${revisionId}, ${memoryId}, 'delete',
                ${sql.json({ kind: "fact", content: "Held memory", deleted: false })},
                ${sql.json({ kind: "fact", content: "Held memory", deleted: true })}
              )
            `;
          }),
        );
        yield* sql`
          insert into legal_holds (scope_kind, scope_id, reason, placed_by_user_id)
          values ('user', ${userId}, 'Memory evidence', 'legal-admin')
        `;
        return { userId, memoryId };
      }),
    );

    expect(await runDb(purgeUserMemoryTombstones())).toEqual({
      processed: 0,
      hardDeleted: 0,
      madeProvenanceOnly: 0,
      revisionsDeleted: 0,
    });
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`update platform_users set legal_hold = false where id = ${state.userId}`;
      }),
    );
    expect((await runDb(purgeUserMemoryTombstones())).processed).toBe(0);
    await runDb(releaseHolds([state.userId]));
    expect(await runDb(purgeUserMemoryTombstones())).toMatchObject({
      processed: 1,
      hardDeleted: 1,
    });
  });

  it("completes a delayed platform-notification job as a typed stale-authorization no-op", async () => {
    const state = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const companyId = crypto.randomUUID();
        const adminId = `notification-admin-${crypto.randomUUID()}`;
        const userId = `notification-member-${crypto.randomUUID()}`;
        yield* sql`
          insert into platform_users (id, primary_email, display_name, clerk_user_id)
          values
            (
              ${adminId}, ${`${adminId}@example.test`}, 'Notification admin',
              ${`clerk-${adminId}`}
            ),
            (
              ${userId}, ${`${userId}@example.test`}, 'Notification member',
              ${`clerk-${userId}`}
            )
        `;
        yield* sql`
          insert into client_companies (id, name)
          values (${companyId}, 'Notification stale company')
        `;
        yield* sql`
          insert into client_company_memberships (company_id, user_id, role)
          values
            (${companyId}, ${adminId}, 'admin'),
            (${companyId}, ${userId}, 'member')
        `;
        yield* sql`
          update client_company_memberships
          set revoked_at = now(), revoked_by_user_id = ${adminId}
          where company_id = ${companyId} and user_id = ${userId}
        `;
        const payload = {
          clientCompanyId: companyId,
          userId,
          kind: "usage_limit_reached",
          deduplicationKey: `stale-notification:${companyId}:${userId}`,
        } as const;
        const jobId = crypto.randomUUID();
        yield* sql`
          insert into jobs (id, kind, payload)
          values (${jobId}, 'send_platform_notification', ${sql.json(payload)})
        `;
        return {
          job: {
            id: jobId,
            kind: "send_platform_notification",
            payload,
            attempts: 0,
          } satisfies JobRecord,
          deduplicationKey: payload.deduplicationKey,
        };
      }),
    );

    const result = await runPlatformJob(state.job);
    expect(result).toEqual({
      status: "completed",
      message: expect.stringContaining(
        "skipped stale authorization notification_recipient_not_authorized",
      ),
    });
    const notifications = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{ readonly count: number }>`
            select count(*)::int count from platform_notifications
            where deduplication_key = ${state.deduplicationKey}
          `)[0]!.count;
      }),
    );
    expect(notifications).toBe(0);
  });

  it("linearizes user account chat preparation with parent holds in both race orders", async () => {
    const fixture = await runDb(seedPlatformFixture("user-account-hold-race"));
    await markUserRetentionDue(fixture.userId);

    let signalHoldInserted!: () => void;
    const holdInserted = new Promise<void>((resolve) => {
      signalHoldInserted = resolve;
    });
    let releaseHoldTransaction!: () => void;
    const holdTransactionReleased = new Promise<void>((resolve) => {
      releaseHoldTransaction = resolve;
    });
    const holdPlacement = runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              insert into legal_holds (scope_kind, scope_id, reason, placed_by_user_id)
              values ('user', ${fixture.userId}, 'User account hold wins', 'legal-admin')
            `;
            yield* Effect.sync(signalHoldInserted);
            yield* Effect.promise(() => holdTransactionReleased);
          }),
        );
      }),
      "brief-user-account-hold-holder",
    );
    await holdInserted;
    const heldPurge = runDb(purgeDeletedAccounts(), "brief-user-account-hold-purger");
    await waitForAdvisoryWait("brief-user-account-hold-purger");
    releaseHoldTransaction();
    await holdPlacement;
    await expect(heldPurge).resolves.toMatchObject({ purgedUsers: 0, purgedChats: 0 });
    expect((await readChatPresence(fixture.chatId)).deletedAt).toBeNull();

    await runDb(releaseHolds([fixture.userId]));
    await expect(runDb(purgeDeletedAccounts())).resolves.toMatchObject({
      purgedUsers: 1,
      purgedChats: 1,
    });
    expect((await readChatPresence(fixture.chatId)).exists).toBe(false);

    // Hold placement waits behind a purge that already owns the child scopes.
    // A gate on the final lexical key makes this ordering deterministic while
    // still exercising two real PostgreSQL sessions.
    const secondFixture = await runDb(seedPlatformFixture("user-account-purge-race"));
    await markUserRetentionDue(secondFixture.userId);
    let releaseGate!: () => void;
    const gateReleased = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const gate = runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              select pg_advisory_xact_lock(
                hashtextextended(${`brief:legal-hold:user:${secondFixture.userId}`}, 0)
              )
            `;
            yield* Effect.promise(() => gateReleased);
          }),
        );
      }),
      "brief-user-account-purge-gate",
    );
    const purgeFirst = runDb(purgeDeletedAccounts(), "brief-user-account-purge-first");
    await waitForAdvisoryWait("brief-user-account-purge-first");
    const lateHold = runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              insert into legal_holds (scope_kind, scope_id, reason, placed_by_user_id)
              values ('user', ${secondFixture.userId}, 'User hold follows purge', 'legal-admin')
            `;
          }),
        );
      }),
      "brief-user-account-purge-late-hold",
    );
    await waitForAdvisoryWait("brief-user-account-purge-late-hold");
    releaseGate();
    await gate;
    await purgeFirst;
    await lateHold;
    const userPurgeFirstChat = await readChatPresence(secondFixture.chatId);
    expect(!userPurgeFirstChat.exists || userPurgeFirstChat.deletedAt !== null).toBe(true);
    await runDb(releaseHolds([secondFixture.userId]));
    await runDb(purgeDeletedAccounts());
  }, 120_000);

  it("linearizes company account chat preparation with child-user holds in both race orders", async () => {
    const fixture = await runDb(seedPlatformFixture("company-account-hold-race"));
    await markCompanyRetentionDue(fixture.clientCompanyId);

    let signalHoldInserted!: () => void;
    const holdInserted = new Promise<void>((resolve) => {
      signalHoldInserted = resolve;
    });
    let releaseHoldTransaction!: () => void;
    const holdTransactionReleased = new Promise<void>((resolve) => {
      releaseHoldTransaction = resolve;
    });
    const holdPlacement = runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              insert into legal_holds (scope_kind, scope_id, reason, placed_by_user_id)
              values (
                'user', ${fixture.userId}, 'Child user hold wins company preparation', 'legal-admin'
              )
            `;
            yield* Effect.sync(signalHoldInserted);
            yield* Effect.promise(() => holdTransactionReleased);
          }),
        );
      }),
      "brief-company-account-hold-holder",
    );
    await holdInserted;
    const heldPurge = runDb(purgeDeletedAccounts(), "brief-company-account-hold-purger");
    await waitForAdvisoryWait("brief-company-account-hold-purger");
    releaseHoldTransaction();
    await holdPlacement;
    await expect(heldPurge).resolves.toMatchObject({ purgedCompanies: 0 });
    expect((await readChatPresence(fixture.chatId)).deletedAt).toBeNull();

    await runDb(releaseHolds([fixture.userId]));
    await expect(runDb(purgeDeletedAccounts())).resolves.toMatchObject({
      purgedCompanies: 1,
      purgedChats: 1,
    });
    expect((await readChatPresence(fixture.chatId)).exists).toBe(false);

    const secondFixture = await runDb(seedPlatformFixture("company-account-purge-race"));
    await markCompanyRetentionDue(secondFixture.clientCompanyId);
    let releaseGate!: () => void;
    const gateReleased = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const gate = runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              select pg_advisory_xact_lock(
                hashtextextended(${`brief:legal-hold:user:${secondFixture.userId}`}, 0)
              )
            `;
            yield* Effect.promise(() => gateReleased);
          }),
        );
      }),
      "brief-company-account-purge-gate",
    );
    const purgeFirst = runDb(purgeDeletedAccounts(), "brief-company-account-purge-first");
    await waitForAdvisoryWait("brief-company-account-purge-first");
    const lateHold = runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              insert into legal_holds (scope_kind, scope_id, reason, placed_by_user_id)
              values (
                'client_company', ${secondFixture.clientCompanyId},
                'Company hold follows preparation', 'legal-admin'
              )
            `;
          }),
        );
      }),
      "brief-company-account-purge-late-hold",
    );
    await waitForAdvisoryWait("brief-company-account-purge-late-hold");
    releaseGate();
    await gate;
    await purgeFirst;
    await lateHold;
    const companyPurgeFirstChat = await readChatPresence(secondFixture.chatId);
    expect(!companyPurgeFirstChat.exists || companyPurgeFirstChat.deletedAt !== null).toBe(true);
    await runDb(releaseHolds([secondFixture.clientCompanyId]));
    await runDb(purgeDeletedAccounts());
  }, 120_000);

  it("enforces one aggregate 500-candidate budget across every retention category", async () => {
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const batchCompanyId = crypto.randomUUID();
        const batchChatId = crypto.randomUUID();
        const batchUserId = `batch-client-user-${crypto.randomUUID()}`;
        yield* sql`
          insert into client_companies (id, name)
          values (${batchCompanyId}, 'Aggregate retention batch company')
        `;
        yield* sql`
          insert into platform_users (id, primary_email, display_name, clerk_user_id)
          values (
            ${batchUserId}, ${`${batchUserId}@example.test`}, 'Batch client user',
            ${`clerk-${batchUserId}`}
          )
        `;
        yield* sql`
          insert into client_company_memberships (company_id, user_id, role)
          values (${batchCompanyId}, ${batchUserId}, 'admin')
        `;
        yield* sql`
          insert into chats (id, company_id, user_id, memory_mode)
          values (${batchChatId}, ${batchCompanyId}, ${batchUserId}, 'private_owner')
        `;
        yield* sql`
          insert into client_credit_lots (
            client_company_id, kind, credits_granted, credits_remaining,
            available_at, expires_at, stripe_payment_id, retained_until
          )
          select ${batchCompanyId}, 'additional', 1, 0,
                 now() - interval '12 years', now() - interval '11 years',
                 'batch-payment-' || value::text, now() - interval '1 second'
          from generate_series(1, 300) value
        `;
        yield* sql`
          insert into stripe_webhook_events (
            stripe_event_id, event_type, payload, signed_payload, retained_until
          )
          select 'evt_batch_' || value::text, 'unhandled.retention', '{}'::jsonb, '{}',
                 now() - interval '1 second'
          from generate_series(1, 300) value
        `;
        yield* sql`
          insert into platform_admins (user_id, role)
          values ('batch-support-actor', 'support'), ('batch-legal-actor', 'legal')
        `;
        yield* sql`
          insert into restricted_support_grants (
            actor_user_id, reason, scope_kind, scope_id, client_company_id,
            affected_user_id, approval_skipped_reason, granted_by_user_id,
            granted_at, expires_at
          )
          select 'batch-support-actor', 'Historical aggregate retention check',
                 'client_chat', ${batchChatId}::text, ${batchCompanyId}, ${batchUserId},
                 'Security response', 'batch-legal-actor',
                 now() - interval '25 months',
                 now() - interval '25 months' + interval '1 hour'
          from generate_series(1, 300) value
        `;
        yield* sql`
          insert into platform_authorization_audit_log (
            actor_user_id, session_id, request_id, action, scope_kind, scope_id,
            outcome, occurred_at
          )
          select 'batch-audit-actor', 'batch-session', gen_random_uuid(),
                 'platform.retention.batch', 'public_source', 'batch-' || value::text,
                 'succeeded', now() - interval '25 months'
          from generate_series(1, 300) value
        `;
      }),
    );

    const firstAccounting = (await runDb(purgeDeletedAccounts())).accounting;
    expect(firstAccounting).toMatchObject({ lots: 300, stripeEvents: 200 });
    expect(Object.values(firstAccounting).reduce((total, count) => total + count, 0)).toBe(500);
    const secondAccounting = (await runDb(purgeDeletedAccounts())).accounting;
    expect(secondAccounting).toMatchObject({ lots: 0, stripeEvents: 100 });

    const firstOperational = await runDb(purgeOperationalAuditRetention());
    expect(firstOperational).toEqual({
      supportAccessLogs: 0,
      supportGrants: 300,
      authorizationAuditLogs: 200,
    });
    expect(Object.values(firstOperational).reduce((total, count) => total + count, 0)).toBe(500);
    expect(await runDb(purgeOperationalAuditRetention())).toEqual({
      supportAccessLogs: 0,
      supportGrants: 0,
      authorizationAuditLogs: 100,
    });
  }, 120_000);
});
