// node --test quality/history-push.test.mjs

import assert from "node:assert/strict";
import { test } from "node:test";

import { historyName } from "./collect.mjs";
import { BRANCH, pushHistory } from "./history-push.mjs";

const run = { generated_at: "2026-11-11T14:05:00.000Z", commit: "545edb4abcdef", mode: "ci", collectors: ["ci"], metrics: { "ci.pass_rate": { value: 97, unit: "%" } } };

// A fake `gh api` that answers from a branch holding `files` (null: no branch) and records each call.
function fakeGh(files) {
  const calls = [];
  const gh = (args, body) => {
    const path = args.at(-1);
    calls.push({ method: args[0] === "-X" ? args[1] : "GET", path, body });
    if (path.includes("/git/matching-refs/")) return files ? [{ ref: `refs/heads/${BRANCH}-old` }, { ref: `refs/heads/${BRANCH}`, object: { sha: "tip1" } }] : [];
    if (path.endsWith("/git/commits/tip1")) return { tree: { sha: "tree1" } };
    if (path.includes("/git/trees/tree1")) return { sha: "tree1", tree: files.map((p) => ({ path: p, type: "blob" })) };
    if (path.endsWith("/git/trees")) return { sha: "tree2" };
    if (path.endsWith("/git/commits")) return { sha: "commit2" };
    return {};
  };
  return { gh, calls };
}

test("historyName: one file per UTC day, the name a local run writes", () => {
  assert.equal(historyName(run), "2026-11-11.json");
  assert.equal(historyName({ generated_at: "2026-11-11T23:59:59.000Z" }), "2026-11-11.json");
});

test("pushHistory: the first run creates the branch with no parent, holding the day's file in the run's own shape", () => {
  const { gh, calls } = fakeGh(null);
  assert.deepEqual(pushHistory(gh, { repo: "o/r", run }), { wrote: true, path: "history/2026-11-11.json", created: true });
  const tree = calls.find((c) => c.path === "repos/o/r/git/trees");
  assert.equal(tree.body.base_tree, undefined);
  assert.deepEqual(JSON.parse(tree.body.tree[0].content), run, "the same run record, latest.json's shape");
  assert.deepEqual(calls.find((c) => c.path === "repos/o/r/git/commits").body.parents, []);
  assert.deepEqual(calls.at(-1), { method: "POST", path: "repos/o/r/git/refs", body: { ref: `refs/heads/${BRANCH}`, sha: "commit2" } });
});

test("pushHistory: a new day adds one commit on the branch tip; a day already written writes nothing", () => {
  const { gh, calls } = fakeGh(["history/2026-11-10.json"]);
  assert.equal(pushHistory(gh, { repo: "o/r", run }).wrote, true);
  assert.equal(calls.find((c) => c.path === "repos/o/r/git/trees").body.base_tree, "tree1");
  assert.deepEqual(calls.find((c) => c.path === "repos/o/r/git/commits").body.parents, ["tip1"]);
  assert.deepEqual(calls.at(-1), { method: "PATCH", path: `repos/o/r/git/refs/heads/${BRANCH}`, body: { sha: "commit2" } });

  const again = fakeGh(["history/2026-11-10.json", "history/2026-11-11.json"]);
  assert.deepEqual(pushHistory(again.gh, { repo: "o/r", run }), { wrote: false, path: "history/2026-11-11.json" });
  assert.ok(again.calls.every((c) => c.method === "GET"), "at most one file a day: no write on the second run");
  assert.equal(again.calls.length, 3);
});

test("pushHistory: only a CI run is kept", () => {
  const { gh, calls } = fakeGh(null);
  assert.throws(() => pushHistory(gh, { repo: "o/r", run: { ...run, mode: "local" } }), /not a CI run/);
  assert.equal(calls.length, 0);
});
