/**
 * PI-Desktop adapter for the upstream web tools.
 *
 * Everything that decides *what a tool does* lives upstream and is imported
 * verbatim: `createStandaloneWebToolCore()` is upstream's own host for
 * environments without the Pi coding agent (it powers the MCP server today).
 * This module only re-expresses that core as PI-Desktop tool descriptors and
 * re-implements upstream's provider-availability aggregate without the
 * `ExtensionContext` a desktop plugin does not have.
 *
 * The upstream Pi shell (`index.ts`) is deliberately not imported: it depends on
 * `@earendil-works/pi-tui` and on Pi-only surfaces (widgets, shortcuts,
 * `sendMessage`, `appendEntry`, `sessionManager`) that the desktop host does not
 * provide. See docs/PORT-NOTES.md.
 */

import {
  DEFAULT_TOOL_NAMES,
  WEB_SEARCH_CONFIG_PATH,
  getMaxInlineContentChars,
  isToolEnabled,
  loadConfig,
  resolveFetchModeConfig,
  type StandaloneWebToolCore,
  type ToolNames,
  type WebSearchConfig,
} from "../upstream/web-tool-core.ts";
import { createDesktopWebToolCore, type DesktopAnswerRequest, type DesktopCoreHooks } from "./core.ts";
import { buildToolDefinitions } from "./schema.ts";
import { clearResults } from "../upstream/storage.ts";
import {
  MCP_TOOL_DEFINITIONS,
  validateMcpToolArguments,
} from "../upstream/mcp-tool-definitions.ts";
import {
  ALL_SEARCH_PROVIDERS,
  RESOLVED_SEARCH_PROVIDERS,
  getAllowedSearchProviders,
  type ProviderAvailability,
  type ResolvedSearchProvider,
} from "../upstream/gemini-search.ts";

// Availability probes, in the same set upstream's Pi shell uses. Each reads the
// config file or the environment only; the three that accepted an
// `ExtensionContext` are called without one, exactly like upstream's MCP host.
import { isAnySearchAvailable } from "../upstream/anysearch.ts";
import { isBochaAvailable } from "../upstream/bocha.ts";
import { isBraveAvailable } from "../upstream/brave.ts";
import { isBrightDataAvailable } from "../upstream/brightdata.ts";
import { isCeramicAvailable } from "../upstream/ceramic.ts";
import { isCloroAvailable } from "../upstream/cloro.ts";
import { isCloudflareSearchAvailable } from "../upstream/cloudflare-search.ts";
import { isDeepSeekAvailable } from "../upstream/deepseek.ts";
import { isDegoogAvailable } from "../upstream/degoog.ts";
import { isDuckDuckGoAvailable } from "../upstream/duckduckgo.ts";
import { isExaAvailable } from "../upstream/exa.ts";
import { isFirecrawlAvailable } from "../upstream/firecrawl.ts";
import { isGeminiApiAvailable } from "../upstream/gemini-api.ts";
import { isGeminiWebAvailable } from "../upstream/gemini-web.ts";
import { isJinaSearchAvailable } from "../upstream/jina-search.ts";
import { isKagiAvailable } from "../upstream/kagi.ts";
import { isKeenableAvailable } from "../upstream/keenable.ts";
import { isKimiSearchAvailable } from "../upstream/kimi-search.ts";
import { isLinkupAvailable } from "../upstream/linkup.ts";
import { isMistralAvailable } from "../upstream/mistral-search.ts";
import { isNineRouterAvailable } from "../upstream/ninerouter.ts";
import { isOllamaAvailable } from "../upstream/ollama.ts";
import { isOpenAISearchAvailable } from "../upstream/openai-search.ts";
import { isOutcrawlAvailable } from "../upstream/outcrawl.ts";
import { isParallelMcpAvailable } from "../upstream/parallel-mcp.ts";
import { isParallelAvailable } from "../upstream/parallel.ts";
import { isPerplexityAvailable } from "../upstream/perplexity.ts";
import { isQueritAvailable } from "../upstream/querit.ts";
import { isSearch1APIAvailable } from "../upstream/search1api.ts";
import { isSearchApiAvailable } from "../upstream/searchapi.ts";
import { isSearchinfinityAvailable } from "../upstream/searchinfinity.ts";
import { isSearXNGAvailable } from "../upstream/searxng.ts";
import { isSerpApiAvailable } from "../upstream/serpapi.ts";
import { isSerpBaseAvailable } from "../upstream/serpbase.ts";
import { isSerpdiveAvailable } from "../upstream/serpdive.ts";
import { isSerperAvailable } from "../upstream/serper.ts";
import { isSerplyAvailable } from "../upstream/serply.ts";
import { isSofyaAvailable } from "../upstream/sofya.ts";
import { isTabstackAvailable } from "../upstream/tabstack.ts";
import { isTavilyAvailable } from "../upstream/tavily.ts";
import { isTinyFishAvailable } from "../upstream/tinyfish.ts";
import { isValyuAvailable } from "../upstream/valyu.ts";
import { isXaiSearchAvailable } from "../upstream/xai-search.ts";
import { isXcrawlAvailable } from "../upstream/xcrawl.ts";
import { isYouAvailable } from "../upstream/you.ts";

export type ToolRisk = "low" | "medium" | "high";

export interface AgentToolContext {
  signal?: AbortSignal;
  log?: (message: string) => void;
}

export interface AgentToolDescriptor {
  name: string;
  description: string;
  risk: ToolRisk;
  schema: unknown;
  execute(args: Record<string, unknown>, context?: AgentToolContext): Promise<unknown>;
}

export interface AgentToolsStatus {
  configPath: string;
  enabledTools: string[];
  toolNames: ToolNames;
  fetchModes: { defaultMode: string; allowedModes: string[] };
  maxInlineContentChars: number;
  allowedProviders: string[];
  resolvedProviders: readonly string[];
}

export interface AgentToolsHandle {
  /** Descriptors in upstream declaration order. */
  tools: AgentToolDescriptor[];
  /** Names the current config enables; upstream hides a disabled tool entirely. */
  enabledToolNames: () => string[];
  /** Merged config view for the panel and the status log. */
  describe: () => AgentToolsStatus;
  availability: () => Promise<ProviderAvailability>;
  /** Rebuilds the core so a config edit takes effect; stored results are dropped. */
  reload: () => void;
}

/** Resolved when the bundle initialises, which is after main.js set the env. */
const CONFIG_PATH = WEB_SEARCH_CONFIG_PATH;

/** Network tools read the open web, so they are not marked `low`. */
const RISK_BY_TOOL: Readonly<Record<string, ToolRisk>> = {
  [DEFAULT_TOOL_NAMES.getSearchContent]: "low",
  [DEFAULT_TOOL_NAMES.webSearch]: "medium",
  [DEFAULT_TOOL_NAMES.fetchContent]: "medium",
  [DEFAULT_TOOL_NAMES.sourceCheck]: "medium",
};

function errorResult(message: string) {
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    details: { error: message },
    isError: true,
  };
}

function enabledNames(config: WebSearchConfig): string[] {
  return (Object.keys(DEFAULT_TOOL_NAMES) as (keyof ToolNames)[])
    .filter((key) => isToolEnabled(config, key))
    .map((key) => DEFAULT_TOOL_NAMES[key]);
}

function callCore(core: StandaloneWebToolCore, name: string, args: Record<string, unknown>, signal?: AbortSignal) {
  switch (name) {
    case DEFAULT_TOOL_NAMES.webSearch:
      return core.webSearch(args as never, signal);
    case DEFAULT_TOOL_NAMES.fetchContent:
      return core.fetchContent(args as never, signal);
    case DEFAULT_TOOL_NAMES.getSearchContent:
      return core.getSearchContent(args as never, signal);
    case DEFAULT_TOOL_NAMES.sourceCheck:
      return core.sourceCheck(args as never, signal);
    default:
      return Promise.resolve(errorResult(`unknown tool "${name}"`));
  }
}

export interface AgentToolsOptions {
  log?: (message: string) => void;
  /**
   * Runs `fetch_content mode: "answer"`. Supplied by `main.js`, which is the only
   * place that can reach `pi.agent.complete`; without it an answer call reports
   * that this host cannot answer, exactly like upstream's MCP host.
   */
  answerFromPage?: (request: DesktopAnswerRequest, signal?: AbortSignal) => Promise<{ text: string }>;
  /**
   * Supplies the Cloudflare credential `extract` mode reads. `main.js` builds it
   * from the plugin's stored settings and the process environment.
   */
  providerAuth?: (provider: string) => Promise<{ apiKey?: string; env?: Record<string, string | undefined> } | undefined>;
  /**
   * Auto-summary after a search. Supplied by `main.js`, which decides whether the
   * setting is on and reaches `pi.agent.complete`.
   */
  summarize?: DesktopCoreHooks["summarize"];
}

/**
 * Builds the descriptor list once; `execute` closes over a mutable core so a
 * config reload swaps the core without re-registering tools.
 */
export function createAgentTools(options: AgentToolsOptions = {}): AgentToolsHandle {
  const log = options.log ?? (() => {});
  const hooks: DesktopCoreHooks = {};
  if (options.answerFromPage) hooks.answerFromPage = options.answerFromPage;
  if (options.providerAuth) hooks.providerAuth = options.providerAuth;
  if (options.summarize) hooks.summarize = options.summarize;
  let core = createDesktopWebToolCore(hooks);

  const descriptors: AgentToolDescriptor[] = buildToolDefinitions().map((definition) => ({
    name: definition.name,
    description: definition.description,
    risk: RISK_BY_TOOL[definition.name] ?? "medium",
    schema: definition.inputSchema,
    async execute(args, context) {
      const input = args && typeof args === "object" ? args : {};
      const problems = validateMcpToolArguments(definition, input);
      if (problems.length > 0) {
        log(`${definition.name}: rejected arguments (${problems.length})`);
        return errorResult(problems.join("; "));
      }
      try {
        return await callCore(core, definition.name, input as Record<string, unknown>, context?.signal);
      } catch (error) {
        // A thrown tool would surface as a plugin failure; upstream's own MCP host
        // turns the same rejection into an isError result so the model sees why.
        const message = error instanceof Error ? error.message : String(error);
        log(`${definition.name}: ${message}`);
        return errorResult(message);
      }
    },
  }));

  return {
    tools: descriptors,
    enabledToolNames() {
      return enabledNames(loadConfig());
    },
    describe() {
      const config = loadConfig();
      return {
        configPath: CONFIG_PATH,
        enabledTools: enabledNames(config),
        toolNames: DEFAULT_TOOL_NAMES,
        fetchModes: resolveFetchModeConfig(config),
        maxInlineContentChars: getMaxInlineContentChars(config),
        allowedProviders: [...getAllowedSearchProviders()],
        resolvedProviders: RESOLVED_SEARCH_PROVIDERS,
      };
    },
    availability: () => getProviderAvailability(),
    reload() {
      // Each core keeps its own eviction list; dropping that list without clearing
      // the module-level store would orphan up to 50 full page bodies per reload.
      clearResults();
      core = createDesktopWebToolCore(hooks);
    },
  };
}

/** Mirrors upstream's `getProviderAvailability`, including its browser-cookie
 * probe: a browser login counts as Gemini availability, and the probe reads
 * nothing unless `allowBrowserCookies` is on. */
async function getProviderAvailability(): Promise<ProviderAvailability> {
  const allowed = new Set(getAllowedSearchProviders());
  const has = (provider: ResolvedSearchProvider) => allowed.has(provider);
  const probe = async <T>(run: () => T | Promise<T>, fallback: T): Promise<T> => {
    try {
      return await run();
    } catch {
      return fallback;
    }
  };

  const geminiApi = has("gemini") && await probe(() => isGeminiApiAvailable(), false);
  // A browser login counts too, exactly as upstream counts it. The probe returns
  // null before touching any cookie unless `allowBrowserCookies` is enabled.
  const geminiWeb = has("gemini") && (await probe(() => isGeminiWebAvailable(), null)) !== null;
  const providers: Record<ResolvedSearchProvider, boolean> = {
    openai: has("openai") && await probe(() => isOpenAISearchAvailable(undefined), false),
    brave: has("brave") && await probe(() => isBraveAvailable(), false),
    parallel: has("parallel") && await probe(() => isParallelAvailable(), false),
    "parallel-mcp": has("parallel-mcp") && await probe(() => isParallelMcpAvailable(), false),
    tinyfish: has("tinyfish") && await probe(() => isTinyFishAvailable(), false),
    search1api: has("search1api") && await probe(() => isSearch1APIAvailable(), false),
    searchinfinity: has("searchinfinity") && await probe(() => isSearchinfinityAvailable(), false),
    querit: has("querit") && await probe(() => isQueritAvailable(), false),
    tavily: has("tavily") && await probe(() => isTavilyAvailable(), false),
    you: has("you") && await probe(() => isYouAvailable(), false),
    firecrawl: has("firecrawl") && await probe(() => isFirecrawlAvailable(), false),
    jina: has("jina") && await probe(() => isJinaSearchAvailable(), false),
    searxng: has("searxng") && await probe(() => isSearXNGAvailable(), false),
    degoog: has("degoog") && await probe(() => isDegoogAvailable(), false),
    duckduckgo: has("duckduckgo") && await probe(() => isDuckDuckGoAvailable(), false),
    perplexity: has("perplexity") && await probe(() => isPerplexityAvailable(), false),
    gemini: geminiApi || geminiWeb,
    kimi: has("kimi") && await probe(() => isKimiSearchAvailable(undefined), false),
    exa: has("exa") && await probe(() => isExaAvailable(), false),
    serpdive: has("serpdive") && await probe(() => isSerpdiveAvailable(), false),
    kagi: has("kagi") && await probe(() => isKagiAvailable(), false),
    ollama: has("ollama") && await probe(() => isOllamaAvailable(), false),
    anysearch: has("anysearch") && await probe(() => isAnySearchAvailable(), false),
    xai: has("xai") && await probe(() => isXaiSearchAvailable(undefined), false),
    mistral: has("mistral") && await probe(() => isMistralAvailable(), false),
    brightdata: has("brightdata") && await probe(() => isBrightDataAvailable(), false),
    serpbase: has("serpbase") && await probe(() => isSerpBaseAvailable(), false),
    serpapi: has("serpapi") && await probe(() => isSerpApiAvailable(), false),
    serper: has("serper") && await probe(() => isSerperAvailable(), false),
    serply: has("serply") && await probe(() => isSerplyAvailable(), false),
    valyu: has("valyu") && await probe(() => isValyuAvailable(), false),
    bocha: has("bocha") && await probe(() => isBochaAvailable(), false),
    xcrawl: has("xcrawl") && await probe(() => isXcrawlAvailable(), false),
    // `baizhi` and `zai` reach their hosted servers through the MCP client
    // transport, which this build replaces with a stub so the package carries no
    // `new Function` (see `src/shims/mcp-client.ts`). Their API-key probes would
    // answer "configured" although every search throws, so both report
    // unavailable here and the panel matches what a call actually does.
    baizhi: false,
    zai: false,
    keenable: has("keenable") && await probe(() => isKeenableAvailable(), false),
    ceramic: has("ceramic") && await probe(() => isCeramicAvailable(), false),
    deepseek: has("deepseek") && await probe(() => isDeepSeekAvailable(), false),
    linkup: has("linkup") && await probe(() => isLinkupAvailable(), false),
    ninerouter: has("ninerouter") && await probe(() => isNineRouterAvailable(), false),
    cloudflare: has("cloudflare") && await probe(() => isCloudflareSearchAvailable(), false),
    searchapi: has("searchapi") && await probe(() => isSearchApiAvailable(), false),
    outcrawl: has("outcrawl") && await probe(() => isOutcrawlAvailable(), false),
    sofya: has("sofya") && await probe(() => isSofyaAvailable(), false),
    cloro: has("cloro") && await probe(() => isCloroAvailable(), false),
    tabstack: has("tabstack") && await probe(() => isTabstackAvailable(), false),
  };

  return {
    all: ALL_SEARCH_PROVIDERS.some((provider) =>
      provider === "gemini" ? geminiApi || geminiWeb : provider === "auto" ? false : providers[provider as ResolvedSearchProvider],
    ),
    ...providers,
  };
}

export { MCP_TOOL_DEFINITIONS, DEFAULT_TOOL_NAMES, RESOLVED_SEARCH_PROVIDERS };
export { getGeminiWebAvailabilityDiagnostic } from "../upstream/gemini-web.ts";
