import { describe, expect, it } from "vitest";
import { stripIncompleteCitationTail } from "./finalization";

describe("stopped answer citation tails", () => {
  it("removes every incomplete citation prefix while preserving complete text", () => {
    const prefixes = ["[", "[[", "[[c", "[[ci", "[[cit", "[[cite", "[[cite:"];
    for (const prefix of prefixes) {
      expect(stripIncompleteCitationTail(`Answer ${prefix}`)).toBe("Answer ");
    }
    expect(stripIncompleteCitationTail("Answer [[cite:source]")).toBe("Answer ");
    expect(stripIncompleteCitationTail("Answer [[cite:source]]")).toBe("Answer [[cite:source]]");
    expect(stripIncompleteCitationTail("Answer [[not-a-citation")).toBe("Answer [[not-a-citation");
  });
});
