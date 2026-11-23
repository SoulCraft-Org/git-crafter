// node --test tools/merge_pr.test.mjs
// Offline: a fake gh answers each call from an in-memory pull request and records every call.

import assert from "node:assert/strict";
import { test } from "node:test";
import { decide, judge, main } from "./merge_pr.mjs";

const SHA = "a".repeat(40);
const REPO = "acme/widget";
const ARGV = ["--repo", REPO, "--pr", "7", "--sha", SHA];
const run = (id, name, status, conclusion, app = 1) => ({ id, name, status, conclusion, app: { id: app } });
const PASSING = [run(1, "ci / ci-ok", "completed", "success"), run(2, "dco", "completed", "success", 2)];

// Runs main against a fake repo: `pulls` is each read of the pull request in turn (the last repeats), `comments` the verdicts already posted.
async function merge(argv, { pulls, runs = PASSING, statuses = [], comments = [] } = {}) {
  const calls = [], sleeps = [], lines = [];
  const read = [...pulls];
  const gh = (args) => {
    calls.push(args.join(" "));
    const route = args[1];
    if (route.includes("/pulls/")) return JSON.stringify(read.length > 1 ? read.shift() : read[0]);
    if (route.includes("/check-runs")) return JSON.stringify({ total_count: runs.length, check_runs: runs });
    if (route.includes("/status")) return JSON.stringify({ total_count: statuses.length, statuses });
    return args[0] === "api" && args.includes("--paginate") ? comments.join("\n") : "";
  };
  const code = await main(argv, { run: gh, sleep: async (ms) => sleeps.push(ms), log: (l) => lines.push(l), error: (l) => lines.push(l) });
  const writes = calls.filter((c) => c.includes(" -f ") || c.startsWith("pr merge"));
  return { code, calls, sleeps, lines, writes };
}

const pull = (over = {}) => ({ state: "open", draft: false, merged: false, mergeable: true, base: { ref: "main" }, head: { sha: SHA }, ...over });

test("judge reads each check's latest run: a cancelled run beside a newer pass is no failure", () => {
  const checks = judge([run(5, "ci / ci-ok", "completed", "cancelled"), run(9, "ci / ci-ok", "completed", "success"), run(3, "build", "completed", "success"), run(4, "build", "completed", "failure")], []);
  assert.deepEqual(Object.fromEntries(checks.map((c) => [c.name, c.state])), { "ci / ci-ok": "pass", build: "fail" });
  assert.equal(judge([run(1, "x", "in_progress", null)], [])[0].state, "pending");
  assert.deepEqual(judge([], [{ context: "legacy", state: "error" }, { context: "dco", state: "success" }]).map((c) => c.state), ["fail", "pass"]);
});

test("decide refuses a draft, a closed pull request, a stacked base, a moved head, no checks and a failed check", () => {
  const ok = [{ name: "ci", state: "pass" }];
  const opts = { sha: SHA, base: "main" };
  const why = (p, checks = ok) => decide(p, checks, opts);
  assert.equal(why(pull()).act, "merge");
  assert.match(why(pull({ draft: true })).why, /draft/);
  assert.match(why(pull({ state: "closed", merged: true })).why, /merged/);
  assert.match(why(pull({ base: { ref: "claude/parent" } })).why, /base is claude\/parent, not main/);
  assert.match(why(pull({ head: { sha: "b".repeat(40) } })).why, /head moved to bbbbbbb/);
  assert.match(why(pull(), []).why, /no checks/);
  assert.match(why(pull(), [{ name: "build", state: "fail" }]).why, /failed: build/);
  assert.match(why(pull({ mergeable: false })).why, /conflicts/);
  assert.deepEqual(why(pull(), [{ name: "build", state: "pending" }]).on, "checks");
});

test("a clean pull request gets the verdict, then a squash merge pinned to the head", async () => {
  const r = await merge(ARGV, { pulls: [pull()], runs: [run(5, "ci / ci-ok", "completed", "cancelled"), run(9, "ci / ci-ok", "completed", "success")] });
  assert.equal(r.code, 0);
  assert.deepEqual(r.writes, [`api repos/${REPO}/issues/7/comments -f body=Review: MERGE at ${SHA}`, `pr merge 7 --repo ${REPO} --squash --match-head-commit ${SHA}`]);
  assert.ok(!r.calls.some((c) => /--auto|--admin/.test(c)));
});

test("mergeable UNKNOWN is read again until it settles, and gives up after --wait", async () => {
  const unknown = pull({ mergeable: null });
  const settled = await merge(ARGV, { pulls: [unknown, unknown, pull()] });
  assert.equal(settled.code, 0);
  assert.deepEqual(settled.sleeps, [5000, 5000]);
  const stuck = await merge([...ARGV, "--wait", "10"], { pulls: [unknown] });
  assert.equal(stuck.code, 3);
  assert.deepEqual([stuck.sleeps.length, stuck.writes], [2, []]);
});

test("a base other than main, a moved head and a failed latest run stop before any write", async () => {
  for (const [name, options] of [["base", { pulls: [pull({ base: { ref: "claude/parent" } })] }], ["head", { pulls: [pull({ head: { sha: "b".repeat(40) } })] }], ["check", { pulls: [pull()], runs: [run(1, "ci", "completed", "failure")] }]]) {
    const r = await merge(ARGV, options);
    assert.deepEqual([name, r.code, r.writes], [name, 1, []]);
  }
});

test("pending checks exit 3 and --check writes nothing", async () => {
  assert.equal((await merge(ARGV, { pulls: [pull()], runs: [run(1, "ci", "in_progress", null)] })).code, 3);
  const r = await merge([...ARGV, "--check"], { pulls: [pull()] });
  assert.deepEqual([r.code, r.writes], [0, []]);
});

test("a verdict already posted is not posted again, and bad arguments exit 2", async () => {
  const r = await merge(ARGV, { pulls: [pull()], comments: [`Review: MERGE at ${SHA}`] });
  assert.deepEqual(r.writes, [`pr merge 7 --repo ${REPO} --squash --match-head-commit ${SHA}`]);
  for (const bad of [[], ["--repo", REPO, "--pr", "7", "--sha", "abc"], [...ARGV, "--auto"], [...ARGV, "--wait", "x"]]) assert.equal((await merge(bad, { pulls: [pull()] })).code, 2);
});
