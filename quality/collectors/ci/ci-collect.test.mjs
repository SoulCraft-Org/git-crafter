// More tests for the CI collector, split out of ci.test.mjs to keep each file under the Read limit:
// collect() on the fixture and the repo-settings metrics. Shared fixtures are in ci-fixtures.mjs.
// Run with: node --test quality/collectors/ci/ci-collect.test.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { collect, JOBS_BATCH, JOBS_BATCH_WITH_STEPS, LAST_RUNS, METRIC_IDS, QUEUE_SAMPLE, runJobs, settings, skipTriggers } from "./ci.mjs";
import { TARGETS, TEMPLATE_PARAMS, FULL_PARAMS, NOW, REPO, T, run, RUNS, skipped, job, JOBS, CHECKS, pull, RUNS_OF, REST, fakeGh, ROOT, collectWith } from "./ci-fixtures.mjs";
// Worked by hand from the fixture.
const EXPECTED = {
  "ci.latest_flow": 10, // the latest head that went all green, s4: 13:00 to 13:10
  "ci.latest_full_run_minutes": 4.7, // unit-tests' latest real run, 9: 4.67; dependency-scan's, 6: 0.58
  "ci.main_red_minutes": 0, // unit-tests' one push to main, run 9, passed
  "ci.light_run_share": 18.2, // runs 7 and 8 of the 11 completed
  "ci.flaky_reruns": 11.1, // unit-tests on s2 failed its first attempt: 1 of 9 workflow and commit pairs
  "ci.cache_hit_rate": 75, // jobs 109, 105, 101 hit; 103 missed; 112's log has no cache line
  // The latest merge, #11: unit-tests run 3, 12 billed minutes x $0.006, and
  // dependency-scan run 4, 1 x $0.002, from their own REST jobs.
  "ci.latest_pr_dollars": 0.074,
  // #11 is also the latest fix; it closed 2 issues: (12 + 1) / 2.
  "issues.latest_fix_ci_minutes": 6.5,
  // dependency-scan matches the default scan pattern: its latest real run, 6, billed 1 minute.
  "security.latest_scan_minutes": 1,
  "ci.skip_unchanged_share": 40, // 2 of 5 triggers
  // The one push to main, m1: unit-tests run 9 billed 4 minutes.
  "ci.latest_main_push_minutes": 4,
  // The ten jobs with a queue time, in seconds: 5, 10, 10, 15, 15, 20, 20, 30, 40, 60; p90 is 40 + 0.1 x 20.
  "ci.queue_seconds_p90": 42,
  // Run 5 failed, of the 9 runs that passed or failed; 8 skipped, 11 cancelled and 10 unfinished give no verdict.
  "ci.failed_run_share": 11.1,
  // Run 11 (cancelled, 1 billed minute) of the 33 read; run 5 failed on a pull request, so its 3 are not waste.
  "insights.failed_minutes_share": 3,
  // The queue sample's 33 billed minutes: unit-tests 29 x 0.6 cents, dependency-scan 4 x 0.2; 18.2 cents / 33.
  "ci.runner_cents_per_minute": 0.55,
  "ci.api_headroom": 80, // REST 4,000 of 5,000 left, the lower of it and GraphQL's 90%
};

describe("collect", () => {
  it("measures every metric in the fixture to its worked value", async () => {
    const got = await collectWith();
    for (const [id, value] of Object.entries(EXPECTED)) {
      assert.equal(got[id].could_not_check, undefined, `${id}: ${got[id].could_not_check}`);
      assert.equal(got[id].value, value, id);
      assert.match(got[id].read_at, /^\d{4}-\d{2}-\d{2}T/, id);
      assert.ok(got[id].source, id);
    }
  });

  it("returns exactly the metrics its targets file defines", async () => {
    const got = await collectWith();
    assert.deepEqual(Object.keys(got).sort(), TARGETS.map((t) => t.id).sort());
    assert.deepEqual([...METRIC_IDS].sort(), TARGETS.map((t) => t.id).sort());
  });

  it("files each step of the flow with its latest run and pass rate", async () => {
    const { detail } = (await collectWith())["ci.latest_flow"];
    const row = (stage, label) => detail.find((d) => d.stage === stage && d.label === label);
    assert.deepEqual(detail.map((d) => d.stage), ["edit", "commit", "push", "ci", "ci", "ci", "ci", "review", "merge", "deploy"]);
    assert.deepEqual([row("ci", "e2e").value, row("ci", "e2e").pass_rate], [null, null], "no e2e runs in the fixture");
    // One-job workflows are timed by their latest real run, created to finished.
    // dependency-scan on pull requests: real runs 2, 4 and 6; the latest, 6, took 0.58;
    // 3 of 3 decided passed; run 8 skipped, so 1 of 4 not cancelled was light.
    assert.deepEqual([row("ci", "dependency-scan").value, row("ci", "dependency-scan").pass_rate, row("ci", "dependency-scan").light_share], [0.6, 100, 25]);
    // unit-tests on pull requests: real runs 12, 1 and 3; the latest, 3, took 13 (7 was light, 5 failed); 4 of 5 passed; 1 of 5 light.
    assert.deepEqual([row("ci", "unit-tests").value, row("ci", "unit-tests").pass_rate, row("ci", "unit-tests").light_share], [13, 80, 20]);
    // unit-tests on main: run 9, 4.67 minutes.
    assert.deepEqual([row("merge", "unit-tests").value, row("merge", "unit-tests").pass_rate], [4.7, 100]);
    assert.equal(row("merge", "unit-tests").light_share, undefined);
    // Review: the latest merge, #11, came 30 minutes after s2 went green; 3 of the last 4 closed were merged.
    assert.deepEqual([row("review", "Review and merge").value, row("review", "Review and merge").pass_rate], [30, 75]);
    // The deploy app's check run on the latest merge, m2: 5 minutes after it; 1 of 2 passed.
    assert.deepEqual([row("deploy", "Deploy: staging").value, row("deploy", "Deploy: staging").pass_rate], [5, 50]);
    assert.deepEqual([row("edit", "content-guard.sh").value, row("edit", "content-guard.sh").pass_rate], [null, null]);
    for (const d of detail) {
      assert.equal(d.unit, "minutes");
      for (const key of ["label", "stage", "kind", "runs", "file"]) assert.equal(typeof d[key], "string", `${d.label} ${key}`);
    }
  });

  it("ranks queue seconds and failed minutes per workflow", async () => {
    const got = await collectWith();
    // unit-tests queued 10, 20, 20, 30, 40 and 60 seconds; dependency-scan 5, 10, 15 and 15.
    assert.deepEqual(got["ci.queue_seconds_p90"].detail, [
      { label: "unit-tests", value: 50 },
      { label: "dependency-scan", value: 15 },
    ]);
    // unit-tests: none of its 29 billed minutes, since run 5 failed on a pull request, the check working; dependency-scan: the cancelled run 11's 1 of 4.
    assert.deepEqual(got["insights.failed_minutes_share"].detail, [
      { label: "unit-tests", value: 0 },
      { label: "dependency-scan", value: 25 },
    ]);
  });

  it("counts failed runs per workflow on any event, and a timeout as a failure", async () => {
    // unit-tests: run 5 of its 6 decided runs; dependency-scan: none of its 3.
    assert.deepEqual((await collectWith())["ci.failed_run_share"].detail, [
      { label: "unit-tests", value: 16.7 },
      { label: "dependency-scan", value: 0 },
    ]);
    // Run 9, the push to main, times out: 2 of 9.
    const runs = RUNS.filter((r) => r.workflow_id === 1).map((r) => (r.id === 9 ? { ...r, conclusion: "timed_out" } : r));
    const got = await collectWith({ gh: fakeGh({ rest: { ...REST, [RUNS_OF(1)]: { workflow_runs: runs } } }) });
    assert.equal(got["ci.failed_run_share"].value, 22.2);
  });

  it("counts a failure on the default branch as wasted minutes, never one on a pull request", async () => {
    // Run 9, the push to main, fails: its 4 billed minutes join run 11's 1, of 33.
    const runs = RUNS.filter((r) => r.workflow_id === 1).map((r) => (r.id === 9 ? { ...r, conclusion: "failure" } : r));
    const got = await collectWith({ gh: fakeGh({ rest: { ...REST, [RUNS_OF(1)]: { workflow_runs: runs } } }) });
    assert.equal(got["insights.failed_minutes_share"].value, 15.2);
    // The same failure in the merge queue is the check working before the merge: only run 11's 1 of 33 counts.
    const queued = runs.map((r) => (r.id === 9 ? { ...r, event: "merge_group" } : r));
    const inQueue = await collectWith({ gh: fakeGh({ rest: { ...REST, [RUNS_OF(1)]: { workflow_runs: queued } } }) });
    assert.equal(inQueue["insights.failed_minutes_share"].value, 3);
  });

  it("does not score queue seconds or failed minutes when no job ran", async () => {
    const jobs = Object.fromEntries(Object.keys(JOBS).map((id) => [`repos/${REPO}/actions/runs/${id}/jobs?per_page=100`, { jobs: [] }]));
    const got = await collect({ root: ROOT, mode: "local", params: FULL_PARAMS, gh: fakeGh({ rest: { ...REST, ...jobs }, checks: Object.fromEntries(Object.keys(JOBS).map((id) => [id, []])) }), now: NOW, repo: REPO });
    assert.match(got["ci.queue_seconds_p90"].could_not_check, /no job with a queue time/);
    assert.match(got["insights.failed_minutes_share"].could_not_check, /no billed minutes/);
  });

  it("counts flaky pairs per workflow", async () => {
    const got = await collectWith();
    assert.deepEqual(got["ci.flaky_reruns"].detail.map((d) => [d.label, d.value]), [["unit-tests", 1], ["dependency-scan", 0]]);
    assert.deepEqual(got["ci.latest_pr_dollars"].detail.map((d) => [d.label, d.value]), [["unit-tests", 0.072], ["dependency-scan", 0.002]]);
    assert.ok(got["ci.latest_pr_dollars"].source.endsWith("; #11"), got["ci.latest_pr_dollars"].source);
    assert.equal(got["ci.skip_unchanged_share"].detail[1].label, "dependency-scan, pull request: runs its work on every change");
  });

  it("reads each run list, the GraphQL jobs and the pull requests once, and never a dynamic workflow", async () => {
    const calls = [];
    await collect({ root: ROOT, mode: "ci", params: FULL_PARAMS, gh: fakeGh({}, calls), now: NOW, repo: REPO });
    const count = (re) => calls.filter((c) => re.test(c)).length;
    assert.equal(count(/workflows\/3\//), 0, "Dependabot's dynamic workflow is not read");
    assert.equal(count(/\/runs\?per_page=100$/), 2);
    assert.equal(count(/^graphql nodes /), 1, "eleven runs' jobs in one GraphQL call");
    assert.equal(count(/^graphql FixingPulls$/), 1, "one call for the issues each merged pull request closed");
    assert.equal(count(/\/jobs\?per_page=100$/), 11, "REST jobs for queue times: every completed run, 10 or fewer a workflow");
    assert.equal(count(/\/pulls\?/), 1);
    assert.equal(count(/\/check-runs/), 3, "one per merge commit of the last merged pull requests");
    assert.equal(count(/search\/issues|billing|commits\?/), 0);
    // 1 repo + 1 list + 2 run lists + 11 jobs + 5 logs + 1 attempt + 1 pulls + 3 check runs + 1 rate_limit = 26 REST and text calls.
    assert.equal(count(new RegExp(`^repos/${REPO}$`)), 1, "the default branch, read once");
    assert.equal(calls.filter((c) => !c.startsWith("graphql")).length, 26);
  });

  it("reads jobs with their steps in GraphQL calls small enough to finish within GitHub's timeout", async () => {
    // 30 completed runs: two calls with steps (25 and 5), one without.
    const many = Array.from({ length: 30 }, (_, i) => ({ id: 900 + i, node_id: `WFR_${900 + i}` }));
    const checks = Object.fromEntries(many.map((r) => [r.id, CHECKS[9]]));
    const calls = [];
    await runJobs(fakeGh({ checks }, calls), many, { steps: true });
    assert.deepEqual(calls.map((c) => c.split(",").length), [JOBS_BATCH_WITH_STEPS, 5]);
    calls.length = 0;
    await runJobs(fakeGh({ checks }, calls), many);
    assert.equal(calls.length, 1, `up to ${JOBS_BATCH} runs a call without steps`);
  });

  it("reads only the last 20 runs of a workflow, and REST jobs for the newest 10 of them", async () => {
    // 25 passing pushes, one a minute, newest first: runs 125 down to 101.
    const many = Array.from({ length: 25 }, (_, i) => {
      const id = 125 - i;
      const at = new Date(Date.parse(T("12:00:00")) - i * 60_000).toISOString();
      return run(id, 1, "unit-tests", "push", `p${id}`, "success", at, at);
    });
    const checks = Object.fromEntries(many.map((r) => [r.id, CHECKS[9]]));
    const rest = {
      ...REST,
      [`repos/${REPO}/actions/workflows?per_page=100`]: { workflows: [{ id: 1, name: "unit-tests", path: ".github/workflows/unit-tests.yml" }] },
      [RUNS_OF(1)]: { workflow_runs: many },
      ...Object.fromEntries(many.map((r) => [`repos/${REPO}/actions/runs/${r.id}/jobs?per_page=100`, { jobs: JOBS[9] }])),
    };
    const calls = [];
    await collect({ root: ROOT, mode: "ci", params: FULL_PARAMS, gh: fakeGh({ rest, checks }, calls), now: NOW, repo: REPO });
    const graphql = calls.find((c) => c.startsWith("graphql nodes ")).slice(14).split(",").map(Number);
    assert.equal(graphql.length, LAST_RUNS);
    assert.deepEqual([Math.max(...graphql), Math.min(...graphql)], [125, 106], "runs 105 to 101 are older than the last 20");
    const rested = calls.filter((c) => /\/jobs\?per_page=100$/.test(c)).map((c) => Number(/runs\/(\d+)\//.exec(c)[1]));
    assert.equal(rested.length, QUEUE_SAMPLE);
    assert.equal(Math.min(...rested), 116);
  });

  it("reads the same in ci mode as in local mode, with no billing read in either", async () => {
    const got = await collectWith({ mode: "ci" });
    assert.equal(got["ci.latest_flow"].value, 10);
    assert.equal(got["ci.latest_pr_dollars"].value, 0.074);
    const calls = [];
    await collect({ root: ROOT, mode: "local", params: FULL_PARAMS, gh: fakeGh({}, calls), now: NOW, repo: REPO });
    assert.equal(calls.filter((c) => /billing/.test(c)).length, 0, "no billing read");
    assert.equal(calls.filter((c) => !c.startsWith("graphql")).length, 26, "the same 26 as a ci run");
  });

  it("prices each workflow's billed minutes at its runners' list rate", async () => {
    const got = await collectWith();
    assert.deepEqual(got["ci.runner_cents_per_minute"].detail, [
      { label: "unit-tests", value: 0.6 },
      { label: "dependency-scan", value: 0.2 },
    ]);
  });

  it("cannot price a job on a runner with no list price", async () => {
    const rest = { ...REST, [`repos/${REPO}/actions/runs/3/jobs?per_page=100`]: { jobs: JOBS[3].map((j) => ({ ...j, labels: ["self-hosted", "linux"] })) } };
    const got = await collectWith({ gh: fakeGh({ rest }) });
    assert.match(got["ci.latest_pr_dollars"].could_not_check, /self-hosted, linux/);
    assert.equal(got["ci.latest_pr_dollars"].value, undefined);
    assert.equal(got["issues.latest_fix_ci_minutes"].value, 6.5, "minutes need no price");
    assert.match(got["ci.runner_cents_per_minute"].could_not_check, /self-hosted, linux/);
  });
});
describe("api headroom", () => {
  it("names each bucket's share left and the token read", async () => {
    const got = (await collectWith())["ci.api_headroom"];
    assert.deepEqual(got.detail, [
      { label: "REST requests left of 5000", value: 80 },
      { label: "GraphQL points left of 5000", value: 90 },
    ]);
    assert.match(got.source, /the account's login/);
    assert.match((await collectWith({ mode: "ci" }))["ci.api_headroom"].source, /workflow token/);
  });

  it("cannot check when rate_limit lacks a bucket", async () => {
    const rest = { ...REST, rate_limit: { resources: { core: { limit: 5000, remaining: 1 } } } };
    assert.match((await collectWith({ gh: fakeGh({ rest }) }))["ci.api_headroom"].could_not_check, /no core or graphql/);
  });
});
describe("repo settings", () => {
  const roots = [];
  const repoWith = (files) => {
    const dir = mkdtempSync(path.join(tmpdir(), "ci-settings-"));
    roots.push(dir);
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      writeFileSync(path.join(dir, rel), text);
    }
    return dir;
  };
  after(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));
  const WORKFLOW = { ".github/workflows/unit-tests.yml": readFileSync(path.join(ROOT ?? "", ".github/workflows/unit-tests.yml"), "utf8") };

  it("with the template's params, draws a review stage, reads no deploy check runs, and finds no scan", async () => {
    const calls = [];
    const got = await collect({ root: repoWith(WORKFLOW), mode: "local", gh: fakeGh({}, calls), now: NOW, repo: REPO });
    assert.equal(calls.filter((c) => /check-runs/.test(c)).length, 0, "no deploy app named");
    const { detail } = got["ci.latest_flow"];
    assert.deepEqual(detail.map((d) => [d.stage, d.label]), [["ci", "unit-tests"], ["review", "Review and merge"], ["merge", "unit-tests"]]);
    assert.equal(detail[1].file, "branch rules on the default branch");
    assert.deepEqual([detail[1].value, detail[1].pass_rate], [30, 75], "timed from all green to merged, as with the repo's own stage");
    assert.equal(got["security.latest_scan_minutes"].value, 1, "the run list still names dependency-scan, which the default pattern matches");
  });

  it("reads only the metrics the engine passes", async () => {
    const calls = [];
    const targets = TARGETS.filter((t) => t.id === "ci.skip_unchanged_share");
    const got = await collect({ root: ROOT, mode: "local", params: FULL_PARAMS, targets, gh: fakeGh({}, calls), now: NOW, repo: REPO });
    assert.deepEqual(Object.keys(got), ["ci.skip_unchanged_share"]);
    assert.deepEqual(calls, [`repos/${REPO}`], "only the default branch, no run read");
  });

  it("counts a push trigger on the default branch the params name", async () => {
    const trunk = repoWith({ ".github/workflows/build.yml": "name: build\non:\n  push:\n    branches: [trunk]\njobs:\n  b:\n    runs-on: ubuntu-latest\n    steps:\n      - run: make\n" });
    const calls = [];
    const got = await collect({ root: trunk, mode: "local", params: { ...TEMPLATE_PARAMS, default_branch: "trunk" }, gh: fakeGh({}, calls), now: NOW, repo: REPO });
    assert.equal(got["ci.skip_unchanged_share"].detail[0].label, "build, push to trunk: runs its work on every change");
    assert.ok(!calls.includes(`repos/${REPO}`), "the param overrides the repo's branch, with no read");
    assert.deepEqual(skipTriggers(trunk, "main"), [], "a push to trunk is no push to main");
  });

  it("leaves out a pull request trigger that fires on no change, such as one for closed pull requests", () => {
    const wf = (types) => `name: tidy\non:\n  pull_request:\n${types}jobs:\n  t:\n    runs-on: ubuntu-slim\n    steps:\n      - run: echo tidy\n`;
    const rows = (types) => skipTriggers(repoWith({ ".github/workflows/tidy.yml": wf(types) }), "main").map((r) => r.trigger);
    assert.deepEqual(rows("    types: [closed]\n"), [], "closing a pull request changes no code");
    assert.deepEqual(rows("    types: [closed, labeled]\n"), []);
    assert.deepEqual(rows("    types: [opened, closed]\n"), ["pull request"]);
    assert.deepEqual(rows(""), ["pull request"], "no types: GitHub's defaults fire on every push");
  });

  it("counts a CI standard caller with paths as skipping, and one without as running every change", () => {
    const caller = (paths) => `name: ci\non:\n  pull_request:\njobs:\n  ci:\n    uses: acme/kit/.github/workflows/ci-standard.yml@${"a".repeat(40)} # v1\n    with:\n${paths}      short: npm run lint\n`;
    const how = (paths) => skipTriggers(repoWith({ ".github/workflows/ci.yml": caller(paths) }), "main").map((r) => r.how);
    assert.deepEqual(how("      paths: |\n        src/**\n"), ["ci-standard paths"]);
    assert.deepEqual(how(""), [null], "no paths: the standard runs every change");
    assert.deepEqual(how("      paths: |\n        # none yet\n"), [null], "a comment is no path");
  });

  it("reads the default branch from the repo when the params name none: a master repo", async () => {
    const master = repoWith({ ".github/workflows/build.yml": "name: build\non:\n  push:\n    branches: [master]\njobs:\n  b:\n    runs-on: ubuntu-latest\n    steps:\n      - run: make\n" });
    const rest = { ...REST, [`repos/${REPO}`]: { default_branch: "master" } };
    const got = await collect({ root: master, mode: "local", gh: fakeGh({ rest }), now: NOW, repo: REPO });
    assert.equal(got["ci.skip_unchanged_share"].detail[0].label, "build, push to master: runs its work on every change");
    const merge = got["ci.latest_flow"].detail.find((d) => d.stage === "merge");
    assert.match(merge.runs, /^On every push to master: /);
  });

  it("with no repo to read, names the fix and still reads the workflow files", async () => {
    const saved = process.env.GITHUB_REPOSITORY;
    delete process.env.GITHUB_REPOSITORY;
    try {
      const calls = [];
      const got = await collect({ root: ROOT, mode: "local", params: { ...FULL_PARAMS, default_branch: "main" }, gh: fakeGh({}, calls), now: NOW });
      assert.equal(calls.length, 0);
      for (const id of METRIC_IDS.filter((x) => x !== "ci.skip_unchanged_share")) {
        assert.match(got[id].could_not_check, /params\.repo .* is not owner\/name, and GITHUB_REPOSITORY is unset/, id);
      }
      assert.equal(got["ci.skip_unchanged_share"].value, 40, "the files need no repo once params name the branch");
    } finally {
      if (saved !== undefined) process.env.GITHUB_REPOSITORY = saved;
    }
  });

  it("names the param when a repo sets one the collector cannot use", async () => {
    for (const [params, reason] of [
      [{ stages: [{ label: "x" }] }, /params\.stages in targets\/ci\.json must be a list/],
      [{ hook_checks: "(" }, /params\.hook_checks .* does not compile/],
      [{ security_workflows: "(" }, /params\.security_workflows .* does not compile/],
      [{ deploy_apps: "one" }, /params\.deploy_apps .* must be a list/],
    ]) {
      const got = await collect({ root: ROOT, mode: "local", params: { ...FULL_PARAMS, ...params }, gh: fakeGh(), now: NOW, repo: REPO });
      for (const id of METRIC_IDS) assert.match(got[id].could_not_check, reason, id);
    }
  });

  it("adds GitHub's dynamic CodeQL runs to the scan minutes, and to nothing else", async () => {
    const list = `repos/${REPO}/actions/workflows?per_page=100`;
    const rest = {
      ...REST,
      [list]: { workflows: [...REST[list].workflows, { id: 4, name: "CodeQL", path: "dynamic/github-code-scanning/codeql" }] },
      [RUNS_OF(4)]: {
        workflow_runs: [
          run(401, 4, "CodeQL", "dynamic", "c1", "success", T("10:00:00"), T("10:05:00")),
          run(402, 4, "CodeQL", "dynamic", "c2", "success", T("11:00:00"), T("11:06:00")),
        ],
      },
      [`repos/${REPO}/actions/runs/401/jobs?per_page=100`]: { jobs: [job(4011, "Analyze", "10:00:00", "10:00:30", "10:03:30", "success", [])] }, // 3 billed
      [`repos/${REPO}/actions/runs/402/jobs?per_page=100`]: { jobs: [job(4021, "Analyze", "11:00:00", "11:00:10", "11:05:10", "success", [])] }, // 5 billed
    };
    const calls = [];
    const got = await collectWith({ gh: fakeGh({ rest }, calls) });
    assert.equal(got["security.latest_scan_minutes"].value, 6, "dependency-scan's latest real run, 1, plus CodeQL's latest passed run, 402: 5");
    assert.deepEqual(got["security.latest_scan_minutes"].detail.map((d) => [d.label, d.value]), [["dependency-scan", 1], ["CodeQL", 5]]);
    assert.ok(!calls.includes(`repos/${REPO}/actions/runs/401/jobs?per_page=100`), "only the latest CodeQL run's jobs are read");
    assert.equal(got["ci.light_run_share"].value, EXPECTED["ci.light_run_share"], "the run metrics still read only the repo's own workflows");
    assert.equal(got["ci.flaky_reruns"].value, EXPECTED["ci.flaky_reruns"]);
  });

  it("times how long the default branch has been red: from the first failure after its latest pass", async () => {
    const more = [
      run(20, 1, "unit-tests", "push", "m3", "failure", T("15:00:00"), T("15:05:00")),
      run(21, 1, "unit-tests", "push", "m4", "timed_out", T("16:00:00"), T("16:06:00")),
      run(22, 1, "unit-tests", "push", "m5", "cancelled", T("17:00:00"), T("17:01:00")),
      run(23, 1, "unit-tests", "push", "m6", null, T("19:00:00"), T("19:05:00")),
    ];
    const rest = { ...REST, [RUNS_OF(1)]: { workflow_runs: [...more, ...RUNS.filter((r) => r.workflow_id === 1)] } };
    const targets = TARGETS.filter((t) => t.id === "ci.main_red_minutes");
    const got = await collect({ root: ROOT, mode: "local", params: FULL_PARAMS, targets, gh: fakeGh({ rest }), now: NOW, repo: REPO });
    // Run 9 passed at 14:05; 20 failed, ending 15:05, and 21 timed out; a cancelled or unfinished run decides nothing.
    assert.deepEqual(got["ci.main_red_minutes"].detail, [{ label: "unit-tests, red since 2026-11-02T15:05Z", value: 295 }]);
    assert.equal(got["ci.main_red_minutes"].value, 295);
    assert.deepEqual((await collectWith())["ci.main_red_minutes"].detail, [{ label: "workflows green on main", value: 1, unit: "" }]);
    // A workflow disabled, deleted, or no longer started by a push never stays red.
    const list = `repos/${REPO}/actions/workflows?per_page=100`;
    const disabled = { ...rest, [list]: { workflows: REST[list].workflows.map((w) => (w.id === 1 ? { ...w, state: "disabled_manually" } : w)) } };
    const off = await collect({ root: ROOT, mode: "local", params: FULL_PARAMS, targets, gh: fakeGh({ rest: disabled }), now: NOW, repo: REPO });
    assert.equal(off["ci.main_red_minutes"].could_not_check, "no active workflow that runs on a push to main has a run there");
    const gone = await collect({ root: repoWith({}), mode: "local", params: FULL_PARAMS, targets, gh: fakeGh({ rest }), now: NOW, repo: REPO });
    assert.equal(gone["ci.main_red_minutes"].could_not_check, "no active workflow that runs on a push to main has a run there", "its file is gone");
  });

  it("divides the latest fix's runner minutes over the issues it closed, and skips when none closed one", async () => {
    const got = await collectWith();
    assert.deepEqual(got["issues.latest_fix_ci_minutes"].detail.map((d) => [d.label, d.value]), [["unit-tests", 6], ["dependency-scan", 0.5]]);
    assert.match(got["issues.latest_fix_ci_minutes"].source, /; #11 closed 2 issues$/);
    // With #11 closing none, the latest fix is #10: runs 1 (5 billed), 2 (1) and 9 (4), one issue.
    const only10 = { repository: { pullRequests: { nodes: [10, 11, 9].map((number) => ({ number, closingIssuesReferences: { totalCount: number === 10 ? 1 : 0 } })) } } };
    assert.equal((await collectWith({ gh: fakeGh({ closes: only10 }) }))["issues.latest_fix_ci_minutes"].value, 10);
    const none = { repository: { pullRequests: { nodes: [] } } };
    const empty = await collectWith({ gh: fakeGh({ closes: none }) });
    assert.match(empty["issues.latest_fix_ci_minutes"].could_not_check, /no merged pull request among the closed ones read closed an issue/);
  });

  // The board's cards link pull requests by number; github.mjs reads them.
  const CARD = (status, at, numbers) => ({ createdAt: T("01:00:00"), status: { name: status, updatedAt: at }, linked: { pullRequests: { nodes: numbers.map((number) => ({ number, merged: true, createdAt: T("09:00:00") })) } }, content: { __typename: "DraftIssue", body: "" } });
  const BOARD = { github: { project_title: "fixture-repo", project_columns: ["Todo", "In Progress", "Done"] } };
  const withBoard = (board, allParams = { "github.json": BOARD.github }) => collectWith({ gh: fakeGh({ board }), allParams });

  it("prices the latest Done card's pull requests per pull request, and names why it cannot", async () => {
    // The latest Done card (done 12:00) links #10 (runs 1, 2, 9: 10 billed minutes) and #11 (runs 3, 4: 13); the older card links #11 alone.
    const board = [CARD("Done", T("08:00:00"), [11]), CARD("Done", T("12:00:00"), [10, 11]), CARD("In Progress", T("13:00:00"), [9]), CARD("Done", T("14:00:00"), [])];
    const got = (await withBoard(board))["projects.latest_card_ci_minutes"];
    assert.equal(got.value, 11.5, "(10 + 13) / 2");
    assert.deepEqual(got.detail.map((d) => [d.label, d.value]), [["unit-tests", 10.5], ["dependency-scan", 1]]);
    assert.match(got.source, /; #10, #11 of the card done 2026-11-02$/);
    // The newest Done card links a pull request the read does not hold: the one before it is priced, and the note says so.
    const older = (await withBoard([CARD("Done", T("12:00:00"), [10]), CARD("Done", T("14:00:00"), [99])]))["projects.latest_card_ci_minutes"];
    assert.equal(older.value, 10, "#10's runs 1, 2 and 9");
    assert.match(older.source, /; #10 of the card done 2026-11-02; 1 newer card passed over, not yet priceable$/);
    const none = (await withBoard([CARD("Todo", T("12:00:00"), [10])]))["projects.latest_card_ci_minutes"];
    assert.match(none.could_not_check, /no Done card links a merged pull request yet/);
    assert.match((await withBoard(null))["projects.latest_card_ci_minutes"].could_not_check, /no project named fixture-repo yet/);
    assert.match((await withBoard(board, {}))["projects.latest_card_ci_minutes"].could_not_check, /needs at least two columns/);
    const lost = (await withBoard([CARD("Done", T("12:00:00"), [99])]))["projects.latest_card_ci_minutes"];
    assert.match(lost.could_not_check, /#99, linked from the latest Done card, is not among the merged pull requests read/);
    const ci = await collect({ root: ROOT, mode: "ci", params: FULL_PARAMS, gh: fakeGh({ board }), now: NOW, repo: REPO, allParams: { "github.json": BOARD.github } });
    assert.match(ci["projects.latest_card_ci_minutes"].could_not_check, /needs the project scope/);
  });
});

// ---------------------------------------------------------------- targets
