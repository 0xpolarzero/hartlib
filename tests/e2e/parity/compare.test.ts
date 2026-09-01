import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { compareCaptureDirectory } from "../../../scripts/ui-parity/compare";
import { getParityEntry } from "./manifest";
import { writePng, type RgbaImage } from "../../../scripts/ui-parity/png";

const image = (red: number): RgbaImage => ({
  width: 1,
  height: 1,
  pixels: new Uint8Array([red, 2, 3, 255]),
});

describe("parity capture directory comparison", () => {
  it("returns a passing report for an equal pair and a diff for changes", () => {
    const directory = mkdtempSync(join(tmpdir(), "hartlib-ui-parity-compare-"));
    const current = join(directory, "C001-D-current.png");
    const reference = join(directory, "C001-D-reference.png");
    writePng(current, image(1));
    writePng(reference, image(1));
    expect(compareCaptureDirectory(directory, [getParityEntry("C001-D")]).passed).toBe(true);

    writePng(reference, image(4));
    const report = compareCaptureDirectory(directory, [getParityEntry("C001-D")]);
    expect(report.passed).toBe(false);
    expect(report.pairs[0]?.comparison?.changedPixels).toBe(1);
    expect(readFileSync(join(directory, "C001-D-diff.png")).byteLength).toBeGreaterThan(0);
  });
});
