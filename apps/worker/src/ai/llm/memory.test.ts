import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { prepareMemoryProposals } from "./memory";
import { PiAiClient } from "./pi-ai-client";
import type { ProposedMemory } from "./types";
import { zeroUsage } from "./types";

const recordMemoriesMessage = (memories: unknown): AssistantMessage => ({
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

describe("memory proposal preparation", () => {
  it("normalizes content and exactly deduplicates without a write cap", () => {
    const proposals: ProposedMemory[] = [
      { kind: "profile", content: "  Lives in Paris " },
      { kind: "preference", content: "Prefers short answers" },
      { kind: "fact", content: "Has VAT number FR123" },
      { kind: "instruction", content: "Use weekly summaries" },
      { kind: "episode", content: "Asked for an energy briefing" },
      { kind: "fact", content: "Works in energy" },
      { kind: "preference", content: "Prefers tables" },
      { kind: "profile", content: "Lives in Paris" },
      { kind: "fact", content: "   " },
    ];
    const result = prepareMemoryProposals(proposals, [
      { id: "existing-1", kind: "preference", content: "Prefers short answers" },
    ]);

    expect(result.accepted).toEqual([
      { kind: "profile", content: "Lives in Paris" },
      { kind: "fact", content: "Has VAT number FR123" },
      { kind: "instruction", content: "Use weekly summaries" },
      { kind: "episode", content: "Asked for an energy briefing" },
      { kind: "fact", content: "Works in energy" },
      { kind: "preference", content: "Prefers tables" },
    ]);
    expect(result.discarded.map((discarded) => discarded.reason)).toEqual([
      "duplicate",
      "duplicate",
      "empty_content",
    ]);
  });

  it("discards an invented update target before persistence", () => {
    const proposal: ProposedMemory = {
      kind: "fact",
      content: "Invented update",
      targetMemoryId: "not-a-memory-id",
    };

    expect(prepareMemoryProposals([proposal], [])).toEqual({
      accepted: [],
      discarded: [{ proposal, reason: "unknown_target" }],
    });
  });

  it("extractMemories forces record_memories and prepares the returned proposals", async () => {
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
      boundary: {
        complete: async () =>
          recordMemoriesMessage([
            { kind: "profile", content: "Based in Lyon" },
            {
              kind: "instruction",
              content: "Keep examples in TypeScript",
            },
            { kind: "preference", content: "Prefers concise examples" },
          ]),
      },
    });
    const result = await client.extractMemories({
      userText,
      existingMemories: [{ id: "memory-1", kind: "profile", content: "Based in Lyon" }],
    });

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") {
      throw new Error("expected ok");
    }
    expect(result.value.proposals).toEqual([
      {
        kind: "instruction",
        content: "Keep examples in TypeScript",
      },
      { kind: "preference", content: "Prefers concise examples" },
    ]);
    expect(result.value.discarded).toMatchObject([{ reason: "duplicate" }]);
  });

  it("extractMemories discards a malformed record_memories output without failing the run", async () => {
    const client = new PiAiClient({
      apiKey: "test-key",
      mainModelId: "glm-5.2",
      fastModelId: "glm-5-turbo",
      preflightMaxTurns: 4,
      preflightMaxSearches: 8,
      preflightMaxPeeks: 4,
      preflightTimeoutMs: 30_000,
      answerTimeoutMs: 120_000,
      boundary: {
        complete: async () =>
          recordMemoriesMessage([
            { kind: "profile", content: "Based in Lyon" },
            { kind: "instruction" },
          ]),
      },
    });
    const result = await client.extractMemories({
      userText: "I am based in Lyon. Please keep examples in TypeScript.",
      existingMemories: [],
    });

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") {
      throw new Error("expected ok");
    }
    expect(result.value.proposals).toEqual([]);
    expect(result.value.discarded).toEqual([]);
  });
});
