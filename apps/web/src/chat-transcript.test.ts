import { describe, expect, it } from "vitest";
import { buildTranscriptMessages } from "./chat-transcript";

describe("demo transcript projection", () => {
  it("keeps a valid partial answer visible after a stopped stream", () => {
    const messages = buildTranscriptMessages([], "run-1", "stopped", {
      assistantText: "Partial answer",
      sourcesRead: [],
      activities: [],
      activityHistory: [],
      context: null,
      memoryUpdated: null,
      error: null,
      stoppedAt: "2026-08-27T12:00:00.000Z",
      seq: 4,
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: "streaming:run-1",
      content: "Partial answer",
      stopped: true,
      streaming: false,
    });
  });
  it("keeps the streamed answer visible when the terminal reload misses", () => {
    const messages = buildTranscriptMessages([], "run-2", "done", {
      assistantText: "Completed answer",
      sourcesRead: [],
      activities: [],
      activityHistory: [],
      context: null,
      memoryUpdated: null,
      error: null,
      stoppedAt: null,
      seq: 5,
    });
    expect(messages[0]).toMatchObject({
      id: "streaming:run-2",
      content: "Completed answer",
      streaming: false,
    });
  });
});
