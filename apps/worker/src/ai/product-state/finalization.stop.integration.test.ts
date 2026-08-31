import { PgClient } from "@effect/sql-pg";
import { Effect, Redacted } from "effect";
import { describe, expect, it } from "vitest";

import { makeRunAcceptanceScope } from "../../../../../packages/shared/src/chat";
import { stopAiRun } from "./finalization";

const databaseUrl = process.env.WORKER_POSTGRES_TEST_DATABASE_URL;

const runDb = <A, E>(effect: Effect.Effect<A, E, PgClient.PgClient>): Promise<A> => {
  if (databaseUrl === undefined) throw new Error("WORKER_POSTGRES_TEST_DATABASE_URL is required");
  return Effect.runPromise(
    effect.pipe(
      Effect.provide(
        PgClient.layer({
          url: Redacted.make(databaseUrl),
          applicationName: "hartlib-stop-run-integration-test",
        }),
      ),
    ),
  );
};

describe.skipIf(databaseUrl === undefined)("durable AI run stop", () => {
  it("persists validated partial text, emits one stopped event, and is idempotent", async () => {
    const userId = `stop-test-${crypto.randomUUID()}`;
    const companyId = crypto.randomUUID();
    const chatId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const sourceKey = "k_cn_0123456789abcdef012345_1";
    const citationNamespace = "cn_0123456789abcdef012345";
    const acceptanceScope = makeRunAcceptanceScope({
      userId,
      chatId,
      companyId,
      provider: "deterministic_test",
      providerEndpointIdentity: "deterministic_test:deterministic",
    });

    try {
      await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`insert into platform_users (id, primary_email, display_name) values (${userId}, ${`${userId}@example.test`}, 'Stop test')`;
          yield* sql`insert into client_companies (id, name) values (${companyId}::uuid, 'Stop company')`;
          yield* sql`insert into client_company_memberships (company_id, user_id, role) values (${companyId}::uuid, ${userId}, 'admin')`;
          yield* sql`insert into chats (id, user_id, company_id, memory_mode) values (${chatId}::uuid, ${userId}, ${companyId}::uuid, 'private_owner')`;
          yield* sql`insert into ai_runs (id, chat_id, initiating_user_id, locale, market, citation_namespace, acceptance_scope, next_event_seq, started_at) values (${runId}::uuid, ${chatId}::uuid, ${userId}, 'en-US', 'US', ${citationNamespace}, ${sql.json(acceptanceScope)}, 5, now())`;
          yield* sql`insert into ai_run_events (run_id, seq, event, emission_key, emitted_by_task) values (${runId}::uuid, 1, ${sql.json({ type: "answer_started", mode: "single", attempt: 1 })}, 'answer_started:single-answer:1', 'single-answer')`;
          yield* sql`insert into ai_run_events (run_id, seq, event, emission_key, emitted_by_task) values (${runId}::uuid, 2, ${sql.json({ type: "text_delta", delta: "discarded attempt " })}, 'text_delta:single-answer:1:0', 'single-answer')`;
          yield* sql`insert into ai_run_events (run_id, seq, event, emission_key, emitted_by_task) values (${runId}::uuid, 3, ${sql.json({ type: "answer_started", mode: "single", attempt: 2 })}, 'answer_started:single-answer:2', 'single-answer')`;
          yield* sql`insert into ai_run_events (run_id, seq, event, emission_key, emitted_by_task) values (${runId}::uuid, 4, ${sql.json({ type: "text_delta", delta: `Partial [[cite:${sourceKey}]] and [[cite:missing]] [[cite:partial]` })}, 'text_delta:single-answer:2:0', 'single-answer')`;
          yield* sql`insert into assistant_message_sources (run_id, source_key, kind, locator, public_provenance, source_identity_digest, citation_namespace) values (${runId}::uuid, ${sourceKey}, 'web', ${sql.json({ kind: "web", url: "https://example.com/article", title: "Article", domain: "example.com", quote: "Quote", quoteHash: "60zevYK_EZRK8EDTD4qmiPv0yDb0bdjEFUrfQNwoasY", capturedAt: new Date().toISOString() })}, ${sql.json({ citationUrl: "https://example.com/article" })}, ${"a".repeat(64)}, ${citationNamespace})`;
          yield* sql`
            insert into ai_run_usage (
              run_id, task_id, loop_iteration, attempt, provider_request_index,
              agent_role, model_id, input_tokens, output_tokens, cached_tokens,
              reasoning_tokens, total_tokens, stop_reason, provider_service_id
            ) values (
              ${runId}::uuid, 'single-answer', 0, 2, 0, 'main', 'glm-5-turbo',
              2, 3, 0, 0, 5, 'stop', 'deterministic_test'
            )
          `;
        }),
      );

      const stopped = await runDb(stopAiRun(runId));
      expect(stopped).toMatchObject({ status: "stopped", runId, alreadyStopped: false });

      await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const run = yield* sql<{
            readonly stoppedAt: Date | null;
            readonly assistantId: string | null;
          }>`
            select stopped_at as "stoppedAt", assistant_message_id::text as "assistantId"
            from ai_runs where id = ${runId}::uuid
          `;
          expect(run[0]?.stoppedAt).not.toBeNull();
          expect(run[0]?.assistantId).not.toBeNull();
          const assistant = yield* sql<{ readonly content: string }>`
            select content from chat_messages where id = ${run[0]?.assistantId}::uuid
          `;
          expect(assistant[0]?.content).toBe(`Partial [[cite:${sourceKey}]] and `);
          const events = yield* sql<{ readonly type: string; readonly count: number }>`
            select event->>'type' as type, count(*)::int as count
            from ai_run_events where run_id = ${runId}::uuid group by event->>'type'
          `;
          expect(events.find((event) => event.type === "stopped")?.count).toBe(1);
          expect(events.find((event) => event.type === "memory_updated")).toBeUndefined();
          const memoryRevisions = yield* sql<{ readonly count: number }>`
            select count(*)::int as count from user_memory_revisions where run_id = ${runId}::uuid
          `;
          expect(memoryRevisions[0]?.count).toBe(0);
          const usage = yield* sql<{
            readonly taskId: string;
            readonly attempt: number;
            readonly inputTokens: number;
            readonly outputTokens: number;
            readonly totalTokens: number;
            readonly stopReason: string | null;
            readonly providerServiceId: string;
          }>`
            select task_id as "taskId", attempt, input_tokens as "inputTokens",
                   output_tokens as "outputTokens", total_tokens as "totalTokens",
                   stop_reason as "stopReason", provider_service_id as "providerServiceId"
            from ai_run_usage where run_id = ${runId}::uuid
          `;
          expect(usage).toEqual([
            {
              taskId: "single-answer",
              attempt: 2,
              inputTokens: 2,
              outputTokens: 3,
              totalTokens: 5,
              stopReason: "stop",
              providerServiceId: "deterministic_test",
            },
          ]);
        }),
      );

      await expect(runDb(stopAiRun(runId))).resolves.toMatchObject({
        status: "stopped",
        runId,
        alreadyStopped: true,
      });
      await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          expect(yield* sql`select 1 from ai_run_usage where run_id = ${runId}::uuid`).toHaveLength(
            1,
          );
        }),
      );
    } finally {
      await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`set local hartlib.allow_account_purge = 'on'`;
              yield* sql`delete from chats where id = ${chatId}::uuid`;
              yield* sql`delete from client_company_memberships where company_id = ${companyId}::uuid and user_id = ${userId}`;
              yield* sql`delete from client_companies where id = ${companyId}::uuid`;
              yield* sql`delete from platform_users where id = ${userId}`;
            }),
          );
        }),
      );
    }
  });

  it("stops a queued run before any provider attempt and emits only its terminal stop", async () => {
    const userId = `stop-queued-${crypto.randomUUID()}`;
    const companyId = crypto.randomUUID();
    const chatId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const citationNamespace = "cn_0123456789abcdef012345";
    const acceptanceScope = makeRunAcceptanceScope({
      userId,
      chatId,
      companyId,
      provider: "deterministic_test",
      providerEndpointIdentity: "deterministic_test:deterministic",
    });

    try {
      await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`insert into platform_users (id, primary_email, display_name) values (${userId}, ${`${userId}@example.test`}, 'Queued stop test')`;
          yield* sql`insert into client_companies (id, name) values (${companyId}::uuid, 'Queued stop company')`;
          yield* sql`insert into client_company_memberships (company_id, user_id, role) values (${companyId}::uuid, ${userId}, 'admin')`;
          yield* sql`insert into chats (id, user_id, company_id, memory_mode) values (${chatId}::uuid, ${userId}, ${companyId}::uuid, 'private_owner')`;
          yield* sql`insert into ai_runs (id, chat_id, initiating_user_id, locale, market, citation_namespace, acceptance_scope) values (${runId}::uuid, ${chatId}::uuid, ${userId}, 'en-US', 'US', ${citationNamespace}, ${sql.json(acceptanceScope)})`;
        }),
      );

      await expect(runDb(stopAiRun(runId))).resolves.toMatchObject({
        status: "stopped",
        runId,
        assistantMessageId: null,
        alreadyStopped: false,
      });
      await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const run = yield* sql<{
            readonly startedAt: Date | null;
            readonly stoppedAt: Date | null;
            readonly stopRequestedAt: Date | null;
            readonly assistantMessageId: string | null;
          }>`
            select started_at as "startedAt", stopped_at as "stoppedAt",
                   stop_requested_at as "stopRequestedAt", assistant_message_id::text as "assistantMessageId"
            from ai_runs where id = ${runId}::uuid
          `;
          expect(run[0]).toMatchObject({
            startedAt: null,
            assistantMessageId: null,
          });
          expect(run[0]?.stoppedAt).not.toBeNull();
          expect(run[0]?.stopRequestedAt).not.toBeNull();
          const events = yield* sql<{ readonly type: string; readonly count: number }>`
            select event->>'type' as type, count(*)::int as count
            from ai_run_events where run_id = ${runId}::uuid group by event->>'type'
          `;
          expect(events).toEqual([{ type: "stopped", count: 1 }]);
          expect(
            yield* sql`select 1 from chat_messages where assistant_ai_run_id = ${runId}::uuid`,
          ).toHaveLength(0);
        }),
      );
    } finally {
      await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`set local hartlib.allow_account_purge = 'on'`;
              yield* sql`delete from chats where id = ${chatId}::uuid`;
              yield* sql`delete from client_company_memberships where company_id = ${companyId}::uuid and user_id = ${userId}`;
              yield* sql`delete from client_companies where id = ${companyId}::uuid`;
              yield* sql`delete from platform_users where id = ${userId}`;
            }),
          );
        }),
      );
    }
  });

  it("lets a committed normal completion win a later stop request", async () => {
    const userId = `stop-complete-${crypto.randomUUID()}`;
    const companyId = crypto.randomUUID();
    const chatId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const assistantMessageId = crypto.randomUUID();
    const citationNamespace = "cn_0123456789abcdef012345";
    const acceptanceScope = makeRunAcceptanceScope({
      userId,
      chatId,
      companyId,
      provider: "deterministic_test",
      providerEndpointIdentity: "deterministic_test:deterministic",
    });

    try {
      await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`insert into platform_users (id, primary_email, display_name) values (${userId}, ${`${userId}@example.test`}, 'Completion stop test')`;
          yield* sql`insert into client_companies (id, name) values (${companyId}::uuid, 'Completion stop company')`;
          yield* sql`insert into client_company_memberships (company_id, user_id, role) values (${companyId}::uuid, ${userId}, 'admin')`;
          yield* sql`insert into chats (id, user_id, company_id, memory_mode) values (${chatId}::uuid, ${userId}, ${companyId}::uuid, 'private_owner')`;
          yield* sql`insert into ai_runs (id, chat_id, initiating_user_id, assistant_message_id, locale, market, citation_namespace, acceptance_scope, started_at, finished_at) values (${runId}::uuid, ${chatId}::uuid, ${userId}, null, 'en-US', 'US', ${citationNamespace}, ${sql.json(acceptanceScope)}, now(), now())`;
          yield* sql`insert into chat_messages (id, chat_id, author, content, assistant_ai_run_id) values (${assistantMessageId}::uuid, ${chatId}::uuid, 'assistant', 'committed answer', ${runId}::uuid)`;
          yield* sql`update ai_runs set assistant_message_id = ${assistantMessageId}::uuid where id = ${runId}::uuid`;
          yield* sql`insert into ai_run_events (run_id, seq, event, emission_key, emitted_by_task) values (${runId}::uuid, 1, ${sql.json({ type: "done", assistantMessageId })}, 'terminal', 'finalize')`;
        }),
      );

      await expect(runDb(stopAiRun(runId))).resolves.toMatchObject({
        status: "stopped",
        runId,
        assistantMessageId,
        alreadyStopped: false,
      });
      await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const run = yield* sql<{
            readonly finishedAt: Date | null;
            readonly stoppedAt: Date | null;
            readonly stopRequestedAt: Date | null;
          }>`
            select finished_at as "finishedAt", stopped_at as "stoppedAt", stop_requested_at as "stopRequestedAt"
            from ai_runs where id = ${runId}::uuid
          `;
          expect(run[0]?.finishedAt).not.toBeNull();
          expect(run[0]?.stoppedAt).toBeNull();
          expect(run[0]?.stopRequestedAt).toBeNull();
          expect(
            yield* sql`select 1 from ai_run_events where run_id = ${runId}::uuid and event->>'type' = 'stopped'`,
          ).toHaveLength(0);
          expect(
            yield* sql`select content from chat_messages where id = ${assistantMessageId}::uuid`,
          ).toEqual([{ content: "committed answer" }]);
        }),
      );
    } finally {
      await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`set local hartlib.allow_account_purge = 'on'`;
              yield* sql`delete from chats where id = ${chatId}::uuid`;
              yield* sql`delete from client_company_memberships where company_id = ${companyId}::uuid and user_id = ${userId}`;
              yield* sql`delete from client_companies where id = ${companyId}::uuid`;
              yield* sql`delete from platform_users where id = ${userId}`;
            }),
          );
        }),
      );
    }
  });
});
