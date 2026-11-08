/**
 * Pure view model for the Web Access panel.
 *
 * No DOM access happens here: every rule that decides what the panel shows or
 * what it sends back to the plugin process lives in these functions, so the DOM
 * test and the real panel exercise the same logic.
 */
(function (root) {
  "use strict";

  const SETTING_KEYS = [
    "searchProvider",
    "fetchDefaultMode",
    "fetchAllowedModes",
    "maxInlineContentChars",
    "proxy",
    "enableWebSearch",
    "enableSourceCheck",
    "enableFetchContent",
    "enableGetSearchContent",
  ];

  // Every mode the widened fetch_content schema exposes. `extract` still needs
  // `fields` on the call itself, so it is a sensible default only when the caller
  // supplies them; the hint under the control says so.
  const FETCH_MODES = ["readable", "raw", "answer", "extract"];

  /** @param {unknown} value */
  function asObject(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  /**
   * Provider rows for the availability grid: available first, then alphabetical.
   * @param {Record<string, unknown>} availability
   * @param {readonly string[]} providers
   */
  function resolveAvailabilityRows(availability, providers) {
    const source = asObject(availability);
    const names = Array.isArray(providers) && providers.length > 0 ? providers : Object.keys(source);
    return names
      .filter((name) => name !== "all")
      .map((name) => ({ provider: name, available: source[name] === true }))
      .sort((left, right) => {
        if (left.available !== right.available) return left.available ? -1 : 1;
        return left.provider.localeCompare(right.provider);
      });
  }

  /** @param {Record<string, unknown>} status */
  function buildSettingsDraft(status) {
    const settings = asObject(asObject(status).settings);
    const fetchModes = asObject(asObject(status).fetchModes);
    const allowed = Array.isArray(fetchModes.allowedModes) ? fetchModes.allowedModes : ["readable", "raw", "answer"];
    return {
      searchProvider: typeof settings.searchProvider === "string" ? settings.searchProvider : "auto",
      fetchDefaultMode:
        typeof settings.fetchDefaultMode === "string"
          ? settings.fetchDefaultMode
          : typeof fetchModes.defaultMode === "string"
            ? fetchModes.defaultMode
            : "readable",
      fetchAllowedModes: allowed,
      maxInlineContentChars:
        typeof settings.maxInlineContentChars === "number" ? String(settings.maxInlineContentChars) : "",
      proxy: typeof settings.proxy === "string" ? settings.proxy : "",
      enableWebSearch: settings.enableWebSearch !== false,
      enableSourceCheck: settings.enableSourceCheck !== false,
      enableFetchContent: settings.enableFetchContent !== false,
      enableGetSearchContent: settings.enableGetSearchContent !== false,
    };
  }

  /**
   * Turns a draft into the settings patch the plugin should persist: blank
   * strings and unparseable numbers are dropped so the plugin keeps applying the
   * upstream defaults instead of writing garbage.
   * @param {Record<string, unknown>} draft
   */
  function buildSettingsPatch(draft) {
    const source = asObject(draft);
    /** @type {Record<string, unknown>} */
    const patch = {};

    const text = (key) => (typeof source[key] === "string" ? source[key].trim() : "");
    if (text("searchProvider")) patch.searchProvider = text("searchProvider");
    if (text("fetchDefaultMode")) patch.fetchDefaultMode = text("fetchDefaultMode");
    if (text("proxy")) patch.proxy = text("proxy");

    const modes = Array.isArray(source.fetchAllowedModes)
      ? source.fetchAllowedModes
      : String(source.fetchAllowedModes ?? "").split(",");
    const cleanedModes = modes.map((mode) => String(mode).trim()).filter((mode) => FETCH_MODES.includes(mode));
    // The setting is declared as `string` in the manifest and the host runs a
    // `json` setting through `JSON.parse`; a comma-separated string is the one
    // form both sides accept.
    if (cleanedModes.length > 0) patch.fetchAllowedModes = cleanedModes.join(",");

    const chars = text("maxInlineContentChars");
    if (chars !== "" && Number.isFinite(Number(chars)) && Number(chars) > 0) {
      patch.maxInlineContentChars = Number(chars);
    }

    for (const key of ["enableWebSearch", "enableSourceCheck", "enableFetchContent", "enableGetSearchContent"]) {
      if (typeof source[key] === "boolean") patch[key] = source[key];
    }
    return patch;
  }

  /**
   * Credential rows: one per provider that maps to a config field, showing only
   * whether a value exists. The panel never receives a stored credential.
   * @param {{ credentialPresence?: Record<string, unknown>, credentialProviders?: Record<string, unknown> }} status
   */
  function credentialRows(status) {
    const presence = asObject(asObject(status).credentialPresence);
    const providers = asObject(asObject(status).credentialProviders);
    return Object.entries(providers)
      .map(([provider, field]) => ({
        provider: String(provider),
        field: String(field),
        configured: presence[field] === true,
      }))
      .sort((left, right) => left.provider.localeCompare(right.provider));
  }

  /**
   * One-line summary of which config sources contributed.
   * @param {{ legacy?: boolean, settings?: unknown[], secrets?: unknown[] }} applied
   */
  function formatSourceSummary(applied) {
    const source = asObject(applied);
    const settings = Array.isArray(source.settings) ? source.settings.length : 0;
    const secrets = Array.isArray(source.secrets) ? source.secrets.length : 0;
    const parts = [
      `settings ${settings}`,
      `credentials ${secrets}`,
      source.legacy === true ? "legacy file merged" : "no legacy file",
    ];
    return parts.join(" · ");
  }

  function formatTime(value) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "—";
    try {
      return new Date(value).toLocaleString();
    } catch {
      return "—";
    }
  }

  function formatBytes(value) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "—";
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
    return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
  }

  /**
   * Stored results, newest first, with the display strings already formatted so
   * the renderer stays markup-only.
   * @param {{ results?: unknown }} status
   */
  function resultRows(status) {
    const list = Array.isArray(asObject(status).results) ? asObject(status).results : [];
    return list
      .filter((entry) => entry && typeof entry === "object" && typeof entry.id === "string")
      .map((entry) => ({
        id: entry.id,
        type: typeof entry.type === "string" ? entry.type : "unknown",
        label: typeof entry.label === "string" && entry.label !== "" ? entry.label : entry.id,
        timestamp: typeof entry.timestamp === "number" ? entry.timestamp : 0,
        when: formatTime(entry.timestamp),
        size: formatBytes(entry.size),
        urlCount: typeof entry.urlCount === "number" ? entry.urlCount : 0,
        queryCount: typeof entry.queryCount === "number" ? entry.queryCount : 0,
      }))
      .sort((left, right) => right.timestamp - left.timestamp);
  }

  /**
   * Activity entries for the panel card; the plugin's ring buffer arrives newest
   * first and is not re-sorted here.
   * @param {{ activity?: unknown }} status
   */
  function activityRows(status) {
    const list = Array.isArray(asObject(status).activity) ? asObject(status).activity : [];
    return list
      .filter((entry) => entry && typeof entry === "object")
      .map((entry) => ({
        kind: typeof entry.kind === "string" ? entry.kind : "event",
        label: typeof entry.label === "string" ? entry.label : "",
        detail: typeof entry.detail === "string" ? entry.detail : "",
        when: formatTime(entry.at),
      }));
  }

  /**
   * Capability rows for this host build. A false row is still listed, so the
   * panel can explain a limitation instead of hiding it.
   * @param {{ features?: unknown }} status
   */
  function featureRows(status) {
    const features = asObject(asObject(status).features);
    const labels = {
      answer: "页面问答（answer 模式）",
      images: "直接抓取图片",
      extract: "字段提取（extract 模式）",
      video: "视频分析",
      openExternal: "在浏览器中打开链接",
    };
    return Object.entries(labels).map(([key, label]) => ({
      key,
      label,
      available: features[key] === true,
    }));
  }

  /**
   * First readable slice of a stored result for the preview pane.
   * @param {unknown} result StoredSearchData as returned by `results:peek`
   * @param {number} [limit]
   */
  function previewText(result, limit) {
    const data = asObject(result);
    const cap = typeof limit === "number" && limit > 0 ? limit : 2000;
    const pages = Array.isArray(data.urls) ? data.urls : [];
    if (pages.length > 0) {
      const page = asObject(pages[0]);
      const head = [
        typeof page.title === "string" ? page.title : "",
        typeof page.url === "string" ? page.url : "",
        page.error ? `Error: ${page.error}` : "",
      ].filter(Boolean).join("\n");
      const body = typeof page.content === "string" ? page.content.slice(0, cap) : "";
      return [head, body].filter(Boolean).join("\n\n");
    }
    const queries = Array.isArray(data.queries) ? data.queries : [];
    if (queries.length > 0) {
      return queries
        .map((item) => {
          const query = asObject(item);
          const answer = typeof query.answer === "string" ? query.answer.slice(0, cap) : "";
          return [`# ${typeof query.query === "string" ? query.query : ""}`, answer].filter(Boolean).join("\n");
        })
        .join("\n\n")
        .slice(0, cap);
    }
    return "";
  }

  /**
   * Normalises a plugin-channel reply into what the panel should render.
   * @param {unknown} reply
   */
  function describeReply(reply) {
    const value = asObject(reply);
    if (value.ok === true) return { ok: true, message: "" };
    return { ok: false, message: typeof value.message === "string" ? value.message : "请求失败" };
  }

  /** @param {Record<string, unknown>} state @param {string} message */
  function applySaveFailure(state, message) {
    return { ...asObject(state), saving: false, error: String(message ?? "请求失败"), saved: false };
  }

  /** @param {Record<string, unknown>} state */
  function applySaveSuccess(state) {
    return { ...asObject(state), saving: false, error: "", saved: true };
  }

  const api = {
    SETTING_KEYS,
    FETCH_MODES,
    resolveAvailabilityRows,
    buildSettingsDraft,
    buildSettingsPatch,
    credentialRows,
    formatSourceSummary,
    formatTime,
    formatBytes,
    resultRows,
    activityRows,
    featureRows,
    previewText,
    describeReply,
    applySaveFailure,
    applySaveSuccess,
  };

  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.WebAccessModel = api;
})(typeof window !== "undefined" ? window : typeof globalThis !== "undefined" ? globalThis : null);
