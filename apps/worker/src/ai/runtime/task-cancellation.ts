import * as SmithersTaskRuntimeModule from "@smithers-orchestrator/driver/task-runtime";

/**
 * Smithers 0.31.0 publishes the task-runtime JavaScript subpath, but its
 * generated subpath declaration points at the driver's aggregate declarations
 * and omits these exports. Keep the package-specific structural cast here so
 * no Smithers or Effect v3 type leaks into the Effect v4 worker runtime.
 */
const smithersTaskRuntime = SmithersTaskRuntimeModule as unknown as {
  readonly getTaskRuntime: () =>
    | {
        readonly runId: string;
        readonly stepId: string;
        readonly attempt: number;
        readonly iteration: number;
        readonly signal: AbortSignal;
      }
    | undefined;
};

export interface CurrentTaskRuntime {
  readonly runId: string;
  readonly taskId: string;
  readonly attempt: number;
  readonly loopIteration: number;
  readonly signal: AbortSignal;
}

export const currentTaskRuntime = (): CurrentTaskRuntime | undefined => {
  const runtime = smithersTaskRuntime.getTaskRuntime();
  return runtime === undefined
    ? undefined
    : {
        runId: runtime.runId,
        taskId: runtime.stepId,
        attempt: runtime.attempt,
        loopIteration: runtime.iteration,
        signal: runtime.signal,
      };
};

export const currentTaskAbortSignal = (): AbortSignal | undefined => currentTaskRuntime()?.signal;

export const currentTaskCoordinates = (
  expectedTaskId: string,
): { readonly loopIteration: number; readonly attempt: number } | undefined => {
  const runtime = currentTaskRuntime();
  if (runtime === undefined) return undefined;
  if (runtime.taskId !== expectedTaskId) {
    throw new Error(
      `Smithers task runtime mismatch: expected ${expectedTaskId}, executing ${runtime.taskId}`,
    );
  }
  return { loopIteration: runtime.loopIteration, attempt: runtime.attempt };
};

/**
 * Side-effecting runtime paths must never invent Smithers coordinates. Direct
 * unit helpers may inspect the optional form above; provider/product writes use
 * this fail-closed form so every durable key belongs to one exact attempt.
 */
export const requireCurrentTaskCoordinates = (
  expectedTaskId: string,
): { readonly loopIteration: number; readonly attempt: number } => {
  const coordinates = currentTaskCoordinates(expectedTaskId);
  if (coordinates === undefined) {
    throw new Error(`Smithers task runtime is required for ${expectedTaskId}`);
  }
  return coordinates;
};

export const taskAbortError = (): Error => {
  const error = new Error("AI task aborted");
  error.name = "AbortError";
  return error;
};

export const throwIfAborted = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) throw taskAbortError();
};

/** Races non-signal-aware local work without allowing its late result to continue the task. */
export const awaitWithTaskAbort = <Value>(
  promise: Promise<Value>,
  signal: AbortSignal | undefined,
): Promise<Value> => {
  if (signal === undefined) return promise;
  throwIfAborted(signal);
  return new Promise<Value>((resolve, reject) => {
    const onAbort = () => reject(taskAbortError());
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
};

/** Forwards one parent signal into a boundary-owned controller. */
export const forwardAbortSignal = (
  parent: AbortSignal | undefined,
  controller: AbortController,
): (() => void) => {
  if (parent === undefined) return () => undefined;
  const onAbort = () => controller.abort(parent.reason);
  if (parent.aborted) {
    onAbort();
    return () => undefined;
  }
  parent.addEventListener("abort", onAbort, { once: true });
  return () => parent.removeEventListener("abort", onAbort);
};
