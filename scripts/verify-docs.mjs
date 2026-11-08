#!/usr/bin/env node
// Acceptance criterion 8: the deliverables that make this port reviewable are
// present and actually say the required things — install, configuration and keys,
// provider surface, permissions, the diff against upstream, and a replacement for
// every upstream capability that was not ported.
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** @type {{ file: string, contains: string[], label: string }[]} */
const REQUIREMENTS = [
  {
    file: "README.md",
    label: "README",
    contains: ["## 安装", "## 配置与密钥", "## 供应商支持面", "## 权限", "## 与上游的差异", "PORT-NOTES.md"],
  },
  {
    file: "docs/PORT-NOTES.md",
    label: "port notes",
    contains: [
      "## 为什么用原生适配层",
      "## 接缝映射",
      "## 能力对照",
      "## 上游用例子集怎么来的",
      "## 观察记录",
      "## 已知限制",
    ],
  },
  {
    file: "upstream/PATCHES.md",
    label: "patch whitelist",
    contains: ["| File | Reason |", "6dd57b7f5a0c3041053e65a28f5f425323ec95f9"],
  },
  {
    file: "LICENSE",
    label: "licence",
    contains: ["MIT License", "Nico Bailon", "pi-web-access"],
  },
  {
    file: "upstream.lock.json",
    label: "upstream lock",
    contains: ["6dd57b7f5a0c3041053e65a28f5f425323ec95f9", "\"files\""],
  },
];

const problems = [];
for (const requirement of REQUIREMENTS) {
  const absolute = join(root, requirement.file);
  let text;
  try {
    if (!statSync(absolute).isFile()) {
      problems.push(`${requirement.file} is not a file`);
      continue;
    }
    text = readFileSync(absolute, "utf8");
  } catch {
    problems.push(`${requirement.file} is missing`);
    continue;
  }
  for (const needle of requirement.contains) {
    if (!text.includes(needle)) problems.push(`${requirement.file} does not contain ${JSON.stringify(needle)}`);
  }
  console.log(`${requirement.label}: ${requirement.file} (${text.split(/\r?\n/).length} lines)`);
}

// Every capability row must explain itself — ported, replaced, or still
// unavailable — so the comparison table cannot rot into a bare list.
const portNotes = readFileSync(join(root, "docs", "PORT-NOTES.md"), "utf8");
const STATUS_PATTERN = /\| (已替代|部分替代|已启用|已启用（需凭据）|已启用（需打开开关）|参数已开放，未验证|未启用|不可用|不可达) \|/;
const capabilitySection = portNotes.split(/^## /m).find((part) => part.startsWith("能力对照")) ?? "";
const capabilityRows = capabilitySection.split(/\r?\n/).filter((line) => STATUS_PATTERN.test(line));
const unavailableRows = capabilityRows.filter((line) => /\| (未启用|不可用|不可达) \|/.test(line));
for (const row of capabilityRows) {
  const cells = row.split("|").map((cell) => cell.trim());
  const explanation = cells[3] ?? "";
  if (explanation.length < 15) problems.push(`capability row lacks an explanation: ${cells[1]}`);
}
console.log(`capability rows: ${capabilityRows.length}, still unavailable: ${unavailableRows.length}`);

if (problems.length > 0) {
  console.error(`differences: ${problems.length}`);
  for (const problem of problems) console.error(`  ${problem}`);
  console.error("verify:docs FAILED");
  process.exit(1);
}
console.log("verify:docs OK");
