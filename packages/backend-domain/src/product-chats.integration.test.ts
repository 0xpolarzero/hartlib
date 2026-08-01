import { PgClient } from "@effect/sql-pg";
import { runMigrations } from "@brief/database/migrations";
import { Effect, Redacted } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CHAT_ACTIVE_PURGE_WINDOW_DAYS,
  hasProductChatAccess,
  listProductChats,
  mutateProductChat,
  resetProductChat,
  type ProductChatIdentity,
} from "./product-chats";

const sourceDatabaseUrl = process.env.WORKER_POSTGRES_TEST_DATABASE_URL;
const databaseName = `brief_product_chats_${process.pid}_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;

const withDatabase = (name: string): string => {
  if (sourceDatabaseUrl === undefined)
    throw new Error("WORKER_POSTGRES_TEST_DATABASE_URL is required");
  const url = new URL(sourceDatabaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
};

const adminUrl = (): string => withDatabase("postgres");
const isolatedUrl = (): string => withDatabase(databaseName);
const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;

const runDb = <A, E>(
  effect: Effect.Effect<A, E, PgClient.PgClient>,
  applicationName = "brief-product-chats-test",
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(PgClient.layer({ url: Redacted.make(isolatedUrl()), applicationName })),
    ),
  );

const runAdmin = <A, E>(effect: Effect.Effect<A, E, PgClient.PgClient>): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        PgClient.layer({
          url: Redacted.make(adminUrl()),
          applicationName: "brief-product-chats-admin",
        }),
      ),
    ),
  );

type Fixture = {
  readonly companyId: string;
  readonly publisherCompanyId: string;
  readonly subscriptionId: string;
  readonly accessId: string;
  readonly ownerId: string;
  readonly viewerId: string;
  readonly outsiderId: string;
  readonly owner: ProductChatIdentity;
};

const seedFixture = async (): Promise<Fixture> => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const fixture = {
    companyId: crypto.randomUUID(),
    publisherCompanyId: crypto.randomUUID(),
    subscriptionId: crypto.randomUUID(),
    accessId: crypto.randomUUID(),
    ownerId: `reset-owner-${suffix}`,
    viewerId: `reset-viewer-${suffix}`,
    outsiderId: `reset-outsider-${suffix}`,
  } as const;
  await runDb(
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      yield* sql`
        insert into platform_users (id, primary_email, display_name, clerk_user_id)
        values
          (${fixture.ownerId}, ${`${fixture.ownerId}@example.test`}, 'Reset owner', ${`clerk:${fixture.ownerId}`}),
          (${fixture.viewerId}, ${`${fixture.viewerId}@example.test`}, 'Reset viewer', ${`clerk:${fixture.viewerId}`}),
          (${fixture.outsiderId}, ${`${fixture.outsiderId}@example.test`}, 'Reset outsider', ${`clerk:${fixture.outsiderId}`})
      `;
      yield* sql`
        insert into client_companies (id, name, clerk_organization_id)
        values (${fixture.companyId}, 'Reset company', ${`org:${suffix}`})
      `;
      yield* sql`
        insert into client_company_memberships (company_id, user_id, role)
        values
          (${fixture.companyId}, ${fixture.ownerId}, 'admin'),
          (${fixture.companyId}, ${fixture.viewerId}, 'member'),
          (${fixture.companyId}, ${fixture.outsiderId}, 'admin')
      `;
      yield* sql`
        insert into publisher_companies (id, name)
        values (${fixture.publisherCompanyId}, 'Reset publisher')
      `;
      yield* sql`
        insert into publisher_subscriptions (id, publisher_company_id, name, created_by_user_id)
        values (${fixture.subscriptionId}, ${fixture.publisherCompanyId}, 'Reset source', ${fixture.ownerId})
      `;
      yield* sql`
        insert into client_subscription_accesses (
          id, subscription_id, client_company_id, state, first_admin_email,
          accepted_at, subscribed_at, created_by_user_id
        ) values (
          ${fixture.accessId}, ${fixture.subscriptionId}, ${fixture.companyId}, 'active',
          ${`${fixture.ownerId}@example.test`}, now(), now(), ${fixture.ownerId}
        )
      `;
      yield* sql`
        insert into client_employee_subscription_grants (
          access_id, client_company_id, user_id, granted_by_user_id
        ) values
          (${fixture.accessId}, ${fixture.companyId}, ${fixture.ownerId}, ${fixture.ownerId}),
          (${fixture.accessId}, ${fixture.companyId}, ${fixture.viewerId}, ${fixture.ownerId})
      `;
    }),
  );
  return { ...fixture, owner: { mode: "demo", userId: fixture.ownerId, organizationId: null } };
};

const createChat = (
  fixture: Fixture,
  options: { readonly memoryMode?: "private_owner" | "disabled" } = {},
) => {
  const chatId = crypto.randomUUID();
  const memoryId = crypto.randomUUID();
  const revisionId = crypto.randomUUID();
  return runDb(
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      yield* sql`
        insert into chats (id, user_id, company_id, memory_mode)
        values (${chatId}, ${fixture.ownerId}, ${fixture.companyId}, ${options.memoryMode ?? "disabled"})
      `;
      yield* sql`
        insert into chat_subscription_sources (chat_id, access_id, client_company_id, subscription_id)
        values (${chatId}, ${fixture.accessId}, ${fixture.companyId}, ${fixture.subscriptionId})
      `;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`
            insert into user_memories (id, user_id, kind, content, head_revision_id)
            values (${memoryId}, ${fixture.ownerId}, 'preference', ${`keep this memory ${chatId}`}, ${revisionId})
          `;
          yield* sql`
            insert into user_memory_revisions (id, memory_id, action, state_before, state_after)
            values (
              ${revisionId}, ${memoryId}, 'create', null,
              ${sql.json({ kind: "preference", content: `keep this memory ${chatId}`, deleted: false })}
            )
          `;
        }),
      );
      return chatId;
    }),
  );
};

describe.skipIf(sourceDatabaseUrl === undefined)(
  "archive-and-replace product chat transaction",
  () => {
    beforeAll(async () => {
      await runAdmin(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql.unsafe(`create database ${quoteIdentifier(databaseName)}`).raw;
        }),
      );
      await runDb(runMigrations, "brief-product-chats-migrate");
    });

    afterAll(async () => {
      try {
        await runAdmin(
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`select pg_terminate_backend(pid) from pg_stat_activity where datname = ${databaseName}`;
            yield* sql.unsafe(`drop database if exists ${quoteIdentifier(databaseName)}`).raw;
          }),
        );
      } catch {
        // Best-effort cleanup: the test database is isolated per process, so a
        // failed teardown leaves only an orphan that never affects other runs.
        // All assertions already ran above.
      }
    });

    it("records the migration shape, indexes, and no archive purge clock", async () => {
      const catalog = await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const constraints = yield* sql<{ readonly name: string }>`
          select conname as name from pg_constraint
          where conrelid = 'chats'::regclass and conname like 'chats_archive%'
          order by conname
        `;
          const indexes = yield* sql<{ readonly name: string }>`
          select indexname as name from pg_indexes
          where tablename = 'chats' and indexname in (
            'chats_replaced_by_chat_id_key', 'chats_active_owner_idx', 'chats_archived_owner_idx'
          )
          order by indexname
        `;
          return {
            constraints: constraints.map((row) => row.name),
            indexes: indexes.map((row) => row.name),
          };
        }),
      );
      expect(catalog.constraints).toEqual([
        "chats_archive_before_delete",
        "chats_archive_no_self_reference",
        "chats_archive_shape",
      ]);
      expect(catalog.indexes).toEqual([
        "chats_active_owner_idx",
        "chats_archived_owner_idx",
        "chats_replaced_by_chat_id_key",
      ]);
      const fixture = await seedFixture();
      const chatId = await createChat(fixture, { memoryMode: "private_owner" });
      const replacementChatId = crypto.randomUUID();
      await expect(
        runDb(resetProductChat(fixture.owner, chatId, replacementChatId)),
      ).resolves.toMatchObject({
        kind: "created",
        replacementChatId,
      });
      const row = await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return (yield* sql<{ readonly purgeAfter: Date | null }>`
          select purge_after as "purgeAfter" from chats where id = ${chatId}
        `)[0];
        }),
      );
      expect(row?.purgeAfter).toBeNull();
    });

    it("archives and replaces atomically, copying immutable configuration and exact sources", async () => {
      const fixture = await seedFixture();
      const chatId = await createChat(fixture, { memoryMode: "private_owner" });
      const replacementChatId = crypto.randomUUID();
      await expect(
        runDb(resetProductChat(fixture.owner, chatId, replacementChatId)),
      ).resolves.toEqual({
        kind: "created",
        archivedChatId: chatId,
        replacementChatId,
      });
      const rows = await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const chats = yield* sql<{
            readonly id: string;
            readonly companyId: string;
            readonly memoryMode: string;
            readonly archivedAt: Date | null;
            readonly archivedBy: string | null;
            readonly replacedBy: string | null;
          }>`
          select id::text, company_id::text as "companyId", memory_mode as "memoryMode",
                 archived_at as "archivedAt", archived_by_user_id as "archivedBy",
                 replaced_by_chat_id::text as "replacedBy"
          from chats where id in (${chatId}, ${replacementChatId}) order by id
        `;
          const sources = yield* sql<{ readonly chatId: string; readonly accessId: string }>`
          select chat_id::text as "chatId", access_id::text as "accessId"
          from chat_subscription_sources where chat_id in (${chatId}, ${replacementChatId})
          order by chat_id
        `;
          const memories = yield* sql<{ readonly count: number }>`
          select count(*)::int as count from user_memories where user_id = ${fixture.ownerId} and deleted_at is null
        `;
          return { chats, sources, memories };
        }),
      );
      const predecessor = rows.chats.find((chat) => chat.id === chatId);
      const replacement = rows.chats.find((chat) => chat.id === replacementChatId);
      expect(predecessor).toMatchObject({
        companyId: fixture.companyId,
        memoryMode: "private_owner",
        archivedBy: fixture.ownerId,
        replacedBy: replacementChatId,
      });
      expect(predecessor?.archivedAt).toBeInstanceOf(Date);
      expect(replacement).toMatchObject({
        companyId: fixture.companyId,
        memoryMode: "private_owner",
        archivedAt: null,
        archivedBy: null,
        replacedBy: null,
      });
      expect(rows.sources).toEqual(
        expect.arrayContaining([
          { chatId, accessId: fixture.accessId },
          { chatId: replacementChatId, accessId: fixture.accessId },
        ]),
      );
      expect(rows.sources).toHaveLength(2);
      expect(rows.memories[0]?.count).toBe(1);
      const mine = await runDb(listProductChats(fixture.owner, "mine"));
      const archived = await runDb(listProductChats(fixture.owner, "archived"));
      expect(mine.map((chat) => chat.id)).toContain(replacementChatId);
      expect(mine.map((chat) => chat.id)).not.toContain(chatId);
      expect(archived.map((chat) => chat.id)).toContain(chatId);
    });

    it("retains archived history while its deleted replacement is physically purged", async () => {
      const fixture = await seedFixture();
      const chatId = await createChat(fixture);
      const replacementChatId = crypto.randomUUID();
      await expect(
        runDb(resetProductChat(fixture.owner, chatId, replacementChatId)),
      ).resolves.toMatchObject({
        kind: "created",
        archivedChatId: chatId,
        replacementChatId,
      });

      await expect(
        runDb(mutateProductChat(fixture.owner, replacementChatId, "delete")),
      ).resolves.toBe("ok");
      const retainedDuringDeletion = await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return (yield* sql<{
            readonly replacedByChatId: string | null;
            readonly replacementDeletedAt: Date | null;
            readonly replacementPurgeAfter: Date | null;
          }>`
            select predecessor.replaced_by_chat_id::text as "replacedByChatId",
                   replacement.deleted_at as "replacementDeletedAt",
                   replacement.purge_after as "replacementPurgeAfter"
            from chats predecessor
            join chats replacement on replacement.id = predecessor.replaced_by_chat_id
            where predecessor.id = ${chatId}
          `)[0]!;
        }),
      );
      expect(retainedDuringDeletion).toEqual({
        replacedByChatId: replacementChatId,
        replacementDeletedAt: expect.any(Date),
        replacementPurgeAfter: expect.any(Date),
      });

      await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            update chats
            set deleted_at = now() - interval '31 days',
                purge_after = now() - interval '1 day'
            where id = ${replacementChatId}
          `;
          yield* sql`delete from chats where id = ${replacementChatId}`;
        }),
      );
      const predecessor = await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return (yield* sql<{
            readonly archivedAt: Date | null;
            readonly archivedByUserId: string | null;
            readonly replacedByChatId: string | null;
            readonly purgeAfter: Date | null;
          }>`
            select archived_at as "archivedAt",
                   archived_by_user_id as "archivedByUserId",
                   replaced_by_chat_id::text as "replacedByChatId",
                   purge_after as "purgeAfter"
            from chats
            where id = ${chatId}
          `)[0]!;
        }),
      );
      expect(predecessor).toMatchObject({
        archivedAt: expect.any(Date),
        archivedByUserId: fixture.ownerId,
        replacedByChatId: null,
        purgeAfter: null,
      });

      const activeChatId = await createChat(fixture);
      await expect(
        runDb(
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
              update chats
              set replaced_by_chat_id = ${chatId}
              where id = ${activeChatId}
            `;
          }),
        ),
      ).rejects.toThrow();
    });

    it("replays one identity, rejects competing identities, and rejects a pre-used replacement", async () => {
      const fixture = await seedFixture();
      const chatId = await createChat(fixture);
      const replacementChatId = crypto.randomUUID();
      await expect(
        runDb(resetProductChat(fixture.owner, chatId, replacementChatId)),
      ).resolves.toMatchObject({ kind: "created" });
      await expect(
        runDb(resetProductChat(fixture.owner, chatId, replacementChatId)),
      ).resolves.toEqual({
        kind: "replay",
        archivedChatId: chatId,
        replacementChatId,
      });
      await expect(
        runDb(resetProductChat(fixture.owner, chatId, crypto.randomUUID())),
      ).resolves.toEqual({
        kind: "already_reset",
        archivedChatId: chatId,
      });

      const secondChatId = await createChat(fixture);
      await expect(
        runDb(resetProductChat(fixture.owner, secondChatId, replacementChatId)),
      ).resolves.toEqual({
        kind: "replacement_conflict",
      });
      const active = await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return (yield* sql<{ readonly archivedAt: Date | null }>`
          select archived_at as "archivedAt" from chats where id = ${secondChatId}
        `)[0]?.archivedAt;
        }),
      );
      expect(active).toBeNull();
    });

    it("linearizes competing resets to one successor", async () => {
      const fixture = await seedFixture();
      const chatId = await createChat(fixture);
      const firstId = crypto.randomUUID();
      const secondId = crypto.randomUUID();
      const [first, second] = await Promise.all([
        runDb(resetProductChat(fixture.owner, chatId, firstId), "brief-product-chats-race-a"),
        runDb(resetProductChat(fixture.owner, chatId, secondId), "brief-product-chats-race-b"),
      ]);
      expect([first.kind, second.kind].sort()).toEqual(["already_reset", "created"]);
      const successors = await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return yield* sql<{ readonly count: number }>`
          select count(*)::int as count from chats where replaced_by_chat_id = ${first.kind === "created" ? firstId : secondId}
        `;
        }),
      );
      expect(successors[0]?.count).toBe(1);
    });

    it("fails closed for ownership, organization, membership, and revoked source access", async () => {
      const fixture = await seedFixture();
      const nonOwnerChat = await createChat(fixture);
      await expect(
        runDb(
          resetProductChat(
            { ...fixture.owner, userId: fixture.viewerId },
            nonOwnerChat,
            crypto.randomUUID(),
          ),
        ),
      ).resolves.toEqual({ kind: "forbidden" });

      const wrongOrgChat = await createChat(fixture);
      await expect(
        runDb(
          resetProductChat(
            { mode: "clerk", userId: fixture.ownerId, organizationId: "org:wrong" },
            wrongOrgChat,
            crypto.randomUUID(),
          ),
        ),
      ).resolves.toEqual({ kind: "forbidden" });

      const revokedMembershipChat = await createChat(fixture);
      await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
          update client_company_memberships
          set revoked_at = now(), revoked_by_user_id = ${fixture.viewerId}
          where company_id = ${fixture.companyId} and user_id = ${fixture.ownerId}
        `;
        }),
      );
      await expect(
        runDb(resetProductChat(fixture.owner, revokedMembershipChat, crypto.randomUUID())),
      ).resolves.toEqual({ kind: "forbidden" });
      await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
          update client_company_memberships
          set revoked_at = null, revoked_by_user_id = null
          where company_id = ${fixture.companyId} and user_id = ${fixture.ownerId}
        `;
        }),
      );

      const revokedSourceChat = await createChat(fixture);
      await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
          update client_employee_subscription_grants
          set revoked_at = now(), revoked_by_user_id = ${fixture.viewerId}
          where access_id = ${fixture.accessId} and client_company_id = ${fixture.companyId} and user_id = ${fixture.ownerId}
        `;
        }),
      );
      await expect(
        runDb(resetProductChat(fixture.owner, revokedSourceChat, crypto.randomUUID())),
      ).resolves.toEqual({ kind: "forbidden" });
      const replacementCount = await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return (yield* sql<{ readonly count: number }>`
          select count(*)::int as count from chats where user_id = ${fixture.ownerId} and replaced_by_chat_id is not null
        `)[0]?.count;
        }),
      );
      expect(replacementCount).toBe(0);
    });

    it("keeps archived reads and creator deletion while denying archived writes and new shares", async () => {
      const fixture = await seedFixture();
      const chatId = await createChat(fixture);
      const replacementChatId = crypto.randomUUID();
      await runDb(resetProductChat(fixture.owner, chatId, replacementChatId));
      await expect(runDb(hasProductChatAccess(fixture.owner, chatId, "read"))).resolves.toBe(true);
      await expect(runDb(hasProductChatAccess(fixture.owner, chatId, "write"))).resolves.toBe(
        false,
      );
      await expect(runDb(hasProductChatAccess(fixture.owner, chatId, "share"))).resolves.toBe(
        false,
      );
      await expect(runDb(hasProductChatAccess(fixture.owner, chatId, "delete"))).resolves.toBe(
        true,
      );
      await expect(runDb(mutateProductChat(fixture.owner, chatId, "unshare"))).resolves.toBe("ok");
      await expect(runDb(mutateProductChat(fixture.owner, chatId, "delete"))).resolves.toBe("ok");
      const retention = await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return (yield* sql<{ readonly deletedAt: Date | null; readonly purgeAfter: Date | null }>`
          select deleted_at as "deletedAt", purge_after as "purgeAfter" from chats where id = ${chatId}
        `)[0];
        }),
      );
      expect(retention?.deletedAt).toBeInstanceOf(Date);
      expect(retention?.purgeAfter).toBeInstanceOf(Date);
      expect(retention?.purgeAfter?.getTime()).toBeGreaterThan(
        retention?.deletedAt!.getTime() ?? 0,
      );
      expect(CHAT_ACTIVE_PURGE_WINDOW_DAYS).toBe(30);
    });

    it("rejects malformed archive rows at the database boundary", async () => {
      const fixture = await seedFixture();
      const shapeChat = await createChat(fixture);
      await expect(
        runDb(
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`update chats set archived_at = now() where id = ${shapeChat}`;
          }),
        ),
      ).rejects.toThrow();
      const selfChat = await createChat(fixture);
      await expect(
        runDb(
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`
            update chats
            set archived_at = now(), archived_by_user_id = ${fixture.ownerId}, replaced_by_chat_id = ${selfChat}
            where id = ${selfChat}
          `;
          }),
        ),
      ).rejects.toThrow();
    });
  },
);
