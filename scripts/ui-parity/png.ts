import { deflateSync, inflateSync } from "node:zlib";

import { readFileSync, writeFileSync } from "node:fs";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export type RgbaImage = {
  readonly width: number;
  readonly height: number;
  /** Four bytes per pixel, in RGBA order. */
  readonly pixels: Uint8Array;
};

export type PngComparison = {
  readonly same: boolean;
  readonly width: number;
  readonly height: number;
  readonly changedPixels: number;
  readonly totalPixels: number;
  readonly changedRatio: number;
  readonly maximumChannelDelta: number;
  readonly totalAbsoluteChannelDelta: number;
};

const readUInt32 = (bytes: Uint8Array, offset: number): number =>
  (((bytes[offset] ?? 0) << 24) |
    ((bytes[offset + 1] ?? 0) << 16) |
    ((bytes[offset + 2] ?? 0) << 8) |
    (bytes[offset + 3] ?? 0)) >>>
  0;

const paeth = (left: number, above: number, upperLeft: number): number => {
  const prediction = left + above - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const aboveDistance = Math.abs(prediction - above);
  const upperLeftDistance = Math.abs(prediction - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  if (aboveDistance <= upperLeftDistance) return above;
  return upperLeft;
};

const unfilter = (
  filtered: Uint8Array,
  width: number,
  height: number,
  bytesPerPixel: number,
  rowBytes: number,
): Uint8Array => {
  const rows = new Uint8Array(height * rowBytes);
  let inputOffset = 0;
  for (let row = 0; row < height; row += 1) {
    const filter = filtered[inputOffset++] ?? 0;
    const outputOffset = row * rowBytes;
    const previousOffset = (row - 1) * rowBytes;
    for (let column = 0; column < rowBytes; column += 1) {
      const raw = filtered[inputOffset++] ?? 0;
      const left = column >= bytesPerPixel ? (rows[outputOffset + column - bytesPerPixel] ?? 0) : 0;
      const above = row > 0 ? (rows[previousOffset + column] ?? 0) : 0;
      const upperLeft =
        row > 0 && column >= bytesPerPixel
          ? (rows[previousOffset + column - bytesPerPixel] ?? 0)
          : 0;
      let value: number;
      switch (filter) {
        case 0:
          value = raw;
          break;
        case 1:
          value = raw + left;
          break;
        case 2:
          value = raw + above;
          break;
        case 3:
          value = raw + Math.floor((left + above) / 2);
          break;
        case 4:
          value = raw + paeth(left, above, upperLeft);
          break;
        default:
          throw new Error(`Unsupported PNG row filter ${filter} at row ${row}`);
      }
      rows[outputOffset + column] = value & 0xff;
    }
  }
  if (inputOffset !== filtered.length) {
    throw new Error(`PNG scanline payload has ${filtered.length - inputOffset} trailing bytes`);
  }
  // Keep width in the function signature so callers cannot accidentally pass
  // a row length for a different image.
  if (rowBytes !== width * bytesPerPixel) throw new Error("PNG row width is inconsistent");
  return rows;
};

export function decodePng(bytes: Uint8Array): RgbaImage {
  if (
    bytes.length < PNG_SIGNATURE.length ||
    !PNG_SIGNATURE.every((value, index) => bytes[index] === value)
  ) {
    throw new Error("Not a PNG file");
  }

  let offset = PNG_SIGNATURE.length;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat: Uint8Array[] = [];
  let palette: Uint8Array | undefined;
  let transparency: Uint8Array | undefined;
  while (offset + 12 <= bytes.length) {
    const length = readUInt32(bytes, offset);
    offset += 4;
    if (offset + 4 + length + 4 > bytes.length) throw new Error("PNG chunk is truncated");
    const type = String.fromCharCode(...bytes.slice(offset, offset + 4));
    offset += 4;
    const payload = bytes.slice(offset, offset + length);
    offset += length;
    offset += 4; // CRC is checked by the browser; no mutation occurs here.
    if (type === "IHDR") {
      if (length !== 13) throw new Error("PNG IHDR has an invalid length");
      width = readUInt32(payload, 0);
      height = readUInt32(payload, 4);
      bitDepth = payload[8] ?? 0;
      colorType = payload[9] ?? 0;
      interlace = payload[12] ?? 0;
    } else if (type === "IDAT") {
      idat.push(payload);
    } else if (type === "PLTE") {
      palette = payload;
    } else if (type === "tRNS") {
      transparency = payload;
    } else if (type === "IEND") {
      break;
    }
  }
  if (width <= 0 || height <= 0) throw new Error("PNG has no positive dimensions");
  if (bitDepth !== 8 || interlace !== 0)
    throw new Error("Parity comparison supports only non-interlaced 8-bit PNGs");
  const channelCount =
    colorType === 0
      ? 1
      : colorType === 2
        ? 3
        : colorType === 3
          ? 1
          : colorType === 4
            ? 2
            : colorType === 6
              ? 4
              : 0;
  if (channelCount === 0) throw new Error(`Unsupported PNG color type ${colorType}`);
  if (colorType === 3 && (palette === undefined || palette.length % 3 !== 0))
    throw new Error("Indexed PNG is missing a valid palette");
  const inflated = new Uint8Array(
    inflateSync(Buffer.concat(idat.map((part) => Buffer.from(part)))),
  );
  const rowBytes = width * channelCount;
  const rows = unfilter(inflated, width, height, channelCount, rowBytes);
  const pixels = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const source = row * rowBytes + column * channelCount;
      const target = (row * width + column) * 4;
      if (colorType === 6) {
        pixels.set(rows.slice(source, source + 4), target);
      } else if (colorType === 2) {
        pixels[target] = rows[source] ?? 0;
        pixels[target + 1] = rows[source + 1] ?? 0;
        pixels[target + 2] = rows[source + 2] ?? 0;
        pixels[target + 3] =
          transparency?.length === 6 &&
          rows[source] === transparency[1] &&
          rows[source + 1] === transparency[3] &&
          rows[source + 2] === transparency[5]
            ? 0
            : 255;
      } else if (colorType === 0) {
        const gray = rows[source] ?? 0;
        pixels[target] = gray;
        pixels[target + 1] = gray;
        pixels[target + 2] = gray;
        pixels[target + 3] = transparency?.length === 2 && gray === transparency[1] ? 0 : 255;
      } else if (colorType === 4) {
        const gray = rows[source] ?? 0;
        pixels[target] = gray;
        pixels[target + 1] = gray;
        pixels[target + 2] = gray;
        pixels[target + 3] = rows[source + 1] ?? 0;
      } else {
        const index = rows[source] ?? 0;
        const paletteOffset = index * 3;
        pixels[target] = palette?.[paletteOffset] ?? 0;
        pixels[target + 1] = palette?.[paletteOffset + 1] ?? 0;
        pixels[target + 2] = palette?.[paletteOffset + 2] ?? 0;
        pixels[target + 3] = transparency?.[index] ?? 255;
      }
    }
  }
  return { width, height, pixels };
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1)
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff;
  for (const value of bytes) crc = crcTable[(crc ^ value) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

const chunk = (type: string, data: Uint8Array): Uint8Array => {
  const typeBytes = Buffer.from(type, "ascii");
  const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length, 0);
  typeBytes.copy(result, 4);
  Buffer.from(data).copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([typeBytes, Buffer.from(data)])), 8 + data.length);
  return result;
};

export function encodePng(image: RgbaImage): Uint8Array {
  if (image.width <= 0 || image.height <= 0) throw new Error("Cannot encode an empty PNG");
  if (image.pixels.length !== image.width * image.height * 4)
    throw new Error("RGBA pixel buffer has the wrong length");
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header[8] = 8;
  header[9] = 6;
  const scanlines = Buffer.alloc(image.height * (1 + image.width * 4));
  for (let row = 0; row < image.height; row += 1) {
    const rowOffset = row * (1 + image.width * 4);
    scanlines[rowOffset] = 0;
    Buffer.from(
      image.pixels.buffer,
      image.pixels.byteOffset + row * image.width * 4,
      image.width * 4,
    ).copy(scanlines, rowOffset + 1);
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(scanlines)),
    chunk("IEND", new Uint8Array()),
  ]);
}

export function readPng(path: string): RgbaImage {
  return decodePng(readFileSync(path));
}

export function writePng(path: string, image: RgbaImage): void {
  writeFileSync(path, encodePng(image));
}

export function compareImages(current: RgbaImage, reference: RgbaImage): PngComparison {
  const sameSize = current.width === reference.width && current.height === reference.height;
  const width = Math.max(current.width, reference.width);
  const height = Math.max(current.height, reference.height);
  const totalPixels = width * height;
  let changedPixels = 0;
  let maximumChannelDelta = 0;
  let totalAbsoluteChannelDelta = 0;
  const length = Math.min(current.pixels.length, reference.pixels.length);
  for (let index = 0; index < length; index += 1) {
    const delta = Math.abs((current.pixels[index] ?? 0) - (reference.pixels[index] ?? 0));
    if (delta > maximumChannelDelta) maximumChannelDelta = delta;
    totalAbsoluteChannelDelta += delta;
  }
  for (let pixelStart = 0; pixelStart < length; pixelStart += 4) {
    if (
      (current.pixels[pixelStart] ?? 0) !== (reference.pixels[pixelStart] ?? 0) ||
      (current.pixels[pixelStart + 1] ?? 0) !== (reference.pixels[pixelStart + 1] ?? 0) ||
      (current.pixels[pixelStart + 2] ?? 0) !== (reference.pixels[pixelStart + 2] ?? 0) ||
      (current.pixels[pixelStart + 3] ?? 0) !== (reference.pixels[pixelStart + 3] ?? 0)
    ) {
      changedPixels += 1;
    }
  }
  if (!sameSize)
    changedPixels +=
      totalPixels - Math.min(current.width * current.height, reference.width * reference.height);
  return {
    same: sameSize && changedPixels === 0,
    width,
    height,
    changedPixels,
    totalPixels,
    changedRatio: totalPixels === 0 ? 0 : changedPixels / totalPixels,
    maximumChannelDelta,
    totalAbsoluteChannelDelta,
  };
}

export function makeDiffImage(current: RgbaImage, reference: RgbaImage): RgbaImage {
  const width = Math.max(current.width, reference.width);
  const height = Math.max(current.height, reference.height);
  const pixels = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const target = (row * width + column) * 4;
      const currentStart = (row * current.width + column) * 4;
      const referenceStart = (row * reference.width + column) * 4;
      const changed =
        row >= current.height ||
        column >= current.width ||
        row >= reference.height ||
        column >= reference.width ||
        current.pixels[currentStart] !== reference.pixels[referenceStart] ||
        current.pixels[currentStart + 1] !== reference.pixels[referenceStart + 1] ||
        current.pixels[currentStart + 2] !== reference.pixels[referenceStart + 2] ||
        current.pixels[currentStart + 3] !== reference.pixels[referenceStart + 3];
      if (changed) {
        pixels[target] = 220;
        pixels[target + 1] = 30;
        pixels[target + 2] = 55;
        pixels[target + 3] = 210;
      } else {
        pixels[target] = current.pixels[currentStart] ?? 0;
        pixels[target + 1] = current.pixels[currentStart + 1] ?? 0;
        pixels[target + 2] = current.pixels[currentStart + 2] ?? 0;
        pixels[target + 3] = 40;
      }
    }
  }
  return { width, height, pixels };
}

export function comparePngFiles(
  currentPath: string,
  referencePath: string,
  diffPath?: string,
): PngComparison {
  const current = readPng(currentPath);
  const reference = readPng(referencePath);
  const comparison = compareImages(current, reference);
  if (diffPath !== undefined) writePng(diffPath, makeDiffImage(current, reference));
  return comparison;
}
