// Stand-in for `@modelcontextprotocol/sdk/client/*` in the PI-Desktop build.
//
// `upstream/baizhi.ts` and `upstream/zai.ts` lazily import the MCP client to
// talk to their hosted search servers. Bundling that client pulls in `ajv`,
// `function-bind` and `get-intrinsic`, and each of them evaluates code built
// from strings (`new Function`). The plugin center's fail-closed audit refuses
// any package that carries such a construct, so the transport stays out of this
// build. Nothing else in the desktop adapter imports it.
//
// The stub keeps the module shape and fails loudly and precisely when one of
// those two providers is actually selected, instead of crashing the bundle or
// silently returning no results.
const MESSAGE =
  "Baizhi and Zai need the MCP client transport, which this build does not include. " +
  "Pick another search provider.";

export class McpClientUnavailableError extends Error {
  code: string;

  constructor(label: string) {
    super(`${label}: ${MESSAGE}`);
    this.name = "McpClientUnavailableError";
    this.code = "MCP_CLIENT_UNAVAILABLE";
  }
}

export class Client {
  constructor() {
    throw new McpClientUnavailableError("MCP client");
  }
}

export class StreamableHTTPClientTransport {
  constructor() {
    throw new McpClientUnavailableError("MCP transport");
  }
}
