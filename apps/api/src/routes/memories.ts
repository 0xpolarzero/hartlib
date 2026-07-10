import { PgClient } from "@effect/sql-pg";
import { Config, Effect, Layer, Redacted } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { resolveDemoUserId } from "../demo-user";
import { json, type Route } from "../http";

type PgLayer = Layer.Layer<PgClient.PgClient | SqlClient, Config.ConfigError | SqlError, never>;

interface MemoryRow {
  readonly id: string;
  readonly kind: string;
  readonly content: string;
  readonly deleted_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface RevisionRow {
  readonly id: string;
  readonly memory_id: string;
  readonly action: string;
  readonly content_before: string | null;
  readonly content_after: string | null;
  readonly run_id: string | null;
  readonly created_at: Date;
}

const PgLayer = PgClient.layerConfig({
  url: Config.string("DATABASE_URL").pipe(
    Config.withDefault("postgres://brief:brief@localhost:5432/brief"),
    Config.map(Redacted.make),
  ),
  applicationName: Config.succeed("brief-api"),
});

const memoryResponse = (memory: MemoryRow, revisions: readonly RevisionRow[]) => ({
  id: memory.id,
  kind: memory.kind,
  content: memory.content,
  deleted: memory.deleted_at !== null,
  deletedAt: memory.deleted_at?.toISOString() ?? null,
  createdAt: memory.created_at.toISOString(),
  updatedAt: memory.updated_at.toISOString(),
  revisions: revisions.map((revision) => ({
    id: revision.id,
    action: revision.action,
    contentBefore: revision.content_before,
    contentAfter: revision.content_after,
    runId: revision.run_id,
    createdAt: revision.created_at.toISOString(),
  })),
});

const listMemories = (userId: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const memories = yield* sql<MemoryRow>`
      select id::text, kind, content, deleted_at, created_at, updated_at
      from user_memories
      where user_id = ${userId}
      order by deleted_at nulls first, updated_at desc, created_at desc
    `;
    const ids = memories.map((memory) => memory.id);
    const revisions =
      ids.length === 0
        ? []
        : yield* sql<RevisionRow>`
            select
              id::text,
              memory_id::text,
              action,
              content_before,
              content_after,
              run_id::text,
              created_at
            from user_memory_revisions
            where ${sql.in("memory_id", ids)}
            order by created_at asc, id asc
          `;
    const revisionsByMemoryId = new Map<string, RevisionRow[]>();
    for (const revision of revisions) {
      const rows = revisionsByMemoryId.get(revision.memory_id) ?? [];
      rows.push(revision);
      revisionsByMemoryId.set(revision.memory_id, rows);
    }

    return {
      memories: memories.map((memory) =>
        memoryResponse(memory, revisionsByMemoryId.get(memory.id) ?? []),
      ),
    };
  });

const readMemoryId = (url: URL): string =>
  decodeURIComponent(/^\/v1\/memories\/([^/]+)\/revert\/?$/.exec(url.pathname)?.[1] ?? "");

const revertMemory = (userId: string, memoryId: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;

    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const memories = yield* sql<MemoryRow>`
          select id::text, kind, content, deleted_at, created_at, updated_at
          from user_memories
          where id = ${memoryId}
            and user_id = ${userId}
          for update
        `;
        const memory = memories[0];
        if (memory === undefined) return null;

        const latest = yield* sql<RevisionRow>`
          select
            id::text,
            memory_id::text,
            action,
            content_before,
            content_after,
            run_id::text,
            created_at
          from user_memory_revisions
          where memory_id = ${memoryId}
          order by created_at desc, id desc
          limit 1
        `;
        const latestRevision = latest[0];
        const restoredContent = latestRevision?.content_before ?? memory.content;

        const updated = yield* sql<MemoryRow>`
          update user_memories
          set content = ${restoredContent},
              deleted_at = null,
              updated_at = now()
          where id = ${memoryId}
          returning id::text, kind, content, deleted_at, created_at, updated_at
        `;
        yield* sql`
          insert into user_memory_revisions (memory_id, action, content_before, content_after)
          values (${memoryId}, 'reverted', ${memory.content}, ${restoredContent})
        `;
        const revisions = yield* sql<RevisionRow>`
          select
            id::text,
            memory_id::text,
            action,
            content_before,
            content_after,
            run_id::text,
            created_at
          from user_memory_revisions
          where memory_id = ${memoryId}
          order by created_at asc, id asc
        `;

        return memoryResponse(updated[0]!, revisions);
      }),
    );
  });

export const makeMemoryRoutes = (pgLayer: PgLayer = PgLayer): readonly Route[] => [
  {
    method: "GET",
    pattern: /^\/v1\/memories\/?$/,
    handle: (request) =>
      Effect.gen(function* () {
        const userId = yield* resolveDemoUserId(request);
        return yield* listMemories(userId).pipe(Effect.provide(pgLayer), Effect.map(json));
      }),
  },
  {
    method: "POST",
    pattern: /^\/v1\/memories\/[^/]+\/revert\/?$/,
    handle: (request, url) =>
      Effect.gen(function* () {
        const userId = yield* resolveDemoUserId(request);
        const memory = yield* revertMemory(userId, readMemoryId(url)).pipe(Effect.provide(pgLayer));
        if (memory === null) return json({ error: "not_found" }, { status: 404 });
        return json({ memory });
      }),
  },
];

export const memoryRoutes = makeMemoryRoutes();
