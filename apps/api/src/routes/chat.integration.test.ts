import { PgClient } from "@effect/sql-pg";
import { ConfigProvider, Effect, Redacted } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { routeRequest, type Route } from "../http";
import { makeChatRoutes } from "./chat";
import { makeMemoryRoutes } from "./memories";

const migrationsUrl = new URL("../../../../db/migrations/", import.meta.url);
const isBun = typeof process.versions.bun === "string";
const databaseUrl = process.env.WORKER_POSTGRES_TEST_DATABASE_URL;
const isolatedDatabaseName = `brief_api_chat_test_${process.pid}_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;

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
          applicationName: "brief-api-chat-test",
        }),
      ),
    ),
  );
}

const runMigrations = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  const files = [...new Bun.Glob("*.sql").scanSync({ cwd: migrationsUrl.pathname })].sort();

  yield* sql`
    create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )
  `;

  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`select pg_advisory_xact_lock(hashtext('brief:schema_migrations'))`;
      const appliedRows = yield* sql<{ readonly name: string }>`
        select name from schema_migrations
      `;
      const applied = new Set(appliedRows.map((row) => row.name));

      for (const file of files) {
        if (applied.has(file)) continue;

        const body = yield* Effect.promise(() => Bun.file(new URL(file, migrationsUrl)).text());
        yield* sql.unsafe(body).raw;
        yield* sql`
          insert into schema_migrations (name)
          values (${file})
        `;
      }
    }),
  );
});

const pgLayer = () =>
  PgClient.layer({
    url: Redacted.make(isolatedDatabaseUrl()),
    applicationName: "brief-api-chat-test",
  });

const configLayer = ConfigProvider.layer(
  ConfigProvider.fromEnv({
    env: {
      AI_STREAM_POLL_MS: "10",
      AI_STREAM_KEEPALIVE_MS: "20",
    },
  }),
);

const testRoutes = (chatOptions?: Parameters<typeof makeChatRoutes>[1]): readonly Route[] => [
  ...makeChatRoutes(pgLayer(), chatOptions),
  ...makeMemoryRoutes(pgLayer()),
];

const request = (method: string, path: string, init?: RequestInit) =>
  new Request(`http://brief.test${path}`, { ...init, method });

const route = (request: Request, routes = testRoutes()) =>
  Effect.runPromise(routeRequest(routes, request).pipe(Effect.provide(configLayer)));

const jsonBody = async <A>(response: Response): Promise<A> => response.json() as Promise<A>;

const createRun = (userId = "demo-user") =>
  runDb(
    isolatedDatabaseUrl(),
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      const chatRows = yield* sql<{ readonly id: string }>`
        insert into chats (user_id)
        values (${userId})
        returning id::text
      `;
      const chatId = chatRows[0]!.id;
      const messageRows = yield* sql<{ readonly id: string }>`
        insert into chat_messages (chat_id, author, content)
        values (${chatId}, 'user', 'seed')
        returning id::text
      `;
      const runRows = yield* sql<{ readonly id: string }>`
        insert into ai_runs (chat_id, user_message_id, locale, market)
        values (${chatId}, ${messageRows[0]!.id}, 'en-US', 'US')
        returning id::text
      `;
      return { chatId, messageId: messageRows[0]!.id, runId: runRows[0]!.id };
    }),
  );

const seedEvent = (runId: string, seq: number, event: Record<string, unknown>) =>
  runDb(
    isolatedDatabaseUrl(),
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      yield* sql`
        insert into ai_run_events (run_id, seq, event)
        values (${runId}, ${seq}, ${sql.json(event)})
      `;
    }),
  );

const clearDemoState = () =>
  runDb(
    isolatedDatabaseUrl(),
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      yield* sql`delete from chats where user_id in ('demo-user', 'other-user')`;
      yield* sql`delete from user_memories where user_id in ('demo-user', 'other-user')`;
    }),
  );

const readStreamText = async (response: Response) => {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text;
    text += decoder.decode(value, { stream: true });
  }
};

const readUntil = async (
  response: Response,
  predicate: (text: string) => boolean,
  signal: AbortController,
) => {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done || predicate(text)) return text;
    text += decoder.decode(value, { stream: true });
    if (predicate(text)) {
      signal.abort();
      return text;
    }
  }
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!isBun || !databaseUrl)("chat runtime API routes", () => {
  beforeAll(async () => {
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

  beforeEach(async () => {
    await clearDemoState();
  });

  it("creates the chat message, ai run, and queued job", async () => {
    const response = await route(
      request("POST", "/v1/chat/messages", {
        body: JSON.stringify({ text: "Explain this", locale: "en-US", market: "US" }),
      }),
    );
    expect(response.status).toBe(200);
    const body = await jsonBody<{ readonly messageId: string; readonly runId: string }>(response);

    const rows = await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const messages = yield* sql<{ readonly count: number }>`
          select count(*)::int as count
          from chat_messages
          where id = ${body.messageId}
            and author = 'user'
        `;
        const runs = yield* sql<{ readonly count: number }>`
          select count(*)::int as count
          from ai_runs
          where id = ${body.runId}
            and locale = 'en-US'
            and market = 'US'
        `;
        const jobs = yield* sql<{ readonly count: number }>`
          select count(*)::int as count
          from jobs
          where kind = 'ai_chat_run'
            and unique_key = ${`ai_chat_run:${body.runId}`}
            and payload->>'aiRunId' = ${body.runId}
        `;
        return {
          messages: messages[0]?.count ?? 0,
          runs: runs[0]?.count ?? 0,
          jobs: jobs[0]?.count ?? 0,
        };
      }),
    );

    expect(rows).toEqual({ messages: 1, runs: 1, jobs: 1 });
  });

  it("allows only one active run under concurrent sends", async () => {
    const responses = await Promise.all([
      route(
        request("POST", "/v1/chat/messages", {
          body: JSON.stringify({ text: "First", locale: "en-US", market: "US" }),
        }),
      ),
      route(
        request("POST", "/v1/chat/messages", {
          body: JSON.stringify({ text: "Second", locale: "en-US", market: "US" }),
        }),
      ),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(await jsonBody(responses.find((response) => response.status === 409)!)).toEqual({
      error: "run_active",
    });

    const counts = await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const rows = yield* sql<{
          readonly chats: number;
          readonly messages: number;
          readonly runs: number;
          readonly jobs: number;
        }>`
          select
            (select count(*)::int from chats where user_id = 'demo-user') as chats,
            (
              select count(*)::int
              from chat_messages m
              join chats c on c.id = m.chat_id
              where c.user_id = 'demo-user'
                and m.author = 'user'
            ) as messages,
            (
              select count(*)::int
              from ai_runs r
              join chats c on c.id = r.chat_id
              where c.user_id = 'demo-user'
            ) as runs,
            (
              select count(*)::int
              from jobs j
              join ai_runs r on j.payload->>'aiRunId' = r.id::text
              join chats c on c.id = r.chat_id
              where c.user_id = 'demo-user'
                and j.kind = 'ai_chat_run'
            ) as jobs
        `;
        return rows[0]!;
      }),
    );

    expect(counts).toEqual({ chats: 1, messages: 1, runs: 1, jobs: 1 });
  });

  it("rejects oversized chat message bodies before JSON parsing", async () => {
    const response = await route(
      request("POST", "/v1/chat/messages", {
        headers: { "content-length": "65537" },
        body: "{",
      }),
    );

    expect(response.status).toBe(413);
    expect(await jsonBody(response)).toEqual({ error: "request_too_large" });
  });

  it("rejects non-strict chat message body shapes", async () => {
    const withExtraField = await route(
      request("POST", "/v1/chat/messages", {
        body: JSON.stringify({ text: "Explain", locale: "en-US", market: "US", extra: true }),
      }),
    );
    expect(withExtraField.status).toBe(400);
    expect(await jsonBody(withExtraField)).toEqual({ error: "invalid_body" });

    const missingTypedField = await route(
      request("POST", "/v1/chat/messages", {
        body: JSON.stringify({ text: "Explain", locale: "en-US" }),
      }),
    );
    expect(missingTypedField.status).toBe(400);
    expect(await jsonBody(missingTypedField)).toEqual({ error: "invalid_body" });
  });

  it("rejects unsupported locale and market pairs", async () => {
    const response = await route(
      request("POST", "/v1/chat/messages", {
        body: JSON.stringify({ text: "Bonjour", locale: "fr-FR", market: "US" }),
      }),
    );
    expect(response.status).toBe(400);
  });

  it("returns the demo chat with active run, citations, and context blocks", async () => {
    const state = await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const chatRows = yield* sql<{ readonly id: string }>`
          insert into chats (user_id)
          values ('demo-user')
          returning id::text
        `;
        const chatId = chatRows[0]!.id;
        const userRows = yield* sql<{ readonly id: string }>`
          insert into chat_messages (chat_id, author, content)
          values (${chatId}, 'user', 'question')
          returning id::text
        `;
        const runRows = yield* sql<{ readonly id: string }>`
          insert into ai_runs (chat_id, user_message_id, locale, market, finished_at)
          values (${chatId}, ${userRows[0]!.id}, 'en-US', 'US', now())
          returning id::text
        `;
        const runId = runRows[0]!.id;
        const assistantRows = yield* sql<{ readonly id: string }>`
          insert into chat_messages (chat_id, author, content, ai_run_id)
          values (${chatId}, 'assistant', 'answer [[cite:b1]]', ${runId})
          returning id::text
        `;
        yield* sql`
          update ai_runs
          set assistant_message_id = ${assistantRows[0]!.id}
          where id = ${runId}
        `;
        yield* sql`
          insert into chat_context_blocks (
            chat_id,
            block_id,
            kind,
            content,
            token_estimate,
            provenance,
            created_by_run_id
          )
          values (
            ${chatId},
            'b1',
            'document',
            'context',
            42,
            ${sql.json({
              documentId: "doc-1",
              sourceId: "source-1",
              sourceDisplayName: "Source One",
              canonicalUrl: "https://source.example/doc-1",
              title: "Document One",
              publishedAt: "2026-07-08T10:00:00.000Z",
              charStart: null,
              charEnd: null,
            })},
            ${runId}
          )
        `;
        yield* sql`
          insert into ai_observations (run_id, chat_id, kind, payload)
          values
            (${runId}, ${chatId}, 'citation', ${sql.json({ blockId: "b1", messageId: assistantRows[0]!.id })}),
            (${runId}, ${chatId}, 'context_block_added', ${sql.json({ blockId: "b1", label: "Source One: Document One", tokenEstimate: 42 })})
        `;
        const activeRows = yield* sql<{ readonly id: string }>`
          insert into chat_messages (chat_id, author, content)
          values (${chatId}, 'user', 'active question')
          returning id::text
        `;
        const activeRunRows = yield* sql<{ readonly id: string }>`
          insert into ai_runs (chat_id, user_message_id, locale, market)
          values (${chatId}, ${activeRows[0]!.id}, 'en-US', 'US')
          returning id::text
        `;

        return { activeRunId: activeRunRows[0]!.id };
      }),
    );

    const response = await route(request("GET", "/v1/chat"));
    expect(response.status).toBe(200);
    const body = await jsonBody<{
      readonly activeRunId: string | null;
      readonly messages: readonly {
        readonly author: string;
        readonly citations?: readonly {
          readonly blockId: string;
          readonly kind: string;
          readonly label: string | null;
          readonly sourceDisplayName: string | null;
          readonly title: string | null;
          readonly canonicalUrl: string | null;
          readonly publishedAt: string | null;
        }[];
        readonly contextBlocks?: readonly {
          readonly blockId: string;
          readonly tokenEstimate: number;
        }[];
      }[];
    }>(response);

    expect(body.activeRunId).toBe(state.activeRunId);
    const assistant = body.messages.find((message) => message.author === "assistant");
    expect(assistant?.citations).toEqual([
      {
        blockId: "b1",
        kind: "document",
        label: "Source One",
        sourceDisplayName: "Source One",
        title: "Document One",
        canonicalUrl: "https://source.example/doc-1",
        publishedAt: "2026-07-08T10:00:00.000Z",
      },
    ]);
    expect(assistant?.contextBlocks).toEqual([
      expect.objectContaining({ blockId: "b1", tokenEstimate: 42 }),
    ]);
  });

  it("streams ordered events, replays afterSeq, and closes on done", async () => {
    const fixture = await createRun();
    await seedEvent(fixture.runId, 1, { type: "run_started" });
    await seedEvent(fixture.runId, 2, { type: "text_delta", delta: "hello" });
    await seedEvent(fixture.runId, 3, { type: "done", assistantMessageId: "message-a" });

    const response = await route(request("GET", `/v1/ai-runs/${fixture.runId}/stream`));
    expect(response.status).toBe(200);
    expect(await readStreamText(response)).toContain(
      'id: 1\nevent: run_started\ndata: {"type":"run_started"}',
    );

    const replay = await route(
      request("GET", `/v1/ai-runs/${fixture.runId}/stream?afterSeq=1`, {
        headers: { "Last-Event-ID": "2" },
      }),
    );
    const replayText = await readStreamText(replay);
    expect(replayText).not.toContain("id: 1");
    expect(replayText).not.toContain("id: 2");
    expect(replayText).toContain("id: 3");
  });

  it("sends stream keep-alive comments while waiting", async () => {
    const fixture = await createRun();
    const controller = new AbortController();
    const response = await route(
      request("GET", `/v1/ai-runs/${fixture.runId}/stream`, {
        signal: controller.signal,
      }),
    );
    const text = await readUntil(response, (value) => value.includes(": keep-alive"), controller);

    expect(text).toContain(": keep-alive");
  });

  it("stops polling silently when the stream aborts mid-poll", async () => {
    const fixture = await createRun();
    const controller = new AbortController();
    let pollCalls = 0;
    let resolveFirstPoll!: () => void;
    let resolvePoll!: (
      rows: readonly { readonly seq: number; readonly event: Record<string, unknown> }[],
    ) => void;
    const firstPoll = new Promise<void>((resolve) => {
      resolveFirstPoll = resolve;
    });
    const pollResult = new Promise<
      readonly { readonly seq: number; readonly event: Record<string, unknown> }[]
    >((resolve) => {
      resolvePoll = resolve;
    });
    const routes = testRoutes({
      readAiRunEventsAfter: async () => {
        pollCalls += 1;
        resolveFirstPoll();
        return pollResult;
      },
    });

    const response = await route(
      request("GET", `/v1/ai-runs/${fixture.runId}/stream`, {
        signal: controller.signal,
      }),
      routes,
    );
    expect(response.status).toBe(200);

    await firstPoll;
    controller.abort();
    resolvePoll([{ seq: 1, event: { type: "text_delta", delta: "late" } }]);

    const reader = response.body!.getReader();
    await expect(reader.read()).resolves.toMatchObject({ done: true });
    await delay(30);
    expect(pollCalls).toBe(1);
  });

  it("404s a foreign run stream", async () => {
    const fixture = await createRun("other-user");
    const response = await route(request("GET", `/v1/ai-runs/${fixture.runId}/stream`));

    expect(response.status).toBe(404);
  });

  it("lists memories and reverts deleted memory content", async () => {
    const seeded = await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const rows = yield* sql<{ readonly id: string }>`
          insert into user_memories (user_id, kind, content, evidence_quote, deleted_at)
          values ('demo-user', 'preference', 'new content', 'evidence', now())
          returning id::text
        `;
        const memoryId = rows[0]!.id;
        yield* sql`
          insert into user_memory_revisions (
            memory_id,
            action,
            content_before,
            content_after
          )
          values (${memoryId}, 'deleted', 'old content', null)
        `;
        return { memoryId };
      }),
    );

    const listResponse = await route(request("GET", "/v1/memories"));
    expect(listResponse.status).toBe(200);
    const list = await jsonBody<{
      readonly memories: readonly { readonly id: string; readonly deleted: boolean }[];
    }>(listResponse);
    expect(list.memories.find((memory) => memory.id === seeded.memoryId)?.deleted).toBe(true);

    const revertResponse = await route(request("POST", `/v1/memories/${seeded.memoryId}/revert`));
    expect(revertResponse.status).toBe(200);
    const reverted = await jsonBody<{
      readonly memory: {
        readonly content: string;
        readonly deleted: boolean;
        readonly revisions: readonly { readonly action: string }[];
      };
    }>(revertResponse);
    expect(reverted.memory.content).toBe("old content");
    expect(reverted.memory.deleted).toBe(false);
    expect(reverted.memory.revisions.at(-1)?.action).toBe("reverted");
  });
});
