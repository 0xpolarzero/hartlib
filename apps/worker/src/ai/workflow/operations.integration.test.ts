import { PgClient } from "@effect/sql-pg";
import { Effect, Redacted } from "effect";
import { createHash } from "node:crypto";
import * as SmithersTaskRuntimeModule from "@smithers-orchestrator/driver/task-runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeRunAcceptanceScope } from "@hartlib/shared";

import { runMigrations } from "@hartlib/database/migrations";
import { CanonicalAgentClient } from "../runtime/agent-client";
import type { PiRuntimeBoundary } from "../e2e/deterministic-provider";
import type {
  PiBoundaryCoordinates,
  BeforeProviderRequest,
  PiCompletion,
} from "../runtime/pi-boundary";
import { measureProviderRequest, resolveRuntimeModel } from "../runtime/model-registry";
import { providerRequestSha256Hex, type LiveProviderRequest } from "../runtime/provider-request";
import { CanonicalWorkflowOperations, type CanonicalAiConfig } from "./operations";

const sourceDatabaseUrl = process.env.WORKER_POSTGRES_TEST_DATABASE_URL;
const databaseName = `hartlib_ai_operations_test_${process.pid}_${crypto
  .randomUUID()
  .replaceAll("-", "")
  .slice(0, 8)}`;

const databaseUrlFor = (name: string): string => {
  if (sourceDatabaseUrl === undefined) {
    throw new Error("WORKER_POSTGRES_TEST_DATABASE_URL is required");
  }
  const url = new URL(sourceDatabaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
};

const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;

const runDb = <A, E>(
  effect: Effect.Effect<A, E, PgClient.PgClient>,
  url = databaseUrlFor(databaseName),
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        PgClient.layer({
          url: Redacted.make(url),
          applicationName: "hartlib-ai-operations-test",
        }),
      ),
    ),
  );

const withTaskRuntime = (
  SmithersTaskRuntimeModule as unknown as {
    readonly withTaskRuntime: <A>(
      runtime: {
        readonly runId: string;
        readonly stepId: string;
        readonly attempt: number;
        readonly iteration: number;
        readonly signal: AbortSignal;
        readonly db: Readonly<Record<string, unknown>>;
        readonly heartbeat: (data?: unknown) => void;
        readonly lastHeartbeat: unknown | null;
      },
      execute: () => A,
    ) => A;
  }
).withTaskRuntime;

const config: CanonicalAiConfig = {
  aiMainModel: "glm-5-turbo",
  aiFastModel: "glm-5-turbo",
  aiMainInputMaxTokens: 100_000,
  aiMainOutputMaxTokens: 4096,
  aiFastInputMaxTokens: 100_000,
  aiFastOutputMaxTokens: 4096,
  aiConversationRecentTurns: 12,
  aiFanoutMaxTopics: 3,
  aiWebMaxSearches: 2,
  aiWebMaxFetches: 2,
  aiWebMaxDomainFilters: 8,
  aiMemoryToolResultMaxItems: 20,
  webResearchProvider: "",
  aiRetrievalMaxQueries: 24,
  aiRetrievalMaxBranchRows: 25,
  aiRetrievalMaxCandidates: 64,
  aiRetrievalMaxHydratedBytes: 2_000_000,
  aiRetrievalMaxConcurrency: 2,
  aiRetrievalQueryTimeoutMs: 10_000,
};

class RetrievalProviderBoundary implements PiRuntimeBoundary {
  bindAcceptedProviderProfile(): void {}

  async complete(
    request: LiveProviderRequest,
    coordinates: PiBoundaryCoordinates,
    beforeProviderRequest?: BeforeProviderRequest,
  ): Promise<PiCompletion> {
    const measurement = measureProviderRequest(request, resolveRuntimeModel(request.model), {
      inputTokens: 100_000,
      outputTokens: 16_384,
    });
    await beforeProviderRequest?.(
      request,
      { ...coordinates, providerRequestSha256Hex: providerRequestSha256Hex(request) },
      measurement,
    );
    const toolName = request.tools?.[0]?.name;
    const toolCalls =
      toolName === "emit_internal_query_plan"
        ? [
            {
              id: "test-plan",
              name: toolName,
              arguments: {
                action: "search",
                queries: [
                  {
                    purpose: "retrieve public liquidity evidence",
                    targets: [{ kind: "documents", filters: {} }],
                    all: [{ text: "liquidity", mode: "term" }],
                    anyOf: [],
                    not: [],
                    order: "relevance",
                  },
                ],
              },
            },
          ]
        : toolName === "emit_internal_query_review"
          ? [
              {
                id: "test-review",
                name: toolName,
                arguments: { action: "accept", reason: "sufficient_coverage" },
              },
            ]
          : [];
    return {
      text: "",
      toolCalls,
      usage: {
        inputTokens: measurement.inputTokens,
        outputTokens: 1,
        cachedTokens: 0,
        reasoningTokens: 0,
        totalTokens: measurement.inputTokens + 1,
        stopReason: "toolUse",
      },
      stopReason: "toolUse",
    };
  }

  async stream(): Promise<PiCompletion> {
    throw new Error("stream is not used by this integration fixture");
  }
}

const providerBoundary = (): PiRuntimeBoundary => new RetrievalProviderBoundary();

class PublicRetrievalAgent extends CanonicalAgentClient {
  constructor() {
    super(providerBoundary());
  }
}

interface Fixture {
  readonly userId: string;
  readonly companyId: string;
  readonly chatId: string;
  readonly runId: string;
  readonly userMessageId: string;
  readonly publicSourceId: string;
  readonly publicDocumentId: string;
  readonly contentHash: string;
}

const createFixture = (text: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const userId = `ai-operations-${crypto.randomUUID()}`;
    const companyId = crypto.randomUUID();
    const chatId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const publicSourceId = `ai-operations-source-${crypto.randomUUID()}`;
    const publicDocumentId = `ai-operations-document-${crypto.randomUUID()}`;
    const rawArtifactId = crypto.randomUUID();
    const contentHash = createHash("sha256").update(text, "utf8").digest("hex");
    const bodyHash = createHash("sha256").update(`${text}:raw`, "utf8").digest("hex");
    const citationNamespace = `cn_${crypto.randomUUID().replaceAll("-", "").slice(0, 22)}`;

    yield* sql`
      insert into platform_users (id, primary_email, display_name)
      values (${userId}, ${`${userId}@example.test`}, 'AI operations user')
    `;
    yield* sql`
      insert into client_companies (id, name)
      values (${companyId}, 'AI operations company')
    `;
    yield* sql`
      insert into client_company_memberships (company_id, user_id, role)
      values (${companyId}, ${userId}, 'admin')
    `;
    yield* sql`
      insert into client_company_ai_settings (company_id, web_search_enabled)
      values (${companyId}, false)
    `;
    yield* sql`
      insert into public_sources (
        source_id, display_name, publisher_name, description, ingestion_method,
        discovery_url, average_chars_per_item, country, language
      ) values (
        ${publicSourceId}, 'Operations Source', 'Operations Publisher',
        'A public source for operations tests', 'rss',
        ${`https://example.test/operations/${publicSourceId}`}, 100, 'US', 'en-US'
      )
    `;
    yield* sql`
      insert into client_company_public_source_settings (
        client_company_id, source_id, enabled, updated_by_user_id
      ) values (${companyId}, ${publicSourceId}, true, ${userId})
    `;
    yield* sql`
      insert into public_source_raw_artifacts (
        id, source_id, canonical_url, fetched_at, media_type, body, body_hash
      ) values (
        ${rawArtifactId}, ${publicSourceId},
        ${`https://example.test/operations/${publicDocumentId}`}, now(),
        'text/html', ${`${text}:raw`}, ${bodyHash}
      )
    `;
    yield* sql`
      insert into public_source_documents (
        document_id, source_id, canonical_url, title, published_at,
        discovered_at, fetched_at, language, document_type, text,
        text_char_count, content_hash, raw_artifact_id
      ) values (
        ${publicDocumentId}, ${publicSourceId},
        ${`https://example.test/operations/${publicDocumentId}`},
        'Operations document', now(), now(), now(), 'en-US', 'article',
        ${text}, ${text.length}, ${contentHash}, ${rawArtifactId}
      )
    `;
    yield* sql`
      insert into chats (id, company_id, user_id, memory_mode)
      values (${chatId}, ${companyId}, ${userId}, 'private_owner')
    `;
    const messages = yield* sql<{ readonly id: string }>`
      insert into chat_messages (chat_id, author, content)
      values (${chatId}, 'user', 'What changed in liquidity?')
      returning id::text
    `;
    const userMessageId = messages[0]?.id;
    if (userMessageId === undefined) throw new Error("operations fixture message missing");
    yield* sql`
      insert into ai_runs (
        id, chat_id, initiating_user_id, user_message_id, locale, market,
        acceptance_scope, citation_namespace
      ) values (
        ${runId}, ${chatId}, ${userId}, ${userMessageId}, 'en-US', 'US',
        ${sql.json(
          makeRunAcceptanceScope({
            userId,
            chatId,
            companyId,
            publicSourceIds: [publicSourceId],
            provider: "deterministic_test",
            webRequested: false,
            webEnabled: false,
          }),
        )}, ${citationNamespace}
      )
    `;
    yield* sql`
      update ai_runs set smithers_run_id = ${`ai-chat:${runId}`} where id = ${runId}
    `;
    return {
      userId,
      companyId,
      chatId,
      runId,
      userMessageId,
      publicSourceId,
      publicDocumentId,
      contentHash,
    } satisfies Fixture;
  });

describe.skipIf(sourceDatabaseUrl === undefined)("canonical AI operations", () => {
  beforeAll(async () => {
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql.unsafe(`create database ${quoteIdentifier(databaseName)}`).raw;
      }),
      databaseUrlFor("postgres"),
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
          where datname = ${databaseName}
            and pid <> pg_backend_pid()
            and usename = current_user
        `;
        yield* sql.unsafe(`drop database if exists ${quoteIdentifier(databaseName)}`).raw;
      }),
      databaseUrlFor("postgres"),
    );
  }, 60_000);

  it("loads one singular run and fences named public sources to its accepted snapshot", async () => {
    const fixture = await runDb(
      createFixture(
        "Liquidity conditions improved while inflation expectations remained anchored, with longer-term funding costs easing across the market during the latest reporting period.",
      ),
    );
    const operations = new CanonicalWorkflowOperations(
      databaseUrlFor(databaseName),
      config,
      new PublicRetrievalAgent(),
    );
    const load = await operations.loadTurn(fixture.runId);
    expect(load).toMatchObject({
      aiRunId: fixture.runId,
      chatId: fixture.chatId,
      initiatingUserId: fixture.userId,
    });
    expect(load.acceptanceScope.publicSourceIds).toEqual([fixture.publicSourceId]);
    await expect(
      operations.resolveAcceptedRetrievalScope(load, ["Operations Source"]),
    ).resolves.toMatchObject({
      acceptedSourceIds: [`public:${fixture.publicSourceId}`],
    });
    await expect(
      operations.resolveAcceptedRetrievalScope(load, ["Unknown Source"]),
    ).resolves.toMatchObject({ acceptedSourceIds: [] });
  }, 120_000);

  it("persists one public structured retrieval trace and run-owned exposure", async () => {
    const fixture = await runDb(
      createFixture(
        "Liquidity conditions improved while inflation expectations remained anchored, with longer-term funding costs easing across the market during the latest reporting period.",
      ),
    );
    const operations = new CanonicalWorkflowOperations(
      databaseUrlFor(databaseName),
      config,
      new PublicRetrievalAgent(),
    );
    const load = await operations.loadTurn(fixture.runId);
    const result = await withTaskRuntime(
      {
        runId: `ai-chat:${fixture.runId}`,
        stepId: "single-retrieve-internal",
        attempt: 1,
        iteration: 0,
        signal: new AbortController().signal,
        db: {},
        heartbeat: () => undefined,
        lastHeartbeat: null,
      },
      () =>
        operations.retrieveStructuredInternal(
          load,
          "What changed in liquidity?",
          "single-retrieve-internal",
          [],
        ),
    );
    expect(result?.previewExposures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          identity: {
            kind: "public_document",
            sourceId: fixture.publicSourceId,
            documentId: fixture.publicDocumentId,
            snapshotId: fixture.publicDocumentId,
            contentHash: fixture.contentHash,
          },
        }),
      ]),
    );
    const traces = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql<{ readonly payload: Record<string, unknown> }>`
          select payload
          from ai_observations
          where run_id = ${fixture.runId}
            and kind = 'structured_retrieval_trace'
        `;
      }),
    );
    expect(traces).toHaveLength(1);
    expect(traces[0]?.payload).toMatchObject({
      outcome: "accepted",
      review: { action: "accept", reason: "sufficient_coverage" },
    });
    const exposures = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql<{ readonly runId: string; readonly sourceId: string }>`
          select run_id::text as "runId", document_source_id as "sourceId"
          from ai_source_exposures
          where run_id = ${fixture.runId}
            and task_id = 'single-retrieve-internal'
        `;
      }),
    );
    expect(exposures).toEqual([
      { runId: fixture.runId, sourceId: `public:${fixture.publicSourceId}` },
    ]);
  }, 120_000);
});
