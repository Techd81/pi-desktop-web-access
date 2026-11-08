/**
 * Config materialisation for the PI-Desktop host.
 *
 * Upstream reads exactly one JSON file whose path it computes at module load
 * (`getWebSearchConfigPath()`). A desktop plugin has no such file, so this
 * module keeps the merge rules here and lets `main.js` write the result into the
 * plugin data directory before the upstream bundle is required.
 *
 * Precedence, highest first:
 *   1. plugin secrets blob  (provider credentials, arbitrary upstream keys)
 *   2. plugin settings form (toggles, modes, provider, proxy)
 *   3. legacy `~/.pi/web-search.json`
 *   4. upstream built-in defaults (nothing written)
 *
 * Nothing in this module touches upstream module scope: it only produces plain
 * JSON that upstream already knows how to read.
 */

/** Upstream config keys that hold credentials, redacted before anything is logged. */
const SECRET_KEY_PATTERN = /(apikey|token|secret|password|headers?|zone|accountid|gatewayid)$/i;

/** Which upstream config path each `contributes.settings` key writes to. */
export const SETTING_PATHS: Readonly<Record<string, readonly string[]>> = {
  searchProvider: ["searchProvider"],
  proxy: ["proxy"],
  maxInlineContentChars: ["maxInlineContentChars"],
  fetchDefaultMode: ["fetch", "defaultMode"],
  fetchAllowedModes: ["fetch", "allowedModes"],
  enableWebSearch: ["tools", "webSearch", "enabled"],
  enableSourceCheck: ["tools", "sourceCheck", "enabled"],
  enableFetchContent: ["tools", "fetchContent", "enabled"],
  enableGetSearchContent: ["tools", "getSearchContent", "enabled"],
};

/** Credential fields the panel can write directly, keyed by the provider they unlock.
 * Every name below is one upstream reads from its own config (`<name>ApiKey`). */
export const PROVIDER_CREDENTIALS: Readonly<Record<string, string>> = {
  brave: "braveApiKey",
  tavily: "tavilyApiKey",
  exa: "exaApiKey",
  perplexity: "perplexityApiKey",
  serper: "serperApiKey",
  jina: "jinaApiKey",
  kagi: "kagiApiKey",
  you: "youApiKey",
  parallel: "parallelApiKey",
  bocha: "bochaApiKey",
  serpapi: "serpapiApiKey",
  searchapi: "searchapiApiKey",
  tabstack: "tabstackApiKey",
  valyu: "valyuApiKey",
  brightdata: "brightdataApiKey",
  xai: "xaiApiKey",
  deepseek: "deepseekApiKey",
  mistral: "mistralApiKey",
  ollama: "ollamaApiKey",
  tinyfish: "tinyfishApiKey",
  serpdive: "serpdiveApiKey",
  querit: "queritApiKey",
  searchinfinity: "searchinfinityApiKey",
  serpbase: "serpbaseApiKey",
  ceramic: "ceramicApiKey",
  cloro: "cloroApiKey",
  outcrawl: "outcrawlApiKey",
  sofya: "sofyaApiKey",
  anysearch: "anysearchApiKey",
  xcrawl: "xcrawlApiKey",
  zai: "zaiApiKey",
  keenable: "keenableApiKey",
  linkup: "linkupApiKey",
  ninerouter: "ninerouterApiKey",
  degoog: "degoogApiKey",
  openai: "openaiApiKey",
};

/** @param {unknown} value */
export function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function cloneJson(value) {
  if (Array.isArray(value)) return /** @type {T} */ (value.map((item) => cloneJson(item)));
  if (isPlainObject(value)) {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [key, item] of Object.entries(/** @type {Record<string, unknown>} */ (value))) {
      out[key] = cloneJson(item);
    }
    return /** @type {T} */ (out);
  }
  return value;
}

/**
 * Recursive merge that keeps arrays as values (no element-wise merging).
 * @param {Record<string, unknown>} target
 * @param {Record<string, unknown>} source
 * @returns {Record<string, unknown>}
 */
function mergeInto(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (isPlainObject(value) && isPlainObject(target[key])) {
      mergeInto(/** @type {Record<string, unknown>} */ (target[key]), value);
      continue;
    }
    target[key] = cloneJson(value);
  }
  return target;
}

/** @param {Record<string, unknown>} root @param {readonly string[]} path */
function setPath(root, path, value) {
  let cursor = root;
  for (const segment of path.slice(0, -1)) {
    if (!isPlainObject(cursor[segment])) cursor[segment] = {};
    cursor = /** @type {Record<string, unknown>} */ (cursor[segment]);
  }
  cursor[path[path.length - 1]] = value;
}

/** @param {Record<string, unknown>} root @param {readonly string[]} path */
function getPath(root, path) {
  let cursor = root;
  for (const segment of path) {
    if (!isPlainObject(cursor)) return undefined;
    cursor = /** @type {Record<string, unknown>} */ (cursor)[segment];
  }
  return cursor;
}

/**
 * Form values arrive as strings from the panel and as native types from the
 * host's generated controls. Blank strings and `null` mean "not set".
 * @param {unknown} value
 * @param {readonly string[]} path
 */
function normalizeSettingValue(value, path) {
  const isModeList = path[0] === "fetch" && path[1] === "allowedModes";
  if (isModeList) {
    const list = Array.isArray(value) ? value : String(value == null ? "" : value).split(",");
    const modes = list.map((item) => String(item).trim()).filter(Boolean);
    return modes.length > 0 ? modes : undefined;
  }
  if (typeof value === "string") {
    if (value.trim() === "") return undefined;
    if (path[path.length - 1] === "maxInlineContentChars") {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    return value;
  }
  return value == null ? undefined : value;
}

/**
 * @typedef {object} ConfigSources
 * @property {Record<string, unknown> | null | undefined} [legacy]
 * @property {Record<string, unknown> | null | undefined} [settings]
 * @property {Record<string, unknown> | null | undefined} [secrets]
 */

/**
 * @typedef {object} MergedConfig
 * @property {Record<string, unknown>} config
 * @property {{ legacy: boolean, settings: string[], secrets: string[] }} applied
 */

/**
 * @param {ConfigSources} sources
 * @returns {MergedConfig}
 */
export function mergeConfigSources(sources) {
  /** @type {Record<string, unknown>} */
  const config = {};
  const applied = { legacy: false, settings: /** @type {string[]} */ ([]), secrets: /** @type {string[]} */ ([]) };

  if (isPlainObject(sources.legacy)) {
    mergeInto(config, /** @type {Record<string, unknown>} */ (sources.legacy));
    applied.legacy = Object.keys(/** @type {Record<string, unknown>} */ (sources.legacy)).length > 0;
  }

  if (isPlainObject(sources.settings)) {
    for (const [key, raw] of Object.entries(/** @type {Record<string, unknown>} */ (sources.settings))) {
      const path = SETTING_PATHS[key];
      if (!path) continue;
      const value = normalizeSettingValue(raw, path);
      if (value === undefined) continue;
      setPath(config, path, value);
      applied.settings.push(key);
    }
  }

  if (isPlainObject(sources.secrets)) {
    for (const [key, raw] of Object.entries(/** @type {Record<string, unknown>} */ (sources.secrets))) {
      if (raw === undefined || raw === null) continue;
      if (typeof raw === "string" && raw.trim() === "") continue;
      if (isPlainObject(raw) && isPlainObject(config[key])) {
        mergeInto(/** @type {Record<string, unknown>} */ (config[key]), raw);
      } else {
        config[key] = cloneJson(raw);
      }
      applied.secrets.push(key);
    }
  }

  return { config, applied };
}

/**
 * Parses a JSON object out of a text file, returning `undefined` for a missing
 * file or invalid content instead of throwing at startup.
 * @param {string} filePath
 * @param {(path: string) => string} readFile
 * @returns {Record<string, unknown> | undefined}
 */
export function parseConfigText(text) {
  const raw = String(text ?? "").trim();
  if (raw === "") return {};
  const parsed = JSON.parse(raw);
  if (!isPlainObject(parsed)) throw new Error("expected a JSON object");
  return /** @type {Record<string, unknown>} */ (parsed);
}

/** @param {string} key */
export function isSecretKey(key) {
  return SECRET_KEY_PATTERN.test(key.replace(/[_-]/g, ""));
}

/**
 * Deep copy with every credential value replaced, for logs and panel status.
 * @param {unknown} value
 * @returns {unknown}
 */
export function redactConfig(value) {
  if (Array.isArray(value)) return value.map((item) => redactConfig(item));
  if (!isPlainObject(value)) return value;
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, item] of Object.entries(/** @type {Record<string, unknown>} */ (value))) {
    out[key] = isSecretKey(key) && item !== undefined && item !== null && item !== "" ? "[redacted]" : redactConfig(item);
  }
  return out;
}

/**
 * Presence map for the panel: which credential fields already hold a value.
 * Values never leave the plugin process.
 * @param {Record<string, unknown>} config
 * @returns {Record<string, boolean>}
 */
export function credentialPresence(config) {
  /** @type {Record<string, boolean>} */
  const out = {};
  for (const field of Object.values(PROVIDER_CREDENTIALS)) {
    const value = config[field];
    out[field] = typeof value === "string" ? value.trim() !== "" : value !== undefined && value !== null;
  }
  return out;
}

/**
 * Returns the configured provider list used by the panel's selects.
 * @param {Record<string, unknown>} config
 */
export function configuredProvider(config) {
  const value = config.searchProvider ?? config.provider;
  return typeof value === "string" ? value : "auto";
}

/** Upstream throws while *building* its core from an invalid `fetch` block, and
 * that failure would stop every tool from registering. These checks mirror
 * `resolveFetchModeConfig()` so nothing invalid ever reaches disk. */
const FETCH_MODE_VALUES = ["readable", "raw", "answer", "extract"];

/**
 * @param {Record<string, unknown>} config
 * @returns {string[]} problems, empty when the fetch block is acceptable
 */
export function validateFetchSettings(config) {
  /** @type {string[]} */
  const problems = [];
  if (!isPlainObject(config.fetch)) return problems;
  const fetch = /** @type {Record<string, unknown>} */ (config.fetch);
  let allowed = ["readable", "raw", "answer"];
  if (fetch.allowedModes !== undefined) {
    const modes = fetch.allowedModes;
    if (!Array.isArray(modes) || modes.length === 0) {
      problems.push('fetch.allowedModes must be a non-empty array of "readable", "raw", "answer", "extract"');
    } else {
      const invalid = modes.filter((mode) => !FETCH_MODE_VALUES.includes(/** @type {string} */ (mode)));
      if (invalid.length > 0) problems.push(`fetch.allowedModes contains an invalid mode: ${invalid.map(String).join(", ")}`);
      const duplicates = modes.filter((mode, index) => modes.indexOf(mode) !== index);
      if (duplicates.length > 0) problems.push(`fetch.allowedModes contains duplicates: ${duplicates.map(String).join(", ")}`);
      allowed = modes.map(String);
    }
  }
  const defaultMode = fetch.defaultMode;
  // Upstream resolves a missing `defaultMode` to "readable" and then requires it
  // to be one of `allowedModes` (`resolveFetchModeConfig`, web-tool-core.ts:181).
  // An omitted key therefore still has to be checked here: without this,
  // `{ allowedModes: ["raw"] }` passes validation, reaches disk, and every later
  // load throws while building the core — with no way to fix it from the panel.
  const effectiveDefault = defaultMode === undefined ? "readable" : defaultMode;
  if (defaultMode !== undefined && (typeof defaultMode !== "string" || !FETCH_MODE_VALUES.includes(defaultMode))) {
    problems.push('fetch.defaultMode must be one of "readable", "raw", "answer", "extract"');
  } else if (defaultMode === "extract") {
    problems.push('fetch.defaultMode cannot be "extract", because extract needs fields on each call');
  } else if (typeof effectiveDefault === "string" && !allowed.includes(effectiveDefault)) {
    problems.push(`fetch.defaultMode "${effectiveDefault}" must be one of fetch.allowedModes`);
  }
  return problems;
}

export { getPath as readConfigPath };
