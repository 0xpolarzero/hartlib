import { taskAbortError, throwIfAborted } from "./task-cancellation";

export const WORKER_PROVIDER_MAX_CONCURRENCY = 8;

type Waiter = {
  readonly resolve: (release: () => void) => void;
  readonly reject: (error: Error) => void;
  readonly signal: AbortSignal | undefined;
  readonly removeAbortListener: () => void;
};

/** FIFO worker-lifetime permit pool shared by every run and request class. */
export class ProviderSemaphore {
  private active = 0;
  private readonly waiters: Waiter[] = [];

  constructor(readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error("provider semaphore limit must be a positive safe integer");
    }
  }

  private acquire(signal?: AbortSignal): Promise<() => void> {
    throwIfAborted(signal);
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(this.releaseOnce());
    }
    return new Promise((resolve, reject) => {
      let waiter: Waiter;
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index === -1) return;
        this.waiters.splice(index, 1);
        waiter.removeAbortListener();
        reject(taskAbortError());
      };
      const removeAbortListener = () => signal?.removeEventListener("abort", onAbort);
      waiter = { resolve, reject, signal, removeAbortListener };
      this.waiters.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
      // Abort dispatch is synchronous, but recheck for implementations that
      // changed state immediately before the listener was registered.
      if (signal?.aborted) onAbort();
    });
  }

  private releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      while (true) {
        const next = this.waiters.shift();
        if (next === undefined) {
          this.active -= 1;
          return;
        }
        next.removeAbortListener();
        if (next.signal?.aborted) {
          next.reject(taskAbortError());
          continue;
        }
        next.resolve(this.releaseOnce());
        return;
      }
    };
  }

  async withPermit<A>(operation: () => Promise<A>, signal?: AbortSignal): Promise<A> {
    const release = await this.acquire(signal);
    try {
      throwIfAborted(signal);
      const result = await operation();
      throwIfAborted(signal);
      return result;
    } finally {
      release();
    }
  }

  snapshot(): { readonly active: number; readonly queued: number; readonly limit: number } {
    return { active: this.active, queued: this.waiters.length, limit: this.limit };
  }
}

export const workerProviderSemaphore = new ProviderSemaphore(WORKER_PROVIDER_MAX_CONCURRENCY);
