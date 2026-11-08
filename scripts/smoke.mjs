#!/usr/bin/env node
// Acceptance criterion 4: a real network round trip with no API key anywhere.
//
// Runs the plugin through its real entry point (`main.js` + a mock host), then
// calls the registered tools the way the desktop agent would:
//   (a) web_search on a keyless provider returns at least one https result,
//   (b) fetch_content returns >= 500 characters of readable body text,
//   (c) get_search_content returns the stored result by responseId.
//
// No credential is read, written or required. If the network blocks the keyless
// providers, the script fails loudly instead of faking a result.
import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

process.env.PI_WEB_ACCESS_LEGACY_CONFIG = "";

const { createMockHost } = require(join(root, "test", "mock-host.js"));
const dataDir = mkdtempSync(join(tmpdir(), "pi-web-access-smoke-"));
const host = createMockHost({ dataDir, settings: {} });
globalThis.pi = host.pi;

const plugin = require(join(root, "main.js"));
await plugin.onLoad();

const tool = (name) => {
  const definition = host.registered.get(name);
  if (!definition) throw new Error(`tool ${name} was not registered`);
  return definition;
};

const textOf = (result) => (result?.content ?? []).map((item) => item.text ?? "").join("\n");
const urlsIn = (text) => [...new Set(text.match(/https:\/\/[^\s)"'\\]+/g) ?? [])];
const responseIdOf = (result) =>
  result?.structuredContent?.responseId ?? result?.details?.responseId ?? null;

const story = [];
let failed = false;
const check = (label, ok, detail) => {
  story.push(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed = true;
};

// (a) web_search, keyless provider. degoog answers without a key and without a
// proxy; duckduckgo is the proxy-backed fallback on networks that block degoog.
const query = "pi coding agent web access extension";
let search = null;
let providerUsed = null;
for (const attempt of [
  { provider: "degoog", proxy: undefined },
  { provider: "duckduckgo", proxy: process.env.PI_WEB_ACCESS_SMOKE_PROXY || undefined },
]) {
  const result = await tool("web_search").execute({ query, provider: attempt.provider, numResults: 5, proxy: attempt.proxy });
  if (result?.isError !== true) {
    search = result;
    providerUsed = attempt.provider + (attempt.proxy ? ` via ${attempt.proxy}` : " direct");
    break;
  }
  search = result;
}
const searchText = textOf(search);
const results = urlsIn(searchText);
const responseId = responseIdOf(search);
check(
  "web_search returns at least one https result without an API key",
  search?.isError !== true && results.length >= 1,
  `${providerUsed ?? "no provider answered"}; ${results.length} url(s); responseId=${responseId ?? "none"}`,
);

// (b) fetch_content on a content-rich page.
const pageUrl = "https://github.com/nicobailon/pi-web-access";
const fetched = await tool("fetch_content").execute({ url: pageUrl });
const body = textOf(fetched);
check(
  "fetch_content returns >= 500 characters of readable text",
  fetched?.isError !== true && body.length >= 500,
  `${pageUrl} → ${body.length} chars`,
);

// (c) retrieve the stored search result by id.
if (responseId) {
  const stored = await tool("get_search_content").execute({ responseId, queryIndex: 0, offset: 0, limit: 4000 });
  const storedText = textOf(stored);
  check(
    "get_search_content returns the stored result by responseId",
    stored?.isError !== true && storedText.length > 0,
    `${responseId} → ${storedText.length} chars`,
  );
} else {
  check("get_search_content returns the stored result by responseId", false, "web_search produced no responseId");
}

await plugin.onUnload();
delete globalThis.pi;

console.log(story.join("\n"));
console.log(`data directory: ${dataDir}`);
if (failed) {
  console.error("smoke FAILED");
  process.exit(1);
}
console.log("smoke OK");
