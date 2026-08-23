import type { ChatMessage } from "@hartlib/shared";
import { describe, expect, it } from "vitest";

import { mapApiMessagesToTranscript } from "./chat-api";

describe("mapApiMessagesToTranscript", () => {
  it("preserves the durable user run outcome and immutable assistant public records", () => {
    const messages: readonly ChatMessage[] = [
      {
        id: "m1",
        author: "user",
        content: "Question",
        createdAt: "2026-07-09T05:00:00.000Z",
        run: {
          id: "r1",
          status: "failed",
          errorCode: "context_compaction_failed",
          retryable: true,
          failedAt: "2026-07-09T05:00:01.000Z",
        },
      },
      {
        id: "m2",
        author: "assistant",
        content: "Answer [[cite:k_nonce_1]]",
        createdAt: "2026-07-09T05:01:00.000Z",
        citations: [
          {
            sourceKey: "k_nonce_1",
            label: "Official source",
            kind: "web",
            title: "Page",
            domain: "example.com",
            url: "https://example.com/page",
            capturedAt: "2026-07-09T05:00:30.000Z",
            quote: { text: "Evidence" },
            ranges: [],
          },
        ],
        sourcesRead: [
          {
            sourceKey: "k_nonce_1",
            label: "Official source",
            tokenCount: 12,
            topicIds: [],
            kind: "web",
            title: "Page",
            domain: "example.com",
            url: "https://example.com/page",
            capturedAt: "2026-07-09T05:00:30.000Z",
            quote: "Evidence",
            ranges: [],
          },
        ],
      },
    ];

    expect(mapApiMessagesToTranscript(messages)).toEqual([
      {
        id: "m1",
        author: "user",
        content: "Question",
        run: {
          id: "r1",
          status: "failed",
          errorCode: "context_compaction_failed",
          retryable: true,
          failedAt: "2026-07-09T05:00:01.000Z",
        },
      },
      {
        id: "m2",
        author: "assistant",
        content: "Answer [[cite:k_nonce_1]]",
        citations: messages[1]?.author === "assistant" ? messages[1].citations : [],
        sourcesRead: messages[1]?.author === "assistant" ? messages[1].sourcesRead : [],
      },
    ]);
  });
});
