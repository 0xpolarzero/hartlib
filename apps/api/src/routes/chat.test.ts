import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  chatMessagesResponseFromRows,
  maxSendMessageBodyBytes,
  parseSendMessageBody,
  requestJsonWithLimit,
  type ContextBlockRow,
  type MessageRow,
} from "./chat";

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

const laterDocumentBlock: ContextBlockRow = {
  ...documentBlock,
  block_id: "b10",
  token_estimate: 80,
  provenance: {
    documentId: "doc-10",
    sourceId: "source-1",
    sourceDisplayName: "Source One",
    canonicalUrl: "https://source.example/doc-10",
    title: "Document Ten",
    publishedAt: "2026-07-08T10:00:00.000Z",
    charStart: null,
    charEnd: null,
  },
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
        kind: "document",
        label: "Source One",
        sourceDisplayName: "Source One",
        title: "Document One",
        canonicalUrl: "https://source.example/doc-1",
        publishedAt: "2026-07-08T10:00:00.000Z",
      },
      {
        blockId: "b2",
        kind: "memory",
        label: null,
        sourceDisplayName: null,
        title: null,
        canonicalUrl: null,
        publishedAt: null,
      },
    ]);
  });

  it("maps context block observations for an assistant message run", () => {
    const response = chatMessagesResponseFromRows(
      [assistantMessage],
      [documentBlock, memoryBlock, laterDocumentBlock],
      [
        {
          run_id: "run-1",
          kind: "context_block_added",
          payload: { blockId: "b2" },
          created_at: at("2026-07-09T09:00:03.000Z"),
        },
        {
          run_id: "run-1",
          kind: "context_block_added",
          payload: { blockId: "b10" },
          created_at: at("2026-07-09T09:00:04.000Z"),
        },
        {
          run_id: "run-1",
          kind: "context_block_added",
          payload: { blockId: "b1", label: "Custom label", tokenEstimate: 99 },
          created_at: at("2026-07-09T09:00:05.000Z"),
        },
      ],
    );

    expect(response[0]?.contextBlocks).toEqual([
      { blockId: "b1", kind: "document", label: "Custom label", tokenEstimate: 99 },
      { blockId: "b2", kind: "memory", label: null, tokenEstimate: 24 },
      { blockId: "b10", kind: "document", label: "Source One: Document Ten", tokenEstimate: 80 },
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

describe("parseSendMessageBody", () => {
  it("accepts only a strict text, locale, and market object", () => {
    expect(parseSendMessageBody({ text: " Explain this ", locale: "en-US", market: "US" })).toEqual(
      {
        ok: true,
        text: "Explain this",
        locale: "en-US",
        market: "US",
      },
    );

    expect(
      parseSendMessageBody({ text: "Explain this", locale: "en-US", market: "US", extra: true }),
    ).toEqual({ ok: false, error: "invalid_body" });
    expect(parseSendMessageBody({ text: "Explain this", locale: "en-US" })).toEqual({
      ok: false,
      error: "invalid_body",
    });
    expect(parseSendMessageBody({ text: "Explain this", locale: "en-US", market: 1 })).toEqual({
      ok: false,
      error: "invalid_body",
    });
  });
});

describe("requestJsonWithLimit", () => {
  it("rejects oversized Content-Length before parsing JSON", async () => {
    const request = new Request("http://brief.test/v1/chat/messages", {
      method: "POST",
      headers: { "content-length": String(maxSendMessageBodyBytes + 1) },
      body: "{",
    });

    await expect(Effect.runPromise(requestJsonWithLimit(request))).rejects.toThrow(
      "request_body_too_large",
    );
  });

  it("rejects bodies that exceed the bounded reader limit without Content-Length", async () => {
    const request = new Request("http://brief.test/v1/chat/messages", {
      method: "POST",
      body: JSON.stringify({
        text: "x".repeat(maxSendMessageBodyBytes),
        locale: "en-US",
        market: "US",
      }),
    });

    await expect(Effect.runPromise(requestJsonWithLimit(request))).rejects.toThrow(
      "request_body_too_large",
    );
  });
});
