import { describe, expect, it } from "vitest";

import { parseCitationTags } from "./citation-tags";

describe("parseCitationTags", () => {
  it("parses a multi-id citation tag", () => {
    expect(parseCitationTags("Texte [[cite:b1,b2]] suite.", ["b1", "b2"])).toEqual({
      segments: [
        { type: "text", text: "Texte " },
        { type: "citations", citationIds: ["b1", "b2"] },
        { type: "text", text: " suite." },
      ],
      pendingTail: "",
    });
  });

  it("renders unknown ids as literal text", () => {
    expect(parseCitationTags("Texte [[cite:b1,b404]].", ["b1"])).toEqual({
      segments: [{ type: "text", text: "Texte [[cite:b1,b404]]." }],
      pendingTail: "",
    });
  });

  it("holds back a partial citation tag tail", () => {
    expect(parseCitationTags("Texte [[cite:b", ["b1"])).toEqual({
      segments: [{ type: "text", text: "Texte " }],
      pendingTail: "[[cite:b",
    });
  });

  it("holds back an opener prefix at the end of a streaming buffer", () => {
    expect(parseCitationTags("Texte [[ci", ["b1"])).toEqual({
      segments: [{ type: "text", text: "Texte " }],
      pendingTail: "[[ci",
    });
  });

  it("handles adjacent tags", () => {
    expect(parseCitationTags("[[cite:b1]][[cite:b2]]", ["b1", "b2"])).toEqual({
      segments: [
        { type: "citations", citationIds: ["b1"] },
        { type: "citations", citationIds: ["b2"] },
      ],
      pendingTail: "",
    });
  });

  it("keeps repeated ids in order", () => {
    expect(parseCitationTags("[[cite:b1,b1]]", ["b1"])).toEqual({
      segments: [{ type: "citations", citationIds: ["b1", "b1"] }],
      pendingTail: "",
    });
  });
});
