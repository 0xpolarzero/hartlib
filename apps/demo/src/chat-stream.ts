import { ApiResponseError } from "@hartlib/api-client";
import type { AiRunEvent, PublicSourceRecord } from "@hartlib/shared";
import { failActiveAiRunActivity, projectAiRunActivity } from "@hartlib/shared";
import {
  DEMO_STORAGE_KEYS,
  readDemoStorage,
  removeDemoStorage,
  writeDemoStorage,
} from "./storage-registry";

export type ChatStreamPhase = "idle" | "preparing" | "answering" | "done" | "stopped" | "error";
export type ChatStreamEvent = AiRunEvent;
export interface ChatStreamState {
  readonly phase: ChatStreamPhase;
  readonly assistantText: string;
  readonly seq: number;
  readonly attempt: number;
  readonly mode: "clarification" | "single" | "synthesis" | null;
  readonly sourcesRead: readonly PublicSourceRecord[];
  readonly activities: readonly Extract<AiRunEvent, { readonly type: "activity" }>[];
  readonly activityHistory: readonly Extract<AiRunEvent, { readonly type: "activity" }>[];
  readonly context: {
    readonly compactionRan: boolean;
    readonly consumers: Extract<AiRunEvent, { readonly type: "context_ready" }>["consumers"];
  } | null;
  readonly memoryUpdated: {
    readonly created: number;
    readonly updated: number;
    readonly discarded: number;
  } | null;
  readonly error: {
    readonly code: string;
    readonly retryable: boolean;
    readonly runId?: string;
    readonly stage?: string;
    readonly attempt?: number;
    readonly occurredAt?: string;
    readonly errorCategory?: string;
    readonly errorMessage?: string;
  } | null;
  readonly stoppedAt: string | null;
}
export const initialChatStreamState: ChatStreamState = {
  phase: "idle",
  assistantText: "",
  seq: 0,
  attempt: 0,
  mode: null,
  sourcesRead: [],
  activities: [],
  activityHistory: [],
  context: null,
  memoryUpdated: null,
  error: null,
  stoppedAt: null,
};

export type ChatStreamInput = { readonly seq: number; readonly event: ChatStreamEvent };
export function reduceChatStream(state: ChatStreamState, input: ChatStreamInput): ChatStreamState {
  if (
    !Number.isSafeInteger(input.seq) ||
    input.seq <= state.seq ||
    state.phase === "done" ||
    state.phase === "stopped" ||
    state.phase === "error"
  )
    return state;
  const base = { ...state, seq: input.seq };
  switch (input.event.type) {
    case "run_started":
      return { ...base, phase: "preparing", error: null, stoppedAt: null };
    case "activity": {
      const projection = projectAiRunActivity(
        { activities: state.activities, history: state.activityHistory },
        input.event,
      );
      return {
        ...base,
        phase: state.phase === "idle" ? "preparing" : state.phase,
        activities: projection.activities,
        activityHistory: projection.history,
        error: null,
      };
    }
    case "context_ready":
      return {
        ...base,
        phase: "preparing",
        mode: input.event.mode,
        sourcesRead: input.event.sourcesRead,
        context: { compactionRan: input.event.compactionRan, consumers: input.event.consumers },
      };
    case "answer_started":
      return {
        ...base,
        phase: "answering",
        mode: input.event.mode,
        attempt: Math.max(state.attempt, input.event.attempt),
        assistantText: input.event.attempt > state.attempt ? "" : state.assistantText,
        error: null,
        stoppedAt: null,
      };
    case "text_delta":
      return {
        ...base,
        phase: "answering",
        assistantText: state.assistantText + input.event.delta,
      };
    case "memory_updated":
      return {
        ...base,
        memoryUpdated: {
          created: input.event.created,
          updated: input.event.updated,
          discarded: input.event.discarded,
        },
      };
    case "usage":
      return base;
    case "done":
      return { ...base, phase: "done" };
    case "stopped":
      return { ...base, phase: "stopped", stoppedAt: new Date().toISOString() };
    case "error": {
      const projection = failActiveAiRunActivity({
        activities: state.activities,
        history: state.activityHistory,
      });
      return {
        ...base,
        phase: "error",
        assistantText: "",
        sourcesRead: [],
        activities: projection.activities,
        activityHistory: projection.history,
        error: {
          code: input.event.code,
          retryable: input.event.retryable,
          ...(input.event.runId === undefined ? {} : { runId: input.event.runId }),
          ...(input.event.stage === undefined ? {} : { stage: input.event.stage }),
          ...(input.event.attempt === undefined ? {} : { attempt: input.event.attempt }),
          ...(input.event.occurredAt === undefined ? {} : { occurredAt: input.event.occurredAt }),
          ...(input.event.errorCategory === undefined
            ? {}
            : { errorCategory: input.event.errorCategory }),
          ...(input.event.errorMessage === undefined
            ? {}
            : { errorMessage: input.event.errorMessage }),
        },
      };
    }
  }
}

export const isTerminalEventUnavailable = (cause: unknown): boolean =>
  cause instanceof ApiResponseError &&
  cause.status === 410 &&
  cause.code === "terminal_event_unavailable";
export const isDefinitiveStreamHandshakeFailure = (cause: unknown): boolean =>
  cause instanceof ApiResponseError &&
  (cause.status === 401 || cause.status === 403 || cause.status === 404);
export const streamReconnectAction = (cause: unknown): "reconcile" | "retry" =>
  isTerminalEventUnavailable(cause) || isDefinitiveStreamHandshakeFailure(cause)
    ? "reconcile"
    : "retry";
export const streamStorageKey = (runId: string): string =>
  `${DEMO_STORAGE_KEYS.streamPrefix}${runId}`;
export const serializeChatStreamState = (state: ChatStreamState): string =>
  JSON.stringify({ schemaVersion: 5, state });
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isRestorableStreamState = (
  value: Record<string, unknown>,
): value is Partial<ChatStreamState> => {
  const phases: readonly ChatStreamPhase[] = [
    "idle",
    "preparing",
    "answering",
    "done",
    "stopped",
    "error",
  ];
  const modes = ["clarification", "single", "synthesis", null] as const;
  return (
    phases.includes(value.phase as ChatStreamPhase) &&
    typeof value.assistantText === "string" &&
    Number.isSafeInteger(value.seq) &&
    Number(value.seq) >= 0 &&
    Number.isSafeInteger(value.attempt) &&
    Number(value.attempt) >= 0 &&
    modes.includes(value.mode as (typeof modes)[number]) &&
    Array.isArray(value.sourcesRead) &&
    Array.isArray(value.activities) &&
    Array.isArray(value.activityHistory) &&
    (value.context === null || record(value.context)) &&
    (value.memoryUpdated === null || record(value.memoryUpdated)) &&
    (value.error === null || record(value.error)) &&
    (value.stoppedAt === null || typeof value.stoppedAt === "string")
  );
};
export const restoreChatStreamState = (runId: string): ChatStreamState => {
  const key = streamStorageKey(runId);
  const raw = readDemoStorage("session", key);
  if (!raw) return initialChatStreamState;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      !record(parsed) ||
      parsed.schemaVersion !== 5 ||
      !record(parsed.state) ||
      !isRestorableStreamState(parsed.state)
    ) {
      removeDemoStorage("session", key);
      return initialChatStreamState;
    }
    return { ...initialChatStreamState, ...parsed.state } as ChatStreamState;
  } catch {
    removeDemoStorage("session", key);
    return initialChatStreamState;
  }
};
export const persistChatStreamState = (runId: string, state: ChatStreamState): void => {
  writeDemoStorage("session", streamStorageKey(runId), serializeChatStreamState(state));
};
export const clearChatStreamState = (runId: string): void => {
  removeDemoStorage("session", streamStorageKey(runId));
};
