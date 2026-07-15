import { PgClient } from "@effect/sql-pg";
import {
  type MemoryKind,
  type MemoryRecord,
  type MemoryRevision,
  type MemorySnapshot,
} from "@brief/shared";
import { Effect } from "effect";

interface MemoryRow {
  readonly id: string;
  readonly kind: MemoryKind | null;
  readonly content: string | null;
  readonly head_revision_id: string | null;
  readonly deleted_at: Date | null;
  readonly provenance_only_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface RevisionRow {
  readonly id: string;
  readonly memory_id: string;
  readonly action: "create" | "update" | "delete" | "revert";
  readonly state_before: unknown;
  readonly state_after: unknown;
  readonly created_at: Date;
}

interface ActiveRunRow {
  readonly id: string;
}

const memoryKinds: readonly MemoryKind[] = [
  "profile",
  "preference",
  "instruction",
  "fact",
  "episode",
];

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const snapshotFrom = (value: unknown): MemorySnapshot => {
  const record = asRecord(value);
  if (
    typeof record.kind !== "string" ||
    !memoryKinds.includes(record.kind as MemoryKind) ||
    typeof record.content !== "string" ||
    typeof record.deleted !== "boolean"
  ) {
    throw new Error("invalid persisted memory revision snapshot");
  }
  return {
    kind: record.kind as MemoryKind,
    content: record.content,
    deleted: record.deleted,
  };
};

export const memoryRevisionResponse = (revision: RevisionRow): MemoryRevision => ({
  id: revision.id,
  action: revision.action,
  before: revision.state_before === null ? null : snapshotFrom(revision.state_before),
  after: snapshotFrom(revision.state_after),
  createdAt: revision.created_at.toISOString(),
});

const memoryResponse = (memory: MemoryRow, revisions: readonly RevisionRow[]): MemoryRecord => {
  if (memory.kind === null || memory.content === null || memory.head_revision_id === null) {
    throw new Error("provenance-only memory cannot be listed as active product memory");
  }
  return {
    id: memory.id,
    headRevisionId: memory.head_revision_id,
    current: {
      kind: memory.kind,
      content: memory.content,
      deleted: memory.deleted_at !== null,
    },
    createdAt: memory.created_at.toISOString(),
    updatedAt: memory.updated_at.toISOString(),
    revisions: revisions.map(memoryRevisionResponse),
  };
};

const readRevisionRows = (memoryIds: readonly string[]) =>
  Effect.gen(function* () {
    if (memoryIds.length === 0) return [];
    const sql = yield* PgClient.PgClient;
    return yield* sql<RevisionRow>`
      select id::text, memory_id::text, action, state_before, state_after, created_at
      from user_memory_revisions
      where ${sql.in("memory_id", memoryIds)}
      order by created_at, id
    `;
  });

const lockUserMemoryLease = (userId: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    yield* sql`select pg_advisory_xact_lock(hashtext(${`brief:user-memory:${userId}`}))`;
  });

export const listUserMemories = (userId: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        // All memory writers (finalization, explicit mutations, and tombstone
        // GC) take this same transaction advisory lease. Hold it across both
        // reads so every returned head has the complete revision ledger from
        // one linearization point.
        yield* lockUserMemoryLease(userId);
        const memories = yield* sql<MemoryRow>`
          select id::text, kind, content, head_revision_id::text, deleted_at, provenance_only_at,
                 created_at, updated_at
          from user_memories
          where user_id = ${userId}
            and provenance_only_at is null
            and (deleted_at is null or deleted_at > now() - interval '30 days')
          order by deleted_at nulls first, updated_at desc, id
        `;
        const revisions = yield* readRevisionRows(memories.map((memory) => memory.id));
        const byMemory = new Map<string, RevisionRow[]>();
        for (const revision of revisions) {
          const rows = byMemory.get(revision.memory_id) ?? [];
          rows.push(revision);
          byMemory.set(revision.memory_id, rows);
        }
        return {
          memories: memories.map((memory) => memoryResponse(memory, byMemory.get(memory.id) ?? [])),
        };
      }),
    );
  });

const findActiveRun = (userId: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<ActiveRunRow>`
      select id::text
      from ai_runs
      where initiating_user_id = ${userId}
        and finished_at is null and failed_at is null
      order by created_at
      limit 1
    `;
    return rows[0] ?? null;
  });

const readUserMemoryWithRevisionsQuery = (userId: string, memoryId: string, forUpdate: boolean) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const memories = forUpdate
      ? yield* sql<MemoryRow>`
          select id::text, kind, content, head_revision_id::text, deleted_at, provenance_only_at,
                 created_at, updated_at
          from user_memories where id = ${memoryId} and user_id = ${userId}
          for update
        `
      : yield* sql<MemoryRow>`
          select id::text, kind, content, head_revision_id::text, deleted_at, provenance_only_at,
                 created_at, updated_at
          from user_memories where id = ${memoryId} and user_id = ${userId}
        `;
    const memory = memories[0];
    if (memory === undefined) return null;
    const revisions = yield* readRevisionRows([memoryId]);
    return { memory, revisions };
  });

export const readUserMemoryWithRevisions = (userId: string, memoryId: string, forUpdate = false) =>
  Effect.gen(function* () {
    // Mutation callers already run inside their owning transaction and pass
    // `forUpdate`; read-only exact-revision callers get the same lease and
    // transaction boundary as the memories list endpoint.
    if (forUpdate) return yield* readUserMemoryWithRevisionsQuery(userId, memoryId, true);
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* lockUserMemoryLease(userId);
        const loaded = yield* readUserMemoryWithRevisionsQuery(userId, memoryId, false);
        return loaded;
      }),
    );
  });

const mutationGuard = (userId: string) =>
  Effect.gen(function* () {
    yield* lockUserMemoryLease(userId);
    return yield* findActiveRun(userId);
  });

export type MemoryMutationResult =
  | { readonly status: "ok"; readonly memory: MemoryRecord }
  | { readonly status: "not_found" }
  | { readonly status: "active_run"; readonly runId: string }
  | { readonly status: "expired" }
  | { readonly status: "invalid_revision" }
  | { readonly status: "duplicate" };

const isUniqueViolation = (error: unknown): boolean => {
  const record = asRecord(error);
  const cause = asRecord(record.cause);
  return record.code === "23505" || cause.code === "23505";
};

export const revertUserMemory = (userId: string, memoryId: string, revisionId: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const active = yield* mutationGuard(userId);
        if (active !== null) return { status: "active_run", runId: active.id } as const;
        const loaded = yield* readUserMemoryWithRevisions(userId, memoryId, true);
        if (loaded === null) return { status: "not_found" } as const;
        const { memory, revisions } = loaded;
        if (memory.provenance_only_at !== null) return { status: "expired" } as const;
        if (memory.deleted_at !== null) {
          const windows = yield* sql<{ readonly open: boolean }>`
            select ${memory.deleted_at}::timestamptz > now() - interval '30 days' as open
          `;
          if (windows[0]?.open !== true) return { status: "expired" } as const;
        }
        const target = revisions.find((revision) => revision.id === revisionId);
        if (target === undefined) return { status: "not_found" } as const;
        const targetSnapshot = snapshotFrom(target.state_after);
        if (targetSnapshot.deleted) return { status: "invalid_revision" } as const;
        if (memory.kind === null || memory.content === null) return { status: "expired" } as const;
        const current: MemorySnapshot = {
          kind: memory.kind,
          content: memory.content,
          deleted: memory.deleted_at !== null,
        };
        const inserted = yield* sql<{ readonly id: string }>`
          insert into user_memory_revisions (memory_id, action, state_before, state_after)
          values (${memoryId}, 'revert', ${sql.json(current)}, ${sql.json(targetSnapshot)})
          returning id::text
        `;
        const headRevisionId = inserted[0]!.id;
        const updated = yield* sql<MemoryRow>`
          update user_memories
          set kind = ${targetSnapshot.kind}, content = ${targetSnapshot.content},
              head_revision_id = ${headRevisionId}, deleted_at = null, updated_at = now()
          where id = ${memoryId}
          returning id::text, kind, content, head_revision_id::text, deleted_at,
                    provenance_only_at, created_at, updated_at
        `;
        const updatedRevisions = yield* readRevisionRows([memoryId]);
        return { status: "ok", memory: memoryResponse(updated[0]!, updatedRevisions) } as const;
      }).pipe(
        Effect.catch((error: unknown) =>
          isUniqueViolation(error)
            ? Effect.succeed({ status: "duplicate" } as const)
            : Effect.fail(error),
        ),
      ),
    );
  });

export const deleteUserMemory = (userId: string, memoryId: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const active = yield* mutationGuard(userId);
        if (active !== null) return { status: "active_run", runId: active.id } as const;
        const loaded = yield* readUserMemoryWithRevisions(userId, memoryId, true);
        if (loaded === null || loaded.memory.provenance_only_at !== null) {
          return { status: "not_found" } as const;
        }
        const { memory, revisions } = loaded;
        if (memory.deleted_at !== null) {
          return { status: "ok", memory: memoryResponse(memory, revisions) } as const;
        }
        if (memory.kind === null || memory.content === null) {
          return { status: "not_found" } as const;
        }
        const current: MemorySnapshot = {
          kind: memory.kind,
          content: memory.content,
          deleted: false,
        };
        const deleted: MemorySnapshot = { ...current, deleted: true };
        const inserted = yield* sql<{ readonly id: string }>`
          insert into user_memory_revisions (memory_id, action, state_before, state_after)
          values (${memoryId}, 'delete', ${sql.json(current)}, ${sql.json(deleted)})
          returning id::text
        `;
        const updated = yield* sql<MemoryRow>`
          update user_memories
          set head_revision_id = ${inserted[0]!.id}, deleted_at = now(), updated_at = now()
          where id = ${memoryId}
          returning id::text, kind, content, head_revision_id::text, deleted_at,
                    provenance_only_at, created_at, updated_at
        `;
        const updatedRevisions = yield* readRevisionRows([memoryId]);
        return { status: "ok", memory: memoryResponse(updated[0]!, updatedRevisions) } as const;
      }),
    );
  });
