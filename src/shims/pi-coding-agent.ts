/**
 * Desktop stand-in for the only *runtime* import upstream takes from
 * `@earendil-works/pi-coding-agent`: `resizeImage` in the direct-image branch
 * (`upstream/extract.ts`). Every other import of that specifier in `upstream/`
 * is `import type` and is erased at build time.
 *
 * The desktop host does not ship that package. Without this shim the dynamic
 * import rejects, so a direct image URL could never be returned even when the
 * caller allows images. `scripts/build.mjs` aliases the specifier here.
 *
 * Downscaling is real for PNG and a no-op for everything else. PNG is the one
 * format this port can decode and re-encode with `node:zlib` alone — no native
 * module, no image library. JPEG, WebP and GIF are validated and returned at
 * their original size, because decoding them would need a codec this port
 * deliberately does not depend on.
 *
 * A PNG that this decoder cannot handle (16-bit, palette, interlaced, corrupt)
 * is returned untouched rather than failing: the caller still gets a usable
 * image, just at the original size.
 */
import { deflateSync, inflateSync } from "node:zlib";

export interface ResizedImage {
  data: Uint8Array;
  mimeType: string;
  width: number;
  height: number;
}

/** 8 MiB: base64 in a tool result inflates this to ~11 MiB of text. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

interface PixelSize {
  width: number;
  height: number;
}

function u16be(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function u32be(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function pngSize(bytes: Uint8Array): PixelSize | null {
  // IHDR follows the 8-byte signature: length, type, then width and height.
  if (bytes.length < 24) return null;
  if (PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte)) return null;
  if (String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]) !== "IHDR") return null;
  return { width: u32be(bytes, 16), height: u32be(bytes, 20) };
}

function gifSize(bytes: Uint8Array): PixelSize | null {
  if (bytes.length < 10) return null;
  const header = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5]);
  if (header !== "GIF87a" && header !== "GIF89a") return null;
  return { width: bytes[6] | (bytes[7] << 8), height: bytes[8] | (bytes[9] << 8) };
}

/** Walks the JPEG marker chain to the first start-of-frame segment. */
function jpegSize(bytes: Uint8Array): PixelSize | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    // Fill bytes, standalone markers without a length field, and the end marker.
    if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }
    const length = u16be(bytes, offset + 2);
    if (length < 2) return null;
    // SOF0..SOF15 carry the frame size; C4 (Huffman), C8 (JPG) and CC (arith) do not.
    const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame) {
      if (offset + 9 >= bytes.length) return null;
      return { height: u16be(bytes, offset + 5), width: u16be(bytes, offset + 7) };
    }
    offset += 2 + length;
  }
  return null;
}

function webpSize(bytes: Uint8Array): PixelSize | null {
  if (bytes.length < 30) return null;
  const riff = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  const webp = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
  if (riff !== "RIFF" || webp !== "WEBP") return null;
  const chunk = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
  if (chunk === "VP8X") {
    // Canvas size is stored as width-1 / height-1 in 24-bit little-endian.
    const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
    const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
    return { width, height };
  }
  if (chunk === "VP8 ") {
    // Lossy: 3-byte frame tag, 3-byte start code, then 14-bit dimensions.
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    return { width: (bytes[26] | (bytes[27] << 8)) & 0x3fff, height: (bytes[28] | (bytes[29] << 8)) & 0x3fff };
  }
  if (chunk === "VP8L") {
    // Lossless: signature byte then packed 14-bit width-1 / height-1.
    if (bytes[20] !== 0x2f) return null;
    const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  return null;
}

function readSize(bytes: Uint8Array, mimeType: string): PixelSize | null {
  switch (mimeType) {
    case "image/png":
      return pngSize(bytes);
    case "image/jpeg":
      return jpegSize(bytes);
    case "image/gif":
      return gifSize(bytes);
    case "image/webp":
      return webpSize(bytes);
    default:
      return null;
  }
}

/* ------------------------------------------------------------ png scaling */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBytes = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}

interface DecodedPng {
  width: number;
  height: number;
  /** 3 for RGB, 4 for RGBA. */
  channels: number;
  pixels: Buffer;
}

/** Decodes 8-bit, non-interlaced RGB/RGBA PNG. Anything else returns null. */
function decodePng(bytes: Buffer): DecodedPng | null {
  if (bytes.length < 8 || PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte)) return null;
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat: Buffer[] = [];

  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    // Length + type + data + CRC all have to be present before the CRC is read.
    if (dataStart + length + 4 > bytes.length) return null;
    const data = bytes.subarray(dataStart, dataStart + length);
    if (type === "IHDR" || type === "IDAT") {
      const recordedCrc = bytes.readUInt32BE(dataStart + length);
      if (crc32(Buffer.concat([Buffer.from(type, "ascii"), data])) !== recordedCrc) return null;
    }
    if (type === "IHDR") {
      if (length < 13) return null;
      width = bytes.readUInt32BE(dataStart);
      height = bytes.readUInt32BE(dataStart + 4);
      bitDepth = bytes[dataStart + 8];
      colorType = bytes[dataStart + 9];
      interlace = bytes[dataStart + 12];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      if (length !== 0) return null;
      break;
    }
    offset = dataStart + length + 4;
  }

  if (width <= 0 || height <= 0) return null;
  if (bitDepth !== 8 || interlace !== 0) return null;
  const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : 0;
  if (channels === 0 || idat.length === 0) return null;

  // Gate before decompression: IHDR alone can claim a 20000x20000 canvas while
  // the IDAT payload is a few hundred bytes. Bound the inflated size up front so
  // zlib refuses to build the bomb, instead of allocating it and rejecting later.
  const stride = width * channels;
  const expected = height * (stride + 1);
  if (!Number.isSafeInteger(expected) || expected <= 0 || expected > 64 * 1024 * 1024) return null;

  let raw: Buffer;
  try {
    // +1 lets an overlong stream throw instead of being silently truncated.
    raw = inflateSync(Buffer.concat(idat), { maxOutputLength: expected + 1 });
  } catch {
    return null;
  }
  if (raw.length < expected) return null;

  const pixels = Buffer.alloc(stride * height);
  let position = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[position];
    position += 1;
    const rowStart = y * stride;
    const previousStart = rowStart - stride;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[position + x];
      const left = x >= channels ? pixels[rowStart + x - channels] : 0;
      const above = y > 0 ? pixels[previousStart + x] : 0;
      const aboveLeft = y > 0 && x >= channels ? pixels[previousStart + x - channels] : 0;
      let restored: number;
      switch (filter) {
        case 0:
          restored = value;
          break;
        case 1:
          restored = value + left;
          break;
        case 2:
          restored = value + above;
          break;
        case 3:
          restored = value + ((left + above) >> 1);
          break;
        case 4: {
          const estimate = left + above - aboveLeft;
          const distanceLeft = Math.abs(estimate - left);
          const distanceAbove = Math.abs(estimate - above);
          const distanceAboveLeft = Math.abs(estimate - aboveLeft);
          const predictor =
            distanceLeft <= distanceAbove && distanceLeft <= distanceAboveLeft
              ? left
              : distanceAbove <= distanceAboveLeft
                ? above
                : aboveLeft;
          restored = value + predictor;
          break;
        }
        default:
          return null;
      }
      pixels[rowStart + x] = restored & 0xff;
    }
    position += stride;
  }
  return { width, height, channels, pixels };
}

function encodePng(width: number, height: number, channels: number, pixels: Buffer): Buffer {
  const stride = width * channels;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = channels === 4 ? 6 : 2; // colour type: RGBA or RGB
  return Buffer.concat([
    Buffer.from(PNG_SIGNATURE),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw, { level: 6 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Area-average downscale: every source pixel inside a target cell contributes. */
function downscale(source: Buffer, sourceWidth: number, sourceHeight: number, channels: number, targetWidth: number, targetHeight: number): Buffer {
  const output = Buffer.alloc(targetWidth * targetHeight * channels);
  const xRatio = sourceWidth / targetWidth;
  const yRatio = sourceHeight / targetHeight;
  for (let y = 0; y < targetHeight; y += 1) {
    const yStart = Math.floor(y * yRatio);
    const yEnd = Math.max(yStart + 1, Math.floor((y + 1) * yRatio));
    for (let x = 0; x < targetWidth; x += 1) {
      const xStart = Math.floor(x * xRatio);
      const xEnd = Math.max(xStart + 1, Math.floor((x + 1) * xRatio));
      const sums = new Array(channels).fill(0);
      let count = 0;
      for (let sy = yStart; sy < yEnd; sy += 1) {
        for (let sx = xStart; sx < xEnd; sx += 1) {
          const at = (sy * sourceWidth + sx) * channels;
          if (channels === 4) {
            // Premultiply: a fully transparent pixel carries no colour, so its RGB
            // must not drag the average towards black (the halo around cut-outs).
            const alpha = source[at + 3];
            sums[0] += source[at] * alpha;
            sums[1] += source[at + 1] * alpha;
            sums[2] += source[at + 2] * alpha;
            sums[3] += alpha;
          } else {
            for (let c = 0; c < channels; c += 1) sums[c] += source[at + c];
          }
          count += 1;
        }
      }
      const to = (y * targetWidth + x) * channels;
      if (channels === 4) {
        const alphaSum = sums[3];
        if (alphaSum > 0) {
          output[to] = Math.round(sums[0] / alphaSum);
          output[to + 1] = Math.round(sums[1] / alphaSum);
          output[to + 2] = Math.round(sums[2] / alphaSum);
        } else {
          output[to] = 0;
          output[to + 1] = 0;
          output[to + 2] = 0;
        }
        output[to + 3] = Math.round(alphaSum / count);
      } else {
        for (let c = 0; c < channels; c += 1) output[to + c] = Math.round(sums[c] / count);
      }
    }
  }
  return output;
}

/** Returns the shrunk PNG, or null when this decoder cannot handle it. */
function shrinkPng(bytes: Buffer, width: number, height: number, maxWidth: number, maxHeight: number): { data: Buffer; width: number; height: number } | null {
  try {
    const decoded = decodePng(bytes);
    if (!decoded) return null;
    const scale = Math.min(maxWidth / decoded.width, maxHeight / decoded.height);
    const targetWidth = Math.max(1, Math.round(decoded.width * scale));
    const targetHeight = Math.max(1, Math.round(decoded.height * scale));
    if (targetWidth >= decoded.width && targetHeight >= decoded.height) return null;
    const pixels = downscale(decoded.pixels, decoded.width, decoded.height, decoded.channels, targetWidth, targetHeight);
    const data = encodePng(targetWidth, targetHeight, decoded.channels, pixels);
    // The caller's ceiling is on the bytes it has to carry, not on the input:
    // a photo-like 3000x3000 RGBA source can re-encode larger than it started.
    if (data.length > MAX_IMAGE_BYTES) return null;
    return { data, width: targetWidth, height: targetHeight };
  } catch {
    return null;
  }
}

/**
 * Upstream calls this with `{ maxWidth: 2000, maxHeight: 2000 }`. A PNG larger
 * than the box comes back downscaled; every other format comes back with its
 * real pixel size and untouched bytes.
 */
export async function resizeImage(
  data: Uint8Array,
  mimeType: string,
  options?: { maxWidth?: number; maxHeight?: number },
): Promise<ResizedImage | null> {
  if (!(data instanceof Uint8Array) || data.byteLength === 0) return null;
  if (data.byteLength > MAX_IMAGE_BYTES) return null;
  const size = readSize(data, mimeType);
  if (!size || size.width <= 0 || size.height <= 0) return null;

  const maxWidth = options?.maxWidth ?? 2000;
  const maxHeight = options?.maxHeight ?? 2000;
  if (mimeType === "image/png" && (size.width > maxWidth || size.height > maxHeight)) {
    const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    const shrunk = shrinkPng(buffer, size.width, size.height, maxWidth, maxHeight);
    if (shrunk) {
      return { data: shrunk.data, mimeType, width: shrunk.width, height: shrunk.height };
    }
  }
  return { data, mimeType, width: size.width, height: size.height };
}
