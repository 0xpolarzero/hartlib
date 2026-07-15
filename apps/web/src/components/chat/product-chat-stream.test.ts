import { describe, expect, it, vi } from "vitest";

import {
  clearRunStreamState,
  emptyStreamDraft,
  isDefinitiveStreamHandshakeFailure,
  isTerminalEventUnavailable,
  isWebResearchUnavailable,
  persistRunStreamState,
  reconnectDelayMs,
  reduceRunStreamEvent,
  reconcileUserScopedConflict,
  resolveAmbiguousUserScopedConflict,
  restoreRunStreamState,
  runStreamStorageKey,
  shouldApplyChatReload,
  streamFailureAction,
} from "./product-chat-stream";
import { ApiResponseError } from "@brief/api-client";
import type { SendChatMessageRequest } from "@brief/shared";

const memoryStorage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    values,
  };
};

describe("product chat stream resume state", () => {
  it("terminates a pruned cursor immediately instead of retrying it", () => {
    const unavailable = new ApiResponseError(410, "terminal_event_unavailable");
    expect(isTerminalEventUnavailable(unavailable)).toBe(true);
    expect(streamFailureAction(unavailable)).toBe("terminate");
    expect(streamFailureAction(new ApiResponseError(500, "network"))).toBe("retry");
  });

  it("terminates definitive unauthorized or missing stream handshakes", () => {
    for (const status of [401, 403, 404]) {
      const failure = new ApiResponseError(status, "stream_handshake_failed");
      expect(isDefinitiveStreamHandshakeFailure(failure)).toBe(true);
      expect(streamFailureAction(failure)).toBe("terminate");
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
    expect(isWebResearchUnavailable(new ApiResponseError(500, "web_research_unavailable"))).toBe(
      false,
    );
  });

  it("persists and restores the exact cursor with its provisional transcript", () => {
    const storage = memoryStorage();
    persistRunStreamState(storage, {
      version: 1,
      runId: "run-1",
      lastSeq: 12,
      draft: { runId: "run-1", text: "partial", attempt: 1, sourcesRead: [] },
    });
    expect(restoreRunStreamState(storage, "run-1")).toMatchObject({
      lastSeq: 12,
      draft: { text: "partial", attempt: 1 },
    });
    expect(restoreRunStreamState(storage, "run-2")).toBeNull();
    storage.values.set(
      runStreamStorageKey("run-1"),
      JSON.stringify({
        version: 1,
        runId: "run-1",
        lastSeq: 12,
        draft: { runId: "run-1", text: "partial", attempt: 1, sourcesRead: [], extra: true },
      }),
    );
    expect(restoreRunStreamState(storage, "run-1")).toBeNull();
    clearRunStreamState(storage, "run-1");
    expect(storage.values.has(runStreamStorageKey("run-1"))).toBe(false);
  });

  it("deduplicates replayed sequences and resets only for a newer answer attempt", () => {
    const initial = emptyStreamDraft("run-1");
    const first = reduceRunStreamEvent("run-1", 0, initial, 2, {
      type: "text_delta",
      delta: "one",
    });
    const duplicate = reduceRunStreamEvent("run-1", first.lastSeq, first.draft!, 2, {
      type: "text_delta",
      delta: "duplicate",
    });
    const sameAttempt = reduceRunStreamEvent("run-1", duplicate.lastSeq, duplicate.draft!, 3, {
      type: "answer_started",
      mode: "single",
      attempt: 0,
    });
    const retry = reduceRunStreamEvent("run-1", sameAttempt.lastSeq, sameAttempt.draft!, 4, {
      type: "answer_started",
      mode: "single",
      attempt: 1,
    });
    expect(duplicate.applied).toBe(false);
    expect(duplicate.draft?.text).toBe("one");
    expect(sameAttempt.draft?.text).toBe("one");
    expect(retry.draft).toMatchObject({ text: "", attempt: 1 });
  });

  it("marks terminal events and caps persistent exponential reconnects", () => {
    const terminal = reduceRunStreamEvent("run-1", 7, emptyStreamDraft("run-1"), 8, {
      type: "error",
      code: "answer_failed",
      retryable: true,
    });
    expect(terminal).toMatchObject({ applied: true, terminal: true, lastSeq: 8, draft: null });
    expect([0, 1, 2, 3, 4, 5, 50].map(reconnectDelayMs)).toEqual([
      250, 500, 1_000, 2_000, 4_000, 4_000, 4_000,
    ]);
  });
});

describe("product chat active-run conflict reconciliation", () => {
  const request = {
    text: "pending",
    locale: "en-US" as const,
    market: "US" as const,
    webSearchEnabled: false,
  };
  const userMessage = (id: string, status: "queued" | "succeeded") => ({
    id,
    author: "user" as const,
    content: request.text,
    createdAt: "2026-01-01T00:00:00.000Z",
    run:
      status === "queued"
        ? { id: `${id}-run`, status: "queued" as const }
        : { id: `${id}-run`, status: "succeeded" as const, finishedAt: "2026-01-01T00:01:00.000Z" },
  });

  it("attaches only a newly visible active message or chat run after uncertainty", () => {
    const conflict = { chatId: "chat", runId: "foreign", request, knownMessageIds: ["old"] };
    expect(
      resolveAmbiguousUserScopedConflict(conflict, {
        messages: [userMessage("new", "queued")],
        activeRun: null,
      }),
    ).toEqual({ action: "attach", runId: "new-run" });
    expect(
      resolveAmbiguousUserScopedConflict(conflict, {
        messages: [userMessage("old", "queued")],
        activeRun: null,
      }),
    ).toEqual({ action: "clear" });
    expect(
      resolveAmbiguousUserScopedConflict(conflict, {
        messages: [],
        activeRun: { id: "same-chat", status: "running", streamPath: "/runs/same-chat" },
      }),
    ).toEqual({ action: "attach", runId: "same-chat" });
  });

  it("fences stale reloads from replacing a later accepted run", () => {
    expect(shouldApplyChatReload(1, 2, "accepted", "foreign")).toBe(false);
    expect(shouldApplyChatReload(2, 2, "accepted", "foreign")).toBe(false);
    expect(shouldApplyChatReload(2, 2, "accepted", "accepted")).toBe(true);
    expect(shouldApplyChatReload(3, 3, undefined, null)).toBe(true);
  });

  it("retries only typed user conflicts and then attaches the accepted run", async () => {
    vi.useFakeTimers();
    try {
      const send = vi
        .fn<(value: SendChatMessageRequest) => Promise<{ readonly run: { readonly id: string } }>>()
        .mockRejectedValueOnce(
          new ApiResponseError(409, "active_ai_run", {
            code: "active_ai_run",
            conflictScope: "user",
            activeRun: { id: "foreign", status: "running", streamPath: "/runs/foreign" },
          }),
        )
        .mockResolvedValueOnce({ run: { id: "accepted" } });
      const accepted: string[] = [];
      const retry = reconcileUserScopedConflict({
        conflict: { chatId: "chat", runId: "foreign", request },
        signal: new AbortController().signal,
        send,
        delayMs: 5,
        onStillActive: () => undefined,
        onChatConflict: () => undefined,
        onAccepted: (response) => {
          accepted.push(response.run.id);
        },
        onStopped: () => {
          throw new Error("unexpected stop");
        },
      });
      await vi.advanceTimersByTimeAsync(5);
      await vi.advanceTimersByTimeAsync(5);
      await retry;
      expect(send).toHaveBeenCalledTimes(2);
      expect(accepted).toEqual(["accepted"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("attaches a same-chat conflict from a second tab without entering the generic stop path", async () => {
    vi.useFakeTimers();
    try {
      const send = vi.fn<(value: SendChatMessageRequest) => Promise<never>>().mockRejectedValue(
        new ApiResponseError(409, "active_ai_run", {
          code: "active_ai_run",
          conflictScope: "chat",
          activeRun: { id: "same-chat", status: "running", streamPath: "/runs/same-chat" },
        }),
      );
      const attached: string[] = [];
      const stopped: unknown[] = [];
      const retry = reconcileUserScopedConflict({
        conflict: { chatId: "chat", runId: "foreign", request },
        signal: new AbortController().signal,
        send,
        delayMs: 5,
        onStillActive: () => undefined,
        onChatConflict: (conflict) => {
          attached.push(conflict.activeRun.id);
        },
        onAccepted: () => undefined,
        onStopped: (cause) => {
          stopped.push(cause);
        },
      });
      await vi.advanceTimersByTimeAsync(5);
      await retry;
      expect(attached).toEqual(["same-chat"]);
      expect(stopped).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a blocked retry when the page unmounts", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const send = vi.fn<(value: SendChatMessageRequest) => Promise<never>>();
      const retry = reconcileUserScopedConflict({
        conflict: { chatId: "chat", runId: "foreign", request },
        signal: controller.signal,
        send,
        delayMs: 5,
        onStillActive: () => undefined,
        onChatConflict: () => undefined,
        onAccepted: () => undefined,
        onStopped: () => undefined,
      });
      controller.abort();
      await vi.advanceTimersByTimeAsync(10);
      await retry;
      expect(send).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
