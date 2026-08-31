import { PgClient } from "@effect/sql-pg";
import { Effect, Redacted } from "effect";
import { describe, expect, it } from "vitest";

import { makeRunAcceptanceScope } from "../../shared/src/chat";
import { createUserMessageAndRun, ensureDemoChat, loadChatRuntimeState } from "./chat-runtime";
import { deleteVisibleChatMessage, editLastUserMessage } from "./chat-mutations";

const databaseUrl = (
  globalThis as { readonly process?: { readonly env?: Record<string, string | undefined> } }
).process?.env?.WORKER_POSTGRES_TEST_DATABASE_URL;

const runDb = <A, E, R>(effect: Effect.Effect<A, E, R>): Promise<A> => {
  if (databaseUrl === undefined) throw new Error("WORKER_POSTGRES_TEST_DATABASE_URL is required");
  const pgEffect = effect as unknown as Effect.Effect<A, E, PgClient.PgClient>;
  return Effect.runPromise(
    pgEffect.pipe(
      Effect.provide(
        PgClient.layer({
          url: Redacted.make(databaseUrl),
          applicationName: "hartlib-chat-mutations-integration-test",
        }),
      ),
    ),
  );
};

describe.skipIf(databaseUrl === undefined)("singular chat mutations", () => {
  it("edits only the last user row and deletes one row without deleting run evidence", async () => {
    const userId = `mutation-test-${crypto.randomUUID()}`;
    const companyId = crypto.randomUUID();
    const chatId = crypto.randomUUID();
    const userMessageId = crypto.randomUUID();
    const lastUserMessageId = crypto.randomUUID();
    const assistantMessageId = crypto.randomUUID();
    const lastAssistantMessageId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const lastRunId = crypto.randomUUID();
    const sourceKey = "k_cn_0123456789abcdef012345_1";
    const lastCitationNamespace = "cn_abcdef0123456789abcdef";
    const lastSourceKey = `k_${lastCitationNamespace}_1`;
    const deletedMemoryId = crypto.randomUUID();
    const deletedRevisionId = crypto.randomUUID();
    const citationNamespace = "cn_0123456789abcdef012345";
    const config = {
      webResearchProvider: null,
      aiWebMaxDomainFilters: 8,
      aiProviderServiceId: "deterministic_test" as const,
      aiProviderEndpointIdentity: "deterministic_test:deterministic",
    };
    const acceptanceScope = makeRunAcceptanceScope({
      userId,
      chatId,
      companyId,
      memoryRevisionIds: [deletedRevisionId],
      provider: "deterministic_test",
      providerEndpointIdentity: "deterministic_test:deterministic",
    });

    try {
      await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            insert into platform_users (id, primary_email, display_name)
            values (${userId}, ${`${userId}@example.test`}, 'Mutation test')
          `;
          yield* sql`
            insert into client_companies (id, name) values (${companyId}::uuid, 'Mutation company')
          `;
          yield* sql`
            insert into client_company_memberships (company_id, user_id, role)
            values (${companyId}::uuid, ${userId}, 'admin')
          `;
          yield* sql`
            insert into client_company_ai_settings (company_id, web_search_enabled)
            values (${companyId}::uuid, false)
          `;
          yield* sql`
            insert into chats (id, user_id, company_id, memory_mode)
            values (${chatId}::uuid, ${userId}, ${companyId}::uuid, 'private_owner')
          `;
          yield* sql`
            insert into chat_messages (id, chat_id, author, content)
            values (${userMessageId}::uuid, ${chatId}::uuid, 'user', 'old question')
          `;
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`
                insert into user_memories (
                  id, user_id, kind, content, head_revision_id, source_message_id,
                  created_at, updated_at
                ) values (
                  ${deletedMemoryId}::uuid, ${userId}, 'fact', 'Retained mutation memory',
                  ${deletedRevisionId}::uuid, ${userMessageId}::uuid, now(), now()
                )
              `;
              yield* sql`
                insert into user_memory_revisions (
                  id, memory_id, action, state_before, state_after, run_id
                ) values (
                  ${deletedRevisionId}::uuid, ${deletedMemoryId}::uuid, 'create', null,
                  ${sql.json({ kind: "fact", content: "Retained mutation memory", deleted: false })},
                  null
                )
              `;
            }),
          );
          yield* sql`
            insert into ai_runs (
              id, chat_id, initiating_user_id, user_message_id, assistant_message_id,
              locale, market, citation_namespace, acceptance_scope, started_at, finished_at
            ) values (
              ${runId}::uuid, ${chatId}::uuid, ${userId}, ${userMessageId}::uuid,
              null, 'en-US', 'US', ${citationNamespace},
              ${sql.json(acceptanceScope)}, now(), now()
            )
          `;
          yield* sql`
            update user_memory_revisions
            set run_id = ${runId}::uuid
            where id = ${deletedRevisionId}::uuid
          `;
          yield* sql`
            insert into chat_messages (id, chat_id, author, content, assistant_ai_run_id)
            values (${assistantMessageId}::uuid, ${chatId}::uuid, 'assistant', 'answer', ${runId}::uuid)
          `;
          yield* sql`
            update ai_runs
            set assistant_message_id = ${assistantMessageId}::uuid
            where id = ${runId}::uuid
          `;
          yield* sql`
            insert into assistant_message_sources (
              run_id, assistant_message_id, source_key, kind, locator,
              public_provenance, source_identity_digest, citation_namespace,
              message_id
            ) values (
              ${runId}::uuid, ${assistantMessageId}::uuid, ${sourceKey}, 'chat_message',
              ${sql.json({ kind: "chat_message", messageId: userMessageId })}, '{}'::jsonb,
              ${"a".repeat(64)}, ${citationNamespace}, ${userMessageId}::uuid
            )
          `;
          yield* sql`
            insert into assistant_message_source_uses (
              run_id, assistant_message_id, source_key, consumer_task_id,
              rendered_token_count, context_order, ranges, source_use_identity_digest
            ) values (
              ${runId}::uuid, ${assistantMessageId}::uuid, ${sourceKey}, 'single-answer',
              3, 0, ${JSON.stringify([{ charStart: 0, charEnd: 3 }])}::jsonb, ${"b".repeat(64)}
            )
          `;
          yield* sql`
            insert into ai_source_exposures (
              run_id, task_id, loop_iteration, attempt, provider_request_index,
              source_kind, logical_source_identity, content_item_identity,
              exposure_stage, visible_token_count
            ) values (
              ${runId}::uuid, 'single-answer', 0, 0, 0, 'web',
              'web:mutation-test', 'web:mutation-test', 'retrieval', 1
            )
          `;
          yield* sql`
            insert into ai_observations (run_id, chat_id, kind, payload, emitting_task, observation_key)
            values (${runId}::uuid, ${chatId}::uuid, 'mutation-test', '{}'::jsonb, 'mutation-test', 'mutation-observation')
          `;
          yield* sql`
            insert into ai_run_usage (
              run_id, task_id, loop_iteration, attempt, provider_request_index,
              agent_role, model_id, input_tokens, output_tokens, cached_tokens,
              reasoning_tokens, total_tokens, stop_reason, provider_service_id
            ) values (
              ${runId}::uuid, 'single-answer', 0, 0, 0, 'main', 'glm-5-turbo',
              2, 3, 0, 0, 5, 'stop', 'deterministic_test'
            )
          `;

          yield* sql`
            insert into chat_messages (id, chat_id, author, content)
            values (${lastUserMessageId}::uuid, ${chatId}::uuid, 'user', 'last question')
          `;
          yield* sql`
            insert into ai_runs (
              id, chat_id, initiating_user_id, user_message_id, assistant_message_id,
              locale, market, citation_namespace, acceptance_scope, started_at, finished_at
            ) values (
              ${lastRunId}::uuid, ${chatId}::uuid, ${userId}, ${lastUserMessageId}::uuid,
              null, 'en-US', 'US', ${lastCitationNamespace},
              ${sql.json(acceptanceScope)}, now(), now()
            )
          `;
          yield* sql`
            insert into chat_messages (id, chat_id, author, content, assistant_ai_run_id)
            values (${lastAssistantMessageId}::uuid, ${chatId}::uuid, 'assistant', 'last answer', ${lastRunId}::uuid)
          `;
          yield* sql`
            update ai_runs
            set assistant_message_id = ${lastAssistantMessageId}::uuid
            where id = ${lastRunId}::uuid
          `;
          yield* sql`
            insert into assistant_message_sources (
              run_id, assistant_message_id, source_key, kind, locator,
              public_provenance, source_identity_digest, citation_namespace,
              message_id
            ) values (
              ${lastRunId}::uuid, ${lastAssistantMessageId}::uuid, ${lastSourceKey}, 'chat_message',
              ${sql.json({ kind: "chat_message", messageId: lastUserMessageId })}, '{}'::jsonb,
              ${"c".repeat(64)}, ${lastCitationNamespace}, ${lastUserMessageId}::uuid
            )
          `;
          yield* sql`
            insert into assistant_message_source_uses (
              run_id, assistant_message_id, source_key, consumer_task_id,
              rendered_token_count, context_order, ranges, source_use_identity_digest
            ) values (
              ${lastRunId}::uuid, ${lastAssistantMessageId}::uuid, ${lastSourceKey}, 'single-answer',
              4, 0, ${JSON.stringify([{ charStart: 0, charEnd: 4 }])}::jsonb, ${"d".repeat(64)}
            )
          `;
          yield* sql`
            insert into ai_source_exposures (
              run_id, task_id, loop_iteration, attempt, provider_request_index,
              source_kind, logical_source_identity, content_item_identity,
              exposure_stage, visible_token_count
            ) values (
              ${lastRunId}::uuid, 'single-answer', 0, 0, 0, 'web',
              'web:last-mutation-test', 'web:last-mutation-test', 'retrieval', 1
            )
          `;
          yield* sql`
            insert into ai_observations (run_id, chat_id, kind, payload, emitting_task, observation_key)
            values (${lastRunId}::uuid, ${chatId}::uuid, 'last-mutation-test', '{}'::jsonb, 'mutation-test', 'last-mutation-observation')
          `;
          yield* sql`
            insert into ai_run_usage (
              run_id, task_id, loop_iteration, attempt, provider_request_index,
              agent_role, model_id, input_tokens, output_tokens, cached_tokens,
              reasoning_tokens, total_tokens, stop_reason, provider_service_id
            ) values (
              ${lastRunId}::uuid, 'single-answer', 0, 0, 0, 'main', 'glm-5-turbo',
              3, 4, 0, 0, 7, 'stop', 'deterministic_test'
            )
          `;

          const nonLastEdit = yield* editLastUserMessage(
            userId,
            userMessageId,
            { text: "new question", locale: "en-US", market: "US", webSearchEnabled: false },
            config,
          );
          expect(nonLastEdit).toEqual({ kind: "not_found" });
          expect(
            (yield* sql`select content from chat_messages where id = ${userMessageId}::uuid`)[0]
              ?.content,
          ).toBe("old question");

          const edited = yield* editLastUserMessage(
            userId,
            lastUserMessageId,
            { text: "new last question", locale: "en-US", market: "US", webSearchEnabled: false },
            config,
          );
          expect(edited.kind).toBe("accepted");
          if (edited.kind !== "accepted") return;

          const oldRun = yield* sql<{ readonly superseded: Date | null }>`
            select superseded_at as superseded from ai_runs where id = ${lastRunId}::uuid
          `;
          expect(oldRun[0]?.superseded).not.toBeNull();
          expect(
            yield* sql`select 1 from chat_messages where id = ${lastAssistantMessageId}::uuid`,
          ).toHaveLength(0);
          expect(
            (yield* sql`select content from chat_messages where id = ${lastUserMessageId}::uuid`)[0]
              ?.content,
          ).toBe("new last question");

          const replacementRuns = yield* sql<{
            readonly id: string;
            readonly startedAt: Date | null;
            readonly finishedAt: Date | null;
            readonly failedAt: Date | null;
            readonly stoppedAt: Date | null;
            readonly supersededAt: Date | null;
          }>`
            select id::text, started_at as "startedAt", finished_at as "finishedAt",
                   failed_at as "failedAt", stopped_at as "stoppedAt", superseded_at as "supersededAt"
            from ai_runs
            where user_message_id = ${lastUserMessageId}::uuid and id <> ${lastRunId}::uuid
          `;
          expect(replacementRuns).toHaveLength(1);
          expect(replacementRuns[0]).toMatchObject({
            startedAt: null,
            finishedAt: null,
            failedAt: null,
            stoppedAt: null,
            supersededAt: null,
          });

          const evidence = yield* sql<{ readonly assistant: string | null }>`
            select assistant_message_id::text as assistant
            from assistant_message_sources
            where run_id = ${runId}::uuid and source_key = ${sourceKey}
          `;
          expect(evidence[0]?.assistant).toBe(assistantMessageId);
          expect(
            yield* sql`select 1 from assistant_message_source_uses where run_id = ${runId}::uuid and source_key = ${sourceKey}`,
          ).toHaveLength(1);
          const editedEvidence = yield* sql<{ readonly assistant: string | null }>`
            select assistant_message_id::text as assistant
            from assistant_message_sources
            where run_id = ${lastRunId}::uuid and source_key = ${lastSourceKey}
          `;
          expect(editedEvidence).toEqual([{ assistant: null }]);
          expect(
            yield* sql`select 1 from assistant_message_source_uses where run_id = ${lastRunId}::uuid and source_key = ${lastSourceKey}`,
          ).toHaveLength(1);
          expect(
            yield* sql`select 1 from ai_source_exposures where run_id = ${lastRunId}::uuid`,
          ).toHaveLength(1);
          expect(
            yield* sql`select 1 from ai_observations where run_id = ${lastRunId}::uuid`,
          ).toHaveLength(1);
          expect(
            yield* sql`select 1 from ai_run_usage where run_id = ${lastRunId}::uuid`,
          ).toHaveLength(1);

          const deleted = yield* deleteVisibleChatMessage(userId, userMessageId);
          expect(deleted).toEqual({ kind: "accepted" });
          expect(
            yield* sql`select 1 from chat_messages where id = ${userMessageId}::uuid`,
          ).toHaveLength(0);
          expect(
            yield* sql`select 1 from chat_messages where id = ${assistantMessageId}::uuid`,
          ).toHaveLength(1);
          expect(
            yield* sql`select 1 from assistant_message_sources where run_id = ${runId}::uuid and source_key = ${sourceKey}`,
          ).toHaveLength(1);
          expect(
            yield* sql`select 1 from assistant_message_source_uses where run_id = ${runId}::uuid and source_key = ${sourceKey}`,
          ).toHaveLength(1);
          expect(
            yield* sql`select 1 from ai_source_exposures where run_id = ${runId}::uuid`,
          ).toHaveLength(1);
          expect(
            yield* sql`select 1 from ai_observations where run_id = ${runId}::uuid`,
          ).toHaveLength(1);
          expect(yield* sql`select 1 from ai_run_usage where run_id = ${runId}::uuid`).toHaveLength(
            1,
          );
          expect(
            yield* sql`select 1 from user_memories where id = ${deletedMemoryId}::uuid and source_message_id is null`,
          ).toHaveLength(1);
          expect(
            yield* sql`select 1 from user_memory_revisions where id = ${deletedRevisionId}::uuid and run_id = ${runId}::uuid`,
          ).toHaveLength(1);
        }),
      );
    } finally {
      await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`set local hartlib.allow_account_purge = 'on'`;
              yield* sql`
                delete from jobs
                where payload->>'aiRunId' in (select id::text from ai_runs where chat_id = ${chatId}::uuid)
              `;
              yield* sql`delete from chats where id = ${chatId}::uuid`;
              yield* sql`delete from client_company_memberships where company_id = ${companyId}::uuid and user_id = ${userId}`;
              yield* sql`delete from client_company_ai_settings where company_id = ${companyId}::uuid`;
              yield* sql`delete from client_companies where id = ${companyId}::uuid`;
              yield* sql`delete from platform_users where id = ${userId}`;
            }),
          );
        }),
      );
    }
  });

  it("waits for a held finalization lease before projecting the complete chat", async () => {
    const userId = `read-lease-${crypto.randomUUID()}`;
    const companyId = crypto.randomUUID();
    const chatId = crypto.randomUUID();
    const userMessageId = crypto.randomUUID();
    const assistantMessageId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const citationNamespace = "cn_0123456789abcdef012345";
    const sourceKey = `k_${citationNamespace}_1`;
    const config = {
      webResearchProvider: null,
      aiWebMaxDomainFilters: 8,
      aiProviderServiceId: "deterministic_test" as const,
      aiProviderEndpointIdentity: "deterministic_test:deterministic",
    };
    const acceptanceScope = makeRunAcceptanceScope({
      userId,
      chatId,
      companyId,
      provider: "deterministic_test",
      providerEndpointIdentity: "deterministic_test:deterministic",
    });
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });

    try {
      await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`insert into platform_users (id, primary_email, display_name) values (${userId}, ${`${userId}@example.test`}, 'Read lease test')`;
          yield* sql`insert into client_companies (id, name) values (${companyId}::uuid, 'Read lease company')`;
          yield* sql`insert into client_company_memberships (company_id, user_id, role) values (${companyId}::uuid, ${userId}, 'admin')`;
          yield* sql`insert into chats (id, user_id, company_id, memory_mode) values (${chatId}::uuid, ${userId}, ${companyId}::uuid, 'private_owner')`;
          yield* sql`insert into chat_messages (id, chat_id, author, content) values (${userMessageId}::uuid, ${chatId}::uuid, 'user', 'question')`;
          yield* sql`insert into ai_runs (id, chat_id, initiating_user_id, user_message_id, locale, market, citation_namespace, acceptance_scope) values (${runId}::uuid, ${chatId}::uuid, ${userId}, ${userMessageId}::uuid, 'en-US', 'US', ${citationNamespace}, ${sql.json(acceptanceScope)})`;
        }),
      );

      const holder = runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql.withTransaction(
            Effect.gen(function* () {
              // Match the worker's transaction leases. The read must wait on
              // this memory lane before it can begin any projection query.
              yield* sql`select pg_advisory_xact_lock(hashtext(${`hartlib:user-memory:${userId}`}))`;
              yield* sql`select pg_advisory_xact_lock(hashtext(${`hartlib:client-members:${companyId}`}))`;
              yield* sql`select pg_advisory_xact_lock(hashtext(${`hartlib:ai-chat:${chatId}`}))`;
              yield* sql`insert into chat_messages (id, chat_id, author, content, assistant_ai_run_id) values (${assistantMessageId}::uuid, ${chatId}::uuid, 'assistant', ${`answer [[cite:${sourceKey}]]`}, ${runId}::uuid)`;
              yield* sql`update ai_runs set assistant_message_id = ${assistantMessageId}::uuid, finished_at = now() where id = ${runId}::uuid`;
              yield* sql`insert into assistant_message_sources (run_id, source_key, assistant_message_id, kind, locator, public_provenance, source_identity_digest, citation_namespace) values (${runId}::uuid, ${sourceKey}, ${assistantMessageId}::uuid, 'web', ${sql.json({ kind: "web", url: "https://example.com/article", title: "Article", domain: "example.com", quote: "Quote", quoteHash: "60zevYK_EZRK8EDTD4qmiPv0yDb0bdjEFUrfQNwoasY", capturedAt: new Date().toISOString() })}, ${sql.json({ citationUrl: "https://example.com/article" })}, ${"a".repeat(64)}, ${citationNamespace})`;
              signalStarted();
              yield* sql`select pg_sleep(0.75)`;
            }),
          );
        }),
      );
      await started;

      const loaded = await runDb(loadChatRuntimeState({ userId }, config));
      await holder;
      const assistant = loaded.messages.find((message) => message.id === assistantMessageId);
      expect(assistant?.content).toBe(`answer [[cite:${sourceKey}]]`);
      expect(loaded.runs.find((run) => run.id === runId)?.finished_at).not.toBeNull();
      expect(loaded.sourceRows).toEqual(
        expect.arrayContaining([expect.objectContaining({ run_id: runId, source_key: sourceKey })]),
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
              yield* sql`delete from client_company_ai_settings where company_id = ${companyId}::uuid`;
              yield* sql`delete from client_companies where id = ${companyId}::uuid`;
              yield* sql`delete from platform_users where id = ${userId}`;
            }),
          );
        }),
      );
    }
  });

  it("serializes send and edit acceptance on memory and company leases", async () => {
    const userId = `acceptance-lease-${crypto.randomUUID()}`;
    const input = {
      text: "lease question",
      locale: "en-US",
      market: "US",
      webSearchEnabled: false,
    };
    const config = {
      webResearchProvider: null,
      aiWebMaxDomainFilters: 8,
      aiProviderServiceId: "deterministic_test" as const,
      aiProviderEndpointIdentity: "deterministic_test:deterministic",
    };
    let companyId: string | undefined;
    let chatId: string | undefined;
    let releaseMemory!: () => void;
    let releaseCompany!: () => void;
    let memoryReady!: () => void;
    let companyReady!: () => void;
    const memoryReleased = new Promise<void>((resolve) => {
      releaseMemory = resolve;
    });
    const companyReleased = new Promise<void>((resolve) => {
      releaseCompany = resolve;
    });
    const memoryLockReady = new Promise<void>((resolve) => {
      memoryReady = resolve;
    });
    const companyLockReady = new Promise<void>((resolve) => {
      companyReady = resolve;
    });
    let memoryHolder: Promise<unknown> | undefined;
    let companyHolder: Promise<unknown> | undefined;
    let sendPromise: Promise<unknown> | undefined;
    let editPromise: Promise<unknown> | undefined;

    try {
      const chat = await runDb(ensureDemoChat(userId));
      companyId = chat.company_id;
      chatId = chat.id;

      memoryHolder = runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`select pg_advisory_xact_lock(hashtext(${`hartlib:user-memory:${userId}`}))`;
              yield* Effect.sync(memoryReady);
              yield* Effect.promise(() => memoryReleased);
            }),
          );
        }),
      );
      companyHolder = runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`select pg_advisory_xact_lock(hashtext(${`hartlib:client-members:${companyId}`}))`;
              yield* Effect.sync(companyReady);
              yield* Effect.promise(() => companyReleased);
            }),
          );
        }),
      );
      await Promise.all([memoryLockReady, companyLockReady]);

      let sendSettled = false;
      sendPromise = runDb(createUserMessageAndRun(userId, input, config)).then((result) => {
        sendSettled = true;
        return result;
      });
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(sendSettled).toBe(false);
      releaseMemory();
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(sendSettled).toBe(false);
      releaseCompany();
      const accepted = await sendPromise;
      expect(accepted).toMatchObject({ kind: "accepted" });
      if (!isAcceptedMutation(accepted)) throw new Error("send did not return an accepted run");

      await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`update ai_runs set finished_at = now() where id = ${accepted.runId}::uuid`;
        }),
      );

      let editSettled = false;
      releaseCompany = () => undefined;
      const editReleased = new Promise<void>((resolve) => {
        releaseCompany = resolve;
      });
      companyReady = () => undefined;
      const editCompanyReady = new Promise<void>((resolve) => {
        companyReady = resolve;
      });
      companyHolder = runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`select pg_advisory_xact_lock(hashtext(${`hartlib:client-members:${companyId}`}))`;
              yield* Effect.sync(companyReady);
              yield* Effect.promise(() => editReleased);
            }),
          );
        }),
      );
      await editCompanyReady;
      editPromise = runDb(
        editLastUserMessage(
          userId,
          accepted.message.id,
          { ...input, text: "edited lease question" },
          config,
        ),
      ).then((result) => {
        editSettled = true;
        return result;
      });
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(editSettled).toBe(false);
      releaseCompany();
      const edited = await editPromise;
      expect(edited).toMatchObject({ kind: "accepted", messageId: accepted.message.id });
    } finally {
      releaseMemory?.();
      releaseCompany?.();
      await Promise.allSettled(
        [memoryHolder, companyHolder, sendPromise, editPromise].filter(Boolean),
      );
      if (chatId !== undefined && companyId !== undefined) {
        await runDb(
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`set local hartlib.allow_account_purge = 'on'`;
                yield* sql`delete from jobs where payload->>'aiRunId' in (select id::text from ai_runs where chat_id = ${chatId}::uuid)`;
                yield* sql`delete from chats where id = ${chatId}::uuid`;
                yield* sql`delete from client_company_public_source_settings where client_company_id = ${companyId}::uuid`;
                yield* sql`delete from client_company_ai_settings where company_id = ${companyId}::uuid`;
                yield* sql`delete from client_company_memberships where company_id = ${companyId}::uuid and user_id = ${userId}`;
                yield* sql`delete from client_companies where id = ${companyId}::uuid`;
                yield* sql`delete from platform_users where id = ${userId}`;
              }),
            );
          }),
        );
      }
    }
  });
});

const isAcceptedMutation = (
  result: unknown,
): result is {
  readonly kind: "accepted";
  readonly runId: string;
  readonly message: { readonly id: string };
} =>
  typeof result === "object" &&
  result !== null &&
  (result as { readonly kind?: unknown }).kind === "accepted" &&
  typeof (result as { readonly runId?: unknown }).runId === "string" &&
  typeof (result as { readonly message?: { readonly id?: unknown } }).message?.id === "string";
