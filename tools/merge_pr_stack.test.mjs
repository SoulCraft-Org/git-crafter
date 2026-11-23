// node --test tools/merge_pr_stack.test.mjs
// Offline: a fake gh answers each call from an in-memory stack of two pull requests and records every write.

import assert from "node:assert/strict";
import { test } from "node:test";
import { main } from "./merge_pr_stack.mjs";

const REPO = "acme/widget";
const SHA = { 7: "a".repeat(40), 8: "b".repeat(40) };
const ARGV = ["--repo", REPO, "--prs", `7:${SHA[7]},8:${SHA[8]}`];
const PASS = [{ id: 1, name: "ci / ci-ok", status: "completed", conclusion: "success", app: { id: 1 } }];
const pr = (n, base, head) => ({ state: "open", draft: false, merged: false, mergeable: true, base: { ref: base }, head: { ref: head, sha: SHA[n] } });
const STACKED = { 7: pr(7, "main", "claude/one"), 8: pr(8, "claude/one", "claude/two") };
const stack = (...numbers) => ({ open: true, pull_requests: numbers.map((number) => ({ number })) });

// Runs main against a fake repo. `mergedAfter` is how many reads of the top pull request pass before the merge shows.
async function merge(argv, { pulls = STACKED, runs = PASS, stacks = [], mergedAfter = 0, wait = [] } = {}) {
  const writes = [], sleeps = [], lines = [];
  let put = false, reads = 0;
  const gh = (args) => {
    const [, route] = args;
    if (args.includes("POST") || args.includes("PUT") || args.includes("-f")) writes.push(args.slice(1).join(" "));
    if (args.includes("PUT")) put = true;
    const n = /pulls\/(\d)$/.exec(route)?.[1];
    if (n) return JSON.stringify({ ...pulls[n], merged: put && (n !== "8" || reads++ >= mergedAfter) });
    if (route.includes("/check-runs")) return JSON.stringify({ total_count: runs.length, check_runs: runs });
    if (route.includes("/status")) return JSON.stringify({ total_count: 0, statuses: [] });
    if (route.includes("/stacks?")) return JSON.stringify(stacks);
    return "";
  };
  const code = await main(argv, { run: gh, sleep: async (ms) => sleeps.push(ms), log: (l) => lines.push(l), error: (l) => lines.push(l) });
  return { code, writes, sleeps, lines };
}

test("a new stack is joined bottom up, each verdict posted, then the top merges with its own sha", async () => {
  const r = await merge(ARGV);
  assert.equal(r.code, 0);
  assert.deepEqual(r.writes, [
    `-X POST repos/${REPO}/stacks -F pull_requests[]=7 -F pull_requests[]=8`,
    `repos/${REPO}/issues/7/comments -f body=Review: MERGE at ${SHA[7]}`,
    `repos/${REPO}/issues/8/comments -f body=Review: MERGE at ${SHA[8]}`,
    `-X PUT repos/${REPO}/pulls/8/merge-async -f sha=${SHA[8]} -f merge_method=squash`,
  ]);
});

test("an open stack of the same pull requests is reused, any other open stack is refused", async () => {
  assert.ok(!(await merge(ARGV, { stacks: [stack(7, 8)] })).writes.some((w) => w.includes("POST")));
  for (const other of [stack(7, 8, 9), stack(8, 7), stack(6, 7)]) {
    const r = await merge(ARGV, { stacks: [other] });
    assert.deepEqual([r.code, r.writes], [1, []]);
  }
  assert.equal((await merge(ARGV, { stacks: [{ ...stack(6, 7), open: false }] })).code, 0);
});

test("a pull request off the stack, a failed check or a pending check stops before any write", async () => {
  const off = await merge(ARGV, { pulls: { 7: STACKED[7], 8: pr(8, "main", "claude/two") } });
  assert.deepEqual([off.code, off.writes], [1, []]);
  assert.match(off.lines.join("\n"), /base is main, not claude\/one/);
  const red = await merge(ARGV, { runs: [{ ...PASS[0], conclusion: "failure" }] });
  assert.deepEqual([red.code, red.writes], [1, []]);
  const pending = await merge(ARGV, { runs: [{ ...PASS[0], status: "in_progress", conclusion: null }] });
  assert.deepEqual([pending.code, pending.writes], [3, []]);
});

test("--check writes nothing, a slow merge is polled, a stuck one exits 3 and bad arguments exit 2", async () => {
  assert.deepEqual([(await merge([...ARGV, "--check"])).code, (await merge([...ARGV, "--check"])).writes], [0, []]);
  const slow = await merge(ARGV, { mergedAfter: 2 });
  assert.deepEqual([slow.code, slow.sleeps], [0, [5000, 5000]]);
  assert.equal((await merge([...ARGV, "--wait", "5"], { mergedAfter: 99 })).code, 3);
  for (const bad of [["--repo", REPO, "--prs", `7:${SHA[7]}`], [...ARGV, "--admin"], ["--repo", REPO, "--prs", "7:x,8:y"]]) assert.equal((await merge(bad)).code, 2);
});
