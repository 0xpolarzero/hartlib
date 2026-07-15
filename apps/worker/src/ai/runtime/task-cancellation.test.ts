import * as SmithersTaskRuntimeModule from "@smithers-orchestrator/driver/task-runtime";
import { describe, expect, it, vi } from "vitest";

import {
  awaitWithTaskAbort,
  currentTaskAbortSignal,
  currentTaskRuntime,
  forwardAbortSignal,
  requireCurrentTaskCoordinates,
  throwIfAborted,
} from "./task-cancellation";

type Runtime = {
  readonly runId: string;
  readonly stepId: string;
  readonly attempt: number;
  readonly iteration: number;
  readonly signal: AbortSignal;
  readonly db: Readonly<Record<string, unknown>>;
  readonly heartbeat: (data?: unknown) => void;
  readonly lastHeartbeat: unknown | null;
};

const withTaskRuntime = (
  SmithersTaskRuntimeModule as unknown as {
    readonly withTaskRuntime: <Value>(runtime: Runtime, execute: () => Value) => Value;
  }
).withTaskRuntime;

const inTask = <Value>(controller: AbortController, execute: () => Value): Value =>
  withTaskRuntime(
    {
      runId: "run",
      stepId: "task",
      attempt: 1,
      iteration: 0,
      signal: controller.signal,
      db: {},
      heartbeat: () => undefined,
      lastHeartbeat: null,
    },
    execute,
  );

describe("Smithers task cancellation adapter", () => {
  it("reads the exact async-local Smithers task signal without affecting direct calls", () => {
    expect(currentTaskAbortSignal()).toBeUndefined();
    const controller = new AbortController();
    expect(inTask(controller, currentTaskAbortSignal)).toBe(controller.signal);
    expect(inTask(controller, currentTaskRuntime)).toEqual({
      runId: "run",
      taskId: "task",
      attempt: 1,
      loopIteration: 0,
      signal: controller.signal,
    });
    expect(currentTaskAbortSignal()).toBeUndefined();
  });

  it("fails closed when a side effect has no exact Smithers coordinates", () => {
    expect(() => requireCurrentTaskCoordinates("task")).toThrow(
      "Smithers task runtime is required for task",
    );
    const controller = new AbortController();
    expect(inTask(controller, () => requireCurrentTaskCoordinates("task"))).toEqual({
      attempt: 1,
      loopIteration: 0,
    });
    expect(() => inTask(controller, () => requireCurrentTaskCoordinates("other"))).toThrow(
      /expected other, executing task/,
    );
  });

  it("rejects non-signal-aware work on task abort and ignores its late result", async () => {
    const controller = new AbortController();
    let resolve!: (value: string) => void;
    const pending = new Promise<string>((done) => {
      resolve = done;
    });
    const continuation = vi.fn();
    const result = inTask(controller, () =>
      awaitWithTaskAbort(pending, currentTaskAbortSignal()).then(continuation),
    );

    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    resolve("late");
    await Promise.resolve();
    expect(continuation).not.toHaveBeenCalled();
  });

  it("forwards a parent abort exactly once into a boundary controller", () => {
    const parent = new AbortController();
    const child = new AbortController();
    const onAbort = vi.fn();
    child.signal.addEventListener("abort", onAbort);
    const remove = forwardAbortSignal(parent.signal, child);

    parent.abort("task timeout");
    remove();
    parent.abort("ignored");
    expect(child.signal.aborted).toBe(true);
    expect(child.signal.reason).toBe("task timeout");
    expect(onAbort).toHaveBeenCalledOnce();
    expect(() => throwIfAborted(parent.signal)).toThrow(
      expect.objectContaining({ name: "AbortError" }),
    );
  });
});
