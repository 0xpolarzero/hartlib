import { describe, expect, it } from "vitest";
import { memoryRevisionFragment, parseMemoryRevisionFragment } from "./memory-provenance";

describe("memory provenance fragments", () => {
  it("round-trips opaque memory and revision IDs", () => {
    const fragment = memoryRevisionFragment("memory/opaque", "revision?1");
    expect(parseMemoryRevisionFragment(fragment)).toEqual({
      memoryId: "memory/opaque",
      revisionId: "revision?1",
    });
    expect(
      parseMemoryRevisionFragment("#memory-revision?memoryId=one&memoryId=two&revisionId=rev"),
    ).toBeNull();
  });
});
