import { PgClient } from "@effect/sql-pg";
import { Effect, Redacted } from "effect";
import { describe, expect, it } from "vitest";

import { makeRunAcceptanceScope } from "../../../../packages/shared/src/chat";
import {
  housekeepCompletedDemoIdentityPurgeJobs,
  parseDemoIdentityPurgePayload,
  purgeDemoIdentity,
} from "./demo-identity-purge";

const databaseUrl = process.env.WORKER_POSTGRES_TEST_DATABASE_URL;

const runDb = <A, E>(effect: Effect.Effect<A, E, PgClient.PgClient>): Promise<A> => {
  if (databaseUrl === undefined) throw new Error("WORKER_POSTGRES_TEST_DATABASE_URL is required");
  return Effect.runPromise(
    effect.pipe(
      Effect.provide(
        PgClient.layer({
          url: Redacted.make(databaseUrl),
          applicationName: "hartlib-demo-identity-purge-test",
        }),
      ),
    ),
  );
};

describe("demo identity purge payload", () => {
  it("accepts only the visitorId payload", () => {
    const visitorId = crypto.randomUUID();
    expect(parseDemoIdentityPurgePayload({ visitorId })).toEqual({ visitorId });
    expect(() => parseDemoIdentityPurgePayload({ visitorId, extra: true })).toThrow();
    expect(() => parseDemoIdentityPurgePayload({ visitorId: "not-a-uuid" })).toThrow();
  });
});

describe.skipIf(databaseUrl === undefined)("demo identity purge", () => {
  it("removes the old identity graph but leaves its own job row for the runner", async () => {
    const visitorId = crypto.randomUUID();
    const companyId = crypto.randomUUID();
    const successorCompanyId = crypto.randomUUID();
    const chatId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const userMessageId = crypto.randomUUID();
    const assistantMessageId = crypto.randomUUID();
    const memoryId = crypto.randomUUID();
    const revisionId = crypto.randomUUID();
    const successorVisitorId = crypto.randomUUID();
    const successorChatId = crypto.randomUUID();
    const resetOperationId = crypto.randomUUID();
    const purgeSourceId = `purge-${visitorId}`;
    const sourceKey = "k_cn_0123456789abcdef012345_1";
    const auditRequestId = crypto.randomUUID();
    const jobKey = `demo-identity-purge:${visitorId}`;
    const aiJobKey = `ai_chat_run:${runId}`;
    const smithersRunId = `ai-chat:${runId}`;
    const smithersChildRunId = `ai-chat:child:${runId}`;
    let smithersRunsAvailable = false;
    let smithersEvalCasesAvailable = false;

    try {
      await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`insert into platform_users (id, primary_email, display_name) values (${visitorId}, ${`${visitorId}@example.test`}, 'Purge test')`;
          yield* sql`insert into client_companies (id, name) values (${companyId}::uuid, 'Purge company')`;
          yield* sql`insert into client_company_memberships (company_id, user_id, role) values (${companyId}::uuid, ${visitorId}, 'admin')`;
          yield* sql`insert into client_company_ai_settings (company_id, web_search_enabled) values (${companyId}::uuid, false)`;
          yield* sql`
            insert into public_sources (
              source_id, display_name, publisher_name, description,
              ingestion_method, discovery_url, average_chars_per_item
            ) values (
              ${purgeSourceId}, 'Purge source', 'Purge publisher', 'Purge source',
              'test', 'https://purge.example/source', 100
            )
          `;
          yield* sql`
            insert into client_company_public_source_settings (
              client_company_id, source_id, enabled, updated_by_user_id
            ) values (${companyId}::uuid, ${purgeSourceId}, true, ${visitorId})
          `;
          yield* sql`insert into chats (id, user_id, company_id, memory_mode) values (${chatId}::uuid, ${visitorId}, ${companyId}::uuid, 'private_owner')`;
          yield* sql`
            insert into chat_messages (id, chat_id, author, content)
            values (${userMessageId}::uuid, ${chatId}::uuid, 'user', 'Purge this identity')
          `;
          yield* sql`
            insert into ai_runs (
              id, chat_id, initiating_user_id, user_message_id, locale, market,
              citation_namespace, acceptance_scope, smithers_run_id, failed_at,
              error_code, retryable
            ) values (
              ${runId}::uuid, ${chatId}::uuid, ${visitorId}, ${userMessageId}::uuid,
              'en-US', 'US', 'cn_0123456789abcdef012345',
              ${sql.json(makeRunAcceptanceScope({ userId: visitorId, chatId, companyId, publicSourceIds: [purgeSourceId], provider: "deterministic_test", providerEndpointIdentity: "deterministic_test:deterministic" }))},
              ${smithersRunId}, now(), 'internal_error', false
            )
          `;
          yield* sql`
            insert into chat_messages (id, chat_id, author, content, assistant_ai_run_id)
            values (${assistantMessageId}::uuid, ${chatId}::uuid, 'assistant', 'Purge answer', ${runId}::uuid)
          `;
          yield* sql`update ai_runs set assistant_message_id = ${assistantMessageId}::uuid where id = ${runId}::uuid`;
          yield* sql`
            insert into assistant_message_sources (
              run_id, source_key, assistant_message_id, kind, locator,
              display_label, public_provenance, source_identity_digest, citation_namespace
            ) values (
              ${runId}::uuid, ${sourceKey}, ${assistantMessageId}::uuid, 'web',
              ${sql.json({
                kind: "web",
                url: "https://example.com/purge",
                title: "Purge evidence",
                domain: "example.com",
                quote: "Purge evidence quote",
                quoteHash: "mZqQzfBTWIc0V9eIlCHUJAxzMeop2H1kHOcUbjwP-ts",
                capturedAt: "2026-08-29T00:00:00.000Z",
              })},
              'Purge evidence', ${sql.json({ citationUrl: "https://example.com/purge" })}, ${"a".repeat(64)}, 'cn_0123456789abcdef012345'
            )
          `;
          yield* sql`
            insert into assistant_message_source_uses (
              run_id, source_key, assistant_message_id, consumer_task_id,
              rendered_token_count, context_order, ranges, source_use_identity_digest
            ) values (
              ${runId}::uuid, ${sourceKey}, ${assistantMessageId}::uuid,
              'single-answer', 1, 0, '[]'::jsonb, ${"b".repeat(64)}
            )
          `;
          yield* sql`
            insert into ai_source_exposures (
              run_id, task_id, loop_iteration, attempt, provider_request_index,
              source_kind, logical_source_identity, content_item_identity,
              exposure_stage, visible_token_count
            ) values (
              ${runId}::uuid, 'single-answer', 0, 0, 0, 'web',
              'web:purge', 'web:purge', 'retrieval', 1
            )
          `;
          yield* sql`
            insert into ai_observations (run_id, chat_id, kind, payload, emitting_task, observation_key)
            values (${runId}::uuid, ${chatId}::uuid, 'purge_observation', '{}'::jsonb, 'purge-test', 'purge-observation')
          `;
          yield* sql`
            insert into ai_run_usage (
              run_id, task_id, loop_iteration, attempt, provider_request_index,
              agent_role, model_id, input_tokens, output_tokens, cached_tokens,
              reasoning_tokens, total_tokens, stop_reason, provider_service_id
            ) values (
              ${runId}::uuid, 'single-answer', 0, 0, 0, 'main', 'glm-5-turbo',
              1, 1, 0, 0, 2, 'stop', 'deterministic_test'
            )
          `;
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`
                insert into user_memories (
                  id, user_id, kind, content, head_revision_id, source_message_id,
                  created_at, updated_at
                ) values (
                  ${memoryId}::uuid, ${visitorId}, 'fact', 'Purge memory',
                  ${revisionId}::uuid, ${userMessageId}::uuid, now(), now()
                )
              `;
              yield* sql`
                insert into user_memory_revisions (
                  id, memory_id, action, state_before, state_after, run_id
                ) values (
                  ${revisionId}::uuid, ${memoryId}::uuid, 'create', null,
                  ${sql.json({ kind: "fact", content: "Purge memory", deleted: false })},
                  ${runId}::uuid
                )
              `;
            }),
          );
          const smithersRelations = yield* sql<{
            readonly runs: string | null;
            readonly evalCases: string | null;
          }>`
            select
              to_regclass('public._smithers_runs') as runs,
              to_regclass('public._smithers_eval_cases') as "evalCases"
          `;
          smithersRunsAvailable =
            smithersRelations[0]?.runs !== null && smithersRelations[0]?.runs !== undefined;
          smithersEvalCasesAvailable =
            smithersRunsAvailable &&
            smithersRelations[0]?.evalCases !== null &&
            smithersRelations[0]?.evalCases !== undefined;
          if (smithersRunsAvailable) {
            yield* sql`insert into _smithers_runs (run_id, workflow_name, status, created_at_ms) values (${smithersRunId}, 'test', 'failed', 1)`;
            yield* sql`insert into _smithers_runs (run_id, parent_run_id, workflow_name, status, created_at_ms) values (${smithersChildRunId}, ${smithersRunId}, 'test-child', 'failed', 2)`;
          }
          if (smithersEvalCasesAvailable) {
            yield* sql`insert into _smithers_eval_cases (id, eval_run_id, suite_id, case_id, case_index, status, case_run_id) values (${`case:${smithersRunId}`}, ${smithersRunId}, 'suite', 'case', 0, 'failed', ${smithersChildRunId})`;
          }
          if (smithersRunsAvailable) {
            yield* sql`insert into ai_smithers_orphan_candidates (smithers_run_id) values (${smithersRunId}), (${smithersChildRunId})`;
          } else {
            yield* sql`insert into ai_smithers_orphan_candidates (smithers_run_id) values (${smithersRunId})`;
          }
          yield* sql`insert into platform_authorization_audit_log (actor_user_id, session_id, request_id, action, scope_kind, scope_id, outcome, occurred_at, purge_after, hold_scope_keys) values (${visitorId}, 'demo-session', ${auditRequestId}::uuid, 'demo_reset', 'user', ${visitorId}, 'succeeded', now(), now() + interval '10 years', '{}')`;
          yield* sql`insert into demo_sessions (visitor_id, revoked_at) values (${visitorId}::uuid, now())`;
          yield* sql`insert into jobs (kind, payload, unique_key, status) values ('ai_chat_run', ${sql.json({ aiRunId: runId })}, ${aiJobKey}, 'queued')`;
          const purgeJobs = yield* sql<{ readonly id: string }>`
            insert into jobs (kind, payload, unique_key, max_attempts)
            values ('demo_identity_purge', ${sql.json({ visitorId })}, ${jobKey}, 2147483647)
            returning id::text
          `;
          const purgeJobId = purgeJobs[0]?.id;
          if (purgeJobId === undefined)
            return yield* Effect.fail(new Error("purge_job_not_created"));
          yield* sql`insert into demo_sessions (visitor_id) values (${successorVisitorId}::uuid)`;
          yield* sql`insert into platform_users (id, primary_email, display_name) values (${successorVisitorId}, ${`${successorVisitorId}@example.test`}, 'Successor')`;
          yield* sql`insert into client_companies (id, name) values (${successorCompanyId}::uuid, 'Successor company')`;
          yield* sql`insert into client_company_memberships (company_id, user_id, role) values (${successorCompanyId}::uuid, ${successorVisitorId}, 'admin')`;
          yield* sql`insert into chats (id, user_id, company_id, memory_mode) values (${successorChatId}::uuid, ${successorVisitorId}, ${successorCompanyId}::uuid, 'private_owner')`;
          yield* sql`
            insert into demo_reset_operations (
              reset_operation_id, predecessor_visitor_id, successor_visitor_id, purge_job_id
            ) values (
              ${resetOperationId}::uuid, ${visitorId}::uuid,
              ${successorVisitorId}::uuid, ${purgeJobId}::uuid
            )
          `;
        }),
      );

      await expect(purgeDemoIdentity(databaseUrl!, visitorId)).resolves.toEqual({
        status: "completed",
        visitorId,
      });
      await expect(purgeDemoIdentity(databaseUrl!, visitorId)).resolves.toEqual({
        status: "completed",
        visitorId,
      });

      await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          expect(yield* sql`select 1 from platform_users where id = ${visitorId}`).toHaveLength(0);
          expect(
            yield* sql`select 1 from client_companies where id = ${companyId}::uuid`,
          ).toHaveLength(0);
          expect(
            yield* sql`select 1 from client_company_ai_settings where company_id = ${companyId}::uuid`,
          ).toHaveLength(0);
          expect(yield* sql`select 1 from chats where id = ${chatId}::uuid`).toHaveLength(0);
          expect(yield* sql`select 1 from ai_runs where id = ${runId}::uuid`).toHaveLength(0);
          expect(
            yield* sql`select 1 from chat_messages where id in (${userMessageId}::uuid, ${assistantMessageId}::uuid)`,
          ).toHaveLength(0);
          expect(
            yield* sql`select 1 from assistant_message_sources where run_id = ${runId}::uuid`,
          ).toHaveLength(0);
          expect(
            yield* sql`select 1 from assistant_message_source_uses where run_id = ${runId}::uuid`,
          ).toHaveLength(0);
          expect(
            yield* sql`select 1 from ai_source_exposures where run_id = ${runId}::uuid`,
          ).toHaveLength(0);
          expect(
            yield* sql`select 1 from ai_observations where run_id = ${runId}::uuid`,
          ).toHaveLength(0);
          expect(yield* sql`select 1 from ai_run_usage where run_id = ${runId}::uuid`).toHaveLength(
            0,
          );
          expect(yield* sql`select 1 from user_memories where id = ${memoryId}::uuid`).toHaveLength(
            0,
          );
          expect(
            yield* sql`select 1 from user_memory_revisions where id = ${revisionId}::uuid`,
          ).toHaveLength(0);
          expect(
            yield* sql`select 1 from client_company_public_source_settings where client_company_id = ${companyId}::uuid and source_id = ${purgeSourceId}`,
          ).toHaveLength(0);
          expect(
            yield* sql`select 1 from public_sources where source_id = ${purgeSourceId}`,
          ).toHaveLength(1);
          if (smithersRunsAvailable) {
            expect(
              yield* sql`select 1 from _smithers_runs where run_id = ${smithersRunId}`,
            ).toHaveLength(0);
            expect(
              yield* sql`select 1 from _smithers_runs where run_id = ${smithersChildRunId}`,
            ).toHaveLength(0);
          }
          if (smithersEvalCasesAvailable) {
            expect(
              yield* sql`select 1 from _smithers_eval_cases where id = ${`case:${smithersRunId}`}`,
            ).toHaveLength(0);
          }
          expect(
            yield* sql`select 1 from ai_smithers_orphan_candidates where smithers_run_id in (${smithersRunId}, ${smithersChildRunId})`,
          ).toHaveLength(0);
          expect(
            yield* sql`select 1 from demo_sessions where visitor_id = ${visitorId}::uuid`,
          ).toHaveLength(0);
          expect(
            yield* sql`select 1 from demo_sessions where visitor_id = ${successorVisitorId}::uuid`,
          ).toHaveLength(1);
          expect(
            yield* sql`select 1 from platform_users where id = ${successorVisitorId}`,
          ).toHaveLength(1);
          expect(yield* sql`select 1 from chats where id = ${successorChatId}::uuid`).toHaveLength(
            1,
          );
          expect(
            yield* sql`select 1 from client_companies where id = ${successorCompanyId}::uuid`,
          ).toHaveLength(1);
          expect(
            yield* sql`select 1 from client_company_memberships where company_id = ${successorCompanyId}::uuid and user_id = ${successorVisitorId}`,
          ).toHaveLength(1);
          expect(
            yield* sql`select predecessor_visitor_id from demo_reset_operations where reset_operation_id = ${resetOperationId}::uuid and successor_visitor_id = ${successorVisitorId}::uuid`,
          ).toEqual([{ predecessor_visitor_id: null }]);
          expect(
            yield* sql`select 1 from platform_authorization_audit_log where actor_user_id = ${visitorId}`,
          ).toHaveLength(0);
          expect(yield* sql`select 1 from jobs where unique_key = ${aiJobKey}`).toHaveLength(0);
          expect(yield* sql`select 1 from jobs where unique_key = ${jobKey}`).toHaveLength(1);
        }),
      );
      await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`update jobs set status = 'completed', completed_at = now() where unique_key = ${jobKey}`;
        }),
      );
      await expect(housekeepCompletedDemoIdentityPurgeJobs(databaseUrl!)).resolves.toBe(1);
      await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          expect(yield* sql`select 1 from jobs where unique_key = ${jobKey}`).toHaveLength(0);
        }),
      );
    } finally {
      await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`set local hartlib.allow_account_purge = 'on'`;
              yield* sql`delete from jobs where unique_key = ${jobKey}`;
              yield* sql`delete from jobs where unique_key = ${aiJobKey}`;
              yield* sql`delete from demo_reset_operations where reset_operation_id = ${resetOperationId}::uuid`;
              yield* sql`delete from chats where id in (${chatId}::uuid, ${successorChatId}::uuid)`;
              yield* sql`delete from demo_sessions where visitor_id in (${visitorId}::uuid, ${successorVisitorId}::uuid)`;
              yield* sql`delete from client_company_memberships where company_id in (${companyId}::uuid, ${successorCompanyId}::uuid)`;
              yield* sql`delete from client_company_public_source_settings where client_company_id = ${companyId}::uuid`;
              yield* sql`delete from client_company_ai_settings where company_id = ${companyId}::uuid`;
              yield* sql`delete from public_sources where source_id = ${purgeSourceId}`;
              yield* sql`delete from client_companies where id in (${companyId}::uuid, ${successorCompanyId}::uuid)`;
              yield* sql`delete from platform_users where id in (${visitorId}, ${successorVisitorId})`;
              if (smithersRunsAvailable) {
                yield* sql`delete from _smithers_runs where run_id in (${smithersRunId}, ${smithersChildRunId})`;
              }
              if (smithersEvalCasesAvailable) {
                yield* sql`delete from _smithers_eval_cases where id = ${`case:${smithersRunId}`}`;
              }
              yield* sql`delete from ai_smithers_orphan_candidates where smithers_run_id in (${smithersRunId}, ${smithersChildRunId})`;
              yield* sql`delete from demo_sessions where visitor_id = ${visitorId}::uuid`;
              yield* sql`delete from chats where id = ${chatId}::uuid`;
              yield* sql`delete from client_company_memberships where company_id = ${companyId}::uuid and user_id = ${visitorId}`;
              yield* sql`delete from client_companies where id = ${companyId}::uuid`;
              yield* sql`delete from platform_users where id = ${visitorId}`;
              yield* sql`delete from platform_authorization_audit_log where actor_user_id = ${visitorId}`;
            }),
          );
        }),
      );
    }
  });
});
