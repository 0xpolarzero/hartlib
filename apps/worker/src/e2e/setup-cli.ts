import { PgClient } from "@effect/sql-pg";
import { Effect, Redacted } from "effect";
import { createHash } from "node:crypto";
import { loadE2eDatabaseUrl, ZAI_CODING_PLAN_BASE_URL } from "@hartlib/config";
import { makeRunAcceptanceScope } from "@hartlib/shared";
import { runPublicSourceIngestionBatch } from "../source-ingestion/orchestrator";
import { makePgPublicSourceIngestionRepository } from "../source-ingestion/pg-repository";
import { PublicSourceIngestionRepository } from "../source-ingestion/repository";

import { e2eStreamGateLockKey, isE2eStreamGateId } from "../ai/e2e/stream-gate";
import { AI_CHAT_SMITHERS_SCHEMA_FENCE } from "../ai/smithers-interop";
import { runMigrations } from "@hartlib/database/migrations";
import {
  makeE2ePublicSourceAdapters,
  type E2ePublicSourceCorpusItem,
} from "./public-source-corpus";

const databaseUrl = Effect.runSync(loadE2eDatabaseUrl);
const databaseName = new URL(databaseUrl).pathname.replace(/^\//, "") || "hartlib_e2e";
// The E2E stack uses one fixed server-issued identity so setup helpers can
// seed and inspect the same singular chat that the browser receives in its
// bootstrap cookie. Integration setup passes this value to the browser.
const demoVisitorId = process.env.HARTLIB_E2E_VISITOR_ID ?? "00000000-0000-4000-8000-000000000001";
if (
  !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(demoVisitorId)
) {
  throw new Error("HARTLIB_E2E_VISITOR_ID must be a UUID");
}
const demoCompanyHash = createHash("md5")
  .update(`hartlib:client-company:${demoVisitorId}`)
  .digest("hex");
const demoClientCompanyId = [
  demoCompanyHash.slice(0, 8),
  demoCompanyHash.slice(8, 12),
  demoCompanyHash.slice(12, 16),
  demoCompanyHash.slice(16, 20),
  demoCompanyHash.slice(20, 32),
].join("-");
const clientCompanyIdForVisitor = (visitorId: string): string => {
  const hash = createHash("md5").update(`hartlib:client-company:${visitorId}`).digest("hex");
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join("-");
};
const seededAnswerSearchTerms = "solaire raccordements";
const resetQuiescenceTimeoutMs = 10_000;
const resetQuiescencePollMs = 25;
const seededAnswerExpectedDocuments = [
  {
    sourceId: "e2e-fr-energie",
    documentId: "e2e-fr-solaire-raccordements",
    title: "France solaire: raccordements acceleres",
    canonicalUrl: "https://e2e.example/fr/solaire-raccordements",
  },
  {
    sourceId: "e2e-fr-reseau",
    documentId: "e2e-fr-stockage-reseau",
    title: "Stockage et reseau: priorites publiques",
    canonicalUrl: "https://e2e.example/fr/stockage-reseau",
  },
] as const;

const databaseUrlFor = (name: string): string => {
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
};

const adminDatabaseUrl = databaseUrlFor("postgres");
const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const citationNamespaceForSeed = (seed: string): string =>
  `cn_${createHash("sha256").update(`citation:${seed}`).digest().subarray(0, 16).toString("base64url")}`;
const seedProvider =
  process.env.AI_E2E_FAKE_PROVIDER === "true"
    ? ("deterministic_test" as const)
    : ("zai_coding_plan_official" as const);
const seedProviderEndpointIdentity = `${seedProvider}:${process.env.AI_BASE_URL ?? ZAI_CODING_PLAN_BASE_URL}`;

const acceptanceScopeForSeed = (args: {
  readonly userId?: string;
  readonly chatId: string;
  readonly companyId: string;
  readonly publicSourceIds: readonly string[];
  readonly webRequested?: boolean;
  readonly webEnabled?: boolean;
  readonly allowedDomains?: readonly string[] | null;
}) =>
  makeRunAcceptanceScope({
    userId: args.userId ?? demoVisitorId,
    chatId: args.chatId,
    companyId: args.companyId,
    publicSourceIds: args.publicSourceIds,
    memoryMode: "private_owner",
    provider: seedProvider,
    providerEndpointIdentity: seedProviderEndpointIdentity,
    webRequested: args.webRequested ?? false,
    webEnabled: args.webEnabled ?? false,
    webTransportProvider: args.webEnabled === true ? "tinyfish" : null,
    allowedDomains: args.allowedDomains ?? null,
  });

const runDb = <A, E>(url: string, effect: Effect.Effect<A, E, PgClient.PgClient>): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        PgClient.layer({
          url: Redacted.make(url),
          applicationName: "hartlib-playwright-e2e-setup",
        }),
      ),
    ),
  );

const createDatabase = () =>
  runDb(
    adminDatabaseUrl,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      yield* sql`
        select pg_terminate_backend(pid)
        from pg_stat_activity
        where datname = ${databaseName}
          and pid <> pg_backend_pid()
      `;
      yield* sql.unsafe(`drop database if exists ${quoteIdentifier(databaseName)}`);
      yield* sql.unsafe(`create database ${quoteIdentifier(databaseName)}`);
    }),
  );

const dropDatabase = () =>
  runDb(
    adminDatabaseUrl,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      yield* sql`
        select pg_terminate_backend(pid)
        from pg_stat_activity
        where datname = ${databaseName}
          and pid <> pg_backend_pid()
      `;
      yield* sql.unsafe(`drop database if exists ${quoteIdentifier(databaseName)}`);
    }),
  );

const docText = (lead: string): string =>
  `${lead} ` +
  "La note de marche decrit les raccordements, les appels d'offres, le stockage et les contraintes de reseau en France. ".repeat(
    5,
  );
const industryDocText = (lead: string): string =>
  `${lead} ` +
  "La note industrielle decrit les calendriers, l'hydrogene, les usages lourds et les priorites de transition en France. ".repeat(
    5,
  );

const e2eCorpus = [
  {
    sourceId: "e2e-fr-energie",
    displayName: "E2E Energie France",
    publisherName: "Observatoire Energie",
    documentId: seededAnswerExpectedDocuments[0].documentId,
    title: seededAnswerExpectedDocuments[0].title,
    canonicalUrl: seededAnswerExpectedDocuments[0].canonicalUrl,
    publishedAt: "2026-07-01T08:00:00.000Z",
    text: docText(
      "Le solaire francais progresse en 2026 grace a des raccordements regionaux plus rapides et a une file d'attente clarifiee.",
    ),
  },
  {
    sourceId: "e2e-fr-reseau",
    displayName: "E2E Reseau Public",
    publisherName: "Agence Reseau",
    documentId: seededAnswerExpectedDocuments[1].documentId,
    title: seededAnswerExpectedDocuments[1].title,
    canonicalUrl: seededAnswerExpectedDocuments[1].canonicalUrl,
    publishedAt: "2026-07-02T08:00:00.000Z",
    text: docText(
      "Les pouvoirs publics francais renforcent le suivi du stockage solaire pour lisser la demande, reduire les congestions du reseau et preparer les raccordements.",
    ),
  },
  {
    sourceId: "e2e-fr-industrie",
    displayName: "E2E Industrie Climat",
    publisherName: "Mission Industrie",
    documentId: "e2e-fr-hydrogene-industrie",
    title: "Hydrogene bas-carbone: calendrier industriel",
    canonicalUrl: "https://e2e.example/fr/hydrogene-industrie",
    publishedAt: "2026-07-03T08:00:00.000Z",
    text: industryDocText(
      "Le calendrier industriel francais maintient les appels d'offres hydrogene et les usages lourds comme priorites de transition.",
    ),
  },
] as const satisfies readonly E2ePublicSourceCorpusItem[];

const e2eIngestionNow = new Date("2026-07-04T08:00:00.000Z");

const ingestPublicCorpusAndSeedDemoData = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  const repository = yield* makePgPublicSourceIngestionRepository();
  const stats = yield* runPublicSourceIngestionBatch(
    makeE2ePublicSourceAdapters(e2eCorpus, e2eIngestionNow),
    {
      mode: "backfill",
      now: () => e2eIngestionNow,
      operationTimeoutMs: 10_000,
    },
  ).pipe(Effect.provideService(PublicSourceIngestionRepository, repository));
  if (stats.some((result) => result.failedCount > 0 || result.storedDocumentCount !== 1)) {
    return yield* Effect.fail(
      new Error(`E2E local public-source ingestion failed: ${JSON.stringify(stats)}`),
    );
  }

  yield* sql`
    insert into demo_sessions (visitor_id)
    values (${demoVisitorId}::uuid)
    on conflict (visitor_id) do update set revoked_at = null, last_seen_at = now()
  `;
  yield* sql`
    insert into platform_users (id, primary_email, display_name)
    values (${demoVisitorId}, ${`demo+${demoVisitorId}@hartlib.test`}, ${`Demo ${demoVisitorId}`})
    on conflict (id) do update set display_name = excluded.display_name
  `;
  // The demo chat endpoint derives this workspace before creating its first
  // chat. Seed it explicitly so its public-source policy exists before the E2E
  // corpus settings are materialized.
  yield* sql`
    insert into client_companies (id, name)
    values (${demoClientCompanyId}, ${`Demo company for ${demoVisitorId}`})
    on conflict (id) do update set name = excluded.name
  `;
  yield* sql`
    insert into client_company_memberships (company_id, user_id, role)
    values (${demoClientCompanyId}, ${demoVisitorId}, 'admin')
    on conflict (company_id, user_id) do update set
      role = 'admin', revoked_at = null, revoked_by_user_id = null
  `;
  yield* sql`
    insert into client_company_ai_settings (company_id, web_search_enabled)
    values (${demoClientCompanyId}, true) on conflict (company_id) do nothing
  `;
  yield* sql`
    insert into client_company_public_source_settings (
      client_company_id, source_id, enabled, updated_by_user_id
    )
    select memberships.company_id, sources.source_id, true, ${demoVisitorId}
    from client_company_memberships memberships
    cross join public_sources sources
    where memberships.user_id = ${demoVisitorId}
      and memberships.revoked_at is null
      and sources.source_id like 'e2e-%'
    on conflict (client_company_id, source_id) do update set enabled = true, updated_at = now()
  `;
});

const assertSeededCorpusSearchable = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  const ingestionRuns = yield* sql<{
    readonly sourceId: string;
    readonly status: string;
    readonly discoveredCount: number;
    readonly fetchedCount: number;
    readonly storedDocumentCount: number;
    readonly failedCount: number;
  }>`
    select source_id as "sourceId", status,
           discovered_count as "discoveredCount",
           fetched_count as "fetchedCount",
           stored_document_count as "storedDocumentCount",
           failed_count as "failedCount"
    from public_source_ingestion_runs
    where source_id like 'e2e-%'
    order by source_id
  `;
  if (
    ingestionRuns.length !== e2eCorpus.length ||
    ingestionRuns.some(
      (run) =>
        run.status !== "completed" ||
        run.discoveredCount !== 1 ||
        run.fetchedCount !== 1 ||
        run.storedDocumentCount !== 1 ||
        run.failedCount !== 0,
    )
  ) {
    return yield* Effect.fail(
      new Error(`E2E ingestion run validation failed: ${JSON.stringify(ingestionRuns)}`),
    );
  }

  const rows = yield* sql<{
    readonly sourceId: string;
    readonly documentId: string;
    readonly snapshotId: string;
    readonly canonicalUrl: string;
    readonly contentHash: string;
  }>`
    select d.source_id as "sourceId",
           d.document_id as "documentId",
           d.document_id as "snapshotId",
           d.canonical_url as "canonicalUrl",
           d.content_hash as "contentHash"
    from public_source_documents d
    join public_sources s on s.source_id = d.source_id
    where s.country = 'FR'
      and d.language = 'fr'
      and d.search_vector @@ websearch_to_tsquery('french', ${seededAnswerSearchTerms})
    order by
      ts_rank_cd(d.search_vector, websearch_to_tsquery('french', ${seededAnswerSearchTerms})) desc,
      d.published_at desc nulls last,
      d.document_id asc
    limit ${seededAnswerExpectedDocuments.length}
  `;
  const expectedDocuments = seededAnswerExpectedDocuments.map((expected) => {
    const corpusItem = e2eCorpus.find((item) => item.documentId === expected.documentId);
    if (corpusItem === undefined) throw new Error(`missing E2E corpus item ${expected.documentId}`);
    return {
      sourceId: expected.sourceId,
      documentId: expected.documentId,
      snapshotId: expected.documentId,
      canonicalUrl: expected.canonicalUrl,
      contentHash: createHash("sha256").update(corpusItem.text).digest("hex"),
    };
  });

  if (JSON.stringify(rows) !== JSON.stringify(expectedDocuments)) {
    return yield* Effect.fail(
      new Error(
        `E2E seed corpus FTS validation failed for "${seededAnswerSearchTerms}". ` +
          `Expected ${JSON.stringify(expectedDocuments)}; returned ${JSON.stringify(rows)}.`,
      ),
    );
  }
});

const resetDemoRuntimeBody = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  const smithersTables = yield* sql<{ readonly tableName: string }>`
    select distinct table_name as "tableName"
    from information_schema.columns
    where table_schema = 'public'
      and column_name = 'run_id'
      and (
        table_name like '_smithers_%'
        or table_name = 'input'
        or table_name like 'ai_chat_%'
      )
  `;

  // Each browser test reactivates the fixed seed visitor. Remove prior reset
  // operation rows so a fresh test cannot be mistaken for a competing reset
  // against a predecessor that the fixture just made active again.
  yield* sql`
    delete from demo_reset_operations
    where predecessor_visitor_id = ${demoVisitorId}::uuid
       or successor_visitor_id = ${demoVisitorId}::uuid
  `;
  // A reset test leaves a durable purge row behind until the worker handles
  // it. Remove that row while holding the same claim lane as the worker so a
  // queued, retrying, or just-starting purge cannot race the fresh seed
  // identity below. The reset-operation FK is removed first above.
  yield* sql`
    delete from jobs
    where kind = 'demo_identity_purge'
      and payload->>'visitorId' = ${demoVisitorId}
  `;

  yield* sql`
    delete from jobs
    where kind = 'ai_chat_run'
      and payload->>'aiRunId' in (
        select id::text from ai_runs where initiating_user_id = ${demoVisitorId}
      )
  `;
  // Chat deletion cascades the immutable assistant-source rows that can retain
  // demo memory revisions. Remove those references before deleting the cited
  // revisions so reset preserves the production retention foreign keys.
  yield* sql`delete from chats where user_id = ${demoVisitorId}`;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      // The head-revision FK is intentionally deferred so the canonical memory
      // and immutable revision rows can be removed together without ever
      // manufacturing an invalid intermediate memory state.
      yield* sql`delete from user_memory_revisions where memory_id in (select id from user_memories where user_id = ${demoVisitorId})`;
      yield* sql`delete from user_memories where user_id = ${demoVisitorId}`;
    }),
  );

  yield* sql.withTransaction(
    Effect.gen(function* () {
      // Serialize setup truncation with Smithers retention cleanup. Both
      // paths use this transaction-level fence so a worker cannot hold an
      // access share lock while setup requests a destructive truncate.
      yield* sql`
        select pg_advisory_xact_lock(
          hashtextextended(${AI_CHAT_SMITHERS_SCHEMA_FENCE}, 0)
        )
      `;
      for (const table of smithersTables) {
        yield* sql`truncate table ${sql(table.tableName)} cascade`;
      }
    }),
  );

  // Each browser test starts from the same canonical demo-source policy.
  // Tests may revoke one source through this setup boundary to prove that an
  // already acquired hosted path immediately fails closed.
  yield* sql`
    update client_company_public_source_settings
    set enabled = true, updated_by_user_id = ${demoVisitorId}, updated_at = now()
    where client_company_id = ${demoClientCompanyId}
      and source_id like 'e2e-%'
  `;
  yield* sql`
    insert into demo_sessions (visitor_id)
    values (${demoVisitorId}::uuid)
    on conflict (visitor_id) do update set revoked_at = null, last_seen_at = now()
  `;
}).pipe(Effect.asVoid);

const resetDemoRuntime = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  // Purge handlers and queue claims serialize on this transaction-level lane.
  // Holding it across the complete fixture reset prevents a pre-existing purge
  // from observing the freshly reactivated fixed visitor.
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`select pg_advisory_xact_lock(hashtext('hartlib:jobs:claim'))`;
      yield* resetDemoRuntimeBody;
    }),
  );
}).pipe(Effect.asVoid);

const disableDemoPublicSource = (sourceId: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const updated = yield* sql<{ readonly sourceId: string }>`
      update client_company_public_source_settings
      set enabled = false, updated_by_user_id = ${demoVisitorId}, updated_at = now()
      where client_company_id = ${demoClientCompanyId}
        and source_id = ${sourceId}
        and source_id like 'e2e-%'
      returning source_id as "sourceId"
    `;
    if (updated.length !== 1) {
      return yield* Effect.fail(new Error("demo public source setting was not found"));
    }
    return updated[0]!;
  });

const countActiveDemoAiChatJobs = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  const rows = yield* sql<{ readonly count: number }>`
    select count(*)::int as count
    from jobs
    where kind = 'ai_chat_run'
      and status in ('queued', 'retrying', 'running')
      and payload->>'aiRunId' in (
        select id::text from ai_runs where initiating_user_id = ${demoVisitorId}
      )
  `;
  return rows[0]?.count ?? 0;
});

const waitForDemoAiChatJobsToQuiesce = async (): Promise<void> => {
  const deadline = Date.now() + resetQuiescenceTimeoutMs;
  let consecutiveZeroObservations = 0;
  while (Date.now() < deadline) {
    const activeCount = await runDb(databaseUrl, countActiveDemoAiChatJobs);
    if (activeCount === 0) {
      // Playwright runs this E2E project with one worker, so beforeEach cannot
      // submit a new API request while reset is quiescing. Two observations
      // separated by one poll interval also cover a just-committed status
      // transition becoming visible between the first count and reset.
      consecutiveZeroObservations += 1;
      if (consecutiveZeroObservations >= 2) return;
    } else {
      consecutiveZeroObservations = 0;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, resetQuiescencePollMs));
  }
  const activeCount = await runDb(databaseUrl, countActiveDemoAiChatJobs);
  throw new Error(
    `E2E reset refused to race ${activeCount} active demo ai_chat_run job(s) after ${resetQuiescenceTimeoutMs}ms`,
  );
};

const readRuntimeState = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  const chats = yield* sql<{
    readonly id: string;
    readonly companyId: string;
    readonly webEnabled: boolean;
  }>`
    select chats.id::text, chats.company_id::text as "companyId",
           settings.web_search_enabled as "webEnabled"
    from chats
    join client_company_ai_settings settings on settings.company_id = chats.company_id
    where chats.user_id = ${demoVisitorId}
    order by chats.created_at, chats.id
  `;
  const runs = yield* sql<{
    readonly id: string;
    readonly chatId: string;
    readonly status: string;
    readonly errorCode: string | null;
    readonly retryable: boolean | null;
    readonly stopRequestedAt: Date | null;
    readonly stoppedAt: Date | null;
  }>`
    select id::text, chat_id::text as "chatId",
           case
             when finished_at is not null then 'succeeded'
             when failed_at is not null then 'failed'
             when stopped_at is not null then 'stopped'
             when superseded_at is not null then 'superseded'
             when started_at is not null then 'running'
             else 'queued'
           end as status,
           error_code as "errorCode", retryable,
           stop_requested_at as "stopRequestedAt", stopped_at as "stoppedAt"
    from ai_runs
    where initiating_user_id = ${demoVisitorId}
    order by created_at, id
  `;
  const providerMeasurements = yield* sql<{
    readonly runId: string;
    readonly provider: string | null;
    readonly providerEndpointIdentity: string | null;
    readonly modelId: string | null;
    readonly repairConsumed: boolean | null;
  }>`
    select observations.run_id::text as "runId",
           runs.acceptance_scope->>'provider' as provider,
           runs.acceptance_scope->>'providerEndpointIdentity' as "providerEndpointIdentity",
           observations.payload->>'modelId' as "modelId",
           (observations.payload->>'repairConsumed')::boolean as "repairConsumed"
    from ai_observations observations
    join ai_runs runs on runs.id = observations.run_id
    where runs.initiating_user_id = ${demoVisitorId}
      and observations.kind = 'provider_request_measurement'
    order by runs.created_at, observations.created_at, observations.id
  `;
  const providerUsages = yield* sql<{
    readonly runId: string;
    readonly providerServiceId: string;
    readonly modelId: string;
  }>`
    select usage.run_id::text as "runId",
           usage.provider_service_id as "providerServiceId",
           usage.model_id as "modelId"
    from ai_run_usage usage
    join ai_runs runs on runs.id = usage.run_id
    where runs.initiating_user_id = ${demoVisitorId}
    order by runs.created_at, usage.created_at, usage.id
  `;
  const events = yield* sql<{
    readonly runId: string;
    readonly seq: number;
    readonly type: string;
    readonly event: Record<string, unknown>;
    readonly emittedByTask: string | null;
  }>`
    select events.run_id::text as "runId", events.seq,
           events.event->>'type' as type, events.event,
           events.emitted_by_task as "emittedByTask"
    from ai_run_events events
    join ai_runs runs on runs.id = events.run_id
    where runs.initiating_user_id = ${demoVisitorId}
    order by runs.created_at, events.seq
  `;
  const memories = yield* sql<{
    readonly id: string;
    readonly content: string | null;
    readonly deleted: boolean;
    readonly headRevisionId: string | null;
  }>`
    select id::text, content, deleted_at is not null as deleted,
           head_revision_id::text as "headRevisionId"
    from user_memories
    where user_id = ${demoVisitorId} and provenance_only_at is null
    order by created_at, id
  `;
  const revisions = yield* sql<{
    readonly id: string;
    readonly memoryId: string;
    readonly action: string;
  }>`
    select revisions.id::text, revisions.memory_id::text as "memoryId", revisions.action
    from user_memory_revisions revisions
    join user_memories memories on memories.id = revisions.memory_id
    where memories.user_id = ${demoVisitorId}
    order by revisions.created_at, revisions.id
  `;
  const externalToolUsage = yield* sql<{
    readonly runId: string;
    readonly taskId: string;
    readonly loopIteration: number;
    readonly attempt: number;
    readonly toolRequestIndex: number;
    readonly operation: string;
    readonly status: string;
  }>`
    select usage.run_id::text as "runId", usage.task_id as "taskId",
           usage.loop_iteration as "loopIteration", usage.attempt,
           usage.tool_request_index as "toolRequestIndex",
           usage.operation, usage.status
    from ai_external_tool_usage usage
    join ai_runs runs on runs.id = usage.run_id
    where runs.initiating_user_id = ${demoVisitorId}
    order by runs.created_at, usage.task_id, usage.loop_iteration,
             usage.attempt, usage.tool_request_index
  `;
  return {
    chats,
    runs,
    providerMeasurements,
    providerUsages,
    events,
    memories,
    revisions,
    externalToolUsage,
  };
});

const seedPublicDocumentCitation = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  const documents = yield* sql<{
    readonly documentId: string;
    readonly snapshotId: string;
    readonly title: string;
    readonly canonicalUrl: string;
    readonly contentHash: string;
    readonly textCharCount: number;
    readonly publishedAt: Date;
  }>`
    select document_id as "documentId",
           document_id as "snapshotId",
           title,
           canonical_url as "canonicalUrl",
           content_hash as "contentHash",
           text_char_count::int as "textCharCount",
           coalesce(published_at, discovered_at) as "publishedAt"
    from public_source_documents
    where source_id = 'e2e-fr-energie'
      and text_char_count >= 100
    order by discovered_at, document_id
    limit 1
  `;
  const document = documents[0];
  if (document === undefined) {
    return yield* Effect.fail(new Error("public E2E citation document is unavailable"));
  }
  const ranges = [{ charStart: 0, charEnd: Math.min(document.textCharCount, 200) }];
  const publicSources = yield* sql<{ readonly sourceId: string }>`
    select source_id as "sourceId"
    from client_company_public_source_settings
    where client_company_id = ${demoClientCompanyId}
      and enabled
    order by source_id
  `;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const [chat] = yield* sql<{ readonly id: string }>`
        insert into chats (user_id, company_id, memory_mode)
        values (${demoVisitorId}, ${demoClientCompanyId}, 'private_owner')
        on conflict (user_id) do update set updated_at = chats.updated_at
        returning id::text
      `;
      if (chat === undefined) return yield* Effect.fail(new Error("demo chat is unavailable"));
      const [userMessage] = yield* sql<{ readonly id: string }>`
        insert into chat_messages (chat_id, author, content)
        values (${chat.id}, 'user', 'Show the public source evidence.')
        returning id::text
      `;
      const [run] = yield* sql<{
        readonly id: string;
        readonly citationNamespace: string;
      }>`
        insert into ai_runs (
          chat_id, initiating_user_id, user_message_id, locale, market,
          citation_namespace, acceptance_scope, started_at, finished_at
        ) values (
          ${chat.id}, ${demoVisitorId}, ${userMessage!.id}, 'en-US', 'US',
          ${citationNamespaceForSeed("public-document")},
          ${sql.json(
            acceptanceScopeForSeed({
              chatId: chat.id,
              companyId: demoClientCompanyId,
              publicSourceIds: publicSources.map((source) => source.sourceId),
            }),
          )},
          now(), now()
        )
        returning id::text, citation_namespace as "citationNamespace"
      `;
      if (run === undefined)
        return yield* Effect.fail(new Error("public citation run is unavailable"));
      const sourceKey = `k_${run.citationNamespace}_1`;
      const [message] = yield* sql<{ readonly id: string }>`
        insert into chat_messages (chat_id, author, content, assistant_ai_run_id)
        values (${chat.id}, 'assistant', ${`Authorized public source evidence [[cite:${sourceKey}]].`}, ${run.id})
        returning id::text
      `;
      if (message === undefined)
        return yield* Effect.fail(new Error("public citation message is unavailable"));
      yield* sql`
        update ai_runs set assistant_message_id = ${message.id} where id = ${run.id}
      `;
      const sourceId = "e2e-fr-energie";
      const citationUrl = document.canonicalUrl;
      yield* sql`
        insert into assistant_message_sources (
          run_id, assistant_message_id, source_key, kind, locator,
          snapshot_id, document_source_id, document_id, content_hash,
          display_label, public_provenance, source_identity_digest, citation_namespace
        ) values (
          ${run.id}, ${message.id}, ${sourceKey}, 'document',
          ${sql.json({
            kind: "document",
            sourceId: `public:${sourceId}`,
            documentId: document.documentId,
            snapshotId: document.snapshotId,
            contentHash: document.contentHash,
            ranges,
          })},
          ${document.snapshotId}, ${`public:${sourceId}`}, ${document.documentId}, ${document.contentHash},
          ${document.title},
          ${sql.json({
            sourceName: "Observatoire Energie",
            documentTitle: document.title,
            citationUrl,
            publishedAt: document.publishedAt.toISOString(),
          })},
          ${"0".repeat(64)}, ${run.citationNamespace}
        )
      `;
      yield* sql`
        insert into assistant_message_source_uses (
          run_id, assistant_message_id, source_key, consumer_task_id, topic_id,
          rendered_token_count, context_order, ranges, source_use_identity_digest
        ) values (
          ${run.id}, ${message.id}, ${sourceKey}, 'single-answer', null,
          20, 0, ${JSON.stringify(ranges)}::jsonb, ${"0".repeat(64)}
        )
      `;
      return { chatId: chat.id, messageId: message.id, citationUrl };
    }),
  );
});

const makeLatestCitedMemoryProvenanceOnly = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const cited = yield* sql<{
        readonly memoryId: string;
        readonly revisionId: string;
      }>`
        select memories.id::text as "memoryId",
               sources.memory_revision_id::text as "revisionId"
        from assistant_message_sources sources
        join user_memory_revisions revisions on revisions.id = sources.memory_revision_id
        join user_memories memories on memories.id = revisions.memory_id
        where sources.kind = 'memory'
          and memories.user_id = ${demoVisitorId}
        order by sources.created_at desc, sources.assistant_message_id desc, sources.source_key desc
        limit 1
        for update of memories, revisions
      `;
      const identity = cited[0];
      if (identity === undefined) {
        return yield* Effect.fail(new Error("no cited demo memory revision exists"));
      }
      yield* sql`
        delete from user_memory_revisions revisions
        where revisions.memory_id = ${identity.memoryId}
          and revisions.id <> ${identity.revisionId}
          and not exists (
            select 1 from assistant_message_sources sources
            where sources.memory_revision_id = revisions.id
          )
      `;
      yield* sql`
        update user_memory_revisions revisions
        set state_before = null, run_id = null
        where revisions.memory_id = ${identity.memoryId}
          and exists (
            select 1 from assistant_message_sources sources
            where sources.memory_revision_id = revisions.id
          )
      `;
      yield* sql`
        update user_memories
        set kind = null,
            content = null,
            head_revision_id = null,
            source_message_id = null,
            deleted_at = now() - interval '31 days',
            provenance_only_at = now(),
            updated_at = now()
        where id = ${identity.memoryId}
      `;
      return identity;
    }),
  );
});

const seedActiveRun = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  const chats = yield* sql<{ readonly id: string; readonly companyId: string }>`
      select id::text, company_id::text as "companyId"
      from chats where user_id = ${demoVisitorId}
      order by created_at, id limit 1
    `;
  const primary = chats[0];
  if (primary === undefined) return yield* Effect.fail(new Error("demo chat is not initialized"));
  const publicSources = yield* sql<{ readonly sourceId: string }>`
      select source_id as "sourceId"
      from client_company_public_source_settings
      where client_company_id = ${primary.companyId}
        and enabled
      order by source_id
    `;
  const messages = yield* sql<{ readonly id: string }>`
      insert into chat_messages (chat_id, author, content)
      values (${primary.id}, 'user', 'Seeded active-run guard')
      returning id::text
    `;
  const runs = yield* sql<{ readonly id: string }>`
      insert into ai_runs (
        chat_id, initiating_user_id, user_message_id, locale, market,
        citation_namespace, acceptance_scope
      ) values (
        ${primary.id}, ${demoVisitorId}, ${messages[0]!.id}, 'fr-FR', 'FR',
        ${citationNamespaceForSeed("active")},
        ${sql.json(
          acceptanceScopeForSeed({
            chatId: primary.id,
            companyId: primary.companyId,
            publicSourceIds: publicSources.map((source) => source.sourceId),
          }),
        )}
      )
      returning id::text
    `;
  return { chatId: primary.id, runId: runs[0]!.id };
});

const seedPurgeRetry = (visitorId: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const companyId = clientCompanyIdForVisitor(visitorId);
    const uniqueKey = `demo-identity-purge:${visitorId}`;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const existing = yield* sql<{ readonly id: string }>`
          select id::text
          from jobs
          where unique_key = ${uniqueKey}
        `;
        if (existing[0] !== undefined) {
          return yield* Effect.fail(new Error("purge retry seed already exists"));
        }
        yield* sql`
          insert into demo_sessions (visitor_id, revoked_at)
          values (${visitorId}::uuid, now())
        `;
        yield* sql`
          insert into platform_users (id, primary_email, display_name)
          values (${visitorId}, ${`purge+${visitorId}@hartlib.test`}, ${`Purge ${visitorId}`})
        `;
        yield* sql`
          insert into client_companies (id, name)
          values (${companyId}::uuid, ${`Purge company for ${visitorId}`})
        `;
        yield* sql`
          insert into client_company_memberships (company_id, user_id, role)
          values (${companyId}::uuid, ${visitorId}, 'admin')
        `;
        const chats = yield* sql<{ readonly id: string }>`
          insert into chats (user_id, company_id, memory_mode)
          values (${visitorId}, ${companyId}::uuid, 'private_owner')
          returning id::text
        `;
        const chat = chats[0];
        if (chat === undefined)
          return yield* Effect.fail(new Error("purge retry chat was not created"));
        const messages = yield* sql<{ readonly id: string }>`
          insert into chat_messages (chat_id, author, content)
          values (${chat.id}, 'user', 'Durable purge retry seed')
          returning id::text
        `;
        const message = messages[0];
        if (message === undefined)
          return yield* Effect.fail(new Error("purge retry message was not created"));
        const runs = yield* sql<{ readonly id: string }>`
          insert into ai_runs (
            chat_id, initiating_user_id, user_message_id, locale, market,
            citation_namespace, acceptance_scope, started_at, next_event_seq
          ) values (
            ${chat.id}, ${visitorId}, ${message.id}, 'en-US', 'US',
            ${citationNamespaceForSeed(`purge-retry:${visitorId}`)},
            ${sql.json(
              acceptanceScopeForSeed({
                userId: visitorId,
                chatId: chat.id,
                companyId,
                publicSourceIds: [],
              }),
            )},
            now(), 1
          )
          returning id::text
        `;
        const run = runs[0];
        if (run === undefined)
          return yield* Effect.fail(new Error("purge retry run was not created"));
        const jobs = yield* sql<{ readonly id: string }>`
          insert into jobs (kind, payload, unique_key, status, attempts, max_attempts, available_at)
          values (
            'demo_identity_purge',
            ${sql.json({ visitorId })},
            ${uniqueKey},
            'queued',
            5,
            2147483647,
            now()
          )
          returning id::text
        `;
        const job = jobs[0];
        if (job === undefined)
          return yield* Effect.fail(new Error("purge retry job was not created"));
        return { visitorId, companyId, chatId: chat.id, runId: run.id, jobId: job.id };
      }),
    );
  });

const readPurgeRetryState = (visitorId: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const jobs = yield* sql<{
      readonly id: string;
      readonly status: string;
      readonly attempts: number;
      readonly maxAttempts: number;
      readonly availableAt: string;
      readonly lastError: string | null;
    }>`
      select id::text,
             status,
             attempts,
             max_attempts as "maxAttempts",
             available_at::text as "availableAt",
             last_error as "lastError"
      from jobs
      where kind = 'demo_identity_purge'
        and payload->>'visitorId' = ${visitorId}
      order by created_at desc, id desc
      limit 1
    `;
    const graph = yield* sql<{
      readonly sessions: number;
      readonly users: number;
      readonly companies: number;
      readonly memberships: number;
      readonly chats: number;
      readonly runs: number;
    }>`
      select
        (select count(*)::int from demo_sessions where visitor_id = ${visitorId}::uuid) as sessions,
        (select count(*)::int from platform_users where id = ${visitorId}) as users,
        (select count(*)::int from client_companies where id = ${clientCompanyIdForVisitor(visitorId)}::uuid) as companies,
        (select count(*)::int from client_company_memberships where user_id = ${visitorId}) as memberships,
        (select count(*)::int from chats where user_id = ${visitorId}) as chats,
        (select count(*)::int from ai_runs where initiating_user_id = ${visitorId}) as runs
    `;
    const activeRuns = yield* sql<{ readonly count: number }>`
      select count(*)::int as count
      from ai_runs
      where initiating_user_id = ${visitorId}
        and finished_at is null
        and failed_at is null
        and stopped_at is null
        and superseded_at is null
    `;
    return {
      visitorId,
      job: jobs[0] ?? null,
      graph: graph[0] ?? {
        sessions: 0,
        users: 0,
        companies: 0,
        memberships: 0,
        chats: 0,
        runs: 0,
      },
      activeRuns: activeRuns[0]?.count ?? 0,
    };
  });

const releasePurgeRetry = (visitorId: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const runs = yield* sql<{ readonly id: string }>`
          update ai_runs
          set stop_requested_at = coalesce(stop_requested_at, now()),
              stopped_at = coalesce(stopped_at, now())
          where initiating_user_id = ${visitorId}
            and finished_at is null
            and failed_at is null
            and stopped_at is null
            and superseded_at is null
          returning id::text
        `;
        const jobs = yield* sql<{ readonly id: string }>`
          update jobs
          set status = 'queued',
              available_at = now(),
              locked_at = null,
              locked_by = null,
              last_error = null,
              updated_at = now()
          where kind = 'demo_identity_purge'
            and payload->>'visitorId' = ${visitorId}
            and status in ('queued', 'retrying')
          returning id::text
        `;
        return { visitorId, releasedRuns: runs.length, releasedJobs: jobs.length };
      }),
    );
  });

const seedPrunedStreamRun = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  const chats = yield* sql<{ readonly id: string; readonly companyId: string }>`
    select id::text, company_id::text as "companyId"
    from chats where user_id = ${demoVisitorId}
    order by created_at, id limit 1
  `;
  const primary = chats[0];
  if (primary === undefined) return yield* Effect.fail(new Error("demo chat is not initialized"));
  const publicSources = yield* sql<{ readonly sourceId: string }>`
    select source_id as "sourceId"
    from client_company_public_source_settings
    where client_company_id = ${primary.companyId}
      and enabled
    order by source_id
  `;
  const messages = yield* sql<{ readonly id: string }>`
    insert into chat_messages (chat_id, author, content)
    values (${primary.id}, 'user', 'Seeded pruned stream')
    returning id::text
  `;
  const runs = yield* sql<{ readonly id: string }>`
    insert into ai_runs (
      chat_id, initiating_user_id, user_message_id, locale, market,
      citation_namespace, acceptance_scope, started_at, next_event_seq
    ) values (
      ${primary.id}, ${demoVisitorId}, ${messages[0]!.id}, 'en-US', 'US',
      ${citationNamespaceForSeed("pruned-stream")},
      ${sql.json(
        acceptanceScopeForSeed({
          chatId: primary.id,
          companyId: primary.companyId,
          publicSourceIds: publicSources.map((source) => source.sourceId),
        }),
      )},
      now(), 5
    )
    returning id::text
  `;
  const runId = runs[0]!.id;
  yield* sql`
    insert into ai_run_events (run_id, seq, emission_key, event)
    values
      (${runId}, 1, 'run_started', ${sql.json({ type: "run_started" })}),
      (${runId}, 2, 'context_ready', ${sql.json({
        type: "context_ready",
        mode: "single",
        compactionRan: false,
        sourcesRead: [],
        consumers: [],
      })}),
      (${runId}, 3, 'answer_started:1', ${sql.json({
        type: "answer_started",
        mode: "single",
        attempt: 1,
      })}),
      (${runId}, 4, 'text_delta:1:0', ${sql.json({ type: "text_delta", delta: "provisional answer" })})
  `;
  return { chatId: primary.id, runId };
});

const seedFailedRun = (chatId: string, content: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const chats = yield* sql<{ readonly id: string; readonly companyId: string }>`
      select id::text, company_id::text as "companyId"
      from chats
      where id = ${chatId}
        and user_id = ${demoVisitorId}
    `;
    const chat = chats[0];
    if (chat === undefined) return yield* Effect.fail(new Error("failed-run chat is unavailable"));
    const publicSources = yield* sql<{ readonly sourceId: string }>`
      select source_id as "sourceId"
      from client_company_public_source_settings
      where client_company_id = ${chat.companyId}
        and enabled
      order by source_id
    `;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const messages = yield* sql<{ readonly id: string }>`
          insert into chat_messages (chat_id, author, content)
          values (${chat.id}, 'user', ${content})
          returning id::text
        `;
        const runs = yield* sql<{ readonly id: string }>`
          insert into ai_runs (
            chat_id, initiating_user_id, user_message_id, locale, market,
            citation_namespace, acceptance_scope, started_at, failed_at,
            error_code, retryable, next_event_seq
          ) values (
            ${chat.id}, ${demoVisitorId}, ${messages[0]!.id}, 'en-US', 'US',
            ${citationNamespaceForSeed(`failed:${content}`)},
            ${sql.json(
              acceptanceScopeForSeed({
                chatId: chat.id,
                companyId: chat.companyId,
                publicSourceIds: publicSources.map((source) => source.sourceId),
              }),
            )},
            now(), now(), 'answer_failed', true, 3
          )
          returning id::text
        `;
        const runId = runs[0]!.id;
        yield* sql`
          insert into ai_run_events (run_id, seq, emission_key, event)
          values
            (${runId}, 1, 'run_started', ${sql.json({ type: "run_started" })}),
            (${runId}, 2, 'terminal', ${sql.json({
              type: "error",
              code: "answer_failed",
              retryable: true,
            })})
        `;
        return { chatId: chat.id, runId, messageId: messages[0]!.id };
      }),
    );
  });

const pruneSeededStreamRun = (runId: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const runs = yield* sql<{ readonly id: string }>`
          select id::text
          from ai_runs
          where id = ${runId} and initiating_user_id = ${demoVisitorId}
          for update
        `;
        if (runs[0] === undefined)
          return yield* Effect.fail(new Error("seeded stream run not found"));
        yield* sql`
          update ai_runs
          set failed_at = now(), error_code = 'context_plan_unfit', retryable = true
          where id = ${runId}
        `;
        yield* sql`
          insert into ai_run_events (run_id, seq, emission_key, event)
          values (${runId}, 5, 'terminal', ${sql.json({
            type: "error",
            code: "context_plan_unfit",
            retryable: true,
          })})
        `;
        yield* sql`
          delete from ai_run_events
          where run_id = ${runId} and emission_key = 'terminal'
        `;
      }),
    );
  });

const holdStreamGate = (gateId: string) =>
  runDb(
    databaseUrl,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`
            select pg_advisory_xact_lock(hashtext(${e2eStreamGateLockKey(gateId)}))
          `;
          yield* Effect.sync(() => {
            process.stdout.write(`${JSON.stringify({ gateId, ready: true })}\n`);
          });
          yield* Effect.promise(
            () =>
              new Promise<void>((resolve, reject) => {
                const cleanup = () => {
                  process.stdin.off("data", release);
                  process.stdin.off("end", release);
                  process.stdin.off("error", fail);
                };
                const release = () => {
                  cleanup();
                  resolve();
                };
                const fail = (cause: Error) => {
                  cleanup();
                  reject(cause);
                };
                process.stdin.once("data", release);
                process.stdin.once("end", release);
                process.stdin.once("error", fail);
                process.stdin.resume();
              }),
          );
        }),
      );
    }),
  );

const setup = async (): Promise<void> => {
  await createDatabase();
  await runDb(databaseUrl, runMigrations);
  await runDb(databaseUrl, ingestPublicCorpusAndSeedDemoData);
  await runDb(databaseUrl, assertSeededCorpusSearchable);
};

const command = process.argv[2] ?? "setup";

if (command === "setup") {
  await setup();
} else if (command === "teardown") {
  await dropDatabase();
} else if (command === "reset") {
  await waitForDemoAiChatJobsToQuiesce();
  await runDb(databaseUrl, resetDemoRuntime);
} else if (command === "state") {
  console.log(JSON.stringify(await runDb(databaseUrl, readRuntimeState)));
} else if (command === "seed-public-citation") {
  console.log(JSON.stringify(await runDb(databaseUrl, seedPublicDocumentCitation)));
} else if (command === "memory-provenance-only") {
  console.log(JSON.stringify(await runDb(databaseUrl, makeLatestCitedMemoryProvenanceOnly)));
} else if (command === "disable-demo-public-source") {
  const sourceId = process.argv[3] ?? "";
  if (!/^e2e-[a-z0-9-]+$/u.test(sourceId)) throw new Error("invalid E2E public source id");
  console.log(JSON.stringify(await runDb(databaseUrl, disableDemoPublicSource(sourceId))));
} else if (command === "seed-active-chat") {
  console.log(JSON.stringify(await runDb(databaseUrl, seedActiveRun)));
} else if (command === "seed-purge-retry") {
  const visitorId = process.argv[3] ?? "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(visitorId)) {
    throw new Error("invalid purge retry visitor id");
  }
  console.log(JSON.stringify(await runDb(databaseUrl, seedPurgeRetry(visitorId))));
} else if (command === "purge-retry-state") {
  const visitorId = process.argv[3] ?? "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(visitorId)) {
    throw new Error("invalid purge retry visitor id");
  }
  console.log(JSON.stringify(await runDb(databaseUrl, readPurgeRetryState(visitorId))));
} else if (command === "release-purge-retry") {
  const visitorId = process.argv[3] ?? "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(visitorId)) {
    throw new Error("invalid purge retry visitor id");
  }
  console.log(JSON.stringify(await runDb(databaseUrl, releasePurgeRetry(visitorId))));
} else if (command === "seed-pruned-stream-run") {
  console.log(JSON.stringify(await runDb(databaseUrl, seedPrunedStreamRun)));
} else if (command === "seed-failed-run") {
  const chatId = process.argv[3] ?? "";
  const content = process.argv[4] ?? "";
  if (!/^[0-9a-f-]{36}$/iu.test(chatId) || content.trim() === "") {
    throw new Error("invalid failed-run seed arguments");
  }
  console.log(JSON.stringify(await runDb(databaseUrl, seedFailedRun(chatId, content))));
} else if (command === "prune-seeded-stream-run") {
  const runId = process.argv[3] ?? "";
  if (!/^[0-9a-f-]{36}$/iu.test(runId)) throw new Error("invalid seeded stream run id");
  await runDb(databaseUrl, pruneSeededStreamRun(runId));
} else if (command === "hold-stream-gate") {
  const gateId = process.argv[3] ?? "";
  if (!isE2eStreamGateId(gateId)) throw new Error("invalid E2E stream gate id");
  await holdStreamGate(gateId);
} else {
  throw new Error(`Unknown e2e setup command: ${command}`);
}
