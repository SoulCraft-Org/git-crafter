// The size metrics leave out moved lines, read from each merge commit in the checkout, as the pull request gate does.
// Run with `node --test quality/collectors/github/github-moved.test.mjs`.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { gitDiff } from "./github-loaders.mjs";
import { readLines } from "./github-reviews.mjs";
import { GRAPHQL, fakeGh, run } from "./github-test-lib.mjs";

// A repo whose second commit moves 300 lines from a.mjs to b.mjs and adds 10 new ones.
const root = mkdtempSync(path.join(tmpdir(), "github-moved-"));
after(() => rmSync(root, { recursive: true, force: true }));
const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
const lines = (from, n) => Array.from({ length: n }, (_, i) => `export const v${from + i} = ${from + i};`).join("\n") + "\n";
git("init", "-q");
git("config", "user.email", "fixture@example.com");
git("config", "user.name", "fixture");
writeFileSync(path.join(root, "a.mjs"), lines(0, 300));
git("add", ".");
git("commit", "-qm", "one");
writeFileSync(path.join(root, "a.mjs"), "");
writeFileSync(path.join(root, "b.mjs"), lines(0, 300) + lines(1000, 10));
git("add", ".");
git("commit", "-qm", "move");
const MOVE = git("rev-parse", "HEAD");

const pull = (number, mergedAt, oid) => ({
  number, title: `PR ${number}`, createdAt: "2026-11-01T00:00:00Z", mergedAt, additions: 310, deletions: 300, headRefOid: "h",
  files: { nodes: [{ path: "a.mjs", additions: 0, deletions: 300 }, { path: "b.mjs", additions: 310, deletions: 0 }] },
  reviews: { nodes: [] }, headCommit: { nodes: [] }, mergeCommit: oid ? { oid } : null,
});
const page = (nodes) => ({ repository: { pullRequests: { pageInfo: { hasNextPage: false }, nodes } } });

describe("moved lines in the size metrics", () => {
  it("reads a merge commit's files from git, and null for a commit the checkout lacks", () => {
    const files = gitDiff(root, MOVE);
    assert.deepEqual(files.map((f) => [f.filename, f.additions, f.deletions]), [["a.mjs", 0, 300], ["b.mjs", 310, 0]]);
    assert.equal(gitDiff(root, "0".repeat(40)), null);
    assert.equal(gitDiff(root, git("rev-parse", "HEAD~1")), null, "a root commit has no parent to diff");
  });

  it("subtracts two lines per moved pair, never below zero", () => {
    const p = pull(1, "2026-11-01T01:00:00Z", MOVE);
    assert.deepEqual(readLines(p, [], gitDiff(root, MOVE)), { lines: 10, skipped: 0, moved: 600 });
    assert.deepEqual(readLines(p), { lines: 610, skipped: 0, moved: 0 }, "no patch moves nothing");
    assert.equal(readLines({ ...p, additions: 0, deletions: 0, files: { nodes: [] } }, [], gitDiff(root, MOVE)).lines, 0);
  });

  it("scores the latest merge by its new lines, and says when a merge commit was not read", async () => {
    const pulls = [pull(2, "2026-11-02T01:00:00Z", MOVE), pull(1, "2026-11-01T01:00:00Z", null)];
    const out = await run({ root, gh: fakeGh({ graphql: { ...GRAPHQL, MergedPulls: page(pulls) } }) });
    const latest = out["pull_requests.latest_lines"];
    assert.equal(latest.value, 10);
    assert.deepEqual(latest.detail.at(-1), { label: "moved lines left out", value: 600, unit: "lines" });
    assert.doesNotMatch(latest.source, /moved lines counted in full/);
    const over = out["pull_requests.over_400_lines"];
    assert.equal(over.value, 50, "#1 has no merge commit here, so its 610 lines count in full");
    assert.match(over.source, /moved lines counted in full: the merge commit is not in this checkout .*\(1 of 2\)$/);
  });
});
