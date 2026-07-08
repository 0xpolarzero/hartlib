import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { verifyMemoryProposals } from "./memory";
import { PiAiClient } from "./pi-ai-client";
import type { ProposedMemory } from "./types";
import { zeroUsage } from "./types";

const recordMemoriesMessage = (memories: readonly ProposedMemory[]): AssistantMessage => ({
  role: "assistant",
  content: [
    {
      type: "toolCall",
      id: "record",
      name: "record_memories",
      arguments: { memories },
    },
  ],
  api: "openai-completions",
  provider: "zai",
  model: "glm-5-turbo",
  usage: zeroUsage(),
  stopReason: "toolUse",
  timestamp: Date.now(),
});

describe("memory proposal verification", () => {
  it("accepts quoted memories, rejects unquoted ones, caps writes, and deduplicates", () => {
    const userText =
      "I live in Paris. I prefer short answers. My VAT number is FR123. I like weekly summaries.";
    const proposals: ProposedMemory[] = [
      { kind: "profile", content: "Lives in Paris", evidenceQuote: "I live in Paris" },
      { kind: "preference", content: "Prefers short answers", evidenceQuote: "short answers" },
      { kind: "fact", content: "Has VAT number FR123", evidenceQuote: "FR123" },
      { kind: "instruction", content: "Use weekly summaries", evidenceQuote: "weekly summaries" },
      { kind: "episode", content: "Asked about copied text", evidenceQuote: "not user text" },
      { kind: "profile", content: "Lives in Paris", evidenceQuote: "I live in Paris" },
    ];
    const result = verifyMemoryProposals(
      proposals,
      userText,
      [{ id: "existing-1", kind: "preference", content: "Prefers short answers" }],
      2,
    );

    expect(result.accepted).toEqual([
      { kind: "profile", content: "Lives in Paris", evidenceQuote: "I live in Paris" },
      { kind: "fact", content: "Has VAT number FR123", evidenceQuote: "FR123" },
    ]);
    expect(result.discarded.map((discarded) => discarded.reason)).toEqual([
      "duplicate",
      "write_cap",
      "invalid_quote",
      "duplicate",
    ]);
  });

  it("extractMemories forces record_memories and verifies the returned proposals", async () => {
    const userText = "I am based in Lyon. Please keep examples in TypeScript.";
    const client = new PiAiClient({
      apiKey: "test-key",
      mainModelId: "glm-5.2",
      fastModelId: "glm-5-turbo",
      preflightMaxTurns: 4,
      preflightMaxSearches: 8,
      preflightMaxPeeks: 4,
      preflightTimeoutMs: 30_000,
      answerTimeoutMs: 120_000,
      memoryMaxWritesPerTurn: 5,
      boundary: {
        complete: async () =>
          recordMemoriesMessage([
            { kind: "profile", content: "Based in Lyon", evidenceQuote: "based in Lyon" },
            {
              kind: "instruction",
              content: "Keep examples in TypeScript",
              evidenceQuote: "examples in TypeScript",
            },
            { kind: "fact", content: "Read a source article", evidenceQuote: "source article" },
          ]),
      },
    });
    const result = await client.extractMemories({ userText, existingMemories: [] });

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") {
      throw new Error("expected ok");
    }
    expect(result.value.proposals).toEqual([
      { kind: "profile", content: "Based in Lyon", evidenceQuote: "based in Lyon" },
      {
        kind: "instruction",
        content: "Keep examples in TypeScript",
        evidenceQuote: "examples in TypeScript",
      },
    ]);
    expect(result.value.discarded).toMatchObject([{ reason: "invalid_quote" }]);
  });
});
