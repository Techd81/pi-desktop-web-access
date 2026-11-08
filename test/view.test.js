"use strict";

// Acceptance criterion 7: the panel renders the provider availability list, the
// settings form, a credential input per provider and a save entry point, and the
// pure view-model functions decide what gets sent back. The DOM half runs against
// test/harness.html's bridge contract using linkedom, so no browser is needed.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { parseHTML } = require("linkedom");

const ROOT = path.join(__dirname, "..");
const model = require(path.join(ROOT, "views", "lib", "model.js"));

const PROVIDERS = ["brave", "degoog", "duckduckgo", "exa", "kagi", "serper", "tavily"];

function makeStatus(overrides = {}) {
  return {
    ok: true,
    configPath: "C:/data/web-search.json",
    dataDir: "C:/data",
    legacyPath: null,
    applied: { legacy: true, settings: ["searchProvider", "fetchDefaultMode"], secrets: ["tavilyApiKey"] },
    registeredTools: ["web_search", "fetch_content", "get_search_content", "source_check"],
    // source_check is disabled in the stored settings but was registered before
    // the change: the panel must show both facts without contradicting itself.
    enabledTools: ["web_search", "fetch_content", "get_search_content"],
    fetchModes: { defaultMode: "readable", allowedModes: ["readable", "raw"] },
    maxInlineContentChars: 20000,
    resolvedProviders: PROVIDERS,
    credentialPresence: { braveApiKey: false, tavilyApiKey: true, degoogApiKey: false },
    credentialProviders: { brave: "braveApiKey", tavily: "tavilyApiKey", degoog: "degoogApiKey" },
    settings: { searchProvider: "brave", fetchDefaultMode: "raw", enableSourceCheck: false },
    commands: ["pi.web-access.open", "pi.web-access.results", "pi.web-access.settings"],
    shortcut: {
      id: "pi.web-access.open",
      accelerator: "CommandOrControl+Shift+Y",
      command: "pi.web-access.open",
      registered: true,
    },
    results: [
      { id: "r1aaaa", type: "fetch", label: "Example page", timestamp: 1_700_000_000_000, urlCount: 1, queryCount: 0, size: 4096 },
      { id: "r2bbbb", type: "search", label: "node release schedule", timestamp: 1_700_000_500_000, urlCount: 0, queryCount: 2, size: 800 },
    ],
    activity: [{ at: 1_700_000_900_000, kind: "tool", label: "web_search", detail: "" }],
    features: { answer: true, images: true, extract: true, video: true, openExternal: true },
    focus: null,
    ...overrides,
  };
}

/* ------------------------------------------------------------ pure model */

test("availability rows put available providers first and drop the aggregate", () => {
  const rows = model.resolveAvailabilityRows(
    { all: true, brave: false, degoog: true, exa: true, kagi: false },
    ["brave", "degoog", "exa", "kagi"],
  );
  assert.deepEqual(rows.map((row) => row.provider), ["degoog", "exa", "brave", "kagi"]);
  assert.deepEqual(rows.map((row) => row.available), [true, true, false, false]);
  assert.ok(!rows.some((row) => row.provider === "all"));
});

test("a settings draft falls back to upstream values when nothing is stored", () => {
  const draft = model.buildSettingsDraft({});
  assert.equal(draft.searchProvider, "auto");
  assert.equal(draft.fetchDefaultMode, "readable");
  assert.deepEqual(draft.fetchAllowedModes, ["readable", "raw", "answer"]);
  assert.equal(draft.enableWebSearch, true);
});

test("the settings patch drops blanks and keeps boolean false", () => {
  const patch = model.buildSettingsPatch({
    searchProvider: "  ",
    fetchDefaultMode: "raw",
    fetchAllowedModes: ["raw", "nonsense"],
    maxInlineContentChars: "0",
    proxy: "",
    enableWebSearch: false,
    enableSourceCheck: true,
  });
  assert.deepEqual(patch, {
    fetchDefaultMode: "raw",
    fetchAllowedModes: "raw",
    enableWebSearch: false,
    enableSourceCheck: true,
  });
});

test("credential rows expose presence, never a value", () => {
  const rows = model.credentialRows(makeStatus());
  assert.deepEqual(rows.map((row) => row.field), ["braveApiKey", "degoogApiKey", "tavilyApiKey"]);
  assert.equal(rows.find((row) => row.field === "tavilyApiKey").configured, true);
  assert.equal(rows.find((row) => row.field === "braveApiKey").configured, false);
  assert.ok(!JSON.stringify(rows).includes("sk-"));
});

test("save failure keeps the error and clears the saving flag", () => {
  const failed = model.applySaveFailure({ saving: true, saved: false }, "boom");
  assert.deepEqual(failed, { saving: false, saved: false, error: "boom" });
  const recovered = model.applySaveSuccess(failed);
  assert.equal(recovered.error, "");
  assert.equal(recovered.saved, true);
});

test("the source summary names all three sources", () => {
  const text = model.formatSourceSummary({ legacy: true, settings: ["a", "b"], secrets: ["k"] });
  assert.match(text, /settings 2/);
  assert.match(text, /credentials 1/);
  assert.match(text, /legacy file merged/);
});

test("result rows sort newest first and preformat their columns", () => {
  const rows = model.resultRows(makeStatus());
  assert.deepEqual(rows.map((row) => row.id), ["r2bbbb", "r1aaaa"]);
  assert.equal(rows[1].size, "4.0 KiB");
  assert.match(rows[1].when, /\d/);

  // A summary without a label or a size must still render instead of going blank.
  const sparse = model.resultRows({ results: [{ id: "x", type: "fetch", timestamp: 1 }] });
  assert.equal(sparse[0].label, "x");
  assert.equal(sparse[0].size, "—");
  assert.deepEqual(model.resultRows({}), []);
});

test("activity and capability rows survive a partial status", () => {
  assert.deepEqual(model.activityRows({}), []);
  const rows = model.featureRows({ features: { answer: true } });
  assert.equal(rows.length, 5, "a missing capability is listed, not hidden");
  assert.equal(rows.find((row) => row.key === "answer").available, true);
  assert.equal(rows.find((row) => row.key === "images").available, false);
});

test("previewText reads a fetched page, a search answer, or nothing", () => {
  const page = model.previewText({ urls: [{ title: "T", url: "https://e.com", content: "body text" }] });
  assert.match(page, /T/);
  assert.match(page, /https:\/\/e\.com/);
  assert.match(page, /body text/);

  const search = model.previewText({ queries: [{ query: "q", answer: "a" }] });
  assert.match(search, /# q/);
  assert.match(search, /a/);

  assert.equal(model.previewText({}), "");
  const capped = model.previewText({ urls: [{ content: "x".repeat(5000) }] }, 100);
  assert.ok(capped.length <= 140, `preview capped at the limit, got ${capped.length}`);
});

/* ------------------------------------------------------------------- dom */

async function renderPanel(statusOverrides = {}, options = {}) {
  const html = fs
    .readFileSync(path.join(ROOT, "test", "harness.html"), "utf8")
    .replace(/<script[\s\S]*?<\/script>/g, "");
  const { window, document } = parseHTML(html);

  // linkedom may hand back a shared window, so clear any state a previous mount
  // left behind; otherwise app.js skips init because its guard looks defined.
  delete window.__webAccessReady;
  delete window.__webAccessActions;

  const calls = [];
  const status = makeStatus(statusOverrides);
  window.pluginBridge = {
    async invoke(channel, payload) {
      calls.push({ channel, payload });
      if (channel === "availability") {
        return {
          ok: true,
          availability: { all: true, degoog: true, exa: true, brave: false, kagi: false, tavily: false },
        };
      }
      if (options.failOn && options.failOn === channel) return { ok: false, message: "host refused" };
      return status;
    },
  };

  const source = ["views/lib/model.js", "views/app.js"]
    .map((file) => fs.readFileSync(path.join(ROOT, ...file.split("/")), "utf8"))
    .join("\n");
  // eslint-disable-next-line no-new-func
  const run = new Function("window", "document", source);
  run(window, document);
  await window.__webAccessReady;

  return { window, document, calls, status };
}

test("the panel renders status, tools, providers, settings, credentials and save", async () => {
  const { document, window } = await renderPanel();

  assert.ok(document.getElementById("status"), "status card exists");
  assert.match(document.body.textContent, /web-search\.json/, "the config path is shown");

  const chips = [...document.querySelectorAll(".chip[data-tool]")];
  assert.equal(chips.length, 4, "one chip per tool");
  const sourceChip = chips.find((chip) => chip.getAttribute("data-tool") === "source_check");
  assert.equal(sourceChip.getAttribute("data-enabled"), "false", "a disabled tool is reported as such");

  const features = [...document.querySelectorAll(".chip[data-feature]")];
  assert.equal(features.length, 5, "one chip per capability");
  assert.ok(
    features.every((chip) => chip.getAttribute("data-available") === "true"),
    "a capable host reports every capability",
  );

  const results = [...document.querySelectorAll(".result")];
  assert.equal(results.length, 2, "one row per stored result");
  assert.equal(results[0].getAttribute("data-id"), "r2bbbb", "the newest result comes first");
  assert.ok(document.getElementById("result-preview"), "the preview pane exists");
  assert.ok(document.getElementById("results-clear"), "clearing stored results is offered");

  const activity = [...document.querySelectorAll(".activity")];
  assert.equal(activity.length, 1, "the activity card lists the recorded call");

  const providers = [...document.querySelectorAll(".provider")];
  assert.equal(providers.length, PROVIDERS.length, "one row per provider");
  const degoog = providers.find((cell) => cell.getAttribute("data-provider") === "degoog");
  assert.equal(degoog.getAttribute("data-available"), "true", "available providers are marked");
  const brave = providers.find((cell) => cell.getAttribute("data-provider") === "brave");
  assert.equal(brave.getAttribute("data-available"), "false");

  const providerInput = document.getElementById("setting-searchProvider");
  assert.ok(providerInput, "search provider input exists");
  assert.equal(providerInput.value, "brave", "current setting is prefilled");
  assert.equal(document.getElementById("setting-fetchDefaultMode").value, "raw");

  const password = document.getElementById("credential-braveApiKey");
  assert.ok(password, "a credential input exists for each provider");
  assert.equal(password.type, "password", "credentials are typed as passwords");
  assert.ok(document.getElementById("credential-tavilyApiKey"));
  assert.match(document.body.textContent, /已配置/, "presence is shown for a stored credential");

  assert.ok(document.getElementById("save-settings"), "save entry point exists");
  assert.ok(document.getElementById("refresh-providers"), "refresh entry point exists");
  assert.ok(document.getElementById("advanced-save"), "advanced JSON entry point exists");

  assert.equal(window.__webAccessActions.getState().error, "");
});

test("saving settings sends the patch to the plugin channel", async () => {
  const { window, calls } = await renderPanel();
  const state = window.__webAccessActions.getState();
  state.draft.searchProvider = "exa";
  state.draft.enableSourceCheck = true;

  await window.__webAccessActions.saveSettings({ silent: false });

  const save = calls.find((entry) => entry.channel === "settings:save");
  assert.ok(save, "settings:save was called");
  assert.equal(save.payload.searchProvider, "exa");
  assert.equal(save.payload.enableSourceCheck, true);
  assert.equal(window.__webAccessActions.getState().error, "");
});

test("a refused save surfaces the host message instead of pretending success", async () => {
  const { window, document } = await renderPanel({}, { failOn: "settings:save" });

  await window.__webAccessActions.saveSettings({ silent: false });

  assert.equal(window.__webAccessActions.getState().error, "host refused");
  const banner = document.getElementById("error");
  assert.ok(banner, "error banner exists");
  assert.equal(banner.hasAttribute("hidden"), false, "the banner is visible after a failure");
  assert.match(banner.textContent, /host refused/);
});

test("saving a credential goes through the secret channel and never echoes the value", async () => {
  const { window, calls } = await renderPanel();

  await window.__webAccessActions.saveCredential("braveApiKey", "sk-test-value");

  const save = calls.find((entry) => entry.channel === "secret:set");
  assert.ok(save);
  assert.deepEqual(save.payload, { field: "braveApiKey", value: "sk-test-value" });
  assert.ok(!JSON.stringify(window.__webAccessActions.getState().status).includes("sk-test-value"));
});

test("remote content is rendered as text, never as markup", async () => {
  const payload = '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>';
  const { document, window } = await renderPanel({
    results: [{ id: "rx1", type: "fetch", label: payload, timestamp: 1, urlCount: 1, queryCount: 0, size: 8 }],
    activity: [{ at: 1, kind: payload, label: payload, detail: payload }],
    errors: [payload],
  });

  // Each of these strings comes from an arbitrary web page, a stored result or
  // the plugin's own error text. The panel builds nodes by hand, so the only
  // thing keeping that safe is never reaching an HTML sink — assert it directly
  // so a future switch to innerHTML fails here instead of in production.
  assert.equal(document.querySelector("img"), null, "no image element was created");
  assert.equal(document.querySelector("script"), null, "no script element was created");
  assert.equal(window.__xss, undefined, "nothing in the payload executed");
  assert.match(document.body.textContent, /<img src=x onerror=/, "the payload is visible as literal text");
});
