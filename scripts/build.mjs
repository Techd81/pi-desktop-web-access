#!/usr/bin/env node
// Bundles the adapter plus every upstream module it imports into one CommonJS
// file. The plugin package ships no node_modules, so dependencies are inlined
// here; only node builtins stay external.
//
// The bundle lives in `build/`, never in `dist/`: the plugin devkit excludes a
// root `dist` directory from a packed `.piplug`, while `dist/` is where this
// repository puts the finished artifact.
//
// `main.js` must not require this bundle until it has pointed
// `PI_CODING_AGENT_DIR` at the plugin data directory: upstream resolves its
// config path once, when the bundle initialises.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = join(root, "build", "agent.cjs");

mkdirSync(join(root, "build"), { recursive: true });

const result = buildSync({
  entryPoints: [join(root, "src", "index.ts")],
  outfile,
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node20",
  logLevel: "warning",
  legalComments: "none",
  metafile: true,
  // Three specifiers are redirected to local shims:
  //
  // `upstream/extract.ts` dynamically imports `resizeImage` from the Pi SDK when
  // a fetched URL is an image. The desktop host does not ship that package, so
  // the specifier resolves to the local shim: without it the import rejects and
  // a direct image can never be returned. Every other use of that specifier in
  // `upstream/` is `import type`, erased before this alias is consulted.
  //
  // `upstream/baizhi.ts` and `upstream/zai.ts` lazily import the MCP client for
  // their hosted search servers. That client drags in `ajv` and two polyfills
  // that call `Function()`, which the plugin center's fail-closed audit refuses
  // in any shipped package, so the transport resolves to a stub that reports
  // both providers as unavailable in this build.
  //
  // `upstream/pdf-extract.ts` imports `promise.try` only to call `shim()` so the
  // PDF reader finds `Promise.try`. That package reaches `es-abstract`,
  // `call-bind` and `function-bind`, and the last two call `Function()` as well,
  // so it resolves to a local implementation of the same contract.
  alias: {
    "@earendil-works/pi-coding-agent": join(root, "src", "shims", "pi-coding-agent.ts"),
    "@modelcontextprotocol/sdk/client/index.js": join(root, "src", "shims", "mcp-client.ts"),
    "@modelcontextprotocol/sdk/client/streamableHttp.js": join(root, "src", "shims", "mcp-client.ts"),
    "promise.try": join(root, "src", "shims", "promise-try.ts"),
  },
});

const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
console.log(`built build/agent.cjs (${(bytes / 1024).toFixed(0)} KiB, ${Object.keys(result.metafile.inputs).length} inputs)`);
