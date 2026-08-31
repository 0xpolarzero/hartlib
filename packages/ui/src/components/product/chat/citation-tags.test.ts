import { describe, expect, it } from "vitest";
import { parseCitationTags } from "./citation-tags";

describe("strict citation tags", () => {
  it("keeps unknown keys as prose and holds an incomplete streaming tail", () => {
    expect(parseCitationTags("Read [[cite:source-1]] [[cite:source", ["source-1"])).toEqual({
      segments: [
        { type: "text", text: "Read " },
        { type: "citations", citationIds: ["source-1"] },
        { type: "text", text: " " },
      ],
      pendingTail: "[[cite:source",
    });
  });
});
