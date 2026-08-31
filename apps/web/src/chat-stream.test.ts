import { describe, expect, it } from "vitest";
import {
  initialChatStreamState,
  reduceChatStream,
  serializeChatStreamState,
  streamStorageKey,
} from "./chat-stream";

describe("chat stream reducer", () => {
  it("reduces ordered stages and stopped terminal state", () => {
    let state = reduceChatStream(initialChatStreamState, {
      seq: 1,
      event: { type: "run_started" },
    });
    state = reduceChatStream(state, {
      seq: 2,
      event: { type: "answer_started", mode: "single", attempt: 1 },
    });
    state = reduceChatStream(state, { seq: 3, event: { type: "text_delta", delta: "partial" } });
    state = reduceChatStream(state, {
      seq: 4,
      event: { type: "stopped", assistantMessageId: null },
    });
    expect(state).toMatchObject({ phase: "stopped", assistantText: "partial", seq: 4 });
    expect(
      reduceChatStream(state, { seq: 5, event: { type: "done", assistantMessageId: "late" } }),
    ).toBe(state);
  });
  it("uses schema version five persistence under the demo prefix", () => {
    expect(streamStorageKey("run-1")).toBe("hartlib:demo:stream:run-1");
    expect(JSON.parse(serializeChatStreamState(initialChatStreamState))).toMatchObject({
      schemaVersion: 5,
    });
  });
});
