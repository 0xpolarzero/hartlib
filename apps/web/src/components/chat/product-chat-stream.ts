import {
  clearRunStreamState,
  persistRunStreamState,
  restoreRunStreamState,
  runStreamStorageKey,
  type PersistedRunStreamState,
  type StreamDraftState,
} from "@brief/api-client/stream";
import { ApiResponseError } from "@brief/api-client";
import type {
  ActiveAiRunConflict,
  AiRunEvent,
  GetChatResponse,
  SendChatMessageRequest,
} from "@brief/shared";
import { aiRunActivityKey } from "@brief/shared";

export { clearRunStreamState, persistRunStreamState, restoreRunStreamState, runStreamStorageKey };
export type { PersistedRunStreamState, StreamDraftState };

export const isTerminalEventUnavailable = (cause: unknown): boolean =>
  cause instanceof ApiResponseError &&
  cause.status === 410 &&
  cause.code === "terminal_event_unavailable";

/**
 * A stream handshake is definitive when the current viewer can no longer
 * attach to the run. Retrying one of these cursors only repeats an
 * unauthorized or missing-run request and can never recover the provisional
 * transcript.
 */
export const isDefinitiveStreamHandshakeFailure = (cause: unknown): boolean =>
  cause instanceof ApiResponseError &&
  (cause.status === 401 || cause.status === 403 || cause.status === 404);

export const streamFailureAction = (cause: unknown): "terminate" | "retry" =>
  isTerminalEventUnavailable(cause) || isDefinitiveStreamHandshakeFailure(cause)
    ? "terminate"
    : "retry";

/** A typed send rejection means the cached web toggle is stale. */
export const isWebResearchUnavailable = (cause: unknown): boolean =>
  cause instanceof ApiResponseError &&
  cause.status === 403 &&
  cause.code === "web_research_unavailable";

export type UserScopedConflict = {
  /** Route identity of the request that received the user-scoped conflict. */
  readonly chatId: string;
  readonly runId: string;
  readonly request: SendChatMessageRequest;
  /** User-message IDs present before the rejected request was retried. */
  readonly knownMessageIds?: readonly string[];
};

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

export const userConflictRetryDelayMs = 1_000;

/** A late reload may update the page only while its generation is current. */
export const shouldApplyChatReload = (
  requestGeneration: number,
  currentGeneration: number,
  preserveRunId: string | undefined,
  activeRunId: string | null,
): boolean =>
  requestGeneration === currentGeneration &&
  (preserveRunId === undefined || activeRunId === preserveRunId);

/**
 * Replays a request only after a typed user-scoped 409 proves that the
 * original POST was not accepted. Any ambiguous failure stops the loop.
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

export type AmbiguousConflictResolution =
  | { readonly action: "attach"; readonly runId: string }
  | { readonly action: "clear" };

type ChatUserMessage = Extract<GetChatResponse["messages"][number], { readonly author: "user" }>;

/** Reconcile an uncertain request from an authoritative chat projection. */
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

export interface ReducedRunStreamState {
  readonly applied: boolean;
  readonly terminal: boolean;
  readonly lastSeq: number;
  readonly draft: StreamDraftState | null;
}
export const emptyStreamDraft = (runId: string): StreamDraftState => ({
  runId,
  text: "",
  attempt: 0,
  sourcesRead: [],
  activities: [],
  terminalFailure: null,
});

export const reduceRunStreamEvent = (
  runId: string,
  lastSeq: number,
  draft: StreamDraftState,
  seq: number,
  event: AiRunEvent,
): ReducedRunStreamState => {
  if (!Number.isSafeInteger(seq) || seq <= lastSeq) {
    return { applied: false, terminal: false, lastSeq, draft };
  }
  if (event.type === "done") {
    return { applied: true, terminal: true, lastSeq: seq, draft: null };
  }
  if (event.type === "error") {
    const activities = [...draft.activities];
    for (let index = activities.length - 1; index >= 0; index -= 1) {
      const activity = activities[index];
      if (activity?.status === "running" || activity?.status === "retrying") {
        activities[index] = { ...activity, status: "failed" };
        break;
      }
    }
    return {
      applied: true,
      terminal: true,
      lastSeq: seq,
      draft: {
        ...draft,
        text: "",
        activities,
        terminalFailure: { code: event.code, retryable: event.retryable },
      },
    };
  }
  if (event.type === "activity") {
    const key = aiRunActivityKey(event.code, event.topicId);
    const activities = [...draft.activities];
    const index = activities.findIndex(
      (activity) => aiRunActivityKey(activity.code, activity.topicId) === key,
    );
    if (index === -1) activities.push(event);
    else activities[index] = event;
    return {
      applied: true,
      terminal: false,
      lastSeq: seq,
      draft: { ...draft, activities, terminalFailure: null },
    };
  }
  if (event.type === "context_ready") {
    return {
      applied: true,
      terminal: false,
      lastSeq: seq,
      draft: { ...draft, sourcesRead: event.sourcesRead },
    };
  }
  if (event.type === "answer_started") {
    return {
      applied: true,
      terminal: false,
      lastSeq: seq,
      draft: {
        ...draft,
        runId,
        text: event.attempt > draft.attempt ? "" : draft.text,
        attempt: event.attempt,
        terminalFailure: null,
      },
    };
  }
  if (event.type === "text_delta") {
    return {
      applied: true,
      terminal: false,
      lastSeq: seq,
      draft: { ...draft, text: draft.text + event.delta },
    };
  }
  return { applied: true, terminal: false, lastSeq: seq, draft };
};

const reconnectDelaysMs = [250, 500, 1_000, 2_000, 4_000] as const;

export const reconnectDelayMs = (failureCount: number): number =>
  reconnectDelaysMs[Math.min(Math.max(0, failureCount), reconnectDelaysMs.length - 1)]!;
