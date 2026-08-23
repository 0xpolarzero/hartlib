import { PgClient } from "@effect/sql-pg";
import { runMigrations } from "@hartlib/database/migrations";
import {
  deleteUserMemory,
  listUserMemories,
  readUserMemoryWithRevisions,
} from "@hartlib/backend-domain/memories";
import { ConfigProvider, Effect, Redacted } from "effect";
import { makeRunAcceptanceScope } from "@hartlib/shared";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { RequestAuthenticator } from "../auth";
import { routeRequest, type Route } from "../http";
import { DEMO_COOKIE_NAME } from "../demo-session";
import { makeChatRoutes, type AiRunEventPoller } from "../domain/chat";
import { makeMemoryRoutes } from "../domain/memories";

const isBun = typeof process.versions.bun === "string";

const demoCookie = `${DEMO_COOKIE_NAME}=demo-user`;
const databaseUrl = process.env.WORKER_POSTGRES_TEST_DATABASE_URL;
const databaseName = `hartlib_api_contract_${process.pid}_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;

const sourceUrl = () => {
  if (databaseUrl === undefined) throw new Error("WORKER_POSTGRES_TEST_DATABASE_URL is required");
  return databaseUrl;
};

const withDatabase = (name: string) => {
  const url = new URL(sourceUrl());
  url.pathname = `/${name}`;
  return url.toString();
};

const adminUrl = () => withDatabase("postgres");
const isolatedUrl = () => withDatabase(databaseName);
const quoteIdentifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
const namespacedPublicDocumentIdentity = (sourceId: string, documentId: string): string =>
  `document:namespace:public:${JSON.stringify([`public:${sourceId}`, documentId])}`;
const namespacedPublisherDocumentIdentity = (
  subscriptionId: string,
  issueId: string,
  documentId: string,
): string =>
  `document:namespace:publisher:${JSON.stringify([
    `publisher:${subscriptionId}`,
    issueId,
    documentId,
    documentId,
  ])}`;

const documentContentItemIdentity = (
  logicalSourceIdentity: string,
  snapshotId: string,
  ranges: readonly { readonly charStart: number; readonly charEnd: number }[],
): string =>
  `${logicalSourceIdentity}:${snapshotId}:${createHash("sha256")
    .update(JSON.stringify(ranges), "utf8")
    .digest("base64url")}`;

const runDb = <A, E>(url: string, effect: Effect.Effect<A, E, PgClient.PgClient>): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        PgClient.layer({ url: Redacted.make(url), applicationName: "hartlib-api-contract-test" }),
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
          url: Redacted.make(isolatedUrl()),
          applicationName,
        }),
      ),
    ),
  );

const waitForDatabaseLock = async (applicationName: string): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const waiting = await runDb(
      isolatedUrl(),
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

const waitForDatabaseBlocker = async (
  waitingApplicationName: string,
  blockingApplicationName: string,
): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const blocked = await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{ readonly blocked: boolean }>`
            select exists(
              select 1
              from pg_stat_activity waiting
              cross join lateral unnest(pg_blocking_pids(waiting.pid)) blocker_pid
              join pg_stat_activity blocking on blocking.pid = blocker_pid
              where waiting.datname = current_database()
                and waiting.application_name = ${waitingApplicationName}
                and blocking.application_name = ${blockingApplicationName}
            ) as blocked
          `)[0]!.blocked;
      }),
    );
    if (blocked) return;
    await Bun.sleep(5);
  }
  throw new Error(`${waitingApplicationName} was not blocked by ${blockingApplicationName}`);
};

const pgLayer = () =>
  PgClient.layer({
    url: Redacted.make(isolatedUrl()),
    applicationName: "hartlib-api-contract-test",
  });

const configLayer = ConfigProvider.layer(
  ConfigProvider.fromEnv({
    env: {
      AUTH_MODE: "demo",
      AI_STREAM_POLL_MS: "5",
      AI_STREAM_KEEPALIVE_MS: "10",
      TINYFISH_API_KEY: "test-key",
      AI_WEB_MAX_DOMAIN_FILTERS: "2",
    },
  }),
);

const clerkStreamConfigLayer = ConfigProvider.layer(
  ConfigProvider.fromEnv({
    env: {
      AUTH_MODE: "clerk",
      CLERK_SECRET_KEY: "sk_test_stream",
      CLERK_PUBLISHABLE_KEY: "pk_test_stream",
      AI_STREAM_POLL_MS: "5",
      AI_STREAM_KEEPALIVE_MS: "60000",
      TINYFISH_API_KEY: "test-key",
      AI_WEB_MAX_DOMAIN_FILTERS: "2",
    },
  }),
);

const routes = (): readonly Route[] => [
  ...makeChatRoutes(pgLayer()),
  ...makeMemoryRoutes(pgLayer()),
];
const request = (method: string, path: string, init?: RequestInit) =>
  new Request(`http://hartlib.test${path}`, {
    ...init,
    method,
    headers: { cookie: demoCookie, ...(init?.headers as Record<string, string> | undefined) },
  });
const route = (value: Request) =>
  Effect.runPromise(routeRequest(routes(), value).pipe(Effect.provide(configLayer)));
const body = <A>(response: Response): Promise<A> => response.json() as Promise<A>;

const getChat = async () => {
  const response = await route(request("GET", "/v1/chat"));
  expect(response.status).toBe(200);
  return body<{
    chat: { id: string };
    activeRun: { id: string } | null;
    effectiveWebPolicy: unknown;
    messages: readonly unknown[];
  }>(response);
};

const getSharedChat = async () => {
  const chat = await getChat();
  const sharedChatId = crypto.randomUUID();
  await runDb(
    isolatedUrl(),
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      const companyId = (yield* sql<{ readonly id: string }>`
        select company_id::text as id from chats where id = ${chat.chat.id}
      `)[0]!.id;
      yield* sql`
        insert into chats (id, user_id, company_id, memory_mode, shared_at)
        values (${sharedChatId}, 'demo-user', ${companyId}, 'disabled', now())
      `;
    }),
  );
  return { ...chat, chat: { ...chat.chat, id: sharedChatId } };
};

const postMessage = (input: Record<string, unknown>) =>
  route(
    request("POST", "/v1/chat/messages", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  );

const terminalRun = (runId: string) =>
  runDb(
    isolatedUrl(),
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      yield* sql`
        update ai_runs
        set finished_at = now(), error_code = null, retryable = null
        where id = ${runId}
      `;
    }),
  );

const seedMemory = (content = "Use concise answers") =>
  runDb(
    isolatedUrl(),
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const memoryId = crypto.randomUUID();
          const revisionId = crypto.randomUUID();
          yield* sql`
            insert into user_memories (
              id, user_id, kind, content, head_revision_id, source_message_id
            ) values (${memoryId}, 'demo-user', 'preference', ${content}, ${revisionId}, null)
          `;
          yield* sql`
            insert into user_memory_revisions (id, memory_id, action, state_before, state_after)
            values (
              ${revisionId}, ${memoryId}, 'create', null,
              ${sql.json({ kind: "preference", content, deleted: false })}
            )
          `;
          return { memoryId, revisionId };
        }),
      );
    }),
  );

const holdMemoryRevisionTable = (applicationName: string) => {
  let signalHeld!: () => void;
  const held = new Promise<void>((resolve) => {
    signalHeld = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const done = runDbAs(
    applicationName,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`lock table user_memory_revisions in access exclusive mode`;
          yield* Effect.sync(signalHeld);
          yield* Effect.promise(() => released);
        }),
      );
    }),
  );
  return {
    held,
    release,
    done,
  };
};

const readStream = async (response: Response) => {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text;
    text += decoder.decode(value, { stream: true });
  }
};
const readStreamUntil = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  expected: string,
) => {
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) throw new Error(`stream ended before ${expected}`);
    text += decoder.decode(value, { stream: true });
    if (text.includes(expected)) return text;
  }
};

describe.skipIf(!isBun || !databaseUrl)("canonical chat and memory API", () => {
  beforeAll(async () => {
    await runDb(
      adminUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql.unsafe(`create database ${quoteIdentifier(databaseName)}`).withoutTransform;
      }),
    );
    await runDb(isolatedUrl(), runMigrations);
  });

  afterAll(async () => {
    await runDb(
      adminUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`select pg_terminate_backend(pid) from pg_stat_activity where datname = ${databaseName}`;
        yield* sql.unsafe(`drop database if exists ${quoteIdentifier(databaseName)}`)
          .withoutTransform;
      }),
    );
  });

  beforeEach(async () => {
    await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`truncate table client_companies cascade`;
        yield* sql`truncate table jobs cascade`;
        yield* sql`delete from user_memories`;
      }),
    );
  });

  it("creates one deterministic chat workspace safely under concurrent first reads", async () => {
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => route(request("GET", "/v1/chat"))),
    );
    expect(responses.every((response) => response.status === 200)).toBe(true);
    const payloads = await Promise.all(
      responses.map((response) => body<{ effectiveWebPolicy: unknown }>(response.clone())),
    );
    expect(
      payloads.every(
        ({ effectiveWebPolicy }) =>
          JSON.stringify(effectiveWebPolicy) ===
          JSON.stringify({ enabled: true, provider: "tinyfish", allowedDomains: null }),
      ),
    ).toBe(true);
    const counts = await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{
          chats: number;
          companies: number;
          memberships: number;
          users: number;
        }>`
          select
            (select count(*)::int from chats) chats,
            (select count(*)::int from client_companies) companies,
            (select count(*)::int from client_company_memberships) memberships,
            (select count(*)::int from platform_users where id = 'demo-user') users
        `)[0]!;
      }),
    );
    expect(counts).toEqual({ chats: 1, companies: 1, memberships: 1, users: 1 });
  });

  it("keeps demo GET projection stable when actual finalization starts between its queries", async () => {
    const chat = await getChat();
    const memoryResult = { proposals: [], discardedCount: 0 } as const;
    const canonicalizationModuleUrl = new URL(
      "../../../worker/src/ai/runtime/canonicalization.ts",
      import.meta.url,
    ).href;
    const canonicalizationModule = await import(/* @vite-ignore */ canonicalizationModuleUrl);
    const extractionSha256Hex = canonicalizationModule.memoryExtractionSha256Hex(memoryResult);
    const memoryProducer = {
      taskId: "memory-extract" as const,
      loopIteration: 0,
      attempt: 0,
      observationKey: "memory-extract:0:0:memory_extraction_result:result",
      extractionSha256Hex,
    };
    const runId = crypto.randomUUID();
    await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const [message] = yield* sql<{ readonly id: string }>`
          insert into chat_messages (chat_id, author, content)
          values (${chat.chat.id}, 'user', 'Finalize while demo reload is projecting')
          returning id::text
        `;
        const [chatRow] = yield* sql<{ readonly companyId: string }>`
          select company_id::text as "companyId" from chats where id = ${chat.chat.id}
        `;
        yield* sql`
          insert into ai_runs (
            id,
            chat_id, initiating_user_id, user_message_id, locale, market,
            acceptance_scope, smithers_run_id
          ) values (
            ${runId}, ${chat.chat.id}, 'demo-user', ${message!.id}, 'en-US', 'US',
            ${sql.json(
              makeRunAcceptanceScope({
                userId: "demo-user",
                chatId: chat.chat.id,
                companyId: chatRow!.companyId,
              }),
            )},
            ${`ai-chat:${runId}`}
          )
        `;
        yield* sql`
          insert into ai_observations (
            run_id, chat_id, emitting_task, loop_iteration, attempt,
            observation_key, kind, payload
          ) values (
            ${runId}, ${chat.chat.id}, 'plan-turn', 0, 0,
            'demo-route:turn-plan', 'turn_plan',
            ${sql.json({ mode: "clarify", question: "answered" })}
          )
        `;
        yield* sql`
          insert into ai_observations (
            run_id, chat_id, emitting_task, loop_iteration, attempt,
            observation_key, kind, payload
          ) values (
            ${runId}, ${chat.chat.id}, 'plan-turn', 0, 0,
            'demo-route:plan-measurement', 'provider_request_measurement',
            ${sql.json({
              providerRequestIndex: 0,
              agentRole: "plan_turn",
              modelId: "glm-5-turbo",
              requestSha256Hex: "a".repeat(64),
              sourceExposureProofSha256Hexes: [],
              inputTokens: 10,
              requestedOutputTokens: 2048,
              usableInputTokens: 6144,
              contextWindow: 8192,
              passed: true,
            })}
          )
        `;
        yield* sql`
          insert into ai_run_usage (
            run_id, task_id, loop_iteration, attempt, provider_request_index,
            agent_role, model_id, provider_service_id, input_tokens, output_tokens, cached_tokens,
            reasoning_tokens, total_tokens, stop_reason
          ) values (
            ${runId}, 'plan-turn', 0, 0, 0, 'plan_turn', 'glm-5-turbo', 'zai_coding_plan_official',
            10, 4, 0, 0, 14, 'stop'
          )
        `;
        yield* sql`
          insert into ai_observations (
            run_id, chat_id, emitting_task, loop_iteration, attempt,
            observation_key, kind, payload
          ) values (
            ${runId}, ${chat.chat.id}, 'memory-extract', 0, 0,
            'demo-route:memory-measurement', 'provider_request_measurement',
            ${sql.json({
              providerRequestIndex: 0,
              agentRole: "memory_extractor",
              modelId: "glm-5-turbo",
              requestSha256Hex: "b".repeat(64),
              sourceExposureProofSha256Hexes: [],
              inputTokens: 10,
              requestedOutputTokens: 2048,
              usableInputTokens: 6144,
              contextWindow: 8192,
              passed: true,
            })}
          )
        `;
        yield* sql`
          insert into ai_run_usage (
            run_id, task_id, loop_iteration, attempt, provider_request_index,
            agent_role, model_id, provider_service_id, input_tokens, output_tokens, cached_tokens,
            reasoning_tokens, total_tokens, stop_reason
          ) values (
            ${runId}, 'memory-extract', 0, 0, 0, 'memory_extractor', 'glm-5-turbo', 'zai_coding_plan_official',
            10, 4, 0, 0, 14, 'stop'
          )
        `;
        yield* sql`
          insert into ai_observations (
            run_id, chat_id, emitting_task, loop_iteration, attempt,
            observation_key, kind, payload
          ) values (
            ${runId}, ${chat.chat.id}, ${memoryProducer.taskId},
            ${memoryProducer.loopIteration}, ${memoryProducer.attempt},
            ${memoryProducer.observationKey}, 'memory_extraction_result',
            ${sql.json({
              proposalCount: memoryResult.proposals.length,
              discardedCount: memoryResult.discardedCount,
              extractionSha256Hex,
            })}
          )
        `;
      }),
    );
    const finalizationModuleUrl = new URL(
      "../../../worker/src/ai/product-state/finalization.ts",
      import.meta.url,
    ).href;
    const finalizationModule = await import(/* @vite-ignore */ finalizationModuleUrl);

    let signalRunsTableHeld!: () => void;
    const runsTableHeld = new Promise<void>((resolve) => {
      signalRunsTableHeld = resolve;
    });
    let releaseRunsTable!: () => void;
    const runsTableReleased = new Promise<void>((resolve) => {
      releaseRunsTable = resolve;
    });
    const tableHolder = runDbAs(
      "hartlib-demo-route-runs-table-holder",
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`lock table ai_runs in access exclusive mode`;
            yield* Effect.sync(signalRunsTableHeld);
            yield* Effect.promise(() => runsTableReleased);
          }),
        );
      }),
    );
    await runsTableHeld;

    const reading = route(request("GET", "/v1/chat"));
    await waitForDatabaseLock("hartlib-api-contract-test");
    const finalizing = runDbAs(
      "hartlib-demo-route-actual-finalization",
      finalizationModule.finalizeAiRun({
        runId,
        expectedSmithersRunId: `ai-chat:${runId}`,
        coordinates: { loopIteration: 0, attempt: 1 },
        answer: {
          status: "ok",
          mode: "clarification",
          content: "Clarification committed after the stable reload",
          sourceMap: [],
        },
        memory: { result: memoryResult, producer: memoryProducer },
      }),
    );
    try {
      await waitForDatabaseLock("hartlib-demo-route-actual-finalization");
    } finally {
      releaseRunsTable();
    }

    const response = await reading;
    expect(response.status).toBe(200);
    const during = await body<{
      readonly activeRun: { readonly id: string } | null;
      readonly messages: readonly { readonly author: string; readonly content: string }[];
    }>(response);
    expect(during.activeRun).toMatchObject({ id: runId });
    expect(during.messages.some((message) => message.author === "assistant")).toBe(false);
    await tableHolder;
    await expect(finalizing).resolves.toMatchObject({ status: "succeeded" });

    const after = await getChat();
    expect(after.activeRun).toBeNull();
    expect(JSON.stringify(after.messages)).toContain(
      "Clarification committed after the stable reload",
    );
  });

  it("returns company-disabled policy after an explicit company opt-out and rejects web atomically", async () => {
    const chat = await getChat();
    await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update client_company_ai_settings settings
          set web_search_enabled = false
          from chats where chats.company_id = settings.company_id and chats.id = ${chat.chat.id}
        `;
      }),
    );
    const disabledChat = await getChat();
    expect(disabledChat.effectiveWebPolicy).toEqual({
      enabled: false,
      reason: "company_disabled",
      allowlistActive: false,
    });
    const response = await postMessage({
      text: "Use the web",
      locale: "fr-FR",
      market: "US",
      webSearchEnabled: true,
    });
    expect(response.status).toBe(403);
    expect(await body(response)).toEqual({
      code: "web_research_unavailable",
      reason: "company_disabled",
    });
    const runCount = await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{ count: number }>`select count(*)::int count from ai_runs`)[0]!.count;
      }),
    );
    expect(runCount).toBe(0);
  });

  it("rejects an adapter-unenforceable allowlist before accepting a web run", async () => {
    const chat = await getChat();
    await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update client_company_ai_settings settings
          set web_search_enabled = true,
              web_domain_allowlist = array['a.gouv.fr', 'b.gouv.fr', 'c.gouv.fr']
          from chats where chats.company_id = settings.company_id and chats.id = ${chat.chat.id}
        `;
      }),
    );

    expect((await getChat()).effectiveWebPolicy).toEqual({
      enabled: false,
      reason: "allowlist_unsupported",
      allowlistActive: true,
    });
    const response = await postMessage({
      text: "Use the web",
      locale: "en-US",
      market: "FR",
      webSearchEnabled: true,
    });
    expect(response.status).toBe(403);
    expect(await body(response)).toEqual({
      code: "web_research_unavailable",
      reason: "allowlist_unsupported",
    });
    const runCount = await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{ count: number }>`select count(*)::int count from ai_runs`)[0]!.count;
      }),
    );
    expect(runCount).toBe(0);
  });

  it("accepts the exact request, snapshots enabled policy, and returns the durable descriptor", async () => {
    const chat = await getChat();
    await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update client_company_ai_settings settings
          set web_search_enabled = true,
              web_domain_allowlist = array['GOUV.FR.', 'gouv.fr']
          from chats where chats.company_id = settings.company_id and chats.id = ${chat.chat.id}
        `;
      }),
    );
    const response = await postMessage({
      text: " Question ",
      locale: "fr-FR",
      market: "US",
      webSearchEnabled: true,
    });
    expect(response.status).toBe(202);
    const accepted = await body<{
      message: { id: string; author: string; content: string };
      run: { id: string; status: string; streamPath: string };
    }>(response);
    expect(accepted).toMatchObject({
      message: { author: "user", content: " Question " },
      run: { status: "queued", streamPath: `/v1/ai-runs/${accepted.run.id}/stream` },
    });
    const rows = await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{ policy: unknown; web: boolean; jobs: number }>`
          select jsonb_build_object(
                   'enabled', (r.acceptance_scope->>'webEnabled')::boolean,
                   'provider', r.acceptance_scope->>'webTransportProvider',
                   'allowedDomains', r.acceptance_scope->'allowedDomains'
                 ) policy,
                 (r.acceptance_scope->>'webRequested')::boolean web,
                 (select count(*)::int from jobs where payload->>'aiRunId' = r.id::text) jobs
          from ai_runs r where r.id = ${accepted.run.id}
        `)[0]!;
      }),
    );
    expect(rows).toEqual({
      policy: { enabled: true, provider: "tinyfish", allowedDomains: ["gouv.fr"] },
      web: true,
      jobs: 1,
    });
  });

  it("lets DB indexes arbitrate concurrent sends and returns a chat-scoped descriptor", async () => {
    await getChat();
    const input = { text: "Concurrent", locale: "en-US", market: "FR", webSearchEnabled: false };
    const responses = await Promise.all([postMessage(input), postMessage(input)]);
    expect(responses.map((response) => response.status).sort()).toEqual([202, 409]);
    const conflict = responses.find((response) => response.status === 409)!;
    expect(await body(conflict)).toMatchObject({ code: "active_ai_run", conflictScope: "chat" });
  });

  it("gives same-chat conflicts precedence over the initiating-user guard", async () => {
    const chat = await getChat();
    const active = await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const messages = yield* sql<{ id: string }>`
          insert into chat_messages (chat_id, author, content)
          values (${chat.chat.id}, 'user', 'other user') returning id::text
        `;
        const [chatRow] = yield* sql<{ readonly companyId: string }>`
          select company_id::text as "companyId" from chats where id = ${chat.chat.id}
        `;
        return (yield* sql<{ id: string }>`
          insert into ai_runs (chat_id, initiating_user_id, user_message_id, locale, market, acceptance_scope)
          values (
            ${chat.chat.id}, 'demo-user', ${messages[0]!.id}, 'en-US', 'US',
            ${sql.json(
              makeRunAcceptanceScope({
                userId: "demo-user",
                chatId: chat.chat.id,
                companyId: chatRow!.companyId,
              }),
            )}
          )
          returning id::text
        `)[0]!.id;
      }),
    );
    const response = await postMessage({
      text: "Mine",
      locale: "en-US",
      market: "US",
      webSearchEnabled: false,
    });
    expect(response.status).toBe(409);
    expect(await body(response)).toMatchObject({
      conflictScope: "chat",
      activeRun: { id: active },
    });
  });

  it("returns a user-scoped conflict when that user's memory lane is active in another chat", async () => {
    const chat = await getChat();
    const active = await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const companies = yield* sql<{
          id: string;
        }>`insert into client_companies (name) values ('Other') returning id::text`;
        const companyId = companies[0]!.id;
        yield* sql`insert into client_company_memberships (company_id, user_id, role) values (${companyId}, 'demo-user', 'admin')`;
        yield* sql`insert into client_company_ai_settings (company_id) values (${companyId})`;
        const chats = yield* sql<{ id: string }>`
          insert into chats (user_id, company_id, memory_mode)
          values ('demo-user', ${companyId}, 'private_owner') returning id::text
        `;
        const messages = yield* sql<{ id: string }>`
          insert into chat_messages (chat_id, author, content)
          values (${chats[0]!.id}, 'user', 'cross-chat') returning id::text
        `;
        return (yield* sql<{ id: string }>`
          insert into ai_runs (chat_id, initiating_user_id, user_message_id, locale, market, acceptance_scope)
          values (
            ${chats[0]!.id}, 'demo-user', ${messages[0]!.id}, 'en-US', 'US',
            ${sql.json(
              makeRunAcceptanceScope({
                userId: "demo-user",
                chatId: chats[0]!.id,
                companyId,
              }),
            )}
          )
          returning id::text
        `)[0]!.id;
      }),
    );
    const response = await postMessage({
      text: "Mine",
      locale: "en-US",
      market: "US",
      webSearchEnabled: false,
    });
    expect(response.status).toBe(409);
    expect(await body(response)).toMatchObject({
      conflictScope: "user",
      activeRun: { id: active },
    });
    expect((await getChat()).chat.id).toBe(chat.chat.id);
  });

  it("returns durable failed outcomes and immutable sources/citations after reload", async () => {
    const chat = await getChat();
    const answeredRunId = await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const user = yield* sql<{ id: string }>`
          insert into chat_messages (chat_id, author, content)
          values (${chat.chat.id}, 'user', 'failed') returning id::text
        `;
        const [chatRow] = yield* sql<{ readonly companyId: string }>`
          select company_id::text as "companyId" from chats where id = ${chat.chat.id}
        `;
        yield* sql`
          insert into ai_runs (
            chat_id, initiating_user_id, user_message_id, locale, market,
            acceptance_scope, failed_at, error_code, retryable
          ) values (
            ${chat.chat.id}, 'demo-user', ${user[0]!.id}, 'en-US', 'US',
            ${sql.json(
              makeRunAcceptanceScope({
                userId: "demo-user",
                chatId: chat.chat.id,
                companyId: chatRow!.companyId,
              }),
            )},
            now(), 'context_plan_unfit', true
          )
        `;
        const answeredUser = yield* sql<{ id: string }>`
          insert into chat_messages (chat_id, author, content)
          values (${chat.chat.id}, 'user', 'answered') returning id::text
        `;
        const run = yield* sql<{ id: string }>`
          insert into ai_runs (
            chat_id, initiating_user_id, user_message_id, locale, market, acceptance_scope,
            finished_at, citation_namespace
          )
          values (
            ${chat.chat.id}, 'demo-user', ${answeredUser[0]!.id}, 'en-US', 'US',
            ${sql.json(
              makeRunAcceptanceScope({
                userId: "demo-user",
                chatId: chat.chat.id,
                companyId: chatRow!.companyId,
              }),
            )},
            now(),
            ${"cn_" + "A".repeat(22)}
          ) returning id::text
        `;
        const assistant = yield* sql<{ id: string }>`
          insert into chat_messages (chat_id, author, content, assistant_ai_run_id)
          values (
            ${chat.chat.id}, 'assistant', 'Answer [[cite:k_cn_AAAAAAAAAAAAAAAAAAAAAA_1]]', ${run[0]!.id}
          ) returning id::text
        `;
        yield* sql`update ai_runs set assistant_message_id = ${assistant[0]!.id} where id = ${run[0]!.id}`;
        yield* sql`
          insert into assistant_message_sources (
            assistant_message_id, source_key, kind, locator, display_label, public_provenance
          ) values (
            ${assistant[0]!.id}, 'k_cn_AAAAAAAAAAAAAAAAAAAAAA_1', 'web',
            ${sql.json({ kind: "web", url: "https://example.com/", title: "Example", domain: "example.com", quote: "Quote", quoteHash: "60zevYK_EZRK8EDTD4qmiPv0yDb0bdjEFUrfQNwoasY", capturedAt: "2026-07-10T00:00:00.000Z" })},
            'Example', ${sql.json({ citationUrl: "https://example.com/" })}
          )
        `;
        yield* sql`
          insert into assistant_message_source_uses (
            assistant_message_id, source_key, consumer_task_id, rendered_token_count, context_order, ranges
          ) values (${assistant[0]!.id}, 'k_cn_AAAAAAAAAAAAAAAAAAAAAA_1', 'single-answer', 11, 0, '[]'::jsonb)
        `;
        yield* sql`
          insert into ai_run_events (run_id, seq, emission_key, event)
          values
            (${run[0]!.id}, 1, 'run_started', ${sql.json({ type: "run_started" })}),
            (${run[0]!.id}, 2, 'activity:request_understanding:all:complete:0', ${sql.json({
              type: "activity",
              stage: "understanding",
              code: "request_understanding",
              status: "complete",
              attempt: 1,
              durationMs: 120,
            })}),
            (${run[0]!.id}, 3, 'terminal', ${sql.json({ type: "done", assistantMessageId: assistant[0]!.id })})
        `;
        return run[0]!.id;
      }),
    );
    const response = await getChat();
    expect(response.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          run: expect.objectContaining({
            status: "failed",
            errorCode: "context_plan_unfit",
            retryable: true,
          }),
        }),
        expect.objectContaining({
          citations: [
            expect.objectContaining({
              sourceKey: "k_cn_AAAAAAAAAAAAAAAAAAAAAA_1",
              kind: "web",
              quote: { text: "Quote" },
            }),
          ],
          sourcesRead: [expect.objectContaining({ tokenCount: 11 })],
        }),
      ]),
    );
    const debugResponse = await route(
      request("GET", `/v1/ai-runs/${encodeURIComponent(answeredRunId)}/debug`),
    );
    expect(debugResponse.status).toBe(200);
    const debugBody = await body<{ available: boolean; debug?: Record<string, unknown> }>(
      debugResponse,
    );
    expect(debugBody).toMatchObject({
      available: true,
      debug: {
        runId: answeredRunId,
        sourceSummary: { read: 1, cited: 1, uncited: 0 },
        history: expect.arrayContaining([
          expect.objectContaining({ code: "request_understanding", status: "complete" }),
        ]),
      },
    });
    expect(JSON.stringify(debugBody)).not.toContain("Answer [[cite:");
    expect(JSON.stringify(debugBody)).not.toContain("https://example.com/");
  });

  it("keeps saved answers readable after source, subscription, memory, and web setting changes", async () => {
    const chat = await getChat();
    const sourceKey = "k_cn_AAAAAAAAAAAAAAAAAAAAAA_1";
    const memory = await seedMemory("Remember the original preference");
    const sourceId = `history-source-${crypto.randomUUID()}`;
    const subscriptionId = crypto.randomUUID();
    const accessId = crypto.randomUUID();
    const publisherCompanyId = crypto.randomUUID();
    await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const companyId = (yield* sql<{ readonly id: string }>`
          select company_id::text as id from chats where id = ${chat.chat.id}
        `)[0]!.id;
        const userMessage = (yield* sql<{ readonly id: string }>`
          insert into chat_messages (chat_id, author, content)
          values (${chat.chat.id}, 'user', 'Saved history fixture')
          returning id::text
        `)[0]!;
        const run = (yield* sql<{ readonly id: string }>`
          insert into ai_runs (
            chat_id, initiating_user_id, user_message_id, locale, market,
            acceptance_scope, finished_at, citation_namespace
          ) values (
            ${chat.chat.id}, 'demo-user', ${userMessage.id}, 'en-US', 'US',
            ${sql.json(
              makeRunAcceptanceScope({
                userId: "demo-user",
                chatId: chat.chat.id,
                companyId,
                memoryRevisionIds: [memory.revisionId],
              }),
            )},
            now(), ${"cn_" + "A".repeat(22)}
          )
          returning id::text
        `)[0]!;
        const assistant = (yield* sql<{ readonly id: string }>`
          insert into chat_messages (chat_id, author, content, assistant_ai_run_id)
          values (
            ${chat.chat.id}, 'assistant', ${`Saved answer [[cite:${sourceKey}]]`}, ${run.id}
          )
          returning id::text
        `)[0]!;
        yield* sql`
          update ai_runs set assistant_message_id = ${assistant.id} where id = ${run.id}
        `;
        yield* sql`
          insert into assistant_message_sources (
            assistant_message_id, source_key, kind, locator, memory_revision_id,
            display_label, public_provenance
          ) values (
            ${assistant.id}, ${sourceKey}, 'memory',
            ${sql.json({ kind: "memory", memoryId: memory.memoryId, memoryRevisionId: memory.revisionId })},
            ${memory.revisionId}, 'Saved preference', ${sql.json({})}
          )
        `;
        yield* sql`
          insert into assistant_message_source_uses (
            assistant_message_id, source_key, consumer_task_id,
            rendered_token_count, context_order, ranges
          ) values (${assistant.id}, ${sourceKey}, 'single-answer', 4, 0, '[]'::jsonb)
        `;
        yield* sql`
          insert into public_sources (
            source_id, display_name, publisher_name, description,
            ingestion_method, discovery_url, average_chars_per_item
          ) values (
            ${sourceId}, 'History source', 'History publisher', 'History fixture',
            'rss', ${`https://history.example/${sourceId}/feed`}, 100
          )
        `;
        yield* sql`
          insert into client_company_public_source_settings (
            client_company_id, source_id, enabled, updated_by_user_id
          ) values (${companyId}, ${sourceId}, true, 'demo-user')
        `;
        yield* sql`
          insert into publisher_companies (id, name)
          values (${publisherCompanyId}, 'History publisher')
        `;
        yield* sql`
          insert into publisher_subscriptions (
            id, publisher_company_id, name, created_by_user_id
          ) values (${subscriptionId}, ${publisherCompanyId}, 'History subscription', 'demo-user')
        `;
        yield* sql`
          insert into client_subscription_accesses (
            id, subscription_id, client_company_id, state, first_admin_email,
            accepted_at, subscribed_at, created_by_user_id
          ) values (
            ${accessId}, ${subscriptionId}, ${companyId}, 'active',
            'demo@example.test', now(), now(), 'demo-user'
          )
        `;
        yield* sql`
          insert into client_employee_subscription_grants (
            access_id, client_company_id, user_id, granted_by_user_id
          ) values (${accessId}, ${companyId}, 'demo-user', 'demo-user')
        `;
      }),
    );

    const before = await getChat();
    expect(before.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          content: expect.stringContaining("Saved answer"),
          citations: [
            expect.objectContaining({
              sourceKey,
              quote: { text: "Remember the original preference" },
            }),
          ],
        }),
      ]),
    );

    await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const companyId = (yield* sql<{ readonly id: string }>`
          select company_id::text as id from chats where id = ${chat.chat.id}
        `)[0]!.id;
        yield* sql`
          update client_company_public_source_settings
          set enabled = false, updated_by_user_id = 'demo-user'
          where client_company_id = ${companyId} and source_id = ${sourceId}
        `;
        yield* sql`
          update client_employee_subscription_grants
          set revoked_at = now(), revoked_by_user_id = 'demo-user'
          where access_id = ${accessId} and user_id = 'demo-user'
        `;
        yield* sql`
          update client_subscription_accesses
          set state = 'paused', delivery_end_at = now(), paused_at = now()
          where id = ${accessId}
        `;
        yield* sql`
          update client_company_ai_settings settings
          set web_search_enabled = false, web_domain_allowlist = array['changed.example']
          where settings.company_id = ${companyId}
        `;
        yield* sql`
          update user_memories
          set content = 'Changed preference', updated_at = now(), deleted_at = now()
          where id = ${memory.memoryId}
        `;
      }),
    );

    const after = await getChat();
    expect(after.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          content: expect.stringContaining("Saved answer"),
          citations: [
            expect.objectContaining({
              sourceKey,
              quote: { text: "Remember the original preference" },
            }),
          ],
        }),
      ]),
    );
    await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`delete from public_sources where source_id = ${sourceId}`;
      }),
    );
  });

  it("replays canonical SSE after the cursor and closes at terminal", async () => {
    const acceptedResponse = await postMessage({
      text: "Stream",
      locale: "en-US",
      market: "US",
      webSearchEnabled: false,
    });
    const accepted = await body<{ run: { id: string } }>(acceptedResponse);
    await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          insert into ai_run_events (run_id, seq, emission_key, event)
          values
            (${accepted.run.id}, 1, 'run_started', ${sql.json({ type: "run_started" })}),
            (${accepted.run.id}, 2, 'terminal', ${sql.json({ type: "error", code: "test_failure", retryable: true })})
        `;
      }),
    );
    const response = await route(
      request("GET", `/v1/ai-runs/${accepted.run.id}/stream?afterSeq=1`),
    );
    expect(response.status).toBe(200);
    expect(await readStream(response)).toBe(
      'id: 2\nevent: error\ndata: {"type":"error","code":"test_failure","retryable":true}\n\n',
    );
  });

  it("interrupts and awaits an in-flight SSE event poll on cancellation", async () => {
    const acceptedResponse = await postMessage({
      text: "Cancel an in-flight stream poll",
      locale: "en-US",
      market: "US",
      webSearchEnabled: false,
    });
    const accepted = await body<{ run: { id: string } }>(acceptedResponse);
    let signal!: AbortSignal;
    let signalPollStarted!: () => void;
    const pollStarted = new Promise<void>((resolve) => {
      signalPollStarted = resolve;
    });
    const poller: AiRunEventPoller = async (
      _userId,
      _organizationId,
      _runId,
      _afterSeq,
      _databaseLayer,
      pollSignal,
    ) => {
      signal = pollSignal!;
      signalPollStarted();
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return {
        authorized: false,
        events: [],
        terminal: false,
        replayableTerminal: false,
      };
    };
    const streamRoutes = makeChatRoutes(pgLayer(), { readAiRunEventsAfter: poller });
    const response = await Effect.runPromise(
      routeRequest(streamRoutes, request("GET", `/v1/ai-runs/${accepted.run.id}/stream`)).pipe(
        Effect.provide(configLayer),
      ),
    );
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    await pollStarted;
    const cancellation = reader.cancel("test cancellation");
    expect(signal.aborted).toBe(true);
    await expect(cancellation).resolves.toBeUndefined();
    reader.releaseLock();
  });

  it("keeps private SSE runs owner-only and permits current shared viewers", async () => {
    const viewerId = `stream-viewer-${crypto.randomUUID()}`;
    const ownerByName = {
      privateNoWeb: `stream-owner-private-no-web-${crypto.randomUUID()}`,
      privateWebBefore: `stream-owner-private-web-before-${crypto.randomUUID()}`,
      privateWebAfter: `stream-owner-private-web-after-${crypto.randomUUID()}`,
      sharedNoWeb: `stream-owner-shared-no-web-${crypto.randomUUID()}`,
      sharedWebBefore: `stream-owner-shared-web-before-${crypto.randomUUID()}`,
      sharedWebAfter: `stream-owner-shared-web-after-${crypto.randomUUID()}`,
    } as const;
    const privateNoWebChatId = crypto.randomUUID();
    const privateWebBeforeChatId = crypto.randomUUID();
    const privateWebAfterChatId = crypto.randomUUID();
    const sharedNoWebChatId = crypto.randomUUID();
    const sharedWebBeforeChatId = crypto.randomUUID();
    const sharedWebAfterChatId = crypto.randomUUID();
    const runIds = {
      privateNoWeb: crypto.randomUUID(),
      privateWebBefore: crypto.randomUUID(),
      privateWebAfter: crypto.randomUUID(),
      sharedNoWeb: crypto.randomUUID(),
      sharedWebBefore: crypto.randomUUID(),
      sharedWebAfter: crypto.randomUUID(),
    } as const;
    const eventText = {
      privateNoWeb: "PRIVATE_NO_WEB",
      privateWebBefore: "PRIVATE_WEB_BEFORE",
      privateWebAfter: "PRIVATE_WEB_AFTER",
      sharedNoWeb: "SHARED_NO_WEB",
      sharedWebBefore: "SHARED_WEB_BEFORE",
      sharedWebAfter: "SHARED_WEB_AFTER",
    } as const;
    const chat = await getChat();
    await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const companyId = (yield* sql<{ readonly id: string }>`
          select company_id::text as id from chats where id = ${chat.chat.id}
        `)[0]!.id;
        for (const userId of [viewerId, ...Object.values(ownerByName)]) {
          yield* sql`
            insert into platform_users (id, primary_email, display_name, clerk_user_id)
            values (${userId}, ${`${userId}@example.test`}, 'Stream fixture user', ${`clerk:${userId}`})
          `;
          yield* sql`
            insert into client_company_memberships (company_id, user_id, role)
            values (${companyId}, ${userId}, 'member')
          `;
        }
        yield* sql`
          insert into chats (id, user_id, company_id, memory_mode, shared_at)
          values
            (${privateNoWebChatId}, ${ownerByName.privateNoWeb}, ${companyId}, 'private_owner', null),
            (${privateWebBeforeChatId}, ${ownerByName.privateWebBefore}, ${companyId}, 'private_owner', null),
            (${privateWebAfterChatId}, ${ownerByName.privateWebAfter}, ${companyId}, 'private_owner', null),
            (${sharedNoWebChatId}, ${ownerByName.sharedNoWeb}, ${companyId}, 'disabled', now()),
            (${sharedWebBeforeChatId}, ${ownerByName.sharedWebBefore}, ${companyId}, 'disabled', now()),
            (${sharedWebAfterChatId}, ${ownerByName.sharedWebAfter}, ${companyId}, 'disabled', now())
        `;
        const cases = [
          ["privateNoWeb", privateNoWebChatId, false, false],
          ["privateWebBefore", privateWebBeforeChatId, true, false],
          ["privateWebAfter", privateWebAfterChatId, true, true],
          ["sharedNoWeb", sharedNoWebChatId, false, false],
          ["sharedWebBefore", sharedWebBeforeChatId, true, false],
          ["sharedWebAfter", sharedWebAfterChatId, true, true],
        ] as const;
        for (const [name, chatId, webSearchEnabled, exposed] of cases) {
          const runId = runIds[name];
          const messageId = crypto.randomUUID();
          yield* sql`
            insert into chat_messages (id, chat_id, author, content)
            values (${messageId}, ${chatId}, 'user', ${`authorization fixture ${name}`})
          `;
          yield* sql`
            insert into ai_runs (
              id, chat_id, initiating_user_id, user_message_id, locale, market,
              acceptance_scope
            ) values (
              ${runId}, ${chatId}, ${ownerByName[name]}, ${messageId}, 'en-US', 'US',
              ${sql.json(
                makeRunAcceptanceScope({
                  userId: ownerByName[name],
                  chatId,
                  companyId,
                  memoryMode: name.startsWith("shared") ? "disabled" : "private_owner",
                  webRequested: webSearchEnabled,
                  webEnabled: webSearchEnabled,
                }),
              )}
            )
          `;
          if (exposed) {
            yield* sql`
              insert into ai_source_exposures (
                run_id, task_id, loop_iteration, attempt, provider_request_index,
                source_kind, logical_source_identity, content_item_identity,
                exposure_stage, visible_token_count
              ) values (
                ${runId}, 'single-retrieve-web', 0, 0, 0, 'web',
                'https://example.com', 'https://example.com:authorization-proof',
                'web_fetch', 4
              )
            `;
          }
          yield* sql`
            insert into ai_run_events (run_id, seq, emission_key, event)
            values (
              ${runId}, 1, ${`authorization:${name}`},
              ${sql.json({ type: "text_delta", delta: eventText[name] })}
            )
          `;
        }
      }),
    );

    let streamUserId = viewerId;
    const streamAuthenticator: RequestAuthenticator = {
      authenticateRequest: async () => ({
        isAuthenticated: true,
        toAuth: () => ({
          userId: streamUserId,
          orgId: null,
          sessionId: `session:${streamUserId}`,
          factorVerificationAge: [0, 0],
        }),
      }),
    };
    const streamRoutes = makeChatRoutes(pgLayer(), { streamAuthenticator });
    const streamAs = (runId: string, userId = streamUserId) => {
      streamUserId = userId;
      return Effect.runPromise(
        routeRequest(streamRoutes, request("GET", `/v1/ai-runs/${runId}/stream`)).pipe(
          Effect.provide(clerkStreamConfigLayer),
        ),
      );
    };
    const readFirstChunk = async (response: Response): Promise<string> => {
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      try {
        const first = await reader.read();
        expect(first.done).toBe(false);
        return new TextDecoder().decode(first.value);
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    };
    const expectNotFoundWithoutLeak = async (runId: string, secret: string): Promise<void> => {
      const response = await streamAs(runId);
      expect(response.status).toBe(404);
      const payload = await body<{ readonly error: string }>(response);
      expect(payload).toEqual({ error: "not_found" });
      expect(JSON.stringify(payload)).not.toContain(secret);
    };

    await expectNotFoundWithoutLeak(runIds.privateNoWeb, eventText.privateNoWeb);
    await expectNotFoundWithoutLeak(runIds.privateWebBefore, eventText.privateWebBefore);
    await expectNotFoundWithoutLeak(runIds.privateWebAfter, eventText.privateWebAfter);

    for (const [name, secret] of Object.entries(eventText)) {
      if (name.startsWith("private")) continue;
      const chunk = await readFirstChunk(await streamAs(runIds[name as keyof typeof runIds]));
      expect(chunk).toContain(secret);
    }

    for (const [name, secret] of Object.entries(eventText)) {
      const key = name as keyof typeof runIds;
      streamUserId = ownerByName[key];
      const chunk = await readFirstChunk(await streamAs(runIds[key], ownerByName[key]));
      expect(chunk).toContain(secret);
    }

    await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update client_company_memberships
          set revoked_at = now(), revoked_by_user_id = ${viewerId}
          where user_id = ${viewerId}
            and company_id = (
              select company_id from chats where id = ${sharedNoWebChatId}
            )
        `;
      }),
    );
    streamUserId = viewerId;
    await expectNotFoundWithoutLeak(runIds.sharedNoWeb, eventText.sharedNoWeb);
  });

  it("denies unauthenticated, cross-company, and cross-chat stream viewers", async () => {
    const chat = await getChat();
    const acceptedResponse = await postMessage({
      text: "Stream boundary fixture",
      locale: "en-US",
      market: "US",
      webSearchEnabled: false,
    });
    const accepted = await body<{ run: { id: string } }>(acceptedResponse);
    const crossChatViewer = `stream-cross-chat-${crypto.randomUUID()}`;
    const crossCompanyViewer = `stream-cross-company-${crypto.randomUUID()}`;
    await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const companyId = (yield* sql<{ readonly id: string }>`
          select company_id::text as id from chats where id = ${chat.chat.id}
        `)[0]!.id;
        yield* sql`
          insert into platform_users (id, primary_email, display_name, clerk_user_id)
          values
            (${crossChatViewer}, ${`${crossChatViewer}@example.test`}, 'Cross chat viewer', ${`clerk:${crossChatViewer}`}),
            (${crossCompanyViewer}, ${`${crossCompanyViewer}@example.test`}, 'Cross company viewer', ${`clerk:${crossCompanyViewer}`})
        `;
        yield* sql`
          insert into client_company_memberships (company_id, user_id, role)
          values (${companyId}, ${crossChatViewer}, 'member')
        `;
        const otherCompany = (yield* sql<{ readonly id: string }>`
          insert into client_companies (name) values ('Stream other company') returning id::text
        `)[0]!;
        yield* sql`
          insert into client_company_memberships (company_id, user_id, role)
          values (${otherCompany.id}, ${crossCompanyViewer}, 'member')
        `;
        yield* sql`
          insert into client_company_ai_settings (company_id) values (${otherCompany.id})
        `;
        yield* sql`
          insert into ai_run_events (run_id, seq, emission_key, event)
          values (
            ${accepted.run.id}, 1, 'stream-boundary-fixture',
            ${sql.json({ type: "text_delta", delta: "STREAM_BOUNDARY_SECRET" })}
          )
        `;
      }),
    );

    let authMode: "unauthenticated" | "cross-company" | "cross-chat" = "unauthenticated";
    const streamAuthenticator: RequestAuthenticator = {
      authenticateRequest: async () => {
        if (authMode === "unauthenticated") {
          return { isAuthenticated: false, toAuth: () => null };
        }
        const userId = authMode === "cross-company" ? crossCompanyViewer : crossChatViewer;
        return {
          isAuthenticated: true,
          toAuth: () => ({
            userId,
            orgId: null,
            sessionId: `session:${userId}`,
            factorVerificationAge: [0, 0],
          }),
        };
      },
    };
    const streamRoutes = makeChatRoutes(pgLayer(), { streamAuthenticator });
    const stream = () =>
      Effect.runPromise(
        routeRequest(streamRoutes, request("GET", `/v1/ai-runs/${accepted.run.id}/stream`)).pipe(
          Effect.provide(clerkStreamConfigLayer),
        ),
      );
    const expectDenied = async (status: 401 | 404): Promise<void> => {
      const response = await stream();
      expect(response.status).toBe(status);
      expect(await body(response)).toEqual({
        error: status === 401 ? "unauthorized" : "not_found",
      });
    };

    await expectDenied(401);
    authMode = "cross-company";
    await expectDenied(404);
    authMode = "cross-chat";
    await expectDenied(404);
  });

  it("rejects a terminal stream after its replayable event ledger was pruned", async () => {
    const acceptedResponse = await postMessage({
      text: "Pruned stream",
      locale: "en-US",
      market: "US",
      webSearchEnabled: false,
    });
    const accepted = await body<{ run: { id: string } }>(acceptedResponse);
    await terminalRun(accepted.run.id);

    const response = await route(request("GET", `/v1/ai-runs/${accepted.run.id}/stream`));
    expect(response.status).toBe(410);
    expect(await body(response)).toEqual({ error: "terminal_event_unavailable" });
    const debugResponse = await route(
      request("GET", `/v1/ai-runs/${encodeURIComponent(accepted.run.id)}/debug`),
    );
    expect(debugResponse.status).toBe(200);
    expect(await body(debugResponse)).toEqual({ available: false });
  });

  it("keeps debug denials content-free across authentication, ownership, sharing, revocation, and organization boundaries", async () => {
    const chat = await getSharedChat();
    const runId = await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const companyId = (yield* sql<{ readonly id: string }>`
          select company_id::text as id from chats where id = ${chat.chat.id}
        `)[0]!.id;
        const message = (yield* sql<{ readonly id: string }>`
          insert into chat_messages (chat_id, author, content)
          values (${chat.chat.id}, 'user', 'debug boundary')
          returning id::text
        `)[0]!;
        return (yield* sql<{ readonly id: string }>`
          insert into ai_runs (
            chat_id, initiating_user_id, user_message_id, locale, market, acceptance_scope
          ) values (
            ${chat.chat.id}, 'demo-user', ${message.id}, 'en-US', 'US',
            ${sql.json(
              makeRunAcceptanceScope({
                userId: "demo-user",
                chatId: chat.chat.id,
                companyId,
                memoryMode: "disabled",
              }),
            )}
          )
          returning id::text
        `)[0]!.id;
      }),
    );

    const unauthenticated = await route(
      request("GET", `/v1/ai-runs/${encodeURIComponent(runId)}/debug`, {
        headers: { cookie: "" },
      }),
    );
    expect(unauthenticated.status).toBe(401);
    expect(await body(unauthenticated)).toEqual({ error: "unauthorized" });

    const owner = await route(request("GET", `/v1/ai-runs/${encodeURIComponent(runId)}/debug`));
    expect(owner.status).toBe(200);
    expect(await body(owner)).toMatchObject({ available: true });

    const viewerId = "debug-shared-viewer";
    const foreignId = "debug-foreign-user";
    await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const companyId = (yield* sql<{ readonly id: string }>`
          select company_id::text as id from chats where id = ${chat.chat.id}
        `)[0]!.id;
        yield* sql`
          insert into platform_users (id, primary_email, display_name, clerk_user_id)
          values (${foreignId}, ${`${foreignId}@example.test`}, 'Foreign viewer', ${`clerk:${foreignId}`})
        `;
        yield* sql`
          insert into platform_users (id, primary_email, display_name, clerk_user_id)
          values (${viewerId}, ${`${viewerId}@example.test`}, 'Debug viewer', ${`clerk:${viewerId}`})
        `;
        yield* sql`
          insert into client_company_memberships (company_id, user_id, role)
          values (${companyId}, ${viewerId}, 'member')
        `;
      }),
    );

    let debugUserId = foreignId;
    let organizationId: string | null = null;
    const debugAuthenticator: RequestAuthenticator = {
      authenticateRequest: async () => ({
        isAuthenticated: true,
        toAuth: () => ({
          userId: debugUserId,
          orgId: organizationId,
          sessionId: `session:${viewerId}`,
          factorVerificationAge: [0, 0],
        }),
      }),
    };
    const clerkRoutes = makeChatRoutes(pgLayer(), { debugAuthenticator });
    const debugAsViewer = () =>
      Effect.runPromise(
        routeRequest(
          clerkRoutes,
          new Request(`http://hartlib.test/v1/ai-runs/${encodeURIComponent(runId)}/debug`, {
            method: "GET",
          }),
        ).pipe(Effect.provide(clerkStreamConfigLayer)),
      );
    const foreignViewer = await debugAsViewer();
    expect(foreignViewer.status).toBe(404);
    expect(await body(foreignViewer)).toEqual({ error: "not_found" });

    debugUserId = viewerId;
    const sharedViewer = await debugAsViewer();
    expect(sharedViewer.status).toBe(404);
    expect(await body(sharedViewer)).toEqual({ error: "not_found" });

    await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update client_company_memberships
          set revoked_at = now(), revoked_by_user_id = 'demo-user'
          where user_id = ${viewerId}
        `;
      }),
    );
    const revokedViewer = await debugAsViewer();
    expect(revokedViewer.status).toBe(404);
    expect(await body(revokedViewer)).toEqual({ error: "not_found" });

    await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update client_company_memberships
          set revoked_at = null, revoked_by_user_id = null
          where user_id = ${viewerId}
        `;
      }),
    );
    organizationId = "org-wrong";
    const wrongOrganization = await debugAsViewer();
    expect(wrongOrganization.status).toBe(404);
    expect(await body(wrongOrganization)).toEqual({ error: "not_found" });
  });

  it("authorizes the chat owner debug projection only with current Clerk membership and organization", async () => {
    const chat = await getChat();
    const organizationId = `org_debug_owner_${crypto.randomUUID()}`;
    const runId = await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const companyId = (yield* sql<{ readonly id: string }>`
          select company_id::text as id from chats where id = ${chat.chat.id}
        `)[0]!.id;
        yield* sql`
          insert into platform_users (id, primary_email, display_name, clerk_user_id)
          values (
            'debug-owner-backup', 'debug-owner-backup@example.test',
            'Debug owner backup', 'clerk:debug-owner-backup'
          )
        `;
        yield* sql`
          insert into client_company_memberships (company_id, user_id, role)
          values (${companyId}, 'debug-owner-backup', 'admin')
        `;
        yield* sql`
          update client_companies
          set clerk_organization_id = ${organizationId}
          where id = ${companyId}
        `;
        const message = (yield* sql<{ readonly id: string }>`
          insert into chat_messages (chat_id, author, content)
          values (${chat.chat.id}, 'user', 'Clerk owner debug authorization')
          returning id::text
        `)[0]!;
        const runId = (yield* sql<{ readonly id: string }>`
          insert into ai_runs (
            chat_id, initiating_user_id, user_message_id, locale, market,
            acceptance_scope, started_at, failed_at, error_code, retryable
          ) values (
            ${chat.chat.id}, 'demo-user', ${message.id}, 'en-US', 'US',
            ${sql.json(
              makeRunAcceptanceScope({
                userId: "demo-user",
                chatId: chat.chat.id,
                companyId,
                memoryMode: "private_owner",
              }),
            )},
            now(), now(), 'provider_transport', true
          )
          returning id::text
        `)[0]!.id;
        yield* sql`
          insert into ai_run_events (run_id, seq, emission_key, event)
          values (
            ${runId}, 1, 'terminal',
            ${sql.json({ type: "error", code: "provider_transport", retryable: true })}
          )
        `;
        return runId;
      }),
    );

    let organization = organizationId;
    const ownerAuthenticator: RequestAuthenticator = {
      authenticateRequest: async () => ({
        isAuthenticated: true,
        toAuth: () => ({
          userId: "demo-user",
          orgId: organization,
          sessionId: "session:clerk-owner",
          factorVerificationAge: [0, 0],
        }),
      }),
    };
    const ownerDebug = () =>
      Effect.runPromise(
        routeRequest(
          makeChatRoutes(pgLayer(), { debugAuthenticator: ownerAuthenticator }),
          new Request(`http://hartlib.test/v1/ai-runs/${encodeURIComponent(runId)}/debug`, {
            method: "GET",
          }),
        ).pipe(Effect.provide(clerkStreamConfigLayer)),
      );

    const authorized = await ownerDebug();
    expect(authorized.status).toBe(200);
    expect(await body(authorized)).toMatchObject({ available: true });

    await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update client_company_memberships
          set revoked_at = now(), revoked_by_user_id = 'demo-user'
          where company_id = (select company_id from chats where id = ${chat.chat.id})
            and user_id = 'demo-user'
        `;
      }),
    );
    const revokedMembership = await ownerDebug();
    expect(revokedMembership.status).toBe(404);
    expect(await body(revokedMembership)).toEqual({ error: "not_found" });

    await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update client_company_memberships
          set revoked_at = null, revoked_by_user_id = null
          where company_id = (select company_id from chats where id = ${chat.chat.id})
            and user_id = 'demo-user'
        `;
      }),
    );
    organization = `org_wrong_${crypto.randomUUID()}`;
    const wrongOrganization = await ownerDebug();
    expect(wrongOrganization.status).toBe(404);
    expect(await body(wrongOrganization)).toEqual({ error: "not_found" });
  });

  it("returns a content-free publisher quote for restricted, deleted, nonrecipient, and shared viewers", async () => {
    const chat = await getSharedChat();
    const sourceKey = `k_${"cn_" + "B".repeat(22)}_1`;
    const deletedSourceKey = `k_${"cn_" + "B".repeat(22)}_2`;
    const publisherCompanyId = crypto.randomUUID();
    const subscriptionId = crypto.randomUUID();
    const accessId = crypto.randomUUID();
    const issueId = crypto.randomUUID();
    const documentId = crypto.randomUUID();
    const snapshotId = crypto.randomUUID();
    const extractionJobId = crypto.randomUUID();
    const extractionId = crypto.randomUUID();
    const deletedDocumentId = crypto.randomUUID();
    const deletedSnapshotId = crypto.randomUUID();
    const deletedExtractionJobId = crypto.randomUUID();
    const deletedExtractionId = crypto.randomUUID();
    const documentText = "Publisher-only secret evidence";
    const deletedDocumentText = "Deleted publisher-only evidence";
    const contentHash = createHash("sha256").update(documentText, "utf8").digest("hex");
    const deletedContentHash = createHash("sha256")
      .update(deletedDocumentText, "utf8")
      .digest("hex");
    const citationUrl = `/v1/issues/${issueId}/documents/${documentId}/content`;
    const ranges = [{ pageNumber: 1, charStart: 0, charEnd: documentText.length }] as const;
    const sourceRanges = [{ charStart: 0, charEnd: documentText.length }] as const;
    const deletedRanges = [
      { pageNumber: 1, charStart: 0, charEnd: deletedDocumentText.length },
    ] as const;
    const deletedSourceRanges = [{ charStart: 0, charEnd: deletedDocumentText.length }] as const;
    const companyId = await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{ readonly id: string }>`
          select company_id::text as id from chats where id = ${chat.chat.id}
        `)[0]!.id;
      }),
    );
    await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const userMessage = (yield* sql<{ readonly id: string }>`
          insert into chat_messages (chat_id, author, content)
          values (${chat.chat.id}, 'user', 'Publisher quote authorization fixture')
          returning id::text
        `)[0]!;
        yield* sql`
          insert into publisher_companies (id, name)
          values (${publisherCompanyId}, 'Quote publisher')
        `;
        yield* sql`
          insert into publisher_subscriptions (
            id, publisher_company_id, name, created_by_user_id
          ) values (${subscriptionId}, ${publisherCompanyId}, 'Quote subscription', 'demo-user')
        `;
        yield* sql`
          insert into publisher_company_memberships (
            publisher_company_id, user_id, role, accepted_at
          ) values (${publisherCompanyId}, 'demo-user', 'admin', now())
        `;
        yield* sql`
          insert into client_subscription_accesses (
            id, subscription_id, client_company_id, state, first_admin_email,
            accepted_at, subscribed_at, created_by_user_id
          ) values (
            ${accessId}, ${subscriptionId}, ${companyId}, 'active',
            'demo@example.test', now(), now(), 'demo-user'
          )
        `;
        yield* sql`
          insert into client_employee_subscription_grants (
            access_id, client_company_id, user_id, granted_by_user_id
          ) values (${accessId}, ${companyId}, 'demo-user', 'demo-user')
        `;
        yield* sql`
          insert into chat_subscription_sources (
            chat_id, access_id, client_company_id, subscription_id
          ) values (${chat.chat.id}, ${accessId}, ${companyId}, ${subscriptionId})
        `;
        const run = (yield* sql<{ readonly id: string }>`
          insert into ai_runs (
            chat_id, initiating_user_id, user_message_id, locale, market,
            citation_namespace, acceptance_scope, finished_at
          ) values (
            ${chat.chat.id}, 'demo-user', ${userMessage.id}, 'en-US', 'US',
            ${"cn_" + "B".repeat(22)},
            ${sql.json(
              makeRunAcceptanceScope({
                userId: "demo-user",
                chatId: chat.chat.id,
                companyId,
                subscriptionIds: [subscriptionId],
                accessIds: [accessId],
                memoryMode: "disabled",
              }),
            )},
            now()
          )
          returning id::text
        `)[0]!;
        const assistant = (yield* sql<{ readonly id: string }>`
          insert into chat_messages (chat_id, author, content, assistant_ai_run_id)
          values (
            ${chat.chat.id}, 'assistant',
            ${`Publisher answer [[cite:${sourceKey},${deletedSourceKey}]]`}, ${run.id}
          )
          returning id::text
        `)[0]!;
        yield* sql`
          update ai_runs set assistant_message_id = ${assistant.id} where id = ${run.id}
        `;
        yield* sql`
          insert into publisher_issues (
            id, subscription_id, title, status, created_by_user_id
          ) values (${issueId}, ${subscriptionId}, 'Quote issue', 'draft', 'demo-user')
        `;
        yield* sql`
          insert into hartlib_documents (
            id, issue_id, title, original_file_name, object_key, media_type,
            byte_size, sha256_hex, upload_completed_at, created_by_user_id, language
          ) values (
            ${documentId}, ${issueId}, 'Quote document', 'quote.pdf',
            ${`quote/${documentId}.pdf`}, 'application/pdf', 1, ${"a".repeat(64)},
            now(), 'demo-user', 'en-US'
          )
        `;
        yield* sql`
          insert into jobs (id, kind, payload)
          values (${extractionJobId}, 'extract_pdf_text', '{}'::jsonb)
        `;
        yield* sql`
          insert into hartlib_document_extractions (
            id, hartlib_document_id, input_sha256_hex, pages,
            extracted_char_count, created_by_job_id
          ) values (
            ${extractionId}, ${documentId}, ${"a".repeat(64)},
            ${JSON.stringify([{ pageNumber: 1, text: documentText }])}::jsonb,
            ${documentText.length}, ${extractionJobId}
          )
        `;
        yield* sql`
          insert into hartlib_document_versions (
            id, hartlib_document_id, publisher_extraction_id, content_hash,
            language, canonical_text, text_char_count, page_ranges
          ) values (
            ${snapshotId}, ${documentId}, ${extractionId}, ${contentHash},
            'en-US', ${documentText}, ${documentText.length},
            ${JSON.stringify(ranges)}::jsonb
          )
        `;
        yield* sql`
          update hartlib_documents set current_version_id = ${snapshotId} where id = ${documentId}
        `;
        yield* sql`
          insert into hartlib_documents (
            id, issue_id, title, original_file_name, object_key, media_type,
            byte_size, sha256_hex, upload_completed_at, deleted_at, deleted_by_user_id,
            purge_after, created_by_user_id, language
          ) values (
            ${deletedDocumentId}, ${issueId}, 'Deleted quote document', 'deleted-quote.pdf',
            ${`quote/${deletedDocumentId}.pdf`}, 'application/pdf', 1, ${"b".repeat(64)},
            now(), now(), 'demo-user', now() + interval '30 days', 'demo-user', 'en-US'
          )
        `;
        yield* sql`
          insert into jobs (id, kind, payload)
          values (${deletedExtractionJobId}, 'extract_pdf_text', '{}'::jsonb)
        `;
        yield* sql`
          insert into hartlib_document_extractions (
            id, hartlib_document_id, input_sha256_hex, pages,
            extracted_char_count, created_by_job_id
          ) values (
            ${deletedExtractionId}, ${deletedDocumentId}, ${"b".repeat(64)},
            ${JSON.stringify([{ pageNumber: 1, text: deletedDocumentText }])}::jsonb,
            ${deletedDocumentText.length}, ${deletedExtractionJobId}
          )
        `;
        yield* sql`
          insert into hartlib_document_versions (
            id, hartlib_document_id, publisher_extraction_id, content_hash,
            language, canonical_text, text_char_count, page_ranges
          ) values (
            ${deletedSnapshotId}, ${deletedDocumentId}, ${deletedExtractionId}, ${deletedContentHash},
            'en-US', ${deletedDocumentText}, ${deletedDocumentText.length},
            ${JSON.stringify(deletedRanges)}::jsonb
          )
        `;
        yield* sql`
          update hartlib_documents
          set current_version_id = ${deletedSnapshotId}
          where id = ${deletedDocumentId}
        `;
        yield* sql`
          update publisher_issues
          set status = 'published', publication_at = now(), published_at = now()
          where id = ${issueId}
        `;
        yield* sql`
          insert into issue_deliveries (
            issue_id, subscription_id, access_id, client_company_id, historical
          ) values (${issueId}, ${subscriptionId}, ${accessId}, ${companyId}, false)
        `;
        yield* sql`
          insert into assistant_message_sources (
            assistant_message_id, source_key, kind, locator,
            snapshot_id, publisher_extraction_id, document_source_id, document_id,
            content_hash, display_label, public_provenance
          ) values (
            ${assistant.id}, ${sourceKey}, 'document',
            ${sql.json({
              kind: "document",
              sourceId: `publisher:${subscriptionId}`,
              documentId,
              snapshotId,
              contentHash,
              ranges: sourceRanges,
              publisherIssueId: issueId,
              publisherDocumentId: documentId,
              publisherExtractionId: extractionId,
            })},
            ${snapshotId}, ${extractionId}, ${`publisher:${subscriptionId}`}, ${documentId},
            ${contentHash}, 'Quote document', ${sql.json({
              sourceName: "Quote publisher",
              issueTitle: "Quote issue",
              documentTitle: "Quote document",
              citationUrl,
              publishedAt: "2026-08-22T00:00:00.000Z",
            })}
          )
        `;
        yield* sql`
          insert into assistant_message_source_uses (
            assistant_message_id, source_key, consumer_task_id, topic_id,
            rendered_token_count, context_order, ranges
          ) values (
            ${assistant.id}, ${sourceKey}, 'single-answer', null, 8, 0,
            ${JSON.stringify(sourceRanges)}::jsonb
          )
        `;
        yield* sql`
          insert into assistant_message_sources (
            assistant_message_id, source_key, kind, locator,
            snapshot_id, publisher_extraction_id, document_source_id, document_id,
            content_hash, display_label, public_provenance
          ) values (
            ${assistant.id}, ${deletedSourceKey}, 'document',
            ${sql.json({
              kind: "document",
              sourceId: `publisher:${subscriptionId}`,
              documentId: deletedDocumentId,
              snapshotId: deletedSnapshotId,
              contentHash: deletedContentHash,
              ranges: deletedSourceRanges,
              publisherIssueId: issueId,
              publisherDocumentId: deletedDocumentId,
              publisherExtractionId: deletedExtractionId,
            })},
            ${deletedSnapshotId}, ${deletedExtractionId}, ${`publisher:${subscriptionId}`},
            ${deletedDocumentId}, ${deletedContentHash}, 'Deleted quote document', ${sql.json({
              sourceName: "Quote publisher",
              issueTitle: "Quote issue",
              documentTitle: "Deleted quote document",
              citationUrl: `/v1/issues/${issueId}/documents/${deletedDocumentId}/content`,
              publishedAt: "2026-08-22T00:00:00.000Z",
            })}
          )
        `;
        yield* sql`
          insert into assistant_message_source_uses (
            assistant_message_id, source_key, consumer_task_id, topic_id,
            rendered_token_count, context_order, ranges
          ) values (
            ${assistant.id}, ${deletedSourceKey}, 'single-answer', null, 8, 1,
            ${JSON.stringify(deletedSourceRanges)}::jsonb
          )
        `;
      }),
    );

    const readOwner = async () => {
      const response = await route(request("GET", `/v1/chats/${chat.chat.id}`));
      expect(response.status).toBe(200);
      return body<{ messages: readonly Record<string, unknown>[] }>(response);
    };
    const assertQuote = async (expected: { readonly text: string } | null) => {
      const payload = await readOwner();
      const assistant = payload.messages.find((message) => message.author === "assistant");
      expect(assistant).toBeDefined();
      const citation = (assistant?.citations as readonly Record<string, unknown>[]).find(
        (item) => item.sourceKey === sourceKey,
      );
      expect(citation).toEqual(expect.objectContaining({ sourceKey, quote: expected }));
      if (expected === null) expect(JSON.stringify(payload)).not.toContain(documentText);
    };
    const assertDeletedQuote = async () => {
      const payload = await readOwner();
      const assistant = payload.messages.find((message) => message.author === "assistant");
      const citation = (assistant?.citations as readonly Record<string, unknown>[]).find(
        (item) => item.sourceKey === deletedSourceKey,
      );
      expect(citation).toEqual(
        expect.objectContaining({ sourceKey: deletedSourceKey, quote: null }),
      );
      expect(JSON.stringify(payload)).not.toContain(deletedDocumentText);
    };

    await assertQuote({ text: documentText });
    await assertDeletedQuote();
    await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update publisher_issues
          set restricted_at = now(), restricted_by_user_id = 'demo-user', restricted_reason = 'test'
          where id = ${issueId}
        `;
      }),
    );
    await assertQuote(null);
    await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update publisher_issues
          set restricted_at = null, restricted_by_user_id = null, restricted_reason = null
          where id = ${issueId}
        `;
      }),
    );
    await assertQuote({ text: documentText });
    await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          insert into platform_users (id, primary_email, display_name, clerk_user_id)
          values
            ('publisher-nonrecipient', 'publisher-nonrecipient@example.test', 'Publisher nonrecipient', 'clerk:publisher-nonrecipient'),
            ('publisher-shared-viewer', 'publisher-shared-viewer@example.test', 'Publisher viewer', 'clerk:publisher-shared-viewer')
        `;
        yield* sql`
          insert into client_company_memberships (company_id, user_id, role)
          values
            (${companyId}, 'publisher-nonrecipient', 'member'),
            (${companyId}, 'publisher-shared-viewer', 'member')
        `;
      }),
    );
    let readUserId = "publisher-nonrecipient";
    const readAuthenticator: RequestAuthenticator = {
      authenticateRequest: async () => ({
        isAuthenticated: true,
        toAuth: () => ({
          userId: readUserId,
          orgId: null,
          sessionId: `session:${readUserId}`,
          factorVerificationAge: [0, 0],
        }),
      }),
    };
    const nonrecipientResponse = await Effect.runPromise(
      routeRequest(
        makeChatRoutes(pgLayer(), { readAuthenticator }),
        new Request(`http://hartlib.test/v1/chats/${chat.chat.id}`, { method: "GET" }),
      ).pipe(Effect.provide(clerkStreamConfigLayer)),
    );
    expect(nonrecipientResponse.status).toBe(200);
    const nonrecipientPayload = await body<{ messages: readonly Record<string, unknown>[] }>(
      nonrecipientResponse,
    );
    const nonrecipientAssistant = nonrecipientPayload.messages.find(
      (message) => message.author === "assistant",
    );
    const nonrecipientCitation = (
      nonrecipientAssistant?.citations as readonly Record<string, unknown>[]
    ).find((item) => item.sourceKey === sourceKey);
    expect(nonrecipientCitation).toEqual(expect.objectContaining({ sourceKey, quote: null }));
    expect(JSON.stringify(nonrecipientPayload)).not.toContain(documentText);

    readUserId = "publisher-shared-viewer";
    const sharedViewerResponse = await Effect.runPromise(
      routeRequest(
        makeChatRoutes(pgLayer(), { readAuthenticator }),
        new Request(`http://hartlib.test/v1/chats/${chat.chat.id}`, { method: "GET" }),
      ).pipe(Effect.provide(clerkStreamConfigLayer)),
    );
    expect(sharedViewerResponse.status).toBe(200);
    const sharedViewerPayload = await body<{ messages: readonly Record<string, unknown>[] }>(
      sharedViewerResponse,
    );
    const sharedAssistant = sharedViewerPayload.messages.find(
      (message) => message.author === "assistant",
    );
    const sharedCitation = (sharedAssistant?.citations as readonly Record<string, unknown>[]).find(
      (item) => item.sourceKey === sourceKey,
    );
    expect(sharedCitation).toEqual(expect.objectContaining({ sourceKey, quote: null }));
    expect(JSON.stringify(sharedViewerPayload)).not.toContain(documentText);
  });

  it("nulls an authorized public quote after its source setting is revoked without a leak", async () => {
    const chat = await getChat();
    const sourceId = `quote-public-source-${crypto.randomUUID()}`;
    const documentId = `quote-public-document-${crypto.randomUUID()}`;
    const artifactId = crypto.randomUUID();
    const sourceKey = `k_${"cn_" + "Q".repeat(22)}_1`;
    const canonicalUrl = `https://example.test/public/${documentId}`;
    const documentText =
      "Authorized public quote evidence: the source setting permits this exact passage. ".repeat(3);
    const contentHash = createHash("sha256").update(documentText, "utf8").digest("hex");
    const ranges = [{ charStart: 0, charEnd: documentText.length }] as const;
    const companyId = await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{ readonly id: string }>`
          select company_id::text as id from chats where id = ${chat.chat.id}
        `)[0]!.id;
      }),
    );

    await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          insert into public_sources (
            source_id, display_name, publisher_name, description, ingestion_method,
            discovery_url, average_chars_per_item
          ) values (
            ${sourceId}, 'Public quote source', 'Public publisher', 'Quote authorization fixture',
            'rss', ${`${canonicalUrl}/feed`}, 1000
          )
        `;
        const bodyText = `<main>${documentText}</main>`;
        yield* sql`
          insert into public_source_raw_artifacts (
            id, source_id, canonical_url, fetched_at, media_type, body, body_hash
          ) values (
            ${artifactId}, ${sourceId}, ${canonicalUrl}, now(), 'text/html',
            ${bodyText}, encode(digest(convert_to(${bodyText}, 'UTF8'), 'sha256'), 'hex')
          )
        `;
        yield* sql`
          insert into public_source_documents (
            document_id, source_id, raw_artifact_id, canonical_url, title, text, language,
            discovered_at, fetched_at, document_type, content_hash, text_char_count
          ) values (
            ${documentId}, ${sourceId}, ${artifactId}, ${canonicalUrl}, 'Public quote document',
            ${documentText}, 'en-US', now(), now(), 'publication', ${contentHash}, ${documentText.length}
          )
        `;
        yield* sql`
          insert into public_source_items (
            source_id, canonical_url, external_id, title, published_at, discovered_at,
            current_content_hash, latest_document_id, latest_raw_artifact_id,
            last_fetched_at, last_successful_fetch_at
          ) values (
            ${sourceId}, ${canonicalUrl}, ${documentId}, 'Public quote document', now(), now(),
            ${contentHash}, ${documentId}, ${artifactId}, now(), now()
          )
        `;
        yield* sql`
          insert into client_company_public_source_settings (
            client_company_id, source_id, enabled, updated_by_user_id
          ) values (${companyId}, ${sourceId}, true, 'demo-user')
        `;
        const userMessage = (yield* sql<{ readonly id: string }>`
          insert into chat_messages (chat_id, author, content)
          values (${chat.chat.id}, 'user', 'Read the public quote')
          returning id::text
        `)[0]!;
        const run = (yield* sql<{ readonly id: string }>`
          insert into ai_runs (
            chat_id, initiating_user_id, user_message_id, locale, market,
            citation_namespace, acceptance_scope, started_at, finished_at
          ) values (
            ${chat.chat.id}, 'demo-user', ${userMessage.id}, 'en-US', 'US',
            ${"cn_" + "Q".repeat(22)},
            ${sql.json(
              makeRunAcceptanceScope({
                userId: "demo-user",
                chatId: chat.chat.id,
                companyId,
                publicSourceIds: [sourceId],
                memoryMode: "private_owner",
              }),
            )},
            now(), now()
          )
          returning id::text
        `)[0]!;
        const assistant = (yield* sql<{ readonly id: string }>`
          insert into chat_messages (chat_id, author, content, assistant_ai_run_id)
          values (
            ${chat.chat.id}, 'assistant', ${`Authorized public quote [[cite:${sourceKey}]]`},
            ${run.id}
          )
          returning id::text
        `)[0]!;
        yield* sql`
          update ai_runs set assistant_message_id = ${assistant.id} where id = ${run.id}
        `;
        yield* sql`
          insert into assistant_message_sources (
            assistant_message_id, source_key, kind, locator,
            snapshot_id, document_source_id, document_id, content_hash,
            display_label, public_provenance
          ) values (
            ${assistant.id}, ${sourceKey}, 'document',
            ${sql.json({
              kind: "document",
              sourceId: `public:${sourceId}`,
              documentId,
              snapshotId: documentId,
              contentHash,
              ranges,
            })},
            ${documentId}, ${`public:${sourceId}`}, ${documentId}, ${contentHash},
            'Public quote document', ${sql.json({
              sourceName: "Public quote source",
              issueTitle: "Public quote issue",
              documentTitle: "Public quote document",
              citationUrl: canonicalUrl,
              publishedAt: "2026-08-22T00:00:00.000Z",
            })}
          )
        `;
        yield* sql`
          insert into assistant_message_source_uses (
            assistant_message_id, source_key, consumer_task_id, topic_id,
            rendered_token_count, context_order, ranges
          ) values (
            ${assistant.id}, ${sourceKey}, 'single-answer', null, 12, 0,
            ${JSON.stringify(ranges)}::jsonb
          )
        `;
      }),
    );

    const readOwner = async () => {
      const response = await route(request("GET", `/v1/chats/${chat.chat.id}`));
      expect(response.status).toBe(200);
      return body<{ messages: readonly Record<string, unknown>[] }>(response);
    };
    const readCitation = async () => {
      const payload = await readOwner();
      const assistant = payload.messages.find((message) => message.author === "assistant");
      const citation = (assistant?.citations as readonly Record<string, unknown>[]).find(
        (item) => item.sourceKey === sourceKey,
      );
      expect(citation).toBeDefined();
      return { payload, citation: citation! };
    };

    const authorized = await readCitation();
    expect(authorized.citation).toEqual(
      expect.objectContaining({ sourceKey, quote: { text: documentText } }),
    );

    await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update client_company_public_source_settings
          set enabled = false, updated_at = now()
          where client_company_id = ${companyId} and source_id = ${sourceId}
        `;
      }),
    );
    const revoked = await readCitation();
    expect(revoked.citation).toEqual(expect.objectContaining({ sourceKey, quote: null }));
    const serialized = JSON.stringify(revoked.payload);
    expect(serialized).not.toContain(documentText);
    expect(serialized).not.toContain("source setting permits");
    expect(serialized).not.toContain("not authorized");
  });

  it.each([
    ["root excess field", { type: "error", code: "test_failure", retryable: true, forged: true }],
    [
      "nested excess field",
      {
        type: "context_ready",
        mode: "single",
        compactionRan: false,
        sourcesRead: [],
        consumers: [
          {
            consumer: "direct",
            inputTokens: 1,
            requestedOutputTokens: 1,
            usableInputTokens: 1,
            forged: true,
          },
        ],
      },
    ],
  ])("fails the SSE stream closed for a persisted %s", async (_label, event) => {
    const acceptedResponse = await postMessage({
      text: "Malformed stream event",
      locale: "en-US",
      market: "US",
      webSearchEnabled: false,
    });
    const accepted = await body<{ run: { id: string } }>(acceptedResponse);
    await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          insert into ai_run_events (run_id, seq, emission_key, event)
          values (${accepted.run.id}, 1, 'malformed', ${sql.json(event)})
        `;
      }),
    );
    const response = await route(request("GET", `/v1/ai-runs/${accepted.run.id}/stream`));
    expect(response.status).toBe(200);
    await expect(readStream(response)).rejects.toThrow();
  });

  it("keeps a cited immutable memory revision authorized when finalization advances its head", async () => {
    const acceptedResponse = await postMessage({
      text: "Update remembered preference",
      locale: "en-US",
      market: "US",
      webSearchEnabled: false,
    });
    const accepted = await body<{ run: { id: string } }>(acceptedResponse);
    const memoryId = crypto.randomUUID();
    const citedRevisionId = crypto.randomUUID();
    const updatedRevisionId = crypto.randomUUID();
    await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              insert into user_memories (
                id, user_id, kind, content, head_revision_id
              ) values (
                ${memoryId}, 'demo-user', 'preference', 'Prefers concise answers',
                ${citedRevisionId}
              )
            `;
            yield* sql`
              insert into user_memory_revisions (
                id, memory_id, action, state_before, state_after, run_id
              ) values
              (
                ${citedRevisionId}, ${memoryId}, 'create', null,
                ${sql.json({
                  kind: "preference",
                  content: "Prefers concise answers",
                  deleted: false,
                })}, null
              ),
              (
                ${updatedRevisionId}, ${memoryId}, 'update',
                ${sql.json({
                  kind: "preference",
                  content: "Prefers concise answers",
                  deleted: false,
                })},
                ${sql.json({
                  kind: "preference",
                  content: "Prefers very concise answers",
                  deleted: false,
                })}, ${accepted.run.id}
              )
            `;
            yield* sql`
              update user_memories
              set head_revision_id = ${updatedRevisionId},
                  content = 'Prefers very concise answers', updated_at = now()
              where id = ${memoryId}
            `;
            yield* sql`
              insert into ai_source_exposures (
                run_id, task_id, loop_iteration, attempt, provider_request_index,
                source_kind, logical_source_identity, content_item_identity,
                exposure_stage, visible_token_count
              ) values (
                ${accepted.run.id}, 'single-answer', 0, 0, 0,
                'memory', ${`memory:${memoryId}`}, ${citedRevisionId}, 'answer', 8
              )
            `;
            yield* sql`
              insert into ai_run_events (run_id, seq, emission_key, event)
              values
                (
                  ${accepted.run.id}, 1, 'text_delta:memory:0:0',
                  ${sql.json({ type: "text_delta", delta: "Memory-backed answer" })}
                ),
                (
                  ${accepted.run.id}, 2, 'memory_updated',
                  ${sql.json({
                    type: "memory_updated",
                    created: 0,
                    updated: 1,
                    discarded: 0,
                  })}
                ),
                (
                  ${accepted.run.id}, 3, 'terminal',
                  ${sql.json({ type: "done", assistantMessageId: crypto.randomUUID() })}
                )
            `;
          }),
        );
      }),
    );
    const response = await route(request("GET", `/v1/ai-runs/${accepted.run.id}/stream`));
    expect(response.status).toBe(200);
    const stream = await readStream(response);
    expect(stream).toContain("Memory-backed answer");
    expect(stream).toContain("event: memory_updated");
    expect(stream).toContain("event: done");
  });

  it("keeps an open SSE stream after source access revocation", async () => {
    const chat = await getChat();
    const acceptedResponse = await postMessage({
      text: "Stream with revocation",
      locale: "en-US",
      market: "US",
      webSearchEnabled: false,
    });
    const accepted = await body<{ run: { id: string } }>(acceptedResponse);
    const accessId = await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const company = (yield* sql<{ readonly id: string }>`
            select company_id::text as id from chats where id = ${chat.chat.id}
          `)[0]!;
        const publisherCompanyId = crypto.randomUUID();
        const subscriptionId = crypto.randomUUID();
        const accessId = crypto.randomUUID();
        yield* sql`
          insert into publisher_companies (id, name)
          values (${publisherCompanyId}, 'SSE publisher')
        `;
        yield* sql`
          insert into publisher_subscriptions (
            id, publisher_company_id, name, created_by_user_id
          ) values (${subscriptionId}, ${publisherCompanyId}, 'SSE source', 'demo-user')
        `;
        yield* sql`
          insert into client_subscription_accesses (
            id, subscription_id, client_company_id, state, first_admin_email,
            accepted_at, subscribed_at, created_by_user_id
          ) values (
            ${accessId}, ${subscriptionId}, ${company.id}, 'active',
            'demo@example.test', now(), now(), 'demo-user'
          )
        `;
        yield* sql`
          insert into client_employee_subscription_grants (
            access_id, client_company_id, user_id, granted_by_user_id
          ) values (${accessId}, ${company.id}, 'demo-user', 'demo-user')
        `;
        yield* sql`
          insert into chat_subscription_sources (
            chat_id, access_id, client_company_id, subscription_id
          ) values (${chat.chat.id}, ${accessId}, ${company.id}, ${subscriptionId})
        `;
        yield* sql`
          insert into ai_run_events (run_id, seq, emission_key, event)
          values (
            ${accepted.run.id}, 1, 'text_delta:before:0:0',
            ${sql.json({ type: "text_delta", delta: "AUTHORIZED_BEFORE" })}
          )
        `;
        return accessId;
      }),
    );
    const response = await route(request("GET", `/v1/ai-runs/${accepted.run.id}/stream`));
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    await expect(readStreamUntil(reader, "AUTHORIZED_BEFORE")).resolves.toContain(
      "AUTHORIZED_BEFORE",
    );

    await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update client_employee_subscription_grants
          set revoked_at = now(), revoked_by_user_id = 'demo-user'
          where access_id = ${accessId} and user_id = 'demo-user'
        `;
        yield* sql`
          insert into ai_run_events (run_id, seq, emission_key, event)
          values (
            ${accepted.run.id}, 2, 'text_delta:after:0:0',
            ${sql.json({ type: "text_delta", delta: "FORBIDDEN_AFTER" })}
          )
        `;
      }),
    );
    await expect(readStreamUntil(reader, "FORBIDDEN_AFTER")).resolves.toContain("FORBIDDEN_AFTER");
    await reader.cancel();
  });

  it("closes an open Clerk-organization stream before events after an organization rebind", async () => {
    const chat = await getChat();
    const acceptedResponse = await postMessage({
      text: "Stream under an active Clerk organization",
      locale: "en-US",
      market: "US",
      webSearchEnabled: false,
    });
    const accepted = await body<{ run: { id: string } }>(acceptedResponse);
    const activeOrganizationId = `org_stream_${crypto.randomUUID()}`;
    await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update client_companies
          set clerk_organization_id = ${activeOrganizationId}
          where id = (select company_id from chats where id = ${chat.chat.id})
        `;
        yield* sql`
          insert into ai_run_events (run_id, seq, emission_key, event)
          values (
            ${accepted.run.id}, 1, 'text_delta:org-before:0:0',
            ${sql.json({ type: "text_delta", delta: "ORG_AUTHORIZED_BEFORE" })}
          )
        `;
      }),
    );

    const streamAuthenticator: RequestAuthenticator = {
      authenticateRequest: async () => ({
        isAuthenticated: true,
        toAuth: () => ({
          userId: "demo-user",
          orgId: activeOrganizationId,
          sessionId: "session:org-stream",
          factorVerificationAge: [0, 0],
        }),
      }),
    };
    const response = await Effect.runPromise(
      routeRequest(
        makeChatRoutes(pgLayer(), { streamAuthenticator }),
        request("GET", `/v1/ai-runs/${accepted.run.id}/stream`),
      ).pipe(Effect.provide(clerkStreamConfigLayer)),
    );
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(new TextDecoder().decode(first.value)).toContain("ORG_AUTHORIZED_BEFORE");

    await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              update client_companies
              set clerk_organization_id = ${`org_rebound_${crypto.randomUUID()}`}
              where id = (select company_id from chats where id = ${chat.chat.id})
            `;
            yield* sql`
              insert into ai_run_events (run_id, seq, emission_key, event)
              values (
                ${accepted.run.id}, 2, 'text_delta:org-after:0:0',
                ${sql.json({ type: "text_delta", delta: "ORG_FORBIDDEN_AFTER" })}
              )
            `;
          }),
        );
      }),
    );
    let remainder = "";
    for (;;) {
      const result = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("organization-rebound stream did not close")), 1_000),
        ),
      ]);
      if (result.done) break;
      remainder += new TextDecoder().decode(result.value);
    }
    expect(remainder).not.toContain("ORG_FORBIDDEN_AFTER");
    expect(remainder).not.toContain("keep-alive");
  });

  it("keeps an open SSE stream after public-source opt-out", async () => {
    const chat = await getChat();
    const acceptedResponse = await postMessage({
      text: "Stream with public-source opt-out",
      locale: "en-US",
      market: "US",
      webSearchEnabled: false,
    });
    const accepted = await body<{ run: { id: string } }>(acceptedResponse);
    const sourceId = `stream-source-${crypto.randomUUID()}`;
    const documentId = `stream-document-${crypto.randomUUID()}`;
    const artifactId = crypto.randomUUID();
    await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const company = (yield* sql<{ readonly id: string }>`
          select company_id::text as id from chats where id = ${chat.chat.id}
        `)[0]!;
        const canonicalUrl = `https://example.test/${documentId}`;
        const text = "Authorized public source stream evidence ".repeat(10);
        const ranges = [{ charStart: 0, charEnd: text.length }] as const;
        const contentHash = createHash("sha256").update(text, "utf8").digest("hex");
        yield* sql`
          insert into public_sources (
            source_id, display_name, publisher_name, description, ingestion_method,
            discovery_url, average_chars_per_item
          ) values (
            ${sourceId}, 'Stream source', 'Official publisher', 'SSE authorization fixture',
            'rss', ${`${canonicalUrl}/feed`}, 1000
          )
        `;
        yield* sql`
          insert into public_source_raw_artifacts (
            id, source_id, canonical_url, fetched_at, media_type, body, body_hash
          ) values (
            ${artifactId}, ${sourceId}, ${canonicalUrl}, now(), 'text/html',
            ${`<main>${text}</main>`},
            encode(digest(${`<main>${text}</main>`}, 'sha256'), 'hex')
          )
        `;
        yield* sql`
          insert into public_source_documents (
            document_id, source_id, raw_artifact_id, canonical_url, title, text, language,
            discovered_at, fetched_at, document_type, content_hash, text_char_count
          ) values (
            ${documentId}, ${sourceId}, ${artifactId}, ${canonicalUrl}, 'Stream document',
            ${text}, 'en-US', now(), now(), 'publication',
            encode(digest(${text}, 'sha256'), 'hex'), ${text.length}
          )
        `;
        yield* sql`
          insert into client_company_public_source_settings (
            client_company_id, source_id, enabled, updated_by_user_id
          ) values (${company.id}, ${sourceId}, true, 'demo-user')
        `;
        yield* sql`
          insert into ai_source_exposures (
            run_id, task_id, loop_iteration, attempt, provider_request_index, source_kind,
            logical_source_identity, content_item_identity, exposure_stage, visible_token_count,
            document_source_id, document_id, snapshot_id, content_hash, document_ranges
            ) values (
              ${accepted.run.id}, 'single-retrieve-internal', 0, 0, 0, 'document',
            ${namespacedPublicDocumentIdentity(sourceId, documentId)},
            ${documentContentItemIdentity(namespacedPublicDocumentIdentity(sourceId, documentId), documentId, ranges)},
            'internal_inspection', 12, ${`public:${sourceId}`}, ${documentId}, ${documentId},
            ${contentHash}, ${JSON.stringify(ranges)}::jsonb
          )
        `;
        yield* sql`
          insert into ai_run_events (run_id, seq, emission_key, event)
          values (
            ${accepted.run.id}, 1, 'text_delta:public-before:0:0',
            ${sql.json({ type: "text_delta", delta: "PUBLIC_AUTHORIZED_BEFORE" })}
          )
        `;
      }),
    );

    const response = await route(request("GET", `/v1/ai-runs/${accepted.run.id}/stream`));
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(new TextDecoder().decode(first.value)).toContain("PUBLIC_AUTHORIZED_BEFORE");

    await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update client_company_public_source_settings
          set enabled = false, updated_at = now()
          where source_id = ${sourceId}
        `;
        yield* sql`
          insert into ai_run_events (run_id, seq, emission_key, event)
          values (
            ${accepted.run.id}, 2, 'text_delta:public-after:0:0',
            ${sql.json({ type: "text_delta", delta: "PUBLIC_FORBIDDEN_AFTER" })}
          )
        `;
      }),
    );
    const after = await reader.read();
    expect(after.done).toBe(false);
    expect(new TextDecoder().decode(after.value)).toContain("PUBLIC_FORBIDDEN_AFTER");
    await reader.cancel();
  });

  it("fails closed when a public exposure names the wrong namespace or malformed identity", async () => {
    const chat = await getChat();
    const sourceId = `stream-source-${crypto.randomUUID()}`;
    const documentId = `stream-document-${crypto.randomUUID()}`;
    const artifactId = crypto.randomUUID();
    const text = "Namespaced public exposure evidence ".repeat(4);
    await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const company = (yield* sql<{ readonly id: string }>`
          select company_id::text as id from chats where id = ${chat.chat.id}
        `)[0]!;
        const canonicalUrl = `https://example.test/${documentId}`;
        yield* sql`
          insert into public_sources (
            source_id, display_name, publisher_name, description, ingestion_method,
            discovery_url, average_chars_per_item
          ) values (
            ${sourceId}, 'Namespace source', 'Official publisher', 'SSE namespace fixture',
            'rss', ${`${canonicalUrl}/feed`}, 1000
          )
        `;
        yield* sql`
          insert into public_source_raw_artifacts (
            id, source_id, canonical_url, fetched_at, media_type, body, body_hash
          ) values (
            ${artifactId}, ${sourceId}, ${canonicalUrl}, now(), 'text/html',
            ${`<main>${text}</main>`}, encode(digest(${`<main>${text}</main>`}, 'sha256'), 'hex')
          )
        `;
        yield* sql`
          insert into public_source_documents (
            document_id, source_id, raw_artifact_id, canonical_url, title, text, language,
            discovered_at, fetched_at, document_type, content_hash, text_char_count
          ) values (
            ${documentId}, ${sourceId}, ${artifactId}, ${canonicalUrl}, 'Namespace document',
            ${text}, 'en-US', now(), now(), 'publication',
            encode(digest(${text}, 'sha256'), 'hex'), ${text.length}
          )
        `;
        yield* sql`
          insert into client_company_public_source_settings (
            client_company_id, source_id, enabled, updated_by_user_id
          ) values (${company.id}, ${sourceId}, true, 'demo-user')
        `;
      }),
    );

    const seedExposure = async (
      runId: string,
      identity: string,
      publisherDocumentId: string | null = null,
    ): Promise<void> => {
      await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const document = yield* sql<{ readonly contentHash: string }>`
            select content_hash as "contentHash"
            from public_source_documents
            where document_id = ${documentId}
          `;
          const ranges = [{ charStart: 0, charEnd: text.length }] as const;
          yield* sql`
            insert into ai_source_exposures (
              run_id, task_id, loop_iteration, attempt, provider_request_index, source_kind,
              logical_source_identity, publisher_document_id, content_item_identity,
              exposure_stage, visible_token_count, document_source_id, document_id,
              snapshot_id, content_hash, document_ranges
            ) values (
              ${runId}, 'single-retrieve-internal', 0, 0, 0, 'document',
              ${identity}, ${publisherDocumentId}, ${documentContentItemIdentity(identity, documentId, ranges)},
              'internal_inspection', 12, ${`public:${sourceId}`}, ${documentId}, ${documentId},
              ${document[0]!.contentHash}, ${JSON.stringify(ranges)}::jsonb
            )
          `;
          yield* sql`
            insert into ai_run_events (run_id, seq, emission_key, event)
            values (
              ${runId}, 1, ${`text_delta:namespace:${crypto.randomUUID()}`},
              ${sql.json({ type: "text_delta", delta: "NAMESPACE" })}
            )
          `;
        }),
      );
    };

    const wrongNamespaceResponse = await postMessage({
      text: "Wrong public source namespace",
      locale: "en-US",
      market: "US",
      webSearchEnabled: false,
    });
    const wrongNamespace = await body<{ run: { id: string } }>(wrongNamespaceResponse);
    await seedExposure(
      wrongNamespace.run.id,
      namespacedPublicDocumentIdentity(`different-source-${crypto.randomUUID()}`, documentId),
    );
    const wrongNamespaceStream = await route(
      request("GET", `/v1/ai-runs/${wrongNamespace.run.id}/stream`),
    );
    expect(wrongNamespaceStream.status).toBe(200);
    await wrongNamespaceStream.body?.cancel();
    await terminalRun(wrongNamespace.run.id);

    const malformedResponse = await postMessage({
      text: "Malformed public source namespace",
      locale: "en-US",
      market: "US",
      webSearchEnabled: false,
    });
    const malformed = await body<{ run: { id: string } }>(malformedResponse);
    await seedExposure(malformed.run.id, `document:namespace:public:not-json`);
    const malformedStream = await route(request("GET", `/v1/ai-runs/${malformed.run.id}/stream`));
    expect(malformedStream.status).toBe(200);
    await malformedStream.body?.cancel();
    await terminalRun(malformed.run.id);

    const partialResponse = await postMessage({
      text: "Partial publisher provenance",
      locale: "en-US",
      market: "US",
      webSearchEnabled: false,
    });
    const partial = await body<{ run: { id: string } }>(partialResponse);
    await expect(
      seedExposure(
        partial.run.id,
        namespacedPublicDocumentIdentity(sourceId, documentId),
        crypto.randomUUID(),
      ),
    ).rejects.toThrow();
    await terminalRun(partial.run.id);
  });

  it("authorizes only the exact publisher namespace tuple for a cited document", async () => {
    const chat = await getChat();
    const company = chat.chat.id;
    const publisherCompanyId = crypto.randomUUID();
    const subscriptionId = crypto.randomUUID();
    const accessId = crypto.randomUUID();
    const issueId = crypto.randomUUID();
    const snapshotId = crypto.randomUUID();
    // Deliberately reuse the same raw document ID as the public namespace fixture
    // below; the namespace tuple must keep the two identities distinct.
    const documentId = crypto.randomUUID();
    const publicSourceId = `publisher-namespace-public-${crypto.randomUUID()}`;
    const publicArtifactId = crypto.randomUUID();
    const publisherText = "Publisher namespace evidence";
    const publisherContentHash = createHash("sha256").update(publisherText, "utf8").digest("hex");
    const extractionJobId = crypto.randomUUID();
    const extractionId = crypto.randomUUID();
    await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const companyId = (yield* sql<{ readonly id: string }>`
          select company_id::text as id from chats where id = ${company}
        `)[0]!.id;
        const publicUrl = `https://example.test/public/${documentId}`;
        const publicText = "Public namespace twin document ".repeat(6);
        const publicBody = `<main>${publicText}</main>`;
        yield* sql`
          insert into public_sources (
            source_id, display_name, publisher_name, description, ingestion_method,
            discovery_url, average_chars_per_item
          ) values (
            ${publicSourceId}, 'Public twin source', 'Public publisher', 'Namespace twin',
            'rss', ${`${publicUrl}/feed`}, 100
          )
        `;
        yield* sql`
          insert into public_source_raw_artifacts (
            id, source_id, canonical_url, fetched_at, media_type, body, body_hash
          ) values (
            ${publicArtifactId}, ${publicSourceId}, ${publicUrl}, now(), 'text/html',
            ${publicBody}, encode(digest(${publicBody}, 'sha256'), 'hex')
          )
        `;
        yield* sql`
          insert into public_source_documents (
            document_id, source_id, raw_artifact_id, canonical_url, title, text, language,
            discovered_at, fetched_at, document_type, content_hash, text_char_count
          ) values (
            ${documentId}, ${publicSourceId}, ${publicArtifactId}, ${publicUrl}, 'Public twin',
            ${publicText}, 'en-US', now(), now(), 'publication',
            encode(digest(${publicText}, 'sha256'), 'hex'), ${publicText.length}
          )
        `;
        yield* sql`
          insert into client_company_public_source_settings (
            client_company_id, source_id, enabled, updated_by_user_id
          ) values (${companyId}, ${publicSourceId}, true, 'demo-user')
        `;
        yield* sql`
          insert into publisher_companies (id, name)
          values (${publisherCompanyId}, 'Namespace publisher')
        `;
        yield* sql`
          insert into publisher_subscriptions (
            id, publisher_company_id, name, created_by_user_id
          ) values (${subscriptionId}, ${publisherCompanyId}, 'Namespace subscription', 'demo-user')
        `;
        yield* sql`
          insert into client_subscription_accesses (
            id, subscription_id, client_company_id, state, first_admin_email,
            accepted_at, subscribed_at, created_by_user_id
          ) values (
            ${accessId}, ${subscriptionId}, ${companyId}, 'active',
            'demo@example.test', now(), now(), 'demo-user'
          )
        `;
        yield* sql`
          insert into client_employee_subscription_grants (
            access_id, client_company_id, user_id, granted_by_user_id
          ) values (${accessId}, ${companyId}, 'demo-user', 'demo-user')
        `;
        yield* sql`
          insert into chat_subscription_sources (
            chat_id, access_id, client_company_id, subscription_id
          ) values (${company}, ${accessId}, ${companyId}, ${subscriptionId})
        `;
        yield* sql`
          insert into publisher_issues (
            id, subscription_id, title, status, created_by_user_id
          ) values (
            ${issueId}, ${subscriptionId}, 'Namespace issue', 'draft', 'demo-user'
          )
        `;
        yield* sql`
          insert into hartlib_documents (
            id, issue_id, title, original_file_name, object_key, media_type,
            byte_size, sha256_hex, upload_completed_at, created_by_user_id, language
          ) values (
            ${documentId}, ${issueId}, 'Namespace document', 'namespace.pdf',
            ${`namespace/${documentId}.pdf`}, 'application/pdf', 1, ${"a".repeat(64)},
            now(), 'demo-user', 'en-US'
          )
        `;
        yield* sql`
          insert into jobs (id, kind, payload)
          values (${extractionJobId}, 'extract_pdf_text', '{}'::jsonb)
        `;
        yield* sql`
          insert into hartlib_document_extractions (
            id, hartlib_document_id, input_sha256_hex, pages, extracted_char_count, created_by_job_id
          ) values (
            ${extractionId}, ${documentId}, ${"a".repeat(64)},
            ${JSON.stringify([{ pageNumber: 1, text: publisherText }])}::jsonb,
            ${publisherText.length}, ${extractionJobId}
          )
        `;
        yield* sql`
          insert into hartlib_document_versions (
            id, hartlib_document_id, publisher_extraction_id, content_hash, language, canonical_text,
            text_char_count, page_ranges
          ) values (
            ${snapshotId}, ${documentId}, ${extractionId}, ${publisherContentHash}, 'en-US', ${publisherText},
            ${publisherText.length},
            ${JSON.stringify([{ pageNumber: 1, charStart: 0, charEnd: publisherText.length }])}::jsonb
          )
        `;
        yield* sql`
          update hartlib_documents
          set current_version_id = ${snapshotId}
          where id = ${documentId}
        `;
        yield* sql`
          update publisher_issues
          set status = 'published', publication_at = now(), published_at = now()
          where id = ${issueId}
        `;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              insert into issue_deliveries (
                issue_id, subscription_id, access_id, client_company_id, historical
              ) values (${issueId}, ${subscriptionId}, ${accessId}, ${companyId}, false)
            `;
            yield* sql`
              insert into issue_delivery_recipients (
                issue_id, client_company_id, user_id, delivered_at
              )
              select issue_id, client_company_id, 'demo-user', delivered_at
              from issue_deliveries
              where issue_id = ${issueId} and client_company_id = ${companyId}
            `;
          }),
        );
      }),
    );

    const seedExposure = async (runId: string, identity: string): Promise<void> => {
      await runDb(
        isolatedUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const ranges = [{ charStart: 0, charEnd: publisherText.length }] as const;
          yield* sql`
            insert into ai_source_exposures (
              run_id, task_id, loop_iteration, attempt, provider_request_index, source_kind,
              logical_source_identity, publisher_issue_id, publisher_document_id,
              content_item_identity, exposure_stage, visible_token_count, document_source_id,
              document_id, snapshot_id, content_hash, publisher_extraction_id, document_ranges
            ) values (
              ${runId}, 'single-retrieve-internal', 0, 0, 0, 'document', ${identity},
              ${issueId}, ${documentId}, ${documentContentItemIdentity(identity, snapshotId, ranges)},
              'internal_inspection', 12, ${`publisher:${subscriptionId}`}, ${documentId},
              ${snapshotId}, ${publisherContentHash}, ${extractionId},
              ${JSON.stringify(ranges)}::jsonb
            )
          `;
          yield* sql`
            insert into ai_run_events (run_id, seq, emission_key, event)
            values (
              ${runId}, 1, ${`text_delta:publisher:${crypto.randomUUID()}`},
              ${sql.json({ type: "text_delta", delta: "PUBLISHER" })}
            )
          `;
        }),
      );
    };

    const validResponse = await postMessage({
      text: "Valid publisher namespace",
      locale: "en-US",
      market: "US",
      webSearchEnabled: false,
    });
    const valid = await body<{ run: { id: string } }>(validResponse);
    await seedExposure(
      valid.run.id,
      namespacedPublisherDocumentIdentity(subscriptionId, issueId, documentId),
    );
    const validStream = await route(request("GET", `/v1/ai-runs/${valid.run.id}/stream`));
    expect(validStream.status).toBe(200);
    const validReader = validStream.body!.getReader();
    try {
      const firstChunk = await Promise.race([
        validReader.read(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("publisher stream did not emit")), 1_000),
        ),
      ]);
      if (firstChunk.done) throw new Error("publisher stream ended before its first event");
      expect(new TextDecoder().decode(firstChunk.value)).toContain("PUBLISHER");
    } finally {
      await validReader.cancel().catch(() => undefined);
      validReader.releaseLock();
      await terminalRun(valid.run.id);
    }

    const publicNamespaceResponse = await postMessage({
      text: "Public namespace cannot authorize publisher",
      locale: "en-US",
      market: "US",
      webSearchEnabled: false,
    });
    const publicNamespace = await body<{ run: { id: string } }>(publicNamespaceResponse);
    await seedExposure(
      publicNamespace.run.id,
      namespacedPublicDocumentIdentity(publicSourceId, documentId),
    );
    const publicNamespaceStream = await route(
      request("GET", `/v1/ai-runs/${publicNamespace.run.id}/stream`),
    );
    expect(publicNamespaceStream.status).toBe(200);
    await publicNamespaceStream.body?.cancel();
    await terminalRun(publicNamespace.run.id);

    const wrongSourceResponse = await postMessage({
      text: "Wrong publisher source namespace",
      locale: "en-US",
      market: "US",
      webSearchEnabled: false,
    });
    const wrongSource = await body<{ run: { id: string } }>(wrongSourceResponse);
    await seedExposure(
      wrongSource.run.id,
      namespacedPublisherDocumentIdentity(crypto.randomUUID(), issueId, documentId),
    );
    const wrongSourceStream = await route(
      request("GET", `/v1/ai-runs/${wrongSource.run.id}/stream`),
    );
    expect(wrongSourceStream.status).toBe(200);
    await wrongSourceStream.body?.cancel();
    await terminalRun(wrongSource.run.id);

    const wrongIssueResponse = await postMessage({
      text: "Wrong publisher issue namespace",
      locale: "en-US",
      market: "US",
      webSearchEnabled: false,
    });
    const wrongIssue = await body<{ run: { id: string } }>(wrongIssueResponse);
    await seedExposure(
      wrongIssue.run.id,
      namespacedPublisherDocumentIdentity(subscriptionId, crypto.randomUUID(), documentId),
    );
    const wrongIssueStream = await route(request("GET", `/v1/ai-runs/${wrongIssue.run.id}/stream`));
    expect(wrongIssueStream.status).toBe(200);
    await wrongIssueStream.body?.cancel();
    await terminalRun(wrongIssue.run.id);

    const wrongDocumentResponse = await postMessage({
      text: "Wrong publisher document namespace",
      locale: "en-US",
      market: "US",
      webSearchEnabled: false,
    });
    const wrongDocument = await body<{ run: { id: string } }>(wrongDocumentResponse);
    await seedExposure(
      wrongDocument.run.id,
      namespacedPublisherDocumentIdentity(subscriptionId, issueId, crypto.randomUUID()),
    );
    const wrongDocumentStream = await route(
      request("GET", `/v1/ai-runs/${wrongDocument.run.id}/stream`),
    );
    expect(wrongDocumentStream.status).toBe(200);
    await wrongDocumentStream.body?.cancel();
    await terminalRun(wrongDocument.run.id);

    const malformedResponse = await postMessage({
      text: "Malformed publisher namespace",
      locale: "en-US",
      market: "US",
      webSearchEnabled: false,
    });
    const malformed = await body<{ run: { id: string } }>(malformedResponse);
    await seedExposure(malformed.run.id, "document:namespace:publisher:not-json");
    const malformedStream = await route(request("GET", `/v1/ai-runs/${malformed.run.id}/stream`));
    expect(malformedStream.status).toBe(200);
    await malformedStream.body?.cancel();
  });

  it("keeps the SSE handshake independent of later web capability changes", async () => {
    const chat = await getChat();
    await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update client_company_ai_settings settings
          set web_search_enabled = true,
              web_domain_allowlist = array['example.com', 'example.org']
          from chats where chats.company_id = settings.company_id and chats.id = ${chat.chat.id}
        `;
      }),
    );
    const acceptedResponse = await postMessage({
      text: "Stream with deployment revocation",
      locale: "en-US",
      market: "US",
      webSearchEnabled: true,
    });
    const accepted = await body<{ run: { id: string } }>(acceptedResponse);
    await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          insert into ai_source_exposures (
            run_id, task_id, loop_iteration, attempt, provider_request_index,
            source_kind, logical_source_identity, content_item_identity,
            exposure_stage, visible_token_count
          ) values (
            ${accepted.run.id}, 'single-retrieve-web', 0, 0, 0, 'web',
            'https://example.com', 'https://example.com:proof', 'web_fetch', 4
          )
        `;
        yield* sql`
          insert into ai_run_events (run_id, seq, emission_key, event)
          values (${accepted.run.id}, 1, 'web-before', ${sql.json({ type: "text_delta", delta: "WEB" })})
        `;
      }),
    );
    const available = await route(request("GET", `/v1/ai-runs/${accepted.run.id}/stream`));
    expect(available.status).toBe(200);
    await available.body?.cancel("handshake-only assertion complete");
    await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update client_company_ai_settings settings
          set web_domain_allowlist = null
          from chats
          where chats.company_id = settings.company_id and chats.id = ${chat.chat.id}
        `;
      }),
    );
    const broadened = await route(request("GET", `/v1/ai-runs/${accepted.run.id}/stream`));
    expect(broadened.status).toBe(200);
    const broadenedReader = broadened.body!.getReader();
    await expect(readStreamUntil(broadenedReader, "WEB")).resolves.toContain("WEB");
    await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update client_company_ai_settings settings
          set web_domain_allowlist = array['example.com']
          from chats
          where chats.company_id = settings.company_id and chats.id = ${chat.chat.id}
        `;
        yield* sql`
          insert into ai_run_events (run_id, seq, emission_key, event)
          values (
            ${accepted.run.id}, 2, 'web-after-narrowing',
            ${sql.json({ type: "text_delta", delta: "NARROWED_FORBIDDEN" })}
          )
        `;
      }),
    );
    await expect(readStreamUntil(broadenedReader, "NARROWED_FORBIDDEN")).resolves.toContain(
      "NARROWED_FORBIDDEN",
    );
    await broadenedReader.cancel();
    const narrowed = await route(request("GET", `/v1/ai-runs/${accepted.run.id}/stream`));
    expect(narrowed.status).toBe(200);
    await narrowed.body?.cancel();
  });

  it("keeps streaming after a later malformed web policy", async () => {
    const chat = await getChat();
    await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update client_company_ai_settings settings
          set web_search_enabled = true, web_domain_allowlist = null
          from chats where chats.company_id = settings.company_id and chats.id = ${chat.chat.id}
        `;
      }),
    );
    const acceptedResponse = await postMessage({
      text: "Stream with malformed policy",
      locale: "en-US",
      market: "US",
      webSearchEnabled: true,
    });
    const accepted = await body<{ run: { id: string } }>(acceptedResponse);
    await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          insert into ai_source_exposures (
            run_id, task_id, loop_iteration, attempt, provider_request_index,
            source_kind, logical_source_identity, content_item_identity,
            exposure_stage, visible_token_count
          ) values (
            ${accepted.run.id}, 'single-retrieve-web', 0, 0, 0, 'web',
            'https://example.com', 'https://example.com:malformed-policy', 'web_fetch', 4
          )
        `;
        yield* sql`
          insert into ai_run_events (run_id, seq, emission_key, event)
          values (${accepted.run.id}, 1, 'policy-before', ${sql.json({ type: "text_delta", delta: "BEFORE" })})
        `;
      }),
    );
    const stream = await route(request("GET", `/v1/ai-runs/${accepted.run.id}/stream`));
    expect(stream.status).toBe(200);
    const reader = stream.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(new TextDecoder().decode(first.value)).toContain("BEFORE");

    await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        // The schema checks non-null/empty shape, but domain syntax remains a
        // service-boundary invariant. This is a controlled malformed-state injection.
        yield* sql`
          update client_company_ai_settings settings
          set web_domain_allowlist = array['localhost']
          from chats where chats.company_id = settings.company_id and chats.id = ${chat.chat.id}
        `;
        yield* sql`
          insert into ai_run_events (run_id, seq, emission_key, event)
          values (${accepted.run.id}, 2, 'malformed-policy-after', ${sql.json({ type: "text_delta", delta: "MALFORMED_FORBIDDEN" })})
        `;
      }),
    );
    const malformedAfter = await readStreamUntil(reader, "MALFORMED_FORBIDDEN");
    expect(malformedAfter).toContain("MALFORMED_FORBIDDEN");
    await reader.cancel();
    const malformedReplay = await route(request("GET", `/v1/ai-runs/${accepted.run.id}/stream`));
    expect(malformedReplay.status).toBe(200);
    await malformedReplay.body?.cancel();
    await Bun.sleep(50);
  });

  it("keeps an open SSE stream after cited memory revocation", async () => {
    const acceptedResponse = await postMessage({
      text: "Stream with memory revocation",
      locale: "en-US",
      market: "US",
      webSearchEnabled: false,
    });
    const accepted = await body<{ run: { id: string } }>(acceptedResponse);
    const seeded = await seedMemory("Keep answers concise");
    const memoryId = seeded.memoryId;
    const revisionId = seeded.revisionId;
    await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          insert into ai_source_exposures (
            run_id, task_id, loop_iteration, attempt, provider_request_index,
            source_kind, logical_source_identity, content_item_identity,
            exposure_stage, visible_token_count
          ) values (
            ${accepted.run.id}, 'single-answer', 0, 0, 0, 'memory',
            ${`memory:${memoryId}`}, ${revisionId}, 'answer_serialized', 4
          )
        `;
        yield* sql`
          insert into ai_run_events (run_id, seq, emission_key, event)
          values (
            ${accepted.run.id}, 1, 'memory-before',
            ${sql.json({ type: "text_delta", delta: "MEMORY_AUTHORIZED_BEFORE" })}
          )
        `;
      }),
    );
    const response = await route(request("GET", `/v1/ai-runs/${accepted.run.id}/stream`));
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    await expect(readStreamUntil(reader, "MEMORY_AUTHORIZED_BEFORE")).resolves.toContain(
      "MEMORY_AUTHORIZED_BEFORE",
    );
    await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update user_memories set deleted_at = now() where id = ${memoryId}
        `;
        yield* sql`
          insert into ai_run_events (run_id, seq, emission_key, event)
          values (
            ${accepted.run.id}, 2, 'memory-after',
            ${sql.json({ type: "text_delta", delta: "MEMORY_FORBIDDEN_AFTER" })}
          )
        `;
      }),
    );
    await expect(readStreamUntil(reader, "MEMORY_FORBIDDEN_AFTER")).resolves.toContain(
      "MEMORY_FORBIDDEN_AFTER",
    );
    await reader.cancel();
  });

  it("implements exact memory revision, delete, idempotent delete, and selected revert APIs", async () => {
    await getChat();
    const seeded = await seedMemory();
    const listed = await body<{
      memories: readonly {
        id: string;
        current: { deleted: boolean };
        revisions: readonly { id: string }[];
      }[];
    }>(await route(request("GET", "/v1/memories")));
    expect(listed.memories[0]).toMatchObject({ id: seeded.memoryId, current: { deleted: false } });

    const revision = await route(
      request("GET", `/v1/memories/${seeded.memoryId}/revisions/${seeded.revisionId}`),
    );
    expect(await body(revision)).toMatchObject({
      memoryId: seeded.memoryId,
      revision: { id: seeded.revisionId, action: "create" },
    });

    const deleted = await route(request("DELETE", `/v1/memories/${seeded.memoryId}`));
    expect(await body(deleted)).toMatchObject({ current: { deleted: true } });
    const deletedAgain = await route(request("DELETE", `/v1/memories/${seeded.memoryId}`));
    expect(deletedAgain.status).toBe(200);
    const revisionsAfterDelete = await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{
          count: number;
        }>`select count(*)::int count from user_memory_revisions where memory_id = ${seeded.memoryId}`)[0]!
          .count;
      }),
    );
    expect(revisionsAfterDelete).toBe(2);

    const reverted = await route(
      request("POST", `/v1/memories/${seeded.memoryId}/revert`, {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ revisionId: seeded.revisionId }),
      }),
    );
    expect(await body(reverted)).toMatchObject({
      current: { deleted: false, content: "Use concise answers" },
    });
  });

  it("lists memory heads and revision ledgers from one user-memory snapshot", async () => {
    await getChat();
    const seeded = await seedMemory("Before concurrent finalization");
    const blocker = holdMemoryRevisionTable("hartlib-memory-snapshot-blocker");
    await blocker.held;
    const listing = runDbAs("hartlib-memory-snapshot-reader", listUserMemories("demo-user"));
    await waitForDatabaseBlocker(
      "hartlib-memory-snapshot-reader",
      "hartlib-memory-snapshot-blocker",
    );

    const writer = runDbAs(
      "hartlib-memory-snapshot-writer",
      deleteUserMemory("demo-user", seeded.memoryId),
    );
    await waitForDatabaseBlocker(
      "hartlib-memory-snapshot-writer",
      "hartlib-memory-snapshot-reader",
    );
    blocker.release();
    await blocker.done;

    const listed = await listing;
    const written = await writer;
    expect(written.status).toBe("ok");
    const memory = listed.memories.find((candidate) => candidate.id === seeded.memoryId);
    expect(memory).toMatchObject({
      id: seeded.memoryId,
      headRevisionId: seeded.revisionId,
      current: { content: "Before concurrent finalization" },
    });
    expect(memory?.revisions.map((revision) => revision.id)).toEqual([seeded.revisionId]);

    const after = await runDbAs("hartlib-memory-snapshot-after", listUserMemories("demo-user"));
    const nextRevisionId = written.status === "ok" ? written.memory.headRevisionId : "";
    expect(after.memories[0]).toMatchObject({
      id: seeded.memoryId,
      headRevisionId: nextRevisionId,
      current: { content: "Before concurrent finalization", deleted: true },
    });
    expect(after.memories[0]?.revisions.map((revision) => revision.id)).toEqual([
      seeded.revisionId,
      nextRevisionId,
    ]);
  });

  it("reads an exact memory and its revision ledger under one user-memory lease", async () => {
    await getChat();
    const seeded = await seedMemory("Before exact revision read");
    const blocker = holdMemoryRevisionTable("hartlib-memory-exact-blocker");
    await blocker.held;
    const reading = runDbAs(
      "hartlib-memory-exact-reader",
      readUserMemoryWithRevisions("demo-user", seeded.memoryId),
    );
    await waitForDatabaseBlocker("hartlib-memory-exact-reader", "hartlib-memory-exact-blocker");

    const writer = runDbAs(
      "hartlib-memory-exact-writer",
      deleteUserMemory("demo-user", seeded.memoryId),
    );
    await waitForDatabaseBlocker("hartlib-memory-exact-writer", "hartlib-memory-exact-reader");
    blocker.release();
    await blocker.done;

    const loaded = await reading;
    const written = await writer;
    expect(written.status).toBe("ok");
    expect(loaded?.memory).toMatchObject({
      id: seeded.memoryId,
      head_revision_id: seeded.revisionId,
      content: "Before exact revision read",
    });
    expect(loaded?.revisions.map((revision) => revision.id)).toEqual([seeded.revisionId]);

    const after = await runDbAs(
      "hartlib-memory-exact-after",
      readUserMemoryWithRevisions("demo-user", seeded.memoryId),
    );
    const nextRevisionId = written.status === "ok" ? written.memory.headRevisionId : "";
    expect(after?.memory).toMatchObject({
      id: seeded.memoryId,
      head_revision_id: nextRevisionId,
      content: "Before exact revision read",
      deleted_at: expect.any(Date),
    });
    expect(after?.revisions.map((revision) => revision.id)).toEqual([
      seeded.revisionId,
      nextRevisionId,
    ]);
  });

  it("blocks memory mutation during an active run and enforces the 30-day revert window", async () => {
    await getChat();
    const seeded = await seedMemory("Remember me");
    const accepted = await body<{ run: { id: string } }>(
      await postMessage({ text: "Active", locale: "en-US", market: "US", webSearchEnabled: false }),
    );
    const mutation = await route(request("DELETE", `/v1/memories/${seeded.memoryId}`));
    expect(mutation.status).toBe(200);
    await terminalRun(accepted.run.id);
    await route(request("DELETE", `/v1/memories/${seeded.memoryId}`));
    await runDb(
      isolatedUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`update user_memories set deleted_at = now() - interval '31 days' where id = ${seeded.memoryId}`;
      }),
    );
    const expired = await route(
      request("POST", `/v1/memories/${seeded.memoryId}/revert`, {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ revisionId: seeded.revisionId }),
      }),
    );
    expect(expired.status).toBe(410);
    expect(await body(expired)).toEqual({ code: "memory_revert_window_expired" });
  });
});
