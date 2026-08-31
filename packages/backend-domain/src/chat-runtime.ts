import { PgClient } from "@effect/sql-pg";
import {
  AiRunEvent,
  deriveEffectiveWebPolicy,
  makeRunAcceptanceScope,
  normalizeDomainAllowlist,
  type AiProviderEndpointIdentity,
  type AiProviderServiceId,
  type AiRunActivityEvent,
  type EffectiveWebPolicy,
  type PublicAiRunDebug,
  type PublicAiRunDebugEvent,
} from "@hartlib/shared";
import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";

import { minimumReadablePublicSourceTextChars } from "./public-sources";

const randomCitationNamespace = (): string => crypto.randomUUID().replaceAll("-", "").slice(0, 22);

export interface ChatRuntimeConfiguration {
  readonly webResearchProvider: "tinyfish" | null;
  readonly aiWebMaxDomainFilters: number;
  readonly aiProviderServiceId: AiProviderServiceId;
  readonly aiProviderEndpointIdentity: AiProviderEndpointIdentity;
}

export interface ChatRuntimeReadIdentity {
  readonly userId: string;
}

export interface ChatRow {
  readonly id: string;
  readonly user_id: string;
  readonly company_id: string;
  readonly memory_mode: "private_owner" | "disabled";
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface MessageRow {
  readonly id: string;
  readonly chat_id?: string;
  readonly author: "user" | "assistant";
  readonly content: string;
  readonly created_at: Date;
}

export interface RunRow {
  readonly id: string;
  readonly chat_id: string;
  readonly user_message_id: string | null;
  readonly assistant_message_id: string | null;
  readonly started_at: Date | null;
  readonly finished_at: Date | null;
  readonly failed_at: Date | null;
  readonly stopped_at: Date | null;
  readonly superseded_at: Date | null;
  readonly error_code: string | null;
  readonly retryable: boolean | null;
}

export interface SourceRow {
  readonly run_id: string;
  readonly assistant_message_id: string | null;
  readonly source_key: string;
  readonly citation_namespace: string;
  readonly source_id?: string | null;
  readonly canonical_url?: string | null;
  readonly document_id?: string | null;
  readonly snapshot_id?: string | null;
  readonly content_hash?: string | null;
  readonly source_identity_digest?: string | null;
  readonly source_identity_valid?: boolean;
  readonly message_id?: string | null;
  readonly memory_revision_id?: string | null;
  readonly document_text?: string | null;
  readonly memory_revision_text?: string | null;
  readonly memory_revision_deleted?: boolean | null;
  readonly kind: "document" | "chat_message" | "memory" | "web";
  readonly locator: unknown;
  readonly display_label: string | null;
  readonly public_provenance: unknown;
}

export interface SourceUseRow {
  readonly run_id: string;
  readonly assistant_message_id: string | null;
  readonly source_key: string;
  readonly consumer_task_id: string;
  readonly topic_id: "t1" | "t2" | "t3" | null;
  readonly rendered_token_count: number;
  readonly context_order: number;
  readonly ranges?: unknown;
  readonly source_use_identity_digest?: string | null;
  readonly source_use_identity_valid?: boolean;
}

export type ActiveRunRow = RunRow;

export interface RunStreamContext {
  readonly runId: string;
  readonly chatId: string;
}

export interface AiRunEventRow {
  readonly seq: number;
  readonly event: unknown;
}

export interface AuthorizedAiRunEventPoll {
  readonly authorized: boolean;
  readonly events: readonly AiRunEventRow[];
  readonly terminal: boolean;
  readonly replayableTerminal: boolean;
}

export const effectiveWebPolicy = (args: {
  readonly companyEnabled: boolean;
  readonly allowedDomains: readonly string[] | null;
  readonly adapterAvailable: boolean;
  readonly provider: "tinyfish" | null;
  readonly allowlistSupported: boolean;
  readonly maxDomainFilters: number;
}): EffectiveWebPolicy => deriveEffectiveWebPolicy(args);

export { normalizeDomainAllowlist };

const deploymentPolicy = (config: ChatRuntimeConfiguration) => ({
  adapterAvailable: config.webResearchProvider === "tinyfish",
  provider: config.webResearchProvider,
  allowlistSupported: config.webResearchProvider === "tinyfish",
  maxDomainFilters: config.aiWebMaxDomainFilters,
});

const publicSourceSettings = (sql: SqlClient, companyId: string, userId: string) =>
  sql`
    insert into client_company_public_source_settings (
      client_company_id, source_id, enabled, updated_by_user_id
    )
    select ${companyId}, source.source_id, true, ${userId}
    from public_sources source
    where source.source_id not like 'eval-%'
      and source.discovery_url not like 'https://evaluation.invalid/%'
    on conflict (client_company_id, source_id) do nothing
  `;

/** Create the deterministic demo company and its single chat under one lock. */
const ensureDemoChatInTransaction = (userId: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    yield* sql`select pg_advisory_xact_lock(hashtext(${`hartlib:demo-chat:${userId}`}))`;
    yield* sql`
      insert into platform_users (id, primary_email, display_name)
      values (
        ${userId},
        ${`demo+${encodeURIComponent(userId)}@hartlib.invalid`},
        ${`Demo ${userId}`}
      )
      on conflict (id) do nothing
    `;
    const companyRows = yield* sql<{ readonly id: string }>`
      insert into client_companies (id, name)
      values (
        (
          substr(md5(${"hartlib:client-company:" + userId}), 1, 8) || '-' ||
          substr(md5(${"hartlib:client-company:" + userId}), 9, 4) || '-' ||
          substr(md5(${"hartlib:client-company:" + userId}), 13, 4) || '-' ||
          substr(md5(${"hartlib:client-company:" + userId}), 17, 4) || '-' ||
          substr(md5(${"hartlib:client-company:" + userId}), 21, 12)
        )::uuid,
        ${`Demo company for ${userId}`}
      )
      on conflict (id) do update set updated_at = client_companies.updated_at
      returning id::text
    `;
    const companyId = companyRows[0]?.id;
    if (companyId === undefined) return yield* Effect.fail(new Error("company_not_found"));
    yield* sql`
      insert into client_company_memberships (company_id, user_id, role)
      values (${companyId}, ${userId}, 'admin')
      on conflict (company_id, user_id) do update set
        role = 'admin', revoked_at = null, revoked_by_user_id = null
    `;
    yield* sql`
      insert into client_company_ai_settings (company_id, web_search_enabled)
      values (${companyId}, true)
      on conflict (company_id) do nothing
    `;
    yield* publicSourceSettings(sql, companyId, userId);
    const rows = yield* sql<ChatRow>`
      insert into chats (user_id, company_id, memory_mode)
      values (${userId}, ${companyId}, 'private_owner')
      on conflict (user_id) do update set updated_at = chats.updated_at
      returning id::text, user_id, company_id::text, memory_mode, created_at, updated_at
    `;
    const chat = rows[0];
    if (chat === undefined) return yield* Effect.fail(new Error("chat_not_found"));
    return chat;
  });

export const ensureDemoChat = (userId: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(ensureDemoChatInTransaction(userId));
  });

export const readEffectiveWebPolicy = (
  chat: Pick<ChatRow, "company_id">,
  config: ChatRuntimeConfiguration,
  lock = false,
) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows = lock
      ? yield* sql<{
          readonly web_search_enabled: boolean;
          readonly web_domain_allowlist: readonly string[] | null;
        }>`
          select settings.web_search_enabled, settings.web_domain_allowlist
          from client_company_ai_settings settings
          where settings.company_id = ${chat.company_id}
          for update
        `
      : yield* sql<{
          readonly web_search_enabled: boolean;
          readonly web_domain_allowlist: readonly string[] | null;
        }>`
          select settings.web_search_enabled, settings.web_domain_allowlist
          from client_company_ai_settings settings
          where settings.company_id = ${chat.company_id}
        `;
    const row = rows[0] ?? { web_search_enabled: false, web_domain_allowlist: null };
    return effectiveWebPolicy({
      companyEnabled: row.web_search_enabled,
      allowedDomains: row.web_domain_allowlist,
      ...deploymentPolicy(config),
    });
  });

const sourceRowsFor = (
  sql: SqlClient,
  chatId: string,
  runIds: readonly string[],
  assistantIds: readonly string[],
) =>
  runIds.length === 0
    ? Effect.succeed<readonly SourceRow[]>([])
    : Effect.gen(function* () {
        const rows = yield* sql<SourceRow>`
          select sources.run_id::text,
                 runs.assistant_message_id::text as assistant_message_id,
                 sources.source_key, sources.kind, sources.locator,
                 sources.display_label, sources.public_provenance,
                 sources.document_source_id as source_id,
                 public_documents.canonical_url,
                 sources.document_id, sources.snapshot_id, sources.content_hash,
                 sources.source_identity_digest,
                 (sources.source_identity_digest ~ '^[0-9a-f]{64}$') as source_identity_valid,
                 sources.message_id::text as message_id,
                 sources.memory_revision_id::text as memory_revision_id,
                 runs.citation_namespace
          from assistant_message_sources sources
          join ai_runs runs on runs.id = sources.run_id
          left join public_source_documents public_documents
            on sources.document_source_id like 'public:%'
           and public_documents.source_id::text = substring(sources.document_source_id from 8)
           and public_documents.document_id::text = sources.locator->>'documentId'
          where runs.chat_id = ${chatId}
            and ${sql.in("sources.run_id", runIds)}
            and (${sql.in("runs.assistant_message_id", assistantIds)} or runs.assistant_message_id is null)
          order by sources.run_id,
                   (substring(sources.source_key from '_([1-9][0-9]*)$'))::numeric,
                   sources.source_key
        `;
        return rows;
      });

const sourceUseRowsFor = (sql: SqlClient, runIds: readonly string[]) =>
  runIds.length === 0
    ? Effect.succeed<readonly SourceUseRow[]>([])
    : sql<SourceUseRow>`
        select uses.run_id::text,
               runs.assistant_message_id::text as assistant_message_id,
               uses.source_key, uses.consumer_task_id, uses.topic_id,
               uses.rendered_token_count, uses.context_order, uses.ranges,
               uses.source_use_identity_digest,
               (uses.source_use_identity_digest ~ '^[0-9a-f]{64}$') as source_use_identity_valid
        from assistant_message_source_uses uses
        join ai_runs runs on runs.id = uses.run_id
        where ${sql.in("uses.run_id", runIds)}
        order by uses.run_id, uses.context_order,
                 (substring(uses.source_key from '_([1-9][0-9]*)$'))::numeric,
                 uses.source_key
      `;

/** Load the one chat owned by the authenticated visitor. */
export const loadChatRuntimeState = (
  identity: ChatRuntimeReadIdentity,
  config: ChatRuntimeConfiguration,
) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        // Reads share the same lease order as finalization: memory, chat row,
        // company membership, then chat execution. This keeps the complete
        // projection at one linearization point while workers publish rows.
        yield* sql`select pg_advisory_xact_lock(hashtext(${`hartlib:user-memory:${identity.userId}`}))`;
        const chat = yield* ensureDemoChatInTransaction(identity.userId);
        const chatRows = yield* sql<ChatRow>`
          select id::text, user_id, company_id::text, memory_mode, created_at, updated_at
          from chats where id = ${chat.id} and user_id = ${identity.userId}
          for share
        `;
        const lockedChat = chatRows[0];
        if (lockedChat === undefined) return yield* Effect.fail(new Error("chat_not_found"));
        yield* sql`select pg_advisory_xact_lock(hashtext(${`hartlib:client-members:${lockedChat.company_id}`}))`;
        yield* sql`select pg_advisory_xact_lock(hashtext(${`hartlib:ai-chat:${lockedChat.id}`}))`;
        const effectivePolicy = yield* readEffectiveWebPolicy(lockedChat, config, true);
        const messages = yield* sql<MessageRow>`
          select id::text, chat_id::text, author, content, created_at
          from chat_messages
          where chat_id = ${lockedChat.id}
          order by created_at, id
        `;
        const runs = yield* sql<RunRow>`
          select id::text, chat_id::text, user_message_id::text,
                 assistant_message_id::text, started_at, finished_at, failed_at,
                 stopped_at, superseded_at, error_code, retryable
          from ai_runs
          where chat_id = ${lockedChat.id}
          order by created_at, id
        `;
        const runIds = runs.map((run) => run.id);
        const assistantIds = messages
          .filter((message) => message.author === "assistant")
          .map((message) => message.id);
        const sourceRows = yield* sourceRowsFor(sql, lockedChat.id, runIds, assistantIds);
        const useRows = yield* sourceUseRowsFor(sql, runIds);

        // Hydrate only citations that are currently authorized.  Unauthorized or
        // deleted evidence remains in the run ledger but projects a null quote.
        const cited = new Set(
          messages.flatMap((message) =>
            message.author === "assistant"
              ? [
                  ...message.content.matchAll(
                    /\[\[cite:([A-Za-z0-9_-]+(?:,[A-Za-z0-9_-]+)*)\]\]/gu,
                  ),
                ].flatMap((match) =>
                  (match[1]?.split(",") ?? []).map((key) => `${message.id}\u0000${key}`),
                )
              : [],
          ),
        );
        const citedDocuments = sourceRows.filter(
          (row) =>
            row.kind === "document" &&
            row.assistant_message_id !== null &&
            cited.has(`${row.assistant_message_id}\u0000${row.source_key}`),
        );
        const citedMemories = sourceRows.filter(
          (row) =>
            row.kind === "memory" &&
            row.assistant_message_id !== null &&
            cited.has(`${row.assistant_message_id}\u0000${row.source_key}`),
        );
        const documentTextRows =
          citedDocuments.length === 0
            ? []
            : yield* sql<{
                readonly runId: string;
                readonly sourceKey: string;
                readonly text: string | null;
              }>`
            select sources.run_id::text as "runId", sources.source_key as "sourceKey",
                   public_documents.text as text
            from assistant_message_sources sources
            join ai_runs runs on runs.id = sources.run_id and runs.chat_id = ${lockedChat.id}
            left join public_source_documents public_documents
              on sources.document_source_id like 'public:%'
             and public_documents.source_id::text = substring(sources.document_source_id from 8)
             and public_documents.document_id::text = sources.locator->>'documentId'
            where ${sql.or(citedDocuments.map((row) => sql`(sources.run_id = ${row.run_id} and sources.source_key = ${row.source_key})`))}
              and exists (
                  select 1 from client_company_public_source_settings settings
                  join public_source_items item on item.source_id = settings.source_id
                  join public_source_documents current_document on current_document.document_id = item.latest_document_id
                  where settings.client_company_id = ${chat.company_id}
                    and settings.source_id = substring(sources.document_source_id from 8)
                    and settings.enabled
                    and item.latest_document_id = public_documents.document_id
                    and item.current_content_hash = public_documents.content_hash
                    and current_document.raw_artifact_id = public_documents.raw_artifact_id
                    and public_documents.text_char_count >= ${minimumReadablePublicSourceTextChars}
              )
          `;
        const memoryTextRows =
          citedMemories.length === 0
            ? []
            : yield* sql<{
                readonly runId: string;
                readonly sourceKey: string;
                readonly text: string | null;
                readonly deleted: boolean | null;
              }>`
            select sources.run_id::text as "runId", sources.source_key as "sourceKey",
                   revisions.state_after->>'content' as text,
                   (revisions.state_after->>'deleted')::boolean as deleted
            from assistant_message_sources sources
            join ai_runs runs on runs.id = sources.run_id and runs.chat_id = ${lockedChat.id}
            join user_memory_revisions revisions on revisions.id = sources.memory_revision_id
            where ${sql.or(citedMemories.map((row) => sql`(sources.run_id = ${row.run_id} and sources.source_key = ${row.source_key})`))}
              and runs.initiating_user_id = ${identity.userId}
          `;
        const documentTexts = new Map(
          documentTextRows.map((row) => [`${row.runId}\u0000${row.sourceKey}`, row.text]),
        );
        const memoryTexts = new Map(
          memoryTextRows.map((row) => [
            `${row.runId}\u0000${row.sourceKey}`,
            { text: row.text, deleted: row.deleted },
          ]),
        );
        const hydrated = sourceRows.map((row) => {
          const key = `${row.run_id}\u0000${row.source_key}`;
          const text = documentTexts.get(key);
          if (text !== undefined) return { ...row, document_text: text };
          const memory = memoryTexts.get(key);
          return memory === undefined
            ? row
            : {
                ...row,
                memory_revision_text: memory.text,
                memory_revision_deleted: memory.deleted,
              };
        });
        return { chat: lockedChat, effectivePolicy, messages, runs, sourceRows: hydrated, useRows };
      }),
    );
  });

const findActiveRunConflictForUser = (userId: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<RunRow>`
      select run.id::text, run.chat_id::text, run.user_message_id::text,
             assistant_message_id::text, started_at, finished_at, failed_at,
             stopped_at, superseded_at, error_code, retryable
      from ai_runs run
      join chats chat on chat.id = run.chat_id
      where chat.user_id = ${userId}
        and run.finished_at is null and run.failed_at is null
        and run.stopped_at is null and run.superseded_at is null
      order by run.created_at, run.id
      limit 1
    `;
    return rows[0] ?? null;
  });

export interface CreateChatRunInput {
  readonly text: string;
  readonly locale: string;
  readonly market: string;
  readonly webSearchEnabled: boolean;
}

type JsonSqlClient = SqlClient & { readonly json: (value: unknown) => unknown };

const insertMessageRunAndJob = (
  sql: JsonSqlClient,
  chat: ChatRow,
  userId: string,
  input: CreateChatRunInput,
  policy: EffectiveWebPolicy,
  providerServiceId: AiProviderServiceId,
  providerEndpointIdentity: AiProviderEndpointIdentity,
) =>
  Effect.gen(function* () {
    const selectedPublicRows = yield* sql<{ readonly sourceId: string }>`
      select settings.source_id as "sourceId"
      from client_company_public_source_settings settings
      where settings.client_company_id = ${chat.company_id} and settings.enabled
      order by settings.source_id
    `;
    const memoryRows =
      chat.memory_mode === "private_owner"
        ? yield* sql<{ readonly revisionId: string }>`
          select memories.head_revision_id::text as "revisionId"
          from user_memories memories
          where memories.user_id = ${userId}
            and memories.deleted_at is null
            and memories.provenance_only_at is null
            and memories.head_revision_id is not null
          order by memories.head_revision_id::text
        `
        : [];
    const acceptanceScope = makeRunAcceptanceScope({
      userId,
      chatId: chat.id,
      companyId: chat.company_id,
      publicSourceIds: [...new Set(selectedPublicRows.map((row) => row.sourceId))],
      memoryMode: chat.memory_mode,
      memoryRevisionIds: [...new Set(memoryRows.map((row) => row.revisionId))],
      webRequested: input.webSearchEnabled,
      webEnabled: input.webSearchEnabled && policy.enabled,
      provider: providerServiceId,
      providerEndpointIdentity,
      webTransportProvider: input.webSearchEnabled && policy.enabled ? policy.provider : null,
      allowedDomains: input.webSearchEnabled && policy.enabled ? policy.allowedDomains : null,
    });
    const messages = yield* sql<{ readonly id: string; readonly created_at: Date }>`
      insert into chat_messages (chat_id, author, content)
      values (${chat.id}, 'user', ${input.text})
      returning id::text, created_at
    `;
    const message = messages[0];
    if (message === undefined) return yield* Effect.fail(new Error("message_not_created"));
    const runs = yield* sql<{ readonly id: string }>`
      insert into ai_runs (
        chat_id, initiating_user_id, user_message_id, locale, market,
        citation_namespace, acceptance_scope, web_search_enabled,
        effective_web_policy
      ) values (
        ${chat.id}, ${userId}, ${message.id}, ${input.locale}, ${input.market},
        ${`cn_${randomCitationNamespace()}`}, ${sql.json(acceptanceScope)},
        ${input.webSearchEnabled}, ${sql.json(policy)}
      )
      returning id::text
    `;
    const runId = runs[0]?.id;
    if (runId === undefined) return yield* Effect.fail(new Error("run_not_created"));
    yield* sql`
      insert into jobs (kind, payload, unique_key, priority)
      values ('ai_chat_run', ${sql.json({ aiRunId: runId })}, ${`ai_chat_run:${runId}`}, 100)
      on conflict (unique_key) where unique_key is not null do nothing
    `;
    return { kind: "accepted", chat, message, runId } as const;
  });

/** Insert one message and one run. The chat is always resolved by visitor id. */
export const createUserMessageAndRun = (
  userId: string,
  input: CreateChatRunInput,
  config: ChatRuntimeConfiguration,
) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`select pg_advisory_xact_lock(hashtext(${`hartlib:user-memory:${userId}`}))`;
        yield* sql`select pg_advisory_xact_lock(hashtext(${`hartlib:ai-chat:${userId}`}))`;
        const chat = yield* ensureDemoChatInTransaction(userId);
        // Finalization, edit, and delete all serialize on the chat lane. Hold
        // it before checking conflicts and inserting the new run so a send
        // cannot slip between a worker's terminal check and its commit.
        yield* sql`select pg_advisory_xact_lock(hashtext(${`hartlib:client-members:${chat.company_id}`}))`;
        yield* sql`select pg_advisory_xact_lock(hashtext(${`hartlib:ai-chat:${chat.id}`}))`;
        const membership = yield* sql<{ readonly active: boolean }>`
          select exists(
            select 1 from client_company_memberships
            where company_id = ${chat.company_id} and user_id = ${userId} and revoked_at is null
          ) as active
        `;
        if (membership[0]?.active !== true) return { kind: "forbidden" } as const;
        const policy = yield* readEffectiveWebPolicy(chat, config, true);
        if (input.webSearchEnabled && !policy.enabled)
          return { kind: "web_unavailable", policy } as const;
        const active = yield* findActiveRunConflictForUser(userId);
        if (active !== null) return { kind: "conflict", active, chat } as const;
        return yield* insertMessageRunAndJob(
          sql,
          chat,
          userId,
          input,
          policy,
          config.aiProviderServiceId,
          config.aiProviderEndpointIdentity,
        );
      }),
    );
  });

export const readAuthorizedAiRunEventsAfter = (userId: string, runId: string, afterSeq: number) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<{
      readonly authorized: boolean;
      readonly terminal: boolean | null;
      readonly replayableTerminal: boolean | null;
      readonly seq: number | null;
      readonly event: unknown | null;
    }>`
      with authorized as (
        select run.id,
               (run.finished_at is not null or run.failed_at is not null or run.stopped_at is not null or run.superseded_at is not null) as terminal
        from ai_runs run
        join chats chat on chat.id = run.chat_id
        join client_company_memberships membership
          on membership.company_id = chat.company_id
         and membership.user_id = ${userId}
         and membership.revoked_at is null
        join demo_sessions session
          on session.visitor_id::text = ${userId}
         and session.revoked_at is null
        where run.id = ${runId} and chat.user_id = ${userId}
      )
      select authorized.id is not null as authorized,
             authorized.terminal,
             case when authorized.id is null then false else exists (
               select 1 from ai_run_events terminal_events
               where terminal_events.run_id = authorized.id
                 and terminal_events.seq > ${afterSeq}
                 and terminal_events.event->>'type' in ('done', 'error', 'stopped')
             ) end as "replayableTerminal",
             event_rows.seq, event_rows.event
      from (values (1)) anchor(value)
      left join authorized on true
      left join lateral (
        select events.seq, events.event from ai_run_events events
        where events.run_id = authorized.id and events.seq > ${afterSeq}
        order by events.seq
      ) event_rows on authorized.id is not null
      order by event_rows.seq nulls first
    `;
    const first = rows[0];
    if (first?.authorized !== true)
      return {
        authorized: false,
        terminal: false,
        replayableTerminal: false,
        events: [],
      } satisfies AuthorizedAiRunEventPoll;
    return {
      authorized: true,
      terminal: first.terminal === true,
      replayableTerminal: first.replayableTerminal === true,
      events: rows.flatMap((row) =>
        row.seq === null || row.event === null ? [] : [{ seq: row.seq, event: row.event }],
      ),
    } satisfies AuthorizedAiRunEventPoll;
  });

export type AuthorizedAiRunDebugRead =
  | { readonly kind: "unauthorized" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "available"; readonly debug: PublicAiRunDebug };

const debugStages = ["understanding", "evidence", "preparing", "writing", "finishing"] as const;
const safeDebugCode = (value: unknown): string =>
  typeof value === "string" && /^[a-z][a-z0-9_]{0,95}$/u.test(value) ? value : "unknown_error";
const safeDebugCount = (value: unknown): number | null => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 && number <= 1_000_000_000 ? number : null;
};
const debugTimestamp = (value: Date | null): string | null =>
  value === null ? null : value.toISOString();
const debugActivityEvent = (
  event: AiRunActivityEvent,
  occurredAt: string | null,
): PublicAiRunDebugEvent => ({
  stage: event.stage,
  topicId: event.topicId ?? null,
  code: safeDebugCode(event.code),
  status: event.status,
  occurredAt,
  attempt: event.attempt === undefined ? null : safeDebugCount(event.attempt),
  durationMs: event.durationMs === undefined ? null : safeDebugCount(event.durationMs),
  sourceCount: event.sourceCount === undefined ? null : safeDebugCount(event.sourceCount),
  resultCount: event.resultCount === undefined ? null : safeDebugCount(event.resultCount),
  errorCode: event.errorCode === undefined ? null : safeDebugCode(event.errorCode),
  errorCategory: event.errorCategory ?? null,
});

export const readAuthorizedAiRunDebug = (
  userId: string,
  runId: string,
): Effect.Effect<AuthorizedAiRunDebugRead, unknown, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<{
      readonly id: string;
      readonly startedAt: Date | null;
      readonly finishedAt: Date | null;
      readonly failedAt: Date | null;
      readonly stoppedAt: Date | null;
      readonly supersededAt: Date | null;
      readonly errorCode: string | null;
      readonly retryable: boolean | null;
      readonly assistantMessageId: string | null;
      readonly assistantContent: string | null;
    }>`
      select run.id::text as id, run.started_at as "startedAt", run.finished_at as "finishedAt",
             run.failed_at as "failedAt", run.stopped_at as "stoppedAt", run.superseded_at as "supersededAt", run.error_code as "errorCode",
             run.retryable, run.assistant_message_id::text as "assistantMessageId", assistant.content as "assistantContent"
      from ai_runs run
      join chats chat on chat.id = run.chat_id and chat.user_id = ${userId}
      join client_company_memberships membership
        on membership.company_id = chat.company_id and membership.user_id = ${userId} and membership.revoked_at is null
      left join chat_messages assistant on assistant.id = run.assistant_message_id and assistant.author = 'assistant'
      where run.id = ${runId}
      limit 1
    `;
    const run = rows[0];
    if (run === undefined) return { kind: "unauthorized" } satisfies AuthorizedAiRunDebugRead;
    const eventRows = yield* sql<{
      readonly seq: number;
      readonly event: unknown;
      readonly createdAt: Date;
    }>`
      select seq, event, created_at as "createdAt" from ai_run_events where run_id = ${run.id} order by seq
    `;
    const terminal =
      run.finishedAt !== null ||
      run.failedAt !== null ||
      run.stoppedAt !== null ||
      run.supersededAt !== null;
    if (
      terminal &&
      !eventRows.some((row) => {
        const event = row.event as { readonly type?: unknown };
        return event.type === "done" || event.type === "error" || event.type === "stopped";
      })
    )
      return { kind: "unavailable" } satisfies AuthorizedAiRunDebugRead;
    let decoded: Array<{
      readonly seq: number;
      readonly occurredAt: string | null;
      readonly event: Schema.Schema.Type<typeof AiRunEvent>;
    }>;
    try {
      decoded = eventRows.map((row) => ({
        seq: row.seq,
        occurredAt: debugTimestamp(row.createdAt),
        event: Schema.decodeUnknownSync(AiRunEvent, { onExcessProperty: "error" })(row.event),
      }));
    } catch {
      return { kind: "unavailable" } satisfies AuthorizedAiRunDebugRead;
    }
    const activities = decoded
      .filter((row) => row.event.type === "activity")
      .map((row) => ({ ...row, event: row.event as AiRunActivityEvent }));
    const latest = new Map<(typeof debugStages)[number], AiRunActivityEvent>();
    for (const row of activities) latest.set(row.event.stage, row.event);
    const stages = debugStages.map((stage) => {
      const event = latest.get(stage);
      return {
        stage,
        status: event?.status ?? "waiting",
        attempt: event?.attempt === undefined ? null : safeDebugCount(event.attempt),
        durationMs: event?.durationMs === undefined ? null : safeDebugCount(event.durationMs),
        sourceCount: event?.sourceCount === undefined ? null : safeDebugCount(event.sourceCount),
        resultCount: event?.resultCount === undefined ? null : safeDebugCount(event.resultCount),
        errorCode: event?.errorCode === undefined ? null : safeDebugCode(event.errorCode),
        errorCategory: event?.errorCategory ?? null,
      };
    });
    const history: PublicAiRunDebugEvent[] = activities
      .slice(-200)
      .map((row) => debugActivityEvent(row.event, row.event.occurredAt ?? row.occurredAt));
    const sourceRows = yield* sql<{ readonly sourceKey: string }>`
      select source_key as "sourceKey" from assistant_message_sources where run_id = ${run.id}
    `;
    const cited =
      run.assistantContent === null
        ? 0
        : new Set(
            [
              ...run.assistantContent.matchAll(
                /\[\[cite:([A-Za-z0-9_-]+(?:,[A-Za-z0-9_-]+)*)\]\]/gu,
              ),
            ]
              .flatMap((match) => match[1]?.split(",") ?? [])
              .filter((key) => sourceRows.some((row) => row.sourceKey === key)),
          ).size;
    const usageRows = yield* sql<{
      readonly input: string;
      readonly output: string;
      readonly searches: string;
      readonly fetches: string;
      readonly bytes: string;
    }>`
      select coalesce((select sum(input_tokens) from ai_run_usage where run_id = ${run.id}), 0)::text as input,
             coalesce((select sum(output_tokens) from ai_run_usage where run_id = ${run.id}), 0)::text as output,
             coalesce((select count(*) from ai_external_tool_usage where run_id = ${run.id} and operation = 'web_search'), 0)::text as searches,
             coalesce((select count(*) from ai_external_tool_usage where run_id = ${run.id} and operation = 'web_fetch'), 0)::text as fetches,
             coalesce((select sum(response_bytes) from ai_external_tool_usage where run_id = ${run.id}), 0)::text as bytes
    `;
    const usage = usageRows[0];
    const status =
      run.stoppedAt !== null || run.supersededAt !== null
        ? "stopped"
        : run.finishedAt !== null
          ? "succeeded"
          : run.failedAt !== null
            ? "failed"
            : run.startedAt === null
              ? "queued"
              : "running";
    const terminalError =
      run.failedAt === null
        ? null
        : {
            code: safeDebugCode(run.errorCode ?? "internal_error"),
            retryable: run.retryable === true,
            category: null,
            message: null,
          };
    const debug: PublicAiRunDebug = {
      runId: run.id,
      status,
      startedAt: debugTimestamp(run.startedAt),
      finishedAt: debugTimestamp(run.finishedAt),
      failedAt: debugTimestamp(run.failedAt),
      stoppedAt: debugTimestamp(run.stoppedAt ?? run.supersededAt),
      lastSequence: eventRows.at(-1)?.seq ?? null,
      stages,
      history,
      sourceSummary: {
        read: sourceRows.length,
        cited,
        uncited: Math.max(0, sourceRows.length - cited),
      },
      context: { compactionRan: null, consumers: 0, inputTokens: null, usableInputTokens: null },
      memory: null,
      usage:
        usage === undefined
          ? null
          : {
              modelInputTokens: safeDebugCount(usage.input) ?? 0,
              modelOutputTokens: safeDebugCount(usage.output) ?? 0,
              webSearches: safeDebugCount(usage.searches) ?? 0,
              webFetches: safeDebugCount(usage.fetches) ?? 0,
              webResponseBytes: safeDebugCount(usage.bytes) ?? 0,
            },
      terminalError,
    };
    return { kind: "available", debug } satisfies AuthorizedAiRunDebugRead;
  });

export const readRunStreamContext = (runId: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<RunStreamContext>`
      select run.id::text as "runId", run.chat_id::text as "chatId"
      from ai_runs run join chats chat on chat.id = run.chat_id where run.id = ${runId}
    `;
    return rows[0] ?? null;
  });
