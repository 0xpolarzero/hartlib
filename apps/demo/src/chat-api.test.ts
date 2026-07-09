import { describe, expect, it } from "vitest";

import { mapApiMessagesToTranscript, type ChatApiMessage } from "./chat-api";

describe("mapApiMessagesToTranscript", () => {
  it("maps API payload messages to transcript messages", () => {
    const messages: readonly ChatApiMessage[] = [
      {
        id: "m1",
        author: "user",
        content: "Question",
        createdAt: "2026-07-09T05:00:00.000Z",
      },
      {
        id: "m2",
        author: "assistant",
        content: "Réponse [[cite:b1]]",
        createdAt: "2026-07-09T05:01:00.000Z",
        citations: [
          {
            blockId: "b1",
            label: "Journal officiel",
            sourceDisplayName: "Journal officiel",
            title: "Décret",
            canonicalUrl: "https://example.test/decret",
            publishedAt: "2026-07-01T00:00:00.000Z",
          },
        ],
        contextBlocks: [
          {
            blockId: "b1",
            kind: "document",
            label: "Journal officiel: Décret",
            tokenEstimate: 128,
          },
        ],
      },
    ];

    expect(mapApiMessagesToTranscript(messages)).toEqual([
      {
        id: "m1",
        author: "user",
        content: "Question",
        citations: [],
        contextBlocks: [],
      },
      {
        id: "m2",
        author: "assistant",
        content: "Réponse [[cite:b1]]",
        citations: [
          {
            id: "b1",
            label: "Journal officiel",
            url: "https://example.test/decret",
            publishedAt: "2026-07-01T00:00:00.000Z",
            title: "Décret",
            sourceDisplayName: "Journal officiel",
          },
        ],
        contextBlocks: [
          {
            blockId: "b1",
            kind: "document",
            label: "Journal officiel: Décret",
            tokenEstimate: 128,
          },
        ],
      },
    ]);
  });

  it("maps memory citations with null urls", () => {
    const messages: readonly ChatApiMessage[] = [
      {
        id: "m1",
        author: "assistant",
        content: "Préférence mémorisée [[cite:b2]]",
        createdAt: "2026-07-09T05:01:00.000Z",
        citations: [
          {
            blockId: "b2",
            label: "saved-memory",
            sourceDisplayName: null,
            title: "Saved memory",
            canonicalUrl: null,
            publishedAt: null,
          },
        ],
        contextBlocks: [
          {
            blockId: "b2",
            kind: "memory",
            label: "saved user memories",
            tokenEstimate: 24,
          },
        ],
      },
    ];

    expect(mapApiMessagesToTranscript(messages)[0]?.citations?.[0]).toEqual({
      id: "b2",
      label: "saved-memory",
      url: null,
      publishedAt: null,
      title: "Saved memory",
      sourceDisplayName: null,
    });
  });
});
