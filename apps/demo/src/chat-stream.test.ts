import { describe, expect, it } from "vitest";

import { initialChatStreamState, reduceChatStream, type ChatStreamInput } from "./chat-stream";

const reduceAll = (events: readonly ChatStreamInput[]) =>
  events.reduce(reduceChatStream, initialChatStreamState);

describe("reduceChatStream", () => {
  it("reduces a full happy sequence", () => {
    const state = reduceAll([
      { seq: 1, event: { type: "run_started" } },
      { seq: 2, event: { type: "preflight_search", terms: "budget", resultCount: 3 } },
      {
        seq: 3,
        event: {
          type: "context_window",
          blocks: [{ blockId: "b1", kind: "document", label: "Source", tokenEstimate: 42 }],
        },
      },
      { seq: 4, event: { type: "answer_started", attempt: 1 } },
      { seq: 5, event: { type: "text_delta", delta: "Bonjour " } },
      { seq: 6, event: { type: "text_delta", delta: "[[cite:b1]]" } },
      { seq: 7, event: { type: "memory_updated", created: 1, updated: 0, discarded: 0 } },
      { seq: 8, event: { type: "done", assistantMessageId: "message-1" } },
    ]);

    expect(state.phase).toBe("done");
    expect(state.assistantText).toBe("Bonjour [[cite:b1]]");
    expect(state.seq).toBe(8);
    expect(state.searchCount).toBe(1);
    expect(state.latestResultCount).toBe(3);
    expect(state.contextBlocks).toEqual([
      { blockId: "b1", kind: "document", label: "Source", tokenEstimate: 42 },
    ]);
    expect(state.memoryUpdated).toEqual({ created: 1, updated: 0, discarded: 0 });
  });

  it("resets assistant text when a second attempt starts", () => {
    const state = reduceAll([
      { seq: 1, event: { type: "answer_started", attempt: 1 } },
      { seq: 2, event: { type: "text_delta", delta: "first attempt" } },
      { seq: 3, event: { type: "answer_retry", gap: "need more evidence" } },
      { seq: 4, event: { type: "answer_started", attempt: 2 } },
      { seq: 5, event: { type: "text_delta", delta: "second attempt" } },
    ]);

    expect(state.phase).toBe("answering");
    expect(state.attempt).toBe(2);
    expect(state.assistantText).toBe("second attempt");
  });

  it("surfaces terminal errors", () => {
    const state = reduceAll([
      { seq: 1, event: { type: "run_started" } },
      { seq: 2, event: { type: "error", code: "worker_unavailable", retryable: true } },
    ]);

    expect(state.phase).toBe("error");
    expect(state.error).toEqual({ code: "worker_unavailable", retryable: true });
  });

  it("guards out-of-order events by sequence", () => {
    const state = reduceAll([
      { seq: 2, event: { type: "text_delta", delta: "new" } },
      { seq: 1, event: { type: "text_delta", delta: "old" } },
    ]);

    expect(state.seq).toBe(2);
    expect(state.assistantText).toBe("new");
  });

  it("keeps reconnect replay idempotent", () => {
    const once = reduceAll([{ seq: 1, event: { type: "text_delta", delta: "hello" } }]);
    const replayed = reduceChatStream(once, {
      seq: 1,
      event: { type: "text_delta", delta: "hello" },
    });

    expect(replayed.assistantText).toBe("hello");
    expect(replayed).toBe(once);
  });
});
