// templates/agents/cloud-setup.sh, the setup script a cloud environment runs before Claude starts
// (templates/agents/README.md). It runs here in a temp folder of fake checkouts, with stand-ins for npm,
// pnpm, yarn and uv that log the folder they ran in and their arguments.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const SCRIPT = readFileSync(new URL("../templates/agents/cloud-setup.sh", import.meta.url), "utf8");
const README = readFileSync(new URL("../templates/agents/README.md", import.meta.url), "utf8");
const STUB = `#!/usr/bin/env bash
echo "$(basename "$PWD") $(basename "$0") $*" >> "$LOG"
[ "$(basename "$0")" != "$FAIL_TOOL" ]
`;

// Runs `script` in a temp folder holding `repos` ({name: [files]}, a .git entry makes a checkout).
// Returns the exit status, stdout plus stderr, and the stand-ins' log lines.
function run(repos, { script = SCRIPT, env = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cloud-setup-"));
  try {
    const work = join(dir, "work");
    const bin = join(dir, "bin");
    mkdirSync(work);
    mkdirSync(bin);
    for (const [name, files] of Object.entries(repos)) {
      mkdirSync(join(work, name));
      for (const file of files) writeFileSync(join(work, name, file), "");
    }
    for (const tool of ["npm", "pnpm", "yarn", "uv"]) {
      writeFileSync(join(bin, tool), STUB);
      chmodSync(join(bin, tool), 0o755);
    }
    writeFileSync(join(dir, "cloud-setup.sh"), script);
    const log = join(dir, "log");
    const r = spawnSync("bash", [join(dir, "cloud-setup.sh")], {
      cwd: work,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, LOG: log, FAIL_TOOL: "", ...env },
    });
    const lines = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
    return { status: r.status, out: r.stdout + r.stderr, lines };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the script fits the setup script box", () => {
  assert.equal(spawnSync("bash", ["-n", "-c", SCRIPT]).status, 0, "bash -n");
  assert.match(SCRIPT, /^#!\/usr\/bin\/env bash\n/);
  assert.match(SCRIPT, /^set -euo pipefail$/m);
  // A goal, not a documented limit (the docs allow 64 KB): short enough to paste into the environment editor, with Unix newlines.
  const lines = SCRIPT.trimEnd().split("\n");
  assert.ok(lines.length <= 100, `${lines.length} lines`);
  for (const line of lines) assert.ok(Buffer.byteLength(line) <= 200, line);
  assert.ok(!SCRIPT.includes("\r"));
});

test("every git checkout installs from its lockfile, with package scripts off", () => {
  const r = run({
    a: [".git", "package-lock.json", "uv.lock"],
    b: [".git", "pnpm-lock.yaml"],
    c: [".git", "yarn.lock"],
    d: [".git"],
    notes: ["package-lock.json"],
  });
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.lines, [
    "a npm ci --ignore-scripts --no-audit --no-fund",
    "a uv sync --frozen --no-install-project",
    "b pnpm install --frozen-lockfile --ignore-scripts",
    "c yarn install --frozen-lockfile --ignore-scripts",
  ]);
  assert.match(r.out, /cloud-setup: done, 4 repos/);
});

test("a folder with no checkout exits 0", () => {
  const r = run({});
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /done, 0 repos/);
});

test("a named repo the session did not clone is skipped, and the script exits 0", () => {
  const script = SCRIPT.replace(/^REPOS=\(\)$/m, "REPOS=(b missing)");
  assert.notEqual(script, SCRIPT, "REPOS=() line");
  const r = run({ a: [".git", "package-lock.json"], b: [".git", "pnpm-lock.yaml"] }, { script });
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.lines, ["b pnpm install --frozen-lockfile --ignore-scripts"]);
  assert.match(r.out, /missing is not cloned, skipped/);
});

test("a failed install stops the script with a non-zero exit, so the session shows the gap", () => {
  const r = run({ a: [".git", "package-lock.json"], b: [".git", "uv.lock"] }, { env: { FAIL_TOOL: "npm" } });
  assert.notEqual(r.status, 0);
  assert.deepEqual(r.lines, ["a npm ci --ignore-scripts --no-audit --no-fund"]);
  assert.doesNotMatch(r.out, /done/);
});

test("the script prints no variable's value", () => {
  const r = run({ a: [".git", "package-lock.json"] }, { env: { GH_TOKEN: "k3-canary-value" } });
  assert.equal(r.status, 0, r.out);
  assert.ok(!r.out.includes("k3-canary-value"));
});

test("the README draws environment, setup script, cache and session", () => {
  const section = README.split("## Cloud environment for workers")[1] ?? "";
  const chart = section.match(/```mermaid\n([\s\S]*?)```/)?.[1] ?? "";
  for (const piece of ["Environment", "Setup script", "Cache", "Session"]) assert.match(chart, new RegExp(piece));
  assert.match(section, /\]\(cloud-setup\.sh\)/);
});
