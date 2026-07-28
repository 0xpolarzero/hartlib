import type { ResetProductChatResponse, GetChatResponse } from "@brief/shared";

/** The cursor that must survive a failed reset so the old stream can resume. */
export type ChatResetCursor = {
  readonly runId: string;
  readonly lastSeq: number;
};

export type ChatResetPhase = "idle" | "pending";

export interface ChatResetSnapshot<Route = unknown> {
  readonly projection: GetChatResponse;
  readonly draft: string;
  readonly activeRunId: string | null;
  readonly streamGeneration: number;
  readonly cursor: ChatResetCursor | null;
  readonly route: Route;
}

export interface ChatResetState<Route = unknown> extends ChatResetSnapshot<Route> {
  readonly phase: ChatResetPhase;
  readonly generation: number;
  readonly pending: {
    readonly chatId: string;
    readonly replacementChatId: string;
    readonly generation: number;
  } | null;
  readonly rollback: ChatResetSnapshot<Route> | null;
  readonly retry: {
    readonly chatId: string;
    readonly replacementChatId: string;
  } | null;
  readonly error: unknown | null;
}

export type ChatResetAction<Route = unknown> =
  | {
      readonly type: "hydrate";
      readonly projection: GetChatResponse;
      readonly activeRunId: string | null;
      readonly streamGeneration: number;
      readonly cursor: ChatResetCursor | null;
      readonly route: Route;
    }
  | {
      readonly type: "draft";
      readonly draft: string;
    }
  | {
      readonly type: "start";
      readonly chatId: string;
      readonly replacementChatId: string;
      readonly route: Route;
    }
  | {
      readonly type: "success";
      readonly generation: number;
      readonly response: ResetProductChatResponse;
    }
  | {
      readonly type: "conflict";
      readonly generation: number;
      readonly response: ResetProductChatResponse;
    }
  | {
      readonly type: "failure";
      readonly generation: number;
      readonly error: unknown;
    }
  | {
      readonly type: "late_projection";
      readonly generation: number;
      readonly projection: GetChatResponse;
      readonly activeRunId: string | null;
    }
  | {
      readonly type: "late_stream";
      readonly generation: number;
      readonly streamGeneration: number;
      readonly cursor: ChatResetCursor | null;
    };

const optimisticProjection = (projection: GetChatResponse, replacementChatId: string) => ({
  ...projection,
  chat: {
    ...projection.chat,
    id: replacementChatId,
  },
  messages: [],
  activeRun: null,
  canWrite: false,
});

export const initialChatResetState = <Route>(
  snapshot: ChatResetSnapshot<Route>,
): ChatResetState<Route> => ({
  ...snapshot,
  phase: "idle",
  generation: 0,
  pending: null,
  rollback: null,
  retry: null,
  error: null,
});

/**
 * The reset state machine has one identity: the replacement UUID. Every
 * action that comes from the network carries the generation minted by start,
 * so an old GET or SSE event cannot publish into the optimistic replacement.
 */
export const chatResetReducer = <Route>(
  state: ChatResetState<Route>,
  action: ChatResetAction<Route>,
): ChatResetState<Route> => {
  switch (action.type) {
    case "hydrate":
      if (state.phase === "pending") return state;
      return {
        ...state,
        projection: action.projection,
        activeRunId: action.activeRunId,
        streamGeneration: action.streamGeneration,
        cursor: action.cursor,
        route: action.route,
        error: null,
      };
    case "draft":
      return { ...state, draft: action.draft };
    case "start": {
      if (state.phase === "pending") return state;
      const generation = state.generation + 1;
      return {
        ...state,
        phase: "pending",
        generation,
        projection: optimisticProjection(state.projection, action.replacementChatId),
        activeRunId: null,
        streamGeneration: state.streamGeneration + 1,
        route: action.route,
        pending: {
          chatId: action.chatId,
          replacementChatId: action.replacementChatId,
          generation,
        },
        rollback: {
          projection: state.projection,
          draft: state.draft,
          activeRunId: state.activeRunId,
          streamGeneration: state.streamGeneration,
          cursor: state.cursor,
          route: state.route,
        },
        error: null,
      };
    }
    case "success":
    case "conflict": {
      if (state.phase !== "pending" || state.pending?.generation !== action.generation) {
        return state;
      }
      const replacement = action.response.replacement;
      return {
        ...state,
        phase: "idle",
        projection: replacement,
        activeRunId: replacement.activeRun?.id ?? null,
        streamGeneration: state.streamGeneration + 1,
        cursor: null,
        pending: null,
        rollback: null,
        retry: null,
        error: null,
      };
    }
    case "failure": {
      if (state.phase !== "pending" || state.pending?.generation !== action.generation) {
        return state;
      }
      const rollback = state.rollback;
      if (rollback === null) return state;
      return {
        ...state,
        ...rollback,
        draft: state.draft,
        phase: "idle",
        generation: state.generation + 1,
        pending: null,
        rollback: null,
        retry: {
          chatId: state.pending.chatId,
          replacementChatId: state.pending.replacementChatId,
        },
        error: action.error,
      };
    }
    case "late_projection":
      if (action.generation !== state.generation || state.phase === "pending") return state;
      return {
        ...state,
        projection: action.projection,
        activeRunId: action.activeRunId,
      };
    case "late_stream":
      if (
        action.generation !== state.generation ||
        action.streamGeneration !== state.streamGeneration ||
        state.phase === "pending"
      )
        return state;
      return {
        ...state,
        cursor: action.cursor,
      };
  }
};

export type ChatResetApi = {
  readonly resetChat: (
    chatId: string,
    replacementChatId: string,
  ) => Promise<ResetProductChatResponse>;
  /** Used only after a two-tab chat_already_reset conflict. */
  readonly getCommittedChat: () => Promise<GetChatResponse>;
};

export type ChatResetController<Route = unknown> = {
  readonly getState: () => ChatResetState<Route>;
  readonly subscribe: (listener: () => void) => () => void;
  readonly reset: (chatId: string, route: Route) => Promise<void>;
  readonly retry: () => Promise<void>;
  readonly dispatch: (action: ChatResetAction<Route>) => void;
};

const replacementFromError = (error: unknown): string | null => {
  if (typeof error !== "object" || error === null) return null;
  const body = (error as { readonly body?: unknown }).body;
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  return record.error === "chat_already_reset" && typeof record.archivedChatId === "string"
    ? record.archivedChatId
    : null;
};

export const createChatResetController = <Route>(options: {
  readonly initial: ChatResetSnapshot<Route>;
  readonly api: ChatResetApi;
  readonly generateReplacementId?: () => string;
  readonly onStart?: (snapshot: ChatResetSnapshot<Route>) => void;
  readonly onSuccess?: (response: ResetProductChatResponse) => void | Promise<void>;
  readonly onFailure?: (error: unknown, snapshot: ChatResetSnapshot<Route>) => void | Promise<void>;
}): ChatResetController<Route> => {
  let state = initialChatResetState(options.initial);
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  const dispatch = (action: ChatResetAction<Route>) => {
    const previous = state;
    state = chatResetReducer(state, action);
    if (state !== previous) notify();
  };

  const run = async (chatId: string, route: Route, replacementChatId: string) => {
    if (state.phase === "pending") return;
    const snapshot: ChatResetSnapshot<Route> = {
      projection: state.projection,
      draft: state.draft,
      activeRunId: state.activeRunId,
      streamGeneration: state.streamGeneration,
      cursor: state.cursor,
      route: state.route,
    };
    dispatch({ type: "start", chatId, replacementChatId, route });
    options.onStart?.(snapshot);
    const generation = state.generation;
    let response: ResetProductChatResponse;
    try {
      response = await options.api.resetChat(chatId, replacementChatId);
    } catch (error) {
      let failure = error;
      const archivedChatId = replacementFromError(failure);
      if (archivedChatId !== null) {
        let committed: GetChatResponse;
        try {
          committed = await options.api.getCommittedChat();
        } catch (reloadError) {
          failure = reloadError;
          dispatch({ type: "failure", generation, error: failure });
          await options.onFailure?.(failure, snapshot);
          return;
        }
        dispatch({
          type: "conflict",
          generation,
          response: { archivedChatId, replacement: committed },
        });
        await options.onSuccess?.({ archivedChatId, replacement: committed });
        return;
      }
      dispatch({ type: "failure", generation, error: failure });
      await options.onFailure?.(failure, snapshot);
      return;
    }
    dispatch({ type: "success", generation, response });
    await options.onSuccess?.(response);
  };

  const reset = async (chatId: string, route: Route) => {
    if (state.phase === "pending") return;
    const retry = state.retry;
    const replacementChatId =
      retry !== null && retry.chatId === chatId
        ? retry.replacementChatId
        : (options.generateReplacementId ?? (() => crypto.randomUUID()))();
    await run(chatId, route, replacementChatId);
  };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reset,
    retry: async () => {
      if (state.retry === null) return;
      await run(state.retry.chatId, state.route, state.retry.replacementChatId);
    },
    dispatch,
  };
};
