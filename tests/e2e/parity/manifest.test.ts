import { describe, expect, it } from "vitest";

import {
  getParityEntry,
  PARITY_ENTRY_COUNT,
  PARITY_ENTRY_IDS,
  PARITY_LOGICAL_ENTRY_COUNT,
  PARITY_MANIFEST,
  PARITY_VIEWPORTS,
  parityManifestSummary,
} from "./manifest";
import { resolveManifestEntries } from "./capture";

describe("parity manifest", () => {
  it("expands the 38 audited logical rows at both exact viewports", () => {
    expect(PARITY_LOGICAL_ENTRY_COUNT).toBe(38);
    expect(PARITY_ENTRY_COUNT).toBe(76);
    expect(PARITY_MANIFEST).toHaveLength(76);
    expect(new Set(PARITY_ENTRY_IDS).size).toBe(76);
    expect(PARITY_VIEWPORTS).toEqual([
      { name: "desktop", width: 1440, height: 900 },
      { name: "narrow", width: 390, height: 844 },
    ]);
  });

  it("keeps every entry captureable and gives each substate a stable id", () => {
    for (const entry of PARITY_MANIFEST) {
      expect(entry.entryId).toMatch(/^C\d{3}-[DN]$/u);
      expect(entry.route).toMatch(/^\//u);
      expect(entry.referenceRoute).toMatch(/^\//u);
      expect(entry.substates.length).toBeGreaterThan(0);
      expect(new Set(entry.substates.map((state) => state.id)).size).toBe(entry.substates.length);
      expect(entry.substates.every((state) => state.capture)).toBe(true);
    }
  });

  it("selects a requested entry without changing matrix order", () => {
    expect(getParityEntry("C013-N")?.viewport).toEqual({ name: "narrow", width: 390, height: 844 });
    expect(parityManifestSummary().entries).toBe(76);
  });

  it("rejects an unknown selection instead of silently capturing nothing", () => {
    expect(() => resolveManifestEntries(["C999-D"])).toThrow(/unknown parity entry id/u);
  });
});
