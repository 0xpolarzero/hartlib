import { PgClient } from "@effect/sql-pg";
import {
  deleteUserMemory,
  listUserMemories,
  readUserMemoryWithRevisions,
} from "@brief/backend-domain/memories";
import { ConfigProvider, Effect, Redacted } from "effect";
import { makeRunAcceptanceScope } from "@brief/shared";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { RequestAuthenticator } from "../auth";
import { routeRequest, type Route } from "../http";
import { makeChatRoutes } from "../domain/chat";
import { makeMemoryRoutes } from "../domain/memories";

const migrationsUrl = new URL("../../../../db/migrations/", import.meta.url);
const isBun = typeof process.versions.bun === "string";
const databaseUrl = process.env.WORKER_POSTGRES_TEST_DATABASE_URL;
const databaseName = `brief_api_contract_${process.pid}_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;

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
  versionId: string,
  ranges: readonly { readonly charStart: number; readonly charEnd: number }[],
): string =>
  `${logicalSourceIdentity}:${versionId}:${createHash("sha256")
    .update(JSON.stringify(ranges), "utf8")
    .digest("base64url")}`;

const runDb = <A, E>(url: string, effect: Effect.Effect<A, E, PgClient.PgClient>): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        PgClient.layer({ url: Redacted.make(url), applicationName: "brief-api-contract-test" }),
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

const migrate = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  const files = [...new Bun.Glob("*.sql").scanSync({ cwd: migrationsUrl.pathname })].sort();
  yield* sql`
    create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )
  `;
  for (const file of files) {
    const body = yield* Effect.promise(() => Bun.file(new URL(file, migrationsUrl)).text());
    yield* sql.unsafe(body).raw;
    yield* sql`insert into schema_migrations (name) values (${file})`;
  }
});

const pgLayer = () =>
  PgClient.layer({ url: Redacted.make(isolatedUrl()), applicationName: "brief-api-contract-test" });

const configLayer = ConfigProvider.layer(
  ConfigProvider.fromEnv({
    env: {
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
  new Request(`http://brief.test${path}`, { ...init, method });
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

describe.skipIf(!isBun || !databaseUrl)("canonical chat and memory API", () => {
  beforeAll(async () => {
    await runDb(
      adminUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql.unsafe(`create database ${quoteIdentifier(databaseName)}`).withoutTransform;
      }),
    );
    await runDb(isolatedUrl(), migrate);
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
      "brief-demo-route-runs-table-holder",
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
    await waitForDatabaseLock("brief-api-contract-test");
    const finalizing = runDbAs(
      "brief-demo-route-actual-finalization",
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
        authorize: () => Effect.succeed({ authorized: true } as const),
      }),
    );
    try {
      await waitForDatabaseLock("brief-demo-route-actual-finalization");
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
    await runDb(
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
            expect.objectContaining({ sourceKey: "k_cn_AAAAAAAAAAAAAAAAAAAAAA_1", kind: "web" }),
          ],
          sourcesRead: [expect.objectContaining({ tokenCount: 11 })],
        }),
      ]),
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
  });

  it.each([
    ["root excess field", { type: "error", code: "test_failure", retryable: true, forged: true }],
    [
      "nested excess field",
      {
        type: "context_ready",
        mode: "single",
        reductionRan: false,
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
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(new TextDecoder().decode(first.value)).toContain("AUTHORIZED_BEFORE");

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
    const after = await reader.read();
    expect(after.done).toBe(false);
    expect(new TextDecoder().decode(after.value)).toContain("FORBIDDEN_AFTER");
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
            document_source_id, document_id, version_id, content_hash, document_ranges
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
              version_id, content_hash, document_ranges
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
    const malformedStream = await route(
      request("GET", `/v1/ai-runs/${malformed.run.id}/stream`),
    );
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
    const versionId = crypto.randomUUID();
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
          insert into brief_documents (
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
          insert into brief_document_extractions (
            id, brief_document_id, input_sha256_hex, pages, extracted_char_count, created_by_job_id
          ) values (
            ${extractionId}, ${documentId}, ${"a".repeat(64)},
            ${JSON.stringify([{ pageNumber: 1, text: publisherText }])}::jsonb,
            ${publisherText.length}, ${extractionJobId}
          )
        `;
        yield* sql`
          insert into brief_document_versions (
            id, brief_document_id, publisher_extraction_id, content_hash, language, canonical_text,
            text_char_count, page_ranges
          ) values (
            ${versionId}, ${documentId}, ${extractionId}, ${publisherContentHash}, 'en-US', ${publisherText},
            ${publisherText.length},
            ${JSON.stringify([{ pageNumber: 1, charStart: 0, charEnd: publisherText.length }])}::jsonb
          )
        `;
        yield* sql`
          update brief_documents
          set current_version_id = ${versionId}
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
              document_id, version_id, content_hash, publisher_extraction_id, document_ranges
            ) values (
              ${runId}, 'single-retrieve-internal', 0, 0, 0, 'document', ${identity},
              ${issueId}, ${documentId}, ${documentContentItemIdentity(identity, versionId, ranges)},
              'internal_inspection', 12, ${`publisher:${subscriptionId}`}, ${documentId},
              ${versionId}, ${publisherContentHash}, ${extractionId},
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
    const wrongIssueStream = await route(
      request("GET", `/v1/ai-runs/${wrongIssue.run.id}/stream`),
    );
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
    const malformedStream = await route(
      request("GET", `/v1/ai-runs/${malformed.run.id}/stream`),
    );
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
    const broadenedFirst = await broadenedReader.read();
    expect(broadenedFirst.done).toBe(false);
    expect(new TextDecoder().decode(broadenedFirst.value)).toContain("WEB");
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
    const narrowedEvent = await broadenedReader.read();
    expect(narrowedEvent.done).toBe(false);
    expect(new TextDecoder().decode(narrowedEvent.value)).toContain("NARROWED_FORBIDDEN");
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
    const malformedAfter = await reader.read();
    expect(malformedAfter.done).toBe(false);
    expect(new TextDecoder().decode(malformedAfter.value)).toContain("MALFORMED_FORBIDDEN");
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
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(new TextDecoder().decode(first.value)).toContain("MEMORY_AUTHORIZED_BEFORE");
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
    const memoryAfter = await reader.read();
    expect(memoryAfter.done).toBe(false);
    expect(new TextDecoder().decode(memoryAfter.value)).toContain("MEMORY_FORBIDDEN_AFTER");
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
    const blocker = holdMemoryRevisionTable("brief-memory-snapshot-blocker");
    await blocker.held;
    const listing = runDbAs("brief-memory-snapshot-reader", listUserMemories("demo-user"));
    await waitForDatabaseBlocker("brief-memory-snapshot-reader", "brief-memory-snapshot-blocker");

    const writer = runDbAs(
      "brief-memory-snapshot-writer",
      deleteUserMemory("demo-user", seeded.memoryId),
    );
    await waitForDatabaseBlocker("brief-memory-snapshot-writer", "brief-memory-snapshot-reader");
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

    const after = await runDbAs("brief-memory-snapshot-after", listUserMemories("demo-user"));
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
    const blocker = holdMemoryRevisionTable("brief-memory-exact-blocker");
    await blocker.held;
    const reading = runDbAs(
      "brief-memory-exact-reader",
      readUserMemoryWithRevisions("demo-user", seeded.memoryId),
    );
    await waitForDatabaseBlocker("brief-memory-exact-reader", "brief-memory-exact-blocker");

    const writer = runDbAs(
      "brief-memory-exact-writer",
      deleteUserMemory("demo-user", seeded.memoryId),
    );
    await waitForDatabaseBlocker("brief-memory-exact-writer", "brief-memory-exact-reader");
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
      "brief-memory-exact-after",
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
