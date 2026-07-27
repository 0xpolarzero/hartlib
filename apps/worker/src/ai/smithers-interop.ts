import { Effect } from "effect3";
import { PgClient } from "@effect/sql-pg";
import { Effect as Effect4, Redacted } from "effect";
import {
  closeSingleRunnerRuntime,
  createSmithersPostgres,
  runWorkflow,
  SmithersDb,
} from "smithers-orchestrator";
import type { CreateSmithersApi, RunOptions, RunResult } from "smithers-orchestrator";
import type { z } from "zod";

export type { CreateSmithersApi, RunOptions, RunResult, RunStatus } from "smithers-orchestrator";

/**
 * The public Smithers run summary used by ownership/recovery decisions. Keep
 * this projection deliberately small: evaluation code must not depend on
 * Smithers' private tables or mutate durable orchestration state itself.
 */
export interface SmithersRunSummary {
  readonly runId: string;
  readonly status: string;
  readonly heartbeatAtMs: number | null;
  readonly runtimeOwnerId: string | null;
  readonly finishedAtMs: number | null;
}

/**
 * Close Smithers' process-local Effect Cluster runtime for finite callers such
 * as the evaluation CLI. Long-lived worker startup intentionally leaves this
 * runtime open until process shutdown.
 */
export const closeSmithersWorkflowRuntime = (): Promise<void> => closeSingleRunnerRuntime();

/**
 * Migration 0060 takes the exclusive side of this fence before inspecting or
 * dropping AI-chat Smithers outputs. Every AI-chat producer/resumer takes the
 * shared side before Smithers can create or write those tables.
 */
export const AI_CHAT_SMITHERS_SCHEMA_FENCE = "brief:ai-chat:smithers-schema";

export type SmithersStorage<Schemas extends Record<string, z.ZodObject<any>>> =
  CreateSmithersApi<Schemas> & { close: () => Promise<void> };

interface SmithersPostgresClient {
  query: (...args: readonly unknown[]) => unknown;
}

const serializedClients = new WeakSet<object>();
const workflowMaxConcurrency = new WeakMap<object, number>();

const workflowKey = (workflow: unknown): object => {
  if ((typeof workflow !== "object" || workflow === null) && typeof workflow !== "function") {
    throw new Error("Smithers workflow must be an object or function");
  }
  return workflow as object;
};

export const registerSmithersWorkflowMaxConcurrency = <Workflow>(
  workflow: Workflow,
  maxConcurrency: number,
): Workflow => {
  if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency <= 0) {
    throw new Error("Smithers workflow maxConcurrency must be a positive safe integer");
  }
  const key = workflowKey(workflow);
  const registered = workflowMaxConcurrency.get(key);
  if (registered !== undefined && registered !== maxConcurrency) {
    throw new Error(
      `Smithers workflow maxConcurrency registration mismatch: registered ${registered}, received ${maxConcurrency}`,
    );
  }
  workflowMaxConcurrency.set(key, maxConcurrency);
  return workflow;
};

export const serializeSmithersPostgresClient = (descriptor: unknown): void => {
  if (
    typeof descriptor !== "object" ||
    descriptor === null ||
    !("connection" in descriptor) ||
    typeof descriptor.connection !== "object" ||
    descriptor.connection === null ||
    !("query" in descriptor.connection) ||
    typeof descriptor.connection.query !== "function"
  ) {
    throw new Error("Smithers PostgreSQL storage descriptor lacks a queryable connection");
  }
  const client = descriptor.connection as SmithersPostgresClient;
  if (serializedClients.has(client)) return;

  const query = client.query.bind(client);
  let tail = Promise.resolve();
  client.query = (...args: readonly unknown[]): unknown => {
    const callback = args.at(-1);
    if (typeof callback === "function") {
      const queryArgs = args.slice(0, -1);
      tail = tail
        .then(
          () =>
            new Promise<void>((resolve) => {
              query(...queryArgs, (error: unknown, result: unknown) => {
                try {
                  (callback as (error: unknown, result: unknown) => void)(error, result);
                } finally {
                  resolve();
                }
              });
            }),
        )
        .catch(() => undefined);
      return undefined;
    }

    const result = tail.then(() => query(...args)) as Promise<unknown>;
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  serializedClients.add(client);
};

export async function createSmithersStorage<Schemas extends Record<string, z.ZodObject<any>>>(
  schemas: Schemas,
  options: { readonly connectionString: string },
): Promise<SmithersStorage<Schemas>> {
  const storage = await createSmithersPostgres(schemas, {
    provider: "postgres",
    connectionString: options.connectionString,
  });

  // Smithers 0.30 provisions a single node-postgres Client, while Parallel nodes
  // may issue durable-state queries concurrently. node-postgres does not support
  // overlapping callback queries on one Client (and pg 9 will reject them), so
  // serialize only the storage transport. Workflow tasks and provider calls still
  // run concurrently; their small Smithers checkpoints are ordered deterministically.
  try {
    serializeSmithersPostgresClient(storage.db);
  } catch (error) {
    await storage.close();
    throw error;
  }

  return storage;
}

const withAiChatSmithersProducerFence = <A, E, R>(
  connectionString: string,
  operation: Effect4.Effect<A, E, R>,
): Effect4.Effect<A, E | unknown, R> =>
  Effect4.scoped(
    Effect4.gen(function* () {
      const sql = yield* PgClient.PgClient;
      const connection = yield* sql.reserve;
      yield* Effect4.acquireRelease(
        connection
          .executeRaw("select pg_advisory_lock_shared(hashtextextended($1::text, 0))", [
            AI_CHAT_SMITHERS_SCHEMA_FENCE,
          ])
          .pipe(Effect4.asVoid),
        () =>
          connection
            .executeRaw("select pg_advisory_unlock_shared(hashtextextended($1::text, 0))", [
              AI_CHAT_SMITHERS_SCHEMA_FENCE,
            ])
            .pipe(Effect4.asVoid, Effect4.ignore),
      );
      return yield* operation;
    }),
  ).pipe(
    Effect4.provide(
      PgClient.layer({
        url: Redacted.make(connectionString),
        applicationName: "brief-ai-chat-smithers-fence",
      }),
    ),
  );

/** Run an AI-chat Smithers producer/resume operation under the shared fence. */
export const runWithAiChatSmithersProducerFence = <A>(
  connectionString: string,
  operation: () => Promise<A>,
): Promise<A> =>
  Effect4.runPromise(
    withAiChatSmithersProducerFence(
      connectionString,
      Effect4.tryPromise({ try: operation, catch: (error) => error }),
    ),
  );

/** Scope the shared fence to initial Smithers table creation. */
export const withAiChatSmithersProducerFenceEffect = <A, E, R>(
  connectionString: string,
  operation: Effect4.Effect<A, E, R>,
): Effect4.Effect<A, E | unknown, R> =>
  withAiChatSmithersProducerFence(connectionString, operation);

/**
 * Provision a Smithers store while holding the shared schema fence only for
 * the provisioning operation. The returned store owns a separate connection
 * and remains usable after the fence scope has been released.
 */
export const createAiChatSmithersStorage = <Schemas extends Record<string, z.ZodObject<any>>>(
  schemas: Schemas,
  connectionString: string,
): Promise<SmithersStorage<Schemas>> =>
  Effect4.runPromise(
    withAiChatSmithersProducerFenceEffect(
      connectionString,
      Effect4.tryPromise({
        try: () => createSmithersStorage(schemas, { connectionString }),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      }),
    ),
  );

export async function smithersRunExists<Schemas extends Record<string, z.ZodObject<any>>>(
  storage: Pick<CreateSmithersApi<Schemas>, "db">,
  runId: string,
): Promise<boolean> {
  return (await smithersRunSummary(storage, runId)) !== null;
}

/** Read one run through Smithers' public storage adapter without changing it. */
export async function smithersRunSummary<Schemas extends Record<string, z.ZodObject<any>>>(
  storage: Pick<CreateSmithersApi<Schemas>, "db">,
  runId: string,
): Promise<SmithersRunSummary | null> {
  const adapter = new SmithersDb(storage.db);
  const row = await Effect.runPromise(adapter.getRun(runId));
  if (row === undefined) return null;
  return {
    runId: row.runId,
    status: row.status,
    heartbeatAtMs: row.heartbeatAtMs,
    runtimeOwnerId: row.runtimeOwnerId,
    finishedAtMs: row.finishedAtMs,
  };
}

export type BriefRunOptions = Pick<RunOptions, "input"> &
  Partial<
    Pick<RunOptions, "runId" | "logDir" | "resume" | "signal" | "rootDir" | "maxConcurrency">
  > & {
    readonly cwd?: string | undefined;
  };

export async function runSmithersWorkflow(
  workflow: unknown,
  options: BriefRunOptions,
): Promise<RunResult> {
  const registeredMaxConcurrency = workflowMaxConcurrency.get(workflowKey(workflow));
  if (
    registeredMaxConcurrency !== undefined &&
    options.maxConcurrency !== undefined &&
    options.maxConcurrency !== registeredMaxConcurrency
  ) {
    throw new Error(
      `Smithers workflow maxConcurrency mismatch: registered ${registeredMaxConcurrency}, received explicit ${options.maxConcurrency}`,
    );
  }
  const maxConcurrency = registeredMaxConcurrency ?? options.maxConcurrency;
  return Effect.runPromise(
    runWorkflow(workflow, {
      ...options,
      ...(maxConcurrency === undefined ? {} : { maxConcurrency }),
    } as RunOptions),
  );
}
