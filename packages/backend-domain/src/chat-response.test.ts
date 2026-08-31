import { describe, expect, it } from "vitest";

import type { MessageRow, RunRow, SourceRow, SourceUseRow } from "./chat-runtime";
import { chatMessagesResponseFromRows } from "./chat-response";

const namespace = "cn_" + "A".repeat(22);
const runId = "00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000002";
const assistantId = "00000000-0000-4000-8000-000000000003";
const sourceKey = `k_${namespace}_1`;
const url = "https://example.com/evidence";

const messages: readonly MessageRow[] = [
  {
    id: userId,
    chat_id: "00000000-0000-4000-8000-000000000004",
    author: "user",
    content: "Question",
    created_at: new Date("2026-01-01T00:00:00.000Z"),
  },
  {
    id: assistantId,
    chat_id: "00000000-0000-4000-8000-000000000004",
    author: "assistant",
    content: `Answer [[cite:${sourceKey}]]`,
    created_at: new Date("2026-01-01T00:00:02.000Z"),
  },
];

const run = (status: "succeeded" | "stopped"): RunRow => ({
  id: runId,
  chat_id: "00000000-0000-4000-8000-000000000004",
  user_message_id: userId,
  assistant_message_id: status === "succeeded" ? assistantId : null,
  started_at: new Date("2026-01-01T00:00:01.000Z"),
  finished_at: status === "succeeded" ? new Date("2026-01-01T00:00:03.000Z") : null,
  failed_at: null,
  stopped_at: status === "stopped" ? new Date("2026-01-01T00:00:03.000Z") : null,
  superseded_at: null,
  error_code: null,
  retryable: null,
});
const source: SourceRow = {
  run_id: runId,
  assistant_message_id: assistantId,
  source_key: sourceKey,
  citation_namespace: namespace,
  kind: "web",
  locator: {
    kind: "web",
    title: "Evidence",
    domain: "example.com",
    url,
    capturedAt: "2026-01-01T00:00:01Z",
    quote: "Evidence",
    quoteHash: "A4Z66nCsr0xdzjenbPWgTasXFtb_cL8DdhxDnaqL6YQ",
  },
  display_label: null,
  public_provenance: { citationUrl: url },
  source_identity_digest: "0".repeat(64),
  source_identity_valid: true,
};

const use: SourceUseRow = {
  run_id: runId,
  assistant_message_id: assistantId,
  source_key: sourceKey,
  consumer_task_id: "single-answer",
  topic_id: null,
  rendered_token_count: 1,
  context_order: 0,
  ranges: [],
  source_use_identity_digest: "0".repeat(64),
  source_use_identity_valid: true,
};

describe("chat response projection", () => {
  it("projects a strict citation with a server quote", () => {
    const result = chatMessagesResponseFromRows(messages, [run("succeeded")], [source], [use]);
    const assistant = result.find((message) => message.author === "assistant");
    expect(assistant?.citations).toEqual([
      expect.objectContaining({ sourceKey, quote: { text: "Evidence" } }),
    ]);
  });

  it("projects stopped user runs and retains orphaned evidence without leaking it", () => {
    const stopped = chatMessagesResponseFromRows(messages.slice(0, 1), [run("stopped")], [], []);
    expect(stopped[0]).toMatchObject({ run: { id: runId, status: "stopped" } });

    const orphaned = chatMessagesResponseFromRows(
      messages.slice(0, 1),
      [run("succeeded")],
      [{ ...source, assistant_message_id: null }],
      [{ ...use, assistant_message_id: null }],
    );
    expect(orphaned).toHaveLength(1);
  });

  it("keeps a cited chat source visible with an unavailable quote after source deletion", () => {
    const chatSource: SourceRow = {
      ...source,
      kind: "chat_message",
      locator: { kind: "chat_message", messageId: userId },
      public_provenance: {},
      message_id: null,
    };
    const chatUse: SourceUseRow = {
      ...use,
      ranges: [{ charStart: 0, charEnd: 8 }],
    };
    const result = chatMessagesResponseFromRows(
      messages.slice(1),
      [{ ...run("succeeded"), user_message_id: null }],
      [chatSource],
      [chatUse],
    );
    const assistant = result.find((message) => message.author === "assistant");
    expect(assistant?.sourcesRead).toEqual([
      expect.objectContaining({ sourceKey, messageId: userId }),
    ]);
    expect(assistant?.citations).toEqual([expect.objectContaining({ sourceKey, quote: null })]);
  });

  it("accepts the topic and synthesis consumers used by a fanout answer", () => {
    const topicUse: SourceUseRow = {
      ...use,
      consumer_task_id: "topic-t1-answer",
      topic_id: "t1",
      context_order: 0,
    };
    const synthesisUse: SourceUseRow = {
      ...use,
      consumer_task_id: "fanout-synthesis",
      topic_id: null,
      context_order: 0,
    };
    const result = chatMessagesResponseFromRows(
      messages,
      [run("succeeded")],
      [source],
      [topicUse, synthesisUse],
    );
    const assistant = result.find((message) => message.author === "assistant");
    expect(assistant?.sourcesRead).toEqual([
      expect.objectContaining({ sourceKey, topicIds: ["t1"], tokenCount: 2 }),
    ]);
  });
});
