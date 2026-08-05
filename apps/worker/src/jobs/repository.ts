import { PgClient } from "@effect/sql-pg";
import { Config, Context, Effect, Layer } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  databaseUrlRedactedConfig,
  loadJobRepositoryConfig,
  WORKER_JOB_LOCK_TIMEOUT_MS_DEFAULT,
} from "@hartlib/config";
import { persistedJobFailureCode } from "./failure";
import { jobSql } from "./sql";
import type { EnqueueJobInput, JobRecord } from "./types";

export interface JobRepositoryShape {
  readonly claimNext: Effect.Effect<JobRecord | undefined, unknown>;
  readonly enqueue: (input: EnqueueJobInput) => Effect.Effect<JobRecord, unknown>;
  readonly heartbeat: (job: JobRecord) => Effect.Effect<void, unknown>;
  readonly lockRenewalIntervalMs: number;
  readonly markCompleted: (job: JobRecord) => Effect.Effect<void, unknown>;
  readonly markFailed: (job: JobRecord, error: unknown) => Effect.Effect<void, unknown>;
}

export class JobRepository extends Context.Service<JobRepository, JobRepositoryShape>()(
  "hartlib/worker/JobRepository",
) {}

const retryDelayMs = (attempts: number): number =>
  Math.min(60_000, 1_000 * 2 ** Math.max(0, attempts - 1));

const lockRenewalIntervalMs = (jobLockTimeoutMs: number): number =>
  Math.max(1_000, Math.floor(jobLockTimeoutMs / 3));

type UpdatedJobRow = {
  readonly id: string;
};

const requireOwnedJobUpdate = (
  action: "complete" | "fail" | "heartbeat",
  job: JobRecord,
  rows: readonly UpdatedJobRow[],
): Effect.Effect<void, Error> =>
  rows.length > 0
    ? Effect.void
    : Effect.fail(
        new Error(
          `Cannot ${action} job ${job.id}: job is no longer running or lock ownership was lost`,
        ),
      );

export const makePgJobRepository = (
  jobLockTimeoutMs = WORKER_JOB_LOCK_TIMEOUT_MS_DEFAULT,
): Effect.Effect<JobRepositoryShape, never, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const workerId = `hartlib-worker:${crypto.randomUUID()}`;

    return JobRepository.of({
      lockRenewalIntervalMs: lockRenewalIntervalMs(jobLockTimeoutMs),

      enqueue: (input) =>
        Effect.gen(function* () {
          const reviveTerminal = input.reviveTerminal ?? true;
          const rows = yield* sql<JobRecord>`
              insert into jobs (kind, payload, unique_key, available_at, priority, max_attempts)
              values (
                ${input.kind},
                ${sql.json(input.payload)},
                ${input.uniqueKey ?? null},
                coalesce(${input.availableAt ?? null}::timestamptz, now()),
                ${input.priority ?? 0},
                ${input.maxAttempts ?? 5}
              )
              on conflict (unique_key) where unique_key is not null do update set
                payload = case
                  when jobs.status in ('completed', 'failed') then excluded.payload
                  else jobs.payload
                end,
                available_at = case
                  when jobs.status in ('completed', 'failed') then excluded.available_at
                  when jobs.status = 'queued' then least(jobs.available_at, excluded.available_at)
                  else jobs.available_at
                end,
                priority = greatest(jobs.priority, excluded.priority),
                attempts = case
                  when jobs.status in ('completed', 'failed') then 0
                  else jobs.attempts
                end,
                max_attempts = excluded.max_attempts,
                status = case
                  when jobs.status in ('completed', 'failed') then 'queued'
                  else jobs.status
                end,
                locked_at = case
                  when jobs.status in ('completed', 'failed') then null
                  else jobs.locked_at
                end,
                locked_by = case
                  when jobs.status in ('completed', 'failed') then null
                  else jobs.locked_by
                end,
                completed_at = case
                  when jobs.status in ('completed', 'failed') then null
                  else jobs.completed_at
                end,
                last_error = case
                  when jobs.status in ('completed', 'failed') then null
                  else jobs.last_error
                end,
                updated_at = now()
              where ${reviveTerminal}
                 or jobs.status not in ('completed', 'failed')
            returning id, kind, payload, attempts, max_attempts as "maxAttempts", locked_by as "lockedBy"
            `;
          if (rows[0] !== undefined) return rows[0];
          const existing = yield* sql<JobRecord>`
            select id, kind, payload, attempts, max_attempts as "maxAttempts",
                   locked_by as "lockedBy"
            from jobs
            where unique_key = ${input.uniqueKey ?? null}
          `;
          return existing[0]!;
        }).pipe(
          Effect.annotateLogs({
            sqlName: "enqueue",
            sqlPrepared: jobSql.enqueue.length > 0,
          }),
        ),

      claimNext: Effect.gen(function* () {
        const rows = yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`select pg_advisory_xact_lock(hashtext('hartlib:jobs:claim'))`;
            yield* sql`
                update jobs
                set status = case
                      -- Queue attempts are not the AI turn's terminal boundary. A
                      -- crashed worker must keep the same durable Smithers/product
                      -- run recoverable until the AI handler commits its terminal
                      -- product transition.
                      when kind = 'ai_chat_run' or attempts < max_attempts then 'retrying'
                      else 'failed'
                    end,
                    available_at = case
                      when kind = 'ai_chat_run' or attempts < max_attempts then now()
                      else available_at
                    end,
                    locked_at = null,
                    locked_by = null,
                    last_error = 'job_lock_expired',
                    updated_at = now()
                where status = 'running'
                  and locked_at < now() - (${jobLockTimeoutMs} * interval '1 millisecond')
              `;
            return yield* sql<JobRecord>`
                update jobs
                set status = 'running',
                    attempts = attempts + 1,
                    locked_at = now(),
                    locked_by = ${workerId},
                    updated_at = now()
                where id = (
                  select pending.id
                  from jobs pending
                  where pending.status in ('queued', 'retrying')
                    and pending.available_at <= now()
                    and not exists (
                      select 1
                      from jobs running
                      where running.status = 'running'
                        and running.kind = pending.kind
                        and running.kind = 'public_source_ingestion'
                        and running.payload->>'sourceId' = pending.payload->>'sourceId'
                    )
                  order by pending.priority desc, pending.available_at asc, pending.created_at asc
                  for update skip locked
                  limit 1
                )
                returning id, kind, payload, attempts, max_attempts as "maxAttempts", locked_by as "lockedBy"
              `;
          }),
        );
        return rows[0];
      }).pipe(
        Effect.annotateLogs({
          sqlName: "claimNext",
          sqlPrepared: jobSql.claimNext.length > 0,
        }),
      ),

      heartbeat: (job) =>
        sql<UpdatedJobRow>`
            update jobs
            set locked_at = now(),
                updated_at = now()
            where id = ${job.id}
              and status = 'running'
              and locked_by = ${job.lockedBy ?? workerId}
            returning id
          `.pipe(
          Effect.flatMap((rows) => requireOwnedJobUpdate("heartbeat", job, rows)),
          Effect.annotateLogs({
            sqlName: "heartbeat",
            sqlPrepared: jobSql.heartbeat.length > 0,
          }),
        ),

      markCompleted: (job) =>
        sql<UpdatedJobRow>`
            update jobs
            set status = 'completed',
                completed_at = now(),
                locked_at = null,
                locked_by = null,
                last_error = null,
                updated_at = now()
            where id = ${job.id}
              and status = 'running'
              and locked_by = ${job.lockedBy ?? workerId}
            returning id
          `.pipe(
          Effect.flatMap((rows) => requireOwnedJobUpdate("complete", job, rows)),
          Effect.tap(() =>
            Effect.logInfo("job completed").pipe(
              Effect.annotateLogs({
                jobId: job.id,
                jobKind: job.kind,
              }),
            ),
          ),
        ),

      markFailed: (job, error) => {
        const errorCode = persistedJobFailureCode(error);
        return sql<UpdatedJobRow>`
            update jobs
            set status = case
                  -- Infrastructure/transport failure before the AI handler can
                  -- read and commit durable terminal metadata must never strand
                  -- an unterminated ai_runs row behind a terminal queue job.
                  when kind = 'ai_chat_run' or attempts < max_attempts then 'retrying'
                  else 'failed'
                end,
                available_at = case
                  when kind = 'ai_chat_run' or attempts < max_attempts
                    then now() + (${retryDelayMs(job.attempts)} * interval '1 millisecond')
                  else available_at
                end,
                locked_at = null,
                locked_by = null,
                last_error = ${errorCode},
                updated_at = now()
            where id = ${job.id}
              and status = 'running'
              and locked_by = ${job.lockedBy ?? workerId}
            returning id
          `.pipe(
          Effect.flatMap((rows) => requireOwnedJobUpdate("fail", job, rows)),
          Effect.tap(() =>
            Effect.logError("job failed").pipe(
              Effect.annotateLogs({
                jobId: job.id,
                jobKind: job.kind,
                errorCode,
              }),
            ),
          ),
        );
      },
    });
  }).pipe(
    Effect.catch((error: SqlError) =>
      Effect.die(new Error(`Postgres job repository failed: ${error.message}`)),
    ),
  );

export const JobRepositoryPgLayer = Layer.effect(
  JobRepository,
  loadJobRepositoryConfig.pipe(
    Effect.flatMap(({ jobLockTimeoutMs }) => makePgJobRepository(jobLockTimeoutMs)),
  ),
).pipe(
  Layer.provide(
    PgClient.layerConfig({
      url: databaseUrlRedactedConfig,
      applicationName: Config.succeed("hartlib-worker"),
    }),
  ),
);
