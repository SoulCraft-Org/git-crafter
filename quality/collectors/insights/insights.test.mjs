// Tests for the Insights collector. Run with `node --test quality/collectors/insights/insights.test.mjs`.
//
// The fixture is small enough to check by hand: a community profile at 71
// with two files missing; seven branches, one the
// default, one with an open pull request and one pushed four hours ago; and three people with write
// access, one who last committed in June and one who never did. The fail-open cases check that a refused or missing read becomes
// could_not_check, never a throw and never a 0. All of it runs offline.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { GhError } from "../github/github-core.mjs";
import { idleAccess, leftoverBranches, leftoverOf, oldestLeftoverHours } from "./insights-access.mjs";
import { collect, communityHealth, METRIC_IDS } from "./insights.mjs";

const read = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
const TARGETS = read("../../targets/insights.json");
const REST = read("../../fixtures/insights/rest.json");
const GRAPHQL = read("../../fixtures/insights/graphql.json");
const REPO = "fixture-org/fixture-repo";
const NOW = Date.parse("2026-11-10T00:00:00Z");
const VIEWS = ["Community", "Network", "People"];

/** A gh client that answers REST routes from the fixture and records each one. */
function fakeGh(rest = REST, calls = []) {
  const answer = async (route) => {
    calls.push(route);
    if (!(route in rest)) throw new GhError(`no fixture for ${route}`, { status: 404 });
    return structuredClone(rest[route]);
  };
  const graphql = async (query) => {
    const name = /query (\w+)/.exec(query)[1];
    calls.push(name);
    return structuredClone(GRAPHQL[name]);
  };
  return { rest: answer, restAll: answer, graphql };
}
const collectWith = (opts = {}) => collect({ mode: "local", gh: fakeGh(), repo: REPO, now: NOW, ...opts });

describe("collect", () => {
  it("measures the community score with a flag per health file", async () => {
    const got = (await collectWith())["insights.community_health_pct"];
    assert.equal(got.value, 71);
    assert.deepEqual(
      got.detail.map((d) => [d.label, d.value]),
      [["Description", 1], ["README", 1], ["License", 1], ["Contributing guide", 1], ["Code of conduct", 0], ["Pull request template", 0]],
    );
    assert.match(got.read_at, /^\d{4}-\d{2}-\d{2}T/);
  });

  it("counts a branch as leftover once its pull request closed, or after a day with none", async () => {
    // merged-b and closed-c had pull requests; never-d and gh-pages are over a day old with none.
    // main, feature-a (open pull request) and fresh-e (pushed 4 hours ago) do not count.
    const got = (await collectWith())["insights.leftover_branches"];
    assert.equal(got.value, 4);
    assert.deepEqual(got.detail.map((d) => [d.label, d.value]), [["pull request merged or closed", 2], ["no pull request for over a day", 2]]);
    const kept = await collectWith({ params: { repo: "", keep_branches: ["gh-pages"], idle_days: 90, branch_grace_hours: 24 } });
    assert.equal(kept["insights.leftover_branches"].value, 3);
    const strict = await collectWith({ params: { repo: "", keep_branches: [], idle_days: 90, branch_grace_hours: 2 } });
    assert.equal(strict["insights.leftover_branches"].value, 5, "fresh-e counts once the grace is 2 hours");
  });

  it("times the oldest leftover branch from its pull request's close, or from its last commit", async () => {
    // gh-pages: last commit 2026-10-01, 40 days before the fixture's now.
    const got = (await collectWith())["insights.oldest_leftover_hours"];
    assert.equal(got.value, 960);
    assert.deepEqual(got.detail, [{ label: "leftover branches", value: 4, unit: "" }]);
    // With gh-pages kept: never-d's last commit, 9 days; closed-c's pull request closed 3 days ago, merged-b's 12 hours.
    const kept = await collectWith({ params: { repo: "", keep_branches: ["gh-pages", "never-d"], idle_days: 90, branch_grace_hours: 24 } });
    assert.equal(kept["insights.oldest_leftover_hours"].value, 72);
  });

  it("counts people with write access and no commit in 90 days, by number and never by name", async () => {
    // dev-one committed 9 days ago; dev-two in June; dev-three never; reader cannot push.
    const got = (await collectWith())["insights.idle_access"];
    assert.equal(got.value, 2);
    assert.deepEqual(got.detail, [{ label: "people with write access", value: 3, unit: "" }]);
    assert.doesNotMatch(JSON.stringify(got), /dev-(one|two|three)|reader/);
    const year = await collectWith({ params: { repo: "", keep_branches: [], idle_days: 365 } });
    assert.equal(year["insights.idle_access"].value, 1, "only the one who never committed");
  });

  it("leaves the people list to a local run: CI makes no admin read", async () => {
    const calls = [];
    const got = await collectWith({ mode: "ci", gh: fakeGh(REST, calls), admin: null });
    assert.match(got["insights.idle_access"].could_not_check, /needs an admin token; refreshed by a --local collect run/);
    assert.ok(!calls.some((c) => /collaborators/.test(c)));
  });

  it("reads the people list in CI with the admin token's client, and only that read", async () => {
    const calls = [];
    const adminCalls = [];
    const got = await collectWith({ mode: "ci", gh: fakeGh(REST, calls), admin: fakeGh(REST, adminCalls) });
    assert.equal(got["insights.idle_access"].value, 2);
    assert.ok(adminCalls.some((c) => /collaborators/.test(c)));
    assert.ok(!calls.some((c) => /collaborators/.test(c)), "the workflow token makes no admin read");
    assert.ok(!adminCalls.some((c) => /community\/profile/.test(c)), "the admin token reads only admin metrics");
  });

  it("names the admin token when GitHub refuses it in CI, never a 0", async () => {
    const refuse = async () => Promise.reject(new GhError("Must have push access to view repository collaborators.", { status: 403 }));
    const got = await collectWith({ mode: "ci", admin: { rest: refuse, restAll: refuse, graphql: refuse } });
    assert.match(got["insights.idle_access"].could_not_check, /needs an admin token/);
    assert.equal(got["insights.idle_access"].value, undefined);
  });

  it("returns exactly the metrics its targets file defines", async () => {
    assert.deepEqual(Object.keys(await collectWith()).sort(), TARGETS.map((t) => t.id).sort());
    assert.deepEqual([...METRIC_IDS].sort(), TARGETS.map((t) => t.id).sort());
  });

  it("reads only the metrics the engine keeps", async () => {
    const calls = [];
    const got = await collectWith({ gh: fakeGh(REST, calls), targets: TARGETS.filter((t) => t.id === "insights.community_health_pct") });
    assert.deepEqual(Object.keys(got), ["insights.community_health_pct"]);
    assert.deepEqual(calls, [`repos/${REPO}/community/profile`]);
  });

  it("turns a missing gh into could_not_check on every metric, never a 0 or a throw", async () => {
    const missing = new GhError("gh is not installed; install the GitHub CLI and run gh auth login");
    const refuse = async () => Promise.reject(missing);
    const got = await collectWith({ gh: { rest: refuse, restAll: refuse, graphql: refuse } });
    for (const id of METRIC_IDS) {
      assert.match(got[id].could_not_check, /gh is not installed/, id);
      assert.equal(got[id].value, undefined, id);
      assert.ok(got[id].source, id);
    }
  });

  it("says a local run refreshes a read the CI token is refused", async () => {
    const refuse = async () => Promise.reject(new GhError("Resource not accessible by integration", { status: 403 }));
    const got = await collectWith({ mode: "ci", gh: { rest: refuse, restAll: refuse, graphql: refuse } });
    for (const id of METRIC_IDS) assert.match(got[id].could_not_check, /refreshed by a --local collect run/, id);
  });

  it("with no repo to read, names the fix and makes no call", async () => {
    const saved = process.env.GITHUB_REPOSITORY;
    delete process.env.GITHUB_REPOSITORY;
    try {
      const calls = [];
      const got = await collect({ mode: "local", gh: fakeGh(REST, calls) });
      assert.equal(calls.length, 0);
      for (const id of METRIC_IDS) assert.match(got[id].could_not_check, /params\.repo .* is not owner\/name, and GITHUB_REPOSITORY is unset/, id);
    } finally {
      if (saved !== undefined) process.env.GITHUB_REPOSITORY = saved;
    }
  });
});

describe("the metric functions", () => {
  it("do not score an answer that lacks the number", () => {
    assert.match(communityHealth({ files: {} }).could_not_check, /without a health percentage/);
    assert.match(idleAccess([], NOW, 90).could_not_check, /nobody with write access/);
  });

  it("read a repo with only its default branch as no leftover branch and no wait", () => {
    const left = leftoverOf([{ name: "main", target: { committedDate: "2026-01-01T00:00:00Z" }, open: { totalCount: 0 }, done: { totalCount: 0, nodes: [] } }], "main", [], NOW, 24);
    assert.equal(leftoverBranches(left).value, 0);
    assert.equal(oldestLeftoverHours(left).value, 0);
  });

  it("read a complete profile as the goal", () => {
    const files = { readme: {}, license: {}, contributing: {}, code_of_conduct: {}, pull_request_template: {} };
    const full = communityHealth({ health_percentage: 100, description: "x", files });
    assert.equal(full.value, 100);
    assert.ok(full.detail.every((d) => d.value === 1));
  });
});

describe("targets/insights.json", () => {
  it("puts each metric on the Insights tab under its view, with a plain meaning and a goal source", () => {
    for (const t of TARGETS) {
      assert.equal(t.tab, "insights", t.id);
      assert.match(t.id, /^insights\.[a-z0-9_]+$/, t.id);
      assert.ok(VIEWS.includes(t.group), `${t.id}: the group is the Insights view's name`);
      assert.ok(t.label.split(/\s+/).length <= 6, `${t.id}: label over six words`);
      assert.ok(t.means.trim() && t.means.length <= 120, t.id);
      assert.ok(t.goal_source.trim(), t.id);
      assert.ok(["none", "github-admin"].includes(t.needs), t.id);
      assert.ok(["number", "bar", "gauge", "table"].includes(t.chart), t.id);
      assert.ok(!/[–—]/.test(JSON.stringify(t)), `${t.id} has a dash`);
    }
  });

  it("has no calendar window: every source names its last N or says state", () => {
    for (const t of TARGETS) assert.match(t.source, /\blast \d+\b|^state\b|^latest\b/, t.id);
  });

  it("holds its params on the first entry, naming no repo, person or home path", () => {
    assert.deepEqual(TARGETS.filter((t) => t.params).map((t) => t.id), [TARGETS[0].id]);
    assert.deepEqual(TARGETS[0].params, { repo: "", keep_branches: [], idle_days: 90, branch_grace_hours: 24 });
    assert.deepEqual(TARGETS.filter((t) => t.kind === "speed").map((t) => t.id), ["insights.oldest_leftover_hours"]);
    assert.deepEqual(TARGETS.filter((t) => t.needs === "github-admin").map((t) => t.id), ["insights.idle_access"]);
    assert.doesNotMatch(JSON.stringify(TARGETS), /\/Users\/|\/home\/|~\//);
  });
});
