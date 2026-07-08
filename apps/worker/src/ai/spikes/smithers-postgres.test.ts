import { PgClient } from "@effect/sql-pg";
import { Effect, Redacted } from "effect";
import { describe, expect, it } from "vitest";

const isBun = typeof process.versions.bun === "string";
const baseDatabaseUrl = process.env.DATABASE_URL ?? "postgres://brief:brief@localhost:5432/brief";
const testDatabaseUrlValue = new URL(baseDatabaseUrl);
testDatabaseUrlValue.pathname = "/brief_test";
const testDatabaseUrl = testDatabaseUrlValue.toString();

const runDb = <A, E>(url: string, effect: Effect.Effect<A, E, PgClient.PgClient>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        PgClient.layer({
          url: Redacted.make(url),
          applicationName: "brief-ai-smithers-spike",
        }),
      ),
    ),
  );

describe.skipIf(!isBun)("smithers postgres backend", () => {
  it(
    "runs a two-task workflow to completion, persists namespaced outputs, and cleans up",
    { timeout: 120_000 },
    async () => {
      await runDb(
        baseDatabaseUrl,
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const rows = yield* sql<{ readonly datname: string }>`
            select datname from pg_database where datname = 'brief_test'
          `;

          if (rows.length === 0) {
            yield* sql.unsafe("create database brief_test");
          }
        }),
      );

      await runDb(
        testDatabaseUrl,
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql.unsafe("drop schema if exists public cascade");
          yield* sql.unsafe("create schema public");
        }),
      );

      const { createSmithersStorage, runSmithersWorkflow } = await import("../smithers-interop");
      const { buildSpikeWorkflow, spikeSchemas } = await import("./spike-workflow");

      const api = await createSmithersStorage(spikeSchemas, {
        connectionString: testDatabaseUrl,
      });
      let runId: string | undefined;

      try {
        const workflow = buildSpikeWorkflow(api);
        const result = await runSmithersWorkflow(workflow, {
          input: { spike: true },
          logDir: null,
        });

        expect(result.status).toBe("finished");
        runId = result.runId;
      } finally {
        await api.close();
      }

      if (runId === undefined) {
        throw new Error("Workflow did not produce a run id");
      }

      const tables = await runDb(
        testDatabaseUrl,
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return yield* sql<{ readonly table_name: string }>`
            select table_name from information_schema.tables where table_schema = 'public'
          `;
        }),
      );
      const tableNames = tables.map((row) => row.table_name);
      const smithersTableNames = tableNames.filter((tableName) =>
        tableName.startsWith("_smithers_"),
      );

      expect(tableNames).toContain("input");
      expect(tableNames).toContain("spike_step_one");
      expect(tableNames).toContain("spike_step_two");
      expect(tableNames).toContain("_smithers_runs");
      expect(smithersTableNames.length).toBeGreaterThan(0);

      const stepOneRows = await runDb(
        testDatabaseUrl,
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return yield* sql<{
            readonly message: string;
            readonly count: number | string | bigint;
          }>`
            select message, count from spike_step_one where run_id = ${runId}
          `;
        }),
      );
      expect(stepOneRows).toHaveLength(1);
      const stepOneRow = stepOneRows[0];

      if (stepOneRow === undefined) {
        throw new Error("Missing spikeStepOne output row");
      }

      expect(stepOneRow.message).toBe("hello from step one");
      expect(Number(stepOneRow.count)).toBe(21);

      const stepTwoRows = await runDb(
        testDatabaseUrl,
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return yield* sql<{
            readonly echoed: string;
            readonly doubled: number | string | bigint;
          }>`
            select echoed, doubled from spike_step_two where run_id = ${runId}
          `;
        }),
      );
      expect(stepTwoRows).toHaveLength(1);
      const stepTwoRow = stepTwoRows[0];

      if (stepTwoRow === undefined) {
        throw new Error("Missing spikeStepTwo output row");
      }

      expect(stepTwoRow.echoed).toBe("hello from step one");
      expect(Number(stepTwoRow.doubled)).toBe(42);

      const inputRows = await runDb(
        testDatabaseUrl,
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return yield* sql<{ readonly run_id: string }>`
            select run_id from input where run_id = ${runId}
          `;
        }),
      );

      expect(inputRows).toHaveLength(1);

      const runIdTables = await runDb(
        testDatabaseUrl,
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return yield* sql<{ readonly table_name: string }>`
            select distinct table_name
            from information_schema.columns
            where table_schema = 'public' and column_name = 'run_id'
          `;
        }),
      );
      const runIdTableNames = runIdTables
        .map((row) => row.table_name)
        .sort((left, right) => {
          if (left === "_smithers_runs") {
            return 1;
          }

          if (right === "_smithers_runs") {
            return -1;
          }

          return left.localeCompare(right);
        });

      expect(runIdTableNames).toContain("input");
      expect(runIdTableNames).toContain("spike_step_one");
      expect(runIdTableNames).toContain("spike_step_two");
      expect(runIdTableNames).toContain("_smithers_runs");

      await runDb(
        testDatabaseUrl,
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;

          for (const tableName of runIdTableNames) {
            yield* sql`
              delete from ${sql(tableName)} where run_id = ${runId}
            `;
          }
        }),
      );

      const remainingCounts = await runDb(
        testDatabaseUrl,
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const counts: Array<{
            readonly tableName: string;
            readonly count: number;
          }> = [];

          for (const tableName of runIdTableNames) {
            const rows = yield* sql<{
              readonly count: number | string | bigint;
            }>`
              select count(*) as count from ${sql(tableName)}
              where run_id = ${runId}
            `;
            counts.push({
              tableName,
              count: Number(rows[0]?.count ?? 0),
            });
          }

          return counts;
        }),
      );

      for (const remainingCount of remainingCounts) {
        expect(remainingCount.count).toBe(0);
      }
    },
  );
});
