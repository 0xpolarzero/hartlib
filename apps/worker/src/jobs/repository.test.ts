import { PgClient } from "@effect/sql-pg";
import { Effect, Redacted } from "effect";
import { describe, expect, it } from "vitest";
import { makePgJobRepository } from "./repository";
import type { JobRecord } from "./types";

const databaseUrl = process.env.WORKER_POSTGRES_TEST_DATABASE_URL;
const migrationsUrl = new URL("../../../../../db/migrations/", import.meta.url);

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
  yield* sql`truncate table jobs restart identity`;
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
  it("claims jobs with durable ownership and requires the same owner to complete", async () => {
    await runDb(
      Effect.gen(function* () {
        yield* resetDatabase;
        const repository = yield* makePgJobRepository(60_000);

        yield* repository.enqueue({
          kind: "public_source_ingestion",
          payload: { sourceId: "info_gouv", mode: "poll" },
          uniqueKey: "public_source_ingestion:info_gouv",
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

  it("keeps backfill queued behind a running poll for the same source", async () => {
    await runDb(
      Effect.gen(function* () {
        yield* resetDatabase;
        const repository = yield* makePgJobRepository(60_000);

        yield* repository.enqueue({
          kind: "public_source_ingestion",
          payload: { sourceId: "info_gouv", mode: "poll" },
          uniqueKey: "public_source_ingestion:info_gouv:poll",
        });
        const runningPoll = yield* repository.claimNext;

        yield* repository.enqueue({
          kind: "public_source_ingestion",
          payload: { sourceId: "info_gouv", mode: "backfill", since: "2026-06-29T00:00:00.000Z" },
          uniqueKey: "public_source_ingestion:info_gouv:backfill",
          priority: 10,
        });

        const blockedBackfill = yield* repository.claimNext;
        expect(blockedBackfill).toBeUndefined();

        yield* repository.markCompleted(runningPoll!);
        const claimedBackfill = yield* repository.claimNext;
        expect(claimedBackfill).toMatchObject({
          payload: {
            sourceId: "info_gouv",
            mode: "backfill",
            since: "2026-06-29T00:00:00.000Z",
          },
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
              last_error: "Job lock expired before completion",
            }),
            expect.objectContaining({
              payload: { value: "exhausted" },
              status: "failed",
              attempts: 3,
              locked_by: null,
              last_error: "Job lock expired before completion",
            }),
          ]),
        );
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
          payload: { sourceId: "info_gouv", mode: "poll" },
          uniqueKey: "public_source_ingestion:info_gouv:poll",
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
});
