#!/usr/bin/env node
// Acceptance criterion 6, second half: run the official devkit's `pi-plugin check`
// against this plugin.
//
// The devkit is not published to npm; it lives in the PI-Desktop repository as two
// workspace packages. This script sparse-clones just those two, builds them with
// tsc, and then runs the real CLI. Everything happens outside this repository.
//
//   node scripts/devkit-check.mjs
//
// Requires network access to GitHub and the npm registry (for typescript,
// @types/node and typebox).
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = "https://github.com/vastsa/PI-Desktop.git";
const workdir = mkdtempSync(join(tmpdir(), "pi-desktop-devkit-"));
const cloneDir = join(workdir, "PI-Desktop");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? workdir,
    encoding: "utf8",
    stdio: options.quiet ? "pipe" : "inherit",
    shell: options.shell ?? process.platform === "win32",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.status !== 0) {
    const detail = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().split(/\r?\n/).slice(-12).join("\n");
    throw new Error(`${command} ${args.join(" ")} failed (${result.status})${detail ? `\n${detail}` : ""}`);
  }
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

try {
  console.log("cloning PI-Desktop (sparse: plugin-devkit + plugin-sdk)…");
  run("git", ["clone", "--depth", "1", "--filter=blob:none", "--sparse", repo, cloneDir]);
  run("git", ["-C", cloneDir, "sparse-checkout", "set", "packages/plugin-devkit", "packages/plugin-sdk"]);

  console.log("installing build tooling…");
  // Install beside the workspace instead of inside it: the repository root
  // package.json uses pnpm's `workspace:*` protocol, which npm rejects.
  const tooling = join(cloneDir, ".tooling");
  mkdirSync(tooling, { recursive: true });
  writeFileSync(join(tooling, "package.json"), JSON.stringify({ name: "devkit-tooling", private: true }) + "\n");
  run("npm", ["install", "--no-audit", "--no-fund", "typescript@5.9.3", "@types/node@24", "typebox@1.3.27", "vitest@4.1.11"], {
    cwd: tooling,
  });
  renameSync(join(tooling, "node_modules"), join(cloneDir, "node_modules"));

  console.log("building plugin-sdk…");
  run("npx", ["tsc", "-p", join("packages", "plugin-sdk", "tsconfig.json")], { cwd: cloneDir });

  // plugin-devkit resolves @pi-desktop/plugin-sdk through node_modules; link the
  // freshly built package in instead of running a workspace install.
  const sdkSource = join(cloneDir, "packages", "plugin-sdk");
  const sdkTarget = join(cloneDir, "node_modules", "@pi-desktop", "plugin-sdk");
  mkdirSync(sdkTarget, { recursive: true });
  if (!existsSync(join(sdkSource, "dist", "index.js"))) throw new Error("plugin-sdk did not build a dist/index.js");
  cpSync(join(sdkSource, "dist"), join(sdkTarget, "dist"), { recursive: true });
  writeFileSync(
    join(sdkTarget, "package.json"),
    readFileSync(join(sdkSource, "package.json"), "utf8").replace('"private": true,', ""),
  );

  console.log("building plugin-devkit…");
  run("npx", ["tsc", "-p", join("packages", "plugin-devkit", "tsconfig.json")], { cwd: cloneDir });

  const cli = join(cloneDir, "packages", "plugin-devkit", "dist", "cli.js");
  if (!existsSync(cli)) throw new Error("plugin-devkit did not build a dist/cli.js");

  console.log(`running: pi-plugin check ${root}`);
  // No shell here: the node binary path contains spaces on Windows.
  const output = run(process.execPath, [cli, "check", root], { shell: false, quiet: true });
  console.log(output.trim());

  const blocking = /error/i.test(output) && !/0 error/i.test(output);
  if (/✖|blocking/i.test(output) || blocking) {
    console.error("devkit:check FAILED (the devkit reported blocking errors)");
    process.exit(1);
  }
  console.log("devkit:check OK");
} catch (error) {
  console.error(`devkit:check FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
} finally {
  rmSync(workdir, { recursive: true, force: true });
}
