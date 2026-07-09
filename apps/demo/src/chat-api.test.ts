import { describe, expect, it } from "vitest";

import { mapApiMessagesToTranscript, type ChatApiMessage } from "./chat-api";

const labels = {
  memoryBlockLabel: "Localized memories",
  memoryCitation: "Localized memory",
};

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
            kind: "document",
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

    expect(mapApiMessagesToTranscript(messages, labels)).toEqual([
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
            kind: "memory",
            label: null,
            sourceDisplayName: null,
            title: null,
            canonicalUrl: null,
            publishedAt: null,
          },
        ],
        contextBlocks: [
          {
            blockId: "b2",
            kind: "memory",
            label: null,
            tokenEstimate: 24,
          },
        ],
      },
    ];

    const transcript = mapApiMessagesToTranscript(messages, labels);

    expect(transcript[0]?.citations?.[0]).toEqual({
      id: "b2",
      label: "Localized memory",
      url: null,
      publishedAt: null,
      title: "Localized memory",
      sourceDisplayName: null,
    });
    expect(transcript[0]?.contextBlocks?.[0]).toEqual({
      blockId: "b2",
      kind: "memory",
      label: "Localized memories",
      tokenEstimate: 24,
    });
  });
});
