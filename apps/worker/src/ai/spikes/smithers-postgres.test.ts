import { PgClient } from "@effect/sql-pg";
import { Effect, Redacted } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const isBun = typeof process.versions.bun === "string";
const databaseUrl = process.env.WORKER_POSTGRES_TEST_DATABASE_URL;

const getSpikeDatabaseUrl = () => {
  if (databaseUrl === undefined) {
    throw new Error("WORKER_POSTGRES_TEST_DATABASE_URL is required for smithers postgres spikes");
  }

  const url = new URL(databaseUrl);

  if (url.pathname === "/brief_smithers_spike") {
    throw new Error("WORKER_POSTGRES_TEST_DATABASE_URL must not point at brief_smithers_spike");
  }

  url.pathname = "/brief_smithers_spike";
  return url.toString();
};

const getSourceDatabaseUrl = () => {
  if (databaseUrl === undefined) {
    throw new Error("WORKER_POSTGRES_TEST_DATABASE_URL is required for smithers postgres spikes");
  }
  return databaseUrl;
};

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

describe.skipIf(!isBun || !databaseUrl)("smithers postgres backend", () => {
  beforeAll(async () => {
    await runDb(
      getSourceDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const rows = yield* sql<{ readonly datname: string }>`
            select datname from pg_database where datname = 'brief_smithers_spike'
          `;

        if (rows.length === 0) {
          yield* sql.unsafe("create database brief_smithers_spike");
        }
      }),
    );

    await runDb(
      getSpikeDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql.unsafe("drop schema if exists public cascade");
        yield* sql.unsafe("create schema public");
      }),
    );
  }, 60_000);

  it(
    "runs a two-task workflow to completion, persists namespaced outputs, and cleans up",
    { timeout: 120_000 },
    async () => {
      const spikeDatabaseUrl = getSpikeDatabaseUrl();
      const { createSmithersStorage, runSmithersWorkflow } = await import("../smithers-interop");
      const { buildSpikeWorkflow, spikeSchemas } = await import("./spike-workflow");

      const api = await createSmithersStorage(spikeSchemas, {
        connectionString: spikeDatabaseUrl,
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
        spikeDatabaseUrl,
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
        spikeDatabaseUrl,
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
        spikeDatabaseUrl,
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
        spikeDatabaseUrl,
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return yield* sql<{ readonly run_id: string }>`
            select run_id from input where run_id = ${runId}
          `;
        }),
      );

      expect(inputRows).toHaveLength(1);

      const runIdTables = await runDb(
        spikeDatabaseUrl,
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
        spikeDatabaseUrl,
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
        spikeDatabaseUrl,
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

  it("runs the toy workflow from a directory outside any git repository", async () => {
    const spikeDatabaseUrl = getSpikeDatabaseUrl();
    const rootDir = await mkdtemp(join(tmpdir(), "brief-smithers-gitless-"));
    const { createSmithersStorage, runSmithersWorkflow } = await import("../smithers-interop");
    const { buildSpikeWorkflow, spikeSchemas } = await import("./spike-workflow");
    const api = await createSmithersStorage(spikeSchemas, {
      connectionString: spikeDatabaseUrl,
    });

    try {
      const workflow = buildSpikeWorkflow(api);
      const result = await runSmithersWorkflow(workflow, {
        input: { spike: true },
        runId: `spike-gitless-${crypto.randomUUID()}`,
        logDir: null,
        rootDir,
        cwd: rootDir,
      });

      expect(result.status).toBe("finished");
    } finally {
      await api.close();
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it(
    "two storage instances share one postgres and hand off runs",
    { timeout: 120_000 },
    async () => {
      const spikeDatabaseUrl = getSpikeDatabaseUrl();
      const { createSmithersStorage, runSmithersWorkflow } = await import("../smithers-interop");
      const { buildHandoffSpikeWorkflow, buildSpikeWorkflow, spikeSchemas } =
        await import("./spike-workflow");

      const countRows = async (tableName: string, runId: string) =>
        runDb(
          spikeDatabaseUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            const rows = yield* sql<{ readonly count: number | string | bigint }>`
              select count(*) as count from ${sql(tableName)} where run_id = ${runId}
            `;
            return Number(rows[0]?.count ?? 0);
          }),
        );

      const getRunStatus = async (runId: string) =>
        runDb(
          spikeDatabaseUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            return yield* sql<{ readonly status: string }>`
              select status from _smithers_runs where run_id = ${runId}
            `;
          }),
        );

      const storageA = await createSmithersStorage(spikeSchemas, {
        connectionString: spikeDatabaseUrl,
      });
      const storageB = await createSmithersStorage(spikeSchemas, {
        connectionString: spikeDatabaseUrl,
      });
      let storageAClosed = false;

      try {
        const workflowA = buildSpikeWorkflow(storageA);
        const workflowB = buildSpikeWorkflow(storageB);
        const [resultA, resultB] = await Promise.all([
          runSmithersWorkflow(workflowA, {
            input: { spike: true },
            runId: "spike-two-instances-a",
            logDir: null,
          }),
          runSmithersWorkflow(workflowB, {
            input: { spike: true },
            runId: "spike-two-instances-b",
            logDir: null,
          }),
        ]);

        expect(resultA.status).toBe("finished");
        expect(resultA.runId).toBe("spike-two-instances-a");
        expect(resultB.status).toBe("finished");
        expect(resultB.runId).toBe("spike-two-instances-b");
        expect(await countRows("spike_step_one", "spike-two-instances-a")).toBe(1);
        expect(await countRows("spike_step_two", "spike-two-instances-a")).toBe(1);
        expect(await countRows("spike_step_one", "spike-two-instances-b")).toBe(1);
        expect(await countRows("spike_step_two", "spike-two-instances-b")).toBe(1);
        expect(await getRunStatus("spike-two-instances-a")).toEqual([{ status: "finished" }]);
        expect(await getRunStatus("spike-two-instances-b")).toEqual([{ status: "finished" }]);

        const handoffRunId = "spike-two-instances-handoff";
        let releaseStarted!: () => void;
        const stepTwoStarted = new Promise<void>((resolve) => {
          releaseStarted = resolve;
        });
        let rejectGate!: (error: Error) => void;
        const gate = new Promise<never>((_, reject) => {
          rejectGate = reject;
        });
        void gate.catch(() => undefined);
        const phaseOneWorkflow = buildHandoffSpikeWorkflow(storageA, {
          stepOne: () => ({ message: "hello from step one", count: 21 }),
          stepTwo: () => {
            releaseStarted();
            return gate;
          },
        });
        const controller = new AbortController();
        const pending = runSmithersWorkflow(phaseOneWorkflow, {
          input: { spike: true },
          runId: handoffRunId,
          logDir: null,
          signal: controller.signal,
        });
        await stepTwoStarted;
        controller.abort();
        rejectGate(new Error("interrupted for handoff"));
        const interrupted = await pending;

        expect(interrupted.status).toBe("cancelled");

        await storageA.close();
        storageAClosed = true;

        expect(await countRows("spike_step_one", handoffRunId)).toBe(1);
        expect(await countRows("spike_step_two", handoffRunId)).toBe(0);
        expect(await getRunStatus(handoffRunId)).toEqual([{ status: "cancelled" }]);

        const phaseTwoWorkflow = buildHandoffSpikeWorkflow(storageB, {
          stepOne: () => {
            throw new Error("step one must not re-execute on resume");
          },
          stepTwo: (stepOne) => ({
            echoed: stepOne.message,
            doubled: stepOne.count * 2,
          }),
        });
        const resumed = await runSmithersWorkflow(phaseTwoWorkflow, {
          input: { spike: true },
          runId: handoffRunId,
          logDir: null,
          resume: true,
        });

        expect(resumed.status).toBe("finished");

        const handoffStepOneRows = await runDb(
          spikeDatabaseUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            return yield* sql<{
              readonly message: string;
              readonly count: number | string | bigint;
            }>`
              select message, count from spike_step_one where run_id = ${handoffRunId}
            `;
          }),
        );
        const handoffStepTwoRows = await runDb(
          spikeDatabaseUrl,
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            return yield* sql<{
              readonly echoed: string;
              readonly doubled: number | string | bigint;
            }>`
              select echoed, doubled from spike_step_two where run_id = ${handoffRunId}
            `;
          }),
        );

        expect(handoffStepOneRows).toHaveLength(1);
        expect(handoffStepOneRows[0]?.message).toBe("hello from step one");
        expect(Number(handoffStepOneRows[0]?.count)).toBe(21);
        expect(handoffStepTwoRows).toHaveLength(1);
        expect(handoffStepTwoRows[0]?.echoed).toBe("hello from step one");
        expect(Number(handoffStepTwoRows[0]?.doubled)).toBe(42);
        expect(await getRunStatus(handoffRunId)).toEqual([{ status: "finished" }]);

        const adopted = await runSmithersWorkflow(buildSpikeWorkflow(storageB), {
          input: { spike: true },
          runId: "spike-two-instances-a",
          logDir: null,
          resume: true,
        });

        expect(adopted.status).toBe("finished");
        expect(await countRows("spike_step_one", "spike-two-instances-a")).toBe(1);
      } finally {
        await storageB.close();

        if (!storageAClosed) {
          await storageA.close();
        }
      }
    },
  );
});
