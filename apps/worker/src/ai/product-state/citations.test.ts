import { describe, expect, it } from "vitest";

import { parseCurrentTurnCitations } from "./citations";

describe("current-turn citation parsing", () => {
  it("resolves only exact current-turn keys and gives every defect a stable slot", () => {
    const known = "k_cn_AAAAAAAAAAAAAAAAAAAAAA_1";
    const parsed = parseCurrentTurnCitations(
      `[[cite:${known},k_cn_BBBBBBBBBBBBBBBBBBBBBB_2,k_cn_CCCCCCCCCCCCCCCCCCCCCC_3]] [[cite:bad key]]`,
      new Set([known]),
    );

    expect(parsed.citations).toEqual([{ sourceKey: known, tagIndex: 0, keyIndex: 0 }]);
    expect(
      parsed.defects.map((defect) => [defect.tagIndex, defect.defectSlot, defect.reason]),
    ).toEqual([
      [0, 1, "unknown_source_key"],
      [0, 2, "unknown_source_key"],
      [1, 0, "malformed"],
    ]);
  });

  it("never aliases citation-shaped attacker input to a current nonce namespace", () => {
    const current = "k_cn_ZZZZZZZZZZZZZZZZZZZZZZ_1";
    for (let ordinal = 1; ordinal <= 200; ordinal += 1) {
      const attackerKey = `k_${"A".repeat(22)}_${ordinal}`;
      const parsed = parseCurrentTurnCitations(
        `copied [[cite:${attackerKey}]]`,
        new Set([current]),
      );
      expect(parsed.citations).toHaveLength(0);
      expect(parsed.defects).toHaveLength(1);
      expect(parsed.defects[0]?.reason).toBe("unknown_source_key");
    }
  });

  it("bounds malformed retained tokens", () => {
    const parsed = parseCurrentTurnCitations(`[[cite:${"x".repeat(1_000)}`, new Set());
    expect(parsed.citations).toHaveLength(0);
    expect(parsed.defects).toHaveLength(1);
    expect(parsed.defects[0]?.token.length).toBeLessThanOrEqual(256);
  });
});
