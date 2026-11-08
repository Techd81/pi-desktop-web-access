#!/usr/bin/env node
// Install this plugin into the local PI-Desktop profile, without the GUI.
//
//   npm run install:local
//
// What it does:
//   1. unzips dist/<id>-<version>.piplug into
//      %USERPROFILE%\.pi-desktop\plugins\installed\<id>\
//   2. upserts one entry in plugins/registry.json (backup kept on first run)
//
// It is idempotent: rerunning replaces the files and keeps installedAt.
// High-risk permissions are NOT granted here — the host asks for those in the
// Plugins page, and a script must not forge that consent.
//
// The host keeps the registry in memory while it runs, so a run against a live
// PI-Desktop can be overwritten when it next writes the file. Rerun this after
// quitting the app, or enable the plugin from the Plugins page once.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const artifactPath = join(root, "dist", `${manifest.id}-${manifest.version}.piplug`);
const pluginsDir = join(homedir(), ".pi-desktop", "plugins");
const registryPath = join(pluginsDir, "registry.json");
const backupPath = join(pluginsDir, "registry.json.bak-pi-web-access");
const target = join(pluginsDir, "installed", manifest.id);

function fail(message) {
  console.error(`install:local FAILED: ${message}`);
  process.exit(1);
}

if (!existsSync(artifactPath)) fail(`missing artifact ${artifactPath}; run "npm run pack" first`);

/** Store-only ZIP reader, matching scripts/pack.mjs. */
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
    entries.push({ name, method, data: buffer.subarray(start, start + size) });
    offset = start + size;
  }
  return entries;
}

// 1. files
const entries = readEntries(readFileSync(artifactPath));
if (entries.length === 0) fail("the artifact contains no readable entries");
if (existsSync(target)) rmSync(target, { recursive: true, force: true });
for (const entry of entries) {
  if (entry.method !== 0) fail(`entry ${entry.name} is compressed; expected a store-only .piplug`);
  const out = join(target, ...entry.name.split("/"));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, entry.data);
}
console.log(`files: ${entries.length} → ${target}`);
for (const required of ["manifest.json", "main.js", "build/agent.cjs"]) {
  if (!existsSync(join(target, ...required.split("/")))) fail(`${required} missing after extraction`);
}

// 2. registry entry
const raw = readFileSync(registryPath, "utf8");
const registry = JSON.parse(raw);
if (!Array.isArray(registry)) fail("registry.json is not an array");
if (!existsSync(backupPath)) {
  writeFileSync(backupPath, raw);
  console.log(`backup: ${backupPath}`);
}

const stamp = new Date().toISOString().replace("Z", "+00:00");
const entry = {
  id: manifest.id,
  name: manifest.name,
  version: manifest.version,
  enabled: true,
  scope: { mode: "global", projects: [] },
  source: "dev",
  bundled: false,
  status: "ready",
  permissions: [...(manifest.permissions ?? [])],
  path: target,
  capabilities: ["tools", "views"],
  description: manifest.description,
  author: manifest.author,
  installedAt: stamp,
  updatedAt: stamp,
  autoUpdate: false,
};

const index = registry.findIndex((item) => item && item.id === manifest.id);
if (index >= 0) {
  entry.installedAt = registry[index].installedAt ?? stamp;
  registry[index] = entry;
} else {
  registry.push(entry);
}
writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
console.log(`registry: ${index >= 0 ? "updated" : "registered"} ${manifest.id} (${registry.length} entries)`);

// 3. tell the user what still needs a human
let running = false;
try {
  const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq PI-Desktop.exe", "/NH"], { encoding: "utf8" });
  running = /PI-Desktop\.exe/i.test(out);
} catch {
  running = false;
}
console.log("");
console.log("installed. Next:");
console.log("  1. The host reads registry.json at startup: restart PI-Desktop if the plugin does not appear.");
if (running) console.log("     PI-Desktop is running right now, so a quit may overwrite this entry — rerun this command after quitting if needed.");
const HIGH_RISK_PERMISSIONS = [
  "agent.tool.register",
  "net.anyHost",
  "net.fetch",
  "agent.prompt.inject",
  "agent.complete",
  "browser.cdp",
  "desktop.control",
  "fs.write",
  "fs.delete",
];
const highRisk = (manifest.permissions ?? []).filter((permission) => HIGH_RISK_PERMISSIONS.includes(permission));
console.log(`  2. Grant the high-risk permissions once in Plugins (${highRisk.join(", ")}); the host asks, a script must not.`);
console.log("  3. Work panel → view menu → 联网访问, then add a provider key or use degoog/duckduckgo as-is.");

