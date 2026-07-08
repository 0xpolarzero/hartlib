import { Effect } from "effect3";
import { createSmithersPostgres, runWorkflow } from "smithers-orchestrator";
import type { CreateSmithersApi, RunOptions, RunResult } from "smithers-orchestrator";
import type { z } from "zod";

export type { CreateSmithersApi, RunOptions, RunResult, RunStatus } from "smithers-orchestrator";

export async function createSmithersStorage<Schemas extends Record<string, z.ZodObject<any>>>(
  schemas: Schemas,
  options: { readonly connectionString: string },
): Promise<CreateSmithersApi<Schemas> & { close: () => Promise<void> }> {
  return createSmithersPostgres(schemas, {
    provider: "postgres",
    connectionString: options.connectionString,
  });
}

export function runSmithersWorkflow(
  workflow: unknown,
  options: Pick<RunOptions, "runId" | "input" | "logDir">,
): Promise<RunResult> {
  return Effect.runPromise(runWorkflow(workflow, options));
}
