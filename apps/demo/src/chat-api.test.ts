import type { ChatMessage } from "@hartlib/shared";
import { describe, expect, it } from "vitest";
import { mapApiMessagesToTranscript } from "./chat-api";

describe("mapApiMessagesToTranscript", () => {
  it("keeps strict assistant citations and terminal user outcomes", () => {
    const messages = [
      {
        id: "m1",
        author: "user",
        content: "Question",
        createdAt: "2026-07-09T05:00:00.000Z",
        run: { id: "r1", status: "stopped", stoppedAt: "2026-07-09T05:00:01.000Z" },
      },
      {
        id: "m2",
        author: "assistant",
        content: "Answer",
        createdAt: "2026-07-09T05:01:00.000Z",
        citations: [
          {
            sourceKey: "k1",
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
            sourceKey: "k1",
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
    ] as unknown as readonly ChatMessage[];
    expect(mapApiMessagesToTranscript(messages)).toMatchObject([
      { id: "m1", stopped: true, author: "user" },
      { id: "m2", author: "assistant", content: "Answer" },
    ]);
    const assistant = mapApiMessagesToTranscript(messages)[1];
    expect(assistant?.author === "assistant" ? assistant.citations?.[0]?.quote : null).toEqual({
      text: "Evidence",
    });
  });
});
