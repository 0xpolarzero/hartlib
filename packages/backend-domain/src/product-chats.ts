import { PgClient } from "@effect/sql-pg";
import type { CreateProductChatRequest } from "@brief/shared";
import { Effect } from "effect";

export const CHAT_ACTIVE_PURGE_WINDOW_DAYS = 30;

export interface ProductChatIdentity {
  readonly mode: "demo" | "clerk";
  readonly userId: string;
  readonly organizationId: string | null;
}

export interface ProductChatListRow {
  readonly id: string;
  readonly companyId: string;
  readonly creatorUserId: string;
  readonly memoryMode: "private_owner" | "disabled";
  readonly sharedAt: Date | null;
  readonly archivedAt: Date | null;
  readonly replacedByChatId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly sourceCount: number;
}

interface SourceRow {
  readonly accessId: string;
  readonly subscriptionId: string;
}

const organizationMatchesCompany = (identity: ProductChatIdentity, companyId: string) =>
  Effect.gen(function* () {
    if (identity.mode === "demo" || identity.organizationId === null) return true;
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<{ readonly matches: boolean }>`
      select exists (
        select 1 from client_companies
        where id = ${companyId}
          and clerk_organization_id = ${identity.organizationId}
          and recovery_deleted_at is null
      ) as matches
    `;
    return rows[0]?.matches === true;
  });

export const listProductChats = (
  identity: ProductChatIdentity,
  view: "mine" | "shared" | "archived",
) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const candidates = yield* sql<{ readonly id: string }>`
          select membership.company_id::text as id
          from client_company_memberships membership
          join client_companies company on company.id = membership.company_id
          where membership.user_id = ${identity.userId}
            and membership.revoked_at is null
            and company.recovery_deleted_at is null and company.purged_at is null
            and (
              ${identity.mode} = 'demo'
              or ${identity.organizationId}::text is null
              or company.clerk_organization_id = ${identity.organizationId}
            )
          order by membership.company_id::text
        `;
        for (const candidate of candidates) {
          yield* sql`
            select pg_advisory_xact_lock(
              hashtext(${`brief:client-members:${candidate.id}`})
            )
          `;
        }
        return yield* sql<ProductChatListRow>`
          select chat.id::text as "id", chat.company_id::text as "companyId",
                 chat.user_id as "creatorUserId", chat.memory_mode as "memoryMode",
                 chat.shared_at as "sharedAt", chat.archived_at as "archivedAt",
                 chat.replaced_by_chat_id::text as "replacedByChatId",
                 chat.created_at as "createdAt", chat.updated_at as "updatedAt",
                 count(selected.access_id)::integer as "sourceCount"
          from chats chat
          join client_companies company
            on company.id = chat.company_id
           and company.recovery_deleted_at is null and company.purged_at is null
          join client_company_memberships membership
            on membership.company_id = chat.company_id and membership.user_id = ${identity.userId}
           and membership.revoked_at is null
          join platform_users users
            on users.id = membership.user_id
           and users.recovery_deleted_at is null and users.purged_at is null
          join platform_users creator
            on creator.id = chat.user_id
           and creator.recovery_deleted_at is null and creator.purged_at is null
          left join chat_subscription_sources selected on selected.chat_id = chat.id
          where chat.deleted_at is null
            and (
              ${identity.mode} = 'demo'
              or ${identity.organizationId}::text is null
              or company.clerk_organization_id = ${identity.organizationId}
            )
            and (
              -- Archived history is owned and read-only, so it is listed
              -- regardless of later source revocation. Active chats still
              -- require current access to every selected subscription source.
              ${view} = 'archived'
              or not exists (
                select 1 from chat_subscription_sources required_source
                where required_source.chat_id = chat.id
                  and not exists (
                    select 1
                    from client_employee_subscription_grants grant_row
                    join client_subscription_accesses access_row
                      on access_row.id = grant_row.access_id
                     and access_row.client_company_id = grant_row.client_company_id
                    where grant_row.access_id = required_source.access_id
                      and grant_row.client_company_id = chat.company_id
                      and grant_row.user_id = ${identity.userId}
                      and grant_row.granted_at <= now()
                      and (grant_row.revoked_at is null or grant_row.revoked_at > now())
                      and access_row.state in ('active', 'ending', 'paused')
                  )
              )
            )
            and (
              (${view} = 'mine' and chat.user_id = ${identity.userId} and chat.archived_at is null)
              or (${view} = 'shared' and chat.shared_at is not null and chat.memory_mode = 'disabled' and chat.archived_at is null)
              or (${view} = 'archived' and chat.archived_at is not null and chat.user_id = ${identity.userId})
            )
          group by chat.id
          order by chat.updated_at desc, chat.id
        `;
      }),
    );
  });

const authorizedSources = (
  identity: ProductChatIdentity,
  companyId: string,
  requested: readonly string[] | undefined,
) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const all = yield* sql<SourceRow>`
      select access_row.id::text as "accessId",
             access_row.subscription_id::text as "subscriptionId"
      from client_employee_subscription_grants employee_grant
      join client_companies company
        on company.id = employee_grant.client_company_id
       and company.recovery_deleted_at is null
      join client_subscription_accesses access_row on access_row.id = employee_grant.access_id
      where employee_grant.client_company_id = ${companyId}
        and employee_grant.user_id = ${identity.userId}
        and employee_grant.revoked_at is null
        and access_row.state in ('active', 'ending', 'paused')
      order by access_row.subscribed_at, access_row.id
    `;
    if (requested === undefined) return all;
    const byId = new Map(all.map((source) => [source.accessId, source]));
    return requested.flatMap((id) => {
      const source = byId.get(id);
      return source === undefined ? [] : [source];
    });
  });

export const createProductChat = (identity: ProductChatIdentity, body: CreateProductChatRequest) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          select pg_advisory_xact_lock(hashtext(${`brief:client-members:${body.companyId}`}))
        `;
        yield* sql`
          select pg_advisory_xact_lock(hashtext(${`brief:create-chat:${identity.userId}`}))
        `;
        const membership = yield* sql<{ readonly exists: boolean }>`
          select exists (
            select 1
            from client_company_memberships membership
            join client_companies company on company.id = membership.company_id
            join platform_users users
              on users.id = membership.user_id
             and users.recovery_deleted_at is null and users.purged_at is null
            where membership.company_id = ${body.companyId}
              and membership.user_id = ${identity.userId}
              and membership.revoked_at is null
              and company.recovery_deleted_at is null
          ) as exists
        `;
        if (membership[0]?.exists !== true) return { kind: "forbidden" } as const;
        if (!(yield* organizationMatchesCompany(identity, body.companyId))) {
          return { kind: "forbidden" } as const;
        }
        const sources = yield* authorizedSources(identity, body.companyId, body.sourceAccessIds);
        if (body.sourceAccessIds !== undefined && sources.length !== body.sourceAccessIds.length) {
          return { kind: "forbidden" } as const;
        }
        const rows = yield* sql<{ readonly id: string; readonly createdAt: Date }>`
          insert into chats (user_id, company_id, memory_mode)
          values (${identity.userId}, ${body.companyId}, ${body.memoryMode})
          returning id::text as "id", created_at as "createdAt"
        `;
        const chat = rows[0]!;
        for (const source of sources) {
          yield* sql`
            insert into chat_subscription_sources (
              chat_id, access_id, client_company_id, subscription_id
            ) values (${chat.id}, ${source.accessId}, ${body.companyId}, ${source.subscriptionId})
          `;
        }
        return { kind: "created", chat, sources } as const;
      }),
    );
  });

export type ResetProductChatResult =
  | {
      readonly kind: "created";
      readonly archivedChatId: string;
      readonly replacementChatId: string;
    }
  | { readonly kind: "replay"; readonly archivedChatId: string; readonly replacementChatId: string }
  | { readonly kind: "already_reset"; readonly archivedChatId: string }
  | { readonly kind: "replacement_conflict" }
  | { readonly kind: "forbidden" };

interface ArchivedChatRow {
  readonly company_id: string;
  readonly user_id: string;
  readonly memory_mode: "private_owner" | "disabled";
  readonly archived_at: Date | null;
  readonly replaced_by_chat_id: string | null;
}

/**
 * One atomic, locked archive-and-replace. The old chat becomes read-only
 * history while a fresh replacement inherits its company, immutable memory
 * mode, and exact selected subscription sources. The shared lock order matches
 * message acceptance and worker finalization so a reset, a late message, and a
 * late answer are ordered without partial cross-chat results.
 *
 * The client-supplied replacement UUID is the replay key: a retry with the same
 * old id and replacement id returns the same committed row, a different
 * replacement id for an already archived chat is rejected, and any
 * authorization or source-access failure creates nothing.
 */
export const resetProductChat = (
  identity: ProductChatIdentity,
  chatId: string,
  replacementChatId: string,
) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        // Match message acceptance and finalization before taking the chat
        // row: user-memory, chat row, company membership, then chat execution.
        yield* sql`
          select pg_advisory_xact_lock(hashtext(${`brief:user-memory:${identity.userId}`}))
        `;
        const oldChats = yield* sql<ArchivedChatRow>`
          select company_id::text as company_id, user_id, memory_mode,
                 archived_at, replaced_by_chat_id::text as replaced_by_chat_id
          from chats
          where id = ${chatId} and deleted_at is null
          for update
        `;
        const old = oldChats[0];
        if (old === undefined) return { kind: "forbidden" } as const;
        // Continue the established order with company membership, chat
        // execution, then the create-chat lane shared with createProductChat.
        yield* sql`
          select pg_advisory_xact_lock(
            hashtext(${`brief:client-members:${old.company_id}`})
          )
        `;
        yield* sql`select pg_advisory_xact_lock(hashtext(${`brief:ai-chat:${chatId}`}))`;
        yield* sql`
          select pg_advisory_xact_lock(hashtext(${`brief:create-chat:${identity.userId}`}))
        `;
        if (old.user_id !== identity.userId) return { kind: "forbidden" } as const;
        if (!(yield* organizationMatchesCompany(identity, old.company_id))) {
          return { kind: "forbidden" } as const;
        }
        const membership = yield* sql<{ readonly active: boolean }>`
          select exists (
            select 1
            from client_company_memberships membership
            join client_companies company on company.id = membership.company_id
            join platform_users users on users.id = membership.user_id
            where membership.company_id = ${old.company_id}
              and membership.user_id = ${identity.userId}
              and membership.revoked_at is null
              and company.recovery_deleted_at is null
              and company.purged_at is null
              and users.recovery_deleted_at is null
              and users.purged_at is null
          ) as active
        `;
        if (membership[0]?.active !== true) return { kind: "forbidden" } as const;
        if (old.archived_at !== null) {
          if (old.replaced_by_chat_id === replacementChatId) {
            return { kind: "replay", archivedChatId: chatId, replacementChatId } as const;
          }
          return { kind: "already_reset", archivedChatId: chatId } as const;
        }
        // Fail closed: the caller must still hold write access to every
        // selected subscription source before any replacement row is written.
        const access = yield* sql<{ readonly ok: boolean }>`
          select not exists (
            select 1 from chat_subscription_sources selected
            where selected.chat_id = ${chatId}
              and not exists (
                select 1
                from client_employee_subscription_grants grant_row
                join client_subscription_accesses access_row
                  on access_row.id = grant_row.access_id
                 and access_row.client_company_id = grant_row.client_company_id
                where grant_row.access_id = selected.access_id
                  and grant_row.client_company_id = ${old.company_id}
                  and grant_row.user_id = ${identity.userId}
                  and grant_row.granted_at <= now()
                  and (grant_row.revoked_at is null or grant_row.revoked_at > now())
                  and access_row.state in ('active', 'ending', 'paused')
              )
          ) as ok
        `;
        if (access[0]?.ok !== true) return { kind: "forbidden" } as const;
        // Insert the replacement atomically. ON CONFLICT removes the
        // check-then-insert window so two concurrent resets that supply the
        // same replacement UUID for different predecessors cannot both pass a
        // prior SELECT and then race on the primary key. The loser inserts no
        // row and receives a clean replacement_conflict without archiving.
        const inserted = yield* sql<{ readonly id: string }>`
          insert into chats (id, user_id, company_id, memory_mode)
          values (${replacementChatId}, ${identity.userId}, ${old.company_id}, ${old.memory_mode})
          on conflict (id) do nothing
          returning id::text
        `;
        if (inserted[0] === undefined) return { kind: "replacement_conflict" } as const;
        yield* sql`
          insert into chat_subscription_sources (
            chat_id, access_id, client_company_id, subscription_id
          )
          select ${replacementChatId}, access_id, client_company_id, subscription_id
          from chat_subscription_sources
          where chat_id = ${chatId}
        `;
        // Fail any still-active run on the archived chat so it cannot commit a
        // late answer or block the replacement through the per-user active-run
        // guard. The shared chat lock ordered this against worker finalization:
        // either the run already finished before archive, or archive wins and
        // the run is terminal before the replacement accepts its first message.
        yield* sql`
          update ai_runs
          set failed_at = now(),
              error_code = 'chat_archived',
              retryable = false
          where chat_id = ${chatId}
            and finished_at is null
            and failed_at is null
        `;
        yield* sql`
          update chats
          set archived_at = now(),
              archived_by_user_id = ${identity.userId},
              replaced_by_chat_id = ${replacementChatId},
              updated_at = now()
          where id = ${chatId} and archived_at is null
        `;
        return { kind: "created", archivedChatId: chatId, replacementChatId } as const;
      }),
    );
  });

export const hasProductChatAccess = (
  identity: ProductChatIdentity,
  chatId: string,
  operation: "read" | "write" | "share" | "delete",
) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<{ readonly exists: boolean }>`
      select exists (
        select 1 from chats chat
        join client_companies company on company.id = chat.company_id
        join platform_users creator
          on creator.id = chat.user_id
         and creator.recovery_deleted_at is null and creator.purged_at is null
        where chat.id = ${chatId} and chat.deleted_at is null
          and company.recovery_deleted_at is null
          and exists (
            select 1 from client_company_memberships membership
            join platform_users users
              on users.id = membership.user_id
             and users.recovery_deleted_at is null and users.purged_at is null
            where membership.company_id = chat.company_id
              and membership.user_id = ${identity.userId}
              and membership.revoked_at is null
          )
          and (
            ${operation} = 'delete'
            or not exists (
              select 1 from chat_subscription_sources selected
              where selected.chat_id = chat.id
                and not exists (
                  select 1
                  from client_employee_subscription_grants employee_grant
                  join client_subscription_accesses access_row on access_row.id = employee_grant.access_id
                  where employee_grant.access_id = selected.access_id
                    and employee_grant.user_id = ${identity.userId}
                    and employee_grant.client_company_id = chat.company_id
                    and employee_grant.revoked_at is null
                    and access_row.state in ('active', 'ending', 'paused')
                )
            )
          )
          and (
            -- Archived chats are read-only history. Reads and explicit
            -- creator delete/unshare remain allowed; new writes and ordinary
            -- sharing changes require a live chat.
            ${operation} in ('read', 'delete')
            or chat.archived_at is null
          )
          and (
            chat.user_id = ${identity.userId}
            or (${operation} = 'read' and chat.shared_at is not null and chat.memory_mode = 'disabled')
          )
      ) as exists
    `;
    return rows[0]?.exists === true;
  });

export const mutateProductChat = (
  identity: ProductChatIdentity,
  chatId: string,
  operation: "share" | "unshare" | "delete",
) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const candidates = yield* sql<{ readonly companyId: string }>`
          select company_id::text as "companyId"
          from chats
          where id = ${chatId} and deleted_at is null
          for update
        `;
        const candidate = candidates[0];
        if (candidate === undefined) return "forbidden" as const;
        yield* sql`
          select pg_advisory_xact_lock(
            hashtext(${`brief:client-members:${candidate.companyId}`})
          )
        `;
        yield* sql`select pg_advisory_xact_lock(hashtext(${`brief:ai-chat:${chatId}`}))`;
        if (!(yield* organizationMatchesCompany(identity, candidate.companyId))) {
          return "forbidden" as const;
        }
        // Unsharing and deletion only retract content. The creator keeps this lifecycle
        // authority after source revocation, while sharing still requires current access.
        const required = operation === "unshare" ? "delete" : operation;
        if (!(yield* hasProductChatAccess(identity, chatId, required))) {
          return "forbidden" as const;
        }
        if (operation === "share") {
          const rows = yield* sql<{ readonly id: string }>`
            update chats set shared_at = coalesce(shared_at, now()), updated_at = now()
            where id = ${chatId} and user_id = ${identity.userId}
              and deleted_at is null and memory_mode = 'disabled'
            returning id::text
          `;
          return rows[0] === undefined ? "forbidden" : "ok";
        }
        if (operation === "unshare") {
          const rows = yield* sql<{ readonly id: string }>`
            update chats set shared_at = null, updated_at = now()
            where id = ${chatId} and user_id = ${identity.userId} and deleted_at is null
            returning id::text
          `;
          return rows[0] === undefined ? "forbidden" : "ok";
        }
        const rows = yield* sql<{ readonly id: string }>`
          update chats
          set deleted_at = now(), deleted_by_user_id = ${identity.userId},
              purge_after = now() + (${CHAT_ACTIVE_PURGE_WINDOW_DAYS} * interval '1 day'),
              shared_at = null, updated_at = now()
          where id = ${chatId} and user_id = ${identity.userId} and deleted_at is null
          returning id::text
        `;
        return rows[0] === undefined ? "forbidden" : "ok";
      }),
    );
  });
