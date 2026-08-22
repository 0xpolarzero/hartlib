/** @jsxImportSource smithers-orchestrator */
// smithers-metadata-version: 1
// smithers-display-name: Temporary Demo Terminal Error Fix
// smithers-description: Delegate the focused demo terminal-error fix to the repository Luna write agent.
// smithers-tags: temporary, implementation, demo, chat
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";

const inputSchema = z.object({ goal: z.string().trim().min(1) });
const resultSchema = z.object({
  summary: z.string(),
  rootCause: z.string(),
  changedFiles: z.array(z.string()),
  tests: z.array(z.string()),
  residualRisk: z.array(z.string()),
  blockers: z.array(z.string()),
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: inputSchema,
  result: resultSchema,
});

export default smithers((ctx) => (
  <Workflow name="tmp-demo-terminal-error">
    <Task id="implement-debug-test" output={outputs.result} agent={agents.write}>
      {ctx.input.goal}
    </Task>
  </Workflow>
));
