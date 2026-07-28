import {
  aiRunActivityKey,
  type ActiveAiRunConflict,
  type AiRunEvent,
  type GetChatResponse,
  type PublicSourceRecord,
  type SendChatMessageRequest,
} from "@brief/shared";
import { ApiResponseError } from "@brief/api-client";
import type { PersistedRunStreamState } from "@brief/api-client/stream";

export type ChatStreamPhase = "idle" | "preparing" | "answering" | "done" | "error";
export type ChatStreamEvent = AiRunEvent;

export type UserScopedConflict = {
  readonly runId: string;
  readonly request: SendChatMessageRequest;
  /** User-message IDs present before the ambiguous POST was retried. */
  readonly knownMessageIds?: readonly string[];
};

export const userConflictRetryDelayMs = 1_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const asActiveAiRunConflict = (value: unknown): ActiveAiRunConflict | null => {
  if (!isRecord(value)) return null;
  const activeRun = value.activeRun;
  if (
    value.code !== "active_ai_run" ||
    (value.conflictScope !== "chat" && value.conflictScope !== "user") ||
    !isRecord(activeRun) ||
    typeof activeRun.id !== "string" ||
    (activeRun.status !== "queued" && activeRun.status !== "running") ||
    typeof activeRun.streamPath !== "string"
  ) {
    return null;
  }
  return value as ActiveAiRunConflict;
};

const conflictFromCause = (cause: unknown): ActiveAiRunConflict | null =>
  cause instanceof ApiResponseError && cause.status === 409
    ? asActiveAiRunConflict(cause.body)
    : null;

const waitForRetry = (delayMs: number, signal: AbortSignal): Promise<boolean> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolve(result);
    };
    const abort = () => finish(false);
    const timer = setTimeout(() => finish(true), delayMs);
    signal.addEventListener("abort", abort, { once: true });
  });

/**
 * Replays one rejected user-scoped send until the API accepts it or a
 * different/ambiguous outcome requires the UI to stop. A confirmed 409 is
 * the only retryable result: it proves the exact POST was not accepted.
 */
export const reconcileUserScopedConflict = async <Accepted>(options: {
  readonly conflict: UserScopedConflict;
  readonly signal: AbortSignal;
  readonly send: (request: SendChatMessageRequest) => Promise<Accepted>;
  readonly onAccepted: (response: Accepted) => void | Promise<void>;
  readonly onStillActive: (conflict: ActiveAiRunConflict) => void;
  readonly onChatConflict: (conflict: ActiveAiRunConflict) => void | Promise<void>;
  readonly onStopped: (cause: unknown) => void | Promise<void>;
  readonly delayMs?: number;
}): Promise<void> => {
  const delayMs = options.delayMs ?? userConflictRetryDelayMs;
  while (await waitForRetry(delayMs, options.signal)) {
    let response: Accepted;
    try {
      response = await options.send(options.conflict.request);
    } catch (cause) {
      if (options.signal.aborted) return;
      const conflict = conflictFromCause(cause);
      if (conflict?.conflictScope === "user") {
        options.onStillActive(conflict);
        continue;
      }
      if (conflict?.conflictScope === "chat") {
        await options.onChatConflict(conflict);
        return;
      }
      await options.onStopped(cause);
      return;
    }
    if (options.signal.aborted) return;
    await options.onAccepted(response);
    return;
  }
};

export type ChatStreamInput = {
  readonly seq: number;
  readonly event: ChatStreamEvent;
};

export type ChatStreamState = {
  readonly phase: ChatStreamPhase;
  readonly assistantText: string;
  readonly seq: number;
  readonly attempt: number;
  readonly mode: "clarification" | "single" | "synthesis" | null;
  readonly sourcesRead: readonly PublicSourceRecord[];
  readonly activities: readonly Extract<AiRunEvent, { readonly type: "activity" }>[];
  readonly memoryUpdated: {
    readonly created: number;
    readonly updated: number;
    readonly discarded: number;
  } | null;
  readonly error: { readonly code: string; readonly retryable: boolean } | null;
};

export const initialChatStreamState: ChatStreamState = {
  phase: "idle",
  assistantText: "",
  seq: 0,
  attempt: 0,
  mode: null,
  sourcesRead: [],
  activities: [],
  memoryUpdated: null,
  error: null,
};

/** A terminal run is no longer replayable once its SSE event has aged out. */
export const isTerminalEventUnavailable = (cause: unknown): boolean =>
  cause instanceof ApiResponseError &&
  cause.status === 410 &&
  cause.code === "terminal_event_unavailable";

/** Definitive SSE handshake failures cannot recover by replaying a cursor. */
export const isDefinitiveStreamHandshakeFailure = (cause: unknown): boolean =>
  cause instanceof ApiResponseError &&
  (cause.status === 401 || cause.status === 403 || cause.status === 404);

export const streamReconnectAction = (cause: unknown): "reconcile" | "retry" =>
  isTerminalEventUnavailable(cause) || isDefinitiveStreamHandshakeFailure(cause)
    ? "reconcile"
    : "retry";

/** A send rejection proves the cached web toggle is stale. */
export const isWebResearchUnavailable = (cause: unknown): boolean =>
  cause instanceof ApiResponseError &&
  cause.status === 403 &&
  cause.code === "web_research_unavailable";

export type AmbiguousConflictResolution =
  | { readonly action: "attach"; readonly runId: string }
  | { readonly action: "clear" };

type ChatUserMessage = Extract<GetChatResponse["messages"][number], { readonly author: "user" }>;

/**
 * Reconcile a POST whose transport outcome is unknown using the authoritative
 * chat projection. A newly persisted matching user message proves acceptance;
 * otherwise the request can be released without automatically replaying it.
 */
export const resolveAmbiguousUserScopedConflict = (
  conflict: UserScopedConflict,
  chat: Pick<GetChatResponse, "messages" | "activeRun">,
): AmbiguousConflictResolution => {
  if (chat.activeRun !== null) return { action: "attach", runId: chat.activeRun.id };
  const known = conflict.knownMessageIds === undefined ? null : new Set(conflict.knownMessageIds);
  const matched = [...chat.messages]
    .reverse()
    .find(
      (message): message is ChatUserMessage =>
        message.author === "user" &&
        message.content === conflict.request.text.trim() &&
        (known === null || !known.has(message.id)),
    );
  if (
    matched !== undefined &&
    (matched.run.status === "queued" || matched.run.status === "running")
  ) {
    return { action: "attach", runId: matched.run.id };
  }
  return { action: "clear" };
};

export const restoreChatStreamState = (
  persisted: PersistedRunStreamState | null,
): ChatStreamState => {
  if (persisted === null) return initialChatStreamState;
  const terminalFailure = persisted.draft.terminalFailure;
  return {
    ...initialChatStreamState,
    phase:
      terminalFailure !== null ? "error" : persisted.draft.text === "" ? "preparing" : "answering",
    assistantText: terminalFailure === null ? persisted.draft.text : "",
    seq: persisted.lastSeq,
    attempt: persisted.draft.attempt,
    sourcesRead: persisted.draft.sourcesRead,
    activities: persisted.draft.activities,
    error: terminalFailure,
  };
};

const assertNever = (value: never): never => {
  throw new Error(`Unhandled chat stream event: ${JSON.stringify(value)}`);
};

export function reduceChatStream(state: ChatStreamState, input: ChatStreamInput): ChatStreamState {
  if (input.seq <= state.seq) return state;
  const base = { ...state, seq: input.seq };

  switch (input.event.type) {
    case "run_started":
      return { ...base, phase: "preparing", error: null };
    case "activity": {
      const key = aiRunActivityKey(input.event.code, input.event.topicId);
      const activities = [...state.activities];
      const index = activities.findIndex(
        (activity) => aiRunActivityKey(activity.code, activity.topicId) === key,
      );
      if (index === -1) activities.push(input.event);
      else activities[index] = input.event;
      return {
        ...base,
        phase: state.phase === "idle" ? "preparing" : state.phase,
        activities,
        error: null,
      };
    }
    case "context_ready":
      return {
        ...base,
        phase: "preparing",
        mode: input.event.mode,
        sourcesRead: input.event.sourcesRead,
      };
    case "answer_started":
      return {
        ...base,
        phase: "answering",
        mode: input.event.mode,
        attempt: Math.max(state.attempt, input.event.attempt),
        assistantText: input.event.attempt > state.attempt ? "" : state.assistantText,
        error: null,
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
    case "error": {
      const activities = [...state.activities];
      for (let index = activities.length - 1; index >= 0; index -= 1) {
        const activity = activities[index];
        if (activity?.status === "running" || activity?.status === "retrying") {
          activities[index] = { ...activity, status: "failed" };
          break;
        }
      }
      return {
        ...base,
        phase: "error",
        assistantText: "",
        sourcesRead: [],
        activities,
        error: { code: input.event.code, retryable: input.event.retryable },
      };
    }
  }

  return assertNever(input.event);
}
