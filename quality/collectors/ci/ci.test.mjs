// Tests for the CI collector: its pieces, fail-open cases, targets and flaky checks.
// The collect and repo-settings cases are in ci-collect.test.mjs; shared fixtures in ci-fixtures.mjs.
// Run with: node --test quality/collectors/ci/ci.test.mjs
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { cacheVerdict, collect, commonStart, describeRun, flakyChecks, hookCode, hookRuns, jobGraph, jobNames, METRIC_IDS, pipelineStages, latestPriced, priceRuns, prRuns, pushToGreen, reasonFor, runnerRate, settings, shardCount, skipTriggers, weightedLightShare } from "./ci.mjs";
import { GhError } from "../github/github.mjs";
import { TARGETS, TEMPLATE_PARAMS, PARAMS, NOW, REPO, T, run, RUNS, skipped, LIGHT_SITE, GATES, job, JOBS, LOGS, pull, PULLS, RUNS_OF, REST, fakeGh, ROOT, collectWith } from "./ci-fixtures.mjs";

describe("ci collector pieces", () => {
  it("marks a passing run light when it skipped something and finished within a minute", () => {
    assert.equal(describeRun(RUNS[6], JOBS[7]).light, true);
    assert.equal(describeRun(RUNS[0], JOBS[1]).light, false, "nothing skipped");
    assert.equal(describeRun(RUNS[4], JOBS[5]).light, false, "a failed run's skipped steps are not light");
    assert.equal(describeRun(RUNS[7], JOBS[8]).light, true, "a skipped run is light");
    const slow = [job(201, "unit-tests", "13:00:00", "13:00:20", "13:03:20", "success", LIGHT_SITE)];
    assert.equal(describeRun(RUNS[6], slow).light, false, "three minutes of work is real work");
    // A sharded run whose shards were skipped: a detector and a gate job, 25 seconds.
    const sharded = [
      job(301, "e2e: changes", "13:00:00", "13:00:05", "13:00:15", "success", GATES),
      { ...job(302, "e2e: shard 1/2", "13:00:00", null, null, "skipped", []) },
      job(303, "e2e", "13:00:16", "13:00:20", "13:00:30", "success", GATES),
    ];
    assert.equal(describeRun(RUNS[6], sharded).light, true, "skipped shard jobs count");
  });

  it("bills each job rounded up to the minute, at least 1, and times the run from its creation", () => {
    const r = describeRun(RUNS[3], JOBS[4]);
    assert.equal(r.billed, 1, "30 seconds bills 1 minute");
    assert.equal(r.wall, 0.75);
    assert.equal(describeRun(RUNS[7], JOBS[8]).billed, 0, "a job that never ran bills nothing");
  });

  it("times push to all green only for heads where every run passed or skipped, the newest first", () => {
    const green = Object.fromEntries(pushToGreen(RUNS).map((g) => [g.sha, g.minutes]));
    assert.deepEqual(green, { s1: 6, s2: 20, s4: 10, s0: 5 }, "October's head counts: no calendar window");
    assert.deepEqual(pushToGreen(RUNS, 2).map((g) => g.sha), ["s4", "s2"], "the last 2 green heads, by first run");
  });

  it("finds a merged pull request's runs: its branch's from opening to merge, and its merge commit's", () => {
    assert.deepEqual(prRuns(PULLS[0], RUNS).map((r) => r.id).sort((a, b) => a - b), [1, 2, 9]);
    assert.deepEqual(prRuns(PULLS[1], RUNS).map((r) => r.id).sort((a, b) => a - b), [3, 4]);
    const late = { ...PULLS[1], created_at: T("11:30:00") };
    assert.deepEqual(prRuns(late, RUNS).map((r) => r.id), [], "runs before it opened belong to another pull request");
  });

  it("prices the latest pull request, and names why when it cannot", () => {
    // PULLS[1] is #11 (opened 10:45, runs 3 and 4), then #10.
    const pulls = [PULLS[1], PULLS[0]];
    assert.deepEqual(latestPriced(pulls, RUNS, -Infinity, "merged pull request").runs.map((r) => r.id).sort(), [3, 4]);
    assert.equal(latestPriced(pulls, RUNS, Date.parse(T("11:00:00")), "merged pull request").skip,
      "#11, the latest merged pull request, opened 2026-11-02 10:45 UTC, before 2026-11-02 11:00 UTC, where the runs read stop covering every workflow");
    const going = [...RUNS, run(30, 2, "dependency-scan", "pull_request", "s2", null, T("11:10:00"), T("11:15:00"))];
    assert.equal(latestPriced(pulls, going, -Infinity, "merged pull request").skip, "#11, the latest merged pull request, has a run still going: dependency-scan");
    // The run collecting is the merge's own pages run, always still going while it reads: left out, never a skip.
    const self = latestPriced(pulls, going, -Infinity, "merged pull request", 30);
    assert.deepEqual(self.runs.map((r) => r.id).sort(), [3, 4]);
    assert.equal(self.self, "this run (dependency-scan) left out, still going");
    assert.equal(latestPriced(pulls, RUNS, -Infinity, "merged pull request", 30).self, undefined);
  });

  it("prices the newest covered pull request when the latest opened before the runs read", () => {
    // #11 opened 08:00 here, before the 09:00 start; #10 opened 09:30 (runs 1, 2 and 9).
    const pulls = [{ ...PULLS[1], created_at: T("08:00:00") }, PULLS[0]];
    const got = latestPriced(pulls, RUNS, Date.parse(T("09:00:00")), "merged pull request");
    assert.equal(got.pull.number, 10);
    assert.deepEqual(got.runs.map((r) => r.id).sort((a, b) => a - b), [1, 2, 9]);
    assert.equal(got.self, "#11, the latest merged pull request, opened 2026-11-02 08:00 UTC, before 2026-11-02 09:00 UTC, where the runs read stop covering every workflow; #10 priced");
  });

  it("still skips when no pull request in the list opened after the runs read", () => {
    const pulls = [PULLS[1], PULLS[0]];
    assert.equal(latestPriced(pulls, RUNS, Date.parse(T("12:00:00")), "merged pull request").skip,
      "#11, the latest merged pull request, opened 2026-11-02 10:45 UTC, before 2026-11-02 12:00 UTC, where the runs read stop covering every workflow");
    assert.match(latestPriced([PULLS[1]], RUNS, Date.parse(T("11:00:00")), "merged pull request").skip, /^#11, .*opened .*every workflow$/, "a one-element list skips as before");
  });

  it("prices the pull request before when only the runs its merge started hold the latest back", () => {
    // #11 merged as m2; this push started pages (40, collecting) and verify (41), both still going.
    const pulls = [PULLS[1], PULLS[0]];
    const push = [...RUNS, run(40, 5, "pages", "push", "m2", null, T("11:51:00"), T("11:52:00")), run(41, 6, "verify", "push", "m2", null, T("11:51:00"), T("11:52:00"))];
    const got = latestPriced(pulls, push, -Infinity, "merged pull request", 40);
    assert.equal(got.pull.number, 10);
    assert.deepEqual(got.runs.map((r) => r.id).sort((a, b) => a - b), [1, 2, 9]);
    assert.equal(got.self, "#11, the latest merged pull request, has runs its merge started still going (verify); #10 priced");
    // A local read has no collecting run to leave out: pages counts as going too, and #10 is still priced.
    assert.equal(latestPriced(pulls, push, -Infinity, "merged pull request").self, "#11, the latest merged pull request, has runs its merge started still going (pages, verify); #10 priced");
    assert.match(latestPriced([PULLS[1]], push, -Infinity, "merged pull request", 40).skip, /still going: verify$/, "no next pull request: a skip");
    const branch = [...push, run(42, 2, "dependency-scan", "pull_request", "s2", null, T("11:10:00"), T("11:15:00"))];
    assert.match(latestPriced(pulls, branch, -Infinity, "merged pull request", 40).skip, /^#11.*still going/, "a branch run still going is not a merge run: a skip");
    assert.match(latestPriced(pulls, push, Date.parse(T("10:00:00")), "merged pull request", 40).skip, /^#11, .*still going \(verify\); #10, .*opened/, "the next one's own skip, both named");
  });

  it("names the priced pull request even when it also owns the collecting run", () => {
    // #11 is held back by its merge's verify run; #10 is priced and owns run 1, the run collecting.
    const pulls = [PULLS[1], PULLS[0]];
    const push = [...RUNS, run(41, 6, "verify", "push", "m2", null, T("11:51:00"), T("11:52:00"))];
    const got = latestPriced(pulls, push, -Infinity, "merged pull request", 1);
    assert.equal(got.pull.number, 10);
    assert.ok(got.self.startsWith("#11, the latest merged pull request, has runs its merge started still going (verify); #10 priced; this run ("), got.self);
    assert.ok(got.self.endsWith(") left out, still going"), got.self);
  });

  it("walks back past two merges minutes apart, and names each one passed over once", () => {
    // #12 merged as m3 and #11 as m2 minutes apart: m3 started pages (50, collecting) and verify (51); m2's verify (41) is still going.
    const twelve = { ...PULLS[1], number: 12, merge_commit_sha: "m3", head: { ref: "feat/twelve" }, created_at: T("11:40:00"), merged_at: T("11:55:00") };
    const pulls = [twelve, PULLS[1], PULLS[0]];
    const burst = [...RUNS, run(41, 6, "verify", "push", "m2", null, T("11:51:00"), T("11:52:00")), run(50, 5, "pages", "push", "m3", null, T("11:55:00"), T("11:56:00")), run(51, 6, "verify", "push", "m3", null, T("11:55:00"), T("11:56:00"))];
    const got = latestPriced(pulls, burst, -Infinity, "merged pull request", 50);
    assert.equal(got.pull.number, 10);
    assert.deepEqual(got.runs.map((r) => r.id).sort((a, b) => a - b), [1, 2, 9]);
    assert.equal(got.self, "#12, the latest merged pull request, has runs its merge started still going (verify); #11, the latest merged pull request, has runs its merge started still going (verify); #10 priced");
  });

  it("prices runs from their own jobs, and leaves the dollars unknown for a runner with no list price", () => {
    // #11's runs: 3 (unit-tests, 12 billed minutes on ubuntu-latest) and 4 (dependency-scan, 1 on ubuntu-slim).
    const cost = priceRuns([describeRun(RUNS[2], JOBS[3]), describeRun(RUNS[3], JOBS[4])]);
    assert.deepEqual([cost.minutes, Math.round(cost.dollars * 1000) / 1000, cost.unpriced], [13, 0.074, null]);
    assert.deepEqual([...cost.byWorkflow.keys()], ["unit-tests", "dependency-scan"]);
    const odd = priceRuns([describeRun(RUNS[2], JOBS[3].map((j) => ({ ...j, labels: ["self-hosted", "linux"] })))]);
    assert.match(odd.unpriced, /job unit-tests of unit-tests ran on self-hosted, linux/);
    assert.equal(odd.minutes, 12, "its minutes still count");
  });

  it("prices a job by its runs-on label, and no price for a runner the list does not name", () => {
    assert.equal(runnerRate(["ubuntu-slim"]), 0.002);
    assert.equal(runnerRate(["ubuntu-latest"]), 0.006);
    assert.equal(runnerRate(["ubuntu-24.04"]), 0.006);
    assert.equal(runnerRate(["ubuntu-24.04-arm"]), 0.005);
    assert.equal(runnerRate(["windows-latest"]), 0.01);
    assert.equal(runnerRate(["macos-14"]), 0.062);
    assert.equal(runnerRate(["self-hosted", "linux"]), null);
    assert.equal(runnerRate(["macos-14-xlarge"]), null, "a larger runner is not a standard price");
    assert.equal(runnerRate(null), null);
  });

  it("finds which pull request and push triggers skip work when nothing changed", () => {
    // cloud-test has a paths filter; e2e's shards wait on its changes job;
    // dependency-scan and unit-tests (in this fixture) run their work every time.
    assert.deepEqual(
      skipTriggers(ROOT, "main").map((r) => [r.workflow, r.trigger, r.how]),
      [
        ["cloud-test", "pull request", "paths filter"],
        ["dependency-scan", "pull request", null],
        ["e2e", "pull request", "changes job"],
        ["unit-tests", "pull request", null],
        ["unit-tests", "push to main", null],
      ],
    );
  });

  it("reads setup-node's cache line, color codes and all", () => {
    assert.equal(cacheVerdict(LOGS[105]), "hit");
    assert.equal(cacheVerdict(LOGS[103]), "miss");
    assert.equal(cacheVerdict("no cache line here"), null);
  });

  it("reads a hook's code and the scripts it sources, never comments", () => {
    const cfg = settings(PARAMS);
    const opts = { branch: "main", says: cfg.hookSays, checks: cfg.hookChecks };
    // Known bad: a check and main named only in comments run nothing.
    assert.equal(hookRuns("pre-push", hookCode(ROOT, ".githooks", "# refs/heads/main\n# run_checker \"x\"\nexit 0\n"), opts), "pre-push");
    // Known good: the sourced router's checks, in the order it runs them.
    assert.equal(hookRuns("pre-commit", hookCode(ROOT, ".githooks", '. "$REPO_ROOT/.githooks/route.sh"\n'), opts), "checks content, secret, contract");
    // A default branch other than main.
    assert.equal(hookRuns("pre-push", 'if [ "$r" = "refs/heads/trunk" ]; then exit 1; fi', { branch: "trunk" }), "refuses a push to trunk");
    assert.equal(hookRuns("pre-push", 'if [ "$r" = "refs/heads/trunk" ]; then exit 1; fi'), "pre-push", "no branch named, no branch check");
    assert.throws(() => skipTriggers(ROOT), /needs the repo's default branch/);
    assert.throws(() => pipelineStages(ROOT, settings(PARAMS)), /needs cfg.branch/);
  });

  it("reads a reusable workflow's shards, or the default its expression falls back to", () => {
    assert.equal(shardCount("${{ inputs.shards || '2' }}"), 2);
    assert.equal(shardCount("3"), 3);
    assert.equal(shardCount(4), 4);
    assert.equal(shardCount("${{ inputs.shards }}"), null);
    assert.equal(shardCount(undefined), null);
  });

  it("names a job's matrix copies and orders jobs by what they need", () => {
    assert.deepEqual(jobNames("shard", { name: "e2e: shard ${{ matrix.shard }}/2", strategy: { matrix: { shard: [1, 2] } } }), ["e2e: shard 1/2", "e2e: shard 2/2"]);
    assert.deepEqual(jobNames("tests", { strategy: { matrix: { os: ["a", "b"], node: [24, 26] } } }), ["tests (1 of 4)", "tests (2 of 4)", "tests (3 of 4)", "tests (4 of 4)"]);
    assert.deepEqual(jobNames("build", {}), ["build"]);
    const jobs = Object.entries({
      build: { "runs-on": "ubuntu-latest" },
      deploy: { needs: "build", if: "github.event_name != 'pull_request'" },
    });
    assert.deepEqual(jobGraph(jobs, "push").map((level) => level.map(([id]) => id)), [["build"], ["deploy"]]);
    assert.deepEqual(jobGraph(jobs, "pull_request").map((level) => level.map(([id]) => id)), [["build"]], "the Pages deploy never runs on a pull request");
  });

  it("starts the runs that cover every workflow where the shallowest full list starts", () => {
    const at = (hms) => ({ created_at: T(hms) });
    const since = Date.parse("2026-10-19T20:00:00Z");
    // A full list (cap 2) reaching back to 12:00, and a short list reaching further.
    assert.equal(commonStart([[at("13:00:00"), at("12:00:00")], [at("09:00:00")]], since, 2), Date.parse(T("12:00:00")));
    assert.equal(commonStart([[at("13:00:00")], [at("09:00:00")]], since, 2), since, "no full list: since stands");
    assert.equal(commonStart([[at("13:00:00")], [at("09:00:00")]], -Infinity, 2), -Infinity, "no full list and no since: every run counts");
  });

  it("weights each workflow's light share by its runs, not by its sample", () => {
    // Workflow A: 2 of its 10 runs sampled, 1 light. B: both of its 2 runs, none light.
    // (0.5 x 10 + 0 x 2) / 12 = 41.7%; an unweighted sample would say 1 of 4, 25%.
    const sample = [
      { workflow: "A", event: "pull_request", light: true },
      { workflow: "A", event: "pull_request", light: false },
      { workflow: "B", event: "pull_request", light: false },
      { workflow: "B", event: "pull_request", light: false },
    ];
    const runs = [
      ...Array.from({ length: 10 }, () => ({ workflow: "A", event: "pull_request", status: "completed" })),
      ...Array.from({ length: 2 }, () => ({ workflow: "B", event: "pull_request", status: "completed" })),
      { workflow: "A", event: "pull_request", status: "in_progress" },
    ];
    const got = weightedLightShare(sample, runs);
    assert.equal(got.share, 41.7);
    assert.deepEqual(got.detail.map((d) => [d.label, d.value]), [["A", 50], ["B", 0]]);
  });

  it("parses the pipeline from the hook and workflow files and the stages the params name", () => {
    const stages = pipelineStages(ROOT, { ...settings(PARAMS), branch: "main" });
    assert.deepEqual(
      stages.map((s) => [s.stage, s.label]),
      [
        ["edit", "content-guard.sh"],
        ["commit", "pre-commit"],
        ["push", "pre-push"],
        ["ci", "cloud-test"],
        ["ci", "dependency-scan"],
        ["ci", "e2e"],
        ["ci", "unit-tests"],
        ["merge", "unit-tests"],
        ["review", "Review and merge"],
        ["deploy", "Deploy to staging"],
      ],
    );
    // The pre-push's comment names run_checker "unit"; only the router's code counts.
    assert.equal(stages[2].runs, "refuses a push to main; refuses a push of any commit but HEAD; checks content, secret, contract");
    assert.equal(stages[0].runs, "PostToolUse on Write|Edit: content-guard.sh");
    assert.equal(
      stages[3].runs,
      "On every pull request touching .github/workflows/cloud-test.yml: cloud-test calls fixture-org/.github/.github/workflows/cloud-test.yml in 2 shards",
    );
    assert.equal(stages[4].runs, "On every pull request: dependency-scan on ubuntu-latest: Scan changed files");
    assert.equal(
      stages[5].runs,
      "On every pull request: e2e: changes on ubuntu-slim, then e2e: shard 1/2 and e2e: shard 2/2 in parallel on a runner chosen at run time, if there is work, then e2e on ubuntu-slim",
    );
    assert.equal(stages[6].runs, "On every pull request: unit-tests on ubuntu-latest: uses actions/checkout, Type check");
    assert.ok(stages.filter((s) => s.stage === "ci" || s.stage === "merge").every((s) => s.kind === "workflow"));
  });
});

// ---------------------------------------------------------------- collect

describe("fail open", () => {
  it("names the workflow whose runs could not be read, never reads them as none", async () => {
    const { [RUNS_OF(2)]: _gates, ...rest } = REST;
    const got = await collectWith({ gh: fakeGh({ rest }) });
    for (const id of ["ci.latest_flow", "ci.latest_full_run_minutes", "ci.main_red_minutes", "ci.light_run_share", "ci.flaky_reruns"]) {
      assert.match(got[id].could_not_check, /workflow dependency-scan \(id 2\)/, id);
      assert.equal(got[id].value, undefined, id);
    }
  });

  it("turns a missing gh into could_not_check on every metric, never a 0 or a throw", async () => {
    const missing = new GhError("gh is not installed; install the GitHub CLI and run gh auth login");
    const gh = { rest: async () => Promise.reject(missing), text: async () => Promise.reject(missing), graphql: async () => Promise.reject(missing) };
    const got = await collect({ root: ROOT, mode: "local", gh, now: NOW, repo: REPO });
    for (const id of METRIC_IDS) {
      assert.equal(typeof got[id].could_not_check, "string", id);
      assert.equal(got[id].value, undefined, id);
    }
    assert.match(got["ci.skip_unchanged_share"].could_not_check, /gh is not installed/, "no default branch to judge push triggers by");
    // With the branch named in params, a state of the repo's files needs no gh.
    const named = await collect({ root: ROOT, mode: "local", params: { ...TEMPLATE_PARAMS, default_branch: "main" }, gh, now: NOW, repo: REPO });
    assert.equal(named["ci.skip_unchanged_share"].value, 40);
  });

  it("tells a spent rate limit from a refusal, though both are HTTP 403", () => {
    assert.match(reasonFor(new GhError("API rate limit exceeded for user ID 1.", { status: 403 })), /rate limit is spent/);
    assert.match(reasonFor(new GhError("Resource not accessible by integration", { status: 403 })), /HTTP 403\): Resource not accessible/);
    assert.match(reasonFor(new GhError("Not Found", { status: 404 })), /HTTP 404/);
    assert.equal(reasonFor(new GhError("Bad credentials", { status: 401 })), "gh is not signed in: run gh auth login");
  });

  it("skips with a reason when no run was read", async () => {
    const rest = { ...REST, [RUNS_OF(1)]: { workflow_runs: [] }, [RUNS_OF(2)]: { workflow_runs: [] } };
    const got = await collectWith({ gh: fakeGh({ rest }) });
    for (const id of ["ci.latest_flow", "ci.latest_full_run_minutes", "ci.main_red_minutes", "ci.light_run_share", "ci.flaky_reruns", "ci.cache_hit_rate"]) {
      assert.equal(typeof got[id].could_not_check, "string", id);
      assert.equal(got[id].value, undefined, id);
    }
  });
});

describe("ci.pr_run_requests", () => {
  const only = TARGETS.filter((t) => t.id === "ci.pr_run_requests");
  const notice = { title: "GitHub requests", message: "live 12 REST, 3 GraphQL; 140 replayed from main (replay)" };
  // Runs 91 to 94, newest first; `noted` names the runs whose one job printed a notice.
  const prRest = (noted) => ({
    [`repos/${REPO}/actions/workflows/pages.yml/runs?event=pull_request&status=success&per_page=10`]: { workflow_runs: [91, 92, 93, 94].map((id) => ({ id, head_repository: { full_name: REPO } })) },
    ...Object.fromEntries([91, 92, 93, 94].flatMap((id) => [
      [`repos/${REPO}/actions/runs/${id}/jobs?per_page=100`, { jobs: [{ id: id * 10, name: "build", conclusion: "success" }, { id: id * 10 + 1, name: "deploy", conclusion: "skipped" }] }],
      [`repos/${REPO}/check-runs/${id * 10}/annotations`, noted.includes(id) ? [notice] : []],
    ])),
  });

  it("reads the newest run whose jobs printed a notice", async () => {
    const got = (await collectWith({ targets: only, gh: fakeGh({ rest: prRest([92, 93]) }) }))["ci.pr_run_requests"];
    assert.equal(got.value, 15);
    assert.match(got.source, /; run 92$/);
  });

  it("skips after 3 runs with no notice and never reads a 4th", async () => {
    const calls = [];
    const got = (await collectWith({ targets: only, gh: fakeGh({ rest: prRest([94]) }, calls) }))["ci.pr_run_requests"];
    assert.equal(got.value, undefined);
    assert.match(got.could_not_check, /runs 91, 92, 93 printed no GitHub requests notice/);
    assert.ok(!calls.some((c) => /\/94\/jobs|\/940\//.test(c)), "run 94 is not read");
  });
});

// ---------------------------------------------------------------- settings

describe("targets/ci.json", () => {
  it("puts each metric on its tab with a group, a plain meaning and a goal source", () => {
    for (const t of TARGETS) {
      assert.ok(["actions", "pull-requests", "issues", "projects", "scanning", "code", "insights"].includes(t.tab), t.id);
      // GitHub files its Actions usage view under Insights, so that one metric sits on that tab, grouped by view.
      const view = t.id === "insights.failed_minutes_share";
      assert.equal(t.tab === "insights", view, `${t.id}: no other metric here goes on the Insights tab`);
      assert.ok(t.tab === "actions" || t.kind === "consumption" || view, `${t.id}: only runner cost and the Insights views go on another tab`);
      assert.ok((view ? ["Actions usage"] : ["Reliable", "Fast", "Cost"]).includes(t.group), t.id);
      assert.ok(t.means.length <= 120 && t.means.trim(), t.id);
      assert.ok(t.goal_source.trim(), t.id);
      assert.ok(!/[–—]/.test(JSON.stringify(t)), `${t.id} has a dash`);
    }
    assert.equal(TARGETS.find((t) => t.id === "ci.latest_flow").chart, "flow");
    assert.deepEqual(
      TARGETS.filter((t) => t.kind === "consumption").map((t) => t.id),
      ["ci.latest_pr_dollars", "issues.latest_fix_ci_minutes", "projects.latest_card_ci_minutes", "security.latest_scan_minutes", "code.quality_scan_minutes", "ci.light_run_share", "ci.latest_main_push_minutes", "ci.skip_unchanged_share", "insights.failed_minutes_share", "ci.runner_cents_per_minute", "ci.api_headroom", "ci.pr_run_requests"],
    );
    // Half the billed minutes on ubuntu-slim, near every minute at the standard Linux 2-core rate.
    const rate = TARGETS.find((t) => t.id === "ci.runner_cents_per_minute");
    assert.equal(rate.goal, Math.round(((runnerRate(["ubuntu-slim"]) + runnerRate(["ubuntu-latest"])) / 2) * 1000) / 10);
    assert.equal(rate.near, Math.round(runnerRate(["ubuntu-latest"]) * 1000) / 10);
    // The dollars goal is 60 runner minutes, near 100, at the standard Linux 2-core rate.
    const dollars = TARGETS.find((t) => t.id === "ci.latest_pr_dollars");
    assert.equal(dollars.goal, Math.round(60 * runnerRate(["ubuntu-latest"]) * 100) / 100);
    assert.equal(dollars.near, Math.round(100 * runnerRate(["ubuntu-latest"]) * 100) / 100);
    assert.equal(TARGETS.find((t) => t.id === "ci.included_days_left"), undefined, "a projection from one day's spend is removed");
  });

  it("holds its params on ci.latest_flow, with defaults that fit any repo", () => {
    assert.deepEqual(TARGETS.filter((t) => t.params).map((t) => t.id), ["ci.latest_flow"]);
    const cfg = settings(TARGETS.find((t) => t.params).params);
    assert.deepEqual([cfg.branch, cfg.hooksDir, cfg.hookSays, cfg.hookChecks, cfg.deployApps], [null, ".githooks", [], null, []], "no branch named: it is read from the repo");
    assert.ok(["CodeQL", "secret-scan", "Dependency Review"].every((w) => cfg.securityWorkflows.test(w)));
    assert.ok(!["unit-tests", "e2e", "build"].some((w) => cfg.securityWorkflows.test(w)));
    assert.deepEqual(cfg.stages.map((s) => s.key), ["review"]);
    assert.doesNotMatch(JSON.stringify(TARGETS), /orchestrator|lane\b|CLAUDE\.md|PR #\d/i);
  });

  it("has no calendar window: every source names its last N or says state, and nothing draws a spark", () => {
    for (const t of TARGETS) {
      assert.match(t.source, /\blast \d+\b|^state\b|^latest\b/, t.id);
      assert.ok(t.kind !== "consumption" || /\blast (10|20)\b|^state\b|^latest\b/.test(t.source), `${t.id}: Consumption reads the last 20 runs, a state or the latest event`);
      assert.doesNotMatch(t.source, /at most \d+ days|this month|month end|projected/i, t.id);
      assert.notEqual(t.chart, "spark", t.id);
    }
    assert.equal(TARGETS.find((t) => t.id === "ci.actions_month_end_share"), undefined, "a month projection is removed");
    assert.equal(TARGETS.find((t) => t.id === "ci.actions_top_repo_share"), undefined, "a month total is removed");
  });
});

describe("flakyChecks", () => {
  it("counts a later pass on a push, and on a pull request only a rerun", async () => {
    const run = (id, event, sha, conclusion, created, attempt = 1) => ({ id, workflow: "e2e", event, head_sha: sha, status: "completed", conclusion, run_attempt: attempt, created_at: created });
    const runs = [
      run(1, "push", "p", "failure", "2026-11-02T21:40:00Z"),
      run(2, "push", "p", "success", "2026-11-02T22:00:00Z"),
      // Run 4 tests q merged into a later main than run 3 did, so its pass is no evidence.
      run(3, "pull_request", "q", "failure", "2026-11-02T21:43:00Z"),
      run(4, "pull_request", "q", "success", "2026-11-02T22:04:00Z"),
      run(5, "pull_request", "r", "success", "2026-11-02T22:10:00Z", 2),
    ];
    const gh = { rest: async (route) => ({ conclusion: route.includes("/runs/5/") ? "failure" : "success" }) };
    const { pairs, flaky } = await flakyChecks(gh, "o/r", runs);
    assert.equal(pairs.size, 3);
    assert.deepEqual(flaky.map(([k]) => k.split("\n")[1]).sort(), ["p", "r"]);
  });
});
