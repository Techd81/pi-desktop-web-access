"use strict";

// Regression cover for the defects a review pass found in the adapter:
//   - an invalid `fetch` block used to be written to disk and then break every
//     later load (zero tools, panel claiming everything was fine),
//   - a second onLoad left the previous generation's tools registered,
//   - a cancelled tool call rejected instead of returning an isError result.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createMockHost } = require("./mock-host.js");

process.env.PI_WEB_ACCESS_LEGACY_CONFIG = "";

const ROOT = path.join(__dirname, "..");
const BUNDLE = require(path.join(ROOT, "build", "agent.cjs"));

function loadPlugin(host) {
  globalThis.pi = host.pi;
  delete require.cache[require.resolve(path.join(ROOT, "main.js"))];
  delete require.cache[require.resolve(path.join(ROOT, "build", "agent.cjs"))];
  return require(path.join(ROOT, "main.js"));
}

/* ------------------------------------------------------- config validation */

test("validateFetchSettings accepts a sane fetch block", () => {
  assert.deepEqual(BUNDLE.validateFetchSettings({}), []);
  assert.deepEqual(BUNDLE.validateFetchSettings({ fetch: { defaultMode: "raw", allowedModes: ["raw", "readable"] } }), []);
  assert.deepEqual(BUNDLE.validateFetchSettings({ fetch: { allowedModes: ["readable", "answer", "extract"] } }), []);
});

test("validateFetchSettings rejects every combination upstream throws on", () => {
  const invalidMode = BUNDLE.validateFetchSettings({ fetch: { allowedModes: ["readable", "bogus"] } });
  assert.equal(invalidMode.length, 1);
  assert.match(invalidMode[0], /invalid mode: bogus/);

  const duplicates = BUNDLE.validateFetchSettings({ fetch: { allowedModes: ["raw", "raw"] } });
  // The same config also has no legal defaultMode, so more than one problem is
  // reported; what matters is that the duplicate is named.
  assert.match(duplicates.join(" "), /duplicates: raw/);

  const empty = BUNDLE.validateFetchSettings({ fetch: { allowedModes: [] } });
  assert.equal(empty.length, 1);
  assert.match(empty[0], /non-empty array/);

  const notAllowed = BUNDLE.validateFetchSettings({ fetch: { defaultMode: "readable", allowedModes: ["raw"] } });
  assert.equal(notAllowed.length, 1);
  assert.match(notAllowed[0], /must be one of fetch\.allowedModes/);

  const extractDefault = BUNDLE.validateFetchSettings({ fetch: { defaultMode: "extract" } });
  assert.equal(extractDefault.length, 1);
  assert.match(extractDefault[0], /cannot be "extract"/);
});

test("an invalid fetch block is rejected before it can reach disk", async () => {
  const host = createMockHost({ settings: { fetchAllowedModes: "readable,bogus" } });
  const plugin = loadPlugin(host);
  try {
    await assert.rejects(() => plugin.onLoad(), /invalid configuration/i);
    assert.equal(host.registered.size, 0, "no tool is registered from a rejected config");
    assert.equal(
      fs.existsSync(path.join(host.dataDir, "web-search.json")),
      false,
      "the broken config never reaches the file upstream reads",
    );
  } finally {
    await plugin.onUnload();
    delete globalThis.pi;
  }
});

test("a rejected save leaves the previous config and the running core alone", async (t) => {
  const host = createMockHost({ settings: {} });
  const plugin = loadPlugin(host);
  t.after(async () => {
    await plugin.onUnload();
    delete globalThis.pi;
  });
  await plugin.onLoad();
  const configPath = path.join(host.dataDir, "web-search.json");
  const before = fs.readFileSync(configPath, "utf8");

  host.settingsStore.fetchAllowedModes = ["readable", "bogus"];
  const status = await plugin.onPanelInvoke("settings:save", { fetchAllowedModes: ["readable", "bogus"] });

  assert.equal(fs.readFileSync(configPath, "utf8"), before, "the config file is untouched");
  assert.ok(Array.isArray(status.errors) && status.errors.length > 0, "the panel can show why the save did not apply");
  assert.match(status.errors.join(" "), /invalid mode/);
  assert.equal(host.registered.size, 4, "the running core keeps its tools");
});

/* ------------------------------------------------------------ load hygiene */

test("a second onLoad unregisters the previous generation first", async (t) => {
  const host = createMockHost({ settings: {} });
  const plugin = loadPlugin(host);
  t.after(async () => {
    delete globalThis.pi;
  });

  await plugin.onLoad();
  assert.equal(host.registered.size, 4);

  host.settingsStore.enableSourceCheck = false;
  await plugin.onLoad();

  assert.deepEqual([...host.registered.keys()].sort(), ["fetch_content", "get_search_content", "web_search"]);
  assert.equal(host.calls.unregistered.length, 4, "the first generation was unregistered, not leaked");

  await plugin.onUnload();
  assert.equal(host.registered.size, 0);
});

/* ------------------------------------------------------------- cancellation */

test("a cancelled call returns an isError result instead of throwing", async (t) => {
  const host = createMockHost({ settings: {} });
  const plugin = loadPlugin(host);
  t.after(async () => {
    await plugin.onUnload();
    delete globalThis.pi;
  });
  await plugin.onLoad();

  const tool = host.registered.get("web_search");
  const result = await tool.execute({ query: "anything" }, { signal: AbortSignal.abort() });

  assert.equal(result.isError, true, "a cancelled call is a tool failure, not a rejected promise");
  assert.ok(String(result.details.error ?? "").length > 0, "the reason is preserved for the model");
  assert.match(result.content[0].text, /^Error: /);
});

/* ------------------------------------------------------ store path safety */

// A review pass proved the store would happily read and delete any `*.json`
// file: ids arrive from the panel's `results:*` channels and from the model's
// `responseId`, and `path.join(dir, `${id}.json`)` resolves `..`.
test("a result id cannot escape the results directory", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piwa-store-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  BUNDLE.configureResultStore(dir);

  const outside = path.join(dir, "outside.json");
  fs.writeFileSync(outside, JSON.stringify({ id: "outside", timestamp: Date.now(), type: "search", secret: "LEAKED" }));

  for (const id of ["../../outside", "..\\..\\outside", "../outside", "/etc/passwd", "a".repeat(200)]) {
    assert.equal(BUNDLE.readStoredResult(id), null, `read "…${id.slice(-12)}" is refused`);
    assert.equal(BUNDLE.hydrateResult(id), false, `hydrate "…${id.slice(-12)}" is refused`);
    assert.equal(BUNDLE.dropStoredResult(id), false, `drop "…${id.slice(-12)}" is refused`);
  }
  assert.equal(fs.existsSync(outside), true, "the file outside the results directory survived");

  // A legal id still round-trips.
  BUNDLE.persistResult("legit1", {
    id: "legit1",
    timestamp: Date.now(),
    type: "search",
    queries: [{ query: "q" }],
    urls: [],
  });
  assert.ok(BUNDLE.readStoredResult("legit1"), "a legal id still reads back");
});

test("the panel refuses a traversal id before it reaches the store", async (t) => {
  const host = createMockHost({ settings: {} });
  const plugin = loadPlugin(host);
  t.after(async () => {
    await plugin.onUnload();
    delete globalThis.pi;
  });
  await plugin.onLoad();

  const secretsPath = path.join(host.dataDir, "secrets.json");
  fs.writeFileSync(secretsPath, '{"keep":true}\n');

  for (const id of ["../secrets", "..\\..\\secrets", "", "../../x"]) {
    const drop = await plugin.onPanelInvoke("results:drop", { id });
    assert.equal(drop.ok, false, `"${id}" is refused`);
    assert.equal(drop.code, "INVALID_ARGUMENT");
    const peek = await plugin.onPanelInvoke("results:peek", { id });
    assert.equal(peek.code, "INVALID_ARGUMENT");
  }
  assert.equal(fs.readFileSync(secretsPath, "utf8"), '{"keep":true}\n', "secrets.json is untouched");
});

/* ---------------------------------------------------------- config guards */

// Upstream resolves a missing `defaultMode` to "readable" and then requires it
// to be in `allowedModes`. A validator that only checks a *present* defaultMode
// let `{ allowedModes: ["raw"] }` reach disk, and every later load threw.
test("validateFetchSettings rejects an allowedModes set that excludes the default", () => {
  const problems = BUNDLE.validateFetchSettings({ fetch: { allowedModes: ["raw"] } });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /defaultMode "readable" must be one of fetch\.allowedModes/);

  assert.deepEqual(BUNDLE.validateFetchSettings({ fetch: { allowedModes: ["raw", "readable"] } }), []);
  assert.deepEqual(BUNDLE.validateFetchSettings({ fetch: { allowedModes: ["readable"] } }), []);
  assert.deepEqual(BUNDLE.validateFetchSettings({}), []);
});

test("a rejected defaultMode never reaches the host settings", async (t) => {
  const host = createMockHost({ settings: {} });
  const plugin = loadPlugin(host);
  t.after(async () => {
    await plugin.onUnload();
    delete globalThis.pi;
  });
  await plugin.onLoad();

  const status = await plugin.onPanelInvoke("settings:save", { fetchAllowedModes: "raw" });
  assert.equal(status.ok, false, "the save is refused");
  assert.match(status.errors.join(" "), /defaultMode/);
  assert.notEqual(host.settingsStore.fetchAllowedModes, "raw", "the host never stored the bad value");
  assert.equal(host.registered.size, 4, "the running core keeps its tools");
});

/* ------------------------------------------------------------- store ttl */

// Upstream's `readCachedFetchData` replaces the body of a `fetch` result older
// than an hour with an "expired" placeholder, so a hydrating store has to stamp
// the in-memory copy with the current time.
test("a fetch result stored more than an hour ago still hydrates with its body", async (t) => {
  const host = createMockHost({ settings: {} });
  const first = loadPlugin(host);
  await first.onLoad();
  const bundle = require(path.join(ROOT, "build", "agent.cjs"));
  bundle.persistResult("oldfetch", {
    id: "oldfetch",
    type: "fetch",
    timestamp: Date.now() - 2 * 60 * 60 * 1000,
    urls: [{ url: "https://example.com", title: "Old", content: "old but intact", error: null }],
  });
  await first.onUnload();

  const second = loadPlugin(host);
  await second.onLoad();
  const tool = host.registered.get("get_search_content");
  const result = await tool.execute({ responseId: "oldfetch", limit: 200 }, {});
  assert.match(result.content[0].text, /old but intact/, "the body survived the one-hour window");
  await second.onUnload();
  delete globalThis.pi;
});
