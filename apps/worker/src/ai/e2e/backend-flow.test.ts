import { PgClient } from "@effect/sql-pg";
import { ConfigProvider, Effect, Redacted } from "effect";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { runMigrations } from "../../db/migrate";
import {
  clearFakeAiClientScenario,
  setFakeAiClientScenario,
  type AiCallResult,
  type AnswerStreamEvent,
  type FakeAiClientScenario,
  type MemoryExtractionOutput,
  type PreflightOutput,
} from "../llm";
import { zeroUsage } from "../llm";
import type { QuerySpec } from "../retrieval/query-spec";
import { makeWorkerTick } from "../../jobs/runner";
import { JobRepositoryPgLayer } from "../../jobs/repository";
import { InMemoryPublicSourceIngestionRepositoryLayer } from "../../source-ingestion/repository";
import { AI_CHAT_OUTPUT_TABLES } from "../workflow/smithers-cleanup";

const isBun = typeof process.versions.bun === "string";
const databaseUrl = process.env.WORKER_POSTGRES_TEST_DATABASE_URL;
const isolatedDatabaseName = `brief_backend_e2e_${process.pid}_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
const testTimeoutMs = 60_000;
const sseStallTimeoutMs = 30_000;

const usage = zeroUsage();

vi.setConfig({ testTimeout: testTimeoutMs, hookTimeout: testTimeoutMs });

const sourceDatabaseUrl = () => {
  if (databaseUrl === undefined) {
    throw new Error("WORKER_POSTGRES_TEST_DATABASE_URL is required");
  }

  return databaseUrl;
};

const adminDatabaseUrl = () => {
  const url = new URL(sourceDatabaseUrl());
  url.pathname = "/postgres";
  return url.toString();
};

const isolatedDatabaseUrl = () => {
  const url = new URL(sourceDatabaseUrl());
  url.pathname = `/${isolatedDatabaseName}`;
  return url.toString();
};

const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;

const assistantMessage = (text: string) => ({
  role: "assistant" as const,
  content: [{ type: "text" as const, text }],
  api: "openai-completions" as const,
  provider: "zai",
  model: "fake",
  usage,
  stopReason: "stop" as const,
  timestamp: Date.now(),
});

const answerOk = (text: string): readonly AnswerStreamEvent[] => [
  { type: "text_delta", delta: text },
  {
    type: "result",
    result: {
      kind: "ok",
      value: {
        message: assistantMessage(text),
        text,
        usage,
        insufficiencyGap: null,
      },
    },
  },
];

const answerInsufficient = (gap: string): readonly AnswerStreamEvent[] => {
  const text = `[[insufficient: ${gap}]]`;

  return [
    {
      type: "result",
      result: {
        kind: "ok",
        value: {
          message: assistantMessage(text),
          text,
          usage,
          insufficiencyGap: gap,
        },
      },
    },
  ];
};

function runDb<A, E>(url: string, effect: Effect.Effect<A, E, PgClient.PgClient>): Promise<A> {
  return Effect.runPromise(
    effect.pipe(
      Effect.provide(
        PgClient.layer({
          url: Redacted.make(url),
          applicationName: "brief-backend-e2e",
        }),
      ),
    ),
  );
}

const envFor = (overrides: Record<string, string> = {}) =>
  ConfigProvider.layer(
    ConfigProvider.fromEnv({
      env: {
        DATABASE_URL: isolatedDatabaseUrl(),
        AI_FAKE: "true",
        ZAI_API_KEY: "fake",
        AI_STREAM_POLL_MS: "5",
        AI_STREAM_KEEPALIVE_MS: "1000",
        WORKER_JOB_LOCK_TIMEOUT_MS: "80",
        PUBLIC_SOURCE_INGESTION_ENABLED: "false",
        ...overrides,
      },
    }),
  );

let apiProcess: Bun.ReadableSubprocess | undefined;
let apiBaseUrl: string | undefined;
let apiOutput = "";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const appendApiOutput = (label: string, text: string): void => {
  apiOutput += `[${label}] ${text}`;
  if (apiOutput.length > 20_000) {
    apiOutput = apiOutput.slice(-20_000);
  }
};

const drainApiOutput = async (
  stream: ReadableStream<Uint8Array> | null,
  label: string,
): Promise<void> => {
  if (stream === null) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      appendApiOutput(label, decoder.decode(value, { stream: true }));
    }
    appendApiOutput(label, decoder.decode());
  } catch (error) {
    appendApiOutput(label, `failed to read api ${label}: ${String(error)}\n`);
  }
};

const getFreePort = async (): Promise<number> => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("reserved"),
  });
  const { port } = server;
  await server.stop(true);
  if (port === undefined) {
    throw new Error("Bun did not allocate a port for the reserved API server socket");
  }
  return port;
};

const apiEnv = (port: number): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }

  return {
    ...env,
    DATABASE_URL: isolatedDatabaseUrl(),
    HOST: "127.0.0.1",
    PORT: String(port),
    AI_STREAM_POLL_MS: "50",
    AI_STREAM_KEEPALIVE_MS: "1000",
    NODE_ENV: "test",
    AI_FAKE: "true",
    ZAI_API_KEY: "fake",
    PUBLIC_SOURCE_INGESTION_ENABLED: "false",
  };
};

const waitForApiReady = async (baseUrl: string): Promise<void> => {
  const deadline = Date.now() + 15_000;
  let lastError: unknown;

  while (Date.now() < deadline) {
    if (apiProcess?.exitCode !== null && apiProcess?.exitCode !== undefined) {
      throw new Error(
        `api process exited before readiness with code ${apiProcess.exitCode}\n${apiOutput}`,
      );
    }

    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
      lastError = new Error(`health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    await sleep(100);
  }

  throw new Error(`api did not become ready: ${String(lastError)}\n${apiOutput}`);
};

const stopApiServer = async (): Promise<void> => {
  const processToStop = apiProcess;
  apiProcess = undefined;
  apiBaseUrl = undefined;
  if (processToStop === undefined) return;

  if (processToStop.exitCode === null) {
    processToStop.kill();
  }

  try {
    await withTimeout(processToStop.exited, 5_000, "api process exit");
  } catch {
    if (processToStop.exitCode === null) {
      processToStop.kill("SIGKILL");
      await processToStop.exited.catch(() => undefined);
    }
  }
};

const startApiServer = async (): Promise<void> => {
  const port = await getFreePort();
  apiBaseUrl = `http://127.0.0.1:${port}`;
  apiOutput = "";
  apiProcess = Bun.spawn(["bun", "apps/api/src/index.ts"], {
    cwd: repoRoot,
    env: apiEnv(port),
    stdout: "pipe",
    stderr: "pipe",
  });
  void drainApiOutput(apiProcess.stdout, "stdout");
  void drainApiOutput(apiProcess.stderr, "stderr");

  try {
    await waitForApiReady(apiBaseUrl);
  } catch (error) {
    await stopApiServer();
    throw error;
  }
};

const apiFetch = (method: string, path: string, init?: RequestInit): Promise<Response> => {
  if (apiBaseUrl === undefined) {
    throw new Error("api server has not started");
  }

  return fetch(`${apiBaseUrl}${path}`, { ...init, method });
};

const runWorkerOnce = (env: Record<string, string> = {}, signal?: AbortSignal) =>
  Effect.runPromise(
    makeWorkerTick(signal === undefined ? {} : { signal }).pipe(
      Effect.provide(JobRepositoryPgLayer),
      Effect.provide(InMemoryPublicSourceIngestionRepositoryLayer()),
      Effect.provide(envFor(env)),
    ),
  );

const jsonBody = async <A>(response: Response): Promise<A> => response.json() as Promise<A>;

const withTimeout = <A>(promise: Promise<A>, ms: number, label: string): Promise<A> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });

  return Promise.race([promise, timer]).finally(() => {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  });
};

const sseEvents = async (response: Response): Promise<readonly Record<string, unknown>[]> => {
  if (response.body === null) {
    throw new Error("SSE response has no body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events: Record<string, unknown>[] = [];
  let buffer = "";
  let lastEventAt = Date.now();

  const receivedEvents = () => JSON.stringify(events, null, 2);
  const readNext = async () => {
    const remainingMs = Math.max(0, sseStallTimeoutMs - (Date.now() - lastEventAt));
    if (remainingMs === 0) {
      throw new Error(
        `SSE stream stalled after ${sseStallTimeoutMs}ms; events received so far: ${receivedEvents()}`,
      );
    }

    return await Promise.race([
      reader.read(),
      sleep(remainingMs).then(() => {
        throw new Error(
          `SSE stream stalled after ${sseStallTimeoutMs}ms; events received so far: ${receivedEvents()}`,
        );
      }),
    ]);
  };
  const ingest = (text: string) => {
    buffer += text;
    for (;;) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary === -1) return;
      const chunk = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const dataLine = chunk.split("\n").find((line) => line.startsWith("data: "));
      if (dataLine === undefined) continue;
      events.push(JSON.parse(dataLine.slice("data: ".length)) as Record<string, unknown>);
      lastEventAt = Date.now();
    }
  };

  try {
    for (;;) {
      const { done, value } = await readNext();
      if (done) {
        ingest(decoder.decode());
        return events;
      }
      ingest(decoder.decode(value, { stream: true }));
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
};

const sendMessage = async (text: string) => {
  const response = await apiFetch("POST", "/v1/chat/messages", {
    body: JSON.stringify({ text, locale: "en-US", market: "US" }),
  });
  expect(response.status).toBe(200);
  return jsonBody<{ readonly messageId: string; readonly runId: string }>(response);
};

const sendMessageFr = async (text: string) => {
  const response = await apiFetch("POST", "/v1/chat/messages", {
    body: JSON.stringify({ text, locale: "fr-FR", market: "FR" }),
  });
  expect(response.status).toBe(200);
  return jsonBody<{ readonly messageId: string; readonly runId: string }>(response);
};

const streamRun = (runId: string) => apiFetch("GET", `/v1/ai-runs/${runId}/stream`);

const runTurn = async (
  text: string,
  scenario: FakeAiClientScenario,
  env: Record<string, string> = {},
) => {
  setFakeAiClientScenario(scenario);
  const posted = await sendMessage(text);
  const streamResponse = await streamRun(posted.runId);
  expect(streamResponse.status).toBe(200);
  const streamPromise = sseEvents(streamResponse);
  await runWorkerOnce(env);
  const events = await streamPromise;
  const chatResponse = await apiFetch("GET", "/v1/chat");
  expect(chatResponse.status).toBe(200);
  const chat = await jsonBody<ChatResponse>(chatResponse);

  return { ...posted, events, chat };
};

const runTurnFr = async (
  text: string,
  scenario: FakeAiClientScenario,
  env: Record<string, string> = {},
) => {
  setFakeAiClientScenario(scenario);
  const posted = await sendMessageFr(text);
  const streamResponse = await streamRun(posted.runId);
  expect(streamResponse.status).toBe(200);
  const streamPromise = sseEvents(streamResponse);
  await runWorkerOnce(env);
  const events = await streamPromise;
  const chatResponse = await apiFetch("GET", "/v1/chat");
  expect(chatResponse.status).toBe(200);
  const chat = await jsonBody<ChatResponse>(chatResponse);

  return { ...posted, events, chat };
};

interface ChatResponse {
  readonly activeRunId: string | null;
  readonly messages: readonly {
    readonly author: "user" | "assistant";
    readonly content: string;
    readonly citations?: readonly {
      readonly blockId: string;
      readonly kind: "document" | "memory";
      readonly label: string | null;
      readonly sourceDisplayName: string | null;
      readonly canonicalUrl: string | null;
      readonly publishedAt: string | null;
    }[];
    readonly contextBlocks?: readonly { readonly blockId: string; readonly kind: string }[];
  }[];
}

const latestAssistant = (chat: ChatResponse) =>
  [...chat.messages].reverse().find((message) => message.author === "assistant");

const preflightFromSearch =
  (
    spec: QuerySpec,
    manifest: readonly {
      readonly documentId: string;
      readonly charStart?: number;
      readonly charEnd?: number;
    }[],
    peeks: readonly string[] = [],
  ): NonNullable<FakeAiClientScenario["preflight"]> =>
  async (_inputs, toolContext, _callIndex, retrieval): Promise<AiCallResult<PreflightOutput>> => {
    const results =
      retrieval === undefined ? [] : await retrieval.searchDocuments(spec, toolContext);

    for (const documentId of peeks) {
      if (retrieval !== undefined) {
        await retrieval.peekDocument(documentId, undefined, undefined, toolContext);
      }
    }

    return {
      kind: "ok",
      value: {
        manifest,
        usage,
        toolEvents: [
          { type: "search", spec, resultCount: results.length },
          ...peeks.map((documentId) => ({
            type: "peek" as const,
            documentId,
            offsetChars: null,
            lengthChars: null,
            found: true,
          })),
        ],
      },
    };
  };

const memoryResult = (
  proposals: MemoryExtractionOutput["proposals"],
): AiCallResult<MemoryExtractionOutput> => ({
  kind: "ok",
  value: { proposals, discarded: [], usage },
});

const seedCorpus = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;

  const sources = [
    ["e2e-en", "E2E English Source", "US", "en-US"],
    ["e2e-fr", "E2E French Source", "FR", "fr-FR"],
  ] as const;

  for (const [sourceId, displayName, country, language] of sources) {
    yield* sql`
      insert into public_sources (
        source_id,
        display_name,
        publisher_name,
        description,
        ingestion_method,
        discovery_url,
        average_chars_per_item,
        country,
        language
      )
      values (
        ${sourceId},
        ${displayName},
        ${displayName},
        'backend e2e fixtures',
        'rss',
        ${`https://${sourceId}.example/feed`},
        1000,
        ${country},
        ${language}
      )
      on conflict (source_id) do nothing
    `;
  }

  const docs = [
    {
      documentId: "e2e-doc-en-a",
      sourceId: "e2e-en",
      title: "US clean power outlook",
      text: "Clean power investment in the US accelerated in 2026 with grid storage and solar interconnection gains. ".repeat(
        4,
      ),
      language: "en-US",
      publishedAt: "2026-07-01T10:00:00.000Z",
    },
    {
      documentId: "e2e-doc-en-b",
      sourceId: "e2e-en",
      title: "US grid storage update",
      text: "Grid storage additions helped balance evening demand and reduced curtailment in several US regions. ".repeat(
        4,
      ),
      language: "en-US",
      publishedAt: "2026-07-02T10:00:00.000Z",
    },
    {
      documentId: "e2e-doc-en-c",
      sourceId: "e2e-en",
      title: "Transmission queue reform",
      text: "Transmission queue reform shortened review timelines and prioritized projects with firm site control. ".repeat(
        4,
      ),
      language: "en-US",
      publishedAt: "2026-07-03T10:00:00.000Z",
    },
    {
      documentId: "e2e-doc-fr-a",
      sourceId: "e2e-fr",
      title: "Energie solaire en France",
      text: "La capacite solaire francaise progresse grace aux appels d'offres et aux raccordements regionaux. ".repeat(
        4,
      ),
      language: "fr-FR",
      publishedAt: "2026-07-04T10:00:00.000Z",
    },
  ] as const;

  for (const [index, doc] of docs.entries()) {
    const rawId = `aaaaaaaa-1111-1111-1111-${String(index + 1).padStart(12, "0")}`;
    yield* sql`
      insert into public_source_raw_artifacts (
        id,
        source_id,
        canonical_url,
        fetched_at,
        media_type,
        body,
        body_hash
      )
      values (
        ${rawId},
        ${doc.sourceId},
        ${`https://${doc.sourceId}.example/${doc.documentId}`},
        now(),
        'text/html',
        ${doc.text},
        ${`e2e-body-${doc.documentId}`}
      )
      on conflict (id) do nothing
    `;
    yield* sql`
      insert into public_source_documents (
        document_id,
        source_id,
        raw_artifact_id,
        canonical_url,
        title,
        text,
        language,
        published_at,
        discovered_at,
        fetched_at,
        document_type,
        content_hash,
        text_char_count
      )
      values (
        ${doc.documentId},
        ${doc.sourceId},
        ${rawId},
        ${`https://${doc.sourceId}.example/${doc.documentId}`},
        ${doc.title},
        ${doc.text},
        ${doc.language},
        ${doc.publishedAt},
        now(),
        now(),
        'article',
        ${`e2e-hash-${doc.documentId}`},
        ${doc.text.length}
      )
      on conflict (document_id) do update
      set text = excluded.text,
          title = excluded.title,
          text_char_count = excluded.text_char_count
    `;
  }
});

const clearDemoRuntime = () =>
  runDb(
    isolatedDatabaseUrl(),
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      yield* sql`delete from jobs`;
      yield* sql`delete from user_memory_revisions where memory_id in (select id from user_memories where user_id = 'demo-user')`;
      yield* sql`delete from user_memories where user_id = 'demo-user'`;
      yield* sql`delete from chats where user_id = 'demo-user'`;
    }),
  );

const runtimeCounts = () =>
  runDb(
    isolatedDatabaseUrl(),
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      const [messages] = yield* sql<{ readonly count: number }>`
        select count(*)::int as count from chat_messages where author = 'assistant'
      `;
      const [smithersTables] = yield* sql<{ readonly count: number }>`
        select count(*)::int as count
        from information_schema.columns
        where table_schema = 'public'
          and column_name = 'run_id'
          and (
            table_name like '_smithers_%'
            or table_name = 'input'
            or ${sql.in("table_name", [...AI_CHAT_OUTPUT_TABLES])}
          )
      `;

      return {
        assistantMessages: messages?.count ?? 0,
        smithersRunIdTables: smithersTables?.count ?? 0,
      };
    }),
  );

const smithersRowsForRun = (smithersRunId: string) =>
  runDb(
    isolatedDatabaseUrl(),
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      const tables = yield* sql<{ readonly tableName: string }>`
        select distinct table_name as "tableName"
        from information_schema.columns
        where table_schema = 'public'
          and column_name = 'run_id'
          and (
            table_name like '_smithers_%'
            or table_name = 'input'
            or ${sql.in("table_name", [...AI_CHAT_OUTPUT_TABLES])}
          )
      `;
      let total = 0;
      for (const table of tables) {
        const rows = yield* sql<{ readonly count: number }>`
          select count(*)::int as count
          from ${sql(table.tableName)}
          where run_id = ${smithersRunId}
        `;
        total += rows[0]?.count ?? 0;
      }
      return total;
    }),
  );

const observations = (runId: string, kind?: string) =>
  runDb(
    isolatedDatabaseUrl(),
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      return yield* sql<{ readonly kind: string; readonly payload: Record<string, unknown> }>`
        select kind, payload
        from ai_observations
        where run_id = ${runId}
          and (${kind ?? null}::text is null or kind = ${kind ?? null})
        order by id
      `;
    }),
  );

const dropIsolatedDatabase = () =>
  runDb(
    adminDatabaseUrl(),
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

describe.skipIf(!isBun || !databaseUrl)("backend AI chat flow E2E", () => {
  beforeAll(async () => {
    try {
      await runDb(
        adminDatabaseUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const rows = yield* sql<{ readonly exists: boolean }>`
            select exists(select 1 from pg_database where datname = ${isolatedDatabaseName}) as exists
          `;

          if (rows[0]?.exists !== true) {
            yield* sql.unsafe(`create database ${quoteIdentifier(isolatedDatabaseName)}`);
          }
        }),
      );

      await runDb(isolatedDatabaseUrl(), runMigrations);
      await runDb(isolatedDatabaseUrl(), seedCorpus);
      await startApiServer();
    } catch (error) {
      await stopApiServer();
      await dropIsolatedDatabase();
      throw error;
    }
  }, 120_000);

  afterAll(async () => {
    await stopApiServer();
    await dropIsolatedDatabase();
  }, 60_000);

  afterEach(async () => {
    clearFakeAiClientScenario();
    await clearDemoRuntime();
  }, 60_000);

  it("streams and persists a happy turn through the public API", async () => {
    const result = await runTurn("What changed in US clean power?", {
      preflight: preflightFromSearch(
        { terms: "clean power storage", languages: ["en-US"], limit: 5 },
        [{ documentId: "e2e-doc-en-a" }],
        ["e2e-doc-en-a"],
      ),
      answer: answerOk("US clean power investment accelerated in 2026. [[cite:b1]]"),
    });

    expect(result.events.map((event) => event.type)).toEqual([
      "run_started",
      "preflight_search",
      "preflight_peek",
      "usage",
      "context_window",
      "answer_started",
      "text_delta",
      "usage",
      "usage",
      "memory_updated",
      "done",
    ]);
    expect(result.events.find((event) => event.type === "answer_started")).toMatchObject({
      attempt: 1,
    });
    const assistant = latestAssistant(result.chat);
    expect(assistant?.content).toContain("[[cite:b1]]");
    expect(assistant?.citations).toEqual([
      expect.objectContaining({
        blockId: "b1",
        sourceDisplayName: "E2E English Source",
        canonicalUrl: "https://e2e-en.example/e2e-doc-en-a",
        publishedAt: "2026-07-01T10:00:00.000Z",
      }),
    ]);
    expect(assistant?.contextBlocks).toEqual([expect.objectContaining({ blockId: "b1" })]);
    const runRows = await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql<{
          readonly usage: Record<string, unknown>;
          readonly smithersRunId: string;
        }>`
          select usage, smithers_run_id as "smithersRunId" from ai_runs where id = ${result.runId}
        `;
      }),
    );
    expect(runRows[0]?.usage).toHaveProperty("answer");
    expect(await smithersRowsForRun(runRows[0]!.smithersRunId)).toBe(0);
  });

  it("reuses the standing window on a follow-up without duplicating document blocks", async () => {
    await runTurn("Summarize clean power.", {
      preflight: preflightFromSearch({ terms: "clean power", languages: ["en-US"], limit: 5 }, [
        { documentId: "e2e-doc-en-a" },
      ]),
      answer: answerOk("Clean power investment accelerated. [[cite:b1]]"),
    });
    const second = await runTurn("What about storage?", {
      preflight: preflightFromSearch({ terms: "grid storage", languages: ["en-US"], limit: 5 }, [
        { documentId: "e2e-doc-en-a" },
        { documentId: "e2e-doc-en-b" },
      ]),
      answer: answerOk("Storage additions balanced evening demand. [[cite:b2]]"),
    });

    const blocks = await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql<{ readonly blockId: string; readonly documentId: string | null }>`
          select block_id as "blockId", document_id as "documentId"
          from chat_context_blocks
          where kind = 'document'
          order by block_id
        `;
      }),
    );
    expect(blocks).toEqual([
      { blockId: "b1", documentId: "e2e-doc-en-a" },
      { blockId: "b2", documentId: "e2e-doc-en-b" },
    ]);
    const assistantCitations = second.chat.messages
      .filter((message) => message.author === "assistant")
      .flatMap((message) => message.citations ?? []);
    expect(assistantCitations.map((citation) => citation.blockId).sort()).toEqual(["b1", "b2"]);
  });

  it("shows an insufficiency retry and passes first-pass block ids into retry preflight", async () => {
    const captures: NonNullable<FakeAiClientScenario["captures"]> = { preflightInputs: [] };
    const result = await runTurn("Compare clean power and transmission.", {
      captures,
      preflight: [
        {
          kind: "ok",
          value: {
            manifest: [{ documentId: "e2e-doc-en-a" }],
            usage,
            toolEvents: [
              {
                type: "search",
                spec: { terms: "clean power", languages: ["en-US"], limit: 5 },
                resultCount: 1,
              },
            ],
          },
        },
        {
          kind: "ok",
          value: {
            manifest: [{ documentId: "e2e-doc-en-c" }],
            usage,
            toolEvents: [
              {
                type: "search",
                spec: { terms: "transmission reform", languages: ["en-US"], limit: 5 },
                resultCount: 1,
              },
            ],
          },
        },
      ],
      answer: [
        answerInsufficient("need transmission evidence"),
        answerOk("Transmission queue reform shortened review timelines. [[cite:b2]]"),
      ],
    });

    expect(result.events.map((event) => event.type)).toContain("answer_retry");
    expect(result.events.filter((event) => event.type === "answer_started")).toEqual([
      expect.objectContaining({ attempt: 1 }),
      expect.objectContaining({ attempt: 2 }),
    ]);
    expect(latestAssistant(result.chat)?.content).toBe(
      "Transmission queue reform shortened review timelines. [[cite:b2]]",
    );
    expect(captures.preflightInputs?.[1]?.standingWindow.map((block) => block.blockId)).toContain(
      "b1",
    );
  });

  it("writes, reverts, and reinjects user memory state", async () => {
    const first = await runTurn("Remember this exactly: I prefer concise energy briefings.", {
      preflight: preflightFromSearch({ terms: "clean power", limit: 5 }, []),
      answer: answerOk("Noted."),
      memories: memoryResult([
        {
          kind: "preference",
          content: "I prefer concise energy briefings.",
          evidenceQuote: "I prefer concise energy briefings.",
        },
      ]),
    });
    expect(first.events.find((event) => event.type === "memory_updated")).toMatchObject({
      created: 1,
      updated: 0,
    });
    const memoriesResponse = await apiFetch("GET", "/v1/memories");
    const memories = await jsonBody<{
      readonly memories: readonly {
        readonly id: string;
        readonly content: string;
        readonly revisions: readonly { readonly action: string }[];
      }[];
    }>(memoriesResponse);
    const memory = memories.memories[0]!;
    expect(memory.content).toBe("I prefer concise energy briefings.");
    expect(memory.revisions.at(-1)?.action).toBe("created");

    const updated = await runTurn("Actually make it more detailed.", {
      preflight: preflightFromSearch({ terms: "grid storage", limit: 5 }, []),
      answer: answerOk("Updated."),
      memories: memoryResult([
        {
          kind: "preference",
          content: "I prefer detailed energy briefings.",
          evidenceQuote: "Actually make it more detailed.",
          targetMemoryId: memory.id,
        },
      ]),
    });
    expect(updated.events.find((event) => event.type === "memory_updated")).toMatchObject({
      created: 0,
      updated: 1,
    });
    const revertResponse = await apiFetch("POST", `/v1/memories/${memory.id}/revert`);
    expect(revertResponse.status).toBe(200);
    const reverted = await jsonBody<{ readonly memory: { readonly content: string } }>(
      revertResponse,
    );
    expect(reverted.memory.content).toBe("I prefer concise energy briefings.");

    const captures: NonNullable<FakeAiClientScenario["captures"]> = { preflightInputs: [] };
    const next = await runTurn("Use my saved preference.", {
      captures,
      preflight: preflightFromSearch({ terms: "transmission", limit: 5 }, []),
      answer: answerOk("Concise answer."),
    });
    expect(captures.preflightInputs?.[0]?.memories.map((item) => item.content)).toContain(
      "I prefer concise energy briefings.",
    );
    expect(next.events.find((event) => event.type === "memory_updated")).toMatchObject({
      created: 0,
      updated: 0,
    });
  });

  it("evicts the oldest uncited block under a tiny context budget without breaking old citations", async () => {
    await runTurn(
      "Read two sources.",
      {
        preflight: preflightFromSearch({ terms: "power storage", limit: 5 }, [
          { documentId: "e2e-doc-en-a" },
          { documentId: "e2e-doc-en-b" },
        ]),
        answer: answerOk("Storage helped balance demand. [[cite:b2]]"),
      },
      { AI_CONTEXT_BLOCK_BUDGET: "90", AI_CONTEXT_BLOCK_HARD_CAP: "1000" },
    );
    const second = await runTurn(
      "Add transmission.",
      {
        preflight: preflightFromSearch({ terms: "transmission reform", limit: 5 }, [
          { documentId: "e2e-doc-en-b" },
          { documentId: "e2e-doc-en-c" },
        ]),
        answer: answerOk("Transmission reviews got shorter. [[cite:b3]]"),
      },
      { AI_CONTEXT_BLOCK_BUDGET: "90", AI_CONTEXT_BLOCK_HARD_CAP: "1000" },
    );

    const evictions = await observations(second.runId, "context_block_evicted");
    expect(evictions).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ blockId: "b1" }) }),
    ]);
    const firstAssistant = second.chat.messages.find((message) => message.author === "assistant");
    expect(firstAssistant?.citations?.[0]?.blockId).toBe("b2");
    expect(firstAssistant?.citations?.[0]?.canonicalUrl).toBe(
      "https://e2e-en.example/e2e-doc-en-b",
    );
  });

  it("completes with an empty window", async () => {
    const result = await runTurn("What is outside the corpus?", {
      preflight: {
        kind: "ok",
        value: { manifest: [], usage, toolEvents: [] },
      },
      answer: answerOk("The available sources do not cover that question."),
    });

    expect(latestAssistant(result.chat)?.contextBlocks).toEqual([]);
    expect(latestAssistant(result.chat)?.content).toBe(
      "The available sources do not cover that question.",
    );
  });

  it("keeps the planner-baseline path to one search observation", async () => {
    const result = await runTurn(
      "Baseline clean power.",
      {
        preflight: preflightFromSearch({ terms: "clean power", languages: ["en-US"], limit: 5 }, [
          { documentId: "e2e-doc-en-a" },
        ]),
        answer: answerOk("Clean power investment accelerated. [[cite:b1]]"),
      },
      { AI_PLANNER_BASELINE: "true" },
    );

    const searchEvents = result.events.filter((event) => event.type === "preflight_search");
    expect(searchEvents).toHaveLength(1);
    expect(result.events).not.toContainEqual(expect.objectContaining({ type: "preflight_peek" }));
    expect(await observations(result.runId, "search")).toHaveLength(1);
  });

  it("resumes a run after an aborted worker tick without duplicate assistant messages", async () => {
    let releaseAnswer!: () => void;
    let answerStarted!: () => void;
    const answerStartedPromise = new Promise<void>((resolve) => {
      answerStarted = resolve;
    });
    const releaseAnswerPromise = new Promise<void>((resolve) => {
      releaseAnswer = resolve;
    });
    const controller = new AbortController();

    setFakeAiClientScenario({
      preflight: preflightFromSearch({ terms: "clean power", limit: 5 }, [
        { documentId: "e2e-doc-en-a" },
      ]),
      answer: async function* () {
        answerStarted();
        await releaseAnswerPromise;
        yield* answerOk("Resumed clean power answer. [[cite:b1]]");
      },
    });
    const posted = await sendMessage("Crash and resume this.");
    const firstTick = runWorkerOnce({}, controller.signal).catch(() => undefined);
    await answerStartedPromise;
    controller.abort();
    releaseAnswer();
    await firstTick;
    await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update jobs
          set available_at = now()
          where kind = 'ai_chat_run'
            and payload->>'aiRunId' = ${posted.runId}
            and status in ('queued', 'retrying')
        `;
      }),
    );

    const streamResponse = await streamRun(posted.runId);
    const streamPromise = sseEvents(streamResponse);
    setFakeAiClientScenario({
      preflight: preflightFromSearch({ terms: "clean power", limit: 5 }, [
        { documentId: "e2e-doc-en-a" },
      ]),
      answer: answerOk("Resumed clean power answer. [[cite:b1]]"),
    });
    await runWorkerOnce();
    const events = await streamPromise;

    const counts = await runtimeCounts();
    expect(counts.assistantMessages).toBe(1);
    expect(events.filter((event) => event.type === "answer_started").length).toBeGreaterThanOrEqual(
      1,
    );
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  it("returns 409 for a concurrent send while the real worker has the run in flight", async () => {
    let releaseAnswer!: () => void;
    let answerStarted!: () => void;
    const answerStartedPromise = new Promise<void>((resolve) => {
      answerStarted = resolve;
    });
    const releaseAnswerPromise = new Promise<void>((resolve) => {
      releaseAnswer = resolve;
    });
    setFakeAiClientScenario({
      preflight: preflightFromSearch({ terms: "clean power", limit: 5 }, [
        { documentId: "e2e-doc-en-a" },
      ]),
      answer: async function* () {
        answerStarted();
        await releaseAnswerPromise;
        yield* answerOk("Slow answer. [[cite:b1]]");
      },
    });
    const posted = await sendMessage("Start a slow run.");
    const streamResponse = await streamRun(posted.runId);
    const streamPromise = sseEvents(streamResponse);
    const workerPromise = runWorkerOnce();
    await answerStartedPromise;

    const conflict = await apiFetch("POST", "/v1/chat/messages", {
      body: JSON.stringify({ text: "Second", locale: "en-US", market: "US" }),
    });
    expect(conflict.status).toBe(409);
    expect(await jsonBody(conflict)).toEqual({ error: "run_active" });

    releaseAnswer();
    await workerPromise;
    await streamPromise;
  });

  it("runs a French public-source turn and sweeps runtime hygiene", async () => {
    const result = await runTurnFr("Que dit la source solaire?", {
      preflight: preflightFromSearch(
        { terms: "energie solaire France", languages: ["fr-FR"], limit: 5 },
        [{ documentId: "e2e-doc-fr-a" }],
      ),
      answer: answerOk("La capacite solaire progresse. [[cite:b1]]"),
    });
    expect(latestAssistant(result.chat)?.citations?.[0]?.sourceDisplayName).toBe(
      "E2E French Source",
    );

    await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update ai_run_events
          set created_at = now() - interval '1 hour'
          where run_id = ${result.runId}
        `;
        yield* sql`
          insert into jobs (kind, payload, unique_key)
          values ('purge_ai_runtime', ${sql.json({ gracePeriodMs: 0 })}, 'purge-ai-runtime-e2e')
        `;
      }),
    );
    await runWorkerOnce();

    const remaining = await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const [events] = yield* sql<{ readonly count: number }>`
          select count(*)::int as count from ai_run_events where run_id = ${result.runId}
        `;
        return events?.count ?? 0;
      }),
    );
    expect(remaining).toBe(0);
    expect(await smithersRowsForRun(`ai-chat:${result.runId}`)).toBe(0);
  });
});
