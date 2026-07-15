import { describe, expect, it } from "vitest";

import { memoryRevisionFragment, parseMemoryRevisionFragment } from "./memory-provenance";

describe("memory revision fragments", () => {
  it("round-trips canonical UUID-shaped identities", () => {
    const identity = {
      memoryId: "019f-memory-id/revision-like-value",
      revisionId: "019f-revision-id?with=reserved&characters",
    };
    expect(
      parseMemoryRevisionFragment(memoryRevisionFragment(identity.memoryId, identity.revisionId)),
    ).toEqual(identity);
  });

  it.each([
    "",
    "#memory-revision?",
    "#memory-revision?memoryId=one",
    "#memory-revision?memoryId=&revisionId=two",
    "#memory-revision?memoryId=one&revisionId=two&extra=three",
    "#memory-revision?memoryId=one&memoryId=two&revisionId=three",
    "#other?memoryId=one&revisionId=two",
  ])("rejects malformed fragment %s", (fragment) =>
    expect(parseMemoryRevisionFragment(fragment)).toBeNull(),
  );
});
