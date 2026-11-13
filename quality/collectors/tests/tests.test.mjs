// Tests for the Tests collector. Run with `node --test quality/collectors/tests/tests.test.mjs`.
//
// The fixture is small enough to work every value out by hand. A temporary
// repo, written from quality/fixtures/tests/repo.json, holds five suites, six
// page routes and the two test workflows. quality/fixtures/tests/gh.json holds
// nineteen runs of those workflows, all on 2026-11-03 but one in October,
// which still counts: no metric has a calendar window, only the last N
// events. It holds the jobs GraphQL returns for them. The comments give the arithmetic. The fail-open
// cases check that a missing or partial read becomes could_not_check, never a
// throw and never a lower number. All of it runs offline.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

import { LAST_RUNS, RUNS_PER_WORKFLOW, workflowRuns } from "../ci/ci.mjs";
import { GhError } from "../github/github.mjs";
import {
  collect,
  countSkips,
  METRIC_IDS,
  normalPath,
  pageRoute,
  routeCoverage,
  routeMatches,
  runJobs,
  PARAMS,
  settings,
  testWorkflow,
  LAST,
  WINDOW,
} from "./tests.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const QUALITY = path.join(HERE, "..", "..");
const REPO_ROOT = path.join(QUALITY, "..");
const TARGETS = JSON.parse(readFileSync(path.join(QUALITY, "targets", "tests.json"), "utf8"));
const FILES = JSON.parse(readFileSync(path.join(QUALITY, "fixtures", "tests", "repo.json"), "utf8")).files;
const GH = JSON.parse(readFileSync(path.join(QUALITY, "fixtures", "tests", "gh.json"), "utf8"));
const NOW = Date.parse(GH.now);
const REPO = "fixture-org/fixture-repo";
// The fixture repo's override over the template's params: five suites, the
// site's pages folder and its two test workflows.
const FIXTURE = {
  ...PARAMS,
  suites: [
    { label: "Unit", dir: "site/test/unit/", file: "\\.test\\.ts$" },
    { label: "DOM", dir: "site/test/dom/", file: "\\.test\\.ts$" },
    { label: "Worker: site", dir: "site/test/worker/", file: "\\.test\\.ts$" },
    { label: "Worker: bot", dir: "workers/bot/test/", file: "\\.test\\.ts$" },
    { label: "End to end", dir: "site/e2e/", file: "\\.(spec|test)\\.ts$", e2e: true },
  ],
  pages_dir: "site/src/pages/",
  workflows: [
    { file: "site-tests.yml", script: "check:push", role: "suite" },
    { file: "e2e.yml", script: "test:e2e", role: "e2e" },
  ],
  default_branch: "main",
};
const CFG = settings(FIXTURE);
// One page of each workflow's newest runs, with no date in the query.
const RUNS_OF = (file) => `repos/${REPO}/actions/workflows/${file}/runs?per_page=100`;

const withNodes = (runs) => runs.map((r) => ({ ...r, node_id: `WFR_${r.id}`, updated_at: r.created_at }));
const REST = {
  [RUNS_OF("site-tests.yml")]: { workflow_runs: withNodes(GH.runs["site-tests.yml"]) },
  [RUNS_OF("e2e.yml")]: { workflow_runs: withNodes(GH.runs["e2e.yml"]) },
};

/** A gh client that answers from the fixture and records each call. GraphQL answers nodes() from the check runs by id. */
function fakeGh({ rest = REST, checks = GH.checks, graphqlError } = {}) {
  const calls = { rest: [], graphql: 0 };
  return {
    calls,
    rest: async (route) => {
      calls.rest.push(route);
      if (!(route in rest)) throw new GhError(`no fixture for ${route}`, { status: 404 });
      const body = rest[route];
      if (body instanceof Error) throw body;
      return structuredClone(body);
    },
    graphql: async (query) => {
      calls.graphql += 1;
      if (graphqlError) throw graphqlError;
      const ids = [...query.matchAll(/"WFR_(\d+)"/g)].map((m) => Number(m[1]));
      return { nodes: ids.map((id) => (id in checks ? { databaseId: id, checkSuite: { checkRuns: { nodes: structuredClone(checks[id]) } } } : null)) };
    },
  };
}

function walk(dir, base = dir) {
  return readdirSync(dir).flatMap((name) => {
    const abs = path.join(dir, name);
    return statSync(abs).isDirectory() ? walk(abs, base) : [path.relative(base, abs).split(path.sep).join("/")];
  });
}
const listTree = async (root) => walk(root).sort();

let ROOT;
before(() => {
  ROOT = mkdtempSync(path.join(tmpdir(), "tests-collector-"));
  for (const [rel, text] of Object.entries(FILES)) {
    mkdirSync(path.dirname(path.join(ROOT, rel)), { recursive: true });
    writeFileSync(path.join(ROOT, rel), text);
  }
});
after(() => rmSync(ROOT, { recursive: true, force: true }));

const collectWith = (opts = {}) => collect({ root: ROOT, params: FIXTURE, gh: fakeGh(), now: NOW, repo: REPO, listFiles: listTree, ...opts });
const value = (result, id) => {
  assert.equal(result[id].could_not_check, undefined, `${id}: ${result[id].could_not_check}`);
  return result[id].value;
};
const CI_IDS = ["tests.main_pass_rate", "tests.site_tests_p50", "tests.e2e_shard_p50", "tests.ci_minutes_latest_main"];
const STATIC_IDS = ["tests.e2e_routes", "tests.axe_routes", "tests.skipped"];

// ---------------------------------------------------------------- units

describe("tests collector pieces", () => {
  it("counts skip, todo and fixme markers as always, in code, not in comments", () => {
    assert.deepEqual(countSkips(FILES["site/test/unit/math.test.ts"]), { always: 1, conditional: 0 }, "it.todo");
    assert.deepEqual(countSkips(FILES["site/test/dom/page.test.ts"]), { always: 1, conditional: 1 }, "it.skip always; ctx.skip at run time");
    assert.deepEqual(countSkips(FILES["site/e2e/seats.spec.ts"]), { always: 1, conditional: 0 }, "test.fixme; the commented test.describe.skip is left out");
  });

  it("counts a skip at run time as conditional, since only a run can tell", () => {
    const spec = 'test("draws", async ({ page, isMobile }) => {\n  test.skip(isMobile, "desktop only");\n  test.fixme();\n});\n';
    assert.deepEqual(countSkips(spec), { always: 0, conditional: 2 });
  });

  it("counts a marked describe block by its cases, and skipIf and runIf as conditional", () => {
    // describe.skip holds 2 cases (its title's parentheses are a string); the
    // skipIf block holds 1 case and 1 todo, which counts as always; it.runIf is
    // 1 conditional case; the empty describe.todo counts 1.
    assert.deepEqual(countSkips(FILES["site/test/unit/flags.test.ts"]), { always: 4, conditional: 2 });
    // Known bad for a count of markers: one describe.skipIf around three cases.
    const block = 'describe.skipIf(!written)("score", () => {\n  it("a", () => {});\n  it("b", () => {});\n  it("c", () => {});\n});\nit("runs", () => {});\n';
    assert.deepEqual(countSkips(block), { always: 0, conditional: 3 });
    assert.deepEqual(countSkips('test.describe.fixme("map", () => {\n  test("draws", async () => {});\n  test.skip("zooms", async () => {});\n});\n'), { always: 2, conditional: 0 }, "a case counts once");
    // Known bad: a test held as text, a sample fed to countSkips or a title naming a marker, is not a test.
    const held = "const sample = 'test.skip(\"zooms\", () => {});';\nit(\"reads it.skip( and .todo( in a title\", () => {\n  assert.ok(`it.fixme(\"x\")`);\n});\n";
    assert.deepEqual(countSkips(held), { always: 0, conditional: 0 });
  });

  it("maps page files to routes and leaves out endpoints and underscore files", () => {
    assert.equal(pageRoute("site/src/pages/index.astro", CFG), "/");
    assert.equal(pageRoute("site/src/pages/about.astro", CFG), "/about/");
    assert.equal(pageRoute("site/src/pages/contact/index.astro", CFG), "/contact/");
    assert.equal(pageRoute("site/src/pages/join/[seat].astro", CFG), "/join/[seat]/");
    assert.equal(pageRoute("site/src/pages/guides/intro.md", CFG), "/guides/intro/");
    assert.equal(pageRoute("site/src/pages/feed.json.ts", CFG), null);
    assert.equal(pageRoute("site/src/pages/_drafts/old.astro", CFG), null);
    assert.equal(pageRoute("site/src/components/Card.astro", CFG), null);
  });

  it("reads a spec path the way a route does", () => {
    assert.equal(normalPath("/about/?ref=nav#top"), "/about/");
    assert.equal(normalPath("/seats/${id}/"), "/seats/*/");
    assert.equal(normalPath("/api/suggest"), "/api/suggest/");
    assert.equal(normalPath("/brand/logo.svg"), "/brand/logo.svg");
  });

  it("fills a [param] with any segment, and a ${…} only a [param]", () => {
    assert.equal(routeMatches("/seats/[seat]/", "/seats/lead/"), true);
    assert.equal(routeMatches("/seats/[seat]/", "/seats/*/"), true);
    assert.equal(routeMatches("/seats/apply/", "/seats/*/"), false, "a template never claims a fixed page");
    assert.equal(routeMatches("/seats/[seat]/", "/seats/"), false);
    assert.equal(routeMatches("/docs/[...slug]/", "/docs/a/b/"), true);
    assert.equal(routeMatches("/", "/"), true);
    assert.equal(routeMatches("/", "/about/"), false);
  });

  it("credits the 404 page for a goto() to a path no page serves, and axe per spec file", () => {
    const routes = ["/", "/404/", "/about/"];
    const { visited, axe } = routeCoverage(routes, ['await page.goto("/gone/");\nnew AxeBuilder({ page });', 'expect(a).toHaveAttribute("href", "/gone/");\nawait page.goto("/about/");']);
    assert.deepEqual([...visited].sort(), ["/404/", "/about/"], "a path named outside goto() credits no 404");
    assert.deepEqual([...axe], ["/404/"]);
  });

  it("takes a test job by the name GitHub shows, for a job in a called workflow", () => {
    // A caller of a reusable workflow holds no steps: its test job runs there,
    // and GitHub names it "<caller job> / <its job>".
    const caller = "name: verify\non:\n  pull_request:\n  push:\n    branches: [main]\njobs:\n  ci:\n    uses: ./.github/workflows/ci-standard.yml\n    with:\n      short: bash tools/verify.sh\n";
    assert.deepEqual(testWorkflow(caller, { file: "verify.yml", job: "ci / short", role: "suite" }), {
      id: "verify.yml", name: "verify", jobs: ["ci / short"], skippedAs: ["ci / short"], onMain: true, role: "suite",
    });
    assert.deepEqual(testWorkflow(caller, { file: "verify.yml", job: ["ci / short", "ci / standard"] }).jobs, ["ci / short", "ci / standard"]);
    // npm detection finds nothing in it, which is why a repo names the job.
    assert.throws(() => testWorkflow(caller, { file: "verify.yml", script: "test" }), /has no job that runs npm run test/);
  });

  it("finds a test job by text its step runs, for a job that runs a shell script", () => {
    const shell = "name: checks\non:\n  push:\n    branches: [main]\njobs:\n  verify:\n    name: Verify\n    runs-on: ubuntu-slim\n    steps:\n      - uses: actions/checkout@v4\n      - run: bash tools/verify.sh\n  lint:\n    runs-on: ubuntu-slim\n    steps:\n      - run: npm run lint\n";
    assert.deepEqual(testWorkflow(shell, { file: "checks.yml", step: "tools/verify.sh" }), {
      id: "checks.yml", name: "checks", jobs: ["Verify"], skippedAs: ["Verify"], onMain: true,
    });
    assert.throws(() => testWorkflow(shell, { file: "checks.yml", step: "make test" }), /has no job with a step that runs make test/);
  });

  it("finds a workflow's test jobs by the script they run, matrix names expanded", () => {
    const site = testWorkflow(FILES[".github/workflows/site-tests.yml"], { file: "site-tests.yml", script: "check:push" });
    assert.deepEqual(site, { id: "site-tests.yml", name: "site-tests", jobs: ["site-tests: tests"], skippedAs: ["site-tests: tests"], onMain: true });
    const e2e = testWorkflow(FILES[".github/workflows/e2e.yml"], { file: "e2e.yml", script: "test:e2e" });
    assert.deepEqual(e2e.jobs, ["e2e: shard 1/2", "e2e: shard 2/2"], "e2e:install is not test:e2e");
    assert.deepEqual(e2e.skippedAs, ["e2e: shard ${{ matrix.shard }}/2"], "a skipped matrix job keeps its unexpanded name");
    assert.equal(e2e.onMain, false);
    assert.throws(() => testWorkflow("name: x\njobs:\n  a:\n    steps:\n      - run: npm test\n", { file: "x.yml", script: "check:push" }), /has no job that runs npm run check:push/);
  });

  it("reads jobs 100 runs a GraphQL call and refuses a run that comes back without them", async () => {
    const runs = Array.from({ length: 150 }, (_, i) => ({ id: 1000 + i, node_id: `WFR_${1000 + i}` }));
    const checks = Object.fromEntries(runs.map((r) => [r.id, [{ databaseId: r.id * 10, name: "t", conclusion: "SUCCESS", startedAt: GH.now, completedAt: GH.now }]]));
    const gh = fakeGh({ checks });
    const jobs = await runJobs(gh, runs);
    assert.equal(gh.calls.graphql, 2);
    assert.deepEqual(jobs.get(1149), [{ id: 11490, name: "t", conclusion: "success", started_at: GH.now, completed_at: GH.now }]);
    delete checks[1100];
    await assert.rejects(runJobs(fakeGh({ checks }), runs), /no jobs for run 1100/);
    await assert.rejects(runJobs(fakeGh({ checks }), [{ id: 1, node_id: 'x" } } evil' }]), /no node_id/);
  });

  it("reads run pages until a short one or the page limit (ci.mjs's workflowRuns)", async () => {
    const page = (k, count) => ({ workflow_runs: Array.from({ length: count }, (_, i) => ({ id: k * 1000 + i })) });
    const base = `repos/${REPO}/actions/workflows/x.yml/runs?per_page=${RUNS_PER_WORKFLOW}`;
    const rest = { [base]: page(1, 100), [`${base}&page=2`]: page(2, 100), [`${base}&page=3`]: page(3, 7) };
    const gh = fakeGh({ rest });
    const runs = await workflowRuns(gh, REPO, { id: "x.yml", name: "x" }, { pages: 5 });
    assert.equal(runs.length, 207);
    assert.equal(runs[0].workflow, "x", "each run is named by its workflow");
    assert.equal(gh.calls.rest.length, 3, "a short page ends the read");
    const capped = fakeGh({ rest });
    assert.equal((await workflowRuns(capped, REPO, { id: "x.yml", name: "x" }, { pages: 2 })).length, 200);
    assert.equal(capped.calls.rest.length, 2);
  });

  it("counts a run once when a new run pushes it onto the next page", async () => {
    const ids = (from, count) => Array.from({ length: count }, (_, i) => ({ id: from - i }));
    const base = `repos/${REPO}/actions/workflows/x.yml/runs?per_page=${RUNS_PER_WORKFLOW}`;
    // Page 1 holds runs 500 to 401. A new run arrives, so page 2 starts again at 401.
    const rest = { [base]: { workflow_runs: ids(500, 100) }, [`${base}&page=2`]: { workflow_runs: ids(401, 30) } };
    const runs = await workflowRuns(fakeGh({ rest }), REPO, { id: "x.yml", name: "x" }, { pages: 5 });
    assert.equal(runs.length, 129);
    assert.equal(new Set(runs.map((r) => r.id)).size, 129);
  });

  it("refuses an answer without a workflow_runs list instead of reading it as the last page", async () => {
    const base = `repos/${REPO}/actions/workflows/x.yml/runs?per_page=${RUNS_PER_WORKFLOW}`;
    for (const body of [{}, { workflow_runs: null }, { message: "Moved" }]) {
      await assert.rejects(workflowRuns(fakeGh({ rest: { [base]: body } }), REPO, { id: "x.yml", name: "x" }), /workflow x \(id x\.yml\) came back without a workflow_runs list/);
    }
  });
});

// ---------------------------------------------------------------- good fixture

describe("tests collector on the fixture", () => {
  it("reports every metric in targets/tests.json and nothing else", async () => {
    const result = await collectWith();
    assert.deepEqual(Object.keys(result).sort(), [...METRIC_IDS].sort());
    assert.deepEqual([...METRIC_IDS].sort(), TARGETS.map((t) => t.id).sort());
  });

  it("measures route coverage over page files, the 404 page included", async () => {
    const result = await collectWith();
    // Six routes: /, /404/, /about/, /contact/, /seats/, /seats/[seat]/. The
    // specs open all but /contact/ (helpers.ts is not a spec): 5 of 6.
    assert.equal(value(result, "tests.e2e_routes"), 83.3);
    assert.deepEqual(result["tests.e2e_routes"].detail, [{ label: "/contact/", value: 0, unit: "specs" }]);
    // Only home.spec.ts runs axe: /, /about/ and the 404 page, 3 of 6.
    assert.equal(value(result, "tests.axe_routes"), 50);
    assert.deepEqual(result["tests.axe_routes"].detail.map((d) => d.label), ["/contact/", "/seats/", "/seats/[seat]/"]);
  });

  it("caps a list of routes and states how many it left out", async () => {
    // Two more page files no spec names (a route needs only the file's name):
    // five routes lack axe, three are listed.
    const extra = ["site/src/pages/team.astro", "site/src/pages/zines/[id].astro"];
    const result = await collectWith({ listFiles: async (root) => [...(await listTree(root)), ...extra] });
    assert.deepEqual(result["tests.axe_routes"].detail, [
      { label: "/contact/", value: 0, unit: "specs" },
      { label: "/seats/", value: 0, unit: "specs" },
      { label: "/seats/[seat]/", value: 0, unit: "specs" },
      { label: "More routes with no axe check", value: 2, unit: "routes" },
    ]);
    assert.equal(value(result, "tests.axe_routes"), 37.5, "3 of 8");
  });

  it("counts only tests that never run, per file, most first, with conditional skips in a row outside the value", async () => {
    const result = await collectWith();
    // Always: flags.test.ts 4, page.test.ts 1 (it.skip), seats.spec.ts 1,
    // math.test.ts 1. Conditional, not in the value: flags.test.ts 2 and
    // page.test.ts's ctx.skip 1.
    assert.equal(value(result, "tests.skipped"), 7);
    assert.deepEqual(result["tests.skipped"].detail.map((d) => [d.label, d.value]), [
      ["site/test/unit/flags.test.ts", 4],
      ["site/e2e/seats.spec.ts", 1],
      ["site/test/dom/page.test.ts", 1],
      ["In other files", 1],
      ["Not counted, on a condition: skipIf, runIf or a skip at run time", 3],
    ]);
  });

  it("rates test jobs on main from the first run with a test job, each run that is left out in its own row", async () => {
    const result = await collectWith();
    // Run 11 (07:00) predates the job's name, so the window starts at run 1
    // (08:00). Run 1 passed, run 2 failed, run 3 was cancelled, run 4 passed
    // and skipped its test job (no site change), run 12 never started one,
    // and run 13 failed in its change job, which skipped the test job: that
    // is not "no site change".
    assert.equal(value(result, "tests.main_pass_rate"), 50);
    assert.deepEqual(result["tests.main_pass_rate"].detail.map((d) => [d.label, d.value]), [
      ["Passed", 1],
      ["Failed", 1],
      ["Cancelled, left out", 1],
      ["No site change, test job skipped, left out", 1],
      ["Test job skipped in a failed run, left out", 1],
      ["No test job in the run, left out", 1],
    ]);
    assert.ok(
      result["tests.main_pass_rate"].source.endsWith("; site-tests from 2026-11-03 08:00 UTC, its first run read with a test job; e2e runs only on pull requests"),
      result["tests.main_pass_rate"].source,
    );
  });

  it("leaves a run with no test-named job out of the window instead of calling it a skip", async () => {
    // Before the rename every run named its job differently: no run has a
    // test job, so nothing is rated and nothing is timed.
    const checks = Object.fromEntries(Object.entries(GH.checks).map(([id, list]) => [id, list.map((c) => ({ ...c, name: "site-tests" }))]));
    const result = await collectWith({ gh: fakeGh({ checks }) });
    assert.match(result["tests.main_pass_rate"].could_not_check, /no test job ran in the last 20 runs on main/);
    assert.match(result["tests.site_tests_p50"].could_not_check, /no site-tests: tests job passed/);
  });

  it("rates only the last 20 runs on main, and times only the last 20 passing test jobs", async () => {
    // 30 runs on main, one a minute: runs 0 to 4 failed, the rest passed. Runs
    // 5 to 18 took 10 minutes, runs 19 to 29 took 40 seconds. Read whole, the
    // pass rate would be 83.3% and the median 10 minutes.
    const base = Date.parse("2026-11-03T08:00:00Z");
    const at = (i) => new Date(base + i * 60_000).toISOString();
    const many = Array.from({ length: 30 }, (_, i) => ({ id: 500 + i, event: "push", head_branch: "main", head_sha: `x${i}`, status: "completed", conclusion: i < 5 ? "failure" : "success", run_attempt: 1, created_at: at(i) }));
    const tests = (i) => [{ databaseId: 9000 + i, name: "site-tests: tests", conclusion: i < 5 ? "FAILURE" : "SUCCESS", startedAt: at(i), completedAt: new Date(base + i * 60_000 + (i < 19 ? 600 : 40) * 1000).toISOString() }];
    const checks = { ...GH.checks, ...Object.fromEntries(many.map((r, i) => [r.id, tests(i)])) };
    const rest = { ...REST, [RUNS_OF("site-tests.yml")]: { workflow_runs: withNodes(many) } };
    const result = await collectWith({ gh: fakeGh({ rest, checks }) });
    assert.equal(LAST_RUNS, 20);
    assert.equal(value(result, "tests.main_pass_rate"), 100, "the 5 failures are older than the last 20 runs on main");
    assert.deepEqual(result["tests.main_pass_rate"].detail[0], { label: "Passed", value: 20, unit: "runs" });
    // The last 20 passing jobs, runs 10 to 29: 9 of 10 minutes and 11 of 40
    // seconds, so the median is 40 seconds.
    assert.equal(value(result, "tests.site_tests_p50"), 0.7);
  });

  it("times passing test jobs: site-tests' median and the slowest e2e shard", async () => {
    const result = await collectWith();
    // Passing test jobs: 40, 60, 50 and 30 seconds; the median is 45 s, 0.75 minutes.
    assert.equal(value(result, "tests.site_tests_p50"), 0.8);
    assert.deepEqual(result["tests.site_tests_p50"].detail, [
      { label: "Pull requests", value: 0.8 },
      { label: "Pushes to main", value: 0.7 },
    ]);
    assert.match(result["tests.site_tests_p50"].source, /; site-tests from 2026-11-03 08:00 UTC, its first run read with a test job$/);
    // Shard 1: 120 and 180 s, median 150 s. Shard 2: 90, 150 and 60 s, median
    // 90 s. Run 20's "e2e: shard 1/4" is an older name: it is left out.
    assert.equal(value(result, "tests.e2e_shard_p50"), 2.5);
    assert.deepEqual(result["tests.e2e_shard_p50"].detail, [
      { label: "e2e: shard 1/2", value: 2.5 },
      { label: "e2e: shard 2/2", value: 1.5 },
    ]);
    assert.match(result["tests.e2e_shard_p50"].source, /; e2e from 2026-11-03 09:00 UTC, its first run read with a test job$/);
  });

  it("bills the test jobs of the latest run of each workflow that ran them: on main, and e2e's latest pull request run", async () => {
    const calls = fakeGh();
    const result = await collectWith({ gh: calls });
    // site-tests on main, newest first: run 13's and run 4's test jobs were
    // skipped, run 12 started none, so run 2: one job of 60 s bills 1 minute.
    // e2e never runs on main. Run 25 skipped its shards and run 24 was
    // cancelled, so run 23: two shards of 60 s, 1 minute each. 1 + 2 = 3.
    assert.equal(value(result, "tests.ci_minutes_latest_main"), 3);
    assert.deepEqual(result["tests.ci_minutes_latest_main"].detail, [
      { label: "site-tests: tests, run 2", value: 1 },
      { label: "e2e: shard 1/2, run 23", value: 1 },
      { label: "e2e: shard 2/2, run 23", value: 1 },
    ]);
    assert.match(result["tests.ci_minutes_latest_main"].source, /e2e never runs on main: its latest pull request run, 23/);
    // No call beyond the two run lists and one GraphQL read.
    assert.deepEqual(calls.calls.rest, [RUNS_OF("site-tests.yml"), RUNS_OF("e2e.yml")]);
    assert.equal(calls.calls.graphql, 1);
  });

  it("a missing input: no run on main with a test job is not a 0", async () => {
    const onlyPrs = GH.runs["site-tests.yml"].filter((r) => r.event !== "push" || r.id === 4 || r.id === 13);
    const rest = { ...REST, [RUNS_OF("site-tests.yml")]: { workflow_runs: withNodes(onlyPrs) } };
    const result = await collectWith({ gh: fakeGh({ rest }) });
    assert.match(result["tests.ci_minutes_latest_main"].could_not_check, /no site-tests run on main ran a test job/);
    assert.equal(result["tests.ci_minutes_latest_main"].value, undefined);
  });
});

// ---------------------------------------------------------------- fail open

describe("fail open", () => {
  it("a missing input: git ls-files failing leaves the repo metrics could_not_check, the CI ones measured", async () => {
    const result = await collectWith({ listFiles: async () => Promise.reject(new Error("git ls-files failed: not a git repository")) });
    for (const id of STATIC_IDS) assert.match(result[id].could_not_check, /git ls-files failed: not a git repository/, id);
    assert.equal(value(result, "tests.main_pass_rate"), 50);
  });

  it("a missing input: no test file, page or spec is not a 0", async () => {
    const result = await collectWith({ listFiles: async () => [".github/workflows/site-tests.yml"] });
    for (const id of STATIC_IDS) assert.ok(result[id].could_not_check, id);
    assert.match(result["tests.e2e_routes"].could_not_check, /no page in params\.pages_dir \(site\/src\/pages\/\)/);
  });

  it("a missing input: no workflow file or no gh leaves the CI metrics could_not_check", async () => {
    const bare = mkdtempSync(path.join(tmpdir(), "tests-collector-bare-"));
    try {
      const result = await collect({ root: bare, params: FIXTURE, gh: fakeGh(), now: NOW, repo: REPO, listFiles: async () => [] });
      for (const id of CI_IDS) assert.match(result[id].could_not_check, /site-tests\.yml is missing/, id);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
    const noGh = { rest: async () => Promise.reject(new GhError("gh is not installed; install the GitHub CLI and run gh auth login")), graphql: async () => ({}) };
    const result = await collectWith({ gh: noGh });
    for (const id of CI_IDS) assert.match(result[id].could_not_check, /gh is not installed/, id);
    assert.equal(value(result, "tests.e2e_routes"), 83.3, "the repo metrics still read");
  });

  it("a partial read: one workflow's runs failing blanks every CI metric, never a lower number", async () => {
    const rest = { ...REST, [RUNS_OF("e2e.yml")]: new GhError("Not Found", { status: 404 }) };
    const result = await collectWith({ gh: fakeGh({ rest }) });
    for (const id of CI_IDS) assert.match(result[id].could_not_check, /the runs of workflow e2e \(id e2e\.yml\) answered HTTP 404/, id);
  });

  it("a partial read: a run without its jobs blanks the job metrics", async () => {
    const checks = { ...GH.checks };
    delete checks[22];
    const result = await collectWith({ gh: fakeGh({ checks }) });
    for (const id of CI_IDS) assert.match(result[id].could_not_check, /GitHub returned no jobs for run 22/, id);
  });

  it("a partial read: GraphQL failing or rate limited is said so", async () => {
    const result = await collectWith({ gh: fakeGh({ graphqlError: new GhError("API rate limit exceeded for user", { status: 403 }) }) });
    for (const id of CI_IDS) assert.match(result[id].could_not_check, /rate limit is spent/, id);
  });

  it("a partial read: a shard with no passing run blanks the shard metric instead of timing fewer shards", async () => {
    const checks = structuredClone(GH.checks);
    for (const id of [21, 22, 23]) checks[id] = checks[id].map((c) => (c.name === "e2e: shard 2/2" ? { ...c, conclusion: "FAILURE" } : c));
    const result = await collectWith({ gh: fakeGh({ checks }) });
    assert.match(result["tests.e2e_shard_p50"].could_not_check, /no e2e: shard 2\/2 job passed/);
  });

  it("a partial read: a listed file that cannot be read blanks the repo metrics", async () => {
    const result = await collectWith({ listFiles: async (root) => [...(await listTree(root)), "site/test/unit/gone.test.ts"] });
    for (const id of STATIC_IDS) assert.match(result[id].could_not_check, /ENOENT/, id);
  });
});

// ---------------------------------------------------------------- contracts

describe("naming the test job in params", () => {
  it("reads the same runs whether a job is found by its npm script or named outright", async () => {
    const byScript = await collectWith();
    const named = await collectWith({
      params: {
        ...FIXTURE,
        workflows: [
          { file: "site-tests.yml", job: "site-tests: tests", role: "suite" },
          { file: "e2e.yml", job: ["e2e: shard 1/2", "e2e: shard 2/2"], role: "e2e" },
        ],
      },
    });
    for (const id of CI_IDS) assert.deepEqual([named[id].value, named[id].detail], [byScript[id].value, byScript[id].detail], id);
  });

  it("Git Crafter's own override names its test job, and its verify workflow runs on main", () => {
    const override = JSON.parse(readFileSync(path.join(REPO_ROOT, "config", "quality", "targets", "tests.json"), "utf8"));
    const flows = Object.assign({}, ...override.map((t) => t.params ?? {})).workflows;
    assert.ok(flows.length, "Git Crafter names a test workflow");
    for (const w of flows) {
      const found = testWorkflow(readFileSync(path.join(REPO_ROOT, ".github", "workflows", w.file), "utf8"), w);
      assert.ok(found.jobs.length && found.onMain, `${w.file} names a test job and runs on a push to main`);
    }
    // The named job is the one verify.yml hands tools/verify.sh to.
    const verify = YAML.parse(readFileSync(path.join(REPO_ROOT, ".github", "workflows", "verify.yml"), "utf8"));
    assert.equal(verify.jobs.ci.with.short, "bash tools/verify.sh");
    assert.deepEqual(flows.find((w) => w.file === "verify.yml")?.job, "ci / short");
  });
});

describe("targets/tests.json and the repo", () => {
  it("puts every metric on the Actions tab with a group, a plain meaning and a goal source", () => {
    for (const t of TARGETS) {
      assert.equal(t.tab, "actions", t.id);
      assert.ok(["Coverage", "Trust", "Suite time", "Cost"].includes(t.group), t.id);
      assert.equal(t.group === "Cost", t.kind === "consumption", `${t.id}: Cost holds the Consumption metrics`);
      assert.ok(t.means.trim() && t.means.length <= 120 && !/\d/.test(t.means), `${t.id} means`);
      assert.ok(t.goal_source.trim(), t.id);
      assert.ok(!/[–—]/.test(JSON.stringify(t)), `${t.id} has a dash`);
    }
    const code = JSON.parse(readFileSync(path.join(QUALITY, "targets", "code.json"), "utf8"));
    const coverage = code.find((t) => t.id === "code.test_coverage_pct");
    assert.deepEqual([coverage.tab, coverage.group], ["code", "Coverage"], "line coverage is on the Code tab, in its Coverage group");
  });

  it("emits each target's own source, and every run source states the window", async () => {
    // Nothing reads, so every entry carries its source alone.
    const noGh = { rest: async () => Promise.reject(new GhError("gh is not installed")), graphql: async () => Promise.reject(new GhError("gh is not installed")) };
    const result = await collectWith({ gh: noGh, listFiles: async () => Promise.reject(new Error("git ls-files failed")) });
    for (const t of TARGETS) assert.equal(result[t.id].source, t.source, t.id);
    for (const t of TARGETS.filter((x) => x.kind === "consumption")) assert.match(t.source, /^latest: /, `${t.id} reads the latest event`);
    for (const t of TARGETS.filter((x) => /gh api runs/.test(x.source))) {
      assert.ok(t.source.includes(`(${WINDOW})`), `${t.id} states ${WINDOW}`);
      assert.ok(t.source.includes(`: the ${LAST} `), `${t.id} names its last N`);
      assert.doesNotMatch(t.source, /\b14 days\b|this month/, t.id);
    }
    for (const t of TARGETS) assert.notEqual(t.chart, "spark", t.id);
  });

  it("holds every repo value as a param, with generic defaults", () => {
    assert.equal(TARGETS.filter((t) => t.params).length, 1, "one params block");
    assert.deepEqual(PARAMS.workflows, [], "the template names no workflow");
    assert.equal(PARAMS.pages_dir, "src/pages/");
    assert.equal(PARAMS.default_branch, "", "the template assumes no branch name");
    assert.equal(PARAMS.suites.filter((s) => s.e2e).length, 1, "one e2e suite");
    for (const s of PARAMS.suites) assert.doesNotThrow(() => new RegExp(s.file), s.label);
    const src = readFileSync(path.join(HERE, "tests.mjs"), "utf8");
    for (const p of ["site/", "site-tests", "e2e.yml", "check:push", "workers/"]) assert.ok(!src.includes(p), `tests.mjs names ${p}; move it to a param`);
  });

  it("derives the template's test minutes goal from its speed goals: one suite job plus one e2e job", () => {
    const t = (id) => TARGETS.find((x) => x.id === id);
    const minutes = t("tests.ci_minutes_latest_main");
    assert.equal(minutes.goal, t("tests.site_tests_p50").goal + t("tests.e2e_shard_p50").goal);
    assert.equal(minutes.near, t("tests.site_tests_p50").near + t("tests.e2e_shard_p50").near);
    assert.deepEqual([minutes.kind, minutes.direction, minutes.unit], ["consumption", "lower", "minutes"]);
  });

  it("reads the default branch from the params, else from GitHub, and never assumes main", async () => {
    const asked = fakeGh({ rest: { ...REST, [`repos/${REPO}`]: { default_branch: "main" } } });
    const read = await collectWith({ gh: asked, params: { ...FIXTURE, default_branch: "" } });
    assert.ok(asked.calls.rest.includes(`repos/${REPO}`), "one call for the default branch when no param names it");
    assert.equal(value(read, "tests.main_pass_rate"), value(await collectWith(), "tests.main_pass_rate"));
    // The workflows run on a push to main; a repo whose default is trunk has no
    // test workflow on its default branch, so the rate is not measured.
    const trunk = await collectWith({ params: { ...FIXTURE, default_branch: "trunk" } });
    assert.match(trunk["tests.main_pass_rate"].could_not_check, /no test workflow runs on a push to trunk, the default branch/);
    // ci.json's param, where the Actions tab keeps it, wins over this file's.
    const fromCi = await collectWith({ allParams: { "github.json": { repo: REPO }, "ci.json": { default_branch: "trunk" } } });
    assert.match(fromCi["tests.main_pass_rate"].could_not_check, /push to trunk/);
    // GitHub not answering is could_not_check for the CI metrics, never main by default.
    const silent = await collectWith({ params: { ...FIXTURE, default_branch: "" } });
    for (const id of CI_IDS) assert.match(silent[id].could_not_check, /repos\/fixture-org\/fixture-repo/, id);
  });

  it("with no repo or no workflow, every CI metric is could_not_check naming the param; the repo reads still measure", async () => {
    const noRepo = await collectWith({ repo: "" });
    for (const id of CI_IDS) assert.match(noRepo[id].could_not_check, /set params\.repo in quality\/targets\/github\.json/, id);
    const noFlows = await collectWith({ params: { ...FIXTURE, workflows: [] } });
    for (const id of CI_IDS) assert.match(noFlows[id].could_not_check, /params\.workflows names no test workflow/, id);
    for (const id of STATIC_IDS) assert.equal(typeof value(noFlows, id), "number", id);
    const fromGithub = await collect({ root: ROOT, params: FIXTURE, allParams: { "github.json": { repo: REPO } }, gh: fakeGh(), now: NOW, listFiles: listTree });
    assert.equal(typeof value(fromGithub, "tests.main_pass_rate"), "number", "the repo comes from github.json's params");
  });
});
