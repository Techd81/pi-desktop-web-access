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
  // `upstream/extract.ts` dynamically imports `resizeImage` from the Pi SDK when
  // a fetched URL is an image. The desktop host does not ship that package, so
  // the specifier resolves to the local shim: without it the import rejects and
  // a direct image can never be returned. Every other use of that specifier in
  // `upstream/` is `import type`, erased before this alias is consulted.
  alias: {
    "@earendil-works/pi-coding-agent": join(root, "src", "shims", "pi-coding-agent.ts"),
  },
});

const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
console.log(`built build/agent.cjs (${(bytes / 1024).toFixed(0)} KiB, ${Object.keys(result.metafile.inputs).length} inputs)`);
