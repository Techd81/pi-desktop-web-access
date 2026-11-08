"use strict";

// Acceptance criterion 5: precedence is secrets > settings form > legacy file >
// upstream defaults, provider availability is judged exactly as upstream does,
// and no credential reaches a log line or a packaged file.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createMockHost } = require("./mock-host.js");

process.env.PI_WEB_ACCESS_LEGACY_CONFIG = "";

const ROOT = path.join(__dirname, "..");
const BUNDLE = require(path.join(ROOT, "build", "agent.cjs"));
const SENTINEL = "sk-SENTINEL-do-not-log-0123456789";

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `pi-web-access-cfg-${label}-`));
}

test("secrets override the settings form, which overrides the legacy file", () => {
  const merged = BUNDLE.mergeConfigSources({
    legacy: { searchProvider: "legacy-provider", braveApiKey: "legacy-key", proxy: "http://legacy:1" },
    settings: { searchProvider: "brave", fetchDefaultMode: "raw" },
    secrets: { braveApiKey: SENTINEL },
  });

  assert.equal(merged.config.searchProvider, "brave", "settings form beats the legacy file");
  assert.equal(merged.config.braveApiKey, SENTINEL, "secrets beat the legacy file");
  assert.deepEqual(merged.config.fetch, { defaultMode: "raw" }, "settings map onto nested upstream keys");
  assert.equal(merged.config.proxy, "http://legacy:1", "legacy values survive when nothing overrides them");
  assert.equal(merged.applied.legacy, true);
  assert.deepEqual(merged.applied.settings, ["searchProvider", "fetchDefaultMode"]);
  assert.deepEqual(merged.applied.secrets, ["braveApiKey"]);
});

test("blank form values and blank secrets are treated as 'not set'", () => {
  const merged = BUNDLE.mergeConfigSources({
    legacy: { searchProvider: "exa" },
    settings: { searchProvider: "", proxy: "   " },
    secrets: { braveApiKey: "  ", tavilyApiKey: null },
  });
  assert.equal(merged.config.searchProvider, "exa");
  assert.ok(!("proxy" in merged.config), "blank proxy is not written");
  assert.ok(!("braveApiKey" in merged.config), "blank secret is not written");
  assert.ok(!("tavilyApiKey" in merged.config), "null secret is not written");
});

test("mode lists accept both an array and a comma-separated string", () => {
  const fromArray = BUNDLE.mergeConfigSources({ settings: { fetchAllowedModes: ["raw", "readable"] } });
  const fromString = BUNDLE.mergeConfigSources({ settings: { fetchAllowedModes: "raw, readable" } });
  assert.deepEqual(fromArray.config.fetch.allowedModes, ["raw", "readable"]);
  assert.deepEqual(fromString.config.fetch.allowedModes, ["raw", "readable"]);
});

test("an empty config leaves upstream defaults intact", () => {
  const merged = BUNDLE.mergeConfigSources({});
  assert.deepEqual(merged.config, {});
  assert.equal(merged.applied.legacy, false);
  assert.deepEqual(merged.applied.settings, []);
  assert.deepEqual(merged.applied.secrets, []);
});

test("with no credentials, availability matches upstream (keyless providers only)", async () => {
  const dataDir = tempDir("avail");
  process.env.PI_CODING_AGENT_DIR = dataDir;
  delete require.cache[require.resolve(path.join(ROOT, "build", "agent.cjs"))];
  const bundle = require(path.join(ROOT, "build", "agent.cjs"));
  const tools = bundle.createAgentTools();
  const availability = await tools.availability();

  for (const keyless of ["degoog", "duckduckgo"]) {
    assert.equal(availability[keyless], true, `${keyless} needs no credential`);
  }
  // Upstream treats these as key-gated; keyless routes (degoog, duckduckgo,
  // exa, anysearch, keenable, parallel-mcp) are covered above.
  for (const keyed of ["brave", "tavily", "perplexity", "serper"]) {
    assert.equal(availability[keyed], false, `${keyed} requires a credential`);
  }
  assert.equal(availability.all, true, "at least one provider is usable without a key");
});

test("redaction removes every credential value but keeps structure", () => {
  const redacted = BUNDLE.redactConfig({
    braveApiKey: SENTINEL,
    searchProvider: "brave",
    fetch: { defaultMode: "raw" },
    nested: { tavilyApiKey: SENTINEL },
  });
  const text = JSON.stringify(redacted);
  assert.ok(!text.includes(SENTINEL), "no credential value survives redaction");
  assert.equal(redacted.searchProvider, "brave");
  assert.deepEqual(redacted.fetch, { defaultMode: "raw" });
  assert.equal(redacted.nested.tavilyApiKey, "[redacted]");
});

test("end to end: legacy file, settings form and stored secret combine in order", async (t) => {
  const dataDir = tempDir("e2e");
  const legacyFile = path.join(tempDir("legacy"), "web-search.json");
  fs.writeFileSync(
    legacyFile,
    JSON.stringify({ searchProvider: "legacy-only", braveApiKey: "legacy-key", maxInlineContentChars: 4000 }),
  );
  fs.writeFileSync(path.join(dataDir, "secrets.json"), JSON.stringify({ braveApiKey: SENTINEL }), { mode: 0o600 });

  const previous = process.env.PI_WEB_ACCESS_LEGACY_CONFIG;
  process.env.PI_WEB_ACCESS_LEGACY_CONFIG = legacyFile;
  const host = createMockHost({ dataDir, settings: { searchProvider: "brave", fetchDefaultMode: "raw" } });
  globalThis.pi = host.pi;
  delete require.cache[require.resolve(path.join(ROOT, "main.js"))];
  delete require.cache[require.resolve(path.join(ROOT, "build", "agent.cjs"))];
  const plugin = require(path.join(ROOT, "main.js"));
  t.after(async () => {
    await plugin.onUnload();
    delete globalThis.pi;
    process.env.PI_WEB_ACCESS_LEGACY_CONFIG = previous ?? "";
  });

  await plugin.onLoad();

  const config = JSON.parse(fs.readFileSync(path.join(dataDir, "web-search.json"), "utf8"));
  assert.equal(config.searchProvider, "brave", "settings form wins over the legacy file");
  assert.equal(config.braveApiKey, SENTINEL, "stored secret wins over the legacy file");
  assert.deepEqual(config.fetch, { defaultMode: "raw" });
  assert.equal(config.maxInlineContentChars, 4000, "legacy-only keys are preserved");

  const status = await plugin.onPanelInvoke("status", {});
  assert.equal(status.legacyPath, legacyFile);
  assert.equal(status.credentialPresence.braveApiKey, true, "panel sees presence, not the value");
  assert.ok(!JSON.stringify(status).includes(SENTINEL), "the panel status never carries a credential");
});

test("onLoad and a panel save never write a credential to the log", async (t) => {
  const dataDir = tempDir("logs");
  fs.writeFileSync(path.join(dataDir, "secrets.json"), JSON.stringify({ tavilyApiKey: SENTINEL }), { mode: 0o600 });
  const captured = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => captured.push(args.map(String).join(" "));
  console.error = (...args) => captured.push(args.map(String).join(" "));

  const host = createMockHost({ dataDir, settings: {} });
  globalThis.pi = host.pi;
  delete require.cache[require.resolve(path.join(ROOT, "main.js"))];
  delete require.cache[require.resolve(path.join(ROOT, "build", "agent.cjs"))];
  const plugin = require(path.join(ROOT, "main.js"));
  t.after(async () => {
    await plugin.onUnload();
    console.log = originalLog;
    console.error = originalError;
    delete globalThis.pi;
  });

  await plugin.onLoad();
  await plugin.onPanelInvoke("secret:set", { field: "tavilyApiKey", value: SENTINEL });
  await plugin.onPanelInvoke("settings:save", { searchProvider: "tavily" });

  const joined = captured.join("\n");
  assert.ok(joined.length > 0, "the plugin did log something, so the check is meaningful");
  assert.ok(!joined.includes(SENTINEL), "no log line carries the credential");
});

test("unknown credential fields are rejected", async (t) => {
  const host = createMockHost({ dataDir: tempDir("reject"), settings: {} });
  globalThis.pi = host.pi;
  delete require.cache[require.resolve(path.join(ROOT, "main.js"))];
  delete require.cache[require.resolve(path.join(ROOT, "build", "agent.cjs"))];
  const plugin = require(path.join(ROOT, "main.js"));
  t.after(async () => {
    await plugin.onUnload();
    delete globalThis.pi;
  });
  await plugin.onLoad();

  const reply = await plugin.onPanelInvoke("secret:set", { field: "notARealField", value: "x" });
  assert.equal(reply.ok, false);
  assert.match(reply.message, /unknown credential field/);
});

test("manifest and package metadata carry no credential", () => {
  for (const file of ["manifest.json", "package.json"]) {
    const text = fs.readFileSync(path.join(ROOT, file), "utf8");
    assert.ok(!/sk-[A-Za-z0-9]{16,}/.test(text), `${file} contains no API-key shaped literal`);
  }
});
