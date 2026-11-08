#!/usr/bin/env node
// Acceptance criterion 2: every vendored upstream file must be byte-identical to
// the pinned commit, except files listed in upstream/PATCHES.md.
//
//   node scripts/verify-upstream.mjs           # verify
//   node scripts/verify-upstream.mjs --update  # rewrite upstream.lock.json
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const upstreamDir = join(root, "upstream");
const lockPath = join(root, "upstream.lock.json");
const patchesPath = join(upstreamDir, "PATCHES.md");

/** Port metadata that lives beside the sources but is not an upstream file. */
const PORT_FILES = new Set(["PATCHES.md"]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function hash(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function relativePosix(file) {
  return relative(upstreamDir, file).split(sep).join("/");
}

/** Rows in upstream/PATCHES.md look like: | `file.ts` | reason | */
function readWhitelist() {
  let text;
  try {
    text = readFileSync(patchesPath, "utf8");
  } catch {
    return [];
  }
  const allowed = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\|\s*`([^`]+)`\s*\|/.exec(line);
    if (match) allowed.push(match[1].trim());
  }
  return allowed;
}

const vendored = walk(upstreamDir).map(relativePosix).filter((file) => !PORT_FILES.has(file)).sort();
const hashes = Object.fromEntries(
  vendored.map((file) => [file, hash(join(upstreamDir, file.split("/").join(sep)))]),
);

if (process.argv.includes("--update")) {
  const lock = {
    upstream: {
      repository: "https://github.com/nicobailon/pi-web-access",
      commit: "6dd57b7f5a0c3041053e65a28f5f425323ec95f9",
      version: "0.47.0",
      pinnedAt: "2026-11-06",
      notes:
        "Root *.ts modules, test/**, package.json, tsconfig.json and LICENSE are vendored verbatim. Binary assets (banner.png, pi-web-fetch-demo.mp4) are not source and are not vendored; upstream/PATCHES.md is port metadata and is excluded.",
    },
    fileCount: vendored.length,
    files: hashes,
  };
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  console.log(`wrote upstream.lock.json with ${vendored.length} files`);
  process.exit(0);
}

const lock = JSON.parse(readFileSync(lockPath, "utf8"));
const whitelist = new Set(readWhitelist());
const problems = [];
let compared = 0;

for (const [file, expected] of Object.entries(lock.files)) {
  compared += 1;
  const actual = hashes[file];
  if (actual === undefined) {
    if (!whitelist.has(file)) problems.push(`missing: ${file}`);
    continue;
  }
  if (actual !== expected && !whitelist.has(file)) problems.push(`changed: ${file}`);
}

for (const file of vendored) {
  if (lock.files[file] === undefined && !whitelist.has(file)) problems.push(`unexpected extra file: ${file}`);
}

console.log(`upstream commit: ${lock.upstream.commit} (v${lock.upstream.version})`);
console.log(`files compared: ${compared}`);
console.log(`patched by design: ${whitelist.size}${whitelist.size ? ` (${[...whitelist].join(", ")})` : ""}`);
console.log(`differences outside the whitelist: ${problems.length}`);
for (const problem of problems.slice(0, 40)) console.error(`  ${problem}`);

if (problems.length > 0) {
  console.error("verify:upstream FAILED");
  process.exit(1);
}
console.log("verify:upstream OK");
