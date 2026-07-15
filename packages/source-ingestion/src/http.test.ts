import { describe, expect, it, vi } from "vitest";
import {
  fetchPublicSourceText,
  PUBLIC_SOURCE_TEXT_MAX_BYTES,
  readPublicSourceText,
  withPublicSourceHttpDeadline,
} from "./http";
import type { Fetcher, FetchResponse } from "./types";

const response = (overrides: Partial<FetchResponse>): FetchResponse => ({
  url: "https://example.test/body",
  status: 200,
  ok: true,
  headers: new Headers(),
  text: async () => "",
  ...overrides,
});

describe("public-source HTTP boundaries", () => {
  it("aborts a hanging request at the shared deadline", async () => {
    let aborted = false;
    await expect(
      withPublicSourceHttpDeadline(
        "service_public",
        (signal) =>
          new Promise<never>((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              aborted = true;
              reject(new Error("aborted"));
            });
          }),
        5,
      ),
    ).rejects.toMatchObject({ name: "SourceIngestionError" });
    expect(aborted).toBe(true);
  });

  it("streams and cancels a no-length body at the first byte beyond the text limit", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(PUBLIC_SOURCE_TEXT_MAX_BYTES));
        controller.enqueue(new Uint8Array(1));
      },
      cancel() {
        cancelled = true;
      },
    });

    await expect(readPublicSourceText(response({ body }), "service_public")).rejects.toThrow(
      "exceeds its byte limit",
    );
    expect(cancelled).toBe(true);
  });

  it.each([
    ["invalid", "-1", "invalid content length"],
    ["malformed", "10garbage", "invalid content length"],
    ["excessive", String(PUBLIC_SOURCE_TEXT_MAX_BYTES + 1), "exceeds its byte limit"],
  ])("cancels a body rejected by its %s declared length", async (_label, length, message) => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });

    await expect(
      readPublicSourceText(
        response({ body, headers: new Headers({ "content-length": length }) }),
        "service_public",
      ),
    ).rejects.toThrow(message);
    expect(cancelled).toBe(true);
  });

  it("classifies a rejected response before consuming its body", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    await expect(
      fetchPublicSourceText(
        async () => response({ status: 429, ok: false, body }),
        "service_public",
        "https://example.test/body",
      ),
    ).resolves.toMatchObject({ response: { status: 429 }, body: undefined });
    expect(cancelled).toBe(true);
  });

  it("uses one cumulative deadline for the request and its streamed body", async () => {
    vi.useFakeTimers();
    try {
      let requestSignal: AbortSignal | undefined;
      let bodyCancelled = false;
      const fetcher: Fetcher = async (_url, init) => {
        requestSignal = init?.signal ?? undefined;
        await new Promise<void>((resolve) => setTimeout(resolve, 20_000));
        return response({
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              setTimeout(() => {
                controller.enqueue(new TextEncoder().encode("late body"));
                controller.close();
              }, 20_000);
            },
            cancel() {
              bodyCancelled = true;
            },
          }),
        });
      };

      const pending = fetchPublicSourceText(fetcher, "service_public", "https://example.test/body");
      const assertion = expect(pending).rejects.toThrow("timed out after 30000ms");
      await vi.advanceTimersByTimeAsync(20_000);
      await vi.advanceTimersByTimeAsync(10_001);
      await assertion;
      expect(requestSignal?.aborted).toBe(true);
      expect(bodyCancelled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for aborted reader cleanup, then fails closed at its cleanup bound", async () => {
    vi.useFakeTimers();
    try {
      let markCancellationStarted!: () => void;
      const cancellationStarted = new Promise<void>((resolve) => {
        markCancellationStarted = resolve;
      });
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("partial"));
        },
        cancel: () => {
          markCancellationStarted();
          return new Promise<void>(() => undefined);
        },
      });
      const pending = withPublicSourceHttpDeadline(
        "service_public",
        (signal) => readPublicSourceText(response({ body }), "service_public", signal),
        5,
      );
      const assertion = expect(pending).rejects.toMatchObject({ name: "SourceIngestionError" });
      await vi.advanceTimersByTimeAsync(5);
      await cancellationStarted;
      let settled = false;
      void pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await vi.advanceTimersByTimeAsync(999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed when a custom transport exposes no stream or declared length", async () => {
    await expect(
      readPublicSourceText(response({ text: async () => "unbounded fallback" }), "service_public"),
    ).rejects.toThrow("cannot be safely bounded");
  });

  it("awaits cancellation of a non-null 304 body", async () => {
    let releaseCancellation!: () => void;
    const cancellation = new Promise<void>((resolve) => {
      releaseCancellation = resolve;
    });
    const body = new ReadableStream<Uint8Array>({
      cancel: () => cancellation,
    });
    const pending = fetchPublicSourceText(
      async () => response({ status: 304, ok: false, body }),
      "service_public",
      "https://example.test/body",
    );

    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseCancellation();
    await expect(pending).resolves.toMatchObject({ response: { status: 304 }, body: undefined });
    expect(settled).toBe(true);
  });

  it("contains a rejected 304 body cancellation", async () => {
    const body = new ReadableStream<Uint8Array>({
      cancel: () => Promise.reject(new Error("cancel failed")),
    });
    await expect(
      fetchPublicSourceText(
        async () => response({ status: 304, ok: false, body }),
        "service_public",
        "https://example.test/body",
      ),
    ).resolves.toMatchObject({ response: { status: 304 }, body: undefined });
  });
});
