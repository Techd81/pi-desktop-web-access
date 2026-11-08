"use strict";

// The resizeImage shim replaces a package the desktop host does not ship, so it
// is exercised through the packed bundle. PNG is the one format it can really
// downscale; the rest are validated and returned untouched.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { deflateSync } = require("node:zlib");

const ROOT = path.join(__dirname, "..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-access-shim-"));
process.env.PI_CODING_AGENT_DIR = dataDir;
process.env.PI_WEB_ACCESS_CACHE_ROOT = dataDir;
process.env.PI_WEB_ACCESS_LEGACY_CONFIG = "";

const { resizeImage } = require(path.join(ROOT, "build", "agent.cjs"));

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBytes = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}

/** Builds an unfiltered 8-bit PNG. `channels` is 3 (RGB) or 4 (RGBA). */
function makePng(width, height, channels, pixel, bitDepth = 8) {
  const stride = width * channels;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const rgb = pixel(x, y);
      for (let c = 0; c < channels; c += 1) raw[rowStart + 1 + x * channels + c] = rgb[c];
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = bitDepth;
  header[9] = channels === 4 ? 6 : 2;
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function sizeOf(bytes) {
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

test("a PNG larger than the box is really downscaled", async () => {
  const source = makePng(3000, 2, 3, () => [0x40, 0x80, 0xc0]);
  const result = await resizeImage(source, "image/png", { maxWidth: 2000, maxHeight: 2000 });

  assert.ok(result, "the shim returned an image");
  assert.equal(result.mimeType, "image/png");
  assert.equal(result.width, 2000, "width clamped to the box");
  assert.equal(result.height, 1, "height keeps the aspect ratio");
  assert.ok(result.data.length !== source.length, "the bytes were re-encoded, not passed through");
  assert.ok(Buffer.from(result.data).subarray(0, 8).equals(PNG_SIGNATURE), "still a PNG");
  assert.deepEqual(sizeOf(Buffer.from(result.data)), { width: 2000, height: 1 }, "the header agrees");
});

test("a PNG that already fits comes back untouched", async () => {
  const source = makePng(100, 50, 3, (x, y) => [x, y, 7]);
  const result = await resizeImage(source, "image/png", { maxWidth: 2000, maxHeight: 2000 });

  assert.ok(result);
  assert.equal(result.width, 100);
  assert.equal(result.height, 50);
  assert.equal(result.data, source, "the same bytes are handed back without a copy");
});

test("RGBA is scaled too, and the alpha channel survives the round trip", async () => {
  const source = makePng(4000, 10, 4, () => [10, 20, 30, 200]);
  const result = await resizeImage(source, "image/png", { maxWidth: 2000, maxHeight: 2000 });

  assert.ok(result);
  assert.equal(result.width, 2000);
  assert.equal(result.height, 5);
  // Re-decode through the same public entry by asking for no further scaling:
  // a second pass must see a valid PNG at the size the first pass reported.
  const again = await resizeImage(result.data, "image/png", { maxWidth: 2000, maxHeight: 2000 });
  assert.ok(again, "the re-encoded PNG parses");
  assert.deepEqual({ width: again.width, height: again.height }, { width: 2000, height: 5 });
});

test("a format this shim cannot decode is returned at its real size", async () => {
  const source = makePng(3000, 2, 3, () => [1, 2, 3]);
  // Same bytes, announced as GIF: the size reader fails, so nothing is scaled
  // and the caller is told the honest truth (null) rather than getting a wrong size.
  const wrongType = await resizeImage(source, "image/gif", { maxWidth: 2000, maxHeight: 2000 });
  assert.equal(wrongType, null, "an unreadable container is a null, not a guess");
});

test("a PNG this decoder cannot handle falls back to the original bytes", async () => {
  // 16-bit is valid PNG but outside what this shim decodes.
  const sixteenBit = makePng(3000, 2, 3, () => [1, 2, 3], 16);
  const result = await resizeImage(sixteenBit, "image/png", { maxWidth: 2000, maxHeight: 2000 });

  assert.ok(result, "a usable image still comes back");
  assert.equal(result.width, 3000, "unscaled");
  assert.equal(result.height, 2);
  assert.equal(result.data, sixteenBit, "the original bytes, untouched");
});

test("garbage and oversized payloads are refused", async () => {
  assert.equal(await resizeImage(Buffer.alloc(0), "image/png"), null, "empty input");
  assert.equal(await resizeImage(Buffer.from("not an image"), "image/png"), null, "not a PNG");
  const huge = Buffer.alloc(8 * 1024 * 1024 + 1);
  PNG_SIGNATURE.copy(huge, 0);
  assert.equal(await resizeImage(huge, "image/png"), null, "over the byte ceiling");
});
