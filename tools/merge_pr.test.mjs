// node --test tools/merge_pr.test.mjs: offline, a fake gh answers each call from an in-memory pull request and records every call.

import assert from "node:assert/strict";
import { test } from "node:test";
import { decide, judge, main } from "./merge_pr.mjs";

const SHA = "a".repeat(40);
const REPO = "acme/widget";
const ARGV = ["--repo", REPO, "--pr", "7", "--sha", SHA, "--followups", "none"];
const run = (id, name, status, conclusion, app = 1) => ({ id, name, status, conclusion, app: { id: app } });
const PASSING = [run(1, "ci / ci-ok", "completed", "success"), run(2, "dco", "completed", "success", 2)];

// Runs main against a fake repo: `pulls` is each read of the pull request in turn (the last repeats), `comments` the verdicts already posted.
async function merge(argv, { pulls, runs = PASSING, statuses = [], comments = [], fail } = {}) {
  const calls = [], sleeps = [], lines = [];
  const read = [...pulls];
  const gh = (args) => {
    calls.push(args.join(" "));
    if (fail && fail.test(args.join(" "))) throw new Error("HTTP 403");
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
  assert.equal(decide(pull(), ok, opts).act, "merge");
  const bad = [{ name: "build", state: "fail" }];
  for (const [p, checks, re] of [[pull({ draft: true }), ok, /draft/], [pull({ state: "closed", merged: true }), ok, /merged/], [pull({ base: { ref: "claude/parent" } }), ok, /base is claude\/parent, not main/], [pull({ head: { sha: "b".repeat(40) } }), ok, /head moved to bbbbbbb/], [pull(), [], /no checks/], [pull(), bad, /failed: build/], [pull({ mergeable: false }), ok, /conflicts/]]) assert.match(decide(p, checks, opts).why, re);
  assert.deepEqual(decide(pull(), [{ name: "build", state: "pending" }], opts).on, "checks");
});

const STATUS_WRITE = `api repos/${REPO}/statuses/${SHA} -f state=success -f context=review -f description=Review: MERGE`;
const MERGE_WRITE = `pr merge 7 --repo ${REPO} --squash --auto --match-head-commit ${SHA}`;

test("a clean pull request gets the verdict, the review status, then a squash merge pinned to the head", async () => {
  const r = await merge(ARGV, { pulls: [pull()], runs: [run(5, "ci / ci-ok", "completed", "cancelled"), run(9, "ci / ci-ok", "completed", "success")] });
  assert.equal(r.code, 0);
  assert.deepEqual(r.writes, [`api repos/${REPO}/issues/7/comments -f body=Review: MERGE at ${SHA}\nFollow-ups: none`, STATUS_WRITE, MERGE_WRITE]);
  assert.ok(!r.calls.some((c) => /--admin/.test(c)));
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
  assert.deepEqual(r.writes, [STATUS_WRITE, MERGE_WRITE]);
  for (const bad of [[], ["--repo", REPO, "--pr", "7", "--sha", "abc", "--followups", "none"], [...ARGV, "--auto"], [...ARGV, "--wait", "x"]]) assert.equal((await merge(bad, { pulls: [pull()] })).code, 2);
});

test("--followups is required, takes #n, PVTI_ ids or none, and lands on line 2 of the verdict", async () => {
  const bare = ARGV.slice(0, -2);
  const refused = await merge(bare, { pulls: [pull()] });
  assert.deepEqual([refused.code, refused.calls.length], [2, 0]);
  for (const bad of ["", "12", "#", "#1a", "PR_1", "none,#1", "#1;rm"]) assert.equal((await merge([...bare, "--followups", bad], { pulls: [pull()] })).code, 2, bad);
  const r = await merge([...bare, "--followups", "#12, PVTI_lADO-1"], { pulls: [pull()] });
  assert.equal(r.code, 0);
  const body = r.writes[0].split("-f body=")[1];
  assert.deepEqual(body.split("\n"), [`Review: MERGE at ${SHA}`, "Follow-ups: #12, PVTI_lADO-1"]);
});

test("an earlier review failure on the SHA does not gate the merge, and a failed status write sends no merge", async () => {
  const blocked = [{ context: "review", state: "failure" }];
  assert.equal((await merge(ARGV, { pulls: [pull()], statuses: blocked })).code, 0);
  const r = await merge(ARGV, { pulls: [pull()], fail: /statuses\/.* -f state=success/ });
  assert.equal(r.code, 1);
  assert.ok(!r.calls.some((c) => c.startsWith("pr merge")));
});
