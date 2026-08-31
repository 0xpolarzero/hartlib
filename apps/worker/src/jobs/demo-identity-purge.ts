import { PgClient } from "@effect/sql-pg";
import { Effect } from "effect";

import { runAiProductState } from "../ai/product-state/database";

export type DemoIdentityPurgeResult =
  | { readonly status: "completed"; readonly visitorId: string }
  | { readonly status: "retry"; readonly visitorId: string; readonly reason: string };

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export const parseDemoIdentityPurgePayload = (payload: unknown): { readonly visitorId: string } => {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("demo_identity_purge payload must be an object");
  }
  const record = payload as Record<string, unknown>;
  if (
    Object.keys(record).length !== 1 ||
    typeof record.visitorId !== "string" ||
    !uuidPattern.test(record.visitorId)
  ) {
    throw new Error("demo_identity_purge payload must contain one valid visitorId");
  }
  return { visitorId: record.visitorId };
};

/**
 * Delete one revoked demo identity after every worker using its runs has
 * yielded. The current jobs row is intentionally never touched; the runner
 * owns its terminal state and later housekeeping removes it.
 */
export const purgeDemoIdentity = (
  connectionString: string,
  visitorId: string,
): Promise<DemoIdentityPurgeResult> =>
  runAiProductState(
    connectionString,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`set local hartlib.allow_account_purge = 'on'`;
          // The runner takes this same lane before claiming queued work.  Hold
          // it while deciding that no old AI job can start, then deleting the
          // queued rows, so a claim cannot race the identity sweep.
          yield* sql`select pg_advisory_xact_lock(hashtext('hartlib:jobs:claim'))`;
          const sessions = yield* sql<{ readonly revoked: boolean }>`
            select revoked_at is not null as revoked
            from demo_sessions
            where visitor_id = ${visitorId}::uuid
            for update
          `;
          // A prior attempt normally leaves the session row until the whole
          // transaction commits.  If an operator or an older runner already
          // removed only that row, continue through the graph sweep instead
          // of treating the missing row as proof that the visitor graph is
          // gone.
          if (sessions[0]?.revoked === false) {
            return {
              status: "retry",
              visitorId,
              reason: "demo_session_not_revoked",
            } as const;
          }

          const activeRuns = yield* sql<{ readonly id: string }>`
            select runs.id::text as id
            from ai_runs runs
            join chats chats on chats.id = runs.chat_id
            where chats.user_id = ${visitorId}
              and runs.finished_at is null
              and runs.failed_at is null
              and runs.stopped_at is null
              and runs.superseded_at is null
            for update of runs
          `;
          if (activeRuns.length > 0) {
            yield* sql`
              update ai_runs runs
              set stop_requested_at = coalesce(stop_requested_at, now())
              from chats chats
              where chats.id = runs.chat_id
                and chats.user_id = ${visitorId}
                and runs.finished_at is null
                and runs.failed_at is null
                and runs.stopped_at is null
                and runs.superseded_at is null
            `;
            return {
              status: "retry",
              visitorId,
              reason: "active_ai_runs_must_yield",
            } as const;
          }

          // A worker may have yielded the database run but still be unwinding
          // its Smithers process. Keep the identity graph until that durable
          // queue row leaves running state.
          const runningJobs = yield* sql<{ readonly id: string }>`
            select jobs.id::text as id
            from jobs
            join ai_runs runs on runs.id::text = jobs.payload->>'aiRunId'
            join chats chats on chats.id = runs.chat_id
            where jobs.kind = 'ai_chat_run'
              and jobs.status = 'running'
              and chats.user_id = ${visitorId}
            for update of jobs
          `;
          if (runningJobs.length > 0) {
            return {
              status: "retry",
              visitorId,
              reason: "running_ai_jobs_must_yield",
            } as const;
          }

          const companyRows = yield* sql<{ readonly companyId: string }>`
            select distinct company_id::text as "companyId"
            from client_company_memberships
            where user_id = ${visitorId}
          `;

          // A queued run cannot be claimed after this transaction commits.
          // Mark only its queue rows complete; the run and all evidence remain
          // until the graph deletion below.
          yield* sql`
            update jobs
            set status = 'completed', completed_at = now(), locked_at = null,
                locked_by = null, updated_at = now()
            where kind = 'ai_chat_run'
              and payload->>'aiRunId' in (
                select runs.id::text
                from ai_runs runs
                join chats chats on chats.id = runs.chat_id
                where chats.user_id = ${visitorId}
              )
              and status in ('queued', 'retrying')
          `;

          // Queue rows are part of the old identity graph too. Delete only
          // the visitor's AI-run jobs; the currently executing purge row is
          // deliberately left for the runner to complete and later
          // housekeeping to remove.
          yield* sql`
            delete from jobs
            where kind = 'ai_chat_run'
              and payload->>'aiRunId' in (
                select runs.id::text
                from ai_runs runs
                join chats chats on chats.id = runs.chat_id
                where chats.user_id = ${visitorId}
              )
          `;

          // Smithers rows are run-owned and must disappear before the product
          // graph. The orphan-candidate ledger has no foreign key, so remove
          // it explicitly. Smithers keeps several run_id tables without
          // foreign keys, so sweep every registered private table rather than
          // relying on _smithers_runs CASCADE to remove only part of the graph.
          const smithersSeeds = yield* sql<{ readonly smithersRunId: string }>`
            select distinct runs.smithers_run_id as "smithersRunId"
            from ai_runs runs
            join chats chats on chats.id = runs.chat_id
            where chats.user_id = ${visitorId}
              and runs.smithers_run_id is not null
          `;
          const smithersRelation = yield* sql<{ readonly relation: string | null }>`
            select to_regclass('public._smithers_runs') as relation
          `;
          let smithersRunRows: ReadonlyArray<{ readonly smithersRunId: string }> = smithersSeeds;
          if (
            smithersRelation[0]?.relation !== null &&
            smithersRelation[0]?.relation !== undefined
          ) {
            smithersRunRows = yield* sql<{ readonly smithersRunId: string }>`
              with recursive seed as (
                select distinct runs.smithers_run_id
                from ai_runs runs
                join chats chats on chats.id = runs.chat_id
                where chats.user_id = ${visitorId}
                  and runs.smithers_run_id is not null
              ), descendants as (
                select seed.smithers_run_id
                from seed
                union
                select child.run_id
                from _smithers_runs child
                join descendants parent on parent.smithers_run_id = child.parent_run_id
              )
              select distinct smithers_run_id as "smithersRunId"
              from descendants
              where smithers_run_id is not null
            `;
          }
          for (const smithersRun of smithersRunRows) {
            yield* sql`
              delete from ai_smithers_orphan_candidates
              where smithers_run_id = ${smithersRun.smithersRunId}
            `;
          }
          const smithersTables = yield* sql<{
            readonly tableName: string;
            readonly columnName: string;
          }>`
            select table_name as "tableName", column_name as "columnName"
            from information_schema.columns
            where table_schema = 'public'
              and column_name in ('run_id', 'parent_run_id', 'eval_run_id', 'case_run_id')
              and left(table_name, 9) = '_smithers'
            order by case when table_name = '_smithers_runs' then 1 else 0 end,
                     table_name, column_name
          `;
          for (const smithersRun of smithersRunRows) {
            for (const table of smithersTables) {
              yield* sql`
                delete from ${sql(table.tableName)}
                where ${sql(table.columnName)} = ${smithersRun.smithersRunId}
              `;
            }
          }

          // Remove only visitor-owned retained edges. Company-scoped delivery,
          // grant, and access rows belong to every remaining member and must
          // survive a purge from a shared company; an empty company is deleted
          // below and its rows then disappear through foreign keys.
          yield* sql`delete from issue_delivery_recipients where user_id = ${visitorId}`;
          yield* sql`delete from client_employee_subscription_grants where user_id = ${visitorId}`;
          yield* sql`delete from publisher_membership_subscription_grants where user_id = ${visitorId}`;
          yield* sql`delete from publisher_company_memberships where user_id = ${visitorId}`;
          yield* sql`delete from platform_authorization_audit_log where actor_user_id = ${visitorId}`;

          yield* sql`delete from user_memories where user_id = ${visitorId}`;
          // Evaluation rows are immutable during ordinary operations, but
          // they are part of a run-owned identity graph during account purge.
          // Remove annotations before case runs so their retained foreign key
          // does not block the run cascade.
          yield* sql`
            delete from ai_evaluation_annotations
            where ai_run_id in (
              select runs.id
              from ai_runs runs
              join chats chats on chats.id = runs.chat_id
              where chats.user_id = ${visitorId}
            )
          `;
          yield* sql`
            delete from ai_evaluation_case_runs
            where ai_run_id in (
              select runs.id
              from ai_runs runs
              join chats chats on chats.id = runs.chat_id
              where chats.user_id = ${visitorId}
            )
          `;
          yield* sql`
            delete from chats where user_id = ${visitorId}
          `;

          for (const company of companyRows) {
            yield* sql`delete from client_company_memberships where company_id = ${company.companyId} and user_id = ${visitorId}`;
            const remainingMemberships = yield* sql<{ readonly count: string }>`
              select count(*)::text as count
              from client_company_memberships
              where company_id = ${company.companyId}
            `;
            if (remainingMemberships[0]?.count === "0") {
              // These foreign keys deliberately restrict company deletion.
              // Clear them only after proving that no other visitor still
              // owns the company; shared-company rows stay intact.
              yield* sql`delete from issue_delivery_recipients where client_company_id = ${company.companyId}`;
              yield* sql`delete from issue_deliveries where client_company_id = ${company.companyId}`;
              yield* sql`delete from client_employee_subscription_grants where client_company_id = ${company.companyId}`;
              yield* sql`delete from client_subscription_accesses where client_company_id = ${company.companyId}`;
              yield* sql`delete from client_company_public_source_settings where client_company_id = ${company.companyId}`;
              yield* sql`delete from client_company_ai_settings where company_id = ${company.companyId}`;
              yield* sql`delete from client_companies where id = ${company.companyId}`;
            }
          }

          // Reset operations retain only the successor after the old graph is
          // gone. This update deliberately runs before deleting the session.
          yield* sql`
            update demo_reset_operations
            set predecessor_visitor_id = null
            where predecessor_visitor_id = ${visitorId}::uuid
          `;
          // A successor can later become a predecessor in another reset. Its
          // earlier operation row is owned by that successor, so remove that
          // row with the old identity before deleting the session. Keeping the
          // FK restrictive prevents dangling replay records while allowing a
          // chain of resets to be purged one identity at a time.
          yield* sql`
            delete from demo_reset_operations
            where successor_visitor_id = ${visitorId}::uuid
          `;
          yield* sql`delete from demo_sessions where visitor_id = ${visitorId}::uuid`;
          yield* sql`delete from platform_users where id = ${visitorId}`;

          return { status: "completed", visitorId } as const;
        }),
      );
    }),
  );

/** Remove completed purge queue rows during a later maintenance pass. */
export const housekeepCompletedDemoIdentityPurgeJobs = (
  connectionString: string,
): Promise<number> =>
  runAiProductState(
    connectionString,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      const rows = yield* sql<{ readonly count: number }>`
        with removable as (
          select jobs.id
          from jobs
          where jobs.kind = 'demo_identity_purge'
            and jobs.status = 'completed'
            and not exists (
              select 1
              from demo_reset_operations operations
              where operations.purge_job_id = jobs.id
                and operations.predecessor_visitor_id is not null
            )
        )
        delete from jobs
        where jobs.id in (select id from removable)
        returning 1 as count
      `;
      return rows.length;
    }),
  );
