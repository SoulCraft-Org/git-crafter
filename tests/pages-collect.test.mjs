// node --test tests/pages-collect.test.mjs: the collector, the workflow
// reader, and the run's scope, phases and flags. CI runs every
// tests/pages*.test.mjs through tools/verify.sh. They sit outside pages/, so
// the kit a repo installs from pages/ carries no test that needs Git Crafter's
// own files.

import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  aiAuthors,
  ciMetrics,
  collect,
  collectApi,
  configScope,
  ownQuality,
  failedRun,
  fetchSite,
  finishCollect,
  deployMetrics,
  modelMetrics,
  ghClient,
  ORG,
  TEST_WORKFLOW,
  prMetrics,
  pushToGreen,
  RETRY_MS,
  listRepos,
  ownTokens,
  parseArgs,
  readDocs as readDocsFrom,
  readSiteFromDisk,
  SCOPE,
  scopeFrom,
  siteMetrics,
} from "../tools/collect_org.mjs";
import { fetchRuns } from "../tools/org_fetch.mjs";
import { runMany } from "../tools/org_many.mjs";
import { TEST_PATTERN, hookText, jobNames, jobsText, readWorkflow, repoFlow, repoTests, runsFor, workflowStats } from "../tools/workflows.mjs";
import { build } from "../pages/build.mjs";
import { ciFlow } from "../quality/render/ci-flow.mjs";
import { rate } from "../pages/model.mjs";
import { codeLiteral } from "../quality/collectors/lib/strip.mjs";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const NOW = new Date("2026-11-03T12:00:00Z");
const ago = (h) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const readAt = NOW.toISOString();
const readJson = (name) => JSON.parse(readFileSync(join(ROOT, name), "utf8"));


test("a gh read retries a 5xx once, never a 4xx or a rate limit", () => {
  const fail = (stderr) => Object.assign(new Error("gh failed"), { stderr });
  const client = (outcomes) => {
    const waits = [];
    let i = 0;
    const gh = ghClient(() => {
      const o = outcomes[i++];
      if (o instanceof Error) throw o;
      return o;
    }, (ms) => waits.push(ms));
    return { gh, waits, tries: () => i };
  };
  const ok = client([fail("gh: Internal Server Error (HTTP 500)"), '{"a":1}']);
  assert.deepEqual(ok.gh.rest("x"), { a: 1 }, "the retry's answer is used");
  assert.deepEqual(ok.waits, [RETRY_MS]);
  assert.equal(ok.gh.calls, 2);
  const twice = client([fail("gh: Bad Gateway (HTTP 502)"), fail("gh: Bad Gateway (HTTP 502)"), '{"a":1}']);
  assert.throws(() => twice.gh.rest("x"), /gh failed/, "a second 5xx reaches the caller");
  assert.equal(twice.tries(), 2, "one retry only");
  for (const stderr of ["gh: Not Found (HTTP 404)", "gh: API rate limit exceeded for user ID 1. (HTTP 403)"]) {
    const no = client([fail(stderr), '{"a":1}']);
    assert.throws(() => no.gh.rest("x"), /gh failed/, stderr);
    assert.deepEqual(no.waits, [], `${stderr} is never retried`);
  }
});

// A fake actions/runs endpoint: `perDay` runs a day from START, newest first, 100 a page.
const runsServer = (perDay, start) => {
  const runs = [];
  for (let d = 0; d < 28; d += 1) {
    for (let i = 0; i < perDay; i += 1) {
      const at = start + d * 86_400_000 + Math.floor(((i + 0.5) * 86_400_000) / perDay);
      runs.push({ id: runs.length + 1, name: "ci", path: ".github/workflows/ci.yml", event: "push", status: "completed", conclusion: "success", head_sha: "a", created_at: new Date(at).toISOString(), run_started_at: null, updated_at: null });
    }
  }
  return (path) => {
    const q = new URL(`https://x/${path}`).searchParams;
    const [from, to] = q.get("created").split("..").map(Date.parse);
    const hit = runs.filter((r) => Date.parse(r.created_at) >= from && Date.parse(r.created_at) <= to).reverse();
    const page = Number(q.get("page"));
    return { t: hit.length, r: hit.slice((page - 1) * 100, page * 100) };
  };
};

test("fetchRuns reads every run, and each round of pages goes out in one batch", () => {
  const start = Date.parse("2026-10-01T00:00:00Z");
  const now = start + 28 * 86_400_000;
  for (const perDay of [30, 180]) {
    const answer = runsServer(perDay, start);
    const batches = [];
    const gh = { rest: (path) => (batches.push([path]), answer(path)), restMany: (paths) => (batches.push(paths), paths.map(answer)) };
    const got = fetchRuns(gh, "code-os", start, now);
    assert.equal(got.length, 28 * perDay, `${perDay} a day: every run, none twice`);
    assert.equal(new Set(got.map((r) => r.id)).size, got.length);
    const calls = batches.flat().length;
    assert.ok(batches.length <= 5, `${perDay} a day: ${batches.length} rounds for ${calls} reads, not one round a read`);
    assert.ok(batches.every((b) => b.length <= 100), "a batch holds at most 100 reads");
  }
});

test("restMany keeps the order, runs reads side by side, and a failure reaches the caller", () => {
  const sleepy = (ms, out) => ["-e", `setTimeout(() => process.stdout.write(${codeLiteral(out)}), ${ms})`];
  // The sleeps sum to 4,500 ms, the floor for reads one by one on any runner. Side by side they take the longest,
  // 1,500 ms, plus process startups: about 1,500 ms more on a busy 1-core runner (#861, 1,781 ms for 300 ms
  // sleeps). The 4,000 ms bound sits 1,000 ms above that and 500 ms under the serial floor. The second read ends
  // first, so the order check means something.
  const t0 = Date.now();
  const outs = runMany(process.execPath, [sleepy(1500, '{"n":1}'), sleepy(1000, '{"n":2}'), sleepy(1000, '{"n":3}'), sleepy(1000, '{"n":4}')], { limit: 4 });
  const took = Date.now() - t0;
  assert.deepEqual(outs.map((o) => JSON.parse(o).n), [1, 2, 3, 4], "answers in the order asked");
  assert.ok(took < 4000, `four reads side by side took ${took} ms; one by one they take at least 4,500`);
  assert.throws(() => runMany(process.execPath, [["-e", "process.stderr.write('gh: Not Found (HTTP 404)'); process.exit(1)"]], { limit: 2 }), /HTTP 404/);
  const seq = [];
  const gh = ghClient((cmd, args) => (seq.push(args[1]), '{"a":1}'));
  assert.deepEqual(gh.restMany(["p", "q"]), [{ a: 1 }, { a: 1 }], "a stand-in exec reads one by one");
  assert.deepEqual(seq, ["p", "q"]);
  assert.equal(gh.calls, 2);
});

test("push to green counts a commit only when every run passed", () => {
  const run = (sha, conclusion, created, updated, event = "push") => ({ head_sha: sha, status: "completed", conclusion, event, created_at: ago(created), updated_at: ago(updated) });
  const g = pushToGreen([run("a", "success", 1, 0.9), run("a", "skipped", 1, 0.95), run("b", "success", 2, 1.9), run("b", "failure", 2, 1.8), run("c", "cancelled", 3, 2.9), run("d", "success", 4, 3, "schedule")]);
  assert.deepEqual(g.map((x) => x.sha), ["a"]);
  assert.equal(Math.round(g[0].minutes), 6);
});

test("PR flow: the latest merge, conflicts, stacks, and an empty repo reads conflict-free", () => {
  const merged = { one: [{ number: 1, createdAt: ago(10), mergedAt: ago(8), rollup: "SUCCESS" }, { number: 2, createdAt: ago(30), mergedAt: ago(26), rollup: "FAILURE" }], two: [] };
  const open = { one: [{ number: 3, title: "<b>x</b>", createdAt: ago(48), baseRefName: "main", mergeable: "CONFLICTING" }, { number: 4, title: "y", createdAt: ago(5), baseRefName: "feature", mergeable: "MERGEABLE" }, { number: 5, title: "z", createdAt: ago(4), baseRefName: "feature", mergeable: "MERGEABLE", stack: { number: 1 } }], two: [] };
  const m = prMetrics({ repos: ["one", "two"], merged, open, defaults: { one: "main", two: "main" }, now: NOW, readAt });
  // The latest merge, one#1, took 2 hours; one#2, merged earlier, took 4.
  assert.equal(m["pr.latest_merge_hours"].value, 2);
  assert.deepEqual(m["pr.latest_merge_hours"].detail, [{ label: "one#1", value: 2, unit: "h" }]);
  assert.equal(m["pr.green_at_merge"].value, 50);
  assert.equal(m["pr.conflicts_open"].value, 1);
  assert.equal(m["pr.stacked_open"].value, 1);
  assert.deepEqual(m["pr.stacked_open"].detail.map((d) => d.label), ["one#4 onto feature"], "one#5 is a GitHub stack layer, so it is no hand-made stack");
  assert.equal(m["pr.conflict_free_share"].by_repo.two, 100);
  assert.equal(m["pr.latest_merge_hours"].by_repo.two, null, "a repo with no merge has no latest one");
  // How often work merges, read now: fewer than 10 merges read, so at least the 6 weeks read.
  assert.deepEqual([m["pr.latest_10_merges_hours"].value, m["pr.latest_10_merges_hours"].detail[0].label], [1008, "fewer than 10 merges in the 6 weeks read: at least"]);
  assert.deepEqual([m["pr.latest_10_merges_hours"].bound, m["pr.latest_10_merges_hours"].bound_repos], [true, ["one", "two"]], "a bound says so, for the org and each repo");
  // A share reads each repo's last 20 merges, never a calendar window: the 5 oldest of 25 failed.
  const many = { one: Array.from({ length: 25 }, (_, i) => ({ number: i + 1, createdAt: ago(100 - i), mergedAt: ago(99 - i), rollup: i < 5 ? "FAILURE" : "SUCCESS" })) };
  const mm = prMetrics({ repos: ["one"], merged: many, open: { one: [] }, defaults: { one: "main" }, now: NOW, readAt });
  assert.equal(mm["pr.green_at_merge"].value, 100);
  // The 10th-latest of 25 is one#16, merged 84 hours before the read: a stall after it would show.
  assert.deepEqual([mm["pr.latest_10_merges_hours"].value, mm["pr.latest_10_merges_hours"].detail[0].label], [84, "one#16, the 10th-latest merge"]);
  assert.deepEqual([mm["pr.latest_10_merges_hours"].bound, mm["pr.latest_10_merges_hours"].bound_repos], [undefined, undefined], "a value read is no bound");
});

test("a failed read is null, never zero: totals name the repo, rates leave it out", () => {
  const merged = { one: [{ number: 1, createdAt: ago(10), mergedAt: ago(8), rollup: "SUCCESS" }], two: [{ number: 2, createdAt: ago(5), mergedAt: ago(4), rollup: "SUCCESS" }] };
  const open = { one: [{ number: 3, title: "t", createdAt: ago(5), baseRefName: "main", mergeable: "CONFLICTING" }], two: null };
  const m = prMetrics({ repos: ["one", "two"], merged, open, defaults: { one: "main", two: "main" }, now: NOW, readAt, failures: { open: { two: "HTTP 502" } } });
  for (const id of ["pr.open", "pr.conflicts_open", "pr.stacked_open", "pr.conflict_free_share"]) {
    assert.match(m[id].could_not_check, /two \(HTTP 502\)/, id);
    assert.equal(m[id].by_repo.two, null, id);
  }
  assert.equal(m["pr.open"].by_repo.one, 1);
  assert.equal(m["pr.latest_10_merges_hours"].value, 1008, "two merges read across both repos: at least the 6 weeks read, never could_not_check");
  const none = prMetrics({ repos: ["one", "two"], merged: { one: null, two: null }, open, defaults: {}, now: NOW, readAt, failures: { merged: { one: "rate limit", two: "rate limit" } } });
  assert.match(none["pr.latest_merge_hours"].could_not_check, /could not read: one \(rate limit\); two \(rate limit\)/);
  const runs = { a: [{ name: "ci", path: "ci.yml", event: "push", status: "completed", conclusion: "success", head_sha: "x", created_at: ago(2), run_started_at: ago(2), updated_at: ago(1.9) }], b: null };
  const c = ciMetrics({ repos: ["a", "b"], runs, now: NOW, readAt, failures: { b: "HTTP 403" } });
  assert.equal(c["ci.pass_rate"].value, 100, "a rate is measured over the repos read");
  assert.match(c["ci.pass_rate"].source, /not read: b$/);
  assert.equal(c["ci.pass_rate"].by_repo.b, null);
  // The latest green commit, x in a: 6 minutes of push to green, measured over the repos read.
  assert.deepEqual([c["ci.latest_push_to_green_minutes"].value, c["ci.latest_commit_minutes"].value], [6, 6]);
  assert.match(c["ci.latest_commit_minutes"].source, /not read: b$/);
});

test("site metrics: claude.* and an id the pages name keep their ids; the site's blockers.* stays behind for Git Crafter's own", () => {
  const site = {
    repo: "example-site",
    commit: "abcdef1234",
    defs: [{ id: "claude.x", file: "claude.json", label: "X", unit: "%", direction: "higher", goal: 90, near: 80, goal_source: "g" }],
    data: { metrics: { "claude.x": { value: 95, source: "s" }, "blockers.costly": { value: 1, source: "s" }, "simplicity.restated_rules": { value: 0, source: "s" }, "code.y": { value: 1, source: "s" }, "pull_requests.fixed_after_review": { value: 45, source: "s" }, "pull_requests.open_now": { value: 3, source: "s" } } },
  };
  const m = siteMetrics(site, new Set(), "example-site");
  assert.deepEqual(Object.keys(m), ["claude.x"]);
  assert.deepEqual(Object.keys(siteMetrics(site, new Set(["pull_requests.fixed_after_review"]))), ["claude.x", "pull_requests.fixed_after_review"], "an id the pages name keeps its id; the rest stays behind");
  assert.deepEqual(m["claude.x"].target, { direction: "higher", goal: 90, near: 80, unit: "%", goal_source: "example-site quality/targets/claude.json: g" });
});

test("own tokens: Git Crafter's row of each tokens.* split, with the site's goal; account-wide entries stay behind", () => {
  const site = {
    commit: "abcdef1234",
    defs: [{ id: "tokens.latest_pr_rework_tokens", file: "tokens.json", label: "Rework tokens on the latest merged PR", unit: "tokens", direction: "lower", goal: 200000, near: 500000, goal_source: "g" }],
    data: { metrics: {
      "tokens.latest_pr_rework_tokens": { value: 2200000, by_repo: { "code-os": 1250000, "example-site": 2400000 }, detail: [{ label: "x" }], source: "s", read_at: "2026-11-03T14:30:00Z" },
      "tokens.waste_share": { value: 4, by_repo: { "example-site": 4.2 }, source: "s" },
      "tokens.plan_week_use": { value: 122.6, source: "s" },
    } },
  };
  const m = ownTokens(site, "code-os");
  assert.deepEqual(Object.keys(m), ["tokens.latest_pr_rework_tokens", "tokens.waste_share"]);
  assert.equal(m["tokens.latest_pr_rework_tokens"].value, 1250000);
  assert.equal(m["tokens.latest_pr_rework_tokens"].by_repo, undefined, "its own value, not the split");
  assert.equal(m["tokens.latest_pr_rework_tokens"].target.goal, 200000);
  assert.match(m["tokens.waste_share"].could_not_check, /no code-os value/, "a missing row is not measured, never 0");
});

test("goals that rate a copied site metric use the site's own goal", (t) => {
  // This public repo commits no data/ (.gitignore), so it has nothing to compare.
  if (!existsSync(join(ROOT, "data/org.json"))) return t.skip("this checkout commits no data/org.json");
  const data = readJson("data/org.json");
  // Could not verify is not a failure: a run that could not read the site's data has no targets to compare.
  const unread = data.errors?.find((e) => e.startsWith("site quality data"));
  if (unread) return t.skip(`the committed data could not read the site: ${unread}`);
  const copied = readJson("goals.json").outcomes.flatMap((o) => o.goals).filter((g) => data.metrics[g.metrics[0]]?.target);
  assert.ok(copied.length >= 8, `found ${copied.length}`);
  for (const g of copied) {
    const t = data.metrics[g.metrics[0]].target;
    assert.deepEqual([g.direction, g.goal, g.near], [t.direction, t.goal, t.near], g.id);
  }
});

const WF = `name: site-tests
on: # a comment
  pull_request:
    paths: ["site/**"]
  push:
    branches: [main]
  workflow_dispatch:
jobs:
  changes:
    runs-on: ubuntu-slim
    steps:
      - name: Diff
        run: |
          echo "jobs:"
  tests:
    needs: changes
    if: needs.changes.outputs.site == 'true'
    runs-on: \${{ fromJSON(needs.choose.outputs.runner) }} # blacksmith guard
    steps:
      - uses: actions/checkout@abc
      - name: Unit tests
        run: npm test
      - name: Install deps
        run: npm ci
  cloud:
    uses: example-org/.github/.github/workflows/cloud-test.yml@0123
    with:
      shards: 2
`;

test("the workflow reader takes name, triggers, jobs, needs, runners and steps", () => {
  const wf = readWorkflow(WF);
  assert.equal(wf.name, "site-tests");
  assert.deepEqual(Object.keys(wf.events), ["pull_request", "push", "workflow_dispatch"]);
  assert.equal(wf.events.pull_request.paths, true);
  assert.deepEqual(wf.events.push.branches, ["main"]);
  assert.deepEqual(wf.jobs.map((j) => j.id), ["changes", "tests", "cloud"]);
  assert.deepEqual(wf.jobs[1].needs, ["changes"]);
  assert.deepEqual(wf.jobs[1].steps, ["Unit tests", "Install deps"]);
  assert.equal(wf.jobs[2].shards, 2);
  assert.equal(jobsText(wf.jobs, WF), "changes on ubuntu-slim and cloud calls shared cloud-test.yml in 2 shards, then tests on a runner the Blacksmith guard picks");
  assert.deepEqual(Object.keys(readWorkflow("on: [push, pull_request]\njobs: {}\n").events), ["push", "pull_request"]);
});

test("a job's if keeps it off an event, block conditions included: Git Crafter's own pages.yml", () => {
  const wf = readWorkflow(readFileSync(join(ROOT, ".github", "workflows", "pages.yml"), "utf8"));
  const deploy = wf.jobs.find((j) => j.id === "deploy");
  assert.equal(runsFor(deploy, "pull_request"), false);
  assert.equal(runsFor(deploy, "push"), true);
  assert.doesNotMatch(jobsText(wf.jobs, "", "pull_request"), /deploy/);
  assert.match(jobsText(wf.jobs, "", "push"), /, then [^,]*\bdeploy on ubuntu-slim$/, "deploy waits for the first stage (action-render shares its stage)");
  const block = readWorkflow("on:\n  pull_request:\n  push:\njobs:\n  ship:\n    if: >-\n      github.event_name == 'push' &&\n      github.ref == 'refs/heads/main'\n    runs-on: ubuntu-latest\n");
  assert.equal(block.jobs[0].if, "github.event_name == 'push' && github.ref == 'refs/heads/main'");
  assert.equal(runsFor(block.jobs[0], "pull_request"), false);
  assert.equal(runsFor(block.jobs[0], "push"), true);
});

test("job names read like GitHub's, never a raw expression", () => {
  assert.deepEqual(jobNames({ name: "e2e: shard ${{ matrix.shard }}/${{ strategy.job-total }}", matrix: [{ key: "shard", values: ["1", "2"] }] }), ["e2e: shard 1/2", "e2e: shard 2/2"]);
  assert.deepEqual(jobNames({ name: "Build ${{ inputs.target }}", matrix: [] }), ["Build …"]);
  assert.deepEqual(jobNames({ name: "t ${{ matrix.os }}", matrix: [{ key: "os", values: ["a", "b"] }, { key: "node", values: ["1", "2"] }] }), ["t … (4 in parallel)"]);
});

test("suites are found by job and step names too, in a workflow named CI", () => {
  const ci = "name: CI\non:\n  pull_request:\njobs:\n  web:\n    name: Web test\n    runs-on: ubuntu-latest\n    steps:\n      - name: Install\n        run: npm ci\n      - name: Vitest\n        run: npm test\n  swift:\n    name: Swift Test\n    runs-on: macos-26\n    steps:\n      - name: Build\n        run: swift build\n  docs:\n    runs-on: ubuntu-latest\n    steps:\n      - name: Publish\n        run: x\n";
  const t = repoTests({ workflows: [{ name: "ci.yml", text: ci }], hooks: [] }, new Map());
  assert.equal(t.rows.length, 1);
  assert.deepEqual(t.rows[0].jobs.map((j) => j.name), ["Web test", "Swift Test"]);
  assert.equal(t.rows[0].jobs[0].when, "every pull request");
});

test("a job that calls the CI standard is a test suite, as templates/ci/ci.yml has it", () => {
  const ci = "name: ci\non:\n  pull_request:\njobs:\n  ci:\n    uses: SoulCraft-Org/git-crafter/.github/workflows/ci-standard.yml@0123456789abcdef0123456789abcdef01234567 # v7.0.0\n    with:\n      short: node --test\n";
  const t = repoTests({ workflows: [{ name: "ci.yml", text: ci }], hooks: [] }, new Map());
  assert.equal(t.rows.length, 1);
  assert.equal(t.rows[0].suite, "ci");
});

test("hooks say what they run, and a pre-push without a test command runs no tests", () => {
  const router = { name: "x-route.sh", text: 'PY=python3\nroute_all() {\n  run_checker "content"\n  "$PY" "$REPO_ROOT/tools/check_packages.py"\n}\n' };
  assert.equal(hookText("pre-commit", '. "$REPO_ROOT/.githooks/x-route.sh"\nroute_all "pre-commit"\n', [router]), "runs content, check_packages.py through x-route.sh");
  const prePush = '#!/bin/sh\n# npm test used to run here\nif [ "$ref" = refs/heads/main ]; then exit 1; fi\nbash .githooks/route.sh\n';
  assert.equal(hookText("pre-push", prePush), "refuses a push to main; runs route.sh; runs no tests");
  assert.equal(hookText("pre-push", "npm run check:push\n"), "runs check:push");
});

test("pipelines: stats per workflow and trigger, drawn by the shared ci-flow", () => {
  const run = (event, conclusion, mins, h = 1) => ({ path: ".github/workflows/site-tests.yml", event, status: "completed", conclusion, created_at: ago(h), run_started_at: ago(h), updated_at: new Date(NOW.getTime() - h * 3_600_000 + mins * 60_000).toISOString() });
  const stats = workflowStats([run("pull_request", "success", 4, 3), run("pull_request", "success", 6, 1), run("pull_request", "failure", 1, 2), run("pull_request", "cancelled", 9, 0.5), run("dynamic", "failure", 1)]);
  // The latest passing run, an hour ago, took 6 minutes (the older one 4); 2 of the 3 decided runs passed.
  assert.deepEqual(stats.get(".github/workflows/site-tests.yml\npull_request"), { value: 6, pass_rate: 66.7, runs: 3 });
  // A pass rate reads the last 20 decided runs: the 5 oldest of 25 failed.
  const many = workflowStats(Array.from({ length: 25 }, (_, i) => run("push", i < 5 ? "failure" : "success", 2, 50 - i)));
  assert.deepEqual(many.get(".github/workflows/site-tests.yml\npush"), { value: 2, pass_rate: 100, runs: 20 });
  const files = { workflows: [{ name: "site-tests.yml", text: WF }, { name: "shot.yml", text: "name: <b>shots</b>\non:\n  workflow_dispatch:\njobs:\n  s:\n    runs-on: ubuntu-latest\n" }], hooks: [{ name: "pre-push", text: "bash x.sh\n" }] };
  const { detail, apart } = repoFlow(files, stats);
  assert.deepEqual(detail.map((d) => [d.label, d.stage]), [["pre-push", "push"], ["site-tests", "ci"], ["site-tests", "merge"], ["Pinned review and merge", "review"]]);
  assert.deepEqual(apart.map((d) => [d.label, d.stage]), [["<b>shots</b>", "On demand"]], "on-demand workflows are drawn apart from the rail");
  assert.equal(detail[1].value, 6);
  assert.equal(detail[2].value, null, "a trigger with no runs is not timed, never 0");
  const html = ciFlow([...detail, ...apart], { id: "ci-x", label: "x" });
  assert.match(html, /class="cf-node/);
  assert.ok(!html.includes("<b>shots</b>"), "workflow names are escaped");
  const t = repoTests({ ...files, cloudTest: '{"scripts":{"test:unit":{},"build":{}}}' }, stats);
  assert.deepEqual(t.rows.map((x) => x.suite), ["site-tests"]);
  assert.equal(TEST_WORKFLOW, TEST_PATTERN, "one test pattern");
  assert.match(t.rows[0].when, /every pull request that changes its inputs; every push to main; dispatch; skips its work when nothing it checks changed/);
  assert.equal(t.rows[0].checks, "Unit tests");
  assert.deepEqual(t.dispatch, ["test:unit", "build"]);
});

test("CI: cancelled runs leave the pass rate; test workflows match by name, Dependabot never", () => {
  const run = (name, conclusion, event = "push") => ({ name, path: `.github/workflows/${name}.yml`, event, status: "completed", conclusion, head_sha: name + conclusion, created_at: ago(2), run_started_at: ago(2), updated_at: ago(1.9) });
  const bot = run("npm_and_yarn in /. for @vitest/mocker - Update #123", "failure", "dynamic");
  const m = ciMetrics({ repos: ["r"], runs: { r: [run("site-tests", "success"), run("site-tests", "failure"), run("build", "success"), run("build", "cancelled"), bot] }, now: NOW, readAt });
  assert.equal(m["ci.pass_rate"].value, 50);
  assert.equal(m["tests.pass_rate"].value, 50, "a Dependabot run naming vitest is not a test run");
  assert.ok(m["ci.pass_rate"].detail.some((d) => d.label === "Dependabot updates (1 run)"));
  assert.equal(m["ci.cancelled_share"].value, 20);
  const none = ciMetrics({ repos: ["r"], runs: { r: [run("build", "success")] }, now: NOW, readAt });
  assert.match(none["tests.pass_rate"].could_not_check, /no workflow named for tests/);
  // Pass rates read the last 20 decided runs: 15 newer cancelled runs never push out the passes and failures.
  const at = (name, conclusion, h) => ({ name, path: `.github/workflows/${name}.yml`, event: "push", status: "completed", conclusion, head_sha: `${name}${h}`, created_at: ago(h), run_started_at: ago(h), updated_at: ago(h - 0.1) });
  const mix = [...Array.from({ length: 15 }, (_, i) => at("build", "cancelled", 1 + i * 0.01)), ...Array.from({ length: 5 }, (_, i) => at("build", "failure", 2 + i * 0.01)), ...Array.from({ length: 20 }, (_, i) => at("build", "success", 3 + i * 0.01))];
  const decided = ciMetrics({ repos: ["r"], runs: { r: mix }, now: NOW, readAt });
  assert.equal(decided["ci.pass_rate"].value, 75, "5 failures and the 15 newest passes of the last 20 decided");
  assert.equal(decided["ci.cancelled_share"].value, 75, "the cancelled share reads the last 20 completed runs");
});

test("push to green: a commit with a run still going is not green yet", () => {
  const run = (sha, status, conclusion, h) => ({ name: "ci", path: ".github/workflows/ci.yml", event: "push", status, conclusion, head_sha: sha, created_at: ago(h), run_started_at: ago(h), updated_at: ago(h - 0.1) });
  const m = ciMetrics({ repos: ["r"], runs: { r: [run("aaaaaaa1", "completed", "success", 5), run("bbbbbbb2", "completed", "success", 1), run("bbbbbbb2", "in_progress", null, 1)] }, now: NOW, readAt });
  assert.equal(m["ci.latest_push_to_green_minutes"].detail[0].label, "r aaaaaaa", "the newest commit, b, still has a run going");
  assert.equal(m["ci.latest_push_to_green_minutes"].value, 6);
});

test("deploys: a failed Workers Build fails the commit; staging builds never count", () => {
  const c = (h, conclusion, doneH, name = "Workers Builds: site") => ({ oid: String(h), committedDate: ago(h), message: "", deploys: [{ name, conclusion, completedAt: ago(doneH) }] });
  const m = deployMetrics({ repos: ["site", "none"], commits: { site: [c(5, "SUCCESS", 4.95), c(3, "FAILURE", 2.9), c(2, "FAILURE", 1.9, "Workers Builds: site-staging")], none: [] }, now: NOW, readAt });
  assert.equal(m["deploy.success_rate"].value, 50);
  assert.equal(m["deploy.latest_minutes"].value, 3, "the latest deploy that succeeded, 5 hours ago, took 3 minutes");
  assert.equal(m["deploy.success_rate"].by_repo.none, undefined);
  const staging = deployMetrics({ repos: ["site"], commits: { site: [c(5, "SUCCESS", 4.95, "Workers Builds: site-staging")] }, now: NOW, readAt });
  assert.match(staging["deploy.success_rate"].could_not_check, /staging are left out/);
});

test("the third-party share reads each repo's last 20 commits with an AI co-author", () => {
  // 25 such commits; the 5 oldest name opencode, the rest Claude.
  const commits = { r: Array.from({ length: 25 }, (_, i) => ({ oid: String(i), committedDate: ago(50 - i), message: `x\n\nCo-authored-by: ${i < 5 ? "opencode <bot@opencode.example>" : "Claude <noreply@anthropic.com>"}`, deploys: [] })) };
  const m = modelMetrics({ repos: ["r"], commits, now: NOW, readAt });
  assert.equal(m["models.third_party_share"].value, 0);
  assert.deepEqual(m["models.third_party_share"].detail, [{ label: "claude", value: 20, unit: "commits" }]);
  assert.equal(m["models.ai_commits"], undefined, "a count of commits is no ideal, so it is gone");
});

test("AI co-authors: Claude, a third-party model, and a person", () => {
  assert.deepEqual(aiAuthors("x\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"), ["claude"]);
  assert.deepEqual(aiAuthors("x\n\nCo-authored-by: opencode <bot@opencode.example>"), ["opencode"]);
  assert.deepEqual(aiAuthors("x\n\nCo-authored-by: Alex <p@example.com>"), []);
});

test("a missing data file is exit 3, not a crash", () => {
  const dir = mkdtempSync(join(tmpdir(), "cos-pages-"));
  try {
    cpSync(join(ROOT, "goals.json"), join(dir, "goals.json"));
    cpSync(join(ROOT, "process.json"), join(dir, "process.json"));
    cpSync(join(ROOT, "maps.json"), join(dir, "maps.json"));
    assert.equal(build({ root: dir, now: NOW }).code, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- A repo's own Process page (the kit, installed by claude_os_sync.py) ----

test("a repo's scope reads its own repos, never the org's list, and a branch it cannot read is main", () => {
  const calls = [];
  const gh = {
    restLines: (p) => (calls.push(p), []),
    rest: (p) => {
      calls.push(p);
      if (p.endsWith("/gone")) throw new Error("HTTP 404");
      return { name: p.split("/").pop(), default_branch: "trunk" };
    },
  };
  const errors = [];
  const list = listRepos(gh, scopeFrom({ repos: ["example-site", "gone"] }), errors);
  assert.deepEqual(list, [{ name: "example-site", default_branch: "trunk" }, { name: "gone", default_branch: "main" }]);
  assert.ok(!calls.some((p) => p.startsWith("orgs/")), "no org listing, which a repo's GITHUB_TOKEN cannot read");
  assert.match(errors[0], /gone default branch: HTTP 404/);
  assert.equal(SCOPE.repos, null, "Git Crafter's own run still lists the org");
});

test("--config picks a repo's scope; anything else is a usage error", () => {
  const dir = mkdtempSync(join(tmpdir(), "cos-scope-"));
  try {
    writeFileSync(join(dir, "c.json"), JSON.stringify({ repos: ["one"], site: { root: "." }, docs: { maps: "m.json" } }));
    const a = parseArgs(["--config", "c.json", "--dry-run"], dir);
    assert.equal(a.root, dir);
    assert.deepEqual([a.dry, a.scope.repos, a.scope.own_repo, a.scope.site, a.scope.docs.maps, a.scope.docs.goals], [true, ["one"], "one", { repo: "one", root: "." }, "m.json", join(ROOT, "goals.json")]);
    assert.deepEqual(ownQuality(dir, a.scope), { repo: "one", root: ".", data: ["quality/data/latest.json", "quality/data/local.json"], targets: "quality/targets" }, "with no Quality config, the template's paths");
    assert.equal(parseArgs([]).scope, SCOPE);
    for (const bad of [["--config"], ["--x"], ["--dry-run", "x"]]) assert.equal(parseArgs(bad, dir), null, bad.join(" "));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the site's data from disk: the first file that measured an id wins, a missing file is skipped", () => {
  const dir = mkdtempSync(join(tmpdir(), "cos-site-"));
  try {
    mkdirSync(join(dir, "quality", "targets"), { recursive: true });
    mkdirSync(join(dir, "quality", "data"));
    writeFileSync(join(dir, "quality", "targets", "ci.json"), JSON.stringify([{ id: "ci.latest_flow", goal: 1, near: 2, goal_source: "fixture" }]));
    const latest = { metrics: { "ci.latest_flow": { value: 7, read_at: ago(1) }, "claude.x": { could_not_check: "transcripts live on the Mac" } } };
    const local = { metrics: { "ci.latest_flow": { value: 5, read_at: ago(9) }, "claude.x": { value: 3, read_at: ago(9) } } };
    writeFileSync(join(dir, "quality", "data", "latest.json"), JSON.stringify(latest));
    writeFileSync(join(dir, "quality", "data", "local.json"), JSON.stringify(local));
    const site = { repo: "example-site", root: ".", targets: "quality/targets", data: ["quality/data/latest.json", "quality/data/gone.json", "quality/data/local.json"] };
    const got = readSiteFromDisk(dir, site, null, () => "abc1234\n");
    assert.equal(got.data.metrics["ci.latest_flow"].value, 7, "CI's fresh read comes first");
    assert.equal(got.data.metrics["claude.x"].value, 3, "a value the session measured beats CI's could_not_check");
    assert.equal(got.defs.find((d) => d.id === "ci.latest_flow").file, "ci.json");
    assert.ok(got.commit === process.env.GITHUB_SHA || got.commit === "abc1234");
    assert.equal(got.pagesUrl, null, "no gh, no Pages URL, no crash");
    assert.equal(got.defs_error, undefined);
    // An older targets file of full definitions: the overlay refuses it, and the numbers still read.
    writeFileSync(join(dir, "quality", "targets", "ci.json"), JSON.stringify([{ id: "ci.latest_pr_dollars", tab: "ci", kind: "consumption", label: "Dollars" }]));
    const old = readSiteFromDisk(dir, site, null, () => "abc1234\n");
    assert.deepEqual([old.defs, old.data.metrics["ci.latest_flow"].value], [[], 7], "the numbers read, unrated");
    assert.match(old.defs_error, /^quality\/targets: ci\.json: ci\.latest_pr_dollars: overrides the template metric/);
    assert.throws(() => readSiteFromDisk(dir, { ...site, data: ["quality/data/gone.json"] }), /none of/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a --config that is not JSON, or names no repos, is refused; public.* is off unless asked", () => {
  const dir = mkdtempSync(join(tmpdir(), "cos-scope-"));
  try {
    writeFileSync(join(dir, "bad.json"), "{ repos: [");
    assert.throws(() => parseArgs(["--config", "bad.json"], dir), SyntaxError);
    for (const [name, body] of [["none.json", { site: { root: "." } }], ["empty.json", { repos: [] }], ["path.json", { repos: ["../x"] }], ["list.json", ["one"]]]) {
      writeFileSync(join(dir, name), JSON.stringify(body));
      assert.throws(() => parseArgs(["--config", name], dir), /--config/, name);
    }
    assert.equal(configScope({ repos: ["one"] }).public, false);
    assert.equal(configScope({ repos: ["one"], public: true }).public, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a repo's own run makes no org-wide call, reads its own alerts, and runs only the rate and Quality readers", () => {
  const dir = mkdtempSync(join(tmpdir(), "cos-onerepo-"));
  try {
    mkdirSync(join(dir, "quality", "targets"), { recursive: true });
    mkdirSync(join(dir, "quality", "data"));
    writeFileSync(join(dir, "quality", "targets", "ci.json"), "[]");
    writeFileSync(join(dir, "quality", "data", "local.json"), JSON.stringify({ metrics: {} }));
    mkdirSync(join(dir, "docs"));
    for (const f of ["goals.json", "process.json", "maps.json"]) cpSync(join(ROOT, f), join(dir, "docs", f));
    // Every call is recorded and refused, so every read path runs and fails open.
    const calls = [];
    const refuse = (kind, what) => {
      calls.push(`${kind} ${what}`);
      throw new Error("HTTP 403: Resource not accessible by integration");
    };
    const gh = { calls: 0, graphqlCalls: 0, rest: (p) => refuse("rest", p), restLines: (p) => refuse("rest", p), raw: (p) => refuse("raw", p), graphql: (q) => refuse("graphql", q.slice(0, 200)) };
    const scope = configScope({ repos: ["one"], site: { repo: "one", root: "." }, docs: { goals: "docs/goals.json", process: "docs/process.json", maps: "docs/maps.json", rules: null }, data: "org.json", history: null });
    const data = collect({ gh, now: NOW, scope, root: dir });
    assert.ok(calls.length > 5, `the run read something: ${calls.length} calls`);
    assert.deepEqual(calls.filter((c) => /\borgs\//.test(c)), [], "no org-wide call");
    assert.deepEqual(calls.filter((c) => new RegExp(`repos/${ORG}/(?!one\\b)|name:"(?!one")`).test(c)), [], "no other repo's reads");
    assert.ok(calls.includes(`rest repos/${ORG}/one/dependabot/alerts?state=open&severity=critical,high&per_page=100`));
    assert.match(data.metrics["security.critical_high_open"].could_not_check, /HTTP 403/);
    assert.equal(data.metrics["public.private_refs"]?.value, undefined, "Git Crafter's own public.* is off");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- The pages action: a repo calls it, nothing is copied ------------------

test("the pages action runs scripts that exist, passes its inputs only through env, and defaults to the caller's token", () => {
  const dir = join(ROOT, "actions", "pages");
  const yml = readFileSync(join(dir, "action.yml"), "utf8");
  const scripts = [...new Set([...yml.matchAll(/"\$GITHUB_ACTION_PATH\/([^"]+\.mjs)"/g)].map((m) => m[1]))];
  assert.deepEqual(scripts.sort(), ["../../pages/build.mjs", "../../quality/build.mjs", "../../quality/collect.mjs", "../../quality/pack-checkouts.mjs", "../../tools/collect_org.mjs"]);
  // Each action is fixed: a full SHA, or a reference .github/workflows/actions.lock records with its commit.
  const lock = readFileSync(join(ROOT, ".github", "workflows", "actions.lock"), "utf8");
  const locked = (ref) => new RegExp(`^ {4}'${ref.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}':\\n {8}ref: '[^']+'\\n {8}commit: 'sha1-[0-9a-f]{40}'$`, "m").test(lock);
  for (const m of yml.matchAll(/^\s*uses: (\S+)/gm)) assert.ok(/@[0-9a-f]{40}$/.test(m[1]) || locked(m[1]), `${m[1]} is pinned to a full SHA or locked in actions.lock`);
  assert.match(yml, /all\|collect\|render\) ;;/, "an unknown mode is refused before any step runs");
  assert.match(yml, /pages takes process and quality/, "an unknown page is refused before any step runs");
  // Both pages: the Quality page's steps come first, so the Process page reads
  // its fresh data/latest.json.
  assert.ok(yml.indexOf("quality/build.mjs") < yml.indexOf("tools/collect_org.mjs\" --config \"$CONFIG\"\n"), "the Quality page builds before the Process page collects");
  for (const mode of ["all", "collect", "render"]) assert.ok(yml.includes(`inputs.mode == '${mode}'`) || mode === "all", mode);
  for (const s of scripts) assert.ok(existsSync(join(dir, s)), s);
  assert.match(yml, /using: composite/);
  assert.match(yml, /default: \$\{\{ github\.token \}\}/);
  for (const line of yml.split("\n").filter((l) => /^\s*run:/.test(l))) assert.doesNotMatch(line, /\$\{\{/, `an input reaches a run line only through env: ${line.trim()}`);
  const cfg = readJson("tests/action-config.json");
  assert.deepEqual(configScope(cfg).repos, ["git-crafter"], "the action job's config is a valid repo scope");
});

test("the pages action's admin-read-token is optional and reaches the Quality collect step's env alone; pages.yml passes it on main only", () => {
  const yml = readFileSync(join(ROOT, "actions", "pages", "action.yml"), "utf8");
  assert.match(yml, /^ {2}admin-read-token:\n {4}description: Optional\.[^\n]*\n {4}default: ""$/m, "empty by default, so no caller needs the secret");
  const uses = yml.split("\n").filter((l) => l.includes("inputs.admin-read-token"));
  assert.deepEqual(uses.map((l) => l.trim()), ["ADMIN_READ_TOKEN: ${{ inputs.admin-read-token }}"], "one env line, never a run line");
  const step = yml.slice(yml.lastIndexOf("- name:", yml.indexOf("inputs.admin-read-token")));
  assert.match(step, /^- name: Collect this repo's quality data\n/);
  const wf = readFileSync(join(ROOT, ".github", "workflows", "pages.yml"), "utf8");
  const passed = [...wf.matchAll(/secrets\.ADMIN_READ_TOKEN/g)];
  assert.equal(passed.length, 1, "pages.yml names the secret once");
  assert.ok(wf.includes("admin-read-token: ${{ github.ref == 'refs/heads/main' && (secrets.ADMIN_READ_TOKEN || steps.admin-app.outputs.token) || '' }}"), "a branch's code never runs with it");
  assert.match(wf, /- id: admin-app\n {8}if: github\.ref == 'refs\/heads\/main' && env\.BOARD_APP_KEY_SET == 'true'\n/, "the App token is minted on main only");
  assert.doesNotMatch(wf.slice(wf.indexOf("- id: admin-app"), wf.indexOf("- name:", wf.indexOf("- id: admin-app"))), /: write$/m, "the App token reads only");
});

test("the pages action's pack keys are optional and reach the Quality collect step's env alone; pages.yml passes none", () => {
  const yml = readFileSync(join(ROOT, "actions", "pages", "action.yml"), "utf8");
  const wf = readFileSync(join(ROOT, ".github", "workflows", "pages.yml"), "utf8");
  for (const [input, secret] of [["hf-token", "HF_TOKEN"], ["openrouter-api-key", "OPENROUTER_API_KEY"]]) {
    assert.match(yml, new RegExp(`^ {2}${input}:\\n {4}description: Optional\\.[^\\n]*\\n {4}default: ""$`, "m"), `${input} is empty by default`);
    const uses = yml.split("\n").filter((l) => l.includes(`inputs.${input}`));
    assert.deepEqual(uses.map((l) => l.trim()), [`${secret}: \${{ inputs.${input} }}`], `${input}: one env line, never a run line`);
    const step = yml.slice(yml.lastIndexOf("- name:", yml.indexOf(`inputs.${input}`)));
    assert.match(step, /^- name: Collect this repo's quality data\n/);
    assert.ok(!wf.includes(secret) && !wf.includes(`${input}:`), `pages.yml passes no ${input}`);
  }
});

test("the pages action pins each remote step by full SHA with its version comment, and the lockfile keys it that way", () => {
  // A caller whose Actions policy requires SHA pins refuses a tag at job setup. gh actions-lock's fix mode rewrites
  // these to tags; this test fails if a relock does.
  const yml = readFileSync(join(ROOT, "actions", "pages", "action.yml"), "utf8");
  const lock = readFileSync(join(ROOT, ".github", "workflows", "actions.lock"), "utf8");
  const remote = [...yml.matchAll(/^\s*uses:\s*([^\s#]+)(.*)$/gm)].filter(([, ref]) => !ref.startsWith("./") && !ref.startsWith("$/"));
  assert.ok(remote.length >= 2, "the upload and download steps");
  for (const [, ref, rest] of remote) {
    assert.match(ref, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, `${ref}: a full commit SHA`);
    assert.match(rest, /^ # v\d+\.\d+\.\d+$/, `${ref}: a # vX.Y.Z comment for Dependabot`);
    assert.ok(lock.includes(`'${ref}':`), `${ref}: keyed in actions.lock, or the runner refuses it`);
  }
});

test("under --config a doc the repo does not name is Git Crafter's own, except the maps; one it names is the repo's", () => {
  const s = configScope({ repos: ["one"], docs: { maps: "quality/process/maps.json", rules: null } });
  assert.equal(s.docs.goals, join(ROOT, "goals.json"));
  assert.equal(s.docs.process, join(ROOT, "process.json"));
  assert.equal(configScope({ repos: ["one"] }).docs.rules, join(ROOT, "rules", "delegation.md"));
  assert.equal(s.docs.maps, "quality/process/maps.json");
  assert.equal(configScope({ repos: ["one"] }).docs.maps, null, "a repo never gets Git Crafter's maps");
  assert.equal(s.docs.rules, null, "a repo can turn a doc off");
  const docs = readDocsFrom(join(tmpdir(), "no-such-repo"), { ...s.docs, maps: null });
  assert.equal(docs.goals.outcomes.length, readJson("goals.json").outcomes.length, "an absolute path ignores the repo root");
  assert.equal(docs.rules, "");
  assert.equal(docs.maps, null);
});

test("--phase splits a run: api writes the API half, site reads it; anything else is a usage error", () => {
  const dir = mkdtempSync(join(tmpdir(), "cos-phase-"));
  try {
    writeFileSync(join(dir, "c.json"), JSON.stringify({ repos: ["one"], data: "out/org.json" }));
    assert.equal(parseArgs(["--config", "c.json"], dir).phase, "all");
    const a = parseArgs(["--config", "c.json", "--phase", "api"], dir);
    assert.deepEqual([a.phase, a.api], ["api", "out/org.api.json"], "the API half sits beside the data by default");
    assert.equal(parseArgs(["--config", "c.json", "--phase", "site", "--api", "/tmp/x.json"], dir).api, "/tmp/x.json");
    for (const bad of [["--phase"], ["--phase", "both"], ["--api"], ["--phase", "--dry-run"]]) assert.equal(parseArgs(bad, dir), null, bad.join(" "));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a rate limit fails open: a run that read nothing, a warning and exit 0; any other failure is exit 1 (#484, #488)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cos-limit-"));
  const fail = (stderr) => Object.assign(new Error("gh failed"), { stderr });
  const limits = ["gh: API rate limit exceeded for installation ID 1. (HTTP 403)", "gh: You have exceeded a secondary rate limit. (HTTP 429)"];
  const others = ["gh: Not Found (HTTP 404)", "gh: Resource not accessible by integration (HTTP 403)", "gh: Internal Server Error (HTTP 500)", "ENOENT: no such file or directory, open 'goals.json'"];
  try {
    for (const f of ["goals.json", "process.json", "maps.json"]) cpSync(join(ROOT, f), join(dir, f));
    const args = { ...parseArgs([]), root: dir };
    const said = [];
    const opts = { now: NOW, env: { GITHUB_ACTIONS: "true" }, log: (line) => said.push(line) };
    // Known-good: a failure that is not a rate limit still fails, and writes nothing.
    for (const stderr of others) assert.equal(failedRun(fail(stderr), args, opts), 1, stderr);
    assert.equal(failedRun(fail(limits[0]), { ...args, dry: true }, opts), 0, "a dry run fails open too");
    assert.deepEqual([existsSync(join(dir, "data")), said.length], [false, 1], "and neither wrote");
    // Known-bad: the rate limit, primary or secondary.
    for (const stderr of limits) assert.equal(failedRun(fail(stderr), args, opts), 0, stderr);
    assert.match(said[1], /^::warning::collect_org: could not verify, GitHub's rate limit refused the read \(gh: API rate limit exceeded.*every metric reads not measured$/);
    assert.match(said[2], /secondary rate limit.*data\/org\.json is left as it was$/, "a run already there is never replaced by one that read nothing");
    const data = readJson(relative(ROOT, join(dir, "data", "org.json")));
    assert.deepEqual([data.repos, data.metrics, data.generated_at, data.gh_calls], [[], {}, NOW.toISOString(), 0]);
    assert.deepEqual(data.errors, [`repos and docs: ${limits[0]}`, `site quality data: not read, ${limits[0]}`]);
    assert.equal(existsSync(join(dir, "data", "history")), false, "a run that read nothing plots no history point");
    // The pages build from it: every figure not measured, with why, and none a 0.
    const out = build({ root: dir, now: NOW });
    assert.equal(out.code, 0, "never the exit 3 of a missing data file");
    assert.match(out.pages["index.html"], /Could not read: repos and docs: gh: API rate limit exceeded.*site quality data: not read, gh: API rate limit exceeded/);
    assert.match(out.pages["metrics.html"], /Could not read: repos and docs: gh: API rate limit exceeded/);
    // The API half fails open the same way, in the shape the site half finishes.
    assert.equal(failedRun(fail(limits[0]), { ...args, phase: "api", api: "data/org.api.json" }, opts), 0);
    const half = readJson(relative(ROOT, join(dir, "data", "org.api.json")));
    assert.deepEqual([half.repos, half.site, half.errors.length], [[], undefined, 2]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the two halves, joined through JSON, give the run one call gives, the site's own flow and all", () => {
  const dir = mkdtempSync(join(tmpdir(), "cos-split-"));
  try {
    mkdirSync(join(dir, "quality", "targets"), { recursive: true });
    mkdirSync(join(dir, "quality", "data"));
    mkdirSync(join(dir, "docs"));
    for (const f of ["goals.json", "process.json", "maps.json"]) cpSync(join(ROOT, f), join(dir, "docs", f));
    writeFileSync(join(dir, "quality", "targets", "ci.json"), JSON.stringify([{ id: "ci.latest_flow", goal: 10, near: 20, goal_source: "fixture" }]));
    const flow = [{ label: "site-tests", value: 4, unit: "minutes", stage: "ci", kind: "workflow", runs: "On every pull request", file: ".github/workflows/site-tests.yml", pass_rate: 98 }];
    // A site that has not taken the rename yet still reports ci.flow; the org page reads either.
    writeFileSync(join(dir, "quality", "data", "local.json"), JSON.stringify({ metrics: { "ci.flow": { value: 4, unit: "minutes", detail: flow, source: "quality/collectors/ci/ci.mjs", read_at: ago(1) }, "claude.pr_merge_share": { value: 80, unit: "%", source: "s", read_at: ago(1) }, "pull_requests.fixed_after_review": { value: 45, unit: "%", source: "s", read_at: ago(1) }, "pr.latest_merge_hours": { value: 999, unit: "hours", source: "s", read_at: ago(1) } } }));
    // The workflow files answer; every other read is refused, the same way each time.
    const fake = () => ({
      calls: 0,
      graphqlCalls: 0,
      rest: () => { throw new Error("HTTP 403"); },
      restLines: () => { throw new Error("HTTP 403"); },
      raw: () => { throw new Error("HTTP 403"); },
      graphql: (q) => {
        if (!q.includes("HEAD:.github/workflows")) throw new Error("HTTP 403");
        return { r0: { wf: { entries: [{ name: "ci.yml", object: { text: "name: CI\non:\n  pull_request:\njobs:\n  test:\n    runs-on: ubuntu-latest\n" } }] }, hooks: null, ct: null } };
      },
    });
    const scope = configScope({ repos: ["example-site"], site: { root: "." }, docs: { goals: "docs/goals.json", process: "docs/process.json", maps: "docs/maps.json", rules: null }, data: "org.json" });
    const api = JSON.parse(JSON.stringify(collectApi({ gh: fake(), now: NOW, scope, root: dir })));
    assert.ok(!("site" in api) && !Object.keys(api.metrics).some((id) => id.startsWith("site.") || id.startsWith("claude.")), "the API half reads nothing of the site's data");
    assert.notDeepEqual(api.pipelines["example-site"].detail, flow, "the API half has the pipeline from the files");
    const split = finishCollect(api, { gh: fake(), scope, root: dir, now: NOW });
    const whole = collect({ gh: fake(), now: NOW, scope, root: dir });
    const strip = (x) => JSON.parse(JSON.stringify(x, (k, v) => (k === "read_at" ? undefined : v)));
    assert.deepEqual(strip(split), strip(whole));
    assert.deepEqual(whole.pipelines["example-site"].detail, flow, "the site's own flow replaces its pipeline, in both, under its old id too");
    assert.equal(whole.metrics["claude.pr_merge_share"].value, 80);
    assert.equal(whole.metrics["pull_requests.fixed_after_review"].value, 45, "the Review step's metric comes from the site's data");
    assert.equal(whole.metrics["pull_requests.fixed_after_review"].copied_from, "example-site", "a copy names the repo its number belongs to");
    assert.equal(whole.own_repo, scope.own_repo);
    assert.notEqual(whole.metrics["pr.latest_merge_hours"].value, 999, "Git Crafter's own reading of an id wins over the site's entry");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fetchSite reads the repo the scope names, and every label names that repo", () => {
  const paths = [];
  const gh = {
    rest: (p, jq) => (paths.push(p), p.includes("/targets?") ? [] : p.endsWith("/commits/main") ? "abcdef1234567" : "https://x.pages.github.io/"),
    raw: (p) => (paths.push(p), JSON.stringify({ metrics: { "tokens.waste_share": { value: 3, by_repo: { me: 3 }, source: "s" } } })),
  };
  const site = fetchSite(gh, "other-site");
  assert.ok(paths.length >= 3 && paths.every((p) => p.startsWith(`repos/${ORG}/other-site/`)), paths.join(" "));
  assert.equal(site.repo, "other-site");
  assert.match(ownTokens(site, "me")["tokens.waste_share"].source, new RegExp(`^${ORG}/other-site@abcdef1 `));
});

