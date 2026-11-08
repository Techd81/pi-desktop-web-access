#!/usr/bin/env node
// Acceptance criterion 3: run the upstream test cases that cover the modules this
// port actually reuses, and require zero failures.
//
// The curated list lives in scripts/upstream-tests.json. It was produced by
// running every upstream test file individually; the exclusion reasons are also
// listed there and explained in docs/PORT-NOTES.md. Nothing is silently skipped:
// the runner prints the excluded count and the categories.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

/**
 * Cases that fail only when this machine drops its first connection, and pass on
 * a retry — verified by running them alone (12/12) and by watching a bare `fetch`
 * time out in the same window. Anything else is a real failure and is never
 * retried; a retry is always printed, never hidden.
 */
const NETWORK_FLAKY = [/^not ok \d+ - proxied Request aborts a running curl request\b/];

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const upstream = join(root, "upstream");
const plan = JSON.parse(readFileSync(join(root, "scripts", "upstream-tests.json"), "utf8"));

// Absolute paths plus a throwaway working directory: some upstream cases write
// marker files relative to the CWD, and those must never land inside the
// vendored tree that `verify:upstream` hashes.
const files = plan.include.map((file) => join(upstream, "test", file));
const isolate = pathToFileURL(join(upstream, "test", "isolate-env.mjs")).href;
if (files.length === 0) {
  console.error("upstream-tests.json has no included files");
  process.exit(1);
}

function runOnce() {
  const workdir = mkdtempSync(join(tmpdir(), "pi-web-access-upstream-"));
  const run = spawnSync(
    process.execPath,
    ["--import", isolate, "--test", "--test-reporter=tap", ...files],
    { cwd: workdir, encoding: "utf8", timeout: 30 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 },
  );
  rmSync(workdir, { recursive: true, force: true });
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  const number = (pattern) => {
    const match = pattern.exec(output);
    return match ? Number(match[1]) : null;
  };
  const failing = output
    .split(/\r?\n/)
    .filter((line) => /^not ok \d+ - /.test(line) && !/# SKIP\b/.test(line));
  const reported = number(/^# fail (\d+)$/m);
  return {
    status: run.status,
    tests: number(/^# tests (\d+)$/m),
    pass: number(/^# pass (\d+)$/m),
    // Trust whichever count is larger: a truncated or killed run can lose the TAP
    // summary while still printing its `not ok` lines, and the summary must never
    // under-report a failure.
    fail: Math.max(reported ?? 0, failing.length),
    skipped: number(/^# skipped (\d+)$/m),
    failing,
  };
}

const started = Date.now();
let result = runOnce();
let retried = false;

if (
  result.status !== 0 &&
  result.failing.length > 0 &&
  result.failing.every((line) => NETWORK_FLAKY.some((pattern) => pattern.test(line)))
) {
  retried = true;
  console.log(`retrying once: ${result.failing.length} case(s) that only fail when the first connection is dropped`);
  result = runOnce();
}

const show = (value) => (value === null ? "?" : value);
console.log(`upstream files run: ${files.length}`);
console.log(`upstream tests: ${show(result.tests)} (pass ${show(result.pass)}, fail ${show(result.fail)}, skipped ${show(result.skipped)})`);
console.log(`excluded upstream files: ${plan.exclude.length}`);
const byReason = new Map();
for (const entry of plan.exclude) {
  const key = entry.reason.split(";")[0].slice(0, 70);
  byReason.set(key, (byReason.get(key) ?? 0) + 1);
}
for (const [reason, count] of [...byReason.entries()].sort((left, right) => right[1] - left[1])) {
  console.log(`  ${count.toString().padStart(3)} × ${reason}`);
}
console.log(`duration: ${((Date.now() - started) / 1000).toFixed(1)}s${retried ? " (one retry)" : ""}`);

if (result.status !== 0 || result.fail !== 0) {
  for (const line of result.failing.slice(0, 25)) console.error(`  ${line}`);
  if (result.failing.length === 0) console.error(`  exit ${result.status} with no parseable failure lines`);
  console.error("test:upstream FAILED");
  process.exit(1);
}
console.log("test:upstream OK (# fail 0)");
