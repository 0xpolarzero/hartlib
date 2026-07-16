import { PgClient } from "@effect/sql-pg";
import { Effect, Redacted } from "effect";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { publisherIssueAdvisoryLockKey } from "@brief/shared";

import { runMigrations } from "../../db/migrate";
import { memoryExtractionSha256Hex } from "../runtime/canonicalization";
import type {
  AnswerLaneResult,
  FinalSourceRecord,
  MemoryExtractionArtifact,
  MemoryExtractionResult,
} from "../runtime/types";
import { appendAiRunEvent } from "./events";
import { AiRunSmithersRunIdMismatch, failAiRun, finalizeAiRun } from "./finalization";
import {
  ActiveAiRunError,
  deleteUserMemory,
  MemoryConflictError,
  MemoryRevertWindowExpiredError,
  revertUserMemory,
} from "./memory";
import {
  deriveAggregateAiRunUsage,
  insertAiExternalToolUsage,
  insertAiObservation,
  insertAiRunUsage,
  insertAiSourceExposure,
} from "./observability";
import { purgeUserMemoryTombstones } from "./retention";
import {
  pruneFinishedAiRunEvents,
  purgeAiRuntimeRetention,
  sweepAiChatSmithersRows,
} from "../workflow/smithers-cleanup";
import { AI_CHAT_SMITHERS_SCHEMA_FENCE } from "../smithers-interop";
import { TINYFISH_SEARCH_PROVIDER_ENDPOINT_IDENTITY } from "../web/tinyfish-search";

const isBun = typeof process.versions.bun === "string";
const databaseUrl = process.env.WORKER_POSTGRES_TEST_DATABASE_URL;
const databaseName = `brief_product_state_test_${process.pid}_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
const finalizeCoordinates = { loopIteration: 0, attempt: 1 } as const;

const sourceUrl = () => {
  if (databaseUrl === undefined) throw new Error("WORKER_POSTGRES_TEST_DATABASE_URL is required");
  return databaseUrl;
};

const databaseUrlFor = (name: string) => {
  const url = new URL(sourceUrl());
  url.pathname = `/${name}`;
  return url.toString();
};

const adminUrl = () => databaseUrlFor("postgres");
const testUrl = () => databaseUrlFor(databaseName);
const quoted = (value: string) => `"${value.replaceAll('"', '""')}"`;

const runDb = <A, E>(effect: Effect.Effect<A, E, PgClient.PgClient>, url = testUrl()): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        PgClient.layer({
          url: Redacted.make(url),
          applicationName: "brief-product-state-test",
        }),
      ),
    ),
  );

const runDbAs = <A, E>(
  applicationName: string,
  effect: Effect.Effect<A, E, PgClient.PgClient>,
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        PgClient.layer({
          url: Redacted.make(testUrl()),
          applicationName,
        }),
      ),
    ),
  );

const waitForDatabaseLock = async (applicationName: string): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const waiting = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{ readonly waiting: boolean }>`
          select exists(
            select 1
            from pg_stat_activity
            where datname = current_database()
              and application_name = ${applicationName}
              and wait_event_type = 'Lock'
          ) as waiting
        `)[0]!.waiting;
      }),
    );
    if (waiting) return;
    await Bun.sleep(5);
  }
  throw new Error(`${applicationName} did not wait for a database lock`);
};

interface Fixture {
  readonly companyId: string;
  readonly userId: string;
  readonly chatId: string;
  readonly userMessageId: string;
  readonly runId: string;
}

const createFixture = (suffix: string): Effect.Effect<Fixture, unknown, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const companyId = crypto.randomUUID();
    const chatId = crypto.randomUUID();
    const userId = `product-state-${suffix}-${crypto.randomUUID()}`;

    yield* sql`
      insert into client_companies (id, name)
      values (${companyId}, ${`Product state ${suffix}`})
    `;
    yield* sql`
      insert into client_company_memberships (company_id, user_id, role)
      values (${companyId}, ${userId}, 'admin')
    `;
    yield* sql`
      insert into client_company_ai_settings (company_id, web_search_enabled)
      values (${companyId}, true)
    `;
    yield* sql`
      insert into chats (id, company_id, user_id)
      values (${chatId}, ${companyId}, ${userId})
    `;
    const messages = yield* sql<{ readonly id: string }>`
      insert into chat_messages (chat_id, author, content)
      values (${chatId}, 'user', ${`Question ${suffix}`})
      returning id::text
    `;
    const userMessageId = messages[0]!.id;
    const runs = yield* sql<{ readonly id: string }>`
      insert into ai_runs (
        chat_id,
        initiating_user_id,
        user_message_id,
        locale,
        market,
        web_search_enabled,
        effective_web_policy,
        citation_nonce
      )
      values (
        ${chatId},
        ${userId},
        ${userMessageId},
        'en-US',
        'US',
        false,
        ${sql.json({ enabled: true, provider: "tinyfish", allowedDomains: null })},
        decode(${"00".repeat(16)}, 'hex')
      )
      returning id::text
    `;
    const runId = runs[0]!.id;
    yield* sql`
      update ai_runs
      set smithers_run_id = ${`ai-chat:${runId}`}
      where id = ${runId}
    `;
    yield* sql`
      insert into ai_observations (
        run_id, chat_id, emitting_task, loop_iteration, attempt,
        observation_key, kind, payload
      )
      values (
        ${runId}, ${chatId}, 'resolve-conversation', 0, 0,
        'fixture:conversation_resolution', 'conversation_resolution',
        ${sql.json({ mode: "continue", selectedTurnIds: [] })}
      )
    `;
    return { companyId, userId, chatId, userMessageId, runId };
  });

const persistMemoryArtifact = (
  fixture: Fixture,
  result: MemoryExtractionResult,
): Effect.Effect<MemoryExtractionArtifact, unknown, PgClient.PgClient> =>
  Effect.gen(function* () {
    const extractionSha256Hex = memoryExtractionSha256Hex(result);
    const observationKey = `product-state-test:memory-extraction:${extractionSha256Hex}`;
    yield* insertAiObservation({
      runId: fixture.runId,
      chatId: fixture.chatId,
      emittingTask: "memory-extract",
      loopIteration: 0,
      attempt: 1,
      observationKey,
      kind: "memory_extraction_result",
      payload: {
        proposalCount: result.proposals.length,
        discardedCount: result.discardedCount,
        extractionSha256Hex,
      },
    });
    return {
      result,
      producer: {
        taskId: "memory-extract",
        loopIteration: 0,
        attempt: 1,
        observationKey,
        extractionSha256Hex,
      },
    };
  });

const createNextRun = (fixture: Fixture, content: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const messages = yield* sql<{ readonly id: string }>`
      insert into chat_messages (chat_id, author, content)
      values (${fixture.chatId}, 'user', ${content})
      returning id::text
    `;
    const userMessageId = messages[0]!.id;
    const runs = yield* sql<{ readonly id: string }>`
      insert into ai_runs (
        chat_id, initiating_user_id, user_message_id, locale, market,
        web_search_enabled, effective_web_policy, citation_nonce
      )
      values (
        ${fixture.chatId}, ${fixture.userId}, ${userMessageId}, 'en-US', 'US', false,
        ${sql.json({ enabled: true, provider: "tinyfish", allowedDomains: null })},
        decode(${"00".repeat(16)}, 'hex')
      )
      returning id::text
    `;
    const runId = runs[0]!.id;
    yield* sql`
      update ai_runs
      set smithers_run_id = ${`ai-chat:${runId}`}
      where id = ${runId}
    `;
    yield* sql`
      insert into ai_observations (
        run_id, chat_id, emitting_task, loop_iteration, attempt,
        observation_key, kind, payload
      )
      values (
        ${runId}, ${fixture.chatId}, 'resolve-conversation', 0, 0,
        'fixture:conversation_resolution', 'conversation_resolution',
        ${sql.json({ mode: "continue", selectedTurnIds: [] })}
      )
    `;
    return { ...fixture, userMessageId, runId };
  });

const seedSingleObservability = (fixture: Fixture) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    for (const kind of [
      "execution_plan",
      "retrieval_manifest",
      "context_measurement",
      "context_serialized",
    ]) {
      yield* sql`
        insert into ai_observations (
          run_id, chat_id, emitting_task, loop_iteration, attempt,
          observation_key, kind, payload
        )
        values (
          ${fixture.runId}, ${fixture.chatId}, 'fixture', 0, 0,
          ${`fixture:${kind}`}, ${kind}, '{}'::jsonb
        )
      `;
    }
  });

const sourceFor = (fixture: Fixture): FinalSourceRecord => ({
  sourceKey: "k_AAAAAAAAAAAAAAAAAAAAAA_1",
  locator: { kind: "chat_message", messageId: fixture.userMessageId },
  label: "Question",
  publicProvenance: {},
  uses: [
    {
      consumerTaskId: "single-answer",
      contextOrder: 0,
      renderedTokenCount: 3,
      ranges: [],
    },
  ],
});

interface PublisherSourceFixture {
  readonly subscriptionId: string;
  readonly issueId: string;
  readonly documentId: string;
  readonly versionId: string;
  readonly contentHash: string;
}

const createPublisherSourceFixture = (
  fixture: Fixture,
): Effect.Effect<PublisherSourceFixture, unknown, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const publisherCompanyId = crypto.randomUUID();
    const subscriptionId = crypto.randomUUID();
    const issueId = crypto.randomUUID();
    const documentId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    const contentHash = createHash("sha256").update("Fence source text", "utf8").digest("hex");
    yield* sql`
      insert into publisher_companies (id, name)
      values (${publisherCompanyId}, ${`Fence publisher ${issueId}`})
    `;
    yield* sql`
      insert into publisher_subscriptions (id, publisher_company_id, name, created_by_user_id)
      values (${subscriptionId}, ${publisherCompanyId}, 'Fence publication', ${fixture.userId})
    `;
    yield* sql`
      insert into publisher_issues (
        id, subscription_id, title, status, publication_at, published_at,
        created_by_user_id
      ) values (
        ${issueId}, ${subscriptionId}, 'Fence issue', 'draft', null, null, ${fixture.userId}
      )
    `;
    yield* sql`
      insert into brief_documents (
        id, issue_id, title, original_file_name, object_key, media_type,
        byte_size, sha256_hex, upload_completed_at, created_by_user_id
      ) values (
        ${documentId}, ${issueId}, 'Fence document', 'fence.pdf',
        ${`fence/${documentId}.pdf`}, 'application/pdf', 1, ${"d".repeat(64)}, now(), ${fixture.userId}
      )
    `;
    yield* sql`
      insert into brief_document_versions (
        id, brief_document_id, content_hash, language, canonical_text,
        text_char_count, page_ranges
      ) values (
        ${versionId}, ${documentId}, ${contentHash}, 'english', 'Fence source text',
        17, '[{"pageNumber":1,"charStart":0,"charEnd":17}]'::jsonb
      )
    `;
    yield* sql`
      update brief_documents set current_version_id = ${versionId} where id = ${documentId}
    `;
    yield* sql`
      update publisher_issues
      set status = 'published', publication_at = now(), published_at = now()
      where id = ${issueId}
    `;
    return { subscriptionId, issueId, documentId, versionId, contentHash };
  });

const publisherSourceFor = (source: PublisherSourceFixture): FinalSourceRecord => ({
  sourceKey: "k_AAAAAAAAAAAAAAAAAAAAAA_1",
  locator: {
    kind: "document",
    sourceId: `publisher:${source.subscriptionId}`,
    documentId: source.documentId,
    documentVersionId: source.versionId,
    contentHash: source.contentHash,
    publisherIssueId: source.issueId,
    publisherDocumentId: source.documentId,
    ranges: [{ charStart: 0, charEnd: 8 }],
  },
  label: "Fence document",
  publicProvenance: {
    sourceName: "Fence publisher",
    issueTitle: "Fence issue",
    documentTitle: "Fence document",
    citationUrl: `/v1/issues/${source.issueId}/documents/${source.documentId}/content`,
    publishedAt: new Date().toISOString(),
  },
  uses: [
    {
      consumerTaskId: "single-answer",
      contextOrder: 0,
      renderedTokenCount: 8,
      ranges: [{ charStart: 0, charEnd: 8 }],
    },
  ],
});

const authorize = () => Effect.succeed({ authorized: true } as const);

describe.skipIf(!isBun || !databaseUrl)("canonical AI product state", () => {
  beforeAll(async () => {
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql.unsafe(`create database ${quoted(databaseName)}`);
      }),
      adminUrl(),
    );
    await runDb(runMigrations);
  }, 120_000);

  afterAll(async () => {
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
      adminUrl(),
    );
  }, 60_000);

  it("allocates immutable gapless sequences under concurrent replay", async () => {
    const fixture = await runDb(createFixture("events"));
    const replayed = await Promise.all(
      Array.from({ length: 24 }, () =>
        runDb(
          appendAiRunEvent({
            runId: fixture.runId,
            emissionKey: "text_delta:answer:0:0",
            event: { type: "text_delta", delta: "stable" },
            emittedByTask: "answer",
          }),
        ),
      ),
    );
    expect(new Set(replayed.map((event) => event.seq))).toEqual(new Set([1]));
    expect(replayed.filter((event) => event.inserted)).toHaveLength(1);

    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        runDb(
          appendAiRunEvent({
            runId: fixture.runId,
            emissionKey: `text_delta:answer:0:${index + 1}`,
            event: { type: "text_delta", delta: String(index) },
            emittedByTask: "answer",
          }),
        ),
      ),
    );
    const state = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const events = yield* sql<{ readonly seq: number }>`
          select seq from ai_run_events where run_id = ${fixture.runId} order by seq
        `;
        const [run] = yield* sql<{ readonly nextEventSeq: number }>`
          select next_event_seq as "nextEventSeq" from ai_runs where id = ${fixture.runId}
        `;
        return { events, run };
      }),
    );
    expect(state.events.map((row) => row.seq)).toEqual(
      Array.from({ length: 21 }, (_, index) => index + 1),
    );
    expect(state.run?.nextEventSeq).toBe(22);
  });

  it("deduplicates detailed usage and exposures while retaining attempts", async () => {
    const fixture = await runDb(createFixture("usage"));
    const usage = {
      runId: fixture.runId,
      taskId: "conversation-resolver",
      loopIteration: 0,
      attempt: 0,
      providerRequestIndex: 0,
      providerRequestSha256Hex: "a".repeat(64),
      agentRole: "conversation_resolver",
      modelId: "glm-fast",
      providerServiceId: "zai_coding_plan_official",
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        cachedTokens: 2,
        reasoningTokens: 1,
        totalTokens: 16,
        stopReason: "stop",
      },
    } as const;
    expect(await runDb(insertAiRunUsage(usage))).toBe(true);
    expect(await runDb(insertAiRunUsage(usage))).toBe(false);
    await runDb(insertAiRunUsage({ ...usage, attempt: 1 }));
    await runDb(
      insertAiExternalToolUsage({
        runId: fixture.runId,
        taskId: "web",
        loopIteration: 0,
        attempt: 0,
        toolRequestIndex: 0,
        providerServiceId: "zai_coding_plan_official",
        operation: "web_search",
        status: "empty",
        resultCount: 0,
        responseBytes: 12,
        billedUnits: null,
        durationMs: 30,
      }),
    );
    const exposure = {
      runId: fixture.runId,
      taskId: "retrieval",
      loopIteration: 0,
      attempt: 0,
      providerRequestIndex: 0,
      providerRequestSha256Hex: "a".repeat(64),
      sourceKind: "document" as const,
      logicalSourceIdentity: "document:1",
      publisherIssueId: "issue:1",
      publisherDocumentId: "document:1",
      contentItemIdentity: "version:1:range:a",
      exposureStage: "selector_preview",
      visibleTokenCount: 8,
      documentReconstruction: {
        sourceId: "public:source-1",
        documentId: "document-1",
        documentVersionId: "version-1",
        contentHash: "a".repeat(64),
        ranges: [{ charStart: 0, charEnd: 8 }],
      },
    };
    expect(await runDb(insertAiSourceExposure(exposure))).toBe(true);
    expect(await runDb(insertAiSourceExposure(exposure))).toBe(false);
    expect(
      await runDb(
        insertAiSourceExposure({ ...exposure, contentItemIdentity: "version:1:range:b" }),
      ),
    ).toBe(true);

    const aggregate = await runDb(deriveAggregateAiRunUsage(fixture.runId));
    expect(aggregate.model).toEqual({
      inputTokens: 20,
      outputTokens: 8,
      cachedTokens: 4,
      reasoningTokens: 2,
      totalTokens: 32,
      requestCount: 2,
    });
    expect(aggregate.web).toEqual({
      searchCount: 1,
      fetchCount: 0,
      responseBytes: 12,
      billedUnits: null,
    });
  });

  it("rejects divergent replays for every bound observability field", async () => {
    const fixture = await runDb(createFixture("observability-replay"));
    const expectConflict = async (operation: Promise<unknown>): Promise<void> => {
      await expect(operation).rejects.toThrow(/replay conflicts with an existing immutable row/u);
    };

    const observation = {
      runId: fixture.runId,
      chatId: fixture.chatId,
      emittingTask: "replay-task",
      loopIteration: 0,
      attempt: 0,
      observationKey: "replay:observation",
      kind: "context_measurement",
      payload: { mandatoryTokens: 3, passed: true },
    } as const;
    await expect(runDb(insertAiObservation(observation))).resolves.toBe(true);
    await expect(runDb(insertAiObservation(observation))).resolves.toBe(false);
    for (const divergent of [
      { ...observation, chatId: crypto.randomUUID() },
      { ...observation, emittingTask: "other-task" },
      { ...observation, loopIteration: 1 },
      { ...observation, attempt: 1 },
      { ...observation, kind: "context_decision" },
      { ...observation, payload: { mandatoryTokens: 4, passed: true } },
    ]) {
      await expectConflict(runDb(insertAiObservation(divergent)));
    }

    const usage = {
      runId: fixture.runId,
      taskId: "replay-model",
      loopIteration: 0,
      attempt: 0,
      providerRequestIndex: 0,
      agentRole: "direct_answer",
      modelId: "glm-5-turbo",
      providerServiceId: "deterministic_test" as const,
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        cachedTokens: 2,
        reasoningTokens: 1,
        totalTokens: 16,
        stopReason: "toolUse",
      },
    } as const;
    await expect(runDb(insertAiRunUsage(usage))).resolves.toBe(true);
    await expect(runDb(insertAiRunUsage(usage))).resolves.toBe(false);
    await expectConflict(runDb(insertAiRunUsage({ ...usage, agentRole: "topic_answer" })));
    await expectConflict(runDb(insertAiRunUsage({ ...usage, modelId: "glm-5.2" })));
    await expectConflict(
      runDb(insertAiRunUsage({ ...usage, providerServiceId: "openai_compatible_custom" })),
    );
    await expectConflict(
      runDb(
        insertAiRunUsage({
          ...usage,
          usage: { ...usage.usage, inputTokens: 11, totalTokens: 17 },
        }),
      ),
    );
    await expectConflict(
      runDb(
        insertAiRunUsage({
          ...usage,
          usage: { ...usage.usage, outputTokens: 5, totalTokens: 17 },
        }),
      ),
    );
    await expectConflict(
      runDb(
        insertAiRunUsage({
          ...usage,
          usage: { ...usage.usage, cachedTokens: 3, totalTokens: 17 },
        }),
      ),
    );
    await expectConflict(
      runDb(insertAiRunUsage({ ...usage, usage: { ...usage.usage, reasoningTokens: 2 } })),
    );
    await expectConflict(
      runDb(
        insertAiRunUsage({
          ...usage,
          usage: { ...usage.usage, inputTokens: 9, totalTokens: 15 },
        }),
      ),
    );
    await expectConflict(
      runDb(insertAiRunUsage({ ...usage, usage: { ...usage.usage, stopReason: "stop" } })),
    );

    const tamperedUsage = { ...usage, taskId: "replay-model-event" };
    await expect(runDb(insertAiRunUsage(tamperedUsage))).resolves.toBe(true);
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update ai_run_events
          set event = jsonb_set(event, '{role}', '"tampered"'::jsonb)
          where run_id = ${fixture.runId}
            and emission_key = ${`usage:request:model:${tamperedUsage.taskId}:0:0:0`}
        `;
      }),
    );
    await expectConflict(runDb(insertAiRunUsage(tamperedUsage)));

    const external = {
      runId: fixture.runId,
      taskId: "replay-web",
      loopIteration: 0,
      attempt: 0,
      toolRequestIndex: 0,
      providerServiceId: "deterministic_test",
      operation: "web_search" as const,
      status: "ok" as const,
      resultCount: 2,
      responseBytes: 32,
      billedUnits: 1,
      durationMs: 20,
    };
    await expect(runDb(insertAiExternalToolUsage(external))).resolves.toBe(true);
    await expect(runDb(insertAiExternalToolUsage(external))).resolves.toBe(false);
    for (const divergent of [
      { ...external, providerServiceId: "tinyfish_search_official" },
      { ...external, operation: "web_fetch" as const },
      { ...external, status: "failed" as const },
      { ...external, resultCount: 3 },
      { ...external, responseBytes: 33 },
      { ...external, billedUnits: null },
      { ...external, durationMs: 21 },
    ]) {
      await expectConflict(runDb(insertAiExternalToolUsage(divergent)));
    }

    const exposure = {
      runId: fixture.runId,
      taskId: "replay-exposure",
      loopIteration: 0,
      attempt: 0,
      providerRequestIndex: 0,
      providerRequestSha256Hex: "b".repeat(64),
      sourceKind: "document" as const,
      logicalSourceIdentity: "document:replay",
      publisherIssueId: "issue:replay",
      publisherDocumentId: "document:replay",
      contentItemIdentity: "version:replay:range:0-8",
      exposureStage: "context_candidate_inspection",
      visibleTokenCount: 8,
      documentReconstruction: {
        sourceId: "publisher:replay",
        documentId: "document-replay",
        documentVersionId: "version-replay",
        contentHash: "c".repeat(64),
        ranges: [{ charStart: 0, charEnd: 8 }],
      },
    };
    await expect(runDb(insertAiSourceExposure(exposure))).resolves.toBe(true);
    await expect(runDb(insertAiSourceExposure(exposure))).resolves.toBe(false);
    for (const divergent of [
      { ...exposure, sourceKind: "memory" as const, documentReconstruction: undefined },
      { ...exposure, logicalSourceIdentity: "document:other" },
      { ...exposure, publisherIssueId: "issue:other" },
      { ...exposure, publisherDocumentId: "document:other" },
      { ...exposure, visibleTokenCount: 9 },
      { ...exposure, providerRequestSha256Hex: "d".repeat(64) },
      {
        ...exposure,
        documentReconstruction: {
          ...exposure.documentReconstruction,
          sourceId: "publisher:other",
        },
      },
      {
        ...exposure,
        documentReconstruction: {
          ...exposure.documentReconstruction,
          documentId: "document-other",
        },
      },
      {
        ...exposure,
        documentReconstruction: {
          ...exposure.documentReconstruction,
          documentVersionId: "version-other",
        },
      },
      {
        ...exposure,
        documentReconstruction: {
          ...exposure.documentReconstruction,
          contentHash: "e".repeat(64),
        },
      },
      {
        ...exposure,
        documentReconstruction: {
          ...exposure.documentReconstruction,
          ranges: [{ charStart: 1, charEnd: 8 }],
        },
      },
    ]) {
      await expectConflict(runDb(insertAiSourceExposure(divergent)));
    }
  });

  it("locks the run before concurrent usage child inserts append events", async () => {
    const fixture = await runDb(createFixture("usage-event-lock-order"));
    const operations = Array.from({ length: 48 }, (_, index) => {
      const taskId = index % 2 === 0 ? `model-${index}` : `web-${index}`;
      if (index % 2 === 0) {
        return runDb(
          insertAiRunUsage({
            runId: fixture.runId,
            taskId,
            loopIteration: 0,
            attempt: 1,
            providerRequestIndex: index,
            agentRole: "single_answer",
            modelId: "glm-5-turbo",
            providerServiceId: "deterministic_test",
            usage: {
              inputTokens: 10,
              outputTokens: 4,
              cachedTokens: 0,
              reasoningTokens: 0,
              totalTokens: 14,
              stopReason: "stop",
            },
          }),
        );
      }
      return runDb(
        insertAiExternalToolUsage({
          runId: fixture.runId,
          taskId,
          loopIteration: 0,
          attempt: 1,
          toolRequestIndex: index,
          providerServiceId: "deterministic_test",
          operation: index % 4 === 1 ? "web_search" : "web_fetch",
          status: "ok",
          resultCount: 1,
          responseBytes: 32,
          billedUnits: 1,
          durationMs: 1,
        }),
      );
    });

    await expect(Promise.all(operations)).resolves.toHaveLength(48);
    const state = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const [counts] = yield* sql<{
          readonly usage: number;
          readonly external: number;
          readonly events: number;
          readonly nextEventSeq: number;
        }>`
          select
            (select count(*)::int from ai_run_usage where run_id = ${fixture.runId}) as usage,
            (select count(*)::int from ai_external_tool_usage where run_id = ${fixture.runId}) as external,
            (select count(*)::int from ai_run_events where run_id = ${fixture.runId}) as events,
            (select next_event_seq::int from ai_runs where id = ${fixture.runId}) as "nextEventSeq"
        `;
        return counts;
      }),
    );
    expect(state).toEqual({ usage: 24, external: 24, events: 48, nextEventSeq: 49 });
  }, 60_000);

  it("rejects malformed provider accounting before inserting a usage row", async () => {
    const fixture = await runDb(createFixture("usage-invalid"));
    const usage = {
      runId: fixture.runId,
      taskId: "conversation-resolver",
      loopIteration: 0,
      attempt: 0,
      providerRequestIndex: 0,
      providerRequestSha256Hex: "a".repeat(64),
      agentRole: "conversation_resolver",
      modelId: "glm-fast",
      providerServiceId: "zai_coding_plan_official" as const,
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        cachedTokens: 2,
        reasoningTokens: 5,
        totalTokens: 16,
        stopReason: "stop",
      },
    } as const;

    await expect(runDb(insertAiRunUsage(usage))).rejects.toThrow(
      "provider usage accounting is invalid",
    );
    const count = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const rows = yield* sql<{ readonly count: number }>`
          select count(*)::int as count from ai_run_usage where run_id = ${fixture.runId}
        `;
        return rows[0]?.count ?? 0;
      }),
    );
    expect(count).toBe(0);
  });

  it("requires one passed exact measurement with the same model for every provider usage", async () => {
    const usageFor = (fixture: Fixture) =>
      ({
        runId: fixture.runId,
        taskId: "single-answer",
        loopIteration: 0,
        attempt: 0,
        providerRequestIndex: 0,
        agentRole: "direct_answer",
        modelId: "glm-5.2",
        providerServiceId: "zai_coding_plan_official",
        usage: {
          inputTokens: 10,
          outputTokens: 4,
          cachedTokens: 0,
          reasoningTokens: 0,
          totalTokens: 14,
          stopReason: "stop",
        },
      }) as const;
    const measurementFor = (
      fixture: Fixture,
      modelId: "glm-5.2" | "glm-5-turbo",
      observationKey = "single-answer:measurement",
    ) =>
      insertAiObservation({
        runId: fixture.runId,
        chatId: fixture.chatId,
        emittingTask: "single-answer",
        loopIteration: 0,
        attempt: 0,
        observationKey,
        kind: "provider_request_measurement",
        payload: {
          providerRequestIndex: 0,
          agentRole: "direct_answer",
          modelId,
          requestSha256Hex: "a".repeat(64),
          sourceExposureProofSha256Hexes: [],
          inputTokens: 10,
          requestedOutputTokens: 4,
          usableInputTokens: 100,
          contextWindow: 100,
          passed: true,
        },
      });
    const inputFor = (fixture: Fixture, memory: MemoryExtractionArtifact) => ({
      runId: fixture.runId,
      expectedSmithersRunId: `ai-chat:${fixture.runId}`,
      coordinates: finalizeCoordinates,
      answer: {
        status: "ok" as const,
        mode: "single" as const,
        content: "Measured answer",
        sourceMap: [],
      },
      memory,
      authorize,
    });

    const missing = await runDb(createFixture("measurement-missing"));
    const missingMemory = await runDb(
      persistMemoryArtifact(missing, { proposals: [], discardedCount: 0 }),
    );
    await runDb(seedSingleObservability(missing));
    await runDb(insertAiRunUsage(usageFor(missing)));
    const missingExit = await runDb(Effect.exit(finalizeAiRun(inputFor(missing, missingMemory))));
    expect(missingExit._tag).toBe("Failure");
    await runDb(measurementFor(missing, "glm-5.2"));
    await expect(runDb(finalizeAiRun(inputFor(missing, missingMemory)))).resolves.toMatchObject({
      status: "succeeded",
    });

    const mismatch = await runDb(createFixture("measurement-model-mismatch"));
    const mismatchMemory = await runDb(
      persistMemoryArtifact(mismatch, { proposals: [], discardedCount: 0 }),
    );
    await runDb(seedSingleObservability(mismatch));
    await runDb(insertAiRunUsage(usageFor(mismatch)));
    await runDb(measurementFor(mismatch, "glm-5-turbo"));
    const mismatchExit = await runDb(
      Effect.exit(finalizeAiRun(inputFor(mismatch, mismatchMemory))),
    );
    expect(mismatchExit._tag).toBe("Failure");

    const duplicate = await runDb(createFixture("measurement-duplicate"));
    const duplicateMemory = await runDb(
      persistMemoryArtifact(duplicate, { proposals: [], discardedCount: 0 }),
    );
    await runDb(seedSingleObservability(duplicate));
    await runDb(measurementFor(duplicate, "glm-5.2", "measurement:first"));
    await runDb(measurementFor(duplicate, "glm-5.2", "measurement:second"));
    const duplicateExit = await runDb(
      Effect.exit(finalizeAiRun(inputFor(duplicate, duplicateMemory))),
    );
    expect(duplicateExit._tag).toBe("Failure");
  });

  it("finalizes answer, memory, provenance, citations, and terminal event exactly once", async () => {
    const fixture = await runDb(createFixture("finalize"));
    await runDb(seedSingleObservability(fixture));
    const source = sourceFor(fixture);
    const answer: AnswerLaneResult = {
      status: "ok",
      mode: "single",
      content:
        "Answer [[cite:k_AAAAAAAAAAAAAAAAAAAAAA_1,k_BBBBBBBBBBBBBBBBBBBBBB_2,k_CCCCCCCCCCCCCCCCCCCCCC_3]]",
      sourceMap: [source],
    };
    const memory = await runDb(
      persistMemoryArtifact(fixture, {
        proposals: [{ kind: "fact" as const, content: "  Likes exact results  " }],
        discardedCount: 2,
      }),
    );
    const input = {
      runId: fixture.runId,
      expectedSmithersRunId: `ai-chat:${fixture.runId}`,
      coordinates: finalizeCoordinates,
      answer,
      memory,
      authorize,
    };
    const first = await runDb(finalizeAiRun(input));
    const replay = await runDb(finalizeAiRun(input));
    expect(first.status).toBe("succeeded");
    expect(replay.alreadyTerminal).toBe(true);

    const state = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const [counts] = yield* sql<{
          readonly memories: number;
          readonly revisions: number;
          readonly assistants: number;
          readonly sources: number;
          readonly uses: number;
          readonly citations: number;
          readonly defects: number;
          readonly memoryWritten: number;
        }>`
          select
            (select count(*)::int from user_memories where user_id = ${fixture.userId}) as memories,
            (select count(*)::int from user_memory_revisions revisions join user_memories memories on memories.id = revisions.memory_id where memories.user_id = ${fixture.userId}) as revisions,
            (select count(*)::int from chat_messages where assistant_ai_run_id = ${fixture.runId}) as assistants,
            (select count(*)::int from assistant_message_sources sources join chat_messages messages on messages.id = sources.assistant_message_id where messages.assistant_ai_run_id = ${fixture.runId}) as sources,
            (select count(*)::int from assistant_message_source_uses uses join chat_messages messages on messages.id = uses.assistant_message_id where messages.assistant_ai_run_id = ${fixture.runId}) as uses,
            (select count(*)::int from ai_observations where run_id = ${fixture.runId} and kind = 'citation') as citations,
            (select count(*)::int from ai_observations where run_id = ${fixture.runId} and kind = 'citation_defect') as defects,
            (select count(*)::int from ai_observations where run_id = ${fixture.runId} and kind = 'memory_written') as "memoryWritten"
        `;
        const events = yield* sql<{ readonly key: string; readonly type: string }>`
          select emission_key as key, event->>'type' as type
          from ai_run_events where run_id = ${fixture.runId} order by seq
        `;
        const finalizationObservationCoordinates = yield* sql<{
          readonly loopIteration: number;
          readonly attempt: number;
        }>`
          select distinct loop_iteration as "loopIteration", attempt
          from ai_observations
          where run_id = ${fixture.runId}
            and emitting_task = 'finalize'
          order by loop_iteration, attempt
        `;
        const memoryWrittenPayloads = yield* sql<{ readonly payload: Record<string, unknown> }>`
          select payload from ai_observations
          where run_id = ${fixture.runId} and kind = 'memory_written'
          order by (payload->>'ordinal')::int
        `;
        const memoryApplications = yield* sql<{ readonly payload: Record<string, unknown> }>`
          select payload from ai_observations
          where run_id = ${fixture.runId} and kind = 'memory_application'
        `;
        const [memory] = yield* sql<{
          readonly content: string;
          readonly headRevisionId: string;
          readonly revisionId: string;
        }>`
          select memories.content, memories.head_revision_id::text as "headRevisionId", revisions.id::text as "revisionId"
          from user_memories memories
          join user_memory_revisions revisions on revisions.id = memories.head_revision_id
          where memories.user_id = ${fixture.userId}
        `;
        return {
          counts,
          events,
          finalizationObservationCoordinates,
          memoryWrittenPayloads,
          memoryApplications,
          memory,
        };
      }),
    );
    expect(state.counts).toMatchObject({
      memories: 1,
      revisions: 1,
      assistants: 1,
      sources: 1,
      uses: 1,
      citations: 1,
      defects: 2,
      memoryWritten: 1,
    });
    expect(state.memory?.content).toBe("Likes exact results");
    expect(state.memory?.headRevisionId).toBe(state.memory?.revisionId);
    expect(state.finalizationObservationCoordinates).toEqual([finalizeCoordinates]);
    expect(state.memoryWrittenPayloads).toEqual([
      {
        payload: {
          ordinal: 0,
          memoryId: expect.any(String),
          revisionId: expect.any(String),
          previousRevisionId: null,
          action: "create",
        },
      },
    ]);
    expect(state.memoryApplications).toEqual([
      {
        payload: {
          extractionTaskId: "memory-extract",
          extractionLoopIteration: 0,
          extractionAttempt: 1,
          extractionObservationKey: expect.any(String),
          extractionSha256Hex: expect.stringMatching(/^[a-f0-9]{64}$/u),
          proposalCount: 1,
          discardedCount: 2,
        },
      },
    ]);
    expect(state.events.map((event) => event.key)).toEqual([
      "memory_updated",
      "usage:run",
      "terminal",
    ]);
  });

  it("authorizes a cited memory revision before applying a same-turn update", async () => {
    const fixture = await runDb(createFixture("memory-citation-update"));
    const initialMemory = await runDb(
      persistMemoryArtifact(fixture, {
        proposals: [{ kind: "preference", content: "Use GWh" }],
        discardedCount: 0,
      }),
    );
    await runDb(
      finalizeAiRun({
        runId: fixture.runId,
        expectedSmithersRunId: `ai-chat:${fixture.runId}`,
        coordinates: finalizeCoordinates,
        answer: { status: "ok", mode: "clarification", content: "Saved", sourceMap: [] },
        memory: initialMemory,
        authorize,
      }),
    );

    const memory = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const [row] = yield* sql<{ readonly id: string; readonly revisionId: string }>`
          select id::text, head_revision_id::text as "revisionId"
          from user_memories where user_id = ${fixture.userId}
        `;
        return row!;
      }),
    );
    const next = await runDb(createNextRun(fixture, "Update the energy unit"));
    await runDb(seedSingleObservability(next));
    const updateMemory = await runDb(
      persistMemoryArtifact(next, {
        proposals: [
          {
            kind: "preference",
            content: "Use MWh",
            targetMemoryId: memory.id,
            expectedHeadRevisionId: memory.revisionId,
          },
        ],
        discardedCount: 0,
      }),
    );
    const source: FinalSourceRecord = {
      sourceKey: "k_AAAAAAAAAAAAAAAAAAAAAA_1",
      locator: { kind: "memory", memoryId: memory.id, memoryRevisionId: memory.revisionId },
      label: "Energy unit preference",
      publicProvenance: {},
      uses: [
        {
          consumerTaskId: "single-answer",
          contextOrder: 0,
          renderedTokenCount: 3,
          ranges: [],
        },
      ],
    };
    const result = await runDb(
      finalizeAiRun({
        runId: next.runId,
        expectedSmithersRunId: `ai-chat:${next.runId}`,
        coordinates: finalizeCoordinates,
        answer: {
          status: "ok",
          mode: "single",
          content: "The saved preference is cited [[cite:k_AAAAAAAAAAAAAAAAAAAAAA_1]]",
          sourceMap: [source],
        },
        memory: updateMemory,
        authorize: ({ sourceMap }) =>
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            const cited = sourceMap[0]?.locator;
            if (cited?.kind !== "memory") {
              return { authorized: false as const, code: "source_access_revoked" as const };
            }
            const rows = yield* sql<{ readonly authorized: boolean }>`
              select exists(
                select 1 from user_memories
                where id = ${cited.memoryId}
                  and head_revision_id = ${cited.memoryRevisionId}
                  and user_id = ${fixture.userId}
              ) as authorized
            `;
            return rows[0]?.authorized === true
              ? { authorized: true as const }
              : { authorized: false as const, code: "source_access_revoked" as const };
          }),
      }),
    );
    expect(result).toMatchObject({ status: "succeeded" });
  });

  it("uses publisher provenance to persist a public document whose ID collides with a publisher version", async () => {
    const fixture = await runDb(createFixture("document-identity-collision"));
    const collision = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const publicDocumentId = crypto.randomUUID();
        const publisherCompanyId = crypto.randomUUID();
        const publisherIssueId = crypto.randomUUID();
        const publisherDocumentId = crypto.randomUUID();
        const subscriptionId = crypto.randomUUID();
        const rawArtifactId = crypto.randomUUID();
        const sourceId = `collision-source-${crypto.randomUUID()}`;
        const canonicalUrl = "https://public.example/colliding-document";
        const text = "Public collision evidence. ".repeat(5);
        const publisherText = "Publisher collision text";
        const publicContentHash = createHash("sha256").update(text, "utf8").digest("hex");
        const publisherContentHash = createHash("sha256")
          .update(publisherText, "utf8")
          .digest("hex");
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              insert into publisher_companies (id, name)
              values (${publisherCompanyId}, 'Collision publisher')
            `;
            yield* sql`
              insert into publisher_subscriptions (
                id, publisher_company_id, name, created_by_user_id
              ) values (${subscriptionId}, ${publisherCompanyId}, 'Collision publication', ${fixture.userId})
            `;
            yield* sql`
              insert into publisher_issues (
                id, subscription_id, title, status,
                created_by_user_id
              ) values (
                ${publisherIssueId}, ${subscriptionId}, 'Collision issue', 'draft',
                ${fixture.userId}
              )
            `;
            yield* sql`
              insert into brief_documents (
                id, issue_id, title, original_file_name, object_key, media_type,
                byte_size, sha256_hex, upload_completed_at, created_by_user_id
              ) values (
                ${publisherDocumentId}, ${publisherIssueId}, 'Publisher collision document',
                'collision.pdf', ${`collision/${publisherDocumentId}.pdf`}, 'application/pdf',
                1, ${"b".repeat(64)}, now(), ${fixture.userId}
              )
            `;
            yield* sql`
              insert into brief_document_versions (
                id, brief_document_id, content_hash, language, canonical_text,
                text_char_count, page_ranges
              ) values (
                ${publicDocumentId}, ${publisherDocumentId}, ${publisherContentHash}, 'english',
                ${publisherText}, ${publisherText.length},
                '[{"pageNumber":1,"charStart":0,"charEnd":24}]'::jsonb
              )
            `;
            yield* sql`
              update brief_documents
              set current_version_id = ${publicDocumentId}
              where id = ${publisherDocumentId}
            `;
            yield* sql`
              update publisher_issues
              set status = 'published', publication_at = now(), published_at = now()
              where id = ${publisherIssueId}
            `;
            yield* sql`
              insert into public_sources (
                source_id, display_name, publisher_name, description, ingestion_method,
                discovery_url, average_chars_per_item
              ) values (
                ${sourceId}, 'Collision public source', 'Public publisher', 'Collision source',
                'manual', ${canonicalUrl}, ${text.length}
              )
            `;
            yield* sql`
              insert into public_source_raw_artifacts (
                id, source_id, canonical_url, fetched_at, media_type, body, body_hash
              ) values (
                ${rawArtifactId}, ${sourceId}, ${canonicalUrl}, now(), 'text/html',
                ${text}, ${publicContentHash}
              )
            `;
            yield* sql`
              insert into public_source_documents (
                document_id, source_id, canonical_url, title, published_at,
                discovered_at, fetched_at, language, document_type, text,
                text_char_count, content_hash, raw_artifact_id
              ) values (
                ${publicDocumentId}, ${sourceId}, ${canonicalUrl}, 'Public collision document', now(),
                now(), now(), 'en', 'article', ${text}, ${text.length}, ${publicContentHash}, ${rawArtifactId}
              )
            `;
            yield* sql`
              insert into client_company_public_source_settings (
                client_company_id, source_id, enabled, updated_by_user_id
              ) values (${fixture.companyId}, ${sourceId}, true, ${fixture.userId})
            `;
          }),
        );
        return {
          sourceId,
          subscriptionId,
          publicDocumentId,
          publisherIssueId,
          publisherDocumentId,
          publicContentHash,
          publisherContentHash,
          canonicalUrl,
        };
      }),
    );
    await runDb(seedSingleObservability(fixture));
    const memory = await runDb(
      persistMemoryArtifact(fixture, { proposals: [], discardedCount: 0 }),
    );
    const source: FinalSourceRecord = {
      sourceKey: "k_AAAAAAAAAAAAAAAAAAAAAA_1",
      locator: {
        kind: "document",
        sourceId: `public:${collision.sourceId}`,
        documentId: collision.publicDocumentId,
        documentVersionId: collision.publicDocumentId,
        contentHash: collision.publicContentHash,
        ranges: [{ charStart: 0, charEnd: 8 }],
      },
      label: "Public collision document",
      publicProvenance: {
        documentTitle: "Public collision document",
        citationUrl: collision.canonicalUrl,
      },
      uses: [
        {
          consumerTaskId: "single-answer",
          contextOrder: 0,
          renderedTokenCount: 8,
          ranges: [{ charStart: 0, charEnd: 8 }],
        },
      ],
    };
    await expect(
      runDb(
        finalizeAiRun({
          runId: fixture.runId,
          expectedSmithersRunId: `ai-chat:${fixture.runId}`,
          coordinates: finalizeCoordinates,
          answer: {
            status: "ok",
            mode: "single",
            content: "Public [[cite:k_AAAAAAAAAAAAAAAAAAAAAA_1]]",
            sourceMap: [source],
          },
          memory,
          authorize,
        }),
      ),
    ).resolves.toMatchObject({ status: "succeeded" });
    const persisted = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{
          readonly documentVersionId: string;
          readonly publisherDocumentVersionId: string | null;
        }>`
          select document_version_id as "documentVersionId",
                 publisher_document_version_id::text as "publisherDocumentVersionId"
          from assistant_message_sources
          where assistant_message_id = (select assistant_message_id from ai_runs where id = ${fixture.runId})
        `)[0]!;
      }),
    );
    expect(persisted).toEqual({
      documentVersionId: collision.publicDocumentId,
      publisherDocumentVersionId: null,
    });

    const malformed = await runDb(createFixture("document-identity-malformed"));
    await runDb(seedSingleObservability(malformed));
    const malformedMemory = await runDb(
      persistMemoryArtifact(malformed, { proposals: [], discardedCount: 0 }),
    );
    const wrongIssueId = crypto.randomUUID();
    const malformedSource: FinalSourceRecord = {
      ...source,
      locator: {
        kind: "document",
        sourceId: `publisher:${collision.subscriptionId}`,
        documentId: collision.publisherDocumentId,
        documentVersionId: collision.publicDocumentId,
        contentHash: collision.publisherContentHash,
        publisherIssueId: wrongIssueId,
        publisherDocumentId: collision.publisherDocumentId,
        ranges: [{ charStart: 0, charEnd: 8 }],
      },
      publicProvenance: {
        sourceName: "Collision publisher",
        issueTitle: "Collision issue",
        documentTitle: "Publisher collision document",
        citationUrl: `/v1/issues/${wrongIssueId}/documents/${collision.publisherDocumentId}/content`,
        publishedAt: new Date().toISOString(),
      },
    };
    await expect(
      runDb(
        finalizeAiRun({
          runId: malformed.runId,
          expectedSmithersRunId: `ai-chat:${malformed.runId}`,
          coordinates: finalizeCoordinates,
          answer: {
            status: "ok",
            mode: "single",
            content: "Malformed publisher source",
            sourceMap: [malformedSource],
          },
          memory: malformedMemory,
          authorize,
        }),
      ),
    ).rejects.toThrow("publisher document identity does not match database ownership");
  });

  it("blocks success finalization between full chat projection queries", async () => {
    const fixture = await runDb(createFixture("projection-finalization"));
    let signalBetweenQueries!: () => void;
    const betweenQueries = new Promise<void>((resolve) => {
      signalBetweenQueries = resolve;
    });
    let releaseProjection!: () => void;
    const projectionReleased = new Promise<void>((resolve) => {
      releaseProjection = resolve;
    });

    const projection = runDbAs(
      "brief-full-chat-projection-race",
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const [chat] = yield* sql<{ readonly companyId: string }>`
              select company_id::text as "companyId"
              from chats
              where id = ${fixture.chatId}
              for share
            `;
            yield* sql`
              select pg_advisory_xact_lock(
                hashtext(${`brief:client-members:${chat!.companyId}`})
              )
            `;
            yield* sql`
              select pg_advisory_xact_lock(hashtext(${`brief:ai-chat:${fixture.chatId}`}))
            `;
            const [messageState] = yield* sql<{
              readonly messageCount: number;
              readonly assistantCount: number;
            }>`
              select count(*)::int as "messageCount",
                     count(*) filter (where author = 'assistant')::int as "assistantCount"
              from chat_messages
              where chat_id = ${fixture.chatId}
            `;
            yield* Effect.sync(signalBetweenQueries);
            yield* Effect.promise(() => projectionReleased);
            const [runState] = yield* sql<{
              readonly finished: boolean;
              readonly assistantMessageId: string | null;
            }>`
              select finished_at is not null as finished,
                     assistant_message_id::text as "assistantMessageId"
              from ai_runs
              where id = ${fixture.runId}
            `;
            return { ...messageState!, ...runState! };
          }),
        );
      }),
    );
    await betweenQueries;

    const projectionMemory = await runDb(
      persistMemoryArtifact(fixture, { proposals: [], discardedCount: 0 }),
    );

    const finalization = runDbAs(
      "brief-finalization-behind-full-projection",
      finalizeAiRun({
        runId: fixture.runId,
        expectedSmithersRunId: `ai-chat:${fixture.runId}`,
        coordinates: finalizeCoordinates,
        answer: {
          status: "ok",
          mode: "clarification",
          content: "Clarify the request",
          sourceMap: [],
        },
        memory: projectionMemory,
        authorize,
      }),
    );
    try {
      await waitForDatabaseLock("brief-finalization-behind-full-projection");
    } finally {
      releaseProjection();
    }

    await expect(projection).resolves.toEqual({
      messageCount: 1,
      assistantCount: 0,
      finished: false,
      assistantMessageId: null,
    });
    await expect(finalization).resolves.toMatchObject({
      status: "succeeded",
      alreadyTerminal: false,
    });
    const stableAfter = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const [state] = yield* sql<{
          readonly assistantCount: number;
          readonly finished: boolean;
          readonly assistantMessageId: string | null;
        }>`
          select
            (
              select count(*)::int
              from chat_messages
              where chat_id = ${fixture.chatId} and author = 'assistant'
            ) as "assistantCount",
            finished_at is not null as finished,
            assistant_message_id::text as "assistantMessageId"
          from ai_runs
          where id = ${fixture.runId}
        `;
        return state!;
      }),
    );
    expect(stableAfter).toMatchObject({
      assistantCount: 1,
      finished: true,
      assistantMessageId: expect.any(String),
    });
  });

  it("observes a publisher restriction committed before finalization", async () => {
    const fixture = await runDb(createFixture("publisher-restriction-first"));
    const publisher = await runDb(createPublisherSourceFixture(fixture));
    await runDb(seedSingleObservability(fixture));
    const memory = await runDb(
      persistMemoryArtifact(fixture, { proposals: [], discardedCount: 0 }),
    );
    const source = publisherSourceFor(publisher);
    let signalHeld!: () => void;
    const held = new Promise<void>((resolve) => {
      signalHeld = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const restrictionHolder = runDbAs(
      "brief-publisher-restriction-holder",
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              select pg_advisory_xact_lock(
                hashtextextended(${publisherIssueAdvisoryLockKey(publisher.issueId)}, 0)
              )
            `;
            yield* sql`
              update publisher_issues
              set restricted_at = now(), restricted_by_user_id = ${fixture.userId},
                  restricted_reason = 'Publisher fence test', updated_at = now()
              where id = ${publisher.issueId}
            `;
            yield* Effect.sync(signalHeld);
            yield* Effect.promise(() => released);
          }),
        );
      }),
    );
    await held;

    const finalization = runDbAs(
      "brief-finalization-behind-publisher-restriction",
      finalizeAiRun({
        runId: fixture.runId,
        expectedSmithersRunId: `ai-chat:${fixture.runId}`,
        coordinates: finalizeCoordinates,
        answer: {
          status: "ok",
          mode: "single",
          content: "Restricted source",
          sourceMap: [source],
        },
        memory,
        authorize: ({ sourceMap }) =>
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            const issueId =
              sourceMap[0]?.locator.kind === "document"
                ? sourceMap[0].locator.publisherIssueId
                : undefined;
            const rows = yield* sql<{ readonly restricted: boolean }>`
              select restricted_at is not null as restricted
              from publisher_issues
              where id = ${issueId ?? publisher.issueId}
            `;
            return rows[0]?.restricted === true
              ? { authorized: false as const, code: "source_access_revoked" as const }
              : { authorized: true as const };
          }),
      }),
    );
    await waitForDatabaseLock("brief-finalization-behind-publisher-restriction");
    release();
    await restrictionHolder;
    await expect(finalization).resolves.toMatchObject({
      status: "failed",
      code: "source_access_revoked",
      alreadyTerminal: false,
    });
    const state = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{
          readonly assistantMessageId: string | null;
          readonly failed: boolean;
        }>`
          select assistant_message_id::text as "assistantMessageId",
                 failed_at is not null as failed
          from ai_runs where id = ${fixture.runId}
        `)[0]!;
      }),
    );
    expect(state).toEqual({ assistantMessageId: null, failed: true });
  });

  it("holds the publisher restriction lane through a successful finalization", async () => {
    const fixture = await runDb(createFixture("publisher-finalization-first"));
    const publisher = await runDb(createPublisherSourceFixture(fixture));
    await runDb(seedSingleObservability(fixture));
    const memory = await runDb(
      persistMemoryArtifact(fixture, { proposals: [], discardedCount: 0 }),
    );
    const source = publisherSourceFor(publisher);
    let signalAuthorization!: () => void;
    const authorizationEntered = new Promise<void>((resolve) => {
      signalAuthorization = resolve;
    });
    let releaseAuthorization!: () => void;
    const authorizationReleased = new Promise<void>((resolve) => {
      releaseAuthorization = resolve;
    });
    const finalization = runDbAs(
      "brief-publisher-finalization-holder",
      finalizeAiRun({
        runId: fixture.runId,
        expectedSmithersRunId: `ai-chat:${fixture.runId}`,
        coordinates: finalizeCoordinates,
        answer: {
          status: "ok",
          mode: "single",
          content: "Authorized source [[cite:k_AAAAAAAAAAAAAAAAAAAAAA_1]]",
          sourceMap: [source],
        },
        memory,
        authorize: () =>
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            const rows = yield* sql<{ readonly restricted: boolean }>`
              select restricted_at is not null as restricted
              from publisher_issues where id = ${publisher.issueId}
            `;
            if (rows[0]?.restricted !== false) {
              return { authorized: false as const, code: "source_access_revoked" as const };
            }
            yield* Effect.sync(signalAuthorization);
            yield* Effect.promise(() => authorizationReleased);
            return { authorized: true as const };
          }),
      }),
    );
    await authorizationEntered;

    const restriction = runDbAs(
      "brief-restriction-behind-publisher-finalization",
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              select pg_advisory_xact_lock(
                hashtextextended(${publisherIssueAdvisoryLockKey(publisher.issueId)}, 0)
              )
            `;
            const rows = yield* sql<{ readonly id: string }>`
              update publisher_issues
              set restricted_at = now(), restricted_by_user_id = ${fixture.userId},
                  restricted_reason = 'Restriction after finalization', updated_at = now()
              where id = ${publisher.issueId} and restricted_at is null
              returning id::text
            `;
            return rows.length === 1;
          }),
        );
      }),
    );
    await waitForDatabaseLock("brief-restriction-behind-publisher-finalization");
    releaseAuthorization();
    await expect(finalization).resolves.toMatchObject({ status: "succeeded" });
    await expect(restriction).resolves.toBe(true);

    const state = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{
          readonly assistantMessageId: string | null;
          readonly restricted: boolean;
        }>`
          select runs.assistant_message_id::text as "assistantMessageId",
                 issues.restricted_at is not null as restricted
          from ai_runs runs
          join assistant_message_sources sources on sources.assistant_message_id = runs.assistant_message_id
          join brief_document_versions versions on versions.id = sources.publisher_document_version_id
          join brief_documents documents on documents.id = versions.brief_document_id
          join publisher_issues issues on issues.id = documents.issue_id
          where runs.id = ${fixture.runId}
        `)[0]!;
      }),
    );
    expect(state).toEqual({
      assistantMessageId: expect.any(String),
      restricted: true,
    });
  });

  it("linearizes an export message snapshot before a concurrently finishing answer", async () => {
    const fixture = await runDb(createFixture("export-finalization"));
    const exportId = crypto.randomUUID();
    let signalSnapshotCaptured!: () => void;
    const snapshotCaptured = new Promise<void>((resolve) => {
      signalSnapshotCaptured = resolve;
    });
    let releaseAcceptance!: () => void;
    const acceptanceReleased = new Promise<void>((resolve) => {
      releaseAcceptance = resolve;
    });
    const acceptance = runDbAs(
      "brief-export-message-snapshot-holder",
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              select pg_advisory_xact_lock(
                hashtext(${`brief:client-members:${fixture.companyId}`})
              )
            `;
            const messageIds = yield* sql<{ readonly id: string }>`
              select id::text
              from chat_messages
              where chat_id = ${fixture.chatId}
              order by created_at, id
            `;
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
                  clientCompanyIds: [fixture.companyId],
                  accessIds: [],
                  issueIds: [],
                  documentIds: [],
                  chatIds: [fixture.chatId],
                  chatMessageIds: messageIds.map((message) => message.id),
                })},
                ${`export-finalization-${exportId}`}
              )
            `;
            yield* Effect.sync(signalSnapshotCaptured);
            yield* Effect.promise(() => acceptanceReleased);
            return messageIds.map((message) => message.id);
          }),
        );
      }),
    );
    await snapshotCaptured;

    const exportMemory = await runDb(
      persistMemoryArtifact(fixture, { proposals: [], discardedCount: 0 }),
    );

    const finalization = runDbAs(
      "brief-finalization-behind-export-snapshot",
      finalizeAiRun({
        runId: fixture.runId,
        expectedSmithersRunId: `ai-chat:${fixture.runId}`,
        coordinates: finalizeCoordinates,
        answer: {
          status: "ok",
          mode: "clarification",
          content: "Clarify after export acceptance",
          sourceMap: [],
        },
        memory: exportMemory,
        authorize,
      }),
    );
    try {
      await waitForDatabaseLock("brief-finalization-behind-export-snapshot");
    } finally {
      releaseAcceptance();
    }
    const capturedMessageIds = await acceptance;
    await expect(finalization).resolves.toMatchObject({ status: "succeeded" });

    const after = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const [row] = yield* sql<{
          readonly assistantMessageId: string;
          readonly snapshottedMessageIds: string[];
        }>`
          select run.assistant_message_id::text as "assistantMessageId",
                 array(
                   select jsonb_array_elements_text(
                     request.authorization_snapshot->'chatMessageIds'
                   )
                 ) as "snapshottedMessageIds"
          from ai_runs run
          cross join export_requests request
          where run.id = ${fixture.runId} and request.id = ${exportId}
        `;
        return row!;
      }),
    );
    expect(capturedMessageIds).toEqual([fixture.userMessageId]);
    expect(after.snapshottedMessageIds).toEqual(capturedMessageIds);
    expect(after.snapshottedMessageIds).not.toContain(after.assistantMessageId);
  });

  it("serializes fatal terminal failure on the chat execution lane", async () => {
    const fixture = await runDb(createFixture("failure-execution-lane"));
    let signalLaneHeld!: () => void;
    const laneHeld = new Promise<void>((resolve) => {
      signalLaneHeld = resolve;
    });
    let releaseLane!: () => void;
    const laneReleased = new Promise<void>((resolve) => {
      releaseLane = resolve;
    });
    const holder = runDbAs(
      "brief-failure-lane-holder",
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              select pg_advisory_xact_lock(hashtext(${`brief:ai-chat:${fixture.chatId}`}))
            `;
            yield* Effect.sync(signalLaneHeld);
            yield* Effect.promise(() => laneReleased);
          }),
        );
      }),
    );
    await laneHeld;
    const failure = runDbAs(
      "brief-failure-behind-chat-projection",
      failAiRun(fixture.runId, "answer_failed"),
    );
    try {
      await waitForDatabaseLock("brief-failure-behind-chat-projection");
    } finally {
      releaseLane();
    }
    await holder;
    await expect(failure).resolves.toMatchObject({
      status: "failed",
      code: "answer_failed",
      alreadyTerminal: false,
    });
  });

  it("applies memory on controlled failure and fatal failure remains memory-free", async () => {
    const controlled = await runDb(createFixture("controlled-failure"));
    const controlledMemory = await runDb(
      persistMemoryArtifact(controlled, {
        proposals: [{ kind: "preference", content: "Prefers French" }],
        discardedCount: 0,
      }),
    );
    const result = await runDb(
      finalizeAiRun({
        runId: controlled.runId,
        expectedSmithersRunId: `ai-chat:${controlled.runId}`,
        coordinates: finalizeCoordinates,
        answer: { status: "failed", code: "answer_failed", retryable: false },
        memory: controlledMemory,
        authorize,
      }),
    );
    expect(result).toMatchObject({ status: "failed", code: "answer_failed", retryable: false });

    const fatal = await runDb(createFixture("fatal-failure"));
    await runDb(failAiRun(fatal.runId, "memory_extraction_failed", false));
    await runDb(failAiRun(fatal.runId, "answer_failed"));
    const afterTerminal = await runDb(
      Effect.flip(
        appendAiRunEvent({
          runId: fatal.runId,
          emissionKey: "text_delta:late:0:0",
          event: { type: "text_delta", delta: "late" },
        }),
      ),
    );
    expect(String(afterTerminal)).toContain("cannot append event after terminal run");
    const state = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const rows = yield* sql<{
          readonly runId: string;
          readonly memoryCount: number;
          readonly keys: string[];
          readonly retryable: boolean | null;
        }>`
          select
            runs.id::text as "runId",
            runs.retryable,
            (select count(*)::int from user_memories where user_id = runs.initiating_user_id) as "memoryCount",
            array(select emission_key from ai_run_events where run_id = runs.id order by seq) as keys
          from ai_runs runs
          where runs.id in (${controlled.runId}, ${fatal.runId})
          order by runs.id
        `;
        return rows;
      }),
    );
    const controlledState = state.find((row) => row.runId === controlled.runId)!;
    const fatalState = state.find((row) => row.runId === fatal.runId)!;
    expect(controlledState.memoryCount).toBe(1);
    expect(controlledState.retryable).toBe(false);
    expect(controlledState.keys).toEqual(["memory_updated", "usage:run", "terminal"]);
    expect(fatalState.memoryCount).toBe(0);
    expect(fatalState.retryable).toBe(false);
    expect(fatalState.keys).toEqual(["usage:run", "terminal"]);
  });

  it("fences success and controlled failure before any terminal mutation when Smithers identity is stale", async () => {
    const success = await runDb(createFixture("stale-smithers-success"));
    const successMemory = await runDb(
      persistMemoryArtifact(success, {
        proposals: [{ kind: "fact", content: "Must not be written" }],
        discardedCount: 0,
      }),
    );
    const controlled = await runDb(createFixture("stale-smithers-controlled"));
    const controlledMemory = await runDb(
      persistMemoryArtifact(controlled, {
        proposals: [{ kind: "preference", content: "Must not be written" }],
        discardedCount: 0,
      }),
    );
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update ai_runs
          set smithers_run_id = ${`stale:${success.runId}`}
          where id = ${success.runId}
        `;
        yield* sql`
          update ai_runs
          set smithers_run_id = ${`stale:${controlled.runId}`}
          where id = ${controlled.runId}
        `;
      }),
    );

    await expect(
      runDb(
        finalizeAiRun({
          runId: success.runId,
          expectedSmithersRunId: `ai-chat:${success.runId}`,
          coordinates: finalizeCoordinates,
          answer: {
            status: "ok",
            mode: "clarification",
            content: "Must not finalize",
            sourceMap: [],
          },
          memory: successMemory,
          authorize,
        }),
      ),
    ).rejects.toBeInstanceOf(AiRunSmithersRunIdMismatch);
    await expect(
      runDb(
        finalizeAiRun({
          runId: controlled.runId,
          expectedSmithersRunId: `ai-chat:${controlled.runId}`,
          coordinates: finalizeCoordinates,
          answer: { status: "failed", code: "answer_failed", retryable: false },
          memory: controlledMemory,
          authorize,
        }),
      ),
    ).rejects.toBeInstanceOf(AiRunSmithersRunIdMismatch);

    const state = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql<{
          readonly runId: string;
          readonly assistantCount: number;
          readonly memoryCount: number;
          readonly usageCount: number;
          readonly eventCount: number;
          readonly finishedAt: Date | null;
          readonly failedAt: Date | null;
        }>`
          select runs.id::text as "runId",
                 (select count(*)::int from chat_messages messages
                   where messages.assistant_ai_run_id = runs.id) as "assistantCount",
                 (select count(*)::int from user_memories memories
                   where memories.user_id = runs.initiating_user_id) as "memoryCount",
                 (select count(*)::int from ai_run_usage run_usage where run_usage.run_id = runs.id) as "usageCount",
                 (select count(*)::int from ai_run_events events where events.run_id = runs.id) as "eventCount",
                 runs.finished_at as "finishedAt", runs.failed_at as "failedAt"
          from ai_runs runs
          where runs.id in (${success.runId}, ${controlled.runId})
          order by runs.id
        `;
      }),
    );
    for (const row of state) {
      expect(row.assistantCount).toBe(0);
      expect(row.memoryCount).toBe(0);
      expect(row.usageCount).toBe(0);
      expect(row.eventCount).toBe(0);
      expect(row.finishedAt).toBeNull();
      expect(row.failedAt).toBeNull();
    }
  });

  it("rejects stale memory heads and manual mutation during an active run", async () => {
    const fixture = await runDb(createFixture("memory-lock"));
    const originalMemory = await runDb(
      persistMemoryArtifact(fixture, {
        proposals: [{ kind: "fact", content: "Original" }],
        discardedCount: 0,
      }),
    );
    await runDb(
      finalizeAiRun({
        runId: fixture.runId,
        expectedSmithersRunId: `ai-chat:${fixture.runId}`,
        coordinates: finalizeCoordinates,
        answer: { status: "ok", mode: "clarification", content: "Clarify", sourceMap: [] },
        memory: originalMemory,
        authorize,
      }),
    );
    const memory = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const [row] = yield* sql<{ readonly id: string; readonly head: string }>`
          select id::text, head_revision_id::text as head
          from user_memories where user_id = ${fixture.userId}
        `;
        return row!;
      }),
    );
    const next = await runDb(createNextRun(fixture, "Update memory"));
    const activeDelete = await runDb(Effect.flip(deleteUserMemory(next.userId, memory.id)));
    expect(activeDelete).toBeInstanceOf(ActiveAiRunError);

    const staleMemory = await runDb(
      persistMemoryArtifact(next, {
        proposals: [
          {
            kind: "fact",
            content: "Changed",
            targetMemoryId: memory.id,
            expectedHeadRevisionId: crypto.randomUUID(),
          },
        ],
        discardedCount: 0,
      }),
    );
    const stale = await runDb(
      Effect.flip(
        finalizeAiRun({
          runId: next.runId,
          expectedSmithersRunId: `ai-chat:${next.runId}`,
          coordinates: finalizeCoordinates,
          answer: { status: "ok", mode: "clarification", content: "Updated", sourceMap: [] },
          memory: staleMemory,
          authorize,
        }),
      ),
    );
    expect(stale).toBeInstanceOf(MemoryConflictError);

    await runDb(failAiRun(next.runId, "memory_conflict"));
    const deleted = await runDb(deleteUserMemory(next.userId, memory.id));
    const replay = await runDb(deleteUserMemory(next.userId, memory.id));
    expect(deleted.changed).toBe(true);
    expect(replay.changed).toBe(false);
    const reverted = await runDb(revertUserMemory(next.userId, memory.id, memory.head));
    expect(reverted.current).toEqual({ kind: "fact", content: "Original", deleted: false });
  });

  it("shares the exact API acceptance lock with worker memory mutation", async () => {
    const fixture = await runDb(createFixture("cross-service-lock"));
    const lockedMemory = await runDb(
      persistMemoryArtifact(fixture, {
        proposals: [{ kind: "fact", content: "Locked" }],
        discardedCount: 0,
      }),
    );
    await runDb(
      finalizeAiRun({
        runId: fixture.runId,
        expectedSmithersRunId: `ai-chat:${fixture.runId}`,
        coordinates: finalizeCoordinates,
        answer: { status: "ok", mode: "clarification", content: "Saved", sourceMap: [] },
        memory: lockedMemory,
        authorize,
      }),
    );
    const ids = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const [memory] = yield* sql<{ readonly id: string }>`
          select id::text from user_memories where user_id = ${fixture.userId}
        `;
        const [message] = yield* sql<{ readonly id: string }>`
          insert into chat_messages (chat_id, author, content)
          values (${fixture.chatId}, 'user', 'Accepted while delete races')
          returning id::text
        `;
        return { memoryId: memory!.id, messageId: message!.id };
      }),
    );

    const acceptance = runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              select pg_advisory_xact_lock(hashtext(${`brief:user-memory:${fixture.userId}`}))
            `;
            yield* sql`select pg_sleep(0.3)`;
            const [run] = yield* sql<{ readonly id: string }>`
              insert into ai_runs (
                chat_id, initiating_user_id, user_message_id, locale, market,
                web_search_enabled, effective_web_policy
              )
              values (
                ${fixture.chatId}, ${fixture.userId}, ${ids.messageId}, 'en-US', 'US', false,
                ${sql.json({ enabled: true, provider: "tinyfish", allowedDomains: null })}
              )
              returning id::text
            `;
            return run!.id;
          }),
        );
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const deletion = runDb(Effect.flip(deleteUserMemory(fixture.userId, ids.memoryId)));
    const [acceptedRunId, deletionError] = await Promise.all([acceptance, deletion]);
    expect(deletionError).toBeInstanceOf(ActiveAiRunError);
    expect((deletionError as ActiveAiRunError).runId).toBe(acceptedRunId);
    await runDb(failAiRun(acceptedRunId, "answer_failed"));
  });

  it("redacts referenced expired tombstones and hard-deletes unreferenced tombstones", async () => {
    const fixture = await runDb(createFixture("retention"));
    const retainedMemory = await runDb(
      persistMemoryArtifact(fixture, {
        proposals: [{ kind: "fact", content: "Retain me" }],
        discardedCount: 0,
      }),
    );
    await runDb(
      finalizeAiRun({
        runId: fixture.runId,
        expectedSmithersRunId: `ai-chat:${fixture.runId}`,
        coordinates: finalizeCoordinates,
        answer: { status: "ok", mode: "clarification", content: "First", sourceMap: [] },
        memory: retainedMemory,
        authorize,
      }),
    );
    const memory = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const [row] = yield* sql<{ readonly id: string; readonly revisionId: string }>`
          select id::text, head_revision_id::text as "revisionId"
          from user_memories where user_id = ${fixture.userId}
        `;
        return row!;
      }),
    );
    const citeRun = await runDb(createNextRun(fixture, "Cite memory"));
    await runDb(seedSingleObservability(citeRun));
    const citeMemory = await runDb(
      persistMemoryArtifact(citeRun, { proposals: [], discardedCount: 0 }),
    );
    const memorySource: FinalSourceRecord = {
      sourceKey: "k_AAAAAAAAAAAAAAAAAAAAAA_1",
      locator: {
        kind: "memory",
        memoryId: memory.id,
        memoryRevisionId: memory.revisionId,
      },
      label: "Memory",
      publicProvenance: {},
      uses: [
        {
          consumerTaskId: "single-answer",
          contextOrder: 0,
          renderedTokenCount: 2,
          ranges: [],
        },
      ],
    };
    await runDb(
      finalizeAiRun({
        runId: citeRun.runId,
        expectedSmithersRunId: `ai-chat:${citeRun.runId}`,
        coordinates: finalizeCoordinates,
        answer: {
          status: "ok",
          mode: "single",
          content: "Remember [[cite:k_AAAAAAAAAAAAAAAAAAAAAA_1]]",
          sourceMap: [memorySource],
        },
        memory: citeMemory,
        authorize,
      }),
    );
    await runDb(deleteUserMemory(fixture.userId, memory.id));

    const unreferenced = await runDb(createFixture("retention-unreferenced"));
    const unreferencedMemory = await runDb(
      persistMemoryArtifact(unreferenced, {
        proposals: [{ kind: "fact", content: "Delete me" }],
        discardedCount: 0,
      }),
    );
    await runDb(
      finalizeAiRun({
        runId: unreferenced.runId,
        expectedSmithersRunId: `ai-chat:${unreferenced.runId}`,
        coordinates: finalizeCoordinates,
        answer: { status: "ok", mode: "clarification", content: "First", sourceMap: [] },
        memory: unreferencedMemory,
        authorize,
      }),
    );
    const [unreferencedId] = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql<{ readonly id: string }>`
          select id::text from user_memories where user_id = ${unreferenced.userId}
        `;
      }),
    );
    await runDb(deleteUserMemory(unreferenced.userId, unreferencedId!.id));
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update user_memories
          set deleted_at = now() - interval '31 days'
          where id in (${memory.id}, ${unreferencedId!.id})
        `;
      }),
    );

    const purge = await runDb(purgeUserMemoryTombstones());
    expect(purge).toMatchObject({ processed: 2, hardDeleted: 1, madeProvenanceOnly: 1 });
    const state = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const [retained] = yield* sql<{
          readonly kind: string | null;
          readonly content: string | null;
          readonly head: string | null;
          readonly provenanceOnlyAt: Date | null;
          readonly revisionCount: number;
          readonly stateBefore: unknown;
          readonly runId: string | null;
        }>`
          select
            memories.kind,
            memories.content,
            memories.head_revision_id::text as head,
            memories.provenance_only_at as "provenanceOnlyAt",
            count(revisions.id)::int as "revisionCount",
            min(revisions.state_before::text) as "stateBefore",
            min(revisions.run_id::text) as "runId"
          from user_memories memories
          join user_memory_revisions revisions on revisions.memory_id = memories.id
          where memories.id = ${memory.id}
          group by memories.id
        `;
        const [gone] = yield* sql<{ readonly count: number }>`
          select count(*)::int as count from user_memories where id = ${unreferencedId!.id}
        `;
        return { retained, gone };
      }),
    );
    expect(state.retained).toMatchObject({
      kind: null,
      content: null,
      head: null,
      revisionCount: 1,
      stateBefore: null,
      runId: null,
    });
    expect(state.retained?.provenanceOnlyAt).toBeInstanceOf(Date);
    expect(state.gone?.count).toBe(0);
    const expiredRevert = await runDb(
      Effect.flip(revertUserMemory(fixture.userId, memory.id, memory.revisionId)),
    );
    expect(expiredRevert).toBeInstanceOf(MemoryRevertWindowExpiredError);
  });

  it("does not let a large provenance-only prefix starve newer expired tombstones", async () => {
    const fixture = await runDb(createFixture("retention-fairness"));
    const expiredMemoryId = crypto.randomUUID();
    const expiredRevisionId = crypto.randomUUID();
    const assistantMessageId = crypto.randomUUID();
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
          insert into chat_messages (id, chat_id, author, content)
          values (${assistantMessageId}, ${fixture.chatId}, 'assistant', 'Retained memory evidence')
        `;
            yield* sql`
          insert into user_memories (
            id, user_id, kind, content, head_revision_id, deleted_at
          ) values (
            ${expiredMemoryId}, ${fixture.userId}, 'fact', 'Expired tombstone',
            ${expiredRevisionId}, now() - interval '31 days'
          )
        `;
            yield* sql`
          insert into user_memory_revisions (
            id, memory_id, action, state_before, state_after
          ) values (
            ${expiredRevisionId}, ${expiredMemoryId}, 'create', null,
            ${sql.json({ kind: "fact", content: "Expired tombstone", deleted: false })}
          )
        `;
            // These 501 rows are already provenance-only and each remains
            // referenced by an immutable answer source. Their older deletion
            // timestamp would consume the old single LIMIT 500 forever. The
            // 502nd row is unreferenced and must be reached despite that
            // referenced prefix.
            yield* sql`
          with ids as (
            select ordinal,
                   (
                     substr(md5('retention-fair-memory:' || ordinal::text), 1, 8) || '-' ||
                     substr(md5('retention-fair-memory:' || ordinal::text), 9, 4) || '-' ||
                     substr(md5('retention-fair-memory:' || ordinal::text), 13, 4) || '-' ||
                     substr(md5('retention-fair-memory:' || ordinal::text), 17, 4) || '-' ||
                     substr(md5('retention-fair-memory:' || ordinal::text), 21, 12)
                   )::uuid as memory_id,
                   (
                     substr(md5('retention-fair-revision:' || ordinal::text), 1, 8) || '-' ||
                     substr(md5('retention-fair-revision:' || ordinal::text), 9, 4) || '-' ||
                     substr(md5('retention-fair-revision:' || ordinal::text), 13, 4) || '-' ||
                     substr(md5('retention-fair-revision:' || ordinal::text), 17, 4) || '-' ||
                     substr(md5('retention-fair-revision:' || ordinal::text), 21, 12)
                   )::uuid as revision_id
            from generate_series(1, 502) ordinal
          )
          insert into user_memories (
            id, user_id, kind, content, head_revision_id, deleted_at
          )
          select memory_id, ${fixture.userId}, 'fact', 'Provenance-only', revision_id,
                 now() - interval '32 days'
          from ids
        `;
            yield* sql`
          with ids as (
            select ordinal,
                   (
                     substr(md5('retention-fair-memory:' || ordinal::text), 1, 8) || '-' ||
                     substr(md5('retention-fair-memory:' || ordinal::text), 9, 4) || '-' ||
                     substr(md5('retention-fair-memory:' || ordinal::text), 13, 4) || '-' ||
                     substr(md5('retention-fair-memory:' || ordinal::text), 17, 4) || '-' ||
                     substr(md5('retention-fair-memory:' || ordinal::text), 21, 12)
                   )::uuid as memory_id,
                   (
                     substr(md5('retention-fair-revision:' || ordinal::text), 1, 8) || '-' ||
                     substr(md5('retention-fair-revision:' || ordinal::text), 9, 4) || '-' ||
                     substr(md5('retention-fair-revision:' || ordinal::text), 13, 4) || '-' ||
                     substr(md5('retention-fair-revision:' || ordinal::text), 17, 4) || '-' ||
                     substr(md5('retention-fair-revision:' || ordinal::text), 21, 12)
                   )::uuid as revision_id
            from generate_series(1, 502) ordinal
          )
          insert into user_memory_revisions (
            id, memory_id, action, state_before, state_after
          )
          select revision_id, memory_id, 'create', null,
                 ${sql.json({ kind: "fact", content: "Provenance-only", deleted: false })}
          from ids
        `;
            yield* sql`
          with ids as (
            select ordinal,
                   (
                     substr(md5('retention-fair-memory:' || ordinal::text), 1, 8) || '-' ||
                     substr(md5('retention-fair-memory:' || ordinal::text), 9, 4) || '-' ||
                     substr(md5('retention-fair-memory:' || ordinal::text), 13, 4) || '-' ||
                     substr(md5('retention-fair-memory:' || ordinal::text), 17, 4) || '-' ||
                     substr(md5('retention-fair-memory:' || ordinal::text), 21, 12)
                   )::uuid as memory_id,
                   (
                     substr(md5('retention-fair-revision:' || ordinal::text), 1, 8) || '-' ||
                     substr(md5('retention-fair-revision:' || ordinal::text), 9, 4) || '-' ||
                     substr(md5('retention-fair-revision:' || ordinal::text), 13, 4) || '-' ||
                     substr(md5('retention-fair-revision:' || ordinal::text), 17, 4) || '-' ||
                     substr(md5('retention-fair-revision:' || ordinal::text), 21, 12)
                   )::uuid as revision_id
            from generate_series(1, 502) ordinal
          )
          update user_memories memories
          set kind = null,
              content = null,
              head_revision_id = null,
              provenance_only_at = now() - interval '1 day'
          from ids
          where memories.id = ids.memory_id
        `;
            yield* sql`
          with ids as (
            select ordinal,
                   (
                     substr(md5('retention-fair-memory:' || ordinal::text), 1, 8) || '-' ||
                     substr(md5('retention-fair-memory:' || ordinal::text), 9, 4) || '-' ||
                     substr(md5('retention-fair-memory:' || ordinal::text), 13, 4) || '-' ||
                     substr(md5('retention-fair-memory:' || ordinal::text), 17, 4) || '-' ||
                     substr(md5('retention-fair-memory:' || ordinal::text), 21, 12)
                   )::uuid as memory_id,
                   (
                     substr(md5('retention-fair-revision:' || ordinal::text), 1, 8) || '-' ||
                     substr(md5('retention-fair-revision:' || ordinal::text), 9, 4) || '-' ||
                     substr(md5('retention-fair-revision:' || ordinal::text), 13, 4) || '-' ||
                     substr(md5('retention-fair-revision:' || ordinal::text), 17, 4) || '-' ||
                     substr(md5('retention-fair-revision:' || ordinal::text), 21, 12)
                   )::uuid as revision_id
            from generate_series(1, 501) ordinal
          )
          insert into assistant_message_sources (
            assistant_message_id, source_key, kind, locator, memory_revision_id
          )
          select ${assistantMessageId},
                 'k_AAAAAAAAAAAAAAAAAAAAAA_' || ordinal::text,
                 'memory',
                 jsonb_build_object(
                   'kind', 'memory', 'memoryId', memory_id::text,
                   'memoryRevisionId', revision_id::text
                 ),
                 revision_id
          from ids
        `;
            yield* sql`
          insert into assistant_message_source_uses (
            assistant_message_id, source_key, consumer_task_id,
            rendered_token_count, context_order, ranges
          )
          select ${assistantMessageId},
                 'k_AAAAAAAAAAAAAAAAAAAAAA_' || ordinal::text,
                 'single-answer', 1, ordinal - 1, '[]'::jsonb
          from generate_series(1, 501) ordinal
        `;
          }),
        );
      }),
    );

    const purge = await runDb(purgeUserMemoryTombstones(10));
    expect(purge.processed).toBe(2);
    expect(purge.hardDeleted).toBe(2);
    const remainingExpired = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{ readonly count: number }>`
          select count(*)::int as count from user_memories where id = ${expiredMemoryId}
        `)[0]!.count;
      }),
    );
    expect(remainingExpired).toBe(0);
    const remainingUnreferencedProvenance = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{ readonly count: number }>`
          select count(*)::int as count
          from user_memories memories
          where memories.user_id = ${fixture.userId}
            and memories.provenance_only_at is not null
            and not exists (
              select 1
              from assistant_message_sources sources
              join user_memory_revisions revisions
                on revisions.id = sources.memory_revision_id
              where revisions.memory_id = memories.id
            )
        `)[0]!.count;
      }),
    );
    expect(remainingUnreferencedProvenance).toBe(0);
  });

  it("prunes stream events only beyond the code-owned 24-hour terminal boundary", async () => {
    const expired = await runDb(createFixture("events-expired"));
    const retained = await runDb(createFixture("events-retained"));
    await runDb(failAiRun(expired.runId, "answer_failed"));
    await runDb(failAiRun(retained.runId, "answer_failed"));
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update ai_run_events
          set created_at = now() - interval '24 hours 1 second'
          where run_id = ${expired.runId} and emission_key = 'terminal'
        `;
        yield* sql`
          update ai_run_events
          set created_at = now() - interval '23 hours 59 minutes 59 seconds'
          where run_id = ${retained.runId} and emission_key = 'terminal'
        `;
      }),
    );

    expect(await runDb(pruneFinishedAiRunEvents())).toEqual({
      deletedEvents: 2,
      selectedCandidates: 1,
    });
    const counts = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql<{ readonly runId: string; readonly count: number }>`
          select run_id::text as "runId", count(*)::int as count
          from ai_run_events
          where run_id in (${expired.runId}, ${retained.runId})
          group by run_id
        `;
      }),
    );
    expect(counts.find((row) => row.runId === expired.runId)).toBeUndefined();
    expect(counts.find((row) => row.runId === retained.runId)?.count).toBe(2);
  });

  it("retains expired event ledgers for awaiting-annotation and completed evaluations", async () => {
    const evaluations = [
      {
        fixture: await runDb(createFixture("events-evaluation-awaiting")),
        sessionId: crypto.randomUUID(),
        status: "awaiting_annotations" as const,
      },
      {
        fixture: await runDb(createFixture("events-evaluation-complete")),
        sessionId: crypto.randomUUID(),
        status: "complete" as const,
      },
    ];
    for (const evaluation of evaluations) {
      await runDb(failAiRun(evaluation.fixture.runId, "answer_failed"));
    }
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        for (const evaluation of evaluations) {
          yield* sql`
            update ai_run_events
            set created_at = now() - interval '24 hours 1 second'
            where run_id = ${evaluation.fixture.runId} and emission_key = 'terminal'
          `;
          yield* sql`
            insert into ai_evaluation_sessions (
              id, artifact_version, golden_set_version, fixture_sha256_hex,
              execution_config_sha256_hex, provider_endpoint_identity, status, completed_at
            ) values (
              ${evaluation.sessionId}, 2, 2, ${"a".repeat(64)}, ${"b".repeat(64)},
              ${TINYFISH_SEARCH_PROVIDER_ENDPOINT_IDENTITY},
              ${evaluation.status},
              ${evaluation.status === "complete" ? new Date() : null}
            )
          `;
          yield* sql`
            insert into ai_evaluation_case_runs (
              session_id, case_id, topology, ai_run_id, seed_manifest, status
            ) values (
              ${evaluation.sessionId}, 'retention-case', 'specialized',
              ${evaluation.fixture.runId}, '{}'::jsonb, 'seeded'
            )
          `;
        }
      }),
    );

    expect(await runDb(pruneFinishedAiRunEvents())).toEqual({
      deletedEvents: 0,
      selectedCandidates: 0,
    });
    const counts = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql<{ readonly runId: string; readonly count: number }>`
          select run_id::text as "runId", count(*)::int as count
          from ai_run_events
          where run_id in (${evaluations[0]!.fixture.runId}, ${evaluations[1]!.fixture.runId})
          group by run_id
        `;
      }),
    );
    expect(counts).toHaveLength(2);
    expect(counts.every((row) => row.count === 2)).toBe(true);
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          delete from ai_run_events
          where run_id in (${evaluations[0]!.fixture.runId}, ${evaluations[1]!.fixture.runId})
        `;
      }),
    );
  });

  it("sweeps terminal and absent Smithers state only after 24 hours", async () => {
    const terminal = await runDb(createFixture("smithers-terminal"));
    const active = await runDb(createFixture("smithers-active"));
    const fresh = await runDb(createFixture("smithers-fresh"));
    const terminalSmithersId = `ai-chat:${terminal.runId}`;
    const activeSmithersId = `ai-chat:${active.runId}`;
    const freshSmithersId = `ai-chat:${fresh.runId}`;
    const orphanSmithersId = `ai-chat:${crypto.randomUUID()}`;
    await runDb(failAiRun(terminal.runId, "answer_failed"));
    await runDb(failAiRun(active.runId, "answer_failed"));
    await runDb(failAiRun(fresh.runId, "answer_failed"));
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update ai_runs
          set smithers_run_id = ${terminalSmithersId},
              failed_at = now() - interval '24 hours 1 second'
          where id = ${terminal.runId}
        `;
        yield* sql`
          update ai_runs
          set smithers_run_id = ${activeSmithersId},
              failed_at = now() - interval '24 hours 1 second'
          where id = ${active.runId}
        `;
        yield* sql`
          update ai_runs
          set smithers_run_id = ${freshSmithersId},
              failed_at = now() - interval '23 hours 55 minutes'
          where id = ${fresh.runId}
        `;
        yield* sql`
          create table if not exists _smithers_runs (
            run_id text primary key,
            status text not null,
            heartbeat_at_ms bigint
          )
        `;
        yield* sql`alter table _smithers_runs add column if not exists status text`;
        yield* sql`alter table _smithers_runs add column if not exists heartbeat_at_ms bigint`;
        yield* sql`
          insert into _smithers_runs (run_id, status, heartbeat_at_ms)
          values (${activeSmithersId}, 'running', ${Date.now()})
          on conflict (run_id) do update
            set status = excluded.status, heartbeat_at_ms = excluded.heartbeat_at_ms
        `;
        yield* sql`create table _smithers_retention_test (run_id text primary key)`;
        yield* sql`create table ai_chat_answer (run_id text primary key)`;
        yield* sql`
          insert into _smithers_retention_test (run_id)
          values
            (${terminalSmithersId}), (${activeSmithersId}),
            (${freshSmithersId}), (${orphanSmithersId})
        `;
        yield* sql`
          insert into ai_chat_answer (run_id)
          values
            (${terminalSmithersId}), (${activeSmithersId}),
            (${freshSmithersId}), (${orphanSmithersId})
        `;
      }),
    );

    expect(await runDb(sweepAiChatSmithersRows())).toEqual({
      deletedRuns: 1,
      selectedCandidates: 3,
    });
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update ai_smithers_orphan_candidates
          set first_seen_at = now() - interval '24 hours 1 second'
          where smithers_run_id = ${orphanSmithersId}
        `;
      }),
    );
    expect(await runDb(sweepAiChatSmithersRows())).toEqual({
      deletedRuns: 1,
      selectedCandidates: 2,
    });
    const remaining = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const synthetic = yield* sql<{ readonly runId: string }>`
          select run_id as "runId" from _smithers_retention_test order by run_id
        `;
        const canonical = yield* sql<{ readonly runId: string }>`
          select run_id as "runId" from ai_chat_answer order by run_id
        `;
        return { canonical, synthetic };
      }),
    );
    expect(remaining.synthetic.map((row) => row.runId)).toEqual([
      activeSmithersId,
      freshSmithersId,
    ]);
    expect(remaining.canonical.map((row) => row.runId)).toEqual([
      activeSmithersId,
      freshSmithersId,
    ]);
  });

  it("holds the Smithers ownership fence from heartbeat check through deletion", async () => {
    const fixture = await runDb(createFixture("smithers-retention-fence"));
    const smithersRunId = `ai-chat:${fixture.runId}`;
    await runDb(failAiRun(fixture.runId, "answer_failed"));
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update ai_runs
          set smithers_run_id = ${smithersRunId},
              failed_at = now() - interval '24 hours 1 second'
          where id = ${fixture.runId}
        `;
        yield* sql`create table _smithers_retention_fence_test (run_id text primary key)`;
        yield* sql`
          insert into _smithers_retention_fence_test (run_id) values (${smithersRunId})
        `;
      }),
    );

    let releaseFence!: () => void;
    let signalReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      signalReady = resolve;
    });
    const producerFence = runDb(
      Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const connection = yield* sql.reserve;
          yield* connection.executeRaw(
            "select pg_advisory_lock_shared(hashtextextended($1::text, 0))",
            [AI_CHAT_SMITHERS_SCHEMA_FENCE],
          );
          const released = new Promise<void>((resolve) => {
            releaseFence = resolve;
          });
          signalReady();
          yield* Effect.tryPromise({
            try: () => released,
            catch: (error) => (error instanceof Error ? error : new Error(String(error))),
          });
          yield* connection.executeRaw(
            "select pg_advisory_unlock_shared(hashtextextended($1::text, 0))",
            [AI_CHAT_SMITHERS_SCHEMA_FENCE],
          );
        }),
      ),
    );
    await ready;

    const sweep = runDb(sweepAiChatSmithersRows());
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    const whileFenced = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql<{ readonly count: number }>`
          select count(*)::int as count
          from _smithers_retention_fence_test
          where run_id = ${smithersRunId}
        `;
      }),
    );
    expect(whileFenced[0]?.count).toBe(1);

    releaseFence();
    await producerFence;
    await expect(sweep).resolves.toMatchObject({ deletedRuns: 1 });
  });

  it("shares one exact 500-candidate budget across Smithers and stream-event retention", async () => {
    const smithers = await runDb(createFixture("retention-shared-budget"));
    const smithersRunId = `ai-chat:${smithers.runId}`;
    await runDb(failAiRun(smithers.runId, "answer_failed"));
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update ai_runs
          set smithers_run_id = ${smithersRunId},
              failed_at = now() - interval '24 hours 1 second'
          where id = ${smithers.runId}
        `;
        yield* sql`create table if not exists _smithers_retention_budget_test (run_id text primary key)`;
        yield* sql`
          insert into _smithers_retention_budget_test (run_id)
          values (${smithersRunId})
        `;

        const eventFixture = yield* createFixture("retention-event-budget");
        yield* sql`
          with messages as (
            insert into chat_messages (chat_id, author, content)
            select ${eventFixture.chatId}, 'user', 'retention event ' || candidate::text
            from generate_series(1, 500) candidate
            returning id
          ), runs as (
            insert into ai_runs (
              chat_id, initiating_user_id, user_message_id, locale, market,
              failed_at, error_code, retryable
            )
            select ${eventFixture.chatId}, ${eventFixture.userId}, messages.id,
                   'en-US', 'US', now() - interval '24 hours 1 second',
                   'answer_failed', false
            from messages
            returning id
          )
          insert into ai_run_events (
            run_id, seq, emission_key, emitted_by_task, event, created_at
          )
          select runs.id, 1, 'terminal', 'system',
                 '{"type":"failed","code":"answer_failed","retryable":false}'::jsonb,
                 now() - interval '24 hours 1 second'
          from runs
        `;
      }),
    );

    expect(await runDb(purgeAiRuntimeRetention())).toEqual({
      sweptRuns: 1,
      prunedEvents: 499,
      selectedCandidates: 500,
    });
    const afterFirstSweep = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{ readonly count: number }>`
          select count(*)::int as count
          from ai_run_events
          where emission_key = 'terminal'
            and created_at < now() - interval '24 hours'
        `)[0]!.count;
      }),
    );
    expect(afterFirstSweep).toBe(1);

    expect(await runDb(purgeAiRuntimeRetention())).toEqual({
      sweptRuns: 0,
      prunedEvents: 1,
      selectedCandidates: 1,
    });
  });
});
