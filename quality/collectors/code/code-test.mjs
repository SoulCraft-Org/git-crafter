// The Code collector's test coverage, read with vitest or from the lcov a
// node:test run printed in CI (code.mjs, code-lcov.mjs).

import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { runJobs, workflowRuns } from "../ci/ci.mjs";
import { lcovCoverage, lcovFromLog } from "./code-lcov.mjs";
import { measured, readJson, round, share, sum, unknown, unknownAll } from "./code-util.mjs";

// ---- Quality: test coverage ----

// Pass rate and suite time are the Tests tab's own metrics; this step runs the
// vitest suites only to measure coverage, and runs no node:test suite at all.
export const TEST_SOURCE =
  "vitest run --coverage (v8, json-summary) for each vitest suite in params.test_suites; for each node suite, the lcov block its CI job printed";
// params.test_suites: [{ label, cwd, args, cover }] for vitest. cover maps each
// code folder the suite counts (relative to the repo) to a --coverage.include
// glob relative to the suite's cwd, so a file no test loads counts as 0%.
// A node:test suite is { label, runner: "node", workflow, job, cover: [folders] }:
// its job runs node --test --experimental-test-coverage --test-reporter=lcov and
// prints the lcov with code-lcov.mjs. node counts only the files a test loads.
export const COVERAGE_PACKAGE = "@vitest/coverage-v8";
const COVERAGE_PROVIDER = `node_modules/${COVERAGE_PACKAGE}/package.json`;
const VITEST = "vitest --coverage.provider=v8 json-summary";

// Line and branch coverage of the params.test_suites suites, in ci mode only.
// ci is { client, repo, branch }; client() returns a gh client with text(),
// which reads the job logs node suites print their lcov to.
export async function testCoverage(root, local, run, suites, ci = {}) {
  const ids = ["code.test_coverage_pct"];
  if (!suites.length) return unknownAll(ids, "params.test_suites names no test suite", "params.test_suites");
  // Coverage runs in ci mode only: instrumenting a whole suite is heavy
  // compute, kept off local runs, and without coverage the run measures nothing.
  if (local) return unknownAll(ids, "measured in ci mode only: coverage instruments the whole suite", TEST_SOURCE);
  const vitest = suites.some((s) => s.runner !== "node");
  if (vitest && !existsSync(join(root, COVERAGE_PROVIDER))) return unknownAll(ids, `${COVERAGE_PACKAGE} is not installed (npm ci installs it)`, TEST_SOURCE);
  const rows = [];
  for (const suite of suites) {
    const row = suite.runner === "node" ? await nodeCoverage(ci, suite) : await vitestCoverage(root, run, suite);
    if (row.missing) return unknownAll(ids, "vitest is not installed (npm ci installs it)", TEST_SOURCE);
    rows.push({ ...suite, ...row });
  }
  return { "code.test_coverage_pct": coverageShare(rows) };
}

// One vitest suite's run: { coverage, via }, or { missing } without vitest.
async function vitestCoverage(root, run, suite) {
  const scratch = mkdtempSync(join(tmpdir(), "quality-vitest-"));
  try {
    const r = await run(
      join(root, "node_modules/.bin/vitest"),
      ["run", ...suite.args, ...coverageArgs(suite, scratch)],
      { cwd: join(root, suite.cwd ?? "."), timeoutMs: 900_000 },
    );
    if (r.missing) return { missing: true };
    return { coverage: readCoverage(root, suite, join(scratch, "coverage/coverage-summary.json")), via: VITEST };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// One node:test suite's coverage from the lcov block its job printed, in the
// newest successful run of its workflow on the default branch: { coverage, via },
// coverage a reason string when the run, job or block is missing.
async function nodeCoverage({ client, repo, branch }, suite) {
  const via = `node --test --experimental-test-coverage lcov printed by ${suite.workflow} job ${suite.job}`;
  const fail = (why) => ({ coverage: `${suite.label}: ${why}`, via });
  if (!suite.workflow || !suite.job) return fail("a node suite needs workflow and job");
  if (!/^[\w.-]+\/[\w.-]+$/.test(String(repo))) return fail("no repo: set params.repo in quality/targets/github.json");
  const gh = client();
  const found = await newestJob(gh, repo, branch, suite);
  if (typeof found === "string") return fail(found);
  const { run, job } = found;
  const text = lcovFromLog(await gh.text(`repos/${repo}/actions/jobs/${job.id}/logs`), suite.label);
  if (text == null) return fail(`the log of ${suite.workflow} run ${run.id} has no lcov block for ${suite.label} (code-lcov.mjs prints it)`);
  return { coverage: lcovCoverage(text, suite), via: `${via}, run ${run.id} (${String(run.created_at).slice(0, 10)})` };
}

// The suite's job in the newest successful run of its workflow on the default
// branch, { run, job }, or the reason there is none. A job a reusable workflow
// runs is named "<caller job> / <job>", so that name matches too.
export async function newestJob(gh, repo, branch, suite) {
  const on = branch || (await gh.rest(`repos/${repo}`))?.default_branch;
  const w = await gh.rest(`repos/${repo}/actions/workflows/${encodeURIComponent(suite.workflow)}`);
  const runs = await workflowRuns(gh, repo, { id: w.id, name: w.name });
  const run = runs.find((r) => r.head_branch === on && r.status === "completed" && r.conclusion === "success");
  if (!run) return `no successful run of ${suite.workflow} on ${on}`;
  const jobs = (await runJobs(gh, [run])).get(run.id) ?? [];
  const job = jobs.find((j) => j.name === suite.job || String(j.name).endsWith(` / ${suite.job}`));
  return job ? { run, job } : `${suite.workflow} run ${run.id} has no job named ${suite.job}`;
}

// reportOnFailure: a failing test does not hide the coverage of the run.
function coverageArgs(suite, scratch) {
  return [
    "--coverage.enabled",
    "--coverage.provider=v8",
    "--coverage.reporter=json-summary",
    "--coverage.reportOnFailure",
    `--coverage.reportsDirectory=${join(scratch, "coverage")}`,
    ...Object.values(suite.cover).map((glob) => `--coverage.include=${glob}`),
  ];
}

// One suite's json-summary: its total lines and branches, and both per cover
// root from the per-file rows (keyed by absolute path). branches is null, with
// branchNote saying why, when the summary has none or a malformed count; a
// count of 0 branches is data. Returns a reason string when the summary is
// missing or unreadable.
function readCoverage(root, suite, file) {
  const summary = readJson(file);
  const count = (n) => (Number.isFinite(n?.covered) && Number.isFinite(n?.total) ? { covered: n.covered, total: n.total } : null);
  const lines = count(summary?.total?.lines);
  if (!lines) return `${suite.label}: vitest wrote no coverage summary`;
  const branches = count(summary.total.branches);
  const branchNote = branches ? null : summary.total.branches === undefined ? "reported no branch data" : "wrote malformed branch data";
  const add = (into, n) => {
    into.covered += n.covered;
    into.total += n.total;
  };
  const bases = [...new Set([root, realpathSync(root)])];
  const roots = Object.fromEntries(Object.keys(suite.cover).map((r) => [r, { lines: { covered: 0, total: 0 }, branches: { covered: 0, total: 0 } }]));
  for (const [abs, entry] of Object.entries(summary)) {
    if (abs === "total") continue;
    const path = bases.map((b) => relative(b, abs).split(sep).join("/")).find((p) => !p.startsWith("../"));
    const r = Object.keys(roots).find((k) => path?.startsWith(k + "/"));
    if (r && count(entry?.lines)) {
      add(roots[r].lines, entry.lines);
      if (count(entry.branches)) add(roots[r].branches, entry.branches);
    }
  }
  return { lines, branches, branchNote, roots };
}

// SonarQube's coverage, which the Sonar way gate's 80% names, mixes lines and
// conditions: covered lines plus covered conditions over all of both. v8's
// json-summary gives branches for conditions, but counts a condition's true
// and false outcomes apart, where SonarQube's coverage counts true once; so
// this share approximates SonarQube's coverage rather than matching it.
// Suites combine by summing, never by averaging percentages. One suite
// without a summary makes the metric unknown, since part of the code would be
// missing; one without branch data makes it lines only, named, so the share
// never mixes two definitions.
function coverageShare(rows) {
  const source = [...new Set(rows.map((r) => r.via))].join("; ");
  const missing = rows.filter((r) => typeof r.coverage === "string").map((r) => r.coverage);
  if (missing.length) return unknown([...new Set(missing)].join("; "), source);
  const sum = (key) => rows.reduce((n, r) => ({ covered: n.covered + r.coverage[key].covered, total: n.total + r.coverage[key].total }), { covered: 0, total: 0 });
  const lines = sum("lines");
  const without = rows.filter((r) => !r.coverage.branches);
  const branches = without.length ? null : sum("branches");
  const covered = lines.covered + (branches?.covered ?? 0);
  const total = lines.total + (branches?.total ?? 0);
  if (lines.total === 0) return unknown("coverage counted no lines", source);
  const pct = (n) => (n.total ? round((100 * n.covered) / n.total, 1) : 0);
  const roots = rows.flatMap((r) => Object.entries(r.coverage.roots));
  const detail = roots.flatMap(([root, n]) => [
    { label: `${root} lines`, value: pct(n.lines) },
    ...(branches && n.branches.total ? [{ label: `${root} branches`, value: pct(n.branches) }] : []),
  ]);
  const read = branches
    ? `lines and branches together: ${lines.covered} of ${lines.total} lines and ${branches.covered} of ${branches.total} branches covered`
    : `lines only, since ${Object.entries(Object.groupBy(without, (r) => r.coverage.branchNote)).map(([note, rs]) => `${rs.map((r) => r.label).join(", ")} ${note}`).join("; ")}: ${lines.covered} of ${lines.total} lines covered`;
  return measured(round((100 * covered) / total, 1), `${source}, ${read} in ${roots.map(([r]) => r).join(", ")}`, detail);
}
