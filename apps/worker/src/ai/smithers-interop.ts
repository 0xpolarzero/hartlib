import { Effect } from "effect3";
import { createSmithersPostgres, runWorkflow, SmithersDb } from "smithers-orchestrator";
import type { CreateSmithersApi, RunOptions, RunResult } from "smithers-orchestrator";
import type { z } from "zod";

export type { CreateSmithersApi, RunOptions, RunResult, RunStatus } from "smithers-orchestrator";

export type SmithersStorage<Schemas extends Record<string, z.ZodObject<any>>> =
  CreateSmithersApi<Schemas> & { close: () => Promise<void> };

export async function createSmithersStorage<Schemas extends Record<string, z.ZodObject<any>>>(
  schemas: Schemas,
  options: { readonly connectionString: string },
): Promise<SmithersStorage<Schemas>> {
  return createSmithersPostgres(schemas, {
    provider: "postgres",
    connectionString: options.connectionString,
  });
}

export async function smithersRunExists<Schemas extends Record<string, z.ZodObject<any>>>(
  storage: Pick<CreateSmithersApi<Schemas>, "db">,
  runId: string,
): Promise<boolean> {
  const adapter = new SmithersDb(storage.db);
  const row = await Effect.runPromise(adapter.getRun(runId));

  return row !== undefined;
}

export function runSmithersWorkflow(
  workflow: unknown,
  options: Pick<RunOptions, "runId" | "input" | "logDir" | "resume" | "signal">,
): Promise<RunResult> {
  return Effect.runPromise(runWorkflow(workflow, options));
}
