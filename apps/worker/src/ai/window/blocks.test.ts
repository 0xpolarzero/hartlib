import { describe, expect, it } from "vitest";
import { estimateTokens } from "../retrieval/query-spec";
import {
  formatBlockId,
  formatPublishedDate,
  parseBlockNumber,
  renderBlock,
  renderMemoryBody,
  type RenderableBlock,
} from "./blocks";

describe("blocks", () => {
  it("formats and parses block ids", () => {
    expect(parseBlockNumber(formatBlockId(1))).toBe(1);
    expect(parseBlockNumber(formatBlockId(10))).toBe(10);
    expect(parseBlockNumber(formatBlockId(999))).toBe(999);
    expect(parseBlockNumber("b10")).toBe(10);
    expect(parseBlockNumber("x1")).toBeNull();
    expect(parseBlockNumber("b")).toBeNull();
    expect(parseBlockNumber("")).toBeNull();
    expect(parseBlockNumber("b1.5")).toBeNull();
    expect(parseBlockNumber("b-2")).toBeNull();
    expect(parseBlockNumber("b01")).toBeNull();
    expect(parseBlockNumber("1")).toBeNull();
    expect(parseBlockNumber("B2")).toBeNull();
  });

  it("formats published dates", () => {
    expect(formatPublishedDate(new Date("2024-01-02T23:59:59.000Z"))).toBe("2024-01-02");
    expect(formatPublishedDate("2024-02-03T04:05:06.000Z")).toBe("2024-02-03");
    expect(formatPublishedDate(null)).toBe("unknown");
    expect(formatPublishedDate("not a date")).toBe("unknown");
  });

  it("renders document blocks", () => {
    const block: RenderableBlock = {
      blockId: "b2",
      kind: "document",
      content: "Document body",
      provenance: {
        documentId: "doc1",
        sourceId: "source1",
        sourceDisplayName: "Daily Brief",
        canonicalUrl: "https://example.com/doc1",
        title: "A Useful Article",
        publishedAt: null,
        charStart: null,
        charEnd: null,
      },
    };

    expect(renderBlock(block)).toBe(
      "[b2] document — Daily Brief — unknown — A Useful Article\nDocument body",
    );
  });

  it("renders memory blocks", () => {
    const content = renderMemoryBody([
      { id: "m1", kind: "preference", content: "Use concise answers." },
      { id: "m2", kind: "fact", content: "Works in TypeScript." },
    ]);
    const block: RenderableBlock = {
      blockId: "b3",
      kind: "memory",
      content,
      provenance: { memoryIds: ["m1", "m2"] },
    };

    expect(renderBlock(block)).toBe(
      "[b3] memory\n- (preference) Use concise answers.\n- (fact) Works in TypeScript.",
    );
  });

  it("throws when block kind and provenance do not match", () => {
    const block: RenderableBlock = {
      blockId: "b4",
      kind: "document",
      content: "Document body",
      provenance: { memoryIds: ["m1"] },
    };

    expect(() => renderBlock(block)).toThrow(Error);
  });

  it("renders memory bodies in input order", () => {
    expect(
      renderMemoryBody([
        { id: "m1", kind: "profile", content: "First" },
        { id: "m2", kind: "instruction", content: "Second" },
        { id: "m3", kind: "episode", content: "Third" },
      ]),
    ).toBe("- (profile) First\n- (instruction) Second\n- (episode) Third");
  });

  it("uses the shared token estimator", () => {
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(1)).toBe(1);
    expect(estimateTokens(4)).toBe(1);
    expect(estimateTokens(5)).toBe(2);
  });
});
