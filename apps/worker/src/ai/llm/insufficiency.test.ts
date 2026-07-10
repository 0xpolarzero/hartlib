import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { PiAiClient } from "./pi-ai-client";
import type { AnswerStreamEvent } from "./types";
import { zeroUsage } from "./types";

const message = (text: string): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "openai-completions",
  provider: "zai",
  model: "glm-5.2",
  usage: zeroUsage(),
  stopReason: "stop",
  timestamp: Date.now(),
});

const streamText = (chunks: readonly string[], finalText = chunks.join("")) => {
  const final = message(finalText);
  const stream = createAssistantMessageEventStream();

  stream.push({ type: "start", partial: final });
  stream.push({ type: "text_start", contentIndex: 0, partial: final });
  for (const delta of chunks) {
    stream.push({ type: "text_delta", contentIndex: 0, delta, partial: final });
  }
  stream.push({ type: "text_end", contentIndex: 0, content: finalText, partial: final });
  stream.push({ type: "done", reason: "stop", message: final });
  stream.end(final);

  return stream;
};

const collect = async (events: AsyncIterable<AnswerStreamEvent>) => {
  const collected: AnswerStreamEvent[] = [];

  for await (const event of events) {
    collected.push(event);
  }

  return collected;
};

const clientFor = (chunks: readonly string[], finalText = chunks.join("")) =>
  new PiAiClient({
    apiKey: "test-key",
    mainModelId: "glm-5.2",
    fastModelId: "glm-5-turbo",
    preflightMaxTurns: 4,
    preflightMaxSearches: 8,
    preflightMaxPeeks: 4,
    preflightTimeoutMs: 30_000,
    answerTimeoutMs: 120_000,
    boundary: {
      streamSimple: () => streamText(chunks, finalText),
    },
  });

describe("answer insufficiency prefix withholding", () => {
  it("withholds a split insufficiency tag", async () => {
    const events = await collect(
      clientFor(["[[ins", "ufficient:", " no filings]]"]).streamAnswer({
        systemPrompt: "answer",
        messages: [{ role: "user", content: "question" }],
      }),
    );

    expect(events.filter((event) => event.type === "text_delta")).toEqual([]);
    expect(events.at(-1)).toMatchObject({
      type: "result",
      result: { kind: "ok", value: { insufficiencyGap: "no filings" } },
    });
  });

  it("releases normal answers that begin with brackets but not the tag", async () => {
    const events = await collect(
      clientFor(["[[c", "ite:b1]] Supported."]).streamAnswer({
        systemPrompt: "answer",
        messages: [{ role: "user", content: "question" }],
      }),
    );

    expect(events.filter((event) => event.type === "text_delta")).toEqual([
      { type: "text_delta", delta: "[[cite:b1]] Supported." },
    ]);
  });

  it("treats an insufficiency tag with no gap text as the signal", async () => {
    const events = await collect(
      clientFor(["[[insufficient:]]"]).streamAnswer({
        systemPrompt: "answer",
        messages: [{ role: "user", content: "question" }],
      }),
    );

    expect(events.filter((event) => event.type === "text_delta")).toEqual([]);
    expect(events.at(-1)).toMatchObject({
      type: "result",
      result: { kind: "ok", value: { insufficiencyGap: "" } },
    });
  });

  it("releases withheld text at finalization for non-exact insufficiency text", async () => {
    const events = await collect(
      clientFor(["[[insufficient:", " almost]] plus answer"]).streamAnswer({
        systemPrompt: "answer",
        messages: [{ role: "user", content: "question" }],
      }),
    );

    expect(events.filter((event) => event.type === "text_delta")).toEqual([
      { type: "text_delta", delta: "[[insufficient: almost]] plus answer" },
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "result",
      result: { kind: "ok", value: { insufficiencyGap: null } },
    });
  });
});
