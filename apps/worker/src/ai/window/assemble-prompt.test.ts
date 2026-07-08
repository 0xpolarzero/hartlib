import { describe, expect, it } from "vitest";
import { renderBlock, type RenderableBlock } from "./blocks";
import { assembleContextWindow, type ChatHistoryMessage } from "./assemble-prompt";

const documentBlock = (blockId: string, content: string): RenderableBlock => ({
  blockId,
  kind: "document",
  content,
  provenance: {
    documentId: `doc-${blockId}`,
    sourceId: `source-${blockId}`,
    sourceDisplayName: `Source ${blockId}`,
    canonicalUrl: `https://example.com/${blockId}`,
    title: `Title ${blockId}`,
    publishedAt: "2024-01-02T03:04:05.000Z",
    charStart: null,
    charEnd: null,
  },
});

const memoryBlock = (blockId: string, content: string): RenderableBlock => ({
  blockId,
  kind: "memory",
  content,
  provenance: { memoryIds: [`memory-${blockId}`] },
});

const history: readonly ChatHistoryMessage[] = [
  { author: "user", content: "u1" },
  { author: "assistant", content: "a1" },
  { author: "user", content: "u2" },
];

describe("assembleContextWindow", () => {
  it("assembles the full system string in spec order", () => {
    const memory = memoryBlock("b9", "- (fact) Remember this");
    const doc2 = documentBlock("b2", "Doc two");
    const doc10 = documentBlock("b10", "Doc ten");
    const result = assembleContextWindow({
      systemPrompt: "System",
      memoryBlock: memory,
      blocks: [doc10, doc2],
      history: [],
      userMessage: "Current",
      historyMaxMessages: 10,
    });

    expect(result.system).toBe(
      ["System", renderBlock(memory), renderBlock(doc2), renderBlock(doc10)].join("\n\n"),
    );
  });

  it("renders a higher-id memory block in slot two and sorts document blocks numerically", () => {
    const memory = memoryBlock("b99", "- (preference) Keep it short");
    const doc2 = documentBlock("b2", "Doc two");
    const doc10 = documentBlock("b10", "Doc ten");
    const result = assembleContextWindow({
      systemPrompt: "System",
      memoryBlock: memory,
      blocks: [doc10, doc2],
      history: [],
      userMessage: "Current",
      historyMaxMessages: 10,
    });

    expect(result.system).toBe(
      ["System", renderBlock(memory), renderBlock(doc2), renderBlock(doc10)].join("\n\n"),
    );
  });

  it("keeps only the most recent history messages before the current user message", () => {
    const result = assembleContextWindow({
      systemPrompt: "System",
      memoryBlock: null,
      blocks: [],
      history,
      userMessage: "Current",
      historyMaxMessages: 2,
    });

    expect(result.messages).toEqual([
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
      { role: "user", content: "Current" },
    ]);
  });

  it("preserves author mapping and chronological order", () => {
    const result = assembleContextWindow({
      systemPrompt: "System",
      memoryBlock: null,
      blocks: [],
      history,
      userMessage: "Current",
      historyMaxMessages: 10,
    });

    expect(result.messages).toEqual([
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
      { role: "user", content: "Current" },
    ]);
  });

  it("omits the memory slot when memoryBlock is null", () => {
    const doc = documentBlock("b2", "Doc two");
    const result = assembleContextWindow({
      systemPrompt: "System",
      memoryBlock: null,
      blocks: [doc],
      history: [],
      userMessage: "Current",
      historyMaxMessages: 10,
    });

    expect(result.system).toBe(["System", renderBlock(doc)].join("\n\n"));
  });

  it("excludes memory-kind blocks passed inside blocks", () => {
    const doc = documentBlock("b2", "Doc two");
    const strayMemory = memoryBlock("b1", "- (fact) Stray");
    const result = assembleContextWindow({
      systemPrompt: "System",
      memoryBlock: null,
      blocks: [strayMemory, doc],
      history: [],
      userMessage: "Current",
      historyMaxMessages: 10,
    });

    expect(result.system).toBe(["System", renderBlock(doc)].join("\n\n"));
  });

  it("assembles an empty context with only history tail and current user message", () => {
    const result = assembleContextWindow({
      systemPrompt: "System",
      memoryBlock: null,
      blocks: [],
      history,
      userMessage: "Current",
      historyMaxMessages: 1,
    });

    expect(result.system).toBe("System");
    expect(result.messages).toEqual([
      { role: "user", content: "u2" },
      { role: "user", content: "Current" },
    ]);
  });
});
