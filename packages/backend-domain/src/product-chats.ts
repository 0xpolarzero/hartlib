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

export const listProductChats = (identity: ProductChatIdentity, view: "mine" | "shared") =>
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
                 chat.shared_at as "sharedAt", chat.created_at as "createdAt",
                 chat.updated_at as "updatedAt", count(selected.access_id)::integer as "sourceCount"
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
            and not exists (
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
                    and grant_row.revoked_at is null
                    and access_row.state in ('active', 'ending', 'paused')
                )
            )
            and (
              (${view} = 'mine' and chat.user_id = ${identity.userId})
              or (${view} = 'shared' and chat.shared_at is not null and chat.memory_mode = 'disabled')
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
