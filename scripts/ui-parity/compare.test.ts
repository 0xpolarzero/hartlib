import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { compareCaptureDirectory } from "./compare";
import { encodePng, writePng, type RgbaImage } from "./png";
import { getParityEntry } from "../../tests/e2e/parity/manifest";

const image = (green: number): RgbaImage => ({
  width: 2,
  height: 1,
  pixels: new Uint8Array([220, green, 40, 255, 220, green, 40, 255]),
});

describe("parity PNG comparison", () => {
  it("reports zero changed pixels for an exact pair", () => {
    const directory = mkdtempSync(join(tmpdir(), "hartlib-parity-compare-"));
    const current = join(directory, "C001-D-current.png");
    const reference = join(directory, "C001-D-reference.png");
    writePng(current, image(10));
    writePng(reference, image(10));

    const report = compareCaptureDirectory(directory, [getParityEntry("C001-D")]);

    expect(report.passed).toBe(true);
    expect(report.comparedEntries).toBe(1);
    expect(report.failedEntries).toBe(0);
    expect(report.pairs[0]?.comparison?.changedPixels).toBe(0);
    expect(readFileSync(current)).toEqual(encodePng(image(10)));
  });

  it("counts each changed pixel once and writes a diff image", () => {
    const directory = mkdtempSync(join(tmpdir(), "hartlib-parity-compare-"));
    writePng(join(directory, "C001-D-current.png"), image(10));
    writePng(join(directory, "C001-D-reference.png"), {
      width: 2,
      height: 1,
      pixels: new Uint8Array([220, 11, 40, 255, 220, 10, 40, 255]),
    });

    const report = compareCaptureDirectory(directory, [getParityEntry("C001-D")]);

    expect(report.passed).toBe(false);
    expect(report.failedEntries).toBe(1);
    expect(report.pairs[0]?.comparison?.changedPixels).toBe(1);
    expect(report.pairs[0]?.comparison?.totalPixels).toBe(2);
    expect(readFileSync(join(directory, "C001-D-diff.png")).byteLength).toBeGreaterThan(0);
  });

  it("fails instead of skipping a missing pair", () => {
    const directory = mkdtempSync(join(tmpdir(), "hartlib-parity-compare-"));
    const report = compareCaptureDirectory(directory, [getParityEntry("C001-D")]);
    expect(report.passed).toBe(false);
    expect(report.comparedEntries).toBe(0);
    expect(report.failedEntries).toBe(1);
    expect(report.pairs[0]?.error).toContain("missing current");
  });
});
