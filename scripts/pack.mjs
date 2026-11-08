#!/usr/bin/env node
// Acceptance criterion 6: produce dist/pi.web-access-<version>.piplug.
//
// A .piplug is a store-only (uncompressed) ZIP, so this writes it by hand instead
// of pulling a zip dependency into a package that must ship without one.
//
// The shipped set is deliberately narrow: the manifest, the entry point, the
// pre-built bundle, the panel assets, the licence and the documentation. Sources,
// development scripts and tests stay in the repository, and nothing outside it
// (plugin data, credentials) can ever be picked up because the walk starts at the
// repository root's explicit include list.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const artifactName = `${manifest.id}-${manifest.version}.piplug`;
const artifactPath = join(root, "dist", artifactName);

/** Explicit include list: directories are walked, files are taken as-is. */
const INCLUDE_DIRS = ["views", "skills", "upstream"];
const INCLUDE_FILES = [
  "manifest.json",
  "main.js",
  "build/agent.cjs",
  "README.md",
  "LICENSE",
  "docs/PORT-NOTES.md",
  "upstream.lock.json",
];
/** Never ship these, even if they appear in an included directory. */
const SKIP_DIRS = new Set(["node_modules", "test", "dist", "build", ".git", ".pi"]);
const SKIP_FILES = new Set(["package-lock.json", "tsconfig.json"]);

function walk(relativePath, out = []) {
  const absolute = join(root, relativePath);
  let stats;
  try {
    stats = statSync(absolute);
  } catch {
    return out;
  }
  if (stats.isDirectory()) {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
      if (entry.isFile() && SKIP_FILES.has(entry.name)) continue;
      walk(join(relativePath, entry.name), out);
    }
  } else if (stats.isFile()) {
    out.push(relativePath.split(sep).join("/"));
  }
  return out;
}

// `upstream/test` is a development fixture set; the sources beside it still ship.
function collect() {
  const files = [...INCLUDE_FILES];
  for (const dir of INCLUDE_DIRS) {
    for (const file of walk(dir)) {
      if (file.startsWith("upstream/test/")) continue;
      files.push(file);
    }
  }
  return [...new Set(files)].sort();
}

/* -------------------------------------------------------------------- zip */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0x8f3cd5b1 ^ (value >>> 1) : value >>> 1;
    table[index] = value;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[index]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

function dosTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const { time, day } = dosTime(new Date());

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = entry.data;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += local.length + name.length + data.length;
  }

  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, end]);
}

const files = collect();
const entries = files.map((name) => ({ name, data: readFileSync(join(root, name.split("/").join(sep))) }));
const zip = buildZip(entries);

mkdirSync(join(root, "dist"), { recursive: true });
writeFileSync(artifactPath, zip);

const relativePath = relative(root, artifactPath).split(sep).join("/");
console.log(`packed ${relativePath}`);
console.log(`files: ${entries.length}`);
console.log(`size: ${(zip.length / (1024 * 1024)).toFixed(2)} MiB`);
console.log(`sha256: ${createHash("sha256").update(zip).digest("hex")}`);
