import {
  AiRunActivityEvent,
  AiRunEvent,
  PublicContextConsumer,
  PublicSourceRecord,
  type AiRunActivityEvent as AiRunActivityEventValue,
  type AiRunEvent as AiRunEventValue,
} from "@brief/shared";
import { Schema } from "effect";

import { ApiResponseError } from "./transport";

export interface AiRunStreamFrame {
  readonly seq: number;
  readonly event: AiRunEventValue;
}

const decodeFrame = (frame: string): AiRunStreamFrame | null => {
  const lines = frame.replaceAll("\r\n", "\n").split("\n");
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
  if (!Number.isSafeInteger(seq) || seq <= 0) {
    throw new ApiResponseError(200, "invalid_sse_event");
  }
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
        // Cancellation can race with a server-side terminal close.
      }
    }
    reader.releaseLock();
  }
}

export interface StreamDraftState {
  readonly runId: string;
  readonly text: string;
  readonly attempt: number;
  readonly sourcesRead: readonly Schema.Schema.Type<typeof PublicSourceRecord>[];
  readonly activities: readonly AiRunActivityEventValue[];
  readonly activityHistory: readonly AiRunActivityEventValue[];
  readonly context: {
    readonly compactionRan: boolean;
    readonly consumers: readonly Schema.Schema.Type<typeof PublicContextConsumer>[];
  } | null;
  readonly memoryUpdated: {
    readonly created: number;
    readonly updated: number;
    readonly discarded: number;
  } | null;
  readonly terminalFailure: { readonly code: string; readonly retryable: boolean } | null;
}

export interface PersistedRunStreamState {
  readonly version: 4;
  readonly runId: string;
  readonly lastSeq: number;
  readonly draft: StreamDraftState;
}

const NonNegativeInteger = Schema.Number.pipe(
  Schema.check(Schema.isInt()),
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
);
const StreamDraft = Schema.Struct({
  runId: Schema.String,
  text: Schema.String,
  attempt: NonNegativeInteger,
  sourcesRead: Schema.Array(PublicSourceRecord),
  activities: Schema.Array(AiRunActivityEvent),
  activityHistory: Schema.Array(AiRunActivityEvent),
  context: Schema.NullOr(
    Schema.Struct({
      compactionRan: Schema.Boolean,
      consumers: Schema.Array(PublicContextConsumer),
    }),
  ),
  memoryUpdated: Schema.NullOr(
    Schema.Struct({
      created: NonNegativeInteger,
      updated: NonNegativeInteger,
      discarded: NonNegativeInteger,
    }),
  ),
  terminalFailure: Schema.NullOr(Schema.Struct({ code: Schema.String, retryable: Schema.Boolean })),
});
const PersistedRunStream = Schema.Struct({
  version: Schema.Literal(4),
  runId: Schema.String,
  lastSeq: NonNegativeInteger,
  draft: StreamDraft,
});

export const runStreamStorageKey = (runId: string): string => `brief:web:ai-run-stream:${runId}`;

export const restoreRunStreamState = (
  storage: Pick<Storage, "getItem">,
  runId: string,
): PersistedRunStreamState | null => {
  try {
    const raw = storage.getItem(runStreamStorageKey(runId));
    if (raw === null) return null;
    const value = Schema.decodeUnknownSync(PersistedRunStream, { onExcessProperty: "error" })(
      JSON.parse(raw) as unknown,
    );
    return value.runId === runId && value.draft.runId === runId ? value : null;
  } catch {
    return null;
  }
};

export const persistRunStreamState = (
  storage: Pick<Storage, "setItem">,
  state: PersistedRunStreamState,
): void => {
  try {
    const value = Schema.decodeUnknownSync(PersistedRunStream, { onExcessProperty: "error" })(
      state,
    );
    storage.setItem(runStreamStorageKey(value.runId), JSON.stringify(value));
  } catch {
    // Streaming remains functional when state is invalid or storage is unavailable.
  }
};

export const clearRunStreamState = (storage: Pick<Storage, "removeItem">, runId: string): void => {
  try {
    storage.removeItem(runStreamStorageKey(runId));
  } catch {
    // Best-effort browser-only provisional state cleanup.
  }
};

export const decodeStoredJson = <A, I>(
  schema: Schema.Codec<A, I, never, never>,
  raw: string | null,
): A | undefined => {
  if (raw === null) return undefined;
  try {
    return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(
      JSON.parse(raw) as unknown,
    );
  } catch {
    return undefined;
  }
};
