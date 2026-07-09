import { describe, expect, it } from "vitest";

import { chatMessagesResponseFromRows, type ContextBlockRow, type MessageRow } from "./chat";

const at = (iso: string) => new Date(iso);

const documentBlock: ContextBlockRow = {
  block_id: "b1",
  kind: "document",
  token_estimate: 120,
  provenance: {
    documentId: "doc-1",
    sourceId: "source-1",
    sourceDisplayName: "Source One",
    canonicalUrl: "https://source.example/doc-1",
    title: "Document One",
    publishedAt: "2026-07-08T10:00:00.000Z",
    charStart: null,
    charEnd: null,
  },
};

const memoryBlock: ContextBlockRow = {
  block_id: "b2",
  kind: "memory",
  token_estimate: 24,
  provenance: { memoryIds: ["memory-1"] },
};

const userMessage: MessageRow = {
  id: "message-1",
  author: "user",
  content: "What changed?",
  ai_run_id: null,
  created_at: at("2026-07-09T09:00:00.000Z"),
};

const assistantMessage: MessageRow = {
  id: "message-2",
  author: "assistant",
  content: "It changed [[cite:b1]] and matches your preference [[cite:b2]].",
  ai_run_id: "run-1",
  created_at: at("2026-07-09T09:00:02.000Z"),
};

describe("chatMessagesResponseFromRows", () => {
  it("orders messages and resolves document and memory citations", () => {
    const response = chatMessagesResponseFromRows(
      [assistantMessage, userMessage],
      [documentBlock, memoryBlock],
      [
        {
          run_id: "run-1",
          kind: "citation",
          payload: { blockId: "b1", messageId: "message-2" },
          created_at: at("2026-07-09T09:00:03.000Z"),
        },
        {
          run_id: "run-1",
          kind: "citation",
          payload: { blockId: "b2", messageId: "message-2" },
          created_at: at("2026-07-09T09:00:04.000Z"),
        },
      ],
    );

    expect(response.map((message) => message.id)).toEqual(["message-1", "message-2"]);
    expect(response[1]?.content).toBe(assistantMessage.content);
    expect(response[1]?.citations).toEqual([
      {
        blockId: "b1",
        label: "Source One",
        title: "Document One",
        url: "https://source.example/doc-1",
        publishedAt: "2026-07-08T10:00:00.000Z",
      },
      {
        blockId: "b2",
        label: "saved-memory",
        title: "Saved memory",
        url: null,
        publishedAt: null,
      },
    ]);
  });

  it("maps context block observations for an assistant message run", () => {
    const response = chatMessagesResponseFromRows(
      [assistantMessage],
      [documentBlock, memoryBlock],
      [
        {
          run_id: "run-1",
          kind: "context_block_added",
          payload: { blockId: "b1", label: "Custom label", tokenEstimate: 99 },
          created_at: at("2026-07-09T09:00:03.000Z"),
        },
        {
          run_id: "run-1",
          kind: "context_block_added",
          payload: { blockId: "b2" },
          created_at: at("2026-07-09T09:00:04.000Z"),
        },
      ],
    );

    expect(response[0]?.contextBlocks).toEqual([
      { blockId: "b1", kind: "document", label: "Custom label", tokenEstimate: 99 },
      { blockId: "b2", kind: "memory", label: "saved user memories", tokenEstimate: 24 },
    ]);
  });

  it("leaves unknown citation tags as message text without resolved metadata", () => {
    const response = chatMessagesResponseFromRows(
      [
        {
          ...assistantMessage,
          content: "Unknown support [[cite:b999]]",
        },
      ],
      [documentBlock],
      [
        {
          run_id: "run-1",
          kind: "citation",
          payload: { blockId: "b999", messageId: "message-2" },
          created_at: at("2026-07-09T09:00:03.000Z"),
        },
      ],
    );

    expect(response[0]?.content).toBe("Unknown support [[cite:b999]]");
    expect(response[0]?.citations).toEqual([]);
  });
});
