import { describe, expect, it } from "vitest";

import { resolveAcceptedSourceNames } from "./compile-query-spec";
import { previewFromImmutableText } from "./retrieval";

describe("retrieval projection", () => {
  it("keeps immutable UTF-16 previews on code-point boundaries", () => {
    const text = "A😀 B";
    expect(previewFromImmutableText(text, undefined, 2)).toEqual({
      snippet: "A",
      ranges: [{ charStart: 0, charEnd: 1 }],
    });
    expect(previewFromImmutableText(text, "😀", 2)).toEqual({
      snippet: "😀",
      ranges: [{ charStart: 1, charEnd: 3 }],
    });
  });

  it("fails closed for malformed UTF-16 and empty searches", () => {
    expect(previewFromImmutableText("\ud800", undefined, 10)).toBeNull();
    expect(previewFromImmutableText("text", "   ", 10)).toBeNull();
  });

  it("resolves only public sources in the accepted scope", () => {
    expect(
      resolveAcceptedSourceNames(
        ["Official"],
        { publicSourceIds: ["public-1"] },
        {
          publicSources: [{ sourceId: "public-1", displayName: "Official" }],
        },
      ),
    ).toEqual(["public:public-1"]);
    expect(resolveAcceptedSourceNames(undefined, { publicSourceIds: [] }, {})).toEqual([]);
  });
});
