// Tests for Git Crafter's own page-speed collector. GitHub is a stand-in: every
// gh api call is stubbed, so nothing here reads the network.
// Run with: node --test config/quality/collectors/page-speed.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { GhError } from "../../../quality/collectors/lib/index.mjs";
import { collect, settingsOf } from "./page-speed.mjs";

const ID = "engine.page_seconds";
const REPO = "o/r";
const STEP = "Git Crafter's own Quality, Speed and Consumption page";
const T = (s) => `2026-11-11T05:${s}Z`;
// A pages run whose build job ran the step from start to end.
const run = (id, start, end) => ({
  run: { id, created_at: T("00:00"), head_sha: `abc${id}def0` },
  jobs: { jobs: [{ name: "changes", steps: [] }, { name: "build", steps: [{ name: "npm ci", started_at: T("00:00"), completed_at: T("00:10") }, { name: STEP, started_at: start, completed_at: end }] }] },
});
// A gh stub answering the run list and each run's jobs.
const fakeGh = (runs, calls = []) => ({
  rest: async (route) => {
    calls.push(route);
    if (route.includes("/workflows/")) return { workflow_runs: runs.map((r) => r.run) };
    return runs.find((r) => route.includes(`/runs/${r.run.id}/jobs`)).jobs;
  },
});

test("reads the median of the step's seconds over the last runs, so one slow runner does not set it", async () => {
  const calls = [];
  const runs = [run(1, T("01:00"), T("01:40")), run(2, T("01:00"), T("01:50")), run(3, T("01:00"), T("03:00")), run(4, T("01:00"), T("01:45")), run(5, T("01:00"), T("01:30"))];
  const got = await collect({ params: { runs: 5 }, gh: fakeGh(runs, calls), repo: REPO });
  assert.equal(got[ID].value, 45, "40, 50, 120, 45, 30: the median is 45");
  assert.deepEqual(got[ID].detail.map((d) => d.value), [40, 50, 120, 45, 30]);
  assert.equal(got[ID].detail[0].label, "2026-11-11T05:00Z abc1def");
  assert.equal(calls[0], "repos/o/r/actions/workflows/pages.yml/runs?branch=main&event=push&status=success&per_page=5");
  assert.equal(calls.length, 6, "one list and one jobs read per run");
  assert.match(got[ID].source, /^last 5 successful pushes to main: median seconds/);
});

test("an even count reads the mean of the two middle runs, and a run without the step is left out", async () => {
  const missing = { run: { id: 9, created_at: T("00:00"), head_sha: "x" }, jobs: { jobs: [{ name: "build", steps: [{ name: STEP, started_at: T("01:00"), completed_at: null }] }] } };
  const runs = [run(1, T("01:00"), T("01:40")), missing, run(2, T("01:00"), T("01:51"))];
  const got = await collect({ gh: fakeGh(runs), repo: REPO });
  assert.equal(got[ID].value, 46, "the mean of 40 and 51, rounded");
  assert.equal(got[ID].detail.length, 2);
});

test("a read that fails, or finds no step, is could_not_check with the reason, never 0", async () => {
  const refused = { rest: async () => { throw new GhError("Resource not accessible by integration", { status: 403 }); } };
  const no = await collect({ gh: refused, repo: REPO });
  assert.equal(no[ID].value, undefined);
  assert.match(no[ID].could_not_check, /gh api failed \(HTTP 403\): Resource not accessible/);
  const none = await collect({ gh: fakeGh([]), repo: REPO });
  assert.match(none[ID].could_not_check, /no successful push to main in pages\.yml has the build job's step/);
  const noRepo = await collect({ gh: fakeGh([]), repo: "", params: { repo: "not a slug" } });
  assert.match(noRepo[ID].could_not_check, /no repo to read/);
});

test("its target times the step pages.yml really runs, reads in CI and has a goal with its source", () => {
  const [target] = JSON.parse(readFileSync(new URL("../targets/page-speed.json", import.meta.url), "utf8"));
  assert.equal(target.id, ID);
  assert.deepEqual([target.tab, target.kind, target.needs], ["code", "speed", "none"]);
  assert.ok(target.goal < target.near && target.goal_source.includes("read 2026-11-11"));
  assert.ok(target.means.length <= 120, "means fits the page's 120 characters (quality/score.mjs TEXT_FIELDS)");
  const cfg = settingsOf(target.params);
  const workflow = readFileSync(new URL(`../../../.github/workflows/${cfg.workflow}`, import.meta.url), "utf8");
  assert.match(workflow, new RegExp(`^  ${cfg.job}:$`, "m"), `${cfg.workflow} has the ${cfg.job} job`);
  assert.ok(workflow.includes(`- name: ${cfg.step}\n`), `${cfg.workflow} has the step "${cfg.step}"`);
  assert.deepEqual(settingsOf({}), cfg, "the target's params are the defaults");
});
