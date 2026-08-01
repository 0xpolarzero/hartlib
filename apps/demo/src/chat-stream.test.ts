import { describe, expect, it, vi } from "vitest";
import type { GetChatResponse, SendChatMessageRequest } from "@brief/shared";

import {
  initialChatStreamState,
  isDefinitiveStreamHandshakeFailure,
  isTerminalEventUnavailable,
  isWebResearchUnavailable,
  reconcileUserScopedConflict,
  reduceChatStream,
  resolveAmbiguousUserScopedConflict,
  restoreChatStreamState,
  streamReconnectAction,
  type ChatStreamInput,
  type UserScopedConflict,
} from "./chat-stream";
import { ApiResponseError } from "@brief/api-client";

const source = {
  sourceKey: "k_nonce_1",
  label: "Document",
  tokenCount: 42,
  topicIds: [] as const,
  kind: "document" as const,
  documentTitle: "Document",
  url: "https://example.com/document",
  ranges: [{ charStart: 0, charEnd: 20 }],
};

const reduceAll = (events: readonly ChatStreamInput[]) =>
  events.reduce(reduceChatStream, initialChatStreamState);

describe("reduceChatStream", () => {
  it("recognizes a non-replayable terminal stream response", () => {
    expect(
      isTerminalEventUnavailable(new ApiResponseError(410, "terminal_event_unavailable")),
    ).toBe(true);
    expect(isTerminalEventUnavailable(new ApiResponseError(410, "other"))).toBe(false);
    expect(isTerminalEventUnavailable(new Error("network"))).toBe(false);
    expect(streamReconnectAction(new ApiResponseError(410, "terminal_event_unavailable"))).toBe(
      "reconcile",
    );
    expect(streamReconnectAction(new ApiResponseError(500, "network"))).toBe("retry");
  });

  it("reconciles definitive unauthorized or missing stream handshakes", () => {
    for (const status of [401, 403, 404]) {
      const failure = new ApiResponseError(status, "stream_handshake_failed");
      expect(isDefinitiveStreamHandshakeFailure(failure)).toBe(true);
      expect(streamReconnectAction(failure)).toBe("reconcile");
    }
    expect(isDefinitiveStreamHandshakeFailure(new ApiResponseError(500, "network"))).toBe(false);
  });

  it("recognizes only the typed stale web-policy rejection", () => {
    expect(
      isWebResearchUnavailable(
        new ApiResponseError(403, "web_research_unavailable", {
          code: "web_research_unavailable",
          reason: "company_disabled",
        }),
      ),
    ).toBe(true);
    expect(isWebResearchUnavailable(new ApiResponseError(403, "forbidden"))).toBe(false);
  });

  it("reduces the canonical success sequence", () => {
    const state = reduceAll([
      { seq: 1, event: { type: "run_started" } },
      {
        seq: 2,
        event: {
          type: "context_ready",
          mode: "single",
          compactionRan: false,
          sourcesRead: [source],
          consumers: [
            {
              consumer: "direct",
              inputTokens: 100,
              requestedOutputTokens: 50,
              usableInputTokens: 200,
            },
          ],
        },
      },
      { seq: 3, event: { type: "answer_started", mode: "single", attempt: 1 } },
      { seq: 4, event: { type: "text_delta", delta: "Answer [[cite:k_nonce_1]]" } },
      { seq: 5, event: { type: "memory_updated", created: 1, updated: 0, discarded: 0 } },
      { seq: 6, event: { type: "done", assistantMessageId: "message-1" } },
    ]);

    expect(state).toMatchObject({
      phase: "done",
      assistantText: "Answer [[cite:k_nonce_1]]",
      seq: 6,
      mode: "single",
      sourcesRead: [source],
      memoryUpdated: { created: 1, updated: 0, discarded: 0 },
    });
  });

  it("resets visible text for a new answer attempt", () => {
    const state = reduceAll([
      { seq: 1, event: { type: "answer_started", mode: "single", attempt: 1 } },
      { seq: 2, event: { type: "text_delta", delta: "first" } },
      { seq: 3, event: { type: "answer_started", mode: "single", attempt: 2 } },
      { seq: 4, event: { type: "text_delta", delta: "second" } },
    ]);
    expect(state.attempt).toBe(2);
    expect(state.assistantText).toBe("second");
  });

  it("updates one activity item per public key and marks the active item on failure", () => {
    const state = reduceAll([
      {
        seq: 1,
        event: {
          type: "activity",
          stage: "understanding",
          code: "request_understanding",
          status: "running",
          attempt: 1,
        },
      },
      {
        seq: 2,
        event: {
          type: "activity",
          stage: "understanding",
          code: "request_understanding",
          status: "retrying",
          attempt: 2,
        },
      },
      {
        seq: 3,
        event: {
          type: "activity",
          stage: "preparing",
          code: "context_preparation",
          status: "running",
        },
      },
      { seq: 4, event: { type: "error", code: "context_plan_unfit", retryable: false } },
    ]);

    expect(state.activities).toMatchObject([
      { code: "request_understanding", status: "retrying", attempt: 2 },
      { code: "context_preparation", status: "failed" },
    ]);
    expect(state.error).toEqual({ code: "context_plan_unfit", retryable: false });
  });

  it("discards provisional answer and sources on terminal error", () => {
    const state = reduceAll([
      { seq: 1, event: { type: "answer_started", mode: "synthesis", attempt: 1 } },
      { seq: 2, event: { type: "text_delta", delta: "provisional" } },
      { seq: 3, event: { type: "error", code: "context_compaction_failed", retryable: true } },
    ]);
    expect(state.phase).toBe("error");
    expect(state.assistantText).toBe("");
    expect(state.sourcesRead).toEqual([]);
    expect(state.error).toEqual({ code: "context_compaction_failed", retryable: true });
  });

  it("keeps cursor replay idempotent", () => {
    const once = reduceAll([{ seq: 1, event: { type: "text_delta", delta: "hello" } }]);
    expect(reduceChatStream(once, { seq: 1, event: { type: "text_delta", delta: "hello" } })).toBe(
      once,
    );
  });

  it("restores provisional deltas and their exact replay cursor after reload", () => {
    expect(
      restoreChatStreamState({
        version: 2,
        runId: "run-1",
        lastSeq: 9,
        draft: {
          runId: "run-1",
          text: "provisional answer",
          attempt: 2,
          sourcesRead: [source],
          activities: [
            {
              type: "activity",
              stage: "evidence",
              code: "internal_sources",
              status: "complete",
            },
          ],
          terminalFailure: null,
        },
      }),
    ).toMatchObject({
      phase: "answering",
      assistantText: "provisional answer",
      seq: 9,
      attempt: 2,
      sourcesRead: [source],
      activities: [{ code: "internal_sources", status: "complete" }],
    });
  });
});

describe("user-scoped conflict reconciliation", () => {
  const request = {
    text: "pending",
    locale: "en-US" as const,
    market: "US" as const,
    webSearchEnabled: false,
  };
  const conflict = (runId: string) => ({
    code: "active_ai_run" as const,
    conflictScope: "user" as const,
    activeRun: { id: runId, status: "running" as const, streamPath: `/runs/${runId}` },
  });

  const chatWith = (
    messages: GetChatResponse["messages"],
    activeRun: GetChatResponse["activeRun"] = null,
  ): Pick<GetChatResponse, "messages" | "activeRun"> => ({ messages, activeRun });
  const userMessage = (
    id: string,
    content: string,
    status: "queued" | "running" | "succeeded" | "failed",
  ): GetChatResponse["messages"][number] => ({
    id,
    author: "user",
    content,
    createdAt: "2026-01-01T00:00:00.000Z",
    run:
      status === "queued" || status === "running"
        ? { id: `${id}-run`, status }
        : status === "succeeded"
          ? { id: `${id}-run`, status, finishedAt: "2026-01-01T00:01:00.000Z" }
          : {
              id: `${id}-run`,
              status,
              errorCode: "failed",
              retryable: true,
              failedAt: "2026-01-01T00:01:00.000Z",
            },
  });

  it("authoritatively attaches an ambiguous POST only when the run is visible", () => {
    const pending = { runId: "foreign-1", request, knownMessageIds: ["old"] };
    expect(
      resolveAmbiguousUserScopedConflict(
        pending,
        chatWith([userMessage("new", request.text, "queued")]),
      ),
    ).toEqual({ action: "attach", runId: "new-run" });
    expect(resolveAmbiguousUserScopedConflict(pending, chatWith([]))).toEqual({ action: "clear" });
    expect(
      resolveAmbiguousUserScopedConflict(
        pending,
        chatWith([userMessage("old", request.text, "queued")]),
      ),
    ).toEqual({ action: "clear" });
  });

  it("attaches the authoritative active chat run after repeated conflicts", () => {
    expect(
      resolveAmbiguousUserScopedConflict(
        { runId: "foreign-2", request },
        chatWith([], {
          id: "own-202",
          status: "queued",
          streamPath: "/runs/own-202",
        }),
      ),
    ).toEqual({ action: "attach", runId: "own-202" });
  });

  it("keeps the exact pending send blocked on confirmed 409s, then attaches only its own 202 run", async () => {
    vi.useFakeTimers();
    try {
      const send = vi
        .fn<(value: SendChatMessageRequest) => Promise<{ readonly run: { readonly id: string } }>>()
        .mockRejectedValueOnce(new ApiResponseError(409, "active_ai_run", conflict("foreign-1")))
        .mockRejectedValueOnce(new ApiResponseError(409, "active_ai_run", conflict("foreign-2")))
        .mockResolvedValueOnce({ run: { id: "own-1" } });
      const stillActive: string[] = [];
      const accepted: string[] = [];
      const descriptor: UserScopedConflict = { runId: "foreign-1", request };
      const reconciliation = reconcileUserScopedConflict({
        conflict: descriptor,
        signal: new AbortController().signal,
        send,
        delayMs: 10,
        onStillActive: (next) => {
          stillActive.push(next.activeRun.id);
        },
        onChatConflict: () => undefined,
        onAccepted: (response) => {
          accepted.push(response.run.id);
        },
        onStopped: () => {
          throw new Error("unexpected reconciliation stop");
        },
      });

      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(10);
      await reconciliation;

      expect(send).toHaveBeenCalledTimes(3);
      expect(send).toHaveBeenNthCalledWith(1, request);
      expect(send).toHaveBeenNthCalledWith(2, request);
      expect(stillActive).toEqual(["foreign-1", "foreign-2"]);
      expect(accepted).toEqual(["own-1"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not overlap retries while a confirmed POST is still in flight", async () => {
    vi.useFakeTimers();
    try {
      let resolveSend!: (value: { readonly run: { readonly id: string } }) => void;
      const send = vi.fn(
        () =>
          new Promise<{ readonly run: { readonly id: string } }>((resolve) => {
            resolveSend = resolve;
          }),
      );
      const reconciliation = reconcileUserScopedConflict({
        conflict: { runId: "foreign-1", request },
        signal: new AbortController().signal,
        send,
        delayMs: 10,
        onStillActive: () => undefined,
        onChatConflict: () => undefined,
        onAccepted: () => undefined,
        onStopped: () => undefined,
      });

      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(100);
      expect(send).toHaveBeenCalledTimes(1);
      resolveSend({ run: { id: "own-1" } });
      await reconciliation;
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops after an ambiguous failure instead of retrying a possibly accepted POST", async () => {
    vi.useFakeTimers();
    try {
      const send =
        vi.fn<
          (value: SendChatMessageRequest) => Promise<{ readonly run: { readonly id: string } }>
        >();
      const stopped: unknown[] = [];
      send.mockRejectedValueOnce(new Error("network"));
      const reconciliation = reconcileUserScopedConflict({
        conflict: { runId: "foreign-1", request },
        signal: new AbortController().signal,
        send,
        delayMs: 10,
        onStillActive: () => undefined,
        onChatConflict: () => undefined,
        onAccepted: () => undefined,
        onStopped: (cause) => {
          stopped.push(cause);
        },
      });

      await vi.advanceTimersByTimeAsync(10);
      await reconciliation;
      expect(send).toHaveBeenCalledTimes(1);
      expect(stopped).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
