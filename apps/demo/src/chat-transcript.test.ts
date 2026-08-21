import { describe, expect, it } from "vitest";

import { initialChatStreamState, reduceChatStream } from "./chat-stream";
import { buildTranscriptMessages, provisionalRunIdForPhase } from "./chat-transcript";

const sources = [
  {
    sourceKey: "k_nonce_1",
    label: "Source A",
    tokenCount: 10,
    topicIds: [] as const,
    kind: "document" as const,
    documentTitle: "Source A",
    url: "https://example.com/a",
    ranges: [{ charStart: 0, charEnd: 10 }],
  },
  {
    sourceKey: "k_nonce_2",
    label: "Memory",
    tokenCount: 5,
    topicIds: ["t1"] as const,
    kind: "memory" as const,
    memoryId: "memory-1",
    memoryRevisionId: "revision-1",
    ranges: [] as const,
  },
];

describe("buildTranscriptMessages", () => {
  it("shows a provisional answer with only currently cited source records", () => {
    const messages = buildTranscriptMessages([], "run-1", "answering", {
      assistantText: "Answer [[cite:k_nonce_2]] and [[cite:k_nonce_1,k_nonce_2]]",
      sourcesRead: sources,
      activities: [
        {
          type: "activity",
          stage: "evidence",
          code: "internal_sources",
          status: "complete",
        },
      ],
      error: null,
      activityHistory: [
        {
          type: "activity",
          stage: "evidence",
          code: "internal_sources",
          status: "running",
        },
      ],
      context: { compactionRan: false, consumers: [] },
      seq: 4,
    });
    const assistant = messages[0];
    expect(assistant?.author).toBe("assistant");
    if (assistant?.author !== "assistant") throw new Error("expected assistant");
    expect(assistant.citations.map((citation) => citation.sourceKey)).toEqual([
      "k_nonce_2",
      "k_nonce_1",
    ]);
    expect(assistant.sourcesRead).toEqual(sources);
    expect(assistant.streaming).toBe(true);
    expect(assistant.activities).toMatchObject([{ code: "internal_sources", status: "complete" }]);
    expect(assistant.diagnostics).toMatchObject({ sequence: 4, context: { compactionRan: false } });
  });

  it("keeps the failed activity card after a terminal error", () => {
    const messages = buildTranscriptMessages([], "run-1", "error", {
      assistantText: "",
      sourcesRead: [],
      activities: [
        {
          type: "activity",
          stage: "preparing",
          code: "context_preparation",
          status: "failed",
        },
      ],
      error: { code: "context_compaction_failed", retryable: true },
    });
    const assistant = messages[0];
    expect(assistant?.author).toBe("assistant");
    if (assistant?.author !== "assistant") throw new Error("expected assistant");
    expect(assistant.content).toBe("");
    expect(assistant.activityFailure).toEqual({
      code: "context_compaction_failed",
      retryable: true,
    });
  });

  it("keeps the failed card when an authoritative refresh clears the active run", () => {
    const running = reduceChatStream(initialChatStreamState, {
      seq: 1,
      event: {
        type: "activity",
        stage: "preparing",
        code: "context_preparation",
        status: "running",
      },
    });
    const terminal = reduceChatStream(running, {
      seq: 2,
      event: {
        type: "error",
        code: "context_compaction_failed",
        retryable: true,
      },
    });
    const authoritativeActiveRunId = null;
    const failedRunId = provisionalRunIdForPhase(
      authoritativeActiveRunId,
      terminal.phase,
      "run-1",
    );

    expect(failedRunId).toBe("run-1");
    expect(
      buildTranscriptMessages([], failedRunId, terminal.phase, terminal),
    ).toMatchObject([
      {
        id: "streaming:run-1",
        streaming: true,
        activityFailure: { code: "context_compaction_failed", retryable: true },
        activities: [{ code: "context_preparation", status: "failed" }],
      },
    ]);
  });
});
