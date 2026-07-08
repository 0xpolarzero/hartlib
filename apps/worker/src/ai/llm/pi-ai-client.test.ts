import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage, ToolCall, Usage } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";

import { PiAiClient, type RetrievalExecutor } from "./pi-ai-client";
import type { PreflightOutput } from "./types";
import { zeroUsage } from "./types";

const usage: Usage = zeroUsage();

const assistantMessage = (
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "toolUse",
): AssistantMessage => ({
  role: "assistant",
  content,
  api: "openai-completions",
  provider: "zai",
  model: "glm-5-turbo",
  usage,
  stopReason,
  timestamp: Date.now(),
});

const toolCall = (name: string, args: Record<string, unknown>, id = name): ToolCall => ({
  type: "toolCall",
  id,
  name,
  arguments: args,
});

const streamFor = (message: AssistantMessage) => {
  const stream = createAssistantMessageEventStream();

  stream.push({ type: "start", partial: message });
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    stream.push({ type: "error", reason: message.stopReason, error: message });
  } else {
    stream.push({ type: "done", reason: message.stopReason, message });
  }
  stream.end(message);

  return stream;
};

const scriptedStreamFn = (messages: readonly AssistantMessage[]) => {
  const queue = [...messages];
  let calls = 0;
  const streamFn: StreamFn = () => {
    calls += 1;
    return streamFor(queue.shift() ?? assistantMessage([], "stop"));
  };

  return { streamFn, calls: () => calls };
};

const retrieval = (): RetrievalExecutor => ({
  searchDocuments: async (spec) => [
    {
      documentId: `doc-${spec.terms}`,
      title: "Title",
      sourceDisplayName: "Source",
      publishedAt: null,
      language: "en-US",
      documentType: "article",
      textCharCount: 20,
      estimatedTokens: 5,
      snippet: "snippet",
    },
  ],
  peekDocument: async (documentId, offsetChars = 0, lengthChars = 10) => ({
    documentId,
    text: "0123456789",
    offsetChars,
    lengthChars,
    textCharCount: 10,
  }),
});

const client = (
  streamFn: StreamFn,
  overrides: Partial<ConstructorParameters<typeof PiAiClient>[0]> = {},
) =>
  new PiAiClient({
    apiKey: "test-key",
    mainModelId: "glm-5.2",
    fastModelId: "glm-5-turbo",
    preflightMaxTurns: 4,
    preflightMaxSearches: 8,
    preflightMaxPeeks: 4,
    preflightTimeoutMs: 30_000,
    answerTimeoutMs: 120_000,
    memoryMaxWritesPerTurn: 5,
    retrieval: retrieval(),
    boundary: {
      preflightStreamFn: streamFn,
      complete: async () => assistantMessage([toolCall("emit_manifest", { entries: [] })]),
    },
    ...overrides,
  });

const preflightInputs = {
  systemPrompt: "preflight",
  sourceCatalog: [],
  today: "2026-07-09",
  market: "US",
  locale: "en-US",
  standingWindow: [],
  memories: [],
  history: [],
  userMessage: "question",
  remainingBlockBudget: 1000,
} as const;

const toolContext = {
  access: { kind: "allPublicSources" },
  maxSearchLimit: 20,
  recencyHalfLifeDays: 14,
} as const;

const ok = (result: Awaited<ReturnType<PiAiClient["runPreflight"]>>): PreflightOutput => {
  expect(result.kind).toBe("ok");
  if (result.kind !== "ok") {
    throw new Error("expected ok");
  }

  return result.value;
};

describe("PiAiClient preflight", () => {
  it("rejects emit_manifest batches and keeps the first valid manifest", async () => {
    const script = scriptedStreamFn([
      assistantMessage([
        toolCall("emit_manifest", { entries: [{ documentId: "batched" }] }, "emit-1"),
        toolCall("search_documents", { terms: "budget" }, "search-1"),
      ]),
      assistantMessage([
        toolCall("emit_manifest", { entries: [{ documentId: "doc-1", charStart: 0 }] }, "emit-2"),
      ]),
      assistantMessage([
        toolCall("emit_manifest", { entries: [{ documentId: "doc-2" }] }, "emit-3"),
      ]),
    ]);
    const output = ok(await client(script.streamFn).runPreflight(preflightInputs, toolContext));

    expect(output.manifest).toEqual([{ documentId: "doc-1", charStart: 0 }]);
    expect(output.toolEvents.filter((event) => event.type === "search")).toHaveLength(0);
    expect(output.toolEvents.filter((event) => event.type === "tool_rejected")).toHaveLength(2);
    expect(script.calls()).toBe(2);
  });

  it("respects the turn cap and degrades through a forced manifest", async () => {
    const script = scriptedStreamFn([
      assistantMessage([toolCall("search_documents", { terms: "alpha" })]),
      assistantMessage([toolCall("emit_manifest", { entries: [{ documentId: "too-late" }] })]),
    ]);
    const output = ok(
      await client(script.streamFn, {
        preflightMaxTurns: 1,
        boundary: {
          preflightStreamFn: script.streamFn,
          complete: async () =>
            assistantMessage([toolCall("emit_manifest", { entries: [{ documentId: "forced" }] })]),
        },
      }).runPreflight(preflightInputs, toolContext),
    );

    expect(output.manifest).toEqual([{ documentId: "forced" }]);
    expect(output.toolEvents).toEqual(
      expect.arrayContaining([{ type: "degraded", reason: "forced_manifest" }]),
    );
    expect(script.calls()).toBe(1);
  });

  it("enforces search and peek caps across a parallel tool batch", async () => {
    const script = scriptedStreamFn([
      assistantMessage([
        toolCall("search_documents", { terms: "one" }, "s1"),
        toolCall("search_documents", { terms: "two" }, "s2"),
        toolCall("peek_document", { documentId: "doc-1" }, "p1"),
        toolCall("peek_document", { documentId: "doc-2" }, "p2"),
      ]),
      assistantMessage([toolCall("emit_manifest", { entries: [{ documentId: "done" }] })]),
    ]);
    const output = ok(
      await client(script.streamFn, {
        preflightMaxSearches: 1,
        preflightMaxPeeks: 1,
      }).runPreflight(preflightInputs, toolContext),
    );

    expect(output.manifest).toEqual([{ documentId: "done" }]);
    expect(output.toolEvents.filter((event) => event.type === "search")).toHaveLength(1);
    expect(output.toolEvents.filter((event) => event.type === "peek")).toHaveLength(1);
    expect(output.toolEvents.filter((event) => event.type === "tool_rejected")).toHaveLength(2);
  });

  it("falls back to an empty delta when forced manifest also fails", async () => {
    const script = scriptedStreamFn([assistantMessage([], "stop")]);
    const output = ok(
      await client(script.streamFn, {
        preflightMaxTurns: 1,
        boundary: {
          preflightStreamFn: script.streamFn,
          complete: async () => assistantMessage([{ type: "text", text: "no manifest" }], "stop"),
        },
      }).runPreflight(preflightInputs, toolContext),
    );

    expect(output.manifest).toEqual([]);
    expect(output.toolEvents).toEqual(
      expect.arrayContaining([
        { type: "degraded", reason: "forced_manifest" },
        { type: "degraded", reason: "empty_delta" },
      ]),
    );
  });

  it("treats an invalid manifest schema as a failed turn before degrading", async () => {
    const script = scriptedStreamFn([
      assistantMessage([toolCall("emit_manifest", { wrong: true })]),
      assistantMessage([{ type: "text", text: "still no manifest" }], "stop"),
    ]);
    const output = ok(
      await client(script.streamFn, {
        preflightMaxTurns: 2,
        boundary: {
          preflightStreamFn: script.streamFn,
          complete: async () => assistantMessage([{ type: "text", text: "no manifest" }], "stop"),
        },
      }).runPreflight(preflightInputs, toolContext),
    );

    expect(output.manifest).toEqual([]);
    expect(script.calls()).toBe(2);
    expect(output.toolEvents).toEqual(
      expect.arrayContaining([{ type: "degraded", reason: "empty_delta" }]),
    );
  });
});
