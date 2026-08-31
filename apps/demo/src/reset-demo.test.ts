import { describe, expect, it } from "vitest";
import { createResetDemoController } from "./reset-demo";
import { DEMO_STORAGE_KEYS, readDemoStorage, writeDemoStorage } from "./storage-registry";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}
class RejectingStorage extends MemoryStorage {
  override setItem() {
    throw new Error("quota");
  }
}
describe("destructive demo reset", () => {
  it("writes one operation before request and clears registered state on acceptance", async () => {
    const local = new MemoryStorage();
    let calls = 0;
    let reloaded = 0;
    const controller = createResetDemoController({
      localStorage: local,
      sessionStorage: new MemoryStorage(),
      generateOperationId: () => "00000000-0000-4000-8000-000000000001",
      requestReset: async (id) => {
        calls += 1;
        expect(id).toBe("00000000-0000-4000-8000-000000000001");
        expect(local.getItem("hartlib:demo:pending-reset-operation")).toBe(id);
        return { ok: true };
      },
      reload: () => {
        reloaded += 1;
      },
    });
    await controller.reset();
    expect(calls).toBe(1);
    expect(reloaded).toBe(1);
    expect(controller.getState().phase).toBe("idle");
  });
  it("keeps the operation for a retry after a definite failure", async () => {
    const local = new MemoryStorage();
    const controller = createResetDemoController({
      localStorage: local,
      generateOperationId: () => "00000000-0000-4000-8000-000000000002",
      requestReset: async () => {
        throw new Error("offline");
      },
    });
    await controller.reset();
    expect(controller.getState().phase).toBe("error");
    expect(local.getItem("hartlib:demo:pending-reset-operation")).toBe(
      "00000000-0000-4000-8000-000000000002",
    );
  });
  it("does not request reset when the operation cannot be persisted", async () => {
    const local = new RejectingStorage();
    let calls = 0;
    const controller = createResetDemoController({
      localStorage: local,
      generateOperationId: () => "00000000-0000-4000-8000-000000000003",
      requestReset: async () => {
        calls += 1;
        return { ok: true };
      },
    });
    await controller.reset();
    expect(calls).toBe(0);
    expect(controller.getState()).toMatchObject({
      phase: "error",
      operationId: "00000000-0000-4000-8000-000000000003",
    });
  });
  it("keeps the operation until committed cleanup finishes", async () => {
    const local = new MemoryStorage();
    let release: (() => void) | undefined;
    const cleanup = new Promise<void>((resolve) => {
      release = resolve;
    });
    const controller = createResetDemoController({
      localStorage: local,
      generateOperationId: () => "00000000-0000-4000-8000-000000000004",
      requestReset: async () => ({ ok: true }),
      clearState: async () => cleanup,
    });
    const pending = controller.reset();
    await Promise.resolve();
    expect(local.getItem("hartlib:demo:pending-reset-operation")).toBe(
      "00000000-0000-4000-8000-000000000004",
    );
    release?.();
    await pending;
    expect(local.getItem("hartlib:demo:pending-reset-operation")).toBeNull();
  });
  it("recovers a persisted operation before bootstrap and fences late writes", async () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const operationId = "00000000-0000-4000-8000-000000000005";
    local.setItem(DEMO_STORAGE_KEYS.pendingResetOperation, operationId);
    local.setItem(DEMO_STORAGE_KEYS.locale, "en-US");
    const order: string[] = [];
    const controller = createResetDemoController({
      localStorage: local,
      sessionStorage: session,
      requestReset: async (id) => {
        order.push(`request:${id}`);
        return { ok: true };
      },
      abortStreams: () => order.push("abort-streams"),
      clearState: () => {
        order.push(
          `clear-state:${readDemoStorage("local", DEMO_STORAGE_KEYS.pendingResetOperation, local) === operationId ? "pending" : "missing"}`,
        );
        expect(writeDemoStorage("local", DEMO_STORAGE_KEYS.locale, "fr-FR", local)).toBe(false);
      },
      reload: () => order.push("reload"),
    });
    await expect(controller.recover()).resolves.toBe(true);
    expect(order).toEqual([
      `request:${operationId}`,
      "abort-streams",
      "clear-state:pending",
      "reload",
    ]);
    expect(local.getItem(DEMO_STORAGE_KEYS.pendingResetOperation)).toBeNull();
    expect(local.getItem(DEMO_STORAGE_KEYS.locale)).toBeNull();
  });
  it("shows a retryable error when pending-operation recovery is rejected", async () => {
    const local = new MemoryStorage();
    const operationId = "00000000-0000-4000-8000-000000000006";
    local.setItem(DEMO_STORAGE_KEYS.pendingResetOperation, operationId);
    const controller = createResetDemoController({
      localStorage: local,
      requestReset: async () => {
        throw new Error("offline");
      },
    });

    await expect(controller.recover()).resolves.toBe(false);
    expect(controller.getState()).toEqual({
      phase: "error",
      error: "request-failed",
      operationId,
    });
    expect(local.getItem(DEMO_STORAGE_KEYS.pendingResetOperation)).toBe(operationId);
  });
});
