import { PgClient } from "@effect/sql-pg";
import { Effect } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { lockUserMemories, MEMORY_TOMBSTONE_RETENTION_MS } from "./memory";

export const SMITHERS_TERMINAL_ORPHAN_RETENTION_MS = 24 * 60 * 60 * 1_000;

export interface MemoryTombstonePurgeResult {
  readonly processed: number;
  readonly hardDeleted: number;
  readonly madeProvenanceOnly: number;
  readonly revisionsDeleted: number;
}

interface CandidateRow {
  readonly id: string;
}

interface MemoryOwnerRow {
  readonly userId: string;
}

interface CountRow {
  readonly count: number;
}

interface IdRow {
  readonly id: string;
}

const purgeOneMemory = (
  memoryId: string,
): Effect.Effect<
  Omit<MemoryTombstonePurgeResult, "processed"> | null,
  SqlError,
  PgClient.PgClient
> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const owners = yield* sql<MemoryOwnerRow>`
          select user_id as "userId"
          from user_memories
          where id = ${memoryId}
          limit 1
        `;
        const owner = owners[0];
        if (owner === undefined) return null;

        const legalHoldScopeKey = `user:${owner.userId}`;
        yield* sql`
          select pg_advisory_xact_lock(
            hashtextextended(${`brief:legal-hold:${legalHoldScopeKey}`}, 0)
          )
        `;
        yield* lockUserMemories(owner.userId);
        yield* sql`
          select users.id
          from platform_users users
          where users.id = ${owner.userId}
          for share
        `;
        const eligible = yield* sql<IdRow>`
          select memories.id::text
          from user_memories memories
          left join platform_users users on users.id = memories.user_id
          where memories.id = ${memoryId}
            and memories.deleted_at is not null
            and (
              memories.provenance_only_at is not null
              or memories.deleted_at < now()
                - (${MEMORY_TOMBSTONE_RETENTION_MS} * interval '1 millisecond')
            )
            and coalesce(users.legal_hold, false) = false
            and not brief_has_active_legal_hold(
              array['user:' || memories.user_id]::text[]
            )
          for update of memories
        `;
        if (eligible.length === 0) return null;

        const counts = yield* sql<CountRow>`
          select count(*)::int as count
          from assistant_message_sources sources
          join user_memory_revisions revisions
            on revisions.id = sources.memory_revision_id
          where revisions.memory_id = ${memoryId}
        `;
        const referenceCount = counts[0]?.count ?? 0;

        if (referenceCount === 0) {
          yield* sql`delete from user_memories where id = ${memoryId}`;
          return {
            hardDeleted: 1,
            madeProvenanceOnly: 0,
            revisionsDeleted: 0,
          };
        }

        yield* sql`
          update user_memories
          set kind = null,
              content = null,
              head_revision_id = null,
              source_message_id = null,
              provenance_only_at = coalesce(provenance_only_at, now()),
              updated_at = now()
          where id = ${memoryId}
        `;
        const deleted = yield* sql<IdRow>`
          delete from user_memory_revisions revisions
          where revisions.memory_id = ${memoryId}
            and not exists (
              select 1
              from assistant_message_sources sources
              where sources.memory_revision_id = revisions.id
            )
          returning id::text
        `;
        yield* sql`
          update user_memory_revisions revisions
          set state_before = null,
              run_id = null
          where revisions.memory_id = ${memoryId}
        `;

        return {
          hardDeleted: 0,
          madeProvenanceOnly: 1,
          revisionsDeleted: deleted.length,
        };
      }),
    );
  });

export const purgeUserMemoryTombstones = (
  batchSize = 500,
): Effect.Effect<MemoryTombstonePurgeResult, SqlError, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const aggregateBudget = Number.isSafeInteger(batchSize) ? Math.max(0, batchSize) : 0;
    if (aggregateBudget === 0) {
      return { processed: 0, hardDeleted: 0, madeProvenanceOnly: 0, revisionsDeleted: 0 };
    }

    // Keep two independently ordered queues. A large prefix of provenance-only
    // rows must not consume the entire shared budget and starve newly eligible
    // 30-day tombstones. The unused half is lent to the other queue when one is
    // empty, while the aggregate number of selected candidates never exceeds
    // the code-owned cap.
    const expiredBudget = Math.ceil(aggregateBudget / 2);
    let expiredCandidates = yield* sql<CandidateRow>`
      select memories.id::text
      from user_memories memories
      left join platform_users users on users.id = memories.user_id
      where memories.deleted_at is not null
        and memories.provenance_only_at is null
        and memories.deleted_at < now()
          - (${MEMORY_TOMBSTONE_RETENTION_MS} * interval '1 millisecond')
        and coalesce(users.legal_hold, false) = false
        and not brief_has_active_legal_hold(
          array['user:' || memories.user_id]::text[]
        )
      order by memories.deleted_at, memories.id
      limit ${expiredBudget}
    `;
    const provenanceBudget = aggregateBudget - expiredCandidates.length;
    const provenanceCandidates = yield* sql<CandidateRow>`
      select memories.id::text
      from user_memories memories
      left join platform_users users on users.id = memories.user_id
      where memories.deleted_at is not null
        and memories.provenance_only_at is not null
        and not exists (
          select 1
          from assistant_message_sources sources
          join user_memory_revisions revisions
            on revisions.id = sources.memory_revision_id
          where revisions.memory_id = memories.id
        )
        and coalesce(users.legal_hold, false) = false
        and not brief_has_active_legal_hold(
          array['user:' || memories.user_id]::text[]
        )
      order by memories.provenance_only_at, memories.id
      limit ${provenanceBudget}
    `;
    const unusedBudget = aggregateBudget - expiredCandidates.length - provenanceCandidates.length;
    if (unusedBudget > 0 && expiredCandidates.length === expiredBudget) {
      const additionalExpiredCandidates = yield* sql<CandidateRow>`
        select memories.id::text
        from user_memories memories
        left join platform_users users on users.id = memories.user_id
        where memories.deleted_at is not null
          and memories.provenance_only_at is null
          and memories.deleted_at < now()
            - (${MEMORY_TOMBSTONE_RETENTION_MS} * interval '1 millisecond')
          and coalesce(users.legal_hold, false) = false
          and not brief_has_active_legal_hold(
            array['user:' || memories.user_id]::text[]
          )
        order by memories.deleted_at, memories.id
        offset ${expiredCandidates.length}
        limit ${unusedBudget}
      `;
      expiredCandidates = [...expiredCandidates, ...additionalExpiredCandidates];
    }

    let processed = 0;
    let hardDeleted = 0;
    let madeProvenanceOnly = 0;
    let revisionsDeleted = 0;

    for (const candidates of [expiredCandidates, provenanceCandidates]) {
      for (const candidate of candidates) {
        const result = yield* purgeOneMemory(candidate.id);
        if (result === null) continue;
        processed += 1;
        hardDeleted += result.hardDeleted;
        madeProvenanceOnly += result.madeProvenanceOnly;
        revisionsDeleted += result.revisionsDeleted;
      }
    }

    return { processed, hardDeleted, madeProvenanceOnly, revisionsDeleted };
  });
