import { describe, expect, it } from "vitest";
import { formatBlockId, renderMemoryBody, type DocumentMeta, type ManifestEntry } from "./blocks";
import {
  planWindow,
  remainingBlockBudget,
  type ActiveBlock,
  type PlanWindowInput,
  type WindowBudget,
} from "./plan-window";

const budget: WindowBudget = { blockBudget: 100, hardCap: 150, fullDocMaxChars: 100 };

const docMeta = (documentId: string, textCharCount: number): DocumentMeta => ({
  documentId,
  sourceId: `source-${documentId}`,
  sourceDisplayName: `Source ${documentId}`,
  canonicalUrl: `https://example.com/${documentId}`,
  title: `Title ${documentId}`,
  publishedAt: null,
  textCharCount,
});

const activeBlock = (overrides: Partial<ActiveBlock>): ActiveBlock => ({
  blockId: "b1",
  kind: "document",
  content: "",
  tokenEstimate: 10,
  documentId: "doc1",
  charStart: null,
  charEnd: null,
  pinned: false,
  ...overrides,
});

const entry = (documentId: string, charStart?: number, charEnd?: number): ManifestEntry => ({
  documentId,
  ...(charStart === undefined ? {} : { charStart }),
  ...(charEnd === undefined ? {} : { charEnd }),
});

const documentsMap = (...documents: readonly DocumentMeta[]): ReadonlyMap<string, DocumentMeta> =>
  new Map(documents.map((document) => [document.documentId, document]));

const plan = (overrides: Partial<PlanWindowInput>) =>
  planWindow({
    manifest: [],
    documents: documentsMap(),
    activeBlocks: [],
    nextBlockNumber: 1,
    memories: [],
    budget,
    ...overrides,
  });

const only = <T>(items: readonly T[]): T => {
  expect(items).toHaveLength(1);
  const item = items[0];

  if (item === undefined) {
    throw new Error("missing item");
  }

  return item;
};

describe("planWindow id monotonicity", () => {
  it("assigns memory the first fresh id and documents after it", () => {
    const result = plan({
      manifest: [entry("docA"), entry("docB")],
      documents: documentsMap(docMeta("docA", 40), docMeta("docB", 40)),
      activeBlocks: [
        activeBlock({ blockId: "b2", kind: "memory", content: "old", documentId: null }),
      ],
      nextBlockNumber: 7,
      memories: [{ id: "m1", kind: "fact", content: "new" }],
    });

    expect(result.memory.kind).toBe("append");
    expect(result.memory.kind === "append" ? result.memory.block.blockId : null).toBe("b7");
    expect(result.additions.map((addition) => addition.blockId)).toEqual(["b8", "b9"]);
  });

  it("does not consume ids for duplicates and dropped entries", () => {
    const result = plan({
      manifest: [entry("dup"), entry("docA"), entry("missing"), entry("docB")],
      documents: documentsMap(docMeta("dup", 40), docMeta("docA", 40), docMeta("docB", 40)),
      activeBlocks: [
        activeBlock({ blockId: "b1", documentId: "dup", charStart: null, charEnd: null }),
      ],
      nextBlockNumber: 5,
    });

    expect(result.duplicates).toHaveLength(1);
    expect(result.dropped).toEqual([
      {
        documentId: "missing",
        charStart: null,
        charEnd: null,
        tokenEstimate: null,
        reason: "document_not_found",
      },
    ]);
    expect(result.additions.map((addition) => addition.blockId)).toEqual(["b5", "b6"]);
  });

  it("uses nextBlockNumber for the first accepted document when memory is unchanged", () => {
    const memories = [{ id: "m1", kind: "preference" as const, content: "Brief answers" }];
    const result = plan({
      manifest: [entry("docA")],
      documents: documentsMap(docMeta("docA", 40)),
      activeBlocks: [
        activeBlock({
          blockId: "b4",
          kind: "memory",
          content: renderMemoryBody(memories),
          documentId: null,
        }),
      ],
      nextBlockNumber: 9,
      memories,
    });

    expect(only(result.additions).blockId).toBe(formatBlockId(9));
  });
});

describe("planWindow containment dedup", () => {
  it("marks the exact same document range as an active block duplicate", () => {
    const result = plan({
      manifest: [entry("docA", 20, 80)],
      documents: documentsMap(docMeta("docA", 200)),
      activeBlocks: [
        activeBlock({ blockId: "b3", documentId: "docA", charStart: 20, charEnd: 80 }),
      ],
    });

    expect(result.duplicates).toEqual([
      { documentId: "docA", charStart: 20, charEnd: 80, coveredByBlockId: "b3" },
    ]);
  });

  it("marks a range inside an active whole document block as duplicate", () => {
    const result = plan({
      manifest: [entry("docA", 10, 50)],
      documents: documentsMap(docMeta("docA", 200)),
      activeBlocks: [
        activeBlock({ blockId: "b3", documentId: "docA", charStart: null, charEnd: null }),
      ],
    });

    expect(only(result.duplicates).coveredByBlockId).toBe("b3");
  });

  it("marks a range strictly inside an active range block as duplicate", () => {
    const result = plan({
      manifest: [entry("docA", 20, 40)],
      documents: documentsMap(docMeta("docA", 200)),
      activeBlocks: [
        activeBlock({ blockId: "b3", documentId: "docA", charStart: 10, charEnd: 50 }),
      ],
    });

    expect(result.duplicates).toEqual([
      { documentId: "docA", charStart: 20, charEnd: 40, coveredByBlockId: "b3" },
    ]);
  });

  it("marks a short whole-document candidate covered by an active full range as duplicate", () => {
    const result = plan({
      manifest: [entry("docA", 10, 20)],
      documents: documentsMap(docMeta("docA", 80)),
      activeBlocks: [activeBlock({ blockId: "b3", documentId: "docA", charStart: 0, charEnd: 80 })],
    });

    expect(result.duplicates).toEqual([
      { documentId: "docA", charStart: null, charEnd: null, coveredByBlockId: "b3" },
    ]);
  });

  it("does not deduplicate a partial overlap", () => {
    const result = plan({
      manifest: [entry("docA", 50, 150)],
      documents: documentsMap(docMeta("docA", 200)),
      activeBlocks: [activeBlock({ documentId: "docA", charStart: 0, charEnd: 100 })],
    });

    expect(result.duplicates).toHaveLength(0);
    expect(only(result.additions).charStart).toBe(50);
  });

  it("does not deduplicate a candidate superset", () => {
    const result = plan({
      manifest: [entry("docA", 0, 200)],
      documents: documentsMap(docMeta("docA", 200)),
      activeBlocks: [activeBlock({ documentId: "docA", charStart: 50, charEnd: 100 })],
    });

    expect(result.duplicates).toHaveLength(0);
    expect(only(result.additions).charEnd).toBe(200);
  });

  it("does not deduplicate the same range on a different document", () => {
    const result = plan({
      manifest: [entry("docB", 0, 100)],
      documents: documentsMap(docMeta("docB", 200)),
      activeBlocks: [activeBlock({ documentId: "docA", charStart: 0, charEnd: 100 })],
    });

    expect(result.duplicates).toHaveLength(0);
    expect(only(result.additions).documentId).toBe("docB");
  });

  it("deduplicates only contained intra-manifest entries", () => {
    const result = plan({
      manifest: [
        entry("docA", 0, 100),
        entry("docA", 0, 100),
        entry("docA", 20, 40),
        entry("docA", 80, 140),
      ],
      documents: documentsMap(docMeta("docA", 200)),
    });

    expect(result.additions.map((addition) => [addition.charStart, addition.charEnd])).toEqual([
      [0, 100],
      [80, 140],
    ]);
    expect(result.duplicates).toEqual([
      { documentId: "docA", charStart: 0, charEnd: 100, coveredByBlockId: null },
      { documentId: "docA", charStart: 20, charEnd: 40, coveredByBlockId: null },
    ]);
  });
});

describe("planWindow long-document rule", () => {
  it("includes short documents whole and ignores explicit ranges", () => {
    const result = plan({
      manifest: [entry("docA", 10, 20)],
      documents: documentsMap(docMeta("docA", 80)),
    });
    const addition = only(result.additions);

    expect(addition.charStart).toBeNull();
    expect(addition.charEnd).toBeNull();
    expect(addition.bodyCharCount).toBe(80);
    expect(addition.tokenEstimate).toBe(20);
    expect(addition.truncated).toBe(false);
  });

  it("honors long document ranges without capping them", () => {
    const result = plan({
      manifest: [entry("docA", 0, 300)],
      documents: documentsMap(docMeta("docA", 1_000)),
    });
    const addition = only(result.additions);

    expect(addition.charStart).toBe(0);
    expect(addition.charEnd).toBe(300);
    expect(addition.bodyCharCount).toBe(300);
    expect(addition.tokenEstimate).toBe(75);
    expect(addition.truncated).toBe(false);
  });

  it("uses a truncated leading range for long documents without ranges", () => {
    const result = plan({
      manifest: [entry("docA")],
      documents: documentsMap(docMeta("docA", 200)),
    });
    const addition = only(result.additions);

    expect(addition.charStart).toBe(0);
    expect(addition.charEnd).toBe(100);
    expect(addition.bodyCharCount).toBe(100);
    expect(addition.truncated).toBe(true);
  });

  it("uses a truncated leading range for invalid long document ranges", () => {
    const result = plan({
      manifest: [entry("docA", 80, 20), entry("docB", 300, 400)],
      documents: documentsMap(docMeta("docA", 200), docMeta("docB", 200)),
    });

    expect(
      result.additions.map((addition) => [
        addition.documentId,
        addition.charStart,
        addition.charEnd,
        addition.truncated,
      ]),
    ).toEqual([
      ["docA", 0, 100, true],
      ["docB", 0, 100, true],
    ]);
  });

  it("clamps long document ranges and keeps valid clamped ranges untruncated", () => {
    const result = plan({
      manifest: [entry("docA", -10, 250)],
      documents: documentsMap(docMeta("docA", 200)),
    });
    const addition = only(result.additions);

    expect(addition.charStart).toBe(0);
    expect(addition.charEnd).toBe(200);
    expect(addition.bodyCharCount).toBe(200);
    expect(addition.truncated).toBe(false);
  });
});

describe("planWindow budget and tail-drop", () => {
  it("does not drop entries on an exact hard-cap fit", () => {
    const result = plan({
      manifest: [entry("docA"), entry("docB")],
      documents: documentsMap(docMeta("docA", 40), docMeta("docB", 40)),
      activeBlocks: [activeBlock({ tokenEstimate: 10 })],
      budget: { ...budget, hardCap: 30 },
    });

    expect(result.dropped).toHaveLength(0);
    expect(result.additions).toHaveLength(2);
  });

  it("drops the last accepted entry when over hard cap by one token", () => {
    const result = plan({
      manifest: [entry("docA"), entry("docB")],
      documents: documentsMap(docMeta("docA", 80), docMeta("docB", 44)),
      budget: { ...budget, hardCap: 30 },
    });

    expect(result.additions.map((addition) => addition.documentId)).toEqual(["docA"]);
    expect(result.dropped).toEqual([
      { documentId: "docB", charStart: null, charEnd: null, tokenEstimate: 11, reason: "hard_cap" },
    ]);
  });

  it("drops multiple entries from the tail until the total fits", () => {
    const result = plan({
      manifest: [entry("docA"), entry("docB"), entry("docC")],
      documents: documentsMap(docMeta("docA", 40), docMeta("docB", 40), docMeta("docC", 40)),
      budget: { ...budget, hardCap: 15 },
    });

    expect(result.additions.map((addition) => addition.documentId)).toEqual(["docA"]);
    expect(result.dropped.map((drop) => drop.documentId)).toEqual(["docC", "docB"]);
  });

  it("does not count duplicates toward the hard cap", () => {
    const result = plan({
      manifest: [entry("docA"), entry("docA", 10, 20)],
      documents: documentsMap(docMeta("docA", 200)),
      activeBlocks: [
        activeBlock({ documentId: "docA", charStart: null, charEnd: null, tokenEstimate: 10 }),
      ],
      budget: { ...budget, hardCap: 20 },
    });

    expect(result.duplicates).toHaveLength(2);
    expect(result.dropped).toHaveLength(0);
  });

  it("counts appended memory toward the cap and never drops it", () => {
    const result = plan({
      manifest: [entry("docA"), entry("docB")],
      documents: documentsMap(docMeta("docA", 40), docMeta("docB", 40)),
      memories: [{ id: "m1", kind: "fact", content: "abcdefghijklmnop" }],
      budget: { ...budget, hardCap: 25 },
    });

    expect(result.memory.kind).toBe("append");
    expect(result.additions.map((addition) => addition.documentId)).toEqual(["docA"]);
    expect(result.dropped).toEqual([
      { documentId: "docB", charStart: null, charEnd: null, tokenEstimate: 10, reason: "hard_cap" },
    ]);
  });

  it("excludes a retired memory block from base tokens and includes the new one", () => {
    const result = plan({
      manifest: [entry("docA")],
      documents: documentsMap(docMeta("docA", 80)),
      activeBlocks: [
        activeBlock({
          blockId: "b1",
          kind: "memory",
          documentId: null,
          content: "x".repeat(400),
          tokenEstimate: 100,
        }),
        activeBlock({ blockId: "b2", documentId: "standing", tokenEstimate: 20 }),
      ],
      budget: { ...budget, hardCap: 50 },
    });

    expect(result.memory).toEqual({ kind: "retire", retiredBlockId: "b1" });
    expect(result.dropped).toHaveLength(0);
    expect(result.totalActiveTokensBeforeEviction).toBe(40);
  });

  it("drops every candidate when base tokens alone exceed the hard cap", () => {
    const result = plan({
      manifest: [entry("docA"), entry("docB")],
      documents: documentsMap(docMeta("docA", 40), docMeta("docB", 40)),
      activeBlocks: [activeBlock({ tokenEstimate: 50 })],
      budget: { ...budget, hardCap: 40 },
    });

    expect(result.additions).toHaveLength(0);
    expect(result.dropped.map((drop) => drop.documentId)).toEqual(["docB", "docA"]);
  });
});

describe("planWindow eviction", () => {
  it("evicts oldest standing unpinned document blocks first until within budget", () => {
    const result = plan({
      activeBlocks: [
        activeBlock({ blockId: "b2", tokenEstimate: 20 }),
        activeBlock({ blockId: "b1", tokenEstimate: 20 }),
        activeBlock({ blockId: "b3", tokenEstimate: 20 }),
      ],
      budget: { ...budget, blockBudget: 30 },
    });

    expect(result.evictions).toEqual([
      { blockId: "b1", reason: "over_budget" },
      { blockId: "b2", reason: "over_budget" },
    ]);
    expect(result.totalActiveTokensAfterEviction).toBe(20);
  });

  it("skips pinned standing blocks even when the window stays over budget", () => {
    const result = plan({
      activeBlocks: [
        activeBlock({ blockId: "b1", tokenEstimate: 40, pinned: true }),
        activeBlock({ blockId: "b2", tokenEstimate: 10 }),
        activeBlock({ blockId: "b3", tokenEstimate: 10 }),
      ],
      budget: { ...budget, blockBudget: 30 },
    });

    expect(result.evictions).toEqual([
      { blockId: "b2", reason: "over_budget" },
      { blockId: "b3", reason: "over_budget" },
    ]);
    expect(result.totalActiveTokensAfterEviction).toBe(40);
  });

  it("never puts the standing kept memory block in the eviction pool", () => {
    const memories = [{ id: "m1", kind: "fact" as const, content: "remember this" }];
    const result = plan({
      activeBlocks: [
        activeBlock({
          blockId: "b1",
          kind: "memory",
          documentId: null,
          content: renderMemoryBody(memories),
          tokenEstimate: 50,
        }),
        activeBlock({ blockId: "b2", tokenEstimate: 10 }),
      ],
      memories,
      budget: { ...budget, blockBudget: 10 },
    });

    expect(result.evictions).toEqual([{ blockId: "b2", reason: "over_budget" }]);
    expect(result.totalActiveTokensAfterEviction).toBe(50);
  });

  it("never evicts blocks added in the same turn", () => {
    const result = plan({
      manifest: [entry("docA")],
      documents: documentsMap(docMeta("docA", 80)),
      activeBlocks: [activeBlock({ blockId: "b1", tokenEstimate: 20, pinned: true })],
      budget: { ...budget, blockBudget: 30, hardCap: 100 },
    });

    expect(result.evictions).toHaveLength(0);
    expect(result.totalActiveTokensBeforeEviction).toBe(40);
    expect(result.totalActiveTokensAfterEviction).toBe(40);
  });

  it("stops eviction exactly when total is within budget", () => {
    const result = plan({
      activeBlocks: [
        activeBlock({ blockId: "b1", tokenEstimate: 10 }),
        activeBlock({ blockId: "b2", tokenEstimate: 10 }),
        activeBlock({ blockId: "b3", tokenEstimate: 10 }),
      ],
      budget: { ...budget, blockBudget: 20 },
    });

    expect(result.evictions).toEqual([{ blockId: "b1", reason: "over_budget" }]);
    expect(result.totalActiveTokensAfterEviction).toBe(20);
  });

  it("does not evict when total is already within budget", () => {
    const result = plan({
      activeBlocks: [activeBlock({ blockId: "b1", tokenEstimate: 20 })],
      budget: { ...budget, blockBudget: 20 },
    });

    expect(result.evictions).toHaveLength(0);
    expect(result.totalActiveTokensAfterEviction).toBe(20);
  });
});

describe("planWindow memory versioning", () => {
  it("appends memory when there is no active memory and memories are non-empty", () => {
    const memories = [
      { id: "m1", kind: "profile" as const, content: "Engineer" },
      { id: "m2", kind: "preference" as const, content: "Concise" },
    ];
    const result = plan({ memories, nextBlockNumber: 12 });

    expect(result.memory.kind).toBe("append");
    expect(result.memory.kind === "append" ? result.memory.retiredBlockId : "missing").toBeNull();
    expect(result.memory.kind === "append" ? result.memory.block.memoryIds : []).toEqual([
      "m1",
      "m2",
    ]);
    expect(result.memory.kind === "append" ? result.memory.block.content : "").toBe(
      renderMemoryBody(memories),
    );
  });

  it("keeps an active memory block when its content matches fresh render", () => {
    const memories = [{ id: "m1", kind: "instruction" as const, content: "Use citations" }];
    const result = plan({
      manifest: [entry("docA")],
      documents: documentsMap(docMeta("docA", 40)),
      activeBlocks: [
        activeBlock({
          blockId: "b8",
          kind: "memory",
          documentId: null,
          content: renderMemoryBody(memories),
        }),
      ],
      nextBlockNumber: 10,
      memories,
    });

    expect(result.memory).toEqual({ kind: "keep", blockId: "b8" });
    expect(only(result.additions).blockId).toBe("b10");
  });

  it("appends changed memories with the old block id retired", () => {
    const result = plan({
      activeBlocks: [
        activeBlock({ blockId: "b8", kind: "memory", documentId: null, content: "old" }),
      ],
      nextBlockNumber: 10,
      memories: [{ id: "m1", kind: "fact", content: "new" }],
    });

    expect(result.memory.kind).toBe("append");
    expect(result.memory.kind === "append" ? result.memory.retiredBlockId : null).toBe("b8");
    expect(result.memory.kind === "append" ? result.memory.block.blockId : null).toBe("b10");
  });

  it("retires active memory when memories are empty", () => {
    const result = plan({
      activeBlocks: [activeBlock({ blockId: "b8", kind: "memory", documentId: null })],
    });

    expect(result.memory).toEqual({ kind: "retire", retiredBlockId: "b8" });
  });

  it("has no memory plan when memories are empty and no active memory exists", () => {
    expect(plan({}).memory).toEqual({ kind: "none" });
  });
});

describe("planWindow document_not_found", () => {
  it("drops unknown documents and keeps processing later manifest entries", () => {
    const result = plan({
      manifest: [entry("missing"), entry("docA")],
      documents: documentsMap(docMeta("docA", 40)),
      nextBlockNumber: 4,
    });

    expect(result.dropped).toEqual([
      {
        documentId: "missing",
        charStart: null,
        charEnd: null,
        tokenEstimate: null,
        reason: "document_not_found",
      },
    ]);
    expect(only(result.additions).blockId).toBe("b4");
  });
});

describe("remainingBlockBudget", () => {
  it("returns the remaining positive budget", () => {
    expect(remainingBlockBudget(30, 100)).toBe(70);
  });

  it("returns zero when budget is exactly exhausted", () => {
    expect(remainingBlockBudget(100, 100)).toBe(0);
  });

  it("clamps negative remaining budget at zero", () => {
    expect(remainingBlockBudget(120, 100)).toBe(0);
  });
});
