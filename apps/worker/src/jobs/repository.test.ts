import { PgClient } from "@effect/sql-pg";
import { Effect, Redacted } from "effect";
import { describe, expect, it, vi } from "vitest";
import { TrustedJobFailure } from "./failure";
import { makePgJobRepository } from "./repository";
import type { JobRecord } from "./types";

const databaseUrl = process.env.WORKER_POSTGRES_TEST_DATABASE_URL;
const migrationsUrl = new URL("../../../../db/migrations/", import.meta.url);

const runDb = <A, E>(effect: Effect.Effect<A, E, PgClient.PgClient>): Promise<A> => {
  if (!databaseUrl) {
    throw new Error("WORKER_POSTGRES_TEST_DATABASE_URL is required for Postgres tests");
  }

  return Effect.runPromise(
    effect.pipe(
      Effect.provide(
        PgClient.layer({
          url: Redacted.make(databaseUrl),
          applicationName: "brief-worker-job-repository-test",
        }),
      ),
    ),
  );
};

const resetDatabase = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  const files = [...new Bun.Glob("*.sql").scanSync({ cwd: migrationsUrl.pathname })].sort();

  yield* sql`
      create table if not exists schema_migrations (
        name text primary key,
        applied_at timestamptz not null default now()
      )
    `;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`select pg_advisory_xact_lock(hashtext('brief:schema_migrations'))`;
      const appliedRows = yield* sql<{ readonly name: string }>`
          select name from schema_migrations
        `;
      const applied = new Set(appliedRows.map((row) => row.name));

      for (const file of files) {
        if (applied.has(file)) {
          continue;
        }

        const body = yield* Effect.promise(() => Bun.file(new URL(file, migrationsUrl)).text());
        yield* sql.unsafe(body).raw;
        yield* sql`
            insert into schema_migrations (name)
            values (${file})
          `;
      }
    }),
  );
  // Later canonical platform tables retain job provenance through foreign keys.
  // Test isolation intentionally resets that whole dependent graph.
  yield* sql`truncate table jobs restart identity cascade`;
});

const jobRows = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  return yield* sql<{
    readonly id: string;
    readonly status: string;
    readonly attempts: number;
    readonly payload: { readonly value?: string };
    readonly locked_by: string | null;
    readonly last_error: string | null;
  }>`
      select id, status, attempts, payload, locked_by, last_error
      from jobs
      order by created_at, id
    `;
});

describe.skipIf(!databaseUrl)("postgres job repository", () => {
  it("uses the PostgreSQL clock for immediate default enqueue despite host clock skew", async () => {
    vi.useFakeTimers({ now: new Date("2099-01-01T00:00:00.000Z") });
    try {
      await runDb(
        Effect.gen(function* () {
          yield* resetDatabase;
          const repository = yield* makePgJobRepository(60_000);
          const sql = yield* PgClient.PgClient;

          const enqueued = yield* repository.enqueue({
            kind: "public_source_ingestion",
            payload: { sourceId: "service_public", mode: "poll" },
            uniqueKey: "database-clock-default",
          });
          const scheduledAt = new Date("2100-01-01T00:00:00.000Z");
          const scheduled = yield* repository.enqueue({
            kind: "public_source_ingestion",
            payload: { sourceId: "service_public", mode: "backfill" },
            uniqueKey: "database-clock-explicit",
            availableAt: scheduledAt,
          });
          const [scheduledRow] = yield* sql<{ readonly available_at: Date }>`
            select available_at
            from jobs
            where id = ${scheduled.id}
          `;
          expect(scheduledRow?.available_at.toISOString()).toBe(scheduledAt.toISOString());

          const claimed = yield* repository.claimNext;

          expect(claimed).toMatchObject({
            id: enqueued.id,
            kind: "public_source_ingestion",
            attempts: 1,
          });
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("claims jobs with durable ownership and requires the same owner to complete", async () => {
    await runDb(
      Effect.gen(function* () {
        yield* resetDatabase;
        const repository = yield* makePgJobRepository(60_000);

        yield* repository.enqueue({
          kind: "public_source_ingestion",
          payload: { sourceId: "service_public", mode: "poll" },
          uniqueKey: "public_source_ingestion:service_public",
        });

        const claimed = yield* repository.claimNext;
        expect(claimed).toMatchObject({
          kind: "public_source_ingestion",
          attempts: 1,
        });
        expect(claimed?.lockedBy).toMatch(/^brief-worker:/);

        yield* repository.markCompleted(claimed!);
        yield* Effect.flip(
          repository.markCompleted({
            ...claimed!,
            lockedBy: "brief-worker:someone-else",
          }),
        );

        const rows = yield* jobRows;
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          status: "completed",
          attempts: 1,
          locked_by: null,
          last_error: null,
        });
      }),
    );
  });

  it("preserves active unique jobs and resets terminal unique jobs on enqueue", async () => {
    await runDb(
      Effect.gen(function* () {
        yield* resetDatabase;
        const repository = yield* makePgJobRepository(60_000);

        const first = yield* repository.enqueue({
          kind: "public_source_ingestion",
          payload: { value: "first" },
          uniqueKey: "source:one",
        });
        const duplicateQueued = yield* repository.enqueue({
          kind: "public_source_ingestion",
          payload: { value: "queued-duplicate" },
          uniqueKey: "source:one",
        });
        expect(duplicateQueued.id).toBe(first.id);

        const claimed = yield* repository.claimNext;
        yield* repository.markFailed(claimed!, new Error("try again"));
        const duplicateRetrying = yield* repository.enqueue({
          kind: "public_source_ingestion",
          payload: { value: "retrying-duplicate" },
          uniqueKey: "source:one",
        });
        expect(duplicateRetrying.id).toBe(first.id);
        const sql = yield* PgClient.PgClient;
        yield* sql`
            update jobs
            set available_at = now()
            where id = ${first.id}
          `;

        const retry = yield* repository.claimNext;
        yield* repository.markCompleted(retry!);
        const reset = yield* repository.enqueue({
          kind: "public_source_ingestion",
          payload: { value: "terminal-reset" },
          uniqueKey: "source:one",
        });

        expect(reset.id).toBe(first.id);
        const rows = yield* jobRows;
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          status: "queued",
          attempts: 0,
          payload: { value: "terminal-reset" },
          locked_by: null,
          last_error: null,
        });
      }),
    );
  });

  it("deduplicates a completed recurring time bucket without reviving it", async () => {
    await runDb(
      Effect.gen(function* () {
        yield* resetDatabase;
        const repository = yield* makePgJobRepository(60_000);
        const first = yield* repository.enqueue({
          kind: "purge_expired_exports",
          payload: { value: "first" },
          uniqueKey: "maintenance:purge_expired_exports:bucket-1",
          reviveTerminal: false,
        });
        const claimed = yield* repository.claimNext;
        yield* repository.markCompleted(claimed!);
        const duplicate = yield* repository.enqueue({
          kind: "purge_expired_exports",
          payload: { value: "forged-revival" },
          uniqueKey: "maintenance:purge_expired_exports:bucket-1",
          reviveTerminal: false,
        });
        expect(duplicate.id).toBe(first.id);
        expect((yield* jobRows)[0]).toMatchObject({
          status: "completed",
          attempts: 1,
          payload: { value: "first" },
        });
      }),
    );
  });

  it("keeps backfill queued behind a running poll for the same source", async () => {
    await runDb(
      Effect.gen(function* () {
        yield* resetDatabase;
        const repository = yield* makePgJobRepository(60_000);

        yield* repository.enqueue({
          kind: "public_source_ingestion",
          payload: { sourceId: "service_public", mode: "poll" },
          uniqueKey: "public_source_ingestion:service_public:poll",
        });
        const runningPoll = yield* repository.claimNext;

        yield* repository.enqueue({
          kind: "public_source_ingestion",
          payload: {
            sourceId: "service_public",
            mode: "backfill",
            since: "2026-06-29T00:00:00.000Z",
          },
          uniqueKey: "public_source_ingestion:service_public:backfill",
          priority: 10,
        });

        const blockedBackfill = yield* repository.claimNext;
        expect(blockedBackfill).toBeUndefined();

        yield* repository.markCompleted(runningPoll!);
        const claimedBackfill = yield* repository.claimNext;
        expect(claimedBackfill).toMatchObject({
          payload: {
            sourceId: "service_public",
            mode: "backfill",
            since: "2026-06-29T00:00:00.000Z",
          },
        });
      }),
    );
  });

  it("claims higher-priority chat jobs ahead of older ingestion jobs", async () => {
    await runDb(
      Effect.gen(function* () {
        yield* resetDatabase;
        const repository = yield* makePgJobRepository(60_000);

        yield* repository.enqueue({
          kind: "public_source_ingestion",
          payload: { sourceId: "service_public", mode: "poll" },
          uniqueKey: "public_source_ingestion:service_public:poll",
        });
        yield* repository.enqueue({
          kind: "ai_chat_run",
          payload: { aiRunId: "run-priority-test" },
          uniqueKey: "ai_chat_run:run-priority-test",
          priority: 100,
        });

        const claimed = yield* repository.claimNext;
        expect(claimed).toMatchObject({
          kind: "ai_chat_run",
          payload: { aiRunId: "run-priority-test" },
        });
      }),
    );
  });

  it("recovers stale running jobs and exhausts retries durably", async () => {
    await runDb(
      Effect.gen(function* () {
        yield* resetDatabase;
        const sql = yield* PgClient.PgClient;
        const repository = yield* makePgJobRepository(1);

        const [retryable] = yield* sql<JobRecord>`
            insert into jobs (
              kind,
              payload,
              status,
              attempts,
              max_attempts,
              locked_at,
              locked_by
            )
            values (
              'public_source_ingestion',
              ${sql.json({ value: "retryable" })},
              'running',
              1,
              3,
              now() - interval '5 minutes',
              'brief-worker:dead'
            )
            returning id, kind, payload, attempts, locked_by as "lockedBy"
          `;
        expect(retryable).toBeDefined();

        yield* sql`
            insert into jobs (
              kind,
              payload,
              status,
              attempts,
              max_attempts,
              locked_at,
              locked_by
            )
            values (
              'public_source_ingestion',
              ${sql.json({ value: "exhausted" })},
              'running',
              3,
              3,
              now() - interval '5 minutes',
              'brief-worker:dead'
            )
          `;

        const claimed = yield* repository.claimNext;
        expect(claimed?.id).toBe(retryable!.id);
        expect(claimed?.attempts).toBe(2);
        expect(claimed?.lockedBy).toMatch(/^brief-worker:/);

        const rows = yield* jobRows;
        expect(rows).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              payload: { value: "retryable" },
              status: "running",
              attempts: 2,
              last_error: "job_lock_expired",
            }),
            expect.objectContaining({
              payload: { value: "exhausted" },
              status: "failed",
              attempts: 3,
              locked_by: null,
              last_error: "job_lock_expired",
            }),
          ]),
        );
      }),
    );
  });

  it("concurrently reclaims an exhausted stale AI chat job instead of stranding its product run", async () => {
    await runDb(
      Effect.gen(function* () {
        yield* resetDatabase;
        const sql = yield* PgClient.PgClient;
        const firstRepository = yield* makePgJobRepository(60_000);
        const secondRepository = yield* makePgJobRepository(60_000);
        const [inserted] = yield* sql<JobRecord>`
          insert into jobs (
            kind,
            payload,
            unique_key,
            status,
            attempts,
            max_attempts,
            locked_at,
            locked_by,
            priority
          ) values (
            'ai_chat_run',
            ${sql.json({ aiRunId: "00000000-0000-4000-8000-000000000001" })},
            'ai_chat_run:00000000-0000-4000-8000-000000000001',
            'running',
            5,
            5,
            now() - interval '5 minutes',
            'brief-worker:dead',
            100
          )
          returning id, kind, payload, attempts, max_attempts as "maxAttempts",
                    locked_by as "lockedBy"
        `;

        const claims = yield* Effect.all([firstRepository.claimNext, secondRepository.claimNext], {
          concurrency: "unbounded",
        });
        const claimed = claims.filter((candidate) => candidate !== undefined);
        expect(claimed).toHaveLength(1);
        expect(claimed[0]).toMatchObject({
          id: inserted!.id,
          kind: "ai_chat_run",
          attempts: 6,
          maxAttempts: 5,
        });

        const [row] = yield* sql<{
          readonly status: string;
          readonly attempts: number;
          readonly maxAttempts: number;
          readonly lastError: string | null;
        }>`
          select status, attempts, max_attempts as "maxAttempts", last_error as "lastError"
          from jobs
          where id = ${inserted!.id}
        `;
        expect(row).toEqual({
          status: "running",
          attempts: 6,
          maxAttempts: 5,
          lastError: "job_lock_expired",
        });
      }),
    );
  });

  it("keeps an exhausted AI chat handler failure retryable while ordinary jobs still exhaust", async () => {
    await runDb(
      Effect.gen(function* () {
        yield* resetDatabase;
        const sql = yield* PgClient.PgClient;
        const repository = yield* makePgJobRepository(60_000);
        const [aiJob] = yield* sql<JobRecord>`
          insert into jobs (
            kind, payload, unique_key, status, attempts, max_attempts,
            locked_at, locked_by, priority
          ) values (
            'ai_chat_run',
            ${sql.json({ aiRunId: "00000000-0000-4000-8000-000000000002" })},
            'ai_chat_run:00000000-0000-4000-8000-000000000002',
            'queued', 4, 5, null, null, 100
          )
          returning id, kind, payload, attempts, max_attempts as "maxAttempts",
                    locked_by as "lockedBy"
        `;
        yield* sql`
          insert into jobs (
            kind, payload, unique_key, status, attempts, max_attempts,
            locked_at, locked_by, priority
          ) values (
            'public_source_ingestion',
            ${sql.json({ sourceId: "service_public", mode: "poll" })},
            'ordinary-exhaustion-control',
            'queued', 4, 5, null, null, 0
          )
        `;

        const claimedAiJob = yield* repository.claimNext;
        expect(claimedAiJob).toMatchObject({ id: aiJob!.id, attempts: 5, maxAttempts: 5 });
        yield* repository.markFailed(
          claimedAiJob!,
          new TrustedJobFailure("terminal_metadata_unavailable"),
        );

        const [aiAfterFailure] = yield* sql<{
          readonly status: string;
          readonly attempts: number;
          readonly maxAttempts: number;
          readonly lastError: string | null;
        }>`
          select status, attempts, max_attempts as "maxAttempts", last_error as "lastError"
          from jobs where id = ${aiJob!.id}
        `;
        expect(aiAfterFailure).toEqual({
          status: "retrying",
          attempts: 5,
          maxAttempts: 5,
          lastError: "terminal_metadata_unavailable",
        });

        yield* sql`update jobs set available_at = now() where id = ${aiJob!.id}`;
        const reclaimedAiJob = yield* repository.claimNext;
        expect(reclaimedAiJob).toMatchObject({ id: aiJob!.id, attempts: 6, maxAttempts: 5 });
        yield* repository.markCompleted(reclaimedAiJob!);

        const ordinaryJob = yield* repository.claimNext;
        expect(ordinaryJob).toMatchObject({ kind: "public_source_ingestion", attempts: 5 });
        yield* repository.markFailed(ordinaryJob!, new Error("ordinary infrastructure failure"));
        const [ordinaryAfterFailure] = yield* sql<{ readonly status: string }>`
          select status from jobs where unique_key = 'ordinary-exhaustion-control'
        `;
        expect(ordinaryAfterFailure?.status).toBe("failed");
      }),
    );
  });

  it("renews a running job lock only for the owning worker", async () => {
    await runDb(
      Effect.gen(function* () {
        yield* resetDatabase;
        const repository = yield* makePgJobRepository(60_000);

        yield* repository.enqueue({
          kind: "public_source_ingestion",
          payload: { sourceId: "service_public", mode: "poll" },
          uniqueKey: "public_source_ingestion:service_public:poll",
        });

        const claimed = yield* repository.claimNext;
        expect(claimed?.lockedBy).toMatch(/^brief-worker:/);

        yield* repository.heartbeat(claimed!);
        yield* Effect.flip(
          repository.heartbeat({
            ...claimed!,
            lockedBy: "brief-worker:someone-else",
          }),
        );

        const rows = yield* jobRows;
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          status: "running",
          attempts: 1,
          last_error: null,
        });
        expect(rows[0]?.locked_by).toBe(claimed?.lockedBy);
      }),
    );
  });

  it("persists only explicitly trusted content-free failure codes", async () => {
    await runDb(
      Effect.gen(function* () {
        yield* resetDatabase;
        const repository = yield* makePgJobRepository(60_000);
        yield* repository.enqueue({
          kind: "public_source_ingestion",
          payload: { sourceId: "service_public", mode: "poll" },
          uniqueKey: "content-free-failure",
        });
        const first = yield* repository.claimNext;
        yield* repository.markFailed(
          first!,
          new Error("provider returned secret publisher document text"),
        );
        expect((yield* jobRows)[0]?.last_error).toBe("job_execution_failed");
        const sql = yield* PgClient.PgClient;
        yield* sql`update jobs set available_at = now()`;

        const codeShapedSecret = yield* repository.claimNext;
        yield* repository.markFailed(codeShapedSecret!, new Error("secret_api_key"));
        expect((yield* jobRows)[0]?.last_error).toBe("job_execution_failed");
        yield* sql`update jobs set available_at = now()`;

        const forgedTypedFailure = yield* repository.claimNext;
        yield* repository.markFailed(
          forgedTypedFailure!,
          Object.assign(new Error("ignored detail"), { code: "provider_timeout" }),
        );
        expect((yield* jobRows)[0]?.last_error).toBe("job_execution_failed");
        yield* sql`update jobs set available_at = now()`;

        const trustedFailure = yield* repository.claimNext;
        yield* repository.markFailed(trustedFailure!, new TrustedJobFailure("provider_timeout"));
        const rows = yield* jobRows;
        expect(rows[0]?.last_error).toBe("provider_timeout");
        expect(JSON.stringify(rows[0])).not.toContain("secret");
        expect(JSON.stringify(rows[0])).not.toContain("ignored detail");
      }),
    );
  });
});
