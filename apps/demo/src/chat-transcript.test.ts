import { describe, expect, it } from "vitest";

import { buildTranscriptMessages } from "./chat-transcript";

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
  });

  it("never renders a provisional message after terminal error", () => {
    expect(
      buildTranscriptMessages([], "run-1", "error", {
        assistantText: "discard me",
        sourcesRead: sources,
      }),
    ).toEqual([]);
  });
});
