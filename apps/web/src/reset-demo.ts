import {
  DEMO_STORAGE_KEYS,
  clearDemoClientStorage,
  fenceDemoStorageWrites,
  readDemoStorage,
  writeDemoStorage,
} from "./storage-registry";

export type ResetDemoPhase = "idle" | "pending" | "error";
export type ResetDemoErrorCode =
  | "request-failed"
  | "not-accepted"
  | "operation-id-unavailable"
  | "storage-failed"
  | "cleanup-failed";
export interface ResetDemoState {
  readonly phase: ResetDemoPhase;
  readonly error: ResetDemoErrorCode | null;
  readonly operationId: string | null;
}
export interface ResetDemoOptions {
  readonly requestReset: (resetOperationId: string) => Promise<{ readonly ok: true } | Response>;
  readonly abortStreams?: () => void;
  readonly clearState?: () => void | Promise<void>;
  readonly reload?: () => void;
  readonly onError?: (error: unknown) => void;
  readonly generateOperationId?: () => string;
  readonly localStorage?: Storage;
  readonly sessionStorage?: Storage;
}
export type ResetDemoController = {
  readonly getState: () => ResetDemoState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly reset: () => Promise<void>;
  readonly recover: () => Promise<boolean>;
  readonly retry: () => Promise<void>;
};
const initialState: ResetDemoState = { phase: "idle", error: null, operationId: null };
function operationId(options: ResetDemoOptions): string {
  if (options.generateOperationId) return options.generateOperationId();
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
    return crypto.randomUUID();
  throw new Error("secure operation id unavailable");
}
async function accepted(result: { readonly ok: true } | Response): Promise<boolean> {
  if (result instanceof Response)
    return result.status === 202 && (await result.json().catch(() => null))?.ok === true;
  return result.ok === true;
}

export function createResetDemoController(options: ResetDemoOptions): ResetDemoController {
  let state = initialState;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  const setState = (next: ResetDemoState) => {
    state = next;
    notify();
  };
  const finish = async () => {
    // Fence asynchronous writers before clearing their registered keys. If
    // cleanup cannot prove that every key was removed, keep the page in the
    // retry state and do not reload into a partially reset client.
    fenceDemoStorageWrites(options.localStorage, options.sessionStorage);
    options.abortStreams?.();
    const cleared = clearDemoClientStorage({
      ...(options.localStorage === undefined ? {} : { local: options.localStorage }),
      ...(options.sessionStorage === undefined ? {} : { session: options.sessionStorage }),
      preservePendingResetOperation: true,
    });
    if (!cleared) throw new Error("Reset client storage cleanup was incomplete");
    await options.clearState?.();
    const pendingCleared = clearDemoClientStorage({
      ...(options.localStorage === undefined ? {} : { local: options.localStorage }),
      ...(options.sessionStorage === undefined ? {} : { session: options.sessionStorage }),
    });
    if (!pendingCleared) throw new Error("Reset operation cleanup was incomplete");
    setState(initialState);
    options.reload?.();
  };
  const send = async (id: string): Promise<boolean> => {
    setState({ phase: "pending", error: null, operationId: id });
    try {
      const result = await options.requestReset(id);
      if (!(await accepted(result))) {
        setState({ phase: "error", error: "not-accepted", operationId: id });
        return false;
      }
    } catch (error) {
      setState({ phase: "error", error: "request-failed", operationId: id });
      options.onError?.(error);
      return false;
    }
    try {
      await finish();
      return true;
    } catch (error) {
      setState({ phase: "error", error: "cleanup-failed", operationId: id });
      options.onError?.(error);
      return false;
    }
  };
  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reset: async () => {
      if (state.phase === "pending") return;
      let id: string;
      try {
        id = state.operationId ?? operationId(options);
      } catch (error) {
        setState({
          phase: "error",
          error: "operation-id-unavailable",
          operationId: null,
        });
        options.onError?.(error);
        return;
      }
      if (
        !writeDemoStorage(
          "local",
          DEMO_STORAGE_KEYS.pendingResetOperation,
          id,
          options.localStorage,
        )
      ) {
        const error = new Error("Reset operation could not be saved");
        setState({
          phase: "error",
          error: "storage-failed",
          operationId: id,
        });
        options.onError?.(error);
        return;
      }
      await send(id);
    },
    recover: async () => {
      const id = readDemoStorage(
        "local",
        DEMO_STORAGE_KEYS.pendingResetOperation,
        options.localStorage,
      );
      if (!id) return false;
      return send(id);
    },
    retry: async () => {
      const id =
        state.operationId ??
        readDemoStorage("local", DEMO_STORAGE_KEYS.pendingResetOperation, options.localStorage);
      if (id) {
        const retryingCleanup = state.error === "cleanup-failed" && state.operationId === id;
        if (
          !retryingCleanup &&
          !writeDemoStorage(
            "local",
            DEMO_STORAGE_KEYS.pendingResetOperation,
            id,
            options.localStorage,
          )
        ) {
          const error = new Error("Reset operation could not be saved");
          setState({
            phase: "error",
            error: "storage-failed",
            operationId: id,
          });
          options.onError?.(error);
          return;
        }
        await send(id);
      }
    },
  };
}
