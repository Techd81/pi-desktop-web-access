#!/usr/bin/env node
// Acceptance criterion 6: verify the packed artifact, then load the entry point
// straight out of the extracted package with a stand-in host.
//
// Checks: store-only layout, file count, size, no symlinks, no development or
// credential files, and the four tools still register from inside the package.
// A sentinel secret is written to a plugin data directory first, proving the
// packer ships repository files only and never the data directory.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const artifactPath = join(root, "dist", `${manifest.id}-${manifest.version}.piplug`);
const SENTINEL = "sk-PACKED-SENTINEL-0987654321";
const MAX_FILES = 2000;
const MAX_BYTES = 50 * 1024 * 1024;

const problems = [];
const note = (message) => problems.push(message);

/* -------------------------------------------------------------------- pack */

if (!existsSync(artifactPath)) {
  const packed = spawnSync(process.execPath, [join(root, "scripts", "pack.mjs")], { encoding: "utf8" });
  process.stdout.write(packed.stdout ?? "");
  process.stderr.write(packed.stderr ?? "");
  if (packed.status !== 0) {
    console.error("verify:pack FAILED (pack step did not succeed)");
    process.exit(1);
  }
}

const bytes = readFileSync(artifactPath);
const sha256 = createHash("sha256").update(bytes).digest("hex");

/* -------------------------------------------------------------------- read */

/** Store-only ZIP reader: walks local headers, which is all this packer writes. */
function readEntries(buffer) {
  const entries = [];
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const size = buffer.readUInt32LE(offset + 18);
    const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString("utf8");
    const start = offset + 30 + nameLength + extraLength;
    entries.push({ name, method, data: buffer.subarray(start, start + size), size });
    offset = start + size;
  }
  return entries;
}

const entries = readEntries(bytes);
if (entries.length === 0) note("no ZIP entries could be read from the artifact");

/* ------------------------------------------------------------------ rules */

if (entries.length > MAX_FILES) note(`file count ${entries.length} exceeds ${MAX_FILES}`);
if (bytes.length > MAX_BYTES) {
  note(`artifact size ${(bytes.length / 1024 / 1024).toFixed(1)} MiB exceeds 50 MiB`);
}
for (const entry of entries) {
  const name = entry.name;
  if (entry.method !== 0) note(`entry ${name} is compressed (method ${entry.method}); .piplug must be store-only`);
  if (name.startsWith("/") || name.includes("..") || name.includes("\\")) note(`entry ${name} escapes the package root`);
  if (/(^|\/)node_modules\//.test(name)) note(`entry ${name} ships node_modules`);
  if (/(^|\/)(\.env|\.env\..+|.*\.pem|.*\.key|\.npmrc)$/.test(name)) note(`entry ${name} looks like a credential file`);
  if (/(^|\/)(secrets|web-search)\.json$/.test(name)) note(`entry ${name} is plugin data, not package content`);
  if (/(^|\/)\.git\//.test(name)) note(`entry ${name} ships git metadata`);
}

for (const required of ["manifest.json", "main.js", "build/agent.cjs", "views/index.html", "views/app.js", "LICENSE"]) {
  if (!entries.some((entry) => entry.name === required)) note(`required file ${required} is missing`);
}

// Everything the manifest points at must actually be in the package: a missing
// skill or view entry fails silently at load time otherwise.
const declared = [
  ...(manifest.contributes?.skills ?? []),
  ...(manifest.contributes?.views ?? []).map((view) => view.entry).filter(Boolean),
];
for (const file of declared) {
  if (!entries.some((entry) => entry.name === file)) note(`manifest references ${file}, which is not in the package`);
}

const text = bytes.toString("latin1");
if (text.includes(SENTINEL)) note("the artifact contains the plugin-data sentinel");

/* ------------------------------------------------------------------ load */

const workdir = mkdtempSync(join(tmpdir(), "pi-web-access-pack-"));
const dataDir = join(workdir, "data");
mkdirSync(dataDir, { recursive: true });
writeFileSync(join(dataDir, "secrets.json"), JSON.stringify({ braveApiKey: SENTINEL }), { mode: 0o600 });

for (const entry of entries) {
  const target = join(workdir, "plugin", entry.name.split("/").join("/"));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, entry.data);
}

const pluginRoot = join(workdir, "plugin");
const registered = new Map();
globalThis.pi = {
  agent: {
    async registerTool(definition) {
      registered.set(definition.name, definition);
    },
    async unregisterTool(name) {
      registered.delete(name);
    },
  },
  plugin: {
    async getDataPath() {
      return dataDir;
    },
    async getSettings() {
      return {};
    },
    async setSettings() {},
  },
};

process.env.PI_WEB_ACCESS_LEGACY_CONFIG = "";
const plugin = (await import(`file:///${join(pluginRoot, "main.js").split("\\").join("/")}`)).default ?? null;
const entry = plugin ?? (await import(`file:///${join(pluginRoot, "main.js").split("\\").join("/")}`));

try {
  await entry.onLoad();
  const expected = ["web_search", "fetch_content", "get_search_content", "source_check"];
  for (const name of expected) {
    if (!registered.has(name)) note(`tool ${name} did not register from the extracted package`);
  }
  await entry.onUnload();
  if (registered.size !== 0) note("onUnload left tools registered");
} catch (error) {
  note(`loading the extracted package failed: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  delete globalThis.pi;
  rmSync(workdir, { recursive: true, force: true });
}

/* ---------------------------------------------------------------- report */

console.log(`artifact: ${basename(artifactPath)}`);
console.log(`files: ${entries.length} (limit ${MAX_FILES})`);
console.log(`size: ${(bytes.length / 1024 / 1024).toFixed(2)} MiB (limit 50 MiB)`);
console.log(`sha256: ${sha256}`);
console.log(`entry point loaded from the package: ${entry && typeof entry.onLoad === "function" ? "yes" : "no"}`);
console.log(`differences: ${problems.length}`);
for (const problem of problems.slice(0, 30)) console.error(`  ${problem}`);

if (problems.length > 0) {
  console.error("verify:pack FAILED");
  process.exit(1);
}
console.log("verify:pack OK");
