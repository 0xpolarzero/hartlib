import { describe, expect, it } from "vitest";

import { comparePngBuffers, encodeRgbaPng } from "./capture";

const pixel = (red: number, green: number, blue: number, alpha = 255): Uint8Array =>
  new Uint8Array([red, green, blue, alpha]);

describe("exact PNG comparison", () => {
  it("accepts equal pixels and reports no diff artifact", () => {
    const image = encodeRgbaPng(1, 1, pixel(250, 248, 243));
    expect(comparePngBuffers(image, image)).toMatchObject({
      passed: true,
      width: 1,
      height: 1,
      totalPixels: 1,
      changedPixels: 0,
      changedChannels: 0,
      diffPath: null,
      error: null,
    });
  });

  it("counts every changed pixel and channel without a tolerance", () => {
    const current = encodeRgbaPng(2, 1, new Uint8Array([0, 0, 0, 255, 10, 20, 30, 255]));
    const reference = encodeRgbaPng(2, 1, new Uint8Array([0, 0, 0, 255, 10, 20, 31, 255]));
    expect(comparePngBuffers(current, reference)).toMatchObject({
      passed: false,
      width: 2,
      height: 1,
      totalPixels: 2,
      changedPixels: 1,
      changedChannels: 1,
      maxChannelDelta: 1,
      error: null,
    });
  });

  it("fails a dimension mismatch instead of resizing either surface", () => {
    const current = encodeRgbaPng(1, 1, pixel(0, 0, 0));
    const reference = encodeRgbaPng(2, 1, new Uint8Array([0, 0, 0, 255, 0, 0, 0, 255]));
    expect(comparePngBuffers(current, reference)).toMatchObject({
      passed: false,
      changedPixels: 1,
      maxChannelDelta: 255,
    });
  });
});
