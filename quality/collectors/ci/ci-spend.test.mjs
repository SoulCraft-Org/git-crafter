// Tests for ci-spend.mjs's latestPush: which push to the default branch the push minutes metric prices, and the note that names each one passed over.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PUSHES_TRIED, latestPush } from "./ci-spend.mjs";

const run = (id, sha, workflow, minute, status = "completed", extra = {}) => ({
  id,
  head_sha: sha,
  workflow,
  event: "push",
  head_branch: "main",
  status,
  created_at: `2026-11-10T10:${String(minute).padStart(2, "0")}:00Z`,
  ...extra,
});

describe("latestPush", () => {
  it("prices the newest push whose runs all ended", () => {
    const runs = [run(1, "aaaaaaa1", "verify", 0), run(2, "aaaaaaa1", "pages", 0), run(3, "bbbbbbb2", "verify", 5)];
    const got = latestPush(runs, "main");
    assert.equal(got.sha, "bbbbbbb2");
    assert.deepEqual(got.runs.map((r) => r.id), [3]);
    assert.equal(got.note, "bbbbbbb priced");
  });

  it("passes over the run collecting's own push and a push with a run still going, naming each", () => {
    const runs = [
      run(1, "aaaaaaa1", "verify", 0),
      run(2, "aaaaaaa1", "pages", 0),
      run(3, "bbbbbbb2", "verify", 5, "in_progress"),
      run(4, "ccccccc3", "verify", 9),
      run(5, "ccccccc3", "pages", 9, "in_progress"),
    ];
    const got = latestPush(runs, "main", 5);
    assert.equal(got.sha, "aaaaaaa1");
    assert.deepEqual(got.runs.map((r) => r.id), [1, 2]);
    assert.equal(got.note, "ccccccc, this run's push, still going, passed over; bbbbbbb has a run still going: verify, passed over; aaaaaaa priced");
  });

  it("reads only push runs on the branch it is given", () => {
    const runs = [run(1, "aaaaaaa1", "verify", 0), run(2, "bbbbbbb2", "verify", 5, "completed", { event: "pull_request" }), run(3, "ccccccc3", "verify", 9, "completed", { head_branch: "dev" })];
    assert.equal(latestPush(runs, "main").sha, "aaaaaaa1");
    assert.match(latestPush(runs, "trunk").skip, /^no push to trunk among the runs read$/);
  });

  it(`skips with every reason when none of the latest ${PUSHES_TRIED} pushes can be priced`, () => {
    const runs = Array.from({ length: PUSHES_TRIED + 1 }, (_, i) => run(i + 1, `sha${i}xxxx`, "verify", i, i === 0 ? "completed" : "queued"));
    const got = latestPush(runs, "main");
    assert.equal(got.sha, undefined);
    assert.match(got.skip, new RegExp(`^none of the latest ${PUSHES_TRIED} pushes to main can be priced yet: `));
    assert.equal(got.skip.split("; ").length, PUSHES_TRIED);
  });
});
