/** @jsxImportSource smithers-orchestrator */
import { Effect } from "effect3";
import { createSmithers, runWorkflow, closeSingleRunnerRuntime } from "smithers-orchestrator";
import { z } from "zod";

const { Workflow, Sequence, Task, smithers, outputs } = createSmithers(
  { result: z.object({ value: z.string() }) },
  { dbPath: process.env.HARTLIB_EXIT_DB_PATH ?? "/private/tmp/hartlib-smithers-exit-test.db" },
);
const activeMode = process.env.HARTLIB_EXIT_ACTIVE === "1";
let taskStarted!: () => void;
const taskStartedPromise = new Promise<void>((resolve) => {
  taskStarted = resolve;
});
let releaseTask!: () => void;
const releaseTaskPromise = new Promise<void>((resolve) => {
  releaseTask = resolve;
});
const workflow = smithers(() => (
  <Workflow name="exit-test">
    <Sequence>
      <Task id="result" output={outputs.result} retries={0}>
        {async () => {
          if (process.env.HARTLIB_EXIT_FAIL === "1") throw new Error("expected evaluation failure");
          if (activeMode) {
            taskStarted();
            await releaseTaskPromise;
          }
          return { value: "ok" };
        }}
      </Task>
    </Sequence>
  </Workflow>
));
try {
  const run = () =>
    Effect.runPromise(
      runWorkflow(workflow, {
        runId: process.env.HARTLIB_EXIT_RUN_ID ?? "exit-test",
        input: {},
      }),
    );
  if (activeMode) {
    const pending = run();
    await taskStartedPromise;
    let activeCloseRejected = false;
    try {
      await closeSingleRunnerRuntime();
    } catch (error) {
      activeCloseRejected = true;
      console.error(
        error instanceof Error ? error.message : "expected active-runtime shutdown rejection",
      );
    }
    releaseTask();
    const result = await pending;
    console.log(JSON.stringify({ ...result, activeCloseRejected }));
    if (result.status === "failed" || !activeCloseRejected) process.exitCode = 2;
    await closeSingleRunnerRuntime();
  } else {
    const result = await run();
    console.log(JSON.stringify(result));
    if (result.status === "failed") process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "expected evaluation failure");
  process.exitCode = 2;
} finally {
  try {
    await closeSingleRunnerRuntime();
  } catch (error) {
    console.error(error instanceof Error ? `shutdown failed: ${error.message}` : "shutdown failed");
    process.exitCode = 2;
  }
}
