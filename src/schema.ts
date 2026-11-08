/**
 * Tool schemas the desktop host registers.
 *
 * Three of the four tools use upstream's MCP definitions byte for byte. Only
 * `fetch_content` is widened, because the MCP schema is the *narrowest* of
 * upstream's two surfaces: its header says Pi-only parameters are deliberately
 * not exposed. The underlying core (`upstream/web-tool-core.ts`) never lost
 * those parameters — `normalizeFetchContentParams` in `fetch-params.ts` reads
 * every one of them — so the only thing standing between the desktop agent and
 * `answer` / `extract` / authenticated fetches / video analysis was the schema
 * on this side.
 *
 * Widening happens here, in the adapter, by cloning upstream's own schema and
 * adding properties. `upstream/mcp-tool-definitions.ts` stays untouched, so
 * `verify-upstream` still reports 0 patches; the MCP server, if anyone runs it,
 * keeps its narrower contract.
 */
import { MCP_TOOL_DEFINITIONS, type McpToolDefinition } from "../upstream/mcp-tool-definitions.ts";

export { validateMcpToolArguments } from "../upstream/mcp-tool-definitions.ts";

export const FETCH_TOOL = "fetch_content";
export const SEARCH_TOOL = "web_search";

/** `web_search`'s one Pi-only parameter: it overrides the configured search model. */
const SEARCH_MODEL_DESCRIPTION =
  'Override the search model for this call as "provider/id" (for example "openai/gpt-4.1-mini"). Only providers that accept an override honour it.';

type JsonSchema = Record<string, unknown>;

function clone<T>(value: T): T {
  // The TypeBox objects upstream builds are plain JSON for every field the host
  // and `validateMcpToolArguments` read; the `[Kind]` symbol does not survive
  // JSON and is not consulted by `Value.Check`.
  return JSON.parse(JSON.stringify(value)) as T;
}

const MODE_DESCRIPTION = [
  "readable (default): extract readable content as markdown.",
  "raw: return the exact textual body using direct HTTP only.",
  "answer: answer `prompt` from the fetched page and return the answer instead of the page.",
  "extract: pull `fields` out of each fetched page.",
].join(" ");

const DESCRIPTION = [
  "Fetch web pages, PDFs, GitHub repos, images, and videos.",
  "Full content is stored for retrieval with get_search_content by responseId.",
].join(" ");

/** Properties the MCP schema omits; each maps to a parameter the core already accepts. */
const EXTRA_PROPERTIES: Record<string, JsonSchema> = {
  mode: {
    type: "string",
    enum: ["readable", "raw", "answer", "extract"],
    description: MODE_DESCRIPTION,
  },
  prompt: {
    type: "string",
    description: "answer: the question to answer from the page. Video analysis: the instruction for the frames.",
  },
  answerModel: {
    type: "string",
    description: 'answer: model as "provider/model-id". Defaults to the session model; requires mode answer.',
  },
  timestamp: {
    type: "string",
    description: 'Video: where to start, for example "90" or "1:30".',
  },
  frames: {
    type: "integer",
    minimum: 1,
    maximum: 12,
    description: "Video: frames to sample. Used when timestamp is set or frames is above 1.",
  },
  model: {
    type: "string",
    description: 'Video: model as "provider/model-id" used to analyse the sampled frames.',
  },
  auth: {
    anyOf: [{ type: "boolean" }, { type: "string" }],
    description:
      'Send browser cookies read from the named auth profile; true uses the default profile. Refused with mode answer or extract.',
  },
  redirects: {
    type: "string",
    enum: ["same-origin"],
    description: "Refuse a redirect that leaves the origin.",
  },
  fields: {
    type: "object",
    additionalProperties: { type: "string" },
    description:
      'extract: field name to type, where type is text, number, date, time, datetime, or duration. 1 to 16 fields; requires mode extract.',
  },
};

/**
 * Upstream's definitions with `fetch_content` widened. Every other tool is
 * returned as the same object upstream exports, so the host schema for
 * `web_search`, `get_search_content` and `source_check` is still byte-identical.
 */
export function buildToolDefinitions(): McpToolDefinition[] {
  return MCP_TOOL_DEFINITIONS.map((definition) => {
    if (definition.name === SEARCH_TOOL) {
      const schema = clone(definition.inputSchema) as JsonSchema & { properties?: Record<string, JsonSchema> };
      return {
        ...definition,
        inputSchema: {
          ...schema,
          properties: {
            ...(schema.properties ?? {}),
            model: { type: "string", description: SEARCH_MODEL_DESCRIPTION },
          },
        } as unknown as McpToolDefinition["inputSchema"],
      };
    }
    if (definition.name !== FETCH_TOOL) return definition;
    const schema = clone(definition.inputSchema) as JsonSchema & { properties?: Record<string, JsonSchema> };
    const properties: Record<string, JsonSchema> = { ...(schema.properties ?? {}) };
    for (const [name, property] of Object.entries(EXTRA_PROPERTIES)) properties[name] = property;
    return {
      ...definition,
      description: DESCRIPTION,
      inputSchema: { ...schema, properties } as unknown as McpToolDefinition["inputSchema"],
    };
  });
}

/** True when `mode` needs a page answer from the host model bridge. */
export function needsAnswerMode(args: unknown): boolean {
  return !!args && typeof args === "object" && (args as { mode?: unknown }).mode === "answer";
}
