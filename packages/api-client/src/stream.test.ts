import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  decodeAiRunSse,
  decodeStoredJson,
  persistRunStreamState,
  restoreRunStreamState,
  runStreamStorageKey,
} from "./stream";

const streamResponse = (chunks: readonly string[]): Response => {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
};

const collect = async (response: Response, signal?: AbortSignal) => {
  const frames = [];
  for await (const frame of decodeAiRunSse(response, signal)) frames.push(frame);
  return frames;
};

const byteStreamResponse = (
  chunks: readonly Uint8Array[],
  onCancel?: (reason: unknown) => void,
  close = false,
): Response =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        if (close) controller.close();
      },
      cancel(reason) {
        onCancel?.(reason);
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );

describe("AI run SSE trust boundary", () => {
  it("decodes fragmented canonical frames and preserves durable sequence ids", async () => {
    await expect(
      collect(
        streamResponse([
          'id: 1\r\nevent: run_started\r\ndata: {"type":"run_',
          'started"}\r',
          '\n\r\nid: 2\nevent: text_delta\ndata: {"type":"text_delta","delta":"ok"}\n\n',
        ]),
      ),
    ).resolves.toEqual([
      { seq: 1, event: { type: "run_started" } },
      { seq: 2, event: { type: "text_delta", delta: "ok" } },
    ]);
  });

  it("rejects mismatched event names, malformed ids, and excess payload fields", async () => {
    const invalid = [
      'id: 1\nevent: done\ndata: {"type":"run_started"}\n\n',
      'id: 1x\nevent: run_started\ndata: {"type":"run_started"}\n\n',
      'id: 1\nevent: run_started\ndata: {"type":"run_started","extra":true}\n\n',
      'id: 1\nevent: run_started\nunknown: value\ndata: {"type":"run_started"}\n\n',
    ];
    for (const frame of invalid) {
      await expect(collect(streamResponse([frame]))).rejects.toMatchObject({
        code: "invalid_sse_event",
      });
    }
  });

  it("fails closed on malformed UTF-8 split across chunks and cancels the reader", async () => {
    let cancelled: unknown;
    const encoder = new TextEncoder();
    const response = byteStreamResponse(
      [
        new Uint8Array([
          ...encoder.encode('id: 1\nevent: text_delta\ndata: {"type":"text_delta","delta":"'),
          0xe2,
        ]),
        new Uint8Array([0x28, ...encoder.encode('"}\n\n')]),
      ],
      (reason) => {
        cancelled = reason;
      },
    );
    await expect(collect(response)).rejects.toMatchObject({ code: "invalid_sse_event" });
    expect(cancelled).toBe("stream_consumer_closed");
  });

  it("translates an incomplete UTF-8 sequence at EOF to invalid_sse_event", async () => {
    const response = byteStreamResponse([new Uint8Array([0xe2])], undefined, true);
    await expect(collect(response)).rejects.toMatchObject({ code: "invalid_sse_event" });
  });

  it("cancels and releases the reader when the consumer closes cleanly", async () => {
    let cancelled: unknown;
    const response = byteStreamResponse(
      [new TextEncoder().encode('id: 1\nevent: run_started\ndata: {"type":"run_started"}\n\n')],
      (reason) => {
        cancelled = reason;
      },
    );
    const iterator = decodeAiRunSse(response);
    await expect(iterator.next()).resolves.toMatchObject({ done: false, value: { seq: 1 } });
    await iterator.return();
    expect(cancelled).toBe("stream_consumer_closed");
    expect(response.body!.locked).toBe(false);
  });

  it("aborts incomplete UTF-8 without reporting malformed SSE and releases the reader", async () => {
    let cancelled: unknown;
    const controller = new AbortController();
    const response = byteStreamResponse([new Uint8Array([0xe2])], (reason) => {
      cancelled = reason;
    });
    const pending = collect(response, controller.signal);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await expect(pending).resolves.toEqual([]);
    expect(cancelled).toBe("stream_aborted");
    expect(response.body!.locked).toBe(false);
  });
});

describe("reload and generic storage codecs", () => {
  it("restores only exact versioned stream state", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    persistRunStreamState(storage, {
      version: 2,
      runId: "run-1",
      lastSeq: 7,
      draft: {
        runId: "run-1",
        text: "partial",
        attempt: 2,
        sourcesRead: [],
        activities: [],
        terminalFailure: null,
      },
    });
    expect(restoreRunStreamState(storage, "run-1")).toMatchObject({ lastSeq: 7 });

    values.set(
      runStreamStorageKey("run-1"),
      JSON.stringify({
        version: 1,
        runId: "run-1",
        lastSeq: 7,
        draft: { runId: "run-1", text: "partial", attempt: 2, sourcesRead: [], extra: true },
      }),
    );
    expect(restoreRunStreamState(storage, "run-1")).toBeNull();
  });

  it("returns a safe fallback signal for corrupt or excess generic JSON", () => {
    const schema = Schema.Struct({ value: Schema.String });
    expect(decodeStoredJson(schema, "not-json")).toBeUndefined();
    expect(decodeStoredJson(schema, JSON.stringify({ value: "ok", extra: true }))).toBeUndefined();
    expect(decodeStoredJson(schema, JSON.stringify({ value: "ok" }))).toEqual({ value: "ok" });
  });
});
