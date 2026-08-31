import { AiRunEvent, type AiRunEvent as AiRunEventValue } from "@hartlib/shared";
import { Schema } from "effect";

import { ApiResponseError } from "./transport";

export interface AiRunStreamFrame {
  readonly seq: number;
  readonly event: AiRunEventValue;
}

const decodeFrame = (frame: string): AiRunStreamFrame | null => {
  const lines = frame.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  let id: string | undefined;
  let eventName: string | undefined;
  const data: string[] = [];
  for (const line of lines) {
    if (line === "" || line.startsWith(":")) continue;
    const boundary = line.indexOf(":");
    const field = boundary < 0 ? line : line.slice(0, boundary);
    const raw = boundary < 0 ? "" : line.slice(boundary + 1);
    const value = raw.startsWith(" ") ? raw.slice(1) : raw;
    if (field === "id") {
      if (id !== undefined) throw new ApiResponseError(200, "invalid_sse_event");
      id = value;
    } else if (field === "event") {
      if (eventName !== undefined) throw new ApiResponseError(200, "invalid_sse_event");
      eventName = value;
    } else if (field === "data") {
      data.push(value);
    } else {
      throw new ApiResponseError(200, "invalid_sse_event");
    }
  }
  if (data.length === 0 && id === undefined && eventName === undefined) return null;
  if (id === undefined || eventName === undefined || data.length === 0 || !/^\d+$/u.test(id)) {
    throw new ApiResponseError(200, "invalid_sse_event");
  }
  const seq = Number(id);
  if (!Number.isSafeInteger(seq) || seq <= 0) throw new ApiResponseError(200, "invalid_sse_event");
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.join("\n")) as unknown;
  } catch (cause) {
    throw new ApiResponseError(200, "invalid_sse_event", undefined, { cause });
  }
  let event: AiRunEventValue;
  try {
    event = Schema.decodeUnknownSync(AiRunEvent, { onExcessProperty: "error" })(parsed);
  } catch (cause) {
    throw new ApiResponseError(200, "invalid_sse_event", undefined, { cause });
  }
  if (event.type !== eventName) throw new ApiResponseError(200, "invalid_sse_event");
  return { seq, event };
};

export async function* decodeAiRunSse(
  response: Response,
  signal?: AbortSignal,
): AsyncGenerator<AiRunStreamFrame, void> {
  if (response.body === null) throw new ApiResponseError(response.status, "invalid_sse_body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const decodeUtf8 = (bytes?: Uint8Array, options?: TextDecodeOptions): string => {
    try {
      return decoder.decode(bytes, options);
    } catch (cause) {
      throw new ApiResponseError(200, "invalid_sse_event", undefined, { cause });
    }
  };
  let buffer = "";
  let completed = false;
  let reachedEof = false;
  let abortCancellation: Promise<void> | undefined;
  const onAbort = () => {
    abortCancellation ??= reader.cancel("stream_aborted").catch(() => undefined);
  };
  const normalizeNewlines = (value: string, final: boolean): string => {
    const preservesTrailingCarriageReturn = !final && value.endsWith("\r");
    const body = preservesTrailingCarriageReturn ? value.slice(0, -1) : value;
    const normalized = body.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
    return preservesTrailingCarriageReturn ? `${normalized}\r` : normalized;
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  try {
    while (!signal?.aborted) {
      const chunk = await reader.read();
      if (chunk.done) {
        reachedEof = true;
        break;
      }
      if (signal?.aborted) return;
      buffer = normalizeNewlines(buffer + decodeUtf8(chunk.value, { stream: true }), false);
      for (;;) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary < 0) break;
        const frame = decodeFrame(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        if (frame !== null) yield frame;
      }
    }
    if (signal?.aborted) return;
    buffer = normalizeNewlines(buffer + decodeUtf8(), true);
    if (!signal?.aborted && buffer.trim() !== "") {
      const frame = decodeFrame(buffer);
      if (frame !== null) yield frame;
    }
    completed = reachedEof;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (!completed) {
      try {
        await (abortCancellation ?? reader.cancel("stream_consumer_closed"));
      } catch {
        // Server-side terminal close can race with consumer cancellation.
      }
    }
    reader.releaseLock();
  }
}
