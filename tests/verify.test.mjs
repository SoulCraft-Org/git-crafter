// tools/verify.sh stops at its first failing command (issue #70). It runs
// verify.sh with stand-ins for node and python3 that count their calls and
// fail on the nth, for every n a clean run reaches, and expects verify to
// exit non-zero right there, never printing "verify: ok". A seeded script
// with the old `a && b` line must fail this check, so the check can tell.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const VERIFY = readFileSync(new URL("../tools/verify.sh", import.meta.url), "utf8");
const STUB = `#!/usr/bin/env bash
n=$(( $(cat "$CALLS" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$CALLS"
if [ "$n" = "$FAIL_AT" ]; then exit 1; fi
exit 0
`;

// Runs `script` as tools/verify.sh in a temp tree, failing call `failAt`
// (0: none). Returns its exit status, whether it printed "verify: ok", and
// how many stand-in calls it made.
function run(script, failAt) {
  const dir = mkdtempSync(join(tmpdir(), "verify-"));
  try {
    mkdirSync(join(dir, "tools"));
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "tools", "verify.sh"), script);
    for (const name of ["node", "python3"]) {
      writeFileSync(join(dir, "bin", name), STUB);
      chmodSync(join(dir, "bin", name), 0o755);
    }
    const calls = join(dir, "calls");
    const r = spawnSync("bash", [join(dir, "tools", "verify.sh")], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}`, CALLS: calls, FAIL_AT: String(failAt) },
    });
    return { status: r.status, ok: r.stdout.includes("verify: ok"), calls: existsSync(calls) ? Number(readFileSync(calls, "utf8")) : 0 };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Every call a clean run makes, failed in turn: the ones verify ran past.
function leaks(script) {
  const clean = run(script, 0);
  assert.equal(clean.status, 0, "a clean run passes");
  assert.ok(clean.ok && clean.calls > 0, "a clean run reaches verify: ok");
  const out = [];
  for (let n = 1; n <= clean.calls; n++) {
    const r = run(script, n);
    if (r.status === 0 || r.ok || r.calls !== n) out.push(n);
  }
  return out;
}

test("a seeded `a && b` line runs past its failing first command", () => {
  const bad = "#!/usr/bin/env bash\nset -euo pipefail\ncd \"$(dirname \"$0\")/..\"\necho \"== x\"; node a && node b\necho \"== y\"; python3 c\necho \"verify: ok\"\n";
  assert.deepEqual(leaks(bad), [1], "the old pattern hides a failing first command");
});

test("verify.sh stops at every failing command", () => {
  assert.deepEqual(leaks(VERIFY), []);
});

// tools/private_paths.sh on a seeded checkout: it names only the org's own files.
test("private_paths.sh names data/ but data/quality/ less local.json, history/ and plan-usage.json, the org config, accounts and the term list", () => {
  const dir = mkdtempSync(join(tmpdir(), "private-"));
  try {
    const repo = join(dir, "repo");
    const files = {
      "README.md": "x",
      ".gitignore": readFileSync(new URL("../.gitignore", import.meta.url), "utf8"),
      "tools/private_paths.sh": readFileSync(new URL("../tools/private_paths.sh", import.meta.url), "utf8"),
      "data/org.json": "{}",
      "data/history/d.json": "{}",
      "data/quality/local.json": "{}",
      "data/quality/plan-usage.json": "{}",
      "data/quality/run.json": "{}",
      "tools/bash_guard_cases.json": '["sudo -u acme -H x"]',
      "tools/bash_guard_rules.json": '["sudo -u acme -H x"]',
      "data/quality/history/2026-11-05.json": "{}",
      "config/quality.json": "{}",
      "config/quality/targets/a.json": '{ "org": "nested is kept" }',
      "config/acme.json": '{\n "org": "Acme"\n}',
      "config/accounts/a.json": "{}",
      "config/private-terms.txt": "Acme",
    };
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(join(repo, rel, ".."), { recursive: true });
      writeFileSync(join(repo, rel), text);
    }
    writeFileSync(join(repo, "untracked.md"), "x");
    const git = (...args) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    git("init", "-q");
    git("add", "-f", ...Object.keys(files));
    const check = spawnSync("bash", [join(repo, "tools", "private_paths.sh")], { encoding: "utf8" });
    assert.equal(check.status, 1, "it fails on a tracked private path");
    const named = [...check.stderr.matchAll(/tracked: (\S+)/g)].map((m) => m[1]).sort();
    assert.deepEqual(named, ["config/accounts/a.json", "config/acme.json", "config/private-terms.txt", "data/history/d.json", "data/org.json", "data/quality/history/2026-11-05.json", "data/quality/local.json", "data/quality/plan-usage.json"]);
    git("rm", "-q", "--cached", ...named);
    assert.equal(spawnSync("bash", [join(repo, "tools", "private_paths.sh")]).status, 0, "it passes once none is tracked");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// This repo is public: verify fails when it tracks a private path, and .gitignore keeps the local ones out.
test("this repo tracks no private path, and git ignores the local data files", () => {
  const root = new URL("..", import.meta.url).pathname;
  const r = spawnSync("bash", [join(root, "tools", "private_paths.sh")], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const local = ["data/org.json", "data/history/d.json", "data/quality/local.json", "data/quality/plan-usage.json", "data/quality/history/d.json", "config/accounts/a.json", "config/private-terms.txt"];
  const ignored = spawnSync("git", ["-C", root, "check-ignore", "--no-index", ...local], { encoding: "utf8" }).stdout.trim().split("\n");
  assert.deepEqual(ignored, local);
  const kept = spawnSync("git", ["-C", root, "check-ignore", "--no-index", "data/quality/run.json"], { encoding: "utf8" });
  assert.equal(kept.status, 1, "the rest of data/quality/ is not ignored");
});
