/**
 * The desktop replacement for upstream's `createStandaloneWebToolCore()`.
 *
 * Upstream ships two hosts for the same core: the Pi extension (full
 * `ExtensionContext`) and `createStandaloneWebToolCore()` for hosts without Pi,
 * which is what the MCP server uses. The standalone wrapper deliberately narrows
 * behaviour that a Pi-less host supposedly cannot do:
 *
 *   - `extractOptions: { rejectDirectImages }` refuses every direct image URL,
 *   - `standaloneFetchRejection()` refuses `mode: "answer"`,
 *   - no `answerFromPage` hook, so an answer would have nowhere to run.
 *
 * The desktop host *can* do those things: it has an image path
 * (`src/shims/pi-coding-agent.ts`) and one-shot model access
 * (`pi.agent.complete`). So this factory calls `createWebToolCore(host)`
 * directly — the same upstream function, with a host that supplies what it can
 * actually do — and keeps the standalone wrapper's bookkeeping (the 50-entry
 * eviction list and `markToolError`).
 *
 * It also persists every stored result (`src/store.ts`), which replaces the
 * `sessionManager` bridge the Pi host uses to keep a `responseId` alive.
 *
 * Nothing in `upstream/` changes: this file only chooses a different export.
 */
import {
  DEFAULT_TOOL_NAMES,
  createWebToolCore,
  getMaxInlineContentChars,
  isToolEnabled,
  loadConfig,
  markToolError,
  resolveFetchModeConfig,
  type FetchedContentData,
  type StandaloneWebToolCore,
  type ToolNames,
  type WebSearchConfig,
  type WebToolCoreSettings,
} from "../upstream/web-tool-core.ts";
import { deleteResult, getResult, storeResult, type QueryResultData, type StoredSearchData } from "../upstream/storage.ts";
import { hydrateResult, persistResult } from "./store.ts";

/** `host.answerFromPage` receives exactly this from the core. */
export interface DesktopAnswerRequest {
  question: string;
  pageText: string;
  sourceUrl: string;
  /** `fetch.answerModel` from the call, already in `provider/model` form. */
  model?: string;
  /** Video frames or a fetched image. The desktop model bridge cannot send these. */
  images?: Array<{ data: string; mimeType: string; label?: string }>;
}

/**
 * The shape `runClairic` reads off `modelRegistry.getProviderAuth`.
 *
 * Upstream reads `credential?.auth.apiKey` (`upstream/field-extract.ts`) and
 * that optional chain only guards `credential`: a flat `{ apiKey }` leaves
 * `auth` undefined and throws on `.apiKey`. The credential therefore keeps the
 * nesting, and `normalizeProviderAuth` upgrades the flat form the plugin entry
 * point builds.
 */
export interface DesktopProviderAuth {
  auth?: { apiKey?: string };
  env?: Record<string, string | undefined>;
}

/** What a hook may return: upstream's nested credential, or the flat one. */
export type DesktopProviderAuthInput =
  | DesktopProviderAuth
  | { apiKey?: string; env?: Record<string, string | undefined> };

function normalizeProviderAuth(value: DesktopProviderAuthInput | undefined): DesktopProviderAuth | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as { apiKey?: unknown; auth?: { apiKey?: unknown }; env?: Record<string, string | undefined> };
  const apiKey = typeof record.auth?.apiKey === "string"
    ? record.auth.apiKey
    : typeof record.apiKey === "string" ? record.apiKey : undefined;
  const env = record.env;
  if (!apiKey && !env) return undefined;
  return {
    ...(apiKey ? { auth: { apiKey } } : {}),
    ...(env ? { env } : {}),
  };
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What `webSearch` gets back when the summary model fails: no summary, table intact. */
function fallbackSummary(reason: string): { approvedSummary: string; summaryMeta: DesktopSummaryMeta } {
  return {
    approvedSummary: "",
    summaryMeta: {
      model: null,
      durationMs: 0,
      tokenEstimate: 0,
      fallbackUsed: true,
      fallbackReason: reason,
      phase: "deterministic-fallback",
    },
  };
}

/** Upstream's `SummaryMeta`, restated so this module needs no runtime import from it. */
export interface DesktopSummaryMeta {
  model: string | null;
  durationMs: number;
  tokenEstimate: number;
  fallbackUsed: boolean;
  fallbackReason?: string;
  phase?: "summary-model" | "deterministic-fallback";
  edited?: boolean;
}

export interface DesktopCoreHooks {
  /**
   * Runs `fetch_content mode: "answer"`. Supplied by `main.js`, because only the
   * plugin entry point can reach `pi.agent.complete`.
   */
  answerFromPage?: (request: DesktopAnswerRequest, signal?: AbortSignal) => Promise<{ text: string }>;
  /**
   * Stands in for `ExtensionContext.modelRegistry.getProviderAuth`, which only
   * `extract` mode reaches: upstream's field extraction calls Cloudflare Workers
   * AI and reads the credential from the Pi model registry. Without a hook the
   * core reports "extract mode runs only inside Pi".
   */
  providerAuth?: (provider: string) => Promise<DesktopProviderAuthInput | undefined>;
  /**
   * Runs the auto-summary after a search. Returning prose replaces the raw result
   * table with that prose; an empty string leaves the table intact, which is what
   * the host returns when the user has not turned auto-summary on.
   */
  summarize?: (results: QueryResultData[]) => Promise<{ approvedSummary: string; summaryMeta: DesktopSummaryMeta }>;
}

/** Upstream's standalone cap; kept so memory behaviour matches the MCP host. */
const MAX_STORED_RESULTS = 50;

function buildSettings(config: WebSearchConfig): WebToolCoreSettings {
  return {
    toolNames: { ...DEFAULT_TOOL_NAMES },
    enabledTools: {
      webSearch: isToolEnabled(config, "webSearch"),
      sourceCheck: isToolEnabled(config, "sourceCheck"),
      fetchContent: isToolEnabled(config, "fetchContent"),
      getSearchContent: isToolEnabled(config, "getSearchContent"),
    },
    maxInlineContentChars: getMaxInlineContentChars(config),
    fetchModes: resolveFetchModeConfig(config),
  };
}

export function createDesktopWebToolCore(hooks: DesktopCoreHooks = {}): StandaloneWebToolCore {
  const settings = buildSettings(loadConfig());
  const storedIds: string[] = [];
  // The eviction list is per core, exactly as upstream keeps it: dropping a core
  // without clearing the module-level store orphans up to 50 page bodies.
  const remember = (id: string) => {
    storedIds.push(id);
    while (storedIds.length > MAX_STORED_RESULTS) deleteResult(storedIds.shift()!);
  };

  const modelRegistry = hooks.providerAuth
    ? { getProviderAuth: async (provider: string) => normalizeProviderAuth(await hooks.providerAuth!(provider)) }
    : undefined;

  const core = createWebToolCore({
    settings,
    storeFetchedContent(id, data: FetchedContentData) {
      storeResult(id, data);
      persistResult(id, data);
      remember(id);
    },
    // The core already stored the result; only the retention list and the disk
    // copy are missing here.
    publishResult(data: StoredSearchData) {
      remember(data.id);
      persistResult(data.id, data);
    },
    // No `extractOptions`: `rejectDirectImages` is the standalone guard, and the
    // desktop host returns images through the resizeImage shim instead.
    ...(hooks.answerFromPage
      ? {
          answerFromPage: (request: DesktopAnswerRequest, _context: unknown, signal?: AbortSignal) =>
            hooks.answerFromPage!(request, signal),
        }
      : {}),
  });

  return {
    enabledToolNames: (Object.keys(DEFAULT_TOOL_NAMES) as (keyof ToolNames)[])
      .filter((key) => settings.enabledTools[key])
      .map((key) => DEFAULT_TOOL_NAMES[key]),
    async webSearch(params, signal) {
      // A summary is decoration: if the model call throws, the results it would
      // have summarised still have to reach the caller.
      const call = hooks.summarize
        ? {
            summarize: async (results: QueryResultData[]) => {
              try {
                return await hooks.summarize!(results);
              } catch (error) {
                return fallbackSummary(toMessage(error));
              }
            },
          }
        : undefined;
      return markToolError(await core.webSearch(params, signal, call));
    },
    async fetchContent(params, signal) {
      // Only `extract` reaches the model registry; every other mode ignores it.
      const call = modelRegistry ? { extensionContext: { modelRegistry } as never } : undefined;
      return markToolError(await core.fetchContent(params, signal, call));
    },
    async getSearchContent(params, signal) {
      // A responseId from an earlier process is not in the in-memory store yet;
      // pull it back from disk before the unmodified lookup runs.
      const id = (params as { responseId?: unknown } | undefined)?.responseId;
      if (typeof id === "string" && id !== "" && !getResult(id) && hydrateResult(id)) remember(id);
      return markToolError(await core.getSearchContent(params, signal));
    },
    async sourceCheck(params, signal) {
      return markToolError(await core.sourceCheck(params, signal));
    },
  };
}
