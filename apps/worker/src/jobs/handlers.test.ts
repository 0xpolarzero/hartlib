import { PgClient } from "@effect/sql-pg";
import { Effect, Fiber, Redacted } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PUBLIC_SOURCE_IDS,
  publicSourceDefinitions,
  type PublicSourceId,
} from "@brief/source-ingestion";

import { runMigrations } from "../db/migrate";
import type { WorkerConfig } from "../config";
import { WebBoundaryError, type WebOperationAccounting } from "../ai/web";
import type { JobRecord, JobResult } from "./types";

const runSmithersWorkflowMock = vi.hoisted(() => vi.fn());
const closeSmithersStorageMock = vi.hoisted(() => vi.fn());
const runWithAiChatSmithersProducerFenceMock = vi.hoisted(() =>
  vi.fn(async (_connectionString: string, operation: () => Promise<unknown>) => operation()),
);

vi.mock("../ai/smithers-interop", () => ({
  createSmithersStorage: vi.fn(async () => ({ close: closeSmithersStorageMock })),
  runSmithersWorkflow: runSmithersWorkflowMock,
  smithersRunExists: vi.fn(async () => false),
  runWithAiChatSmithersProducerFence: runWithAiChatSmithersProducerFenceMock,
}));

vi.mock("../ai/workflow/ai-chat", () => ({
  aiChatSchemas: {},
  aiChatSmithersMaxConcurrency: vi.fn(() => 7),
  buildAiChatWorkflow: vi.fn(() => ({})),
}));

const isBun = typeof process.versions.bun === "string";
const databaseUrl = process.env.WORKER_POSTGRES_TEST_DATABASE_URL;
const isolatedDatabaseName = `brief_handlers_test_${process.pid}_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
const previousDatabaseUrl = process.env.DATABASE_URL;

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

describe("AI provider service identity", () => {
  it("distinguishes the exact official endpoint, custom OpenAI-compatible endpoints, and tests", async () => {
    const { providerServiceIdForConfig } = await import("./handlers");
    expect(
      providerServiceIdForConfig({
        aiE2eFakeProvider: false,
        aiBaseUrl: "https://api.z.ai/api/coding/paas/v4",
      } as WorkerConfig),
    ).toBe("zai_coding_plan_official");
    expect(
      providerServiceIdForConfig({
        aiE2eFakeProvider: false,
        aiBaseUrl: "https://compatible.example/v1",
      } as WorkerConfig),
    ).toBe("openai_compatible_custom");
    expect(
      providerServiceIdForConfig({
        nodeEnv: "test",
        aiE2eFakeProvider: true,
        aiBaseUrl: "https://api.z.ai/api/coding/paas/v4",
      } as WorkerConfig),
    ).toBe("deterministic_test");
  });
});

describe("AI chat Smithers identity", () => {
  it("accepts only the run-derived durable identity", async () => {
    const { assertCanonicalAiChatSmithersRunId, deriveAiChatSmithersRunId } =
      await import("./handlers");
    const aiRunId = "00000000-0000-4000-8000-000000000001";
    const expected = deriveAiChatSmithersRunId(aiRunId);
    expect(() => assertCanonicalAiChatSmithersRunId(aiRunId, null)).not.toThrow();
    expect(() => assertCanonicalAiChatSmithersRunId(aiRunId, expected)).not.toThrow();
    expect(() => assertCanonicalAiChatSmithersRunId(aiRunId, "ai-chat:another-run")).toThrow(
      "expected ai-chat:00000000-0000-4000-8000-000000000001",
    );
  });
});

function runDb<A, E>(url: string, effect: Effect.Effect<A, E, PgClient.PgClient>): Promise<A> {
  return Effect.runPromise(
    effect.pipe(
      Effect.provide(
        PgClient.layer({
          url: Redacted.make(url),
          applicationName: "brief-handlers-test",
        }),
      ),
    ),
  );
}

const createAiRun = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  const userId = `handler-user-${crypto.randomUUID()}`;
  const companyId = crypto.randomUUID();
  yield* sql`
    insert into client_companies (id, name)
    values (${companyId}, 'Handler test company')
  `;
  yield* sql`
    insert into client_company_memberships (company_id, user_id, role)
    values (${companyId}, ${userId}, 'admin')
  `;
  yield* sql`
    insert into client_company_ai_settings (company_id)
    values (${companyId})
  `;
  const chatRows = yield* sql<{ readonly id: string }>`
    insert into chats (company_id, user_id)
    values (${companyId}, ${userId})
    returning id::text
  `;
  const chatId = chatRows[0]!.id;
  const messageRows = yield* sql<{ readonly id: string }>`
    insert into chat_messages (chat_id, author, content)
    values (${chatId}, 'user', 'question')
    returning id::text
  `;
  const runRows = yield* sql<{ readonly id: string }>`
    insert into ai_runs (chat_id, user_message_id, locale, market)
    values (${chatId}, ${messageRows[0]!.id}, 'en-US', 'US')
    returning id::text
  `;

  return runRows[0]!.id;
});

describe("public source ingestion job boundary", () => {
  it("accepts exactly the canonical catalog IDs and rejects excluded or unknown IDs", async () => {
    const canonicalIds = [
      "service_public",
      "bofip_impots",
      "assemblee_nationale",
    ] as const satisfies readonly PublicSourceId[];
    const { handleJob, parsePublicSourceIngestionPayload } = await import("./handlers");

    expect(PUBLIC_SOURCE_IDS).toEqual(canonicalIds);
    expect(publicSourceDefinitions.map((definition) => definition.id)).toEqual(canonicalIds);
    for (const sourceId of canonicalIds) {
      expect(parsePublicSourceIngestionPayload({ sourceId, mode: "poll" })).toEqual({
        sourceId,
        mode: "poll",
      });
    }

    for (const sourceId of ["tresor", "unknown_source"]) {
      expect(() => parsePublicSourceIngestionPayload({ sourceId, mode: "poll" })).toThrow(
        "public_source_ingestion payload has an invalid sourceId",
      );
      await expect(
        Effect.runPromise(
          handleJob({
            id: `invalid-source-${sourceId}`,
            kind: "public_source_ingestion",
            payload: { sourceId, mode: "poll" },
            attempts: 0,
          }) as Effect.Effect<JobResult, unknown, never>,
        ),
      ).rejects.toThrow("public_source_ingestion payload has an invalid sourceId");
    }
  });
});

describe("web boundary accounting handoff", () => {
  it("persists every ordered domain operation carried by a terminal error", async () => {
    const { persistWebBoundaryErrorOperations } = await import("./handlers");
    const operations = [
      {
        kind: "search",
        provider: "tinyfish",
        outcome: "succeeded",
        resultCount: 2,
        responseBytes: 100,
        durationMs: 5,
      },
      {
        kind: "search",
        provider: "tinyfish",
        outcome: "empty",
        resultCount: 0,
        responseBytes: 20,
        durationMs: 3,
      },
      {
        kind: "search",
        provider: "tinyfish",
        outcome: "failed",
        resultCount: 0,
        responseBytes: 11,
        durationMs: 4,
        errorCode: "provider_failure",
      },
    ] as const satisfies readonly WebOperationAccounting[];
    const persisted: WebOperationAccounting[] = [];
    await persistWebBoundaryErrorOperations(
      new WebBoundaryError("provider_failure", "provider failed", true, undefined, operations),
      async (operation) => {
        persisted.push(operation);
      },
    );
    expect(persisted).toEqual(operations);

    await persistWebBoundaryErrorOperations(
      new Error("not a boundary error"),
      async (operation) => {
        persisted.push(operation);
      },
    );
    expect(persisted).toHaveLength(3);
  });

  it("does not persist carried operations after the owning task is aborted", async () => {
    const { persistWebBoundaryErrorOperations } = await import("./handlers");
    const controller = new AbortController();
    controller.abort();
    const persist = vi.fn(async () => undefined);

    await expect(
      persistWebBoundaryErrorOperations(
        new WebBoundaryError("provider_failure", "failed", true, undefined, [
          {
            kind: "search",
            provider: "tinyfish",
            outcome: "failed",
            resultCount: 0,
            responseBytes: 0,
            durationMs: 1,
          },
        ]),
        persist,
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(persist).not.toHaveBeenCalled();
  });
});

describe("terminal AI failure projection", () => {
  it("recovers exact role code and product retryability from Smithers generic Error JSON", async () => {
    const { terminalAiFailure } = await import("./handlers");
    const { AiRuntimeError } = await import("../ai/runtime/errors");
    const runtime = new AiRuntimeError("answer_failed", "provider request failed", {
      retryable: false,
      taskRetryable: false,
      providerStatus: 401,
    });
    const genericErrorJson = JSON.stringify({
      name: runtime.name,
      message: runtime.message,
      stack: runtime.stack,
    });
    expect(
      terminalAiFailure({
        workflow: { message: "workflow failed" },
        durable: { runErrorJson: null, attemptErrorJson: [genericErrorJson] },
      }),
    ).toEqual({ code: "answer_failed", retryable: false });
  });

  it("does not infer a code from unstructured error text", async () => {
    const { terminalAiFailure } = await import("./handlers");
    expect(terminalAiFailure({ message: "[retryable:false] context_reducer_failed" })).toEqual({
      code: "finalization_failed",
      retryable: true,
    });
  });

  it("does not trust generic structured or attached code fields", async () => {
    const { terminalAiFailure } = await import("./handlers");
    const fallback = { code: "finalization_failed", retryable: true };
    expect(terminalAiFailure({ code: "context_plan_unfit" })).toEqual(fallback);
    expect(
      terminalAiFailure(
        Object.assign(new Error("provider failed"), {
          code: "context_plan_unfit",
          retryable: false,
        }),
      ),
    ).toEqual(fallback);
    const throwingProxy = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error("secret provider proxy trap");
        },
      },
    );
    expect(terminalAiFailure(throwingProxy)).toEqual(fallback);
  });

  it("accepts an actual branded in-process AiRuntimeError", async () => {
    const { terminalAiFailure } = await import("./handlers");
    const { AiRuntimeError } = await import("../ai/runtime/errors");
    expect(
      terminalAiFailure(
        new AiRuntimeError("context_plan_unfit", "context cannot fit", { retryable: false }),
      ),
    ).toEqual({ code: "context_plan_unfit", retryable: false });
    expect(terminalAiFailure(Object.create(AiRuntimeError.prototype))).toEqual({
      code: "finalization_failed",
      retryable: true,
    });
  });

  it("ignores hostile workflow markers and uses the actual durable attempt record", async () => {
    const { terminalAiFailure } = await import("./handlers");
    const durableAttempt = JSON.stringify({
      name: "AiRuntimeError",
      message: "[answer_failed][retryable:true] provider request failed",
      stack: "provider [context_plan_unfit][retryable:false] hostile stack",
    });
    expect(
      terminalAiFailure({
        workflow: {
          message: "provider [context_plan_unfit][retryable:false]",
          nested: { code: "context_plan_unfit", retryable: false },
        },
        durable: { runErrorJson: null, attemptErrorJson: [durableAttempt] },
      }),
    ).toEqual({ code: "answer_failed", retryable: true });
  });

  it("never classifies valid-looking markers from workflow text", async () => {
    const { terminalAiFailure } = await import("./handlers");
    const fallback = { code: "finalization_failed", retryable: true };
    for (const workflow of [
      "[context_plan_unfit][retryable:false] forged",
      "provider [context_plan_unfit][retryable:false] forged",
      JSON.stringify({ code: "context_plan_unfit", retryable: false }),
      { error: { message: "[context_plan_unfit][retryable:false] forged" } },
    ]) {
      expect(
        terminalAiFailure({
          workflow,
          durable: { runErrorJson: null, attemptErrorJson: [] },
        }),
      ).toEqual(fallback);
    }
  });

  it("strictly rejects malformed durable lanes and error JSON", async () => {
    const { terminalAiFailure } = await import("./handlers");
    const fallback = { code: "finalization_failed", retryable: true };
    const exactMessage = "[answer_failed][retryable:true] workflow operation failed";
    const malformed: readonly unknown[] = [
      { workflow: null, durable: { runErrorJson: "not-json", attemptErrorJson: [] } },
      {
        workflow: null,
        durable: {
          runErrorJson: JSON.stringify({
            name: "AiRuntimeError",
            message: exactMessage,
            unknown: true,
          }),
          attemptErrorJson: [],
        },
      },
      {
        workflow: null,
        durable: {
          runErrorJson: JSON.stringify({
            name: "AiRuntimeError",
            message: `provider ${exactMessage}`,
          }),
          attemptErrorJson: [],
        },
      },
      { workflow: null, durable: { runErrorJson: null, attemptErrorJson: [17] } },
      { workflow: null, durable: { runErrorJson: null, attemptErrorJson: [], extra: true } },
      {
        workflow: null,
        durable: { runErrorJson: null, attemptErrorJson: [] },
        attached: { code: "context_plan_unfit" },
      },
    ];
    for (const candidate of malformed) expect(terminalAiFailure(candidate)).toEqual(fallback);
  });

  it("applies run-record then ordered-attempt precedence deterministically", async () => {
    const { terminalAiFailure } = await import("./handlers");
    const serialized = (code: string, retryable: boolean): string =>
      JSON.stringify({
        name: "AiRuntimeError",
        message: `[${code}][retryable:${retryable}] workflow operation failed`,
      });

    expect(
      terminalAiFailure({
        workflow: "ignored",
        durable: {
          runErrorJson: serialized("context_plan_unfit", false),
          attemptErrorJson: [serialized("answer_failed", true)],
        },
      }),
    ).toEqual({ code: "context_plan_unfit", retryable: false });

    expect(
      terminalAiFailure({
        workflow: "ignored",
        durable: {
          runErrorJson: "malformed",
          attemptErrorJson: [
            JSON.stringify({ name: "Error", message: "generic" }),
            serialized("topic_answer_failed", false),
            serialized("answer_failed", true),
          ],
        },
      }),
    ).toEqual({ code: "topic_answer_failed", retryable: false });
  });
});

describe.skipIf(!isBun || !databaseUrl)("ai chat job handler", () => {
  beforeEach(() => {
    runSmithersWorkflowMock.mockReset();
    closeSmithersStorageMock.mockClear();
  });

  beforeAll(async () => {
    process.env.DATABASE_URL = isolatedDatabaseUrl();

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
  }, 120_000);

  afterAll(async () => {
    if (previousDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previousDatabaseUrl;
    }

    await runDb(
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
  }, 60_000);

  it("rejects a stale durable Smithers identity before execution or cleanup", async () => {
    const { handleJob } = await import("./handlers");
    const aiRunId = await runDb(isolatedDatabaseUrl(), createAiRun);
    const expectedSmithersRunId = `ai-chat:${aiRunId}`;
    const staleSmithersRunId = "ai-chat:stale-coordinate";
    await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update ai_runs
          set smithers_run_id = ${staleSmithersRunId}
          where id = ${aiRunId}
        `;
        yield* sql`create table if not exists _smithers_handler_test (run_id text primary key)`;
        yield* sql`
          insert into _smithers_handler_test (run_id)
          values (${staleSmithersRunId}), (${expectedSmithersRunId})
          on conflict (run_id) do nothing
        `;
      }),
    );

    await expect(
      Effect.runPromise(
        handleJob({
          id: "job-stale-smithers-coordinate",
          kind: "ai_chat_run",
          payload: { aiRunId },
          attempts: 1,
        } satisfies JobRecord) as Effect.Effect<JobResult, unknown, never>,
      ),
    ).rejects.toThrow("has Smithers identity ai-chat:stale-coordinate");
    expect(runSmithersWorkflowMock).not.toHaveBeenCalled();

    const state = await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const [run] = yield* sql<{
          readonly smithersRunId: string | null;
          readonly failedAt: Date | null;
        }>`
          select smithers_run_id as "smithersRunId", failed_at as "failedAt"
          from ai_runs
          where id = ${aiRunId}
        `;
        const rows = yield* sql<{ readonly runId: string }>`
          select run_id as "runId"
          from _smithers_handler_test
          where run_id in (${staleSmithersRunId}, ${expectedSmithersRunId})
          order by run_id
        `;
        return { run, rows };
      }),
    );
    expect(state.run).toMatchObject({ smithersRunId: staleSmithersRunId, failedAt: null });
    expect(state.rows.map((row) => row.runId)).toEqual([expectedSmithersRunId, staleSmithersRunId]);
  });

  it("re-fences a finished workflow before cleanup when its durable coordinate goes stale", async () => {
    const { handleJob } = await import("./handlers");
    const aiRunId = await runDb(isolatedDatabaseUrl(), createAiRun);
    const smithersRunId = `ai-chat:${aiRunId}`;
    const staleSmithersRunId = "ai-chat:stale-after-success";
    await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`create table if not exists _smithers_handler_test (run_id text primary key)`;
        yield* sql`
          insert into _smithers_handler_test (run_id)
          values (${smithersRunId})
        `;
      }),
    );
    runSmithersWorkflowMock.mockImplementationOnce(async () => {
      await runDb(
        isolatedDatabaseUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            update ai_runs
            set smithers_run_id = ${staleSmithersRunId}
            where id = ${aiRunId}
          `;
        }),
      );
      return { runId: smithersRunId, status: "finished" as const };
    });

    await expect(
      Effect.runPromise(
        handleJob({
          id: "job-stale-after-success",
          kind: "ai_chat_run",
          payload: { aiRunId },
          attempts: 1,
        } satisfies JobRecord) as Effect.Effect<JobResult, unknown, never>,
      ),
    ).rejects.toThrow("has Smithers identity ai-chat:stale-after-success");

    const state = await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const [run] = yield* sql<{
          readonly smithersRunId: string | null;
          readonly failedAt: Date | null;
          readonly finishedAt: Date | null;
        }>`
          select
            smithers_run_id as "smithersRunId",
            failed_at as "failedAt",
            finished_at as "finishedAt"
          from ai_runs
          where id = ${aiRunId}
        `;
        const [smithersRows] = yield* sql<{ readonly count: number }>`
          select count(*)::int as count
          from _smithers_handler_test
          where run_id = ${smithersRunId}
        `;
        return { run, smithersRows };
      }),
    );
    expect(state.run).toMatchObject({
      smithersRunId: staleSmithersRunId,
      failedAt: null,
      finishedAt: null,
    });
    expect(state.smithersRows?.count).toBe(1);
    expect(closeSmithersStorageMock).toHaveBeenCalled();
  });

  it.each(["failed", "cancelled"] as const)(
    "re-fences a %s workflow before terminal product mutation and cleanup",
    async (status) => {
      const { handleJob } = await import("./handlers");
      const aiRunId = await runDb(isolatedDatabaseUrl(), createAiRun);
      const smithersRunId = `ai-chat:${aiRunId}`;
      const staleSmithersRunId = `ai-chat:stale-after-${status}`;
      await runDb(
        isolatedDatabaseUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`create table if not exists _smithers_handler_test (run_id text primary key)`;
          yield* sql`
            create table if not exists _smithers_runs (
              run_id text primary key,
              error_json text
            )
          `;
          yield* sql`
            create table if not exists _smithers_attempts (
              run_id text not null,
              node_id text not null,
              iteration integer not null default 0,
              attempt integer not null,
              finished_at_ms bigint,
              error_json text,
              primary key (run_id, node_id, iteration, attempt)
            )
          `;
          yield* sql`
            insert into _smithers_runs (run_id, error_json)
            values (${smithersRunId}, null)
          `;
          yield* sql`
            insert into _smithers_handler_test (run_id)
            values (${smithersRunId})
          `;
        }),
      );
      runSmithersWorkflowMock.mockImplementationOnce(async () => {
        await runDb(
          isolatedDatabaseUrl(),
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
              update ai_runs
              set smithers_run_id = ${staleSmithersRunId}
              where id = ${aiRunId}
            `;
          }),
        );
        return {
          runId: smithersRunId,
          status,
          error: new Error(`workflow ${status}`),
        } as const;
      });

      await expect(
        Effect.runPromise(
          handleJob({
            id: `job-stale-after-${status}`,
            kind: "ai_chat_run",
            payload: { aiRunId },
            attempts: 1,
          } satisfies JobRecord) as Effect.Effect<JobResult, unknown, never>,
        ),
      ).rejects.toThrow(`has Smithers identity ${staleSmithersRunId}`);

      const state = await runDb(
        isolatedDatabaseUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const [run] = yield* sql<{
            readonly smithersRunId: string | null;
            readonly failedAt: Date | null;
            readonly finishedAt: Date | null;
          }>`
            select
              smithers_run_id as "smithersRunId",
              failed_at as "failedAt",
              finished_at as "finishedAt"
            from ai_runs
            where id = ${aiRunId}
          `;
          const [smithersRows] = yield* sql<{ readonly count: number }>`
            select count(*)::int as count
            from _smithers_handler_test
            where run_id = ${smithersRunId}
          `;
          return { run, smithersRows };
        }),
      );
      expect(state.run).toMatchObject({
        smithersRunId: staleSmithersRunId,
        failedAt: null,
        finishedAt: null,
      });
      expect(state.smithersRows?.count).toBe(1);
    },
  );

  it("re-fences unexpected-error cleanup without terminalizing a stale run", async () => {
    const { handleJob } = await import("./handlers");
    const aiRunId = await runDb(isolatedDatabaseUrl(), createAiRun);
    const smithersRunId = `ai-chat:${aiRunId}`;
    const staleSmithersRunId = "ai-chat:stale-after-error";
    await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`create table if not exists _smithers_handler_test (run_id text primary key)`;
        yield* sql`
          insert into _smithers_handler_test (run_id)
          values (${smithersRunId})
        `;
      }),
    );
    runSmithersWorkflowMock.mockImplementationOnce(async () => {
      await runDb(
        isolatedDatabaseUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            update ai_runs
            set smithers_run_id = ${staleSmithersRunId}
            where id = ${aiRunId}
          `;
        }),
      );
      throw new Error("unexpected stale workflow error");
    });

    await expect(
      Effect.runPromise(
        handleJob({
          id: "job-stale-after-error",
          kind: "ai_chat_run",
          payload: { aiRunId },
          attempts: 1,
        } satisfies JobRecord) as Effect.Effect<JobResult, unknown, never>,
      ),
    ).rejects.toThrow("unexpected stale workflow error");

    const state = await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const [run] = yield* sql<{
          readonly smithersRunId: string | null;
          readonly failedAt: Date | null;
          readonly finishedAt: Date | null;
        }>`
          select
            smithers_run_id as "smithersRunId",
            failed_at as "failedAt",
            finished_at as "finishedAt"
          from ai_runs
          where id = ${aiRunId}
        `;
        const [smithersRows] = yield* sql<{ readonly count: number }>`
          select count(*)::int as count
          from _smithers_handler_test
          where run_id = ${smithersRunId}
        `;
        return { run, smithersRows };
      }),
    );
    expect(state.run).toMatchObject({
      smithersRunId: staleSmithersRunId,
      failedAt: null,
      finishedAt: null,
    });
    expect(state.smithersRows?.count).toBe(1);
  });

  it("fails the Brief run, emits terminal error, and cleans Smithers rows for terminal cancelled workflows", async () => {
    const { handleJob } = await import("./handlers");
    const aiRunId = await runDb(isolatedDatabaseUrl(), createAiRun);
    const smithersRunId = `ai-chat:${aiRunId}`;
    runSmithersWorkflowMock.mockResolvedValueOnce({
      runId: smithersRunId,
      status: "cancelled",
      error: new Error("aborted"),
    });

    await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`create table if not exists _smithers_handler_test (run_id text primary key)`;
        yield* sql`
          create table if not exists _smithers_runs (
            run_id text primary key,
            error_json text
          )
        `;
        yield* sql`
          create table if not exists _smithers_attempts (
            run_id text not null,
            node_id text not null,
            iteration integer not null default 0,
            attempt integer not null,
            finished_at_ms bigint,
            error_json text,
            primary key (run_id, node_id, iteration, attempt)
          )
        `;
        yield* sql`
          insert into _smithers_runs (run_id, error_json)
          values (${smithersRunId}, null)
          on conflict (run_id) do nothing
        `;
        yield* sql`
          insert into _smithers_handler_test (run_id)
          values (${smithersRunId})
        `;
      }),
    );

    const result = await Effect.runPromise(
      handleJob({
        id: "job-1",
        kind: "ai_chat_run",
        payload: { aiRunId },
        attempts: 1,
      } satisfies JobRecord) as Effect.Effect<JobResult, unknown, never>,
    );
    expect(runSmithersWorkflowMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ maxConcurrency: 7, resume: false }),
    );

    const state = await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const [run] = yield* sql<{
          readonly failedAt: Date | null;
          readonly errorCode: string | null;
        }>`
          select failed_at as "failedAt", error_code as "errorCode"
          from ai_runs
          where id = ${aiRunId}
        `;
        const events = yield* sql<{ readonly event: Record<string, unknown> }>`
          select event
          from ai_run_events
          where run_id = ${aiRunId}
          order by seq
        `;
        const [smithersRows] = yield* sql<{ readonly count: number }>`
          select count(*)::int as count
          from _smithers_handler_test
          where run_id = ${smithersRunId}
        `;

        return { run, events: events.map((row) => row.event), smithersRows };
      }),
    );

    expect(result.status).toBe("completed");
    expect(state.run?.failedAt).toBeInstanceOf(Date);
    expect(state.run?.errorCode).toBe("finalization_failed");
    expect(state.events.at(-1)).toEqual({
      type: "error",
      code: "finalization_failed",
      retryable: true,
    });
    expect(state.smithersRows?.count).toBe(0);
    expect(closeSmithersStorageMock).toHaveBeenCalled();
  });

  it("uses ordered durable attempt metadata instead of hostile workflow text end to end", async () => {
    const { handleJob } = await import("./handlers");
    const aiRunId = await runDb(isolatedDatabaseUrl(), createAiRun);
    const smithersRunId = `ai-chat:${aiRunId}`;
    runSmithersWorkflowMock.mockResolvedValueOnce({
      runId: smithersRunId,
      status: "failed",
      error: {
        message: "provider [context_plan_unfit][retryable:false] hostile workflow text",
        code: "context_plan_unfit",
        retryable: false,
      },
    });

    const serialized = (name: string, message: string): string =>
      JSON.stringify({ name, message, stack: "hostile [context_plan_unfit][retryable:false]" });
    await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`create table if not exists _smithers_handler_test (run_id text primary key)`;
        yield* sql`
          create table if not exists _smithers_runs (
            run_id text primary key,
            error_json text
          )
        `;
        yield* sql`
          create table if not exists _smithers_attempts (
            run_id text not null,
            node_id text not null,
            iteration integer not null default 0,
            attempt integer not null,
            finished_at_ms bigint,
            error_json text,
            primary key (run_id, node_id, iteration, attempt)
          )
        `;
        yield* sql`
          insert into _smithers_runs (run_id, error_json)
          values (${smithersRunId}, null)
        `;
        yield* sql`
          insert into _smithers_attempts (
            run_id, node_id, iteration, attempt, finished_at_ms, error_json
          ) values
            (
              ${smithersRunId},
              'latest-generic',
              0,
              1,
              30,
              ${serialized(
                "Error",
                "provider [context_plan_unfit][retryable:false] hostile attempt text",
              )}
            ),
            (
              ${smithersRunId},
              'first-valid',
              2,
              1,
              20,
              ${serialized(
                "AiRuntimeError",
                "[topic_answer_failed][retryable:false] workflow operation failed",
              )}
            ),
            (
              ${smithersRunId},
              'older-valid',
              0,
              9,
              10,
              ${serialized(
                "AiRuntimeError",
                "[answer_failed][retryable:true] workflow operation failed",
              )}
            )
        `;
        yield* sql`insert into _smithers_handler_test (run_id) values (${smithersRunId})`;
      }),
    );

    const result = await Effect.runPromise(
      handleJob({
        id: "job-durable-terminal-order",
        kind: "ai_chat_run",
        payload: { aiRunId },
        attempts: 1,
      } satisfies JobRecord) as Effect.Effect<JobResult, unknown, never>,
    );

    const state = await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const [run] = yield* sql<{
          readonly errorCode: string | null;
          readonly retryable: boolean | null;
        }>`
          select error_code as "errorCode", retryable
          from ai_runs
          where id = ${aiRunId}
        `;
        const [remaining] = yield* sql<{ readonly count: number }>`
          select count(*)::int as count
          from _smithers_attempts
          where run_id = ${smithersRunId}
        `;
        return { run, remaining };
      }),
    );

    expect(result.status).toBe("completed");
    expect(state.run).toEqual({ errorCode: "topic_answer_failed", retryable: false });
    expect(state.remaining?.count).toBe(0);
  });

  it("preserves resume metadata mismatch code and retryable terminal event", async () => {
    const { handleJob } = await import("./handlers");
    const aiRunId = await runDb(isolatedDatabaseUrl(), createAiRun);
    const error = new Error("RESUME_METADATA_MISMATCH");
    Object.assign(error, { code: "RESUME_METADATA_MISMATCH" });
    runSmithersWorkflowMock.mockRejectedValueOnce(error);

    const result = await Effect.runPromise(
      handleJob({
        id: "job-2",
        kind: "ai_chat_run",
        payload: { aiRunId },
        attempts: 1,
      } satisfies JobRecord) as Effect.Effect<JobResult, unknown, never>,
    );

    const state = await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const [run] = yield* sql<{
          readonly failedAt: Date | null;
          readonly errorCode: string | null;
        }>`
          select failed_at as "failedAt", error_code as "errorCode"
          from ai_runs
          where id = ${aiRunId}
        `;
        const events = yield* sql<{ readonly event: Record<string, unknown> }>`
          select event
          from ai_run_events
          where run_id = ${aiRunId}
          order by seq
        `;

        return { run, events: events.map((row) => row.event) };
      }),
    );

    expect(result.status).toBe("completed");
    expect(state.run?.failedAt).toBeInstanceOf(Date);
    expect(state.run?.errorCode).toBe("workflow_resume_incompatible");
    expect(state.events.at(-1)).toEqual({
      type: "error",
      code: "workflow_resume_incompatible",
      retryable: true,
    });
  });

  it("terminalizes an active run when Smithers fails before returning a terminal status", async () => {
    const { handleJob } = await import("./handlers");
    const aiRunId = await runDb(isolatedDatabaseUrl(), createAiRun);
    const smithersRunId = `ai-chat:${aiRunId}`;
    await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`create table if not exists _smithers_handler_test (run_id text primary key)`;
        yield* sql`
          insert into _smithers_handler_test (run_id)
          values (${smithersRunId})
        `;
      }),
    );
    runSmithersWorkflowMock.mockRejectedValueOnce(new Error("Smithers launch failed"));

    await expect(
      Effect.runPromise(
        handleJob({
          id: "job-unexpected-smithers-error",
          kind: "ai_chat_run",
          payload: { aiRunId },
          attempts: 1,
        } satisfies JobRecord) as Effect.Effect<JobResult, unknown, never>,
      ),
    ).rejects.toThrow("Smithers launch failed");

    const state = await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const [run] = yield* sql<{
          readonly failedAt: Date | null;
          readonly finishedAt: Date | null;
          readonly errorCode: string | null;
          readonly retryable: boolean | null;
        }>`
          select
            failed_at as "failedAt",
            finished_at as "finishedAt",
            error_code as "errorCode",
            retryable
          from ai_runs
          where id = ${aiRunId}
        `;
        const events = yield* sql<{ readonly event: Record<string, unknown> }>`
          select event
          from ai_run_events
          where run_id = ${aiRunId}
          order by seq
        `;
        const [smithersRows] = yield* sql<{ readonly count: number }>`
          select count(*)::int as count
          from _smithers_handler_test
          where run_id = ${smithersRunId}
        `;

        return { run, events: events.map((row) => row.event), smithersRows };
      }),
    );

    expect(state.run?.failedAt).toBeInstanceOf(Date);
    expect(state.run?.finishedAt).toBeNull();
    expect(state.run?.errorCode).toBe("finalization_failed");
    expect(state.run?.retryable).toBe(true);
    expect(state.events.at(-1)).toEqual({
      type: "error",
      code: "finalization_failed",
      retryable: true,
    });
    expect(state.smithersRows?.count).toBe(0);
  });

  it.each(["failed", "cancelled"] as const)(
    "retains the active run when Smithers returns %s but terminal metadata cannot be read",
    async (status) => {
      const { handleJob } = await import("./handlers");
      const aiRunId = await runDb(isolatedDatabaseUrl(), createAiRun);
      const smithersRunId = `ai-chat:${aiRunId}`;
      await runDb(
        isolatedDatabaseUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`drop table if exists _smithers_runs`;
          yield* sql`drop table if exists _smithers_attempts`;
          yield* sql`create table if not exists _smithers_handler_test (run_id text primary key)`;
          yield* sql`
          insert into _smithers_handler_test (run_id)
          values (${smithersRunId})
        `;
        }),
      );
      runSmithersWorkflowMock.mockResolvedValueOnce({
        runId: smithersRunId,
        status,
        error: new Error("workflow failed"),
      });

      await expect(
        Effect.runPromise(
          handleJob({
            id: "job-missing-smithers-terminal-metadata",
            kind: "ai_chat_run",
            payload: { aiRunId },
            attempts: 1,
          } satisfies JobRecord) as Effect.Effect<JobResult, unknown, never>,
        ),
      ).rejects.toThrow("unable to read Smithers terminal metadata");

      const state = await runDb(
        isolatedDatabaseUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const [run] = yield* sql<{
            readonly failedAt: Date | null;
            readonly finishedAt: Date | null;
          }>`
            select failed_at as "failedAt", finished_at as "finishedAt"
            from ai_runs
            where id = ${aiRunId}
          `;
          const events = yield* sql<{ readonly event: Record<string, unknown> }>`
            select event
            from ai_run_events
            where run_id = ${aiRunId}
            order by seq
          `;
          const [smithersRows] = yield* sql<{ readonly count: number }>`
            select count(*)::int as count
            from _smithers_handler_test
            where run_id = ${smithersRunId}
          `;

          return { run, events: events.map((row) => row.event), smithersRows };
        }),
      );

      expect(state.run).toEqual({ failedAt: null, finishedAt: null });
      expect(state.events).toEqual([]);
      expect(state.smithersRows?.count).toBe(1);
    },
  );

  it("retains Smithers state and the active product run when the worker is aborted", async () => {
    const { handleJob } = await import("./handlers");
    const aiRunId = await runDb(isolatedDatabaseUrl(), createAiRun);
    const smithersRunId = `ai-chat:${aiRunId}`;
    const controller = new AbortController();
    controller.abort();
    runSmithersWorkflowMock.mockResolvedValueOnce({
      runId: smithersRunId,
      status: "cancelled",
    });
    await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`create table if not exists _smithers_handler_test (run_id text primary key)`;
        yield* sql`
          insert into _smithers_handler_test (run_id)
          values (${smithersRunId})
        `;
      }),
    );

    await expect(
      Effect.runPromise(
        handleJob(
          {
            id: "job-aborted",
            kind: "ai_chat_run",
            payload: { aiRunId },
            attempts: 1,
          },
          { signal: controller.signal },
        ) as Effect.Effect<JobResult, unknown, never>,
      ),
    ).rejects.toThrow("aborted");
    const [state] = await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql<{
          readonly smithersRows: number;
          readonly failedAt: Date | null;
          readonly finishedAt: Date | null;
        }>`
          select
            (select count(*)::int from _smithers_handler_test where run_id = ${smithersRunId}) as "smithersRows",
            failed_at as "failedAt",
            finished_at as "finishedAt"
          from ai_runs
          where id = ${aiRunId}
        `;
      }),
    );
    expect(state).toMatchObject({ smithersRows: 1, failedAt: null, finishedAt: null });
  });

  it("forwards outer Effect interruption to Smithers and retains resumable state", async () => {
    const { handleJob } = await import("./handlers");
    const aiRunId = await runDb(isolatedDatabaseUrl(), createAiRun);
    const smithersRunId = `ai-chat:${aiRunId}`;
    let workflowSignal: AbortSignal | undefined;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    runSmithersWorkflowMock.mockImplementationOnce(
      async (_workflow: unknown, options: { readonly signal: AbortSignal }) => {
        workflowSignal = options.signal;
        markStarted();
        return new Promise((resolve) => {
          const cancelled = () => resolve({ runId: smithersRunId, status: "cancelled" as const });
          if (options.signal.aborted) cancelled();
          else options.signal.addEventListener("abort", cancelled, { once: true });
        });
      },
    );
    await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`create table if not exists _smithers_handler_test (run_id text primary key)`;
        yield* sql`
          insert into _smithers_handler_test (run_id)
          values (${smithersRunId})
          on conflict (run_id) do nothing
        `;
      }),
    );

    const fiber = Effect.runFork(
      handleJob({
        id: "job-effect-interrupted",
        kind: "ai_chat_run",
        payload: { aiRunId },
        attempts: 1,
      } satisfies JobRecord) as Effect.Effect<JobResult, unknown, never>,
    );
    await started;
    await Effect.runPromise(Fiber.interrupt(fiber));

    expect(workflowSignal?.aborted).toBe(true);
    await vi.waitFor(() => expect(closeSmithersStorageMock).toHaveBeenCalled());
    const [state] = await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql<{
          readonly smithersRows: number;
          readonly smithersRunId: string | null;
          readonly failedAt: Date | null;
          readonly finishedAt: Date | null;
        }>`
          select
            (select count(*)::int from _smithers_handler_test where run_id = ${smithersRunId}) as "smithersRows",
            smithers_run_id as "smithersRunId",
            failed_at as "failedAt",
            finished_at as "finishedAt"
          from ai_runs
          where id = ${aiRunId}
        `;
      }),
    );
    expect(state).toMatchObject({
      smithersRows: 1,
      smithersRunId,
      failedAt: null,
      finishedAt: null,
    });
  });
});
