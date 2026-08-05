import { PgClient } from "@effect/sql-pg";
import { Effect } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";

import type { MemoryExtractionResult, MemoryKind, ValidatedMemoryProposal } from "../runtime/types";

export const MEMORY_TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export interface MemoryState {
  readonly kind: MemoryKind;
  readonly content: string;
  readonly deleted: boolean;
}

export interface AppliedMemoryChanges {
  readonly created: number;
  readonly updated: number;
  readonly discarded: number;
  readonly writes: ReadonlyArray<{
    readonly ordinal: number;
    readonly memoryId: string;
    readonly revisionId: string;
    readonly previousRevisionId: string | null;
    readonly action: "create" | "update";
  }>;
}

export interface MemoryMutationResult {
  readonly memoryId: string;
  readonly headRevisionId: string;
  readonly current: MemoryState;
  readonly changed: boolean;
}

export class ActiveAiRunError extends Error {
  readonly code = "active_ai_run" as const;

  constructor(readonly runId: string) {
    super(`user has an active AI run: ${runId}`);
    this.name = "ActiveAiRunError";
  }
}

export class MemoryNotFoundError extends Error {
  readonly code = "memory_not_found" as const;

  constructor() {
    super("memory or revision not found");
    this.name = "MemoryNotFoundError";
  }
}

export class MemoryConflictError extends Error {
  readonly code = "memory_conflict" as const;

  constructor() {
    super("memory head changed before finalization");
    this.name = "MemoryConflictError";
  }
}

export class MemoryDuplicateError extends Error {
  readonly code = "memory_duplicate" as const;

  constructor() {
    super("an active memory already has this kind and content");
    this.name = "MemoryDuplicateError";
  }
}

export class MemoryRevertWindowExpiredError extends Error {
  readonly code = "memory_revert_window_expired" as const;

  constructor() {
    super("memory revert window expired");
    this.name = "MemoryRevertWindowExpiredError";
  }
}

interface MemoryRow {
  readonly id: string;
  readonly userId: string;
  readonly kind: MemoryKind | null;
  readonly content: string | null;
  readonly headRevisionId: string | null;
  readonly deletedAt: Date | null;
  readonly provenanceOnlyAt: Date | null;
  readonly revertExpired: boolean;
}

interface ActiveRunRow {
  readonly id: string;
}

interface RevisionRow {
  readonly id: string;
  readonly stateAfter: MemoryState;
}

interface DuplicateRow {
  readonly id: string;
}

export const lockUserMemories = (
  userId: string,
): Effect.Effect<void, SqlError, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    yield* sql`
      select pg_advisory_xact_lock(
        hashtext(${`hartlib:user-memory:${userId}`})
      )
    `;
  });

const currentState = (row: MemoryRow): MemoryState | null =>
  row.kind === null || row.content === null
    ? null
    : { kind: row.kind, content: row.content, deleted: row.deletedAt !== null };

const loadMemoryForUpdate = (
  userId: string,
  memoryId: string,
): Effect.Effect<MemoryRow | null, SqlError, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<MemoryRow>`
      select
        id::text,
        user_id as "userId",
        kind,
        content,
        head_revision_id::text as "headRevisionId",
        deleted_at as "deletedAt",
        provenance_only_at as "provenanceOnlyAt",
        (
          deleted_at is not null
          and deleted_at < now() - (${MEMORY_TOMBSTONE_RETENTION_MS} * interval '1 millisecond')
        ) as "revertExpired"
      from user_memories
      where id = ${memoryId}
        and user_id = ${userId}
      for update
    `;

    return rows[0] ?? null;
  });

const rejectActiveAiRun = (
  userId: string,
): Effect.Effect<void, SqlError | ActiveAiRunError, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<ActiveRunRow>`
      select id::text
      from ai_runs
      where initiating_user_id = ${userId}
        and finished_at is null
        and failed_at is null
      order by created_at, id
      limit 1
    `;

    if (rows[0] !== undefined) {
      return yield* Effect.fail(new ActiveAiRunError(rows[0].id));
    }
  });

const rejectDuplicateMemory = (
  userId: string,
  memoryId: string,
  state: MemoryState,
): Effect.Effect<void, SqlError | MemoryDuplicateError, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const duplicates = yield* sql<DuplicateRow>`
      select id::text
      from user_memories
      where user_id = ${userId}
        and id <> ${memoryId}
        and kind = ${state.kind}
        and btrim(content) = ${state.content.trim()}
        and deleted_at is null
        and provenance_only_at is null
      limit 1
    `;

    if (duplicates.length > 0) {
      return yield* Effect.fail(new MemoryDuplicateError());
    }
  });

const applyCreateProposal = (
  userId: string,
  runId: string,
  proposal: ValidatedMemoryProposal,
): Effect.Effect<{ memoryId: string; revisionId: string }, SqlError, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const memoryId = crypto.randomUUID();
    const revisionId = crypto.randomUUID();
    const content = proposal.content.trim();
    const after: MemoryState = { kind: proposal.kind, content, deleted: false };

    yield* sql`
      insert into user_memories (
        id,
        user_id,
        kind,
        content,
        head_revision_id,
        source_message_id,
        created_at,
        updated_at
      )
      values (
        ${memoryId},
        ${userId},
        ${proposal.kind},
        ${content},
        ${revisionId},
        (select user_message_id from ai_runs where id = ${runId}),
        now(),
        now()
      )
    `;
    yield* sql`
      insert into user_memory_revisions (
        id,
        memory_id,
        action,
        state_before,
        state_after,
        run_id
      )
      values (
        ${revisionId},
        ${memoryId},
        'create',
        null,
        ${sql.json(after)},
        ${runId}
      )
    `;
    return { memoryId, revisionId };
  });

const applyUpdateProposal = (
  userId: string,
  runId: string,
  proposal: ValidatedMemoryProposal,
): Effect.Effect<
  { memoryId: string; revisionId: string; previousRevisionId: string },
  SqlError | MemoryConflictError,
  PgClient.PgClient
> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const memoryId = proposal.targetMemoryId;
    const expectedHeadRevisionId = proposal.expectedHeadRevisionId;

    if (memoryId === undefined || expectedHeadRevisionId === undefined) {
      return yield* Effect.fail(new MemoryConflictError());
    }

    const row = yield* loadMemoryForUpdate(userId, memoryId);
    const before = row === null ? null : currentState(row);

    if (
      row === null ||
      row.provenanceOnlyAt !== null ||
      row.deletedAt !== null ||
      row.headRevisionId !== expectedHeadRevisionId ||
      before === null
    ) {
      return yield* Effect.fail(new MemoryConflictError());
    }

    const revisionId = crypto.randomUUID();
    const content = proposal.content.trim();
    const after: MemoryState = { kind: proposal.kind, content, deleted: false };

    yield* sql`
      insert into user_memory_revisions (
        id,
        memory_id,
        action,
        state_before,
        state_after,
        run_id
      )
      values (
        ${revisionId},
        ${memoryId},
        'update',
        ${sql.json(before)},
        ${sql.json(after)},
        ${runId}
      )
    `;
    yield* sql`
      update user_memories
      set kind = ${proposal.kind},
          content = ${content},
          head_revision_id = ${revisionId},
          source_message_id = (select user_message_id from ai_runs where id = ${runId}),
          updated_at = now()
      where id = ${memoryId}
    `;
    return { memoryId, revisionId, previousRevisionId: expectedHeadRevisionId };
  });

/** Must run inside the finalization transaction. */
export const applyMemoryProposalsInTransaction = (
  runId: string,
  userId: string,
  extraction: MemoryExtractionResult,
): Effect.Effect<AppliedMemoryChanges, SqlError | MemoryConflictError, PgClient.PgClient> =>
  Effect.gen(function* () {
    yield* lockUserMemories(userId);
    let created = 0;
    let updated = 0;
    const writes: AppliedMemoryChanges["writes"][number][] = [];

    for (const [ordinal, proposal] of extraction.proposals.entries()) {
      if (proposal.targetMemoryId === undefined) {
        const write = yield* applyCreateProposal(userId, runId, proposal);
        created += 1;
        writes.push({ ordinal, ...write, previousRevisionId: null, action: "create" });
      } else {
        const write = yield* applyUpdateProposal(userId, runId, proposal);
        updated += 1;
        writes.push({ ordinal, ...write, action: "update" });
      }
    }

    return { created, updated, discarded: extraction.discardedCount, writes };
  });

export const deleteUserMemory = (
  userId: string,
  memoryId: string,
): Effect.Effect<
  MemoryMutationResult,
  SqlError | ActiveAiRunError | MemoryNotFoundError,
  PgClient.PgClient
> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* lockUserMemories(userId);
        yield* rejectActiveAiRun(userId);
        const row = yield* loadMemoryForUpdate(userId, memoryId);
        const before = row === null ? null : currentState(row);

        if (
          row === null ||
          row.provenanceOnlyAt !== null ||
          before === null ||
          row.headRevisionId === null
        ) {
          return yield* Effect.fail(new MemoryNotFoundError());
        }

        if (row.deletedAt !== null) {
          return {
            memoryId,
            headRevisionId: row.headRevisionId,
            current: before,
            changed: false,
          };
        }

        const revisionId = crypto.randomUUID();
        const after: MemoryState = { ...before, deleted: true };
        yield* sql`
          insert into user_memory_revisions (
            id,
            memory_id,
            action,
            state_before,
            state_after,
            run_id
          )
          values (
            ${revisionId},
            ${memoryId},
            'delete',
            ${sql.json(before)},
            ${sql.json(after)},
            null
          )
        `;
        yield* sql`
          update user_memories
          set head_revision_id = ${revisionId},
              deleted_at = now(),
              updated_at = now()
          where id = ${memoryId}
        `;

        return { memoryId, headRevisionId: revisionId, current: after, changed: true };
      }),
    );
  });

export const revertUserMemory = (
  userId: string,
  memoryId: string,
  targetRevisionId: string,
): Effect.Effect<
  MemoryMutationResult,
  | SqlError
  | ActiveAiRunError
  | MemoryNotFoundError
  | MemoryDuplicateError
  | MemoryRevertWindowExpiredError,
  PgClient.PgClient
> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* lockUserMemories(userId);
        yield* rejectActiveAiRun(userId);
        const row = yield* loadMemoryForUpdate(userId, memoryId);
        const before = row === null ? null : currentState(row);

        if (row === null) {
          return yield* Effect.fail(new MemoryNotFoundError());
        }
        if (row.provenanceOnlyAt !== null || row.revertExpired) {
          return yield* Effect.fail(new MemoryRevertWindowExpiredError());
        }
        if (before === null) {
          return yield* Effect.fail(new MemoryNotFoundError());
        }

        const revisions = yield* sql<RevisionRow>`
          select id::text, state_after as "stateAfter"
          from user_memory_revisions
          where id = ${targetRevisionId}
            and memory_id = ${memoryId}
          limit 1
        `;
        const target = revisions[0];

        if (target === undefined || target.stateAfter.deleted) {
          return yield* Effect.fail(new MemoryNotFoundError());
        }

        const after: MemoryState = {
          ...target.stateAfter,
          content: target.stateAfter.content.trim(),
          deleted: false,
        };
        yield* rejectDuplicateMemory(userId, memoryId, after);

        const revisionId = crypto.randomUUID();
        yield* sql`
          insert into user_memory_revisions (
            id,
            memory_id,
            action,
            state_before,
            state_after,
            run_id
          )
          values (
            ${revisionId},
            ${memoryId},
            'revert',
            ${sql.json(before)},
            ${sql.json(after)},
            null
          )
        `;
        yield* sql`
          update user_memories
          set kind = ${after.kind},
              content = ${after.content},
              head_revision_id = ${revisionId},
              deleted_at = null,
              updated_at = now()
          where id = ${memoryId}
        `;

        return { memoryId, headRevisionId: revisionId, current: after, changed: true };
      }),
    );
  });
