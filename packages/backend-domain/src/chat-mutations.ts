import { PgClient } from "@effect/sql-pg";
import { makeRunAcceptanceScope } from "@hartlib/shared/chat";
import { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";

import {
  readEffectiveWebPolicy,
  type ChatRuntimeConfiguration,
  type CreateChatRunInput,
} from "./chat-runtime";

export type ChatMutationResult =
  | { readonly kind: "not_found" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "web_unavailable"; readonly policy: { readonly reason: string } }
  | {
      readonly kind: "accepted";
      readonly messageId: string;
      readonly runId: string;
      readonly createdAt: Date;
    };

export type StopRunResult =
  | { readonly kind: "not_found" }
  | { readonly kind: "accepted"; readonly runId: string; readonly terminal: boolean };

const jsonSql = (sql: SqlClient): SqlClient & { readonly json: (value: unknown) => unknown } =>
  sql as SqlClient & { readonly json: (value: unknown) => unknown };

const randomCitationNamespace = (): string => crypto.randomUUID().replaceAll("-", "").slice(0, 22);

/** Persist a stop request against the run, with terminal completion winning a race. */
export const requestAiRunStop = (
  userId: string,
  runId: string,
): Effect.Effect<StopRunResult, unknown, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const rows = yield* sql<{
          readonly id: string;
          readonly finishedAt: Date | null;
          readonly failedAt: Date | null;
          readonly stoppedAt: Date | null;
          readonly supersededAt: Date | null;
        }>`
          select run.id::text as id, run.finished_at as "finishedAt", run.failed_at as "failedAt",
                 run.stopped_at as "stoppedAt", run.superseded_at as "supersededAt"
          from ai_runs run
          join chats chat on chat.id = run.chat_id and chat.user_id = ${userId}
          where run.id = ${runId}
          for update
        `;
        const run = rows[0];
        if (run === undefined) return { kind: "not_found" } as const;
        if (
          run.finishedAt !== null ||
          run.failedAt !== null ||
          run.stoppedAt !== null ||
          run.supersededAt !== null
        ) {
          return { kind: "accepted", runId: run.id, terminal: true } as const;
        }
        yield* sql`
          update ai_runs set stop_requested_at = coalesce(stop_requested_at, now())
          where id = ${run.id} and finished_at is null and failed_at is null and stopped_at is null and superseded_at is null
        `;
        return { kind: "accepted", runId: run.id, terminal: false } as const;
      }),
    );
  });

const sourceSelections = (sql: SqlClient, companyId: string, userId: string, memoryMode: string) =>
  Effect.gen(function* () {
    const publicRows = yield* sql<{ readonly id: string }>`
      select source_id as id from client_company_public_source_settings
      where client_company_id = ${companyId} and enabled order by source_id
    `;
    const memoryRows =
      memoryMode === "private_owner"
        ? yield* sql<{ readonly id: string }>`
          select head_revision_id::text as id from user_memories
          where user_id = ${userId} and deleted_at is null and provenance_only_at is null and head_revision_id is not null
          order by head_revision_id::text
        `
        : [];
    return {
      publicSourceIds: publicRows.map((row) => row.id),
      memoryRevisionIds: memoryRows.map((row) => row.id),
    };
  });

const insertReplacementRun = (
  sql: SqlClient & { readonly json: (value: unknown) => unknown },
  chat: {
    readonly id: string;
    readonly company_id: string;
    readonly memory_mode: "private_owner" | "disabled";
  },
  userId: string,
  input: CreateChatRunInput & { readonly messageId: string },
  config: ChatRuntimeConfiguration,
  effectivePolicy: unknown,
) =>
  Effect.gen(function* () {
    const selections = yield* sourceSelections(sql, chat.company_id, userId, chat.memory_mode);
    const acceptanceScope = makeRunAcceptanceScope({
      userId,
      chatId: chat.id,
      companyId: chat.company_id,
      publicSourceIds: selections.publicSourceIds,
      memoryMode: chat.memory_mode,
      memoryRevisionIds: selections.memoryRevisionIds,
      webRequested: input.webSearchEnabled,
      webEnabled:
        input.webSearchEnabled &&
        (effectivePolicy as { readonly enabled?: boolean }).enabled === true,
      provider: config.aiProviderServiceId,
      providerEndpointIdentity: config.aiProviderEndpointIdentity,
      webTransportProvider:
        input.webSearchEnabled &&
        (effectivePolicy as { readonly enabled?: boolean }).enabled === true
          ? "tinyfish"
          : null,
      allowedDomains:
        input.webSearchEnabled &&
        (effectivePolicy as { readonly enabled?: boolean }).enabled === true
          ? ((effectivePolicy as { readonly allowedDomains?: readonly string[] }).allowedDomains ??
            null)
          : null,
    });
    const rows = yield* sql<{ readonly id: string }>`
      insert into ai_runs (
        chat_id, initiating_user_id, user_message_id, locale, market,
        citation_namespace, acceptance_scope, web_search_enabled, effective_web_policy
      ) values (
        ${chat.id}, ${userId}, ${input.messageId}, ${input.locale}, ${input.market},
        ${`cn_${randomCitationNamespace()}`}, ${sql.json(acceptanceScope)},
        ${input.webSearchEnabled}, ${sql.json(effectivePolicy)}
      ) returning id::text
    `;
    const runId = rows[0]?.id;
    if (runId === undefined) return yield* Effect.fail(new Error("replacement_run_not_created"));
    yield* sql`
      insert into jobs (kind, payload, unique_key, priority)
      values ('ai_chat_run', ${sql.json({ aiRunId: runId })}, ${`ai_chat_run:${runId}`}, 100)
      on conflict (unique_key) where unique_key is not null do nothing
    `;
    return runId;
  });

/** Replace the last visible user question while retaining its row identity. */
export const editLastUserMessage = (
  userId: string,
  messageId: string,
  input: CreateChatRunInput,
  config: ChatRuntimeConfiguration,
): Effect.Effect<ChatMutationResult, unknown, PgClient.PgClient | SqlClient> =>
  Effect.gen(function* () {
    const sql = jsonSql(yield* PgClient.PgClient);
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`select pg_advisory_xact_lock(hashtext(${`hartlib:user-memory:${userId}`}))`;
        yield* sql`select pg_advisory_xact_lock(hashtext(${`hartlib:ai-chat:${userId}`}))`;
        const chatRows = yield* sql<{
          readonly id: string;
          readonly company_id: string;
          readonly memory_mode: "private_owner" | "disabled";
        }>`
          select id::text, company_id::text, memory_mode from chats where user_id = ${userId} for update
        `;
        const chat = chatRows[0];
        if (chat === undefined) return { kind: "forbidden" } as const;
        // Finalization takes the same chat advisory lane after it locks the
        // chat row. Holding it here makes edit and completion one serial
        // decision even when the worker is about to publish an assistant row.
        yield* sql`select pg_advisory_xact_lock(hashtext(${`hartlib:client-members:${chat.company_id}`}))`;
        yield* sql`select pg_advisory_xact_lock(hashtext(${`hartlib:ai-chat:${chat.id}`}))`;
        const effectivePolicy = yield* readEffectiveWebPolicy(chat, config, true);
        if (
          input.webSearchEnabled &&
          (effectivePolicy as { readonly enabled?: boolean }).enabled !== true
        ) {
          return {
            kind: "web_unavailable",
            policy: {
              reason:
                typeof (effectivePolicy as { readonly reason?: unknown }).reason === "string"
                  ? (effectivePolicy as { readonly reason: string }).reason
                  : "deployment_unavailable",
            },
          } as const;
        }
        const messages = yield* sql<{ readonly id: string; readonly createdAt: Date }>`
          select id::text, created_at as "createdAt" from chat_messages
          where id = ${messageId} and chat_id = ${chat.id} and author = 'user'
        `;
        const message = messages[0];
        if (message === undefined) return { kind: "not_found" } as const;
        const later = yield* sql<{ readonly exists: boolean }>`
          select exists(
            select 1 from chat_messages candidate
            where candidate.chat_id = ${chat.id} and candidate.author = 'user'
              and (candidate.created_at, candidate.id) > (select created_at, id from chat_messages where id = ${message.id})
          ) as exists
        `;
        if (later[0]?.exists === true) return { kind: "not_found" } as const;
        const runs = yield* sql<{
          readonly id: string;
          readonly assistantId: string | null;
          readonly finishedAt: Date | null;
          readonly failedAt: Date | null;
          readonly stoppedAt: Date | null;
          readonly supersededAt: Date | null;
        }>`
          select id::text, assistant_message_id::text as "assistantId", finished_at as "finishedAt",
                 failed_at as "failedAt", stopped_at as "stoppedAt", superseded_at as "supersededAt"
          from ai_runs where user_message_id = ${message.id} and chat_id = ${chat.id}
          order by created_at desc, id desc limit 1 for update
        `;
        const oldRun = runs[0];
        if (oldRun !== undefined) {
          // Editing replaces the prior answer even when its worker already
          // reached a terminal state. Clear the old terminal marker before
          // recording superseded_at so the final-state check remains a single
          // value, while retaining the run row and every derived ledger row.
          yield* sql`
            update ai_runs
            set finished_at = null,
                failed_at = null,
                stopped_at = null,
                error_code = null,
                retryable = null,
                superseded_at = coalesce(superseded_at, now()),
                stop_requested_at = case
                  when finished_at is null and failed_at is null and stopped_at is null and superseded_at is null
                    then coalesce(stop_requested_at, now())
                  else stop_requested_at
                end
            where id = ${oldRun.id}
          `;
        }
        if (oldRun?.assistantId !== null && oldRun?.assistantId !== undefined) {
          yield* sql`delete from chat_messages where id = ${oldRun.assistantId} and author = 'assistant'`;
        }
        yield* sql`update chat_messages set content = ${input.text} where id = ${message.id}`;
        const runId = yield* insertReplacementRun(
          sql,
          chat,
          userId,
          { ...input, messageId: message.id },
          config,
          effectivePolicy,
        );
        return {
          kind: "accepted",
          messageId: message.id,
          runId,
          createdAt: message.createdAt,
        } as const;
      }),
    );
  });

/** Delete one visible row while retaining its paired run and derived evidence. */
export const deleteVisibleChatMessage = (
  userId: string,
  messageId: string,
): Effect.Effect<
  { readonly kind: "accepted" | "not_found" | "forbidden" },
  unknown,
  PgClient.PgClient
> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`select pg_advisory_xact_lock(hashtext(${`hartlib:user-memory:${userId}`}))`;
        yield* sql`select pg_advisory_xact_lock(hashtext(${`hartlib:ai-chat:${userId}`}))`;
        const chats = yield* sql<{ readonly id: string; readonly company_id: string }>`
          select id::text, company_id::text from chats where user_id = ${userId} for update
        `;
        const chat = chats[0];
        if (chat === undefined) return { kind: "forbidden" } as const;
        yield* sql`select pg_advisory_xact_lock(hashtext(${`hartlib:client-members:${chat.company_id}`}))`;
        yield* sql`select pg_advisory_xact_lock(hashtext(${`hartlib:ai-chat:${chat.id}`}))`;
        const rows = yield* sql<{ readonly id: string; readonly runId: string | null }>`
          select message.id::text as id, run.id::text as "runId"
          from chat_messages message
          left join lateral (
            select candidate.id
            from ai_runs candidate
            where candidate.user_message_id = message.id or candidate.assistant_message_id = message.id
            order by candidate.created_at desc, candidate.id desc
            limit 1
          ) run on true
          where message.chat_id = ${chat.id} and message.id = ${messageId}
          for update of message
        `;
        const row = rows[0];
        if (row === undefined) return { kind: "not_found" } as const;
        if (row.runId !== null) {
          yield* sql`
            update ai_runs set
              stop_requested_at = case
                when finished_at is null and failed_at is null and stopped_at is null and superseded_at is null
                  then coalesce(stop_requested_at, now())
                else stop_requested_at
              end,
              superseded_at = case
                when finished_at is null and failed_at is null and stopped_at is null and superseded_at is null
                  then now()
                else superseded_at
              end
            where id = ${row.runId}
          `;
        }
        yield* sql`delete from chat_messages where id = ${row.id}`;
        return { kind: "accepted" } as const;
      }),
    );
  });
