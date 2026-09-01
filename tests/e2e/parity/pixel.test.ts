import { describe, expect, it } from "vitest";

import { comparePixels, decodePng, encodeDiffPng } from "./pixel";

describe("parity PNG comparison", () => {
  it("decodes the diff artifact and counts changed pixels exactly", () => {
    const expected = {
      width: 2,
      height: 1,
      pixels: new Uint8Array([255, 255, 255, 255, 0, 0, 0, 255]),
    };
    const actual = {
      width: 2,
      height: 1,
      pixels: new Uint8Array([255, 255, 255, 255, 255, 0, 0, 255]),
    };

    const summary = comparePixels(expected, actual);
    expect(summary).toMatchObject({
      same: false,
      width: 2,
      height: 1,
      totalPixels: 2,
      changedPixels: 1,
      changedChannels: 1,
      maxChannelDelta: 255,
    });
    expect(summary.firstDifference).toEqual({
      x: 1,
      y: 0,
      expected: [0, 0, 0, 255],
      actual: [255, 0, 0, 255],
    });

    const diff = decodePng(encodeDiffPng(expected, actual));
    expect(diff.width).toBe(2);
    expect(diff.height).toBe(1);
    expect([...diff.pixels]).toEqual([0, 0, 0, 0, 220, 32, 48, 255]);
  });

  it("reports identical RGBA images without a normalization rule", () => {
    const image = {
      width: 1,
      height: 1,
      pixels: new Uint8Array([12, 34, 56, 255]),
    };
    expect(comparePixels(image, image)).toEqual({
      same: true,
      width: 1,
      height: 1,
      totalPixels: 1,
      changedPixels: 0,
      changedChannels: 0,
      maxChannelDelta: 0,
      firstDifference: null,
    });
  });
});
