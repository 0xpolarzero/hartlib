import type { ChatTranscriptContextBlock } from "@brief/ui";

export type ChatStreamPhase = "idle" | "preflight" | "answering" | "retrying" | "done" | "error";

export type ChatStreamEvent =
  | { readonly type: "run_started" }
  | { readonly type: "preflight_search"; readonly terms: string; readonly resultCount: number }
  | { readonly type: "preflight_peek"; readonly documentId: string }
  | { readonly type: "context_window"; readonly blocks: readonly ChatTranscriptContextBlock[] }
  | { readonly type: "answer_started"; readonly attempt: number }
  | { readonly type: "answer_retry"; readonly gap: string }
  | { readonly type: "text_delta"; readonly delta: string }
  | {
      readonly type: "memory_updated";
      readonly created: number;
      readonly updated: number;
      readonly discarded: number;
    }
  | { readonly type: "usage"; readonly agent: string; readonly usage: unknown }
  | { readonly type: "done"; readonly assistantMessageId: string }
  | { readonly type: "error"; readonly code: string; readonly retryable?: boolean };

export type ChatStreamInput = {
  readonly seq: number;
  readonly event: ChatStreamEvent;
};

export type ChatStreamMemoryUpdate = {
  readonly created: number;
  readonly updated: number;
  readonly discarded: number;
};

export type ChatStreamError = {
  readonly code: string;
  readonly retryable: boolean;
};

export type ChatStreamState = {
  readonly phase: ChatStreamPhase;
  readonly assistantText: string;
  readonly seq: number;
  readonly attempt: number;
  readonly searchCount: number;
  readonly latestResultCount: number;
  readonly contextBlocks: readonly ChatTranscriptContextBlock[];
  readonly memoryUpdated: ChatStreamMemoryUpdate | null;
  readonly error: ChatStreamError | null;
};

export const initialChatStreamState: ChatStreamState = {
  phase: "idle",
  assistantText: "",
  seq: 0,
  attempt: 0,
  searchCount: 0,
  latestResultCount: 0,
  contextBlocks: [],
  memoryUpdated: null,
  error: null,
};

const assertNever = (value: never): never => {
  throw new Error(`Unhandled chat stream event: ${JSON.stringify(value)}`);
};

export function reduceChatStream(state: ChatStreamState, input: ChatStreamInput): ChatStreamState {
  if (input.seq <= state.seq) return state;

  const base = { ...state, seq: input.seq };

  switch (input.event.type) {
    case "run_started":
      return {
        ...base,
        phase: "preflight",
        error: null,
      };
    case "preflight_search":
      return {
        ...base,
        phase: base.phase === "idle" ? "preflight" : base.phase,
        searchCount: state.searchCount + 1,
        latestResultCount: input.event.resultCount,
      };
    case "preflight_peek":
      return {
        ...base,
        phase: base.phase === "idle" ? "preflight" : base.phase,
      };
    case "context_window":
      return {
        ...base,
        phase: base.phase === "idle" ? "preflight" : base.phase,
        contextBlocks: input.event.blocks,
      };
    case "answer_started": {
      const nextAttempt = input.event.attempt;
      return {
        ...base,
        phase: "answering",
        attempt: Math.max(state.attempt, nextAttempt),
        assistantText: nextAttempt > state.attempt ? "" : state.assistantText,
        error: null,
      };
    }
    case "answer_retry":
      return {
        ...base,
        phase: "retrying",
      };
    case "text_delta":
      return {
        ...base,
        phase: base.phase === "idle" || base.phase === "preflight" ? "answering" : base.phase,
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
      return {
        ...base,
        phase: "done",
      };
    case "error":
      return {
        ...base,
        phase: "error",
        error: {
          code: input.event.code,
          retryable: input.event.retryable === true,
        },
      };
  }

  return assertNever(input.event);
}
