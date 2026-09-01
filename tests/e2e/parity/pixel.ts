import { inflateSync, deflateSync } from "node:zlib";

import { readFile } from "node:fs/promises";

import type { PixelDiffSummary } from "./types";

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}

export class PngDecodeError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PngDecodeError";
  }
}

const readUint32 = (bytes: Uint8Array, offset: number): number =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset);

const equalBytes = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
};

const paethPredictor = (left: number, above: number, upperLeft: number): number => {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  if (aboveDistance <= upperLeftDistance) return above;
  return upperLeft;
};

const unfilterScanlines = (
  filtered: Uint8Array,
  width: number,
  height: number,
  bytesPerPixel: number,
  rowBytes: number,
): Uint8Array => {
  const rows = new Uint8Array(height * rowBytes);
  let sourceOffset = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = filtered[sourceOffset];
    sourceOffset += 1;
    if (filter === undefined || filter > 4) {
      throw new PngDecodeError(`unsupported PNG filter type ${String(filter)}`);
    }

    const rowOffset = y * rowBytes;
    const previousRowOffset = (y - 1) * rowBytes;
    for (let x = 0; x < rowBytes; x += 1) {
      const encoded = filtered[sourceOffset + x];
      if (encoded === undefined) throw new PngDecodeError("truncated PNG scanline");
      const left = x >= bytesPerPixel ? rows[rowOffset + x - bytesPerPixel] : 0;
      const above = y > 0 ? rows[previousRowOffset + x] : 0;
      const upperLeft =
        y > 0 && x >= bytesPerPixel ? rows[previousRowOffset + x - bytesPerPixel] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      if (filter === 2) predictor = above;
      if (filter === 3) predictor = Math.floor((left + above) / 2);
      if (filter === 4) predictor = paethPredictor(left, above, upperLeft);
      rows[rowOffset + x] = (encoded + predictor) & 0xff;
    }
    sourceOffset += rowBytes;
  }

  if (sourceOffset !== filtered.length) {
    throw new PngDecodeError("PNG contains trailing decompressed scanline data");
  }
  return rows;
};

interface Palette {
  readonly rgb: Uint8Array;
  readonly alpha: Uint8Array;
}

const toRgba = (
  rows: Uint8Array,
  width: number,
  height: number,
  colorType: number,
  palette: Palette | undefined,
  transparency: Uint8Array | undefined,
): Uint8Array => {
  const pixelCount = width * height;
  const output = new Uint8Array(pixelCount * 4);
  let sourceOffset = 0;
  let targetOffset = 0;

  const write = (red: number, green: number, blue: number, alpha: number): void => {
    output[targetOffset] = red;
    output[targetOffset + 1] = green;
    output[targetOffset + 2] = blue;
    output[targetOffset + 3] = alpha;
    targetOffset += 4;
  };

  if (colorType === 6) {
    output.set(rows);
    return output;
  }
  if (colorType === 2) {
    for (let index = 0; index < pixelCount; index += 1) {
      const red = rows[sourceOffset];
      const green = rows[sourceOffset + 1];
      const blue = rows[sourceOffset + 2];
      if (red === undefined || green === undefined || blue === undefined) {
        throw new PngDecodeError("truncated RGB PNG data");
      }
      sourceOffset += 3;
      let alpha = 255;
      if (transparency !== undefined && transparency.length >= 6) {
        const transparentRed = transparency[0] * 256 + transparency[1];
        const transparentGreen = transparency[2] * 256 + transparency[3];
        const transparentBlue = transparency[4] * 256 + transparency[5];
        if (red === transparentRed && green === transparentGreen && blue === transparentBlue) {
          alpha = 0;
        }
      }
      write(red, green, blue, alpha);
    }
    return output;
  }
  if (colorType === 4) {
    for (let index = 0; index < pixelCount; index += 1) {
      const value = rows[sourceOffset];
      const alpha = rows[sourceOffset + 1];
      if (value === undefined || alpha === undefined) {
        throw new PngDecodeError("truncated grayscale-alpha PNG data");
      }
      sourceOffset += 2;
      write(value, value, value, alpha);
    }
    return output;
  }
  if (colorType === 0) {
    for (let index = 0; index < pixelCount; index += 1) {
      const value = rows[sourceOffset];
      if (value === undefined) throw new PngDecodeError("truncated grayscale PNG data");
      sourceOffset += 1;
      let alpha = 255;
      if (transparency !== undefined && transparency.length >= 2) {
        const transparentValue = transparency[0] * 256 + transparency[1];
        if (value === transparentValue) alpha = 0;
      }
      write(value, value, value, alpha);
    }
    return output;
  }
  if (colorType === 3 && palette !== undefined) {
    for (let index = 0; index < pixelCount; index += 1) {
      const paletteIndex = rows[sourceOffset];
      if (paletteIndex === undefined) throw new PngDecodeError("truncated indexed PNG data");
      sourceOffset += 1;
      const rgbOffset = paletteIndex * 3;
      const red = palette.rgb[rgbOffset];
      const green = palette.rgb[rgbOffset + 1];
      const blue = palette.rgb[rgbOffset + 2];
      if (red === undefined || green === undefined || blue === undefined) {
        throw new PngDecodeError(`PNG palette index ${paletteIndex} is out of range`);
      }
      write(red, green, blue, palette.alpha[paletteIndex] ?? 255);
    }
    return output;
  }
  throw new PngDecodeError(`unsupported PNG color type ${colorType}`);
};

/** Decode the 8-bit PNG formats emitted by Playwright into RGBA pixels. */
export const decodePng = (input: Uint8Array): RgbaImage => {
  if (input.length < PNG_SIGNATURE.length || !equalBytes(input.slice(0, 8), PNG_SIGNATURE)) {
    throw new PngDecodeError("invalid PNG signature");
  }

  let offset = PNG_SIGNATURE.length;
  let width: number | undefined;
  let height: number | undefined;
  let bitDepth: number | undefined;
  let colorType: number | undefined;
  let interlaceMethod: number | undefined;
  let palette: Palette | undefined;
  let transparency: Uint8Array | undefined;
  const imageData: Uint8Array[] = [];
  let sawIhdr = false;
  let sawIend = false;

  while (offset + 12 <= input.length) {
    const chunkLength = readUint32(input, offset);
    offset += 4;
    if (offset + 4 + chunkLength + 4 > input.length) {
      throw new PngDecodeError("truncated PNG chunk");
    }
    const type = new TextDecoder().decode(input.slice(offset, offset + 4));
    offset += 4;
    const data = input.slice(offset, offset + chunkLength);
    offset += chunkLength;
    // The CRC is not needed to decode a screenshot, but consuming it here
    // keeps malformed chunk boundaries from being mistaken for image data.
    offset += 4;

    if (type === "IHDR") {
      if (sawIhdr || chunkLength !== 13) throw new PngDecodeError("invalid PNG header");
      sawIhdr = true;
      width = readUint32(data, 0);
      height = readUint32(data, 4);
      bitDepth = data[8];
      colorType = data[9];
      const compressionMethod = data[10];
      const filterMethod = data[11];
      interlaceMethod = data[12];
      if (
        width === undefined ||
        height === undefined ||
        bitDepth === undefined ||
        colorType === undefined ||
        compressionMethod !== 0 ||
        filterMethod !== 0
      ) {
        throw new PngDecodeError("invalid PNG header values");
      }
      if (width === 0 || height === 0) throw new PngDecodeError("PNG dimensions must be positive");
      if (bitDepth !== 8) throw new PngDecodeError(`unsupported PNG bit depth ${bitDepth}`);
      if (![0, 2, 3, 4, 6].includes(colorType)) {
        throw new PngDecodeError(`unsupported PNG color type ${colorType}`);
      }
      if (interlaceMethod !== 0) throw new PngDecodeError("interlaced PNGs are not supported");
      continue;
    }
    if (!sawIhdr) throw new PngDecodeError("PNG data appears before IHDR");
    if (type === "PLTE") {
      if (chunkLength === 0 || chunkLength % 3 !== 0)
        throw new PngDecodeError("invalid PNG palette");
      const alpha = new Uint8Array(chunkLength / 3).fill(255);
      palette = { rgb: data, alpha };
      continue;
    }
    if (type === "tRNS") {
      transparency = data;
      if (palette !== undefined) {
        const alpha = palette.alpha.slice();
        alpha.set(data.slice(0, alpha.length));
        palette = { rgb: palette.rgb, alpha };
      }
      continue;
    }
    if (type === "IDAT") {
      imageData.push(data);
      continue;
    }
    if (type === "IEND") {
      sawIend = true;
      break;
    }
  }

  if (
    !sawIhdr ||
    !sawIend ||
    width === undefined ||
    height === undefined ||
    bitDepth === undefined ||
    colorType === undefined
  ) {
    throw new PngDecodeError("PNG is missing required chunks");
  }
  if (imageData.length === 0) throw new PngDecodeError("PNG contains no image data");

  const channelsByColorType: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const channels = channelsByColorType[colorType];
  if (channels === undefined) throw new PngDecodeError(`unsupported PNG color type ${colorType}`);
  const rowBytes = width * channels;
  const expectedInflatedLength = height * (rowBytes + 1);
  const compressed = new Uint8Array(imageData.reduce((total, chunk) => total + chunk.length, 0));
  let compressedOffset = 0;
  for (const chunk of imageData) {
    compressed.set(chunk, compressedOffset);
    compressedOffset += chunk.length;
  }
  const filtered = new Uint8Array(inflateSync(compressed));
  if (filtered.length !== expectedInflatedLength) {
    throw new PngDecodeError(
      `PNG decompressed length ${filtered.length} does not match ${expectedInflatedLength}`,
    );
  }
  const rows = unfilterScanlines(filtered, width, height, channels, rowBytes);
  return { width, height, pixels: toRgba(rows, width, height, colorType, palette, transparency) };
};

export const comparePixels = (expected: RgbaImage, actual: RgbaImage): PixelDiffSummary => {
  const sameDimensions = expected.width === actual.width && expected.height === actual.height;
  const width = expected.width;
  const height = expected.height;
  const totalPixels = width * height;
  if (!sameDimensions) {
    return {
      same: false,
      width,
      height,
      totalPixels,
      changedPixels: totalPixels,
      changedChannels: totalPixels * 4,
      maxChannelDelta: 255,
      firstDifference: null,
    };
  }

  let changedPixels = 0;
  let changedChannels = 0;
  let maxChannelDelta = 0;
  let firstDifference: PixelDiffSummary["firstDifference"] = null;
  for (let pixel = 0; pixel < totalPixels; pixel += 1) {
    const offset = pixel * 4;
    let pixelChanged = false;
    for (let channel = 0; channel < 4; channel += 1) {
      const expectedValue = expected.pixels[offset + channel] ?? 0;
      const actualValue = actual.pixels[offset + channel] ?? 0;
      const delta = Math.abs(expectedValue - actualValue);
      if (delta > 0) {
        pixelChanged = true;
        changedChannels += 1;
        if (delta > maxChannelDelta) maxChannelDelta = delta;
      }
    }
    if (!pixelChanged) continue;
    changedPixels += 1;
    if (firstDifference === null) {
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      firstDifference = {
        x,
        y,
        expected: [
          expected.pixels[offset] ?? 0,
          expected.pixels[offset + 1] ?? 0,
          expected.pixels[offset + 2] ?? 0,
          expected.pixels[offset + 3] ?? 0,
        ],
        actual: [
          actual.pixels[offset] ?? 0,
          actual.pixels[offset + 1] ?? 0,
          actual.pixels[offset + 2] ?? 0,
          actual.pixels[offset + 3] ?? 0,
        ],
      };
    }
  }
  return {
    same: changedPixels === 0,
    width,
    height,
    totalPixels,
    changedPixels,
    changedChannels,
    maxChannelDelta,
    firstDifference,
  };
};

export const comparePngFiles = async (
  expectedPath: string,
  actualPath: string,
): Promise<PixelDiffSummary> => {
  const [expected, actual] = await Promise.all([readFile(expectedPath), readFile(actualPath)]);
  return comparePixels(decodePng(expected), decodePng(actual));
};

const writeUint32 = (view: DataView, offset: number, value: number): void => {
  view.setUint32(offset, value);
};

// PNG CRC is only needed for interoperability with image viewers. The diff
// artifact is generated locally, so a small table-driven implementation keeps
// this module dependency-free while still writing valid PNG chunks.
const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const pngChunk = (type: string, data: Uint8Array): Uint8Array => {
  const typeBytes = new TextEncoder().encode(type);
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  writeUint32(view, 0, data.length);
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);
  const crcInput = new Uint8Array(typeBytes.length + data.length);
  crcInput.set(typeBytes);
  crcInput.set(data, typeBytes.length);
  writeUint32(view, 8 + data.length, crc32(crcInput));
  return chunk;
};

const concatBytes = (...parts: readonly Uint8Array[]): Uint8Array => {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
};

/** Create a red, transparent diff image for humans inspecting a failure. */
export const encodeDiffPng = (expected: RgbaImage, actual: RgbaImage): Uint8Array => {
  if (expected.width !== actual.width || expected.height !== actual.height) {
    throw new PngDecodeError("cannot encode a diff for images with different dimensions");
  }
  const rows = new Uint8Array(expected.height * (expected.width * 4 + 1));
  for (let y = 0; y < expected.height; y += 1) {
    const rowOffset = y * (expected.width * 4 + 1);
    rows[rowOffset] = 0;
    for (let x = 0; x < expected.width; x += 1) {
      const pixelOffset = (y * expected.width + x) * 4;
      const outputOffset = rowOffset + 1 + x * 4;
      const differs =
        expected.pixels[pixelOffset] !== actual.pixels[pixelOffset] ||
        expected.pixels[pixelOffset + 1] !== actual.pixels[pixelOffset + 1] ||
        expected.pixels[pixelOffset + 2] !== actual.pixels[pixelOffset + 2] ||
        expected.pixels[pixelOffset + 3] !== actual.pixels[pixelOffset + 3];
      rows[outputOffset] = differs ? 220 : 0;
      rows[outputOffset + 1] = differs ? 32 : 0;
      rows[outputOffset + 2] = differs ? 48 : 0;
      rows[outputOffset + 3] = differs ? 255 : 0;
    }
  }
  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  writeUint32(headerView, 0, expected.width);
  writeUint32(headerView, 4, expected.height);
  header[8] = 8;
  header[9] = 6;
  const compressed = new Uint8Array(deflateSync(rows));
  return concatBytes(
    PNG_SIGNATURE,
    pngChunk("IHDR", header),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", new Uint8Array()),
  );
};

export const writeDiffPng = async (
  expectedPath: string,
  actualPath: string,
  diffPath: string,
): Promise<PixelDiffSummary> => {
  const [expectedBytes, actualBytes] = await Promise.all([
    readFile(expectedPath),
    readFile(actualPath),
  ]);
  const expected = decodePng(expectedBytes);
  const actual = decodePng(actualBytes);
  const summary = comparePixels(expected, actual);
  if (expected.width === actual.width && expected.height === actual.height) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(diffPath, encodeDiffPng(expected, actual));
  }
  return summary;
};
