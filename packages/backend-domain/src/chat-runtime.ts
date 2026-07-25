import { randomBytes } from "node:crypto";

import { PgClient } from "@effect/sql-pg";
import {
  deriveEffectiveWebPolicy,
  makeRunAcceptanceScope,
  normalizeDomainAllowlist,
  type AiProviderServiceId,
  type AiProviderEndpointIdentity,
  type EffectiveWebPolicy,
} from "@brief/shared";
import { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";

export interface ChatRuntimeConfiguration {
  readonly authMode: "demo" | "clerk";
  readonly webResearchProvider: "tinyfish" | null;
  readonly aiWebMaxDomainFilters: number;
  readonly aiProviderServiceId: AiProviderServiceId;
  readonly aiProviderEndpointIdentity: AiProviderEndpointIdentity;
}

export interface ChatRuntimeReadIdentity {
  readonly mode: "demo" | "clerk";
  readonly userId: string;
  readonly organizationId: string | null;
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
  readonly author: "user" | "assistant";
  readonly content: string;
  readonly created_at: Date;
}

export interface RunRow {
  readonly id: string;
  readonly chat_id: string;
  readonly user_message_id: string;
  readonly assistant_message_id: string | null;
  readonly started_at: Date | null;
  readonly finished_at: Date | null;
  readonly failed_at: Date | null;
  readonly error_code: string | null;
  readonly retryable: boolean | null;
}

export interface SourceRow {
  readonly assistant_message_id: string;
  readonly source_key: string;
  /** Final per-answer handle namespace. */
  readonly citation_namespace: string;
  /** Indexed publisher extraction identity; null for public-source documents. */
  readonly publisher_extraction_id: string | null;
  /** Publisher ownership resolved from the indexed version's issue/document joins. */
  readonly publisher_document_id?: string | null;
  readonly publisher_issue_id?: string | null;
  /** Canonical indexed evidence identity, populated for durable document rows. */
  readonly source_id?: string | null;
  readonly document_id?: string | null;
  readonly version_id?: string | null;
  readonly content_hash?: string | null;
  readonly canonical_url?: string | null;
  readonly source_identity_digest?: string | null;
  readonly kind: "document" | "chat_message" | "memory" | "web";
  readonly locator: unknown;
  readonly display_label: string | null;
  readonly public_provenance: unknown;
}

export interface SourceUseRow {
  readonly assistant_message_id: string;
  readonly source_key: string;
  readonly consumer_task_id?: string;
  readonly topic_id: "t1" | "t2" | "t3" | null;
  readonly rendered_token_count: number;
  readonly context_order: number;
  readonly ranges?: unknown;
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
  /** The authorized run has reached a durable terminal outcome. */
  readonly terminal: boolean;
  /** A terminal event remains available after the requested replay cursor. */
  readonly replayableTerminal: boolean;
}

interface CompanyPolicyRow {
  readonly web_search_enabled: boolean;
  readonly web_domain_allowlist: readonly string[] | null;
}

export const effectiveWebPolicy = (args: {
  readonly companyEnabled: boolean;
  readonly allowedDomains: readonly string[] | null;
  readonly adapterAvailable: boolean;
  readonly provider: "tinyfish" | null;
  readonly allowlistSupported: boolean;
  readonly maxDomainFilters: number;
}): EffectiveWebPolicy => {
  return deriveEffectiveWebPolicy(args);
};

export { normalizeDomainAllowlist };

const deploymentPolicy = (config: ChatRuntimeConfiguration) => ({
  adapterAvailable: config.webResearchProvider === "tinyfish",
  provider: config.webResearchProvider,
  allowlistSupported: config.webResearchProvider === "tinyfish",
  maxDomainFilters: config.aiWebMaxDomainFilters,
});

const ensureDemoChatInTransaction = (userId: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    yield* sql`select pg_advisory_xact_lock(hashtext(${`brief:demo-chat:${userId}`}))`;
    yield* sql`
      insert into platform_users (id, primary_email, display_name, clerk_user_id)
      values (
        ${userId},
        ${`demo+${encodeURIComponent(userId)}@brief.invalid`},
        ${`Demo ${userId}`},
        ${`demo:${userId}`}
      )
      on conflict (id) do nothing
    `;
    const existing = yield* sql<ChatRow>`
      select chat.id::text, chat.user_id, chat.company_id::text, chat.memory_mode,
             chat.created_at, chat.updated_at
      from chats chat
      join client_companies company on company.id = chat.company_id
      where chat.user_id = ${userId}
        and chat.deleted_at is null
        and company.recovery_deleted_at is null
        and company.purged_at is null
      order by chat.created_at, chat.id
      limit 1
    `;
    if (existing[0] !== undefined) {
      yield* sql`
        insert into client_company_public_source_settings (
          client_company_id, source_id, enabled, updated_by_user_id
        )
        select ${existing[0].company_id}, source.source_id, true, ${userId}
        from public_sources source
        where source.source_id not like 'eval-%'
          and source.discovery_url not like 'https://evaluation.invalid/%'
        on conflict (client_company_id, source_id) do nothing
      `;
      return existing[0];
    }
    const deterministicCompany = yield* sql<{ readonly id: string }>`
      select (
        substr(md5(${"brief:client-company:" + userId}), 1, 8) || '-' ||
        substr(md5(${"brief:client-company:" + userId}), 9, 4) || '-' ||
        substr(md5(${"brief:client-company:" + userId}), 13, 4) || '-' ||
        substr(md5(${"brief:client-company:" + userId}), 17, 4) || '-' ||
        substr(md5(${"brief:client-company:" + userId}), 21, 12)
      )::uuid::text as id
    `;
    const companyId = deterministicCompany[0]!.id;
    yield* sql`
      insert into client_companies (id, name)
      values (${companyId}, ${`Demo company for ${userId}`})
      on conflict (id) do nothing
    `;
    const activeCompany = yield* sql<{ readonly active: boolean }>`
      select exists (
        select 1 from client_companies
        where id = ${companyId}
          and recovery_deleted_at is null
          and purged_at is null
      ) as active
    `;
    if (activeCompany[0]?.active !== true) return yield* Effect.fail(new Error("company_inactive"));
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
    // The demo has a fixed, server-authorized public-source set. Materialize
    // missing rows from the globally ingested catalog so the feed and chat
    // retrieval share one durable authorization boundary. Existing settings
    // are preserved so a deliberate opt-out remains effective. Canonical
    // evaluation fixtures (eval-* sources on evaluation.invalid URLs) are
    // excluded so the golden eval harness cannot pollute the demo feed.
    yield* sql`
      insert into client_company_public_source_settings (
        client_company_id, source_id, enabled, updated_by_user_id
      )
        select ${companyId}, source.source_id, true, ${userId}
        from public_sources source
        where source.source_id not like 'eval-%'
          and source.discovery_url not like 'https://evaluation.invalid/%'
        on conflict (client_company_id, source_id) do nothing
    `;
    const inserted = yield* sql<ChatRow>`
      insert into chats (user_id, company_id, memory_mode)
      values (${userId}, ${companyId}, 'private_owner')
      returning id::text, user_id, company_id::text, memory_mode, created_at, updated_at
    `;
    if (inserted[0] !== undefined) return inserted[0];
    const raced = yield* sql<ChatRow>`
      select chat.id::text, chat.user_id, chat.company_id::text, chat.memory_mode,
             chat.created_at, chat.updated_at
      from chats chat
      join client_companies company on company.id = chat.company_id
      where chat.user_id = ${userId} and chat.deleted_at is null
        and company.recovery_deleted_at is null
        and company.purged_at is null
      order by chat.created_at, chat.id
      limit 1
    `;
    if (raced[0] === undefined) return yield* Effect.fail(new Error("chat_not_found"));
    return raced[0];
  });

export const ensureDemoChat = (userId: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(ensureDemoChatInTransaction(userId));
  });

const readEffectiveWebPolicy = (chat: ChatRow, config: ChatRuntimeConfiguration, lock = false) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const policyRows = lock
      ? yield* sql<CompanyPolicyRow>`
          select settings.web_search_enabled, settings.web_domain_allowlist
          from client_companies company
          join client_company_ai_settings settings on settings.company_id = company.id
          where company.id = ${chat.company_id}
            and company.recovery_deleted_at is null
            and company.purged_at is null
          limit 1
          for update of settings
        `
      : yield* sql<CompanyPolicyRow>`
          select settings.web_search_enabled, settings.web_domain_allowlist
          from client_companies company
          join client_company_ai_settings settings on settings.company_id = company.id
          where company.id = ${chat.company_id}
            and company.recovery_deleted_at is null
            and company.purged_at is null
          limit 1
        `;
    const companyPolicy = policyRows[0] ?? {
      web_search_enabled: false,
      web_domain_allowlist: null,
    };
    return effectiveWebPolicy({
      companyEnabled: companyPolicy.web_search_enabled,
      allowedDomains: companyPolicy.web_domain_allowlist,
      ...deploymentPolicy(config),
    });
  });

export const loadChatRuntimeState = (
  userId: string,
  config: ChatRuntimeConfiguration,
  chatId?: string,
) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const chat =
      chatId === undefined
        ? yield* ensureDemoChat(userId)
        : (yield* sql<ChatRow>`
            select chat.id::text, chat.user_id, chat.company_id::text, chat.memory_mode,
                   chat.created_at, chat.updated_at
            from chats chat
            join client_companies company on company.id = chat.company_id
            join platform_users creator
              on creator.id = chat.user_id
             and creator.recovery_deleted_at is null
             and creator.purged_at is null
            where chat.id = ${chatId} and chat.deleted_at is null
              and company.recovery_deleted_at is null
              and company.purged_at is null
            limit 1
          `)[0];
    if (chat === undefined) return null;
    // A disabled-memory chat is eligible for sharing. A persisted memory source
    // in that chat is therefore an invalid projection, not a source that may be
    // rendered to a shared viewer. Fail closed before loading any transcript
    // rows instead of allowing a malformed durable row to widen the chat's
    // visibility boundary.
    const malformed = yield* sql<{ readonly invalid: boolean }>`
      select (
        chat.memory_mode = 'disabled'
        and exists (
          select 1
          from assistant_message_sources sources
          join chat_messages messages on messages.id = sources.assistant_message_id
          where messages.chat_id = chat.id
            and sources.kind = 'memory'
        )
      ) as invalid
      from chats chat
      where chat.id = ${chat.id}
    `;
    if (malformed[0]?.invalid === true) return null;
    const effectivePolicy = yield* readEffectiveWebPolicy(chat, config);
    const messages = yield* sql<MessageRow>`
      select id::text, author, content, created_at
      from chat_messages where chat_id = ${chat.id}
      order by created_at, id
    `;
    const runs = yield* sql<RunRow>`
      select id::text, chat_id::text, user_message_id::text, assistant_message_id::text,
             started_at, finished_at, failed_at, error_code, retryable
      from ai_runs where chat_id = ${chat.id}
      order by created_at, id
    `;
    const assistantMessageIds = messages
      .filter((message) => message.author === "assistant")
      .map((message) => message.id);
    const sourceRows =
      assistantMessageIds.length === 0
        ? []
        : yield* sql<SourceRow>`
            select sources.assistant_message_id::text, sources.source_key, sources.kind,
                   sources.locator, sources.display_label,
                   sources.public_provenance,
                   sources.publisher_extraction_id::text as publisher_extraction_id,
                   case
                     when publisher_versions.id is not null
                       then 'publisher:' || publisher_issues.subscription_id::text
                     when public_documents.document_id is not null
                       then 'public:' || public_documents.source_id
                     else null
                   end as source_id,
                   case
                     when publisher_versions.id is not null then publisher_documents.id::text
                     else public_documents.document_id
                   end as document_id,
                   case
                     when publisher_versions.id is not null then publisher_versions.id::text
                     else public_documents.document_id
                   end as version_id,
                   case
                     when publisher_versions.id is not null then publisher_versions.content_hash
                     else public_documents.content_hash
                   end as content_hash,
                   public_documents.canonical_url,
                   sources.source_identity_digest,
                   publisher_documents.id::text as publisher_document_id,
                   publisher_issues.id::text as publisher_issue_id,
                   runs.citation_namespace
            from assistant_message_sources sources
            join chat_messages messages
              on messages.id = sources.assistant_message_id
            join ai_runs runs
              on runs.id = messages.assistant_ai_run_id
             and runs.assistant_message_id = messages.id
            left join brief_document_extractions publisher_extractions
              on publisher_extractions.id = sources.publisher_extraction_id
            left join brief_documents publisher_documents
              on publisher_documents.id = publisher_extractions.brief_document_id
            left join brief_document_versions publisher_versions
              on publisher_versions.brief_document_id = publisher_documents.id
             and publisher_versions.id::text = sources.version_id
             and publisher_versions.content_hash = sources.locator->>'contentHash'
            left join publisher_issues publisher_issues
              on publisher_issues.id = publisher_documents.issue_id
            left join public_source_documents public_documents
              on public_documents.document_id = sources.version_id
             and sources.publisher_extraction_id is null
            where ${sql.in("sources.assistant_message_id", assistantMessageIds)}
            order by sources.assistant_message_id,
                     (substring(sources.source_key from '_([1-9][0-9]*)$'))::numeric,
                     sources.source_key
          `;
    const useRows =
      assistantMessageIds.length === 0
        ? []
        : yield* sql<SourceUseRow>`
            select assistant_message_id::text, source_key, topic_id,
                   consumer_task_id, rendered_token_count, context_order, ranges
            from assistant_message_source_uses
            where ${sql.in("assistant_message_id", assistantMessageIds)}
            order by assistant_message_id, context_order,
                     (substring(source_key from '_([1-9][0-9]*)$'))::numeric,
                     source_key
          `;
    return { chat, effectivePolicy, messages, runs, sourceRows, useRows };
  });

export const withAuthorizedChatReadLease = <A, E, R>(
  identity: ChatRuntimeReadIdentity,
  chatId: string,
  operation: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const candidates = yield* sql<{ readonly companyId: string }>`
          select company_id::text as "companyId"
          from chats
          where id = ${chatId}
          for share
        `;
        const candidate = candidates[0];
        if (candidate === undefined) return null;
        yield* sql`
          select pg_advisory_xact_lock(
            hashtext(${`brief:client-members:${candidate.companyId}`})
          )
        `;
        yield* sql`select pg_advisory_xact_lock(hashtext(${`brief:ai-chat:${chatId}`}))`;
        yield* sql`
          select id
          from platform_users
          where id = ${identity.userId}
          for share
        `;
        yield* sql`
          select id
          from client_companies
          where id = ${candidate.companyId}
          for share
        `;
        const authorized = yield* sql<{ readonly authorized: boolean }>`
          select exists(
            select 1
            from chats chat
            join client_companies company on company.id = chat.company_id
            join client_company_memberships membership
              on membership.company_id = chat.company_id
             and membership.user_id = ${identity.userId}
             and membership.revoked_at is null
            join platform_users users
              on users.id = membership.user_id
             and users.recovery_deleted_at is null and users.purged_at is null
            where chat.id = ${chatId}
              and chat.deleted_at is null
              and company.recovery_deleted_at is null and company.purged_at is null
              and exists (
                select 1
                from platform_users creator
                where creator.id = chat.user_id
                  and creator.recovery_deleted_at is null
                  and creator.purged_at is null
              )
              and (
                ${identity.mode} = 'demo'
                or ${identity.organizationId}::text is null
                or company.clerk_organization_id = ${identity.organizationId}
              )
              and (
                chat.user_id = ${identity.userId}
                or chat.shared_at is not null
              )
          ) as authorized
        `;
        if (authorized[0]?.authorized !== true) return null;
        return yield* operation;
      }),
    );
  });

export const loadAuthorizedChatRuntimeState = (
  identity: ChatRuntimeReadIdentity,
  config: ChatRuntimeConfiguration,
  chatId: string,
) =>
  withAuthorizedChatReadLease(
    identity,
    chatId,
    loadChatRuntimeState(identity.userId, config, chatId),
  );

export const loadDemoChatRuntimeState = (
  identity: ChatRuntimeReadIdentity,
  config: ChatRuntimeConfiguration,
) =>
  ensureDemoChat(identity.userId).pipe(
    Effect.flatMap((chat) => loadAuthorizedChatRuntimeState(identity, config, chat.id)),
  );

export const findActiveRunConflict = (
  userId: string,
  chatId: string,
  organizationId: string | null,
) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const chatRows = yield* sql<ActiveRunRow>`
      select run.id::text, run.chat_id::text, run.user_message_id::text,
             run.assistant_message_id::text, run.started_at, run.finished_at,
             run.failed_at, run.error_code, run.retryable
      from ai_runs run
      join chats chat on chat.id = run.chat_id
      join client_companies company on company.id = chat.company_id
      where run.chat_id = ${chatId}
        and run.finished_at is null and run.failed_at is null
        and chat.deleted_at is null
        and company.recovery_deleted_at is null
        and company.purged_at is null
        and (
          ${organizationId}::text is null
          or company.clerk_organization_id = ${organizationId}
        )
      limit 1
    `;
    if (chatRows[0] !== undefined) return chatRows[0];

    const userRows = yield* sql<ActiveRunRow>`
      select run.id::text, run.chat_id::text, run.user_message_id::text,
             run.assistant_message_id::text, run.started_at, run.finished_at,
             run.failed_at, run.error_code, run.retryable
      from ai_runs run
      join chats chat on chat.id = run.chat_id
      join client_companies company on company.id = chat.company_id
      where run.initiating_user_id = ${userId}
        and run.chat_id <> ${chatId}
        and run.finished_at is null and run.failed_at is null
        and chat.deleted_at is null
        and company.recovery_deleted_at is null
        and company.purged_at is null
      order by run.created_at, run.id
      limit 1
    `;
    return userRows[0] ?? null;
  });

type CreditPreflightCode =
  | "billing_account_inactive"
  | "billing_period_unavailable"
  | "company_limit_reached"
  | "employee_limit_reached"
  | "credits_exhausted"
  | "credit_conversion_undefined";

type DatabaseInteger = string | number | bigint;

const exactDatabaseInteger = (value: DatabaseInteger): bigint => {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("unsafe_database_integer");
    return BigInt(value);
  }
  if (!/^-?\d+$/u.test(value)) throw new Error("invalid_database_integer");
  return BigInt(value);
};

export const creditLimitReached = (used: DatabaseInteger, limit: DatabaseInteger | null): boolean =>
  limit !== null && exactDatabaseInteger(used) >= exactDatabaseInteger(limit);

/**
 * Production credits cannot be reserved until the canonical turn-to-credit
 * conversion/version is approved. Fail closed before any message, run, job, or
 * credit-allocation row is written; demo mode intentionally has no billing.
 */
export const preflightCredits = (
  _chat: ChatRow,
  _userId: string,
  config: ChatRuntimeConfiguration,
): Effect.Effect<CreditPreflightCode | null> =>
  Effect.succeed(config.authMode === "demo" ? null : "credit_conversion_undefined");

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
    const selectedPublisherRows = yield* sql<{
      readonly subscriptionId: string;
      readonly accessId: string;
    }>`
      select distinct selected.subscription_id::text as "subscriptionId",
             selected.access_id::text as "accessId"
      from chat_subscription_sources selected
      join client_employee_subscription_grants grants
        on grants.access_id = selected.access_id
       and grants.client_company_id = selected.client_company_id
       and grants.user_id = ${userId}
       and grants.granted_at <= now()
       and (grants.revoked_at is null or grants.revoked_at > now())
      join client_company_memberships membership
        on membership.company_id = grants.client_company_id
       and membership.user_id = grants.user_id
       and membership.revoked_at is null
       and membership.created_at <= now()
      join client_subscription_accesses accesses
        on accesses.id = selected.access_id
       and accesses.client_company_id = selected.client_company_id
       and accesses.subscription_id = selected.subscription_id
       and accesses.state in ('active', 'ending', 'paused')
      where selected.chat_id = ${chat.id}
        and selected.client_company_id = ${chat.company_id}
      order by selected.subscription_id::text, selected.access_id::text
    `;
    const selectedPublicRows = yield* sql<{ readonly sourceId: string }>`
      select settings.source_id as "sourceId"
      from client_company_public_source_settings settings
      where settings.client_company_id = ${chat.company_id}
        and settings.enabled
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
      subscriptionIds: [...new Set(selectedPublisherRows.map((row) => row.subscriptionId))],
      accessIds: [...new Set(selectedPublisherRows.map((row) => row.accessId))],
      publicSourceIds: [...new Set(selectedPublicRows.map((row) => row.sourceId))],
      memoryMode: chat.memory_mode,
      memoryRevisionIds: [...new Set(memoryRows.map((row) => row.revisionId))],
      webRequested: input.webSearchEnabled,
      // Web is an explicit per-request choice. A company policy can only
      // authorize a requested path; it must not turn web on for a request
      // that opted out. Keep the disabled representation canonical so the
      // database and worker cannot mistake policy capability for acceptance.
      webEnabled: input.webSearchEnabled && policy.enabled,
      provider: providerServiceId,
      providerEndpointIdentity,
      webTransportProvider: input.webSearchEnabled && policy.enabled ? policy.provider : null,
      allowedDomains: input.webSearchEnabled && policy.enabled ? policy.allowedDomains : null,
    });
    const messageRows = yield* sql<{ readonly id: string; readonly created_at: Date }>`
      insert into chat_messages (chat_id, author, content)
      values (${chat.id}, 'user', ${input.text})
      returning id::text, created_at
    `;
    const message = messageRows[0]!;
    const runRows = yield* sql<{ readonly id: string }>`
      insert into ai_runs (
        chat_id, initiating_user_id, user_message_id, locale, market, citation_namespace,
        acceptance_scope
      ) values (
        ${chat.id}, ${userId}, ${message.id}, ${input.locale}, ${input.market},
        ${`cn_${randomBytes(16).toString("base64url")}`},
        ${sql.json(acceptanceScope)}
      )
      returning id::text
    `;
    const runId = runRows[0]!.id;
    yield* sql`
      insert into jobs (kind, payload, unique_key, priority)
      values ('ai_chat_run', ${sql.json({ aiRunId: runId })}, ${`ai_chat_run:${runId}`}, 100)
      on conflict (unique_key) where unique_key is not null do nothing
    `;
    return { kind: "accepted", chat, message, runId } as const;
  });

export const createUserMessageAndRun = (
  userId: string,
  input: CreateChatRunInput,
  config: ChatRuntimeConfiguration,
  organizationId: string | null,
  chatId?: string,
) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        // Match migration 0064's shared side of the schema fence. A cutover
        // cannot pass its active-run drain check while this transaction can
        // still insert a new run.
        yield* sql`select pg_advisory_xact_lock(hashtextextended('brief:ai-chat:smithers-schema', 0))`;
        yield* sql`select pg_advisory_xact_lock(hashtext(${`brief:user-memory:${userId}`}))`;
        const chat =
          chatId === undefined
            ? yield* ensureDemoChatInTransaction(userId)
            : (yield* sql<ChatRow>`
                select chat.id::text, chat.user_id, chat.company_id::text, chat.memory_mode,
                       chat.created_at, chat.updated_at
                from chats chat
                join client_companies company on company.id = chat.company_id
                join client_company_memberships membership
                  on membership.company_id = chat.company_id and membership.user_id = ${userId}
                 and membership.revoked_at is null
                 and membership.created_at <= now()
                where chat.id = ${chatId} and chat.user_id = ${userId}
                  and chat.deleted_at is null
                  and company.recovery_deleted_at is null
                  and company.purged_at is null
                  and (
                    ${organizationId}::text is null
                    or company.clerk_organization_id = ${organizationId}
                  )
                  and not exists (
                    select 1 from chat_subscription_sources selected
                    where selected.chat_id = chat.id
                      and not exists (
                        select 1
                        from client_employee_subscription_grants grant_row
                        join client_subscription_accesses access_row
                          on access_row.id = grant_row.access_id
                         and access_row.client_company_id = grant_row.client_company_id
                        where grant_row.access_id = selected.access_id
                          and grant_row.client_company_id = chat.company_id
                          and grant_row.user_id = ${userId}
                          and grant_row.granted_at <= now()
                          and (grant_row.revoked_at is null or grant_row.revoked_at > now())
                          and access_row.state in ('active', 'ending', 'paused')
                      )
                  )
                for update of chat
              `)[0];
        if (chat === undefined) return { kind: "forbidden" } as const;
        yield* sql`
          select pg_advisory_xact_lock(hashtext(${`brief:client-members:${chat.company_id}`}))
        `;
        yield* sql`select pg_advisory_xact_lock(hashtext(${`brief:ai-chat:${chat.id}`}))`;
        const membershipStillActive = yield* sql<{ readonly active: boolean }>`
          select exists(
            select 1
            from client_company_memberships membership
            join client_companies company on company.id = membership.company_id
            join platform_users users on users.id = membership.user_id
            where membership.company_id = ${chat.company_id}
              and membership.user_id = ${userId}
              and membership.revoked_at is null
              and membership.created_at <= now()
              and company.recovery_deleted_at is null and company.purged_at is null
              and (
                ${organizationId}::text is null
                or company.clerk_organization_id = ${organizationId}
              )
              and users.recovery_deleted_at is null and users.purged_at is null
              and not exists (
                select 1
                from chat_subscription_sources selected
                where selected.chat_id = ${chat.id}
                  and not exists (
                    select 1
                    from client_employee_subscription_grants grant_row
                    join client_subscription_accesses access_row
                      on access_row.id = grant_row.access_id
                     and access_row.client_company_id = grant_row.client_company_id
                    where grant_row.access_id = selected.access_id
                      and grant_row.client_company_id = membership.company_id
                      and grant_row.user_id = membership.user_id
                      and grant_row.granted_at <= now()
                      and (grant_row.revoked_at is null or grant_row.revoked_at > now())
                      and access_row.state in ('active', 'ending', 'paused')
                  )
              )
          ) as active
        `;
        if (membershipStillActive[0]?.active !== true) {
          return { kind: "forbidden" } as const;
        }
        const creditFailure = yield* preflightCredits(chat, userId, config);
        if (creditFailure !== null) {
          return { kind: "credit_unavailable", code: creditFailure } as const;
        }
        const policy = yield* readEffectiveWebPolicy(chat, config, true);
        if (input.webSearchEnabled && !policy.enabled) {
          return { kind: "web_unavailable", policy } as const;
        }
        const active = yield* findActiveRunConflict(userId, chat.id, organizationId);
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

export const loadOwnedChat = (userId: string, chatId: string, organizationId: string | null) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<ChatRow>`
      select chat.id::text, chat.user_id, chat.company_id::text, chat.memory_mode,
             chat.created_at, chat.updated_at
      from chats chat
      join client_companies company on company.id = chat.company_id
      join client_company_memberships membership
        on membership.company_id = chat.company_id
       and membership.user_id = ${userId}
       and membership.revoked_at is null
      where chat.id = ${chatId} and chat.user_id = ${userId}
        and chat.deleted_at is null
        and company.recovery_deleted_at is null
        and company.purged_at is null
        and (
          ${organizationId}::text is null
          or company.clerk_organization_id = ${organizationId}
        )
    `;
    return rows[0] ?? null;
  });

export const readAiRunEventsAfter = (runId: string, afterSeq: number) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql<AiRunEventRow>`
      select seq, event from ai_run_events
      where run_id = ${runId} and seq > ${afterSeq}
      order by seq
    `;
  });

export const readAuthorizedAiRunEventsAfter = (
  userId: string,
  organizationId: string | null,
  runId: string,
  afterSeq: number,
  _configuration: Pick<
    ChatRuntimeConfiguration,
    "webResearchProvider" | "aiWebMaxDomainFilters"
  > = {
    webResearchProvider: null,
    aiWebMaxDomainFilters: 0,
  },
) =>
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
        select run.id as run_id,
               (run.finished_at is not null or run.failed_at is not null) as terminal
        from ai_runs run
        join chats chat on chat.id = run.chat_id
        join client_companies company
          on company.id = chat.company_id
          and company.recovery_deleted_at is null
          and company.purged_at is null
        where run.id = ${runId}
          and chat.deleted_at is null
          and (${organizationId}::text is null or company.clerk_organization_id = ${organizationId})
          and exists (
            select 1 from platform_users viewer
            where viewer.id = ${userId}
              and viewer.recovery_deleted_at is null
              and viewer.purged_at is null
          )
          and (
            chat.user_id = ${userId}
            or (
              chat.shared_at is not null
          and exists (
                select 1 from client_company_memberships membership
            where membership.company_id = chat.company_id
              and membership.user_id = ${userId}
              and membership.revoked_at is null
          )
                )
              )
          )
      select authorized.run_id is not null as authorized,
             authorized.terminal,
             case when authorized.run_id is null then false else exists (
               select 1 from ai_run_events terminal_events
               where terminal_events.run_id = authorized.run_id
                 and terminal_events.seq > ${afterSeq}
                 and terminal_events.event->>'type' in ('done', 'error')
             ) end as "replayableTerminal",
             event_rows.seq, event_rows.event
      from (values (1)) as anchor(value)
      left join authorized on true
      left join lateral (
        select events.seq, events.event
        from ai_run_events events
        where events.run_id = authorized.run_id and events.seq > ${afterSeq}
        order by events.seq
      ) event_rows on authorized.run_id is not null
      order by event_rows.seq nulls first
    `;
    const first = rows[0];
    if (first?.authorized !== true) {
      return {
        authorized: false,
        terminal: false,
        replayableTerminal: false,
        events: [],
      } satisfies AuthorizedAiRunEventPoll;
    }
    return {
      authorized: true,
      terminal: first.terminal === true,
      replayableTerminal: first.replayableTerminal === true,
      events: rows.flatMap((row) =>
        row.seq === null || row.event === null ? [] : [{ seq: row.seq, event: row.event }],
      ),
    } satisfies AuthorizedAiRunEventPoll;
  });
export const readRunStreamContext = (runId: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<RunStreamContext>`
      select run.id::text as "runId", run.chat_id::text as "chatId"
      from ai_runs run
      join chats chat on chat.id = run.chat_id
      join client_companies company on company.id = chat.company_id
      where run.id = ${runId} and chat.deleted_at is null
        and company.recovery_deleted_at is null
        and company.purged_at is null
    `;
    return rows[0] ?? null;
  });
