import { describe, expect, it, vi } from "vitest";

import { ProviderSemaphore } from "./provider-semaphore";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe("worker provider semaphore", () => {
  it("globally bounds concurrent calls and serves waiters in FIFO order", async () => {
    const semaphore = new ProviderSemaphore(2);
    const gates = Array.from({ length: 4 }, deferred);
    const entered: number[] = [];
    const calls = gates.map((gate, index) =>
      semaphore.withPermit(async () => {
        entered.push(index);
        await gate.promise;
        return index;
      }),
    );

    await Promise.resolve();
    expect(entered).toEqual([0, 1]);
    expect(semaphore.snapshot()).toEqual({ active: 2, queued: 2, limit: 2 });
    gates[0]!.resolve();
    await calls[0];
    await Promise.resolve();
    expect(entered).toEqual([0, 1, 2]);
    gates[1]!.resolve();
    await calls[1];
    await Promise.resolve();
    expect(entered).toEqual([0, 1, 2, 3]);
    gates[2]!.resolve();
    gates[3]!.resolve();
    await expect(Promise.all(calls)).resolves.toEqual([0, 1, 2, 3]);
    expect(semaphore.snapshot()).toEqual({ active: 0, queued: 0, limit: 2 });
  });

  it("releases a permit after rejection so the next call cannot deadlock", async () => {
    const semaphore = new ProviderSemaphore(1);
    await expect(
      semaphore.withPermit(async () => {
        throw new Error("provider failed");
      }),
    ).rejects.toThrow("provider failed");
    await expect(semaphore.withPermit(async () => "recovered")).resolves.toBe("recovered");
    expect(semaphore.snapshot()).toEqual({ active: 0, queued: 0, limit: 1 });
  });

  it("removes aborted queued waiters without invoking them or disturbing FIFO order", async () => {
    const semaphore = new ProviderSemaphore(1);
    const firstGate = deferred();
    const entered: string[] = [];
    const first = semaphore.withPermit(async () => {
      entered.push("first");
      await firstGate.promise;
    });
    await Promise.resolve();

    const middleController = new AbortController();
    const middleOperation = vi.fn(async () => entered.push("aborted-middle"));
    const middle = semaphore.withPermit(middleOperation, middleController.signal);
    const last = semaphore.withPermit(async () => entered.push("last"));
    expect(semaphore.snapshot()).toEqual({ active: 1, queued: 2, limit: 1 });

    middleController.abort();
    await expect(middle).rejects.toMatchObject({ name: "AbortError" });
    expect(semaphore.snapshot()).toEqual({ active: 1, queued: 1, limit: 1 });
    firstGate.resolve();
    await first;
    await last;

    expect(middleOperation).not.toHaveBeenCalled();
    expect(entered).toEqual(["first", "last"]);
    expect(semaphore.snapshot()).toEqual({ active: 0, queued: 0, limit: 1 });
  });

  it("rejects pre-aborted work without acquiring a permit", async () => {
    const semaphore = new ProviderSemaphore(1);
    const controller = new AbortController();
    controller.abort();
    const operation = vi.fn(async () => "ghost");

    await expect(semaphore.withPermit(operation, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(operation).not.toHaveBeenCalled();
    expect(semaphore.snapshot()).toEqual({ active: 0, queued: 0, limit: 1 });
  });

  it("holds an in-flight permit until abort-aware work terminates, then releases it", async () => {
    const semaphore = new ProviderSemaphore(1);
    const controller = new AbortController();
    const started = deferred();
    const operation = semaphore.withPermit(
      () =>
        new Promise<never>((_resolve, reject) => {
          started.resolve();
          controller.signal.addEventListener(
            "abort",
            () => {
              const error = new Error("transport aborted");
              error.name = "AbortError";
              reject(error);
            },
            { once: true },
          );
        }),
      controller.signal,
    );
    await started.promise;
    const next = vi.fn(async () => "next");
    const queued = semaphore.withPermit(next);

    controller.abort();
    await expect(operation).rejects.toMatchObject({ name: "AbortError" });
    await expect(queued).resolves.toBe("next");
    expect(next).toHaveBeenCalledOnce();
    expect(semaphore.snapshot()).toEqual({ active: 0, queued: 0, limit: 1 });
  });

  it("does not report success when a signal aborts before an ignoring operation settles", async () => {
    const semaphore = new ProviderSemaphore(1);
    const controller = new AbortController();
    let resolve!: (value: string) => void;
    const pending = new Promise<string>((done) => {
      resolve = done;
    });
    const result = semaphore.withPermit(() => pending, controller.signal);
    await Promise.resolve();

    controller.abort();
    expect(semaphore.snapshot()).toEqual({ active: 1, queued: 0, limit: 1 });
    resolve("late-success");
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(semaphore.snapshot()).toEqual({ active: 0, queued: 0, limit: 1 });
  });
});
