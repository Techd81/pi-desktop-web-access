"use strict";

// Acceptance criterion 1: the four tools register with a complete descriptor,
// the manifest describes exactly the same set, and unload unregisters them all.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { createMockHost } = require("./mock-host.js");

// Hermetic runs: never read a real ~/.pi/web-search.json from this machine.
process.env.PI_WEB_ACCESS_LEGACY_CONFIG = "";

const ROOT = path.join(__dirname, "..");
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const EXPECTED_TOOLS = ["web_search", "fetch_content", "get_search_content", "source_check"];

/** Loads a fresh plugin instance. The bundle caches the upstream config path on
 * first require, so both modules must leave the cache to isolate one test from
 * the next. */
function loadPlugin(host) {
  globalThis.pi = host.pi;
  delete require.cache[require.resolve(path.join(ROOT, "main.js"))];
  delete require.cache[require.resolve(path.join(ROOT, "build", "agent.cjs"))];
  return require(path.join(ROOT, "main.js"));
}

function withPlugin(t, settings = {}) {
  const host = createMockHost({ settings });
  const plugin = loadPlugin(host);
  t.after(async () => {
    await plugin.onUnload();
    delete globalThis.pi;
  });
  return { host, plugin };
}

test("onLoad registers every enabled tool with a complete descriptor", async (t) => {
  const { host, plugin } = withPlugin(t);
  await plugin.onLoad();

  assert.deepEqual([...host.registered.keys()].sort(), [...EXPECTED_TOOLS].sort(), "all four tools registered");
  for (const [name, definition] of host.registered) {
    assert.equal(definition.name, name, `${name}: name`);
    assert.equal(typeof definition.description, "string", `${name}: description`);
    assert.ok(definition.description.length > 20, `${name}: description is substantive`);
    assert.ok(["low", "medium", "high"].includes(definition.risk), `${name}: risk`);
    assert.equal(typeof definition.schema, "object", `${name}: schema`);
    assert.equal(definition.schema.type, "object", `${name}: schema is an object schema`);
    assert.equal(typeof definition.execute, "function", `${name}: execute`);
  }
});

test("manifest.contributes.agentTools matches the registered set and schemas", async (t) => {
  const { host, plugin } = withPlugin(t);
  await plugin.onLoad();

  const declared = MANIFEST.contributes.agentTools;
  assert.deepEqual(declared.map((tool) => tool.name).sort(), [...EXPECTED_TOOLS].sort(), "manifest names");

  for (const tool of declared) {
    const runtime = host.registered.get(tool.name);
    assert.ok(runtime, `${tool.name}: declared in manifest and registered`);
    assert.equal(tool.risk, runtime.risk, `${tool.name}: risk matches the manifest`);
    assert.equal(tool.description, runtime.description, `${tool.name}: description matches the manifest`);
    assert.deepEqual(
      tool.schema,
      JSON.parse(JSON.stringify(runtime.schema)),
      `${tool.name}: schema matches the manifest`,
    );
  }
});

test("onUnload unregisters every tool it registered", async () => {
  const host = createMockHost({ settings: {} });
  const plugin = loadPlugin(host);
  await plugin.onLoad();
  assert.equal(host.registered.size, EXPECTED_TOOLS.length);

  await plugin.onUnload();
  delete globalThis.pi;

  assert.equal(host.registered.size, 0, "nothing left registered");
  assert.deepEqual([...host.calls.unregistered].sort(), [...EXPECTED_TOOLS].sort(), "all four unregistered");
});

test("the config file is materialised inside the plugin data directory", async (t) => {
  const { host, plugin } = withPlugin(t);
  await plugin.onLoad();

  const configPath = path.join(host.dataDir, "web-search.json");
  assert.ok(fs.existsSync(configPath), "config written to the plugin data directory");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.equal(typeof config, "object");
  assert.ok(!("braveApiKey" in config), "no credential leaks into a default config");
});

test("a disabled tool is not registered and the panel status reports it", async (t) => {
  const { host, plugin } = withPlugin(t, { enableSourceCheck: false });
  await plugin.onLoad();

  assert.deepEqual(
    [...host.registered.keys()].sort(),
    ["fetch_content", "get_search_content", "web_search"],
    "source_check stays unregistered",
  );

  const status = await plugin.onPanelInvoke("status", {});
  assert.equal(status.ok, true);
  assert.ok(!status.enabledTools.includes("source_check"), "status reports the disabled tool");
});

test("an unknown panel channel is reported, not thrown", async (t) => {
  const { plugin } = withPlugin(t);
  await plugin.onLoad();

  const reply = await plugin.onPanelInvoke("nope", {});
  assert.equal(reply.ok, false);
  assert.equal(reply.code, "UNKNOWN_CHANNEL");
});

/* -------------------------------------------- widened surface and persistence */

const COMMANDS = ["pi.web-access.open", "pi.web-access.results", "pi.web-access.settings"];

test("fetch_content exposes what the MCP schema withholds", async (t) => {
  const { host, plugin } = withPlugin(t);
  await plugin.onLoad();

  const schema = host.registered.get("fetch_content").schema;
  assert.deepEqual(schema.properties.mode.enum, ["readable", "raw", "answer", "extract"], "every mode is offered");
  for (const name of ["prompt", "answerModel", "timestamp", "frames", "model", "auth", "redirects", "fields"]) {
    assert.ok(schema.properties[name], `fetch_content exposes ${name}`);
  }
  assert.equal(schema.additionalProperties, false, "the widened schema is still closed");

  // Upstream's own MCP definition must stay narrow: the widening is the adapter's.
  const upstream = require(path.join(ROOT, "build", "agent.cjs")).MCP_TOOL_DEFINITIONS
    .find((tool) => tool.name === "fetch_content");
  assert.deepEqual(upstream.inputSchema.properties.mode.enum, ["readable", "raw"], "upstream stays untouched");
  assert.equal(upstream.inputSchema.properties.auth, undefined);
});

test("onLoad registers the commands and one shortcut, and unload releases them", async (t) => {
  const { host, plugin } = withPlugin(t);
  await plugin.onLoad();

  assert.deepEqual([...host.calls.commandsRegistered].sort(), [...COMMANDS].sort(), "three commands");
  const binding = host.shortcuts.get("pi.web-access.open");
  assert.ok(binding, "the shortcut is registered");
  assert.equal(binding.command, "pi.web-access.open", "the shortcut runs this plugin's own command");
  assert.equal(binding.registered, true);

  await plugin.onUnload();
  assert.deepEqual([...host.calls.commandsUnregistered].sort(), [...COMMANDS].sort(), "every command is removed");
  assert.equal(host.shortcuts.size, 0, "the shortcut is released");
  delete globalThis.pi;
});

test("a command opens the panel on its own section, once", async (t) => {
  const { host, plugin } = withPlugin(t);
  await plugin.onLoad();

  await host.commands.get("pi.web-access.results").run();
  assert.equal(host.panels.length, 1, "the panel was opened");
  assert.equal(host.panels[0].title, "Web Access");

  const first = await plugin.onPanelInvoke("status", {});
  assert.equal(first.focus, "results", "the panel is told which section to show");
  const second = await plugin.onPanelInvoke("status", {});
  assert.equal(second.focus, "results", "the focus target survives later status reads");
});

test("the results channels list, preview and drop a persisted result", async (t) => {
  const { host, plugin } = withPlugin(t);
  await plugin.onLoad();

  const bundle = require(path.join(ROOT, "build", "agent.cjs"));
  bundle.persistResult("abc123", {
    id: "abc123",
    type: "fetch",
    timestamp: Date.now(),
    urls: [{ url: "https://example.com", title: "Example", content: "hello", error: null }],
  });

  const list = await plugin.onPanelInvoke("results:list", {});
  assert.equal(list.ok, true);
  assert.equal(list.results.length, 1);
  assert.equal(list.results[0].id, "abc123");
  assert.equal(list.results[0].urlCount, 1);

  const peek = await plugin.onPanelInvoke("results:peek", { id: "abc123" });
  assert.equal(peek.ok, true);
  assert.equal(peek.result.urls[0].url, "https://example.com");

  const drop = await plugin.onPanelInvoke("results:drop", { id: "abc123" });
  assert.equal(drop.dropped, true);
  assert.deepEqual(drop.results, []);
});

test("a responseId from a previous instance still answers get_search_content", async () => {
  const host = createMockHost({ settings: {} });

  const first = loadPlugin(host);
  await first.onLoad();
  require(path.join(ROOT, "build", "agent.cjs")).persistResult("keepme", {
    id: "keepme",
    type: "fetch",
    timestamp: Date.now(),
    urls: [{ url: "https://example.com", title: "Kept", content: "the body survived", error: null }],
  });
  await first.onUnload();

  // A second instance has its own module-level store: only the disk copy can answer.
  const second = loadPlugin(host);
  await second.onLoad();
  const tool = host.registered.get("get_search_content");
  const result = await tool.execute({ responseId: "keepme", limit: 200 }, {});
  assert.match(result.content[0].text, /the body survived/, "the page was hydrated from disk");
  await second.onUnload();
  delete globalThis.pi;
});

test("open:external refuses a non-http link", async (t) => {
  const { host, plugin } = withPlugin(t);
  await plugin.onLoad();

  const refused = await plugin.onPanelInvoke("open:external", { url: "file:///etc/passwd" });
  assert.equal(refused.ok, false);
  assert.equal(host.calls.openedExternal.length, 0, "nothing was opened");

  const allowed = await plugin.onPanelInvoke("open:external", { url: "https://example.com" });
  assert.equal(allowed.ok, true);
  assert.deepEqual(host.calls.openedExternal, ["https://example.com"]);
});

test("web_search exposes the model override and the manifest mirrors it", async (t) => {
  const { host, plugin } = withPlugin(t);
  await plugin.onLoad();

  const schema = host.registered.get("web_search").schema;
  assert.ok(schema.properties.model, "the search model override is exposed");
  assert.equal(schema.additionalProperties, false, "the widened schema is still closed");

  const declared = MANIFEST.contributes.agentTools.find((tool) => tool.name === "web_search");
  assert.deepEqual(declared.schema, JSON.parse(JSON.stringify(schema)), "manifest mirrors the runtime schema");
});

test("the manifest declares every contribution and permission the runtime uses", () => {
  assert.deepEqual(MANIFEST.contributes.commands.map((command) => command.id).sort(), [...COMMANDS].sort());
  assert.deepEqual(MANIFEST.contributes.skills, ["skills/web-search.md"]);
  const permissions = new Set(MANIFEST.permissions);
  for (const permission of ["ui.view", "agent.tool.register", "net.anyHost", "agent.prompt.inject", "agent.complete", "keyboard.globalShortcut", "shell.openExternal"]) {
    assert.ok(permissions.has(permission), `declares ${permission}`);
  }
  for (const command of MANIFEST.contributes.commands) {
    assert.ok(MANIFEST.activationEvents.includes(`onCommand:${command.id}`), `activates on ${command.id}`);
  }

  const autoSummary = MANIFEST.contributes.settings.find((setting) => setting.key === "autoSummary");
  assert.ok(autoSummary, "auto-summary is a declared setting");
  assert.equal(autoSummary.default, false, "and it is off until the user asks for it");
});
