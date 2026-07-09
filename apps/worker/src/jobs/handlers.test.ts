import { PgClient } from "@effect/sql-pg";
import { Effect, Redacted } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { runMigrations } from "../db/migrate";
import type { JobRecord, JobResult } from "./types";

const runSmithersWorkflowMock = vi.hoisted(() => vi.fn());
const closeSmithersStorageMock = vi.hoisted(() => vi.fn());

vi.mock("../ai/smithers-interop", () => ({
  createSmithersStorage: vi.fn(async () => ({ close: closeSmithersStorageMock })),
  runSmithersWorkflow: runSmithersWorkflowMock,
  smithersRunExists: vi.fn(async () => false),
}));

vi.mock("../ai/workflow/ai-chat", () => ({
  aiChatSchemas: {},
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
  const chatRows = yield* sql<{ readonly id: string }>`
    insert into chats (user_id)
    values (${userId})
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

    const state = await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const [run] = yield* sql<{
          readonly failedAt: Date | null;
          readonly error: string | null;
        }>`
          select failed_at as "failedAt", error
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
    expect(state.run?.error).toBe("smithers_run_cancelled");
    expect(state.events.at(-1)).toEqual({
      type: "error",
      code: "smithers_run_cancelled",
    });
    expect(state.smithersRows?.count).toBe(0);
    expect(closeSmithersStorageMock).toHaveBeenCalled();
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
          readonly error: string | null;
        }>`
          select failed_at as "failedAt", error
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
    expect(state.run?.error).toBe("RESUME_METADATA_MISMATCH");
    expect(state.events.at(-1)).toEqual({
      type: "error",
      code: "RESUME_METADATA_MISMATCH",
      retryable: true,
    });
  });
});
