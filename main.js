"use strict";

/**
 * PI-Desktop plugin entry point.
 *
 * The host injects the plugin API as `globalThis.pi` and calls `onLoad`,
 * `onUnload` and `onPanelInvoke`. This file only does the host plumbing:
 *
 *   1. resolve the plugin data directory,
 *   2. merge plugin settings + stored credentials + a legacy
 *      `~/.pi/web-search.json` into the single JSON file upstream reads,
 *   3. point the two upstream path hooks at that directory and require the
 *      bundle (upstream resolves its config path once, on initialisation),
 *   4. register the upstream tool descriptors with the host.
 *
 * Tool behaviour lives in `build/agent.cjs`, which bundles `src/` plus the
 * unmodified upstream modules; this file never re-implements a tool.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PLUGIN_ID = "pi.web-access";
const CONFIG_FILE = "web-search.json";
const SECRETS_FILE = "secrets.json";
const CACHE_DIR = "web-search-cache";

/**
 * Command ids. The manifest's `contributes.commands`, `pi.commands.register` and
 * the `command` a global shortcut targets must all use the same string, and the
 * host refuses a shortcut whose command it cannot find.
 */
const COMMAND_OPEN = "pi.web-access.open";
const COMMAND_RESULTS = "pi.web-access.results";
const COMMAND_SETTINGS = "pi.web-access.settings";

/** One binding. The host already spends Alt+Space and Alt+Shift+W. */
const SHORTCUT_ID = "pi.web-access.open";
const SHORTCUT_ACCELERATOR = "CommandOrControl+Shift+Y";

/** `pi.agent.complete` caps combined messages at 200,000 characters. */
const ANSWER_PAGE_LIMIT = 180_000;

/** Room for the question, the source URL and the cut notice in one prompt. */
const ANSWER_QUESTION_LIMIT = 8_000;
/** The host allows 8 `pi.agent.complete` calls per minute; 6 leaves headroom. */
const COMPLETE_BUDGET = 6;
const COMPLETE_WINDOW_MS = 60_000;
const ANSWER_SYSTEM = [
  "You answer a question from one fetched web page.",
  "Use only the page. Quote a short passage when it decides the answer.",
  "If the page does not contain the answer, say so plainly instead of guessing.",
].join(" ");

/** Entries kept for the panel's activity card. */
const ACTIVITY_LIMIT = 50;

const SUMMARY_SYSTEM = [
  "You summarise web search results for an engineer who asked for them.",
  "Lead with the answer when the results contain one, then group findings by sub-topic rather than by query.",
  "Keep every URL you rely on inline as a markdown link. Never invent a fact or a link.",
].join(" ");

/** @type {{ dataDir: string, configPath: string, legacyPath: string | null, applied: object, registered: string[], bundle: any, tools: any } | null} */
let runtime = null;

function host() {
  return globalThis.pi ?? null;
}

function logLine(message) {
  console.log(`[${PLUGIN_ID}] ${message}`);
}

function toMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function resolveDataDir(pi) {
  try {
    const dir = await pi?.plugin?.getDataPath?.();
    if (typeof dir === "string" && dir.trim() !== "") return dir;
  } catch (error) {
    logLine(`getDataPath unavailable: ${toMessage(error)}`);
  }
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), ".pi-desktop");
  return path.join(base, PLUGIN_ID);
}

/** Legacy locations, in the order upstream itself looks. The plugin data
 * directory is skipped so a materialised file never feeds itself. */
function legacyCandidates(dataDir) {
  const explicit = process.env.PI_WEB_ACCESS_LEGACY_CONFIG;
  if (explicit !== undefined) {
    // Explicit override: an empty value means "no legacy file", which is how
    // tests and a user pinning one path keep discovery deterministic.
    return explicit.trim() === "" ? [] : [path.resolve(explicit)];
  }
  const resolvedData = path.resolve(dataDir);
  const dirs = [];
  const push = (dir) => {
    if (!dir) return;
    if (path.resolve(dir) === resolvedData) return;
    dirs.push(dir);
  };
  push(process.env.PI_CODING_AGENT_DIR);
  if (process.env.XDG_CONFIG_HOME) push(path.join(process.env.XDG_CONFIG_HOME, "pi"));
  push(path.join(os.homedir(), ".pi"));
  return dirs.map((dir) => path.join(dir, CONFIG_FILE));
}

function readLegacyConfig(dataDir) {
  for (const file of legacyCandidates(dataDir)) {
    if (!fs.existsSync(file)) continue;
    try {
      return { file, config: JSON.parse(fs.readFileSync(file, "utf8")) };
    } catch (error) {
      logLine(`ignored unreadable legacy config ${file}: ${toMessage(error)}`);
    }
  }
  return undefined;
}

function secretsPath(dataDir) {
  return path.join(dataDir, SECRETS_FILE);
}

function readSecrets(dataDir) {
  const file = secretsPath(dataDir);
  try {
    if (!fs.existsSync(file)) return {};
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    logLine(`ignored unreadable ${SECRETS_FILE}: ${toMessage(error)}`);
    return {};
  }
}

function writeSecrets(dataDir, secrets) {
  const file = secretsPath(dataDir);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  // tmp + rename: a truncated secrets.json would read back as {} and then be
  // overwritten on the next save, silently losing every stored credential.
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(secrets, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, file);
  return file;
}

/** Returns a discriminated result: a failed read must not look like "no settings",
 * otherwise the next materialise would silently drop every stored setting. */
async function readSettings(pi) {
  try {
    const settings = await pi?.plugin?.getSettings?.();
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) return { ok: true, value: {} };
    return { ok: true, value: settings };
  } catch (error) {
    logLine(`getSettings failed: ${toMessage(error)}`);
    return { ok: false, error: toMessage(error) };
  }
}

/**
 * Merges every config source and validates the result without writing anything.
 * Both callers start here: `materialize` before it touches the file, and
 * `saveSettings` before the host stores a value upstream would later reject.
 */
function previewConfig(runtime, settings, secrets) {
  const bundle = runtime.bundle;
  const merged = bundle.mergeConfigSources({
    legacy: runtime.legacyConfig,
    settings,
    secrets,
  });
  return { merged, problems: bundle.validateFetchSettings(merged.config) };
}

/**
 * Validates and then writes the merged config where upstream reads it.
 *
 * Order matters: upstream throws while *building* its core from an invalid
 * `fetch` block, so a config that would not survive `createAgentTools()` must
 * never reach disk — otherwise every later load of the plugin fails too.
 */
function materialize(runtime, settings, secrets) {
  const { merged, problems } = previewConfig(runtime, settings, secrets);
  if (problems.length > 0) return { ok: false, problems, applied: runtime.applied };
  const text = `${JSON.stringify(merged.config, null, 2)}\n`;
  fs.mkdirSync(runtime.dataDir, { recursive: true, mode: 0o700 });
  const temporary = `${runtime.configPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, runtime.configPath);
  runtime.applied = merged.applied;
  return { ok: true, problems: [], applied: merged.applied };
}

/** Sets the two upstream path hooks for the duration of the require, then
 * restores the previous values: upstream caches the directory on first use. */
function loadBundle(dataDir) {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousCacheRoot = process.env.PI_WEB_ACCESS_CACHE_ROOT;
  process.env.PI_CODING_AGENT_DIR = dataDir;
  process.env.PI_WEB_ACCESS_CACHE_ROOT = dataDir;
  try {
    return require("./build/agent.cjs");
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousCacheRoot === undefined) delete process.env.PI_WEB_ACCESS_CACHE_ROOT;
    else process.env.PI_WEB_ACCESS_CACHE_ROOT = previousCacheRoot;
  }
}

function toolStatus() {
  if (!runtime) return null;
  try {
    return runtime.tools.describe();
  } catch (error) {
    return { error: toMessage(error) };
  }
}

async function panelStatus() {
  const read = await readSettings(host());
  const secrets = runtime ? readSecrets(runtime.dataDir) : {};
  const current = toolStatus();
  const errors = [...(runtime?.errors ?? [])];
  if (current && current.error) errors.push(`tools: ${current.error}`);
  let results = [];
  try {
    if (runtime) results = runtime.bundle.listStoredResults();
  } catch (error) {
    errors.push(`results: ${toMessage(error)}`);
  }
  // A command sets a focus target before opening the panel. The value is kept
  // rather than handed over once: the panel re-reads status on every reload, and
  // the renderer only scrolls when the target differs from the one it applied.
  const focus = runtime?.pendingFocus ?? null;
  const pi = host();
  return {
    ok: true,
    pluginId: PLUGIN_ID,
    settings: read.ok ? read.value : {},
    dataDir: runtime?.dataDir ?? null,
    configPath: runtime?.configPath ?? null,
    legacyPath: runtime?.legacyPath ?? null,
    applied: runtime?.applied ?? { legacy: false, settings: [], secrets: [] },
    registeredTools: runtime?.registered ?? [],
    enabledTools: (current && current.enabledTools) || [],
    fetchModes: (current && current.fetchModes) || null,
    maxInlineContentChars: (current && current.maxInlineContentChars) || null,
    allowedProviders: (current && current.allowedProviders) || [],
    credentialPresence: runtime ? runtime.bundle.credentialPresence(secrets) : {},
    credentialProviders: runtime ? runtime.bundle.PROVIDER_CREDENTIALS : {},
    results,
    activity: runtime?.activity ?? [],
    focus,
    commands: runtime?.commands ?? [],
    shortcut: runtime?.shortcut ?? null,
    // What this host can actually do, so the panel can explain a limitation
    // instead of letting a call fail with a host-level error.
    features: {
      answer: typeof pi?.agent?.complete === "function",
      images: true,
      // Nothing in this plugin can hand an image to a model: `pi.agent.complete`
      // takes text only, and upstream passes video frames to `answerFromPage` as
      // `images`. Advertising the capability would make the panel promise
      // something the first video fetch has to refuse.
      extract: true,
      video: false,
      openExternal: typeof pi?.shell?.openExternal === "function",
    },
    errors,
  };
}

/** Result-list view shared by every results channel. */
function listResults() {
  if (!runtime) return [];
  try {
    return runtime.bundle.listStoredResults();
  } catch (error) {
    logLine(`could not list stored results: ${toMessage(error)}`);
    return [];
  }
}

/** Stored-result ids are file names; `src/store.ts` enforces the same rule. */
function resultId(value) {
  const id = String(value ?? "");
  return /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : null;
}

function invalidResultId() {
  return { ok: false, code: "INVALID_ARGUMENT", message: "not a stored result id" };
}

/** Cuts text to `limit` UTF-16 units without splitting a surrogate pair. */
function sliceSafe(text, limit) {
  if (text.length <= limit) return text;
  let cut = limit;
  const last = text.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return text.slice(0, cut);
}

/**
 * Every `pi.agent.complete` call in this plugin spends from one quota (the host
 * allows 8 per minute). A single `fetch_content` in answer mode fires one call
 * per URL at once, so an unbounded bridge can exhaust the minute in one tool
 * call and take the auto-summary down with it. Six leaves headroom for a
 * summary; over budget, callers get a sentence with a wait time instead of a
 * host-level rejection.
 */
const completionLog = [];

function reserveCompletion() {
  const now = Date.now();
  while (completionLog.length > 0 && now - completionLog[0] >= COMPLETE_WINDOW_MS) completionLog.shift();
  if (completionLog.length >= COMPLETE_BUDGET) {
    const waitMs = COMPLETE_WINDOW_MS - (now - completionLog[0]);
    return { ok: false, waitSeconds: Math.max(1, Math.ceil(waitMs / 1000)) };
  }
  completionLog.push(now);
  return { ok: true };
}

/** Ring buffer for the panel's activity card; the plugin process owns it. */
function noteActivity(entry) {
  if (!runtime) return;
  runtime.activity.unshift({ at: Date.now(), ...entry });
  if (runtime.activity.length > ACTIVITY_LIMIT) runtime.activity.length = ACTIVITY_LIMIT;
}

/**
 * Runs `fetch_content mode: "answer"` for the bundle.
 *
 * Upstream's Pi host answers from a page through `ctx.modelRegistry`; the
 * desktop equivalent is `pi.agent.complete`, a host-owned one-shot that resolves
 * the credential itself and never hands one to the plugin. That API takes text
 * only, so a page answer works here while an image or a video frame cannot reach
 * the model: upstream's core passes those as `images`, and this bridge refuses
 * instead of answering from a caption alone.
 */
async function answerFromPage(request, signal) {
  const pi = host();
  if (!pi?.agent?.complete) throw new Error("this host does not expose agent.complete");
  if (signal?.aborted) throw new Error("the fetch was cancelled before the answer model ran");
  const requested = typeof request?.model === "string" ? request.model.trim() : "";
  const modelKey = requested || runtime?.lastModelKey || "";
  if (modelKey === "") {
    throw new Error('answer needs a model: pick one for this session, or set fetch.answerModel to "provider/model-id"');
  }
  if (Array.isArray(request?.images) && request.images.length > 0) {
    throw new Error("this host cannot send images to the answer model; fetch the image on its own or use mode readable");
  }
  const page = typeof request?.pageText === "string" ? request.pageText : "";
  const body = page.length > ANSWER_PAGE_LIMIT
    ? `${sliceSafe(page, ANSWER_PAGE_LIMIT)}\n\n[Page cut at ${ANSWER_PAGE_LIMIT} characters.]`
    : page;
  const asked = typeof request?.question === "string" ? request.question : "";
  const question = sliceSafe(asked, ANSWER_QUESTION_LIMIT);
  const prompt = [
    `Source: ${request?.sourceUrl ?? "(unknown)"}`,
    `Question: ${question || "(none)"}`,
    "",
    "Page:",
    body,
  ].join("\n");
  const slot = reserveCompletion();
  if (!slot.ok) {
    throw new Error(`the host allows ${COMPLETE_BUDGET} completions per minute; try again in ${slot.waitSeconds}s`);
  }
  const result = await pi.agent.complete({
    modelKey,
    system: ANSWER_SYSTEM,
    messages: [{ role: "user", content: prompt }],
  });
  if (signal?.aborted) throw new Error("the fetch was cancelled while the answer model ran");
  const text = typeof result?.text === "string" ? result.text.trim() : "";
  // Upstream treats a returned answer as success and swaps the page for it, so
  // an empty one would hand back a "fetched" result with no content and no
  // explanation. Fail loudly instead and let upstream keep the page text.
  if (text === "") throw new Error("the answer model returned nothing");
  noteActivity({ kind: "answer", label: request?.sourceUrl ?? "", detail: modelKey });
  return { text };
}

/**
 * Stands in for `ExtensionContext.modelRegistry.getProviderAuth`, which only
 * `fetch_content mode: "extract"` reads: upstream's field extraction calls
 * Cloudflare Workers AI and takes the credential from Pi's model registry. The
 * desktop build reads the same values from the plugin's stored settings first and
 * the process environment second, so extraction works without Pi being present.
 * Returning undefined lets upstream report its own "not set up" message.
 */
async function providerAuth(provider) {
  const secrets = runtime ? readSecrets(runtime.dataDir) : {};
  const pick = (...values) => values.find((value) => typeof value === "string" && value.trim() !== "")?.trim() ?? "";
  if (provider === "cloudflare-workers-ai") {
    const apiKey = pick(secrets.cloudflareApiKey, process.env.CLOUDFLARE_API_KEY, process.env.CLOUDFLARE_API_TOKEN);
    if (apiKey === "") return undefined;
    return {
      apiKey,
      env: { CLOUDFLARE_ACCOUNT_ID: pick(secrets.cloudflareAccountId, process.env.CLOUDFLARE_ACCOUNT_ID) },
    };
  }
  if (provider === "cloudflare-ai-gateway") {
    const gatewayId = pick(secrets.cloudflareGatewayId, process.env.CLOUDFLARE_GATEWAY_ID);
    return gatewayId === "" ? undefined : { env: { CLOUDFLARE_GATEWAY_ID: gatewayId } };
  }
  return undefined;
}

/**
 * Auto-summary for `web_search`, gated on the `autoSummary` setting.
 *
 * Upstream awaits this inside the search call and, when it returns prose,
 * replaces the raw result table with that prose. Every failure path returns an
 * empty summary instead of throwing: a summary that cannot be produced must not
 * turn a successful search into a tool error.
 */
async function summarizeResults(results) {
  const started = Date.now();
  const off = (reason) => ({
    approvedSummary: "",
    summaryMeta: {
      model: null,
      durationMs: Date.now() - started,
      tokenEstimate: 0,
      fallbackUsed: true,
      fallbackReason: reason,
      phase: "deterministic-fallback",
    },
  });

  if (!runtime || runtime.lastSettings.autoSummary !== true) return off("auto-summary is off");
  const pi = host();
  if (!pi?.agent?.complete) return off("this host does not expose agent.complete");
  const modelKey = runtime.lastModelKey || "";
  if (modelKey === "") return off("auto-summary needs a session model");

  const body = (Array.isArray(results) ? results : [])
    .map((item, index) => {
      const hits = Array.isArray(item?.results) ? item.results.slice(0, 8) : [];
      const lines = [`## Query ${index + 1}: ${item?.query ?? ""}`];
      if (typeof item?.answer === "string" && item.answer !== "") lines.push(`Provider answer: ${item.answer}`);
      for (const hit of hits) {
        const title = typeof hit?.title === "string" && hit.title !== "" ? hit.title : hit?.url ?? "";
        const snippet = typeof hit?.snippet === "string" ? hit.snippet : typeof hit?.description === "string" ? hit.description : "";
        lines.push(`- ${title}\n  ${hit?.url ?? ""}\n  ${snippet.slice(0, 300)}`);
      }
      return lines.join("\n");
    })
    .join("\n\n");
  if (body.trim() === "") return off("no results to summarise");

  const prompt = `Summarise these search results.\n\n${sliceSafe(body, 60000)}`;
  try {
    const slot = reserveCompletion();
    if (!slot.ok) {
      noteActivity({ kind: "summary-skipped", label: "completion budget spent", detail: modelKey });
      return off(`the host allows ${COMPLETE_BUDGET} completions per minute; the summary was skipped`);
    }
    const answer = await pi.agent.complete({
      modelKey,
      system: SUMMARY_SYSTEM,
      messages: [{ role: "user", content: prompt }],
    });
    const text = typeof answer?.text === "string" ? answer.text.trim() : "";
    if (text === "") return off("the model returned nothing");
    noteActivity({ kind: "summary", label: `${results.length} query(s)`, detail: modelKey });
    return {
      approvedSummary: text,
      summaryMeta: {
        model: modelKey,
        durationMs: Date.now() - started,
        tokenEstimate: Math.ceil(prompt.length / 4),
        fallbackUsed: false,
        phase: "summary-model",
      },
    };
  } catch (error) {
    noteActivity({ kind: "summary-failed", label: toMessage(error), detail: modelKey });
    return off(toMessage(error));
  }
}

/**
 * Commands are the desktop stand-in for the upstream slash commands. `run()`
 * takes no arguments, so each one opens the panel on a section instead of
 * accepting a query inline.
 */
async function registerCommands() {
  const pi = host();
  if (!pi?.commands?.register) return;
  const open = async (focus) => {
    if (runtime) runtime.pendingFocus = focus;
    await pi.ui?.openPanel?.({ title: "Web Access" });
  };
  const commands = [
    { id: COMMAND_OPEN, title: "Web Access: Open panel", keywords: ["web", "search", "fetch", "联网"], run: () => open("overview") },
    { id: COMMAND_RESULTS, title: "Web Access: Stored results", keywords: ["web", "responseId", "results", "已存"], run: () => open("results") },
    { id: COMMAND_SETTINGS, title: "Web Access: Credentials and settings", keywords: ["web", "credentials", "providers", "设置"], run: () => open("settings") },
  ];
  for (const command of commands) {
    try {
      await pi.commands.register(command);
      runtime?.commands.push(command.id);
    } catch (error) {
      logLine(`could not register ${command.id}: ${toMessage(error)}`);
    }
  }
}

async function unregisterCommands() {
  const pi = host();
  if (!pi?.commands?.unregister || !runtime) return;
  for (const id of [...runtime.commands]) {
    try {
      await pi.commands.unregister(id);
    } catch (error) {
      logLine(`could not unregister ${id}: ${toMessage(error)}`);
    }
  }
  if (runtime) runtime.commands = [];
}

/**
 * The manifest declares the accelerator and the host registers it after load,
 * but only when the target command exists; this call also covers a host that
 * ignores `contributes.globalShortcuts`. A refusal is a return value, not an
 * exception, so an OS or PI-Desktop reservation is reported once and left alone.
 */
async function registerShortcut() {
  const pi = host();
  if (!pi?.keyboard?.registerGlobalShortcut || !runtime) return;
  if (!runtime.commands.includes(COMMAND_OPEN)) return;
  try {
    const result = await pi.keyboard.registerGlobalShortcut({
      id: SHORTCUT_ID,
      accelerator: SHORTCUT_ACCELERATOR,
      command: COMMAND_OPEN,
    });
    runtime.shortcut = result ?? null;
    if (result && result.registered === false) {
      logLine(`shortcut ${SHORTCUT_ACCELERATOR} not registered: ${result.error ?? "unknown"}`);
    }
  } catch (error) {
    logLine(`shortcut ${SHORTCUT_ACCELERATOR} rejected: ${toMessage(error)}`);
  }
}

async function unregisterShortcut() {
  const pi = host();
  if (!pi?.keyboard?.unregisterGlobalShortcut) return;
  try {
    await pi.keyboard.unregisterGlobalShortcut(SHORTCUT_ID);
  } catch (error) {
    logLine(`could not unregister shortcut: ${toMessage(error)}`);
  }
}

async function registerTools() {
  const pi = host();
  if (!pi?.agent?.registerTool) throw new Error("host does not expose agent.registerTool");
  const enabled = new Set(runtime.tools.enabledToolNames());
  // Record each name as soon as the host accepts it: a failure half way through
  // must still leave the earlier registrations removable in onUnload.
  runtime.registered = [];
  for (const tool of runtime.tools.tools) {
    if (!enabled.has(tool.name)) continue;
    await pi.agent.registerTool({
      name: tool.name,
      description: tool.description,
      risk: tool.risk,
      schema: tool.schema,
      execute: (args, context) => {
        // `fetch_content mode "answer"` needs a model and the host hands the
        // session's model key to the tool call; `pi.agent.complete` wants exactly
        // that string.
        if (context && typeof context.modelKey === "string" && context.modelKey !== "") {
          runtime.lastModelKey = context.modelKey;
        }
        const mode = args && typeof args === "object" ? args.mode : undefined;
        noteActivity({ kind: "tool", label: tool.name, detail: typeof mode === "string" ? mode : "" });
        return tool.execute(args, context);
      },
    });
    runtime.registered.push(tool.name);
  }
  return runtime.registered;
}

async function unregisterTools() {
  const pi = host();
  if (!pi?.agent?.unregisterTool || !runtime) return;
  for (const name of [...runtime.registered]) {
    try {
      await pi.agent.unregisterTool(name);
    } catch (error) {
      logLine(`could not unregister ${name}: ${toMessage(error)}`);
    }
  }
  if (runtime) runtime.registered = [];
}

async function onLoad() {
  const pi = host();
  // A plugin reload must not leave the previous generation's tools registered:
  // the host would keep answering calls for names this instance no longer owns.
  if (runtime) await onUnload();
  const dataDir = await resolveDataDir(pi);
  const legacy = readLegacyConfig(dataDir);
  const secrets = readSecrets(dataDir);

  runtime = {
    dataDir,
    configPath: path.join(dataDir, CONFIG_FILE),
    legacyPath: legacy?.file ?? null,
    legacyConfig: legacy?.config,
    applied: null,
    registered: [],
    bundle: null,
    tools: null,
    errors: [],
    lastSettings: {},
    commands: [],
    shortcut: null,
    activity: [],
    pendingFocus: null,
    lastModelKey: "",
  };

  runtime.bundle = loadBundle(dataDir);
  const read = await readSettings(pi);
  if (!read.ok) runtime.errors.push(`settings: ${read.error}`);
  if (read.ok) runtime.lastSettings = read.value;
  const written = materialize(runtime, runtime.lastSettings, secrets);
  if (!written.ok) {
    // Never hand upstream a config it will reject: that would register zero
    // tools and look healthy. Fail the load with the real reason instead, and
    // leave whatever config file was already there untouched.
    for (const problem of written.problems) runtime.errors.push(`config: ${problem}`);
    throw new Error(`invalid configuration, nothing was written: ${written.problems.join("; ")}`);
  }
  runtime.bundle.configureResultStore(dataDir);
  runtime.tools = runtime.bundle.createAgentTools({ log: logLine, answerFromPage, providerAuth, summarize: summarizeResults });

  const registered = await registerTools();
  await registerCommands();
  await registerShortcut();
  logLine(
    `ready: ${registered.length} tool(s) [${registered.join(", ")}], config ${runtime.configPath}` +
      (legacy ? `, legacy ${legacy.file}` : ""),
  );
}

async function onUnload() {
  try {
    await unregisterShortcut();
  } catch (error) {
    logLine(`unload shortcut cleanup failed: ${toMessage(error)}`);
  }
  try {
    await unregisterCommands();
  } catch (error) {
    logLine(`unload command cleanup failed: ${toMessage(error)}`);
  }
  try {
    await unregisterTools();
  } catch (error) {
    logLine(`unload tool cleanup failed: ${toMessage(error)}`);
  }
  runtime = null;
}

/** Re-materialises the config from every source and rebuilds the upstream core.
 * A config upstream would reject is never written: the previous file stays, the
 * running core keeps working and the panel shows why the save did not apply. */
async function refresh() {
  if (!runtime) throw new Error("plugin is not loaded");
  const read = await readSettings(host());
  const secrets = readSecrets(runtime.dataDir);
  const settings = read.ok ? read.value : runtime.lastSettings;
  const written = materialize(runtime, settings, secrets);
  const errors = [];
  if (!read.ok) errors.push(`settings: ${read.error}`);
  if (!written.ok) {
    for (const problem of written.problems) errors.push(`config: ${problem}`);
    runtime.errors = errors;
    return await panelStatus();
  }
  runtime.errors = errors;
  runtime.lastSettings = settings;
  if (runtime.tools && typeof runtime.tools.reload === "function") runtime.tools.reload();
  return await panelStatus();
}

async function saveSettings(payload) {
  const pi = host();
  if (!runtime) throw new Error("plugin is not loaded");
  if (!pi?.plugin?.setSettings) throw new Error("host does not expose plugin.setSettings");
  const patch = payload && typeof payload === "object" ? payload : {};
  // Validate against the merged config *before* the host stores anything. A
  // value the host accepts but upstream rejects at build time would make every
  // later load fail, and the panel that could repair it lives in this plugin.
  const preview = previewConfig(runtime, { ...runtime.lastSettings, ...patch }, readSecrets(runtime.dataDir));
  if (preview.problems.length > 0) {
    const errors = [...(runtime.errors ?? []), ...preview.problems.map((problem) => `config: ${problem}`)];
    const status = await panelStatus();
    return { ...status, ok: false, errors };
  }
  await pi.plugin.setSettings(patch);
  return await refresh();
}

function saveCredential(field, value) {
  if (!runtime) throw new Error("plugin is not loaded");
  const known = new Set(Object.values(runtime.bundle.PROVIDER_CREDENTIALS));
  if (!known.has(field)) throw new Error(`unknown credential field "${field}"`);
  const secrets = readSecrets(runtime.dataDir);
  if (value === null || value === undefined || String(value).trim() === "") delete secrets[field];
  else secrets[field] = String(value).trim();
  writeSecrets(runtime.dataDir, secrets);
}

/**
 * @param {string} channel
 * @param {unknown} payload
 */
async function onPanelInvoke(channel, payload) {
  try {
    if (!runtime) throw new Error("plugin is not loaded");
    switch (String(channel)) {
      case "status":
        return await panelStatus();
      case "availability":
        return { ok: true, availability: await runtime.tools.availability() };
      case "reload":
        return await refresh();
      case "settings:save":
        return await saveSettings(payload);
      case "secret:set": {
        const field = String(payload?.field ?? "");
        saveCredential(field, payload?.value);
        return await refresh();
      }
      case "secrets:save": {
        const entries = payload?.entries && typeof payload.entries === "object" ? payload.entries : {};
        const known = new Set(Object.values(runtime.bundle.PROVIDER_CREDENTIALS));
        for (const [field, value] of Object.entries(entries)) {
          if (!known.has(field)) throw new Error(`unknown credential field "${field}"`);
          saveCredential(field, value);
        }
        return await refresh();
      }
      case "advanced:save": {
        const text = String(payload?.json ?? "").trim();
        let parsed;
        try {
          parsed = text === "" ? {} : runtime.bundle.parseConfigText(text);
        } catch (error) {
          logLine(`advanced JSON rejected: ${toMessage(error)}`);
          // The parser quotes the text around the error, and that text is
          // usually a pasted credential: keep the quoted message out of the
          // panel and say what actually needs fixing.
          return {
            ok: false,
            code: "INVALID_ARGUMENT",
            message: "the JSON did not parse; check for a trailing comma, a missing quote or a stray character",
          };
        }
        const secrets = readSecrets(runtime.dataDir);
        for (const [key, value] of Object.entries(parsed)) {
          if (value === null) delete secrets[key];
          else secrets[key] = value;
        }
        writeSecrets(runtime.dataDir, secrets);
        return await refresh();
      }
      case "results:list":
        return { ok: true, results: listResults() };
      case "results:hydrate": {
        const id = resultId(payload?.id);
        if (id === null) return invalidResultId();
        return { ok: runtime.bundle.hydrateResult(id), results: listResults() };
      }
      case "results:peek": {
        const id = resultId(payload?.id);
        if (id === null) return invalidResultId();
        const result = runtime.bundle.readStoredResult(id);
        return { ok: result !== null, result };
      }
      case "results:drop": {
        const id = resultId(payload?.id);
        if (id === null) return invalidResultId();
        return { ok: true, dropped: runtime.bundle.dropStoredResult(id), results: listResults() };
      }
      case "results:clear":
        return { ok: true, removed: runtime.bundle.clearStoredResults(), results: listResults() };
      case "results:repair":
        return { ok: true, added: runtime.bundle.repairIndex(), results: listResults() };
      case "activity":
        return {
          ok: true,
          activity: runtime?.activity ?? [],
          commands: runtime?.commands ?? [],
          shortcut: runtime?.shortcut ?? null,
        };
      case "open:external": {
        const url = String(payload?.url ?? "");
        if (!/^https?:\/\//i.test(url)) {
          return { ok: false, code: "INVALID_ARGUMENT", message: "only http(s) links open externally" };
        }
        const shell = host()?.shell;
        if (!shell?.openExternal) {
          return { ok: false, code: "UNSUPPORTED", message: "host does not expose shell.openExternal" };
        }
        await shell.openExternal(url);
        return { ok: true };
      }
      default:
        return { ok: false, code: "UNKNOWN_CHANNEL", message: `unknown channel "${channel}"` };
    }
  } catch (error) {
    return { ok: false, code: "FAILED", message: toMessage(error) };
  }
}

module.exports = { onLoad, onUnload, onPanelInvoke };
