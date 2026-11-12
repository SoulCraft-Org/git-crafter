// Tests collector for the Quality and Speed page: the Tests tab (id `tests`).
//
// No suite runs here: CI runs every suite. The collector reads two things:
//   - The repo, statically. git ls-files lists each suite's test files; a
//     light parse counts the skipped, todo and conditional tests, and the
//     page routes the end-to-end specs open and check with axe.
//   - CI's runs of the test workflows in params.workflows: the newest
//     RUNS_PER_WORKFLOW of each from ci.mjs's workflowRuns, their jobs from
//     ci.mjs's runJobs (one GraphQL nodes() call per 100 runs).
//
// The suites, the pages folder and the workflows are params of
// quality/targets/tests.json; the repo is github.json's params.repo, read
// through allParams so no file keeps a second copy.
//
// No metric uses a calendar window (metrics-now spec, 2026-11-03). The
// Consumption metric reads the latest event: the latest completed run of each
// test workflow whose test jobs ran, on main, or on a pull request for e2e,
// which never runs on main. Each other run metric reads the last LAST_RUNS events of its kind: runs
// on main, or passing jobs of one test job.
//
// The test jobs are found in the workflow files by the npm script a step runs
// (each workflow's params.workflows script), so a renamed job counts from the
// rename on: a workflow's job metrics start at its first run read with a job
// of that name, and their source says when that was.
//
// GitHub's REST quota is 5,000 calls an hour (gh api rate_limit). A full read
// costs one run list per workflow and one GraphQL call per 100 runs.
//
// collect() never throws: a read that fails becomes could_not_check with its
// reason, never a 0, and a metric that needs two reads needs both whole.

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import YAML from "yaml";

import { describeRun, firesOn, jobNames, LAST_RUNS, reasonFor, runJobs, RUNS_PER_WORKFLOW, workflowRuns } from "../ci/ci.mjs";
import { GhError, ghClient, percentile } from "../github/github.mjs";
import { gitFiles, PARAMS, readRepo, settings } from "./tests-source.mjs";

export { PARAMS };
export { closeParen, codeOnly, countSkips, gitFiles, normalPath, pageRoute, readRepo, routeCoverage, routeMatches, settings } from "./tests-source.mjs";

export const area = "tests";
/** Rows a list of routes or files shows before it folds the rest into a count. */
export const LIST_ROWS = 3;

const round1 = (x) => Math.round(x * 10) / 10;
const pct = (part, whole) => round1((100 * part) / whole);
const median = (values) => percentile(values, 0.5);
const ms = (iso) => Date.parse(iso);
const skip = (reason) => ({ could_not_check: reason });
const measured = (value, detail) => (detail?.length ? { value, detail } : { value });
const sum = (list, key) => list.reduce((a, x) => a + x[key], 0);

/** A reason a metric cannot be measured, which collect() reports as could_not_check. */
class Skip extends Error {}

// ---------------------------------------------------------------- CI

/**
 * A test workflow from its file: its name, whether it runs on a push to main,
 * and the names of the jobs whose steps run its script: `jobs` as they run (a
 * matrix job by every name it expands to), and `skippedAs` as GitHub names
 * them when skipped (a matrix job's name unexpanded). Throws when the file
 * names no such job.
 *
 * A params.workflows entry names its test jobs one of three ways, first that
 * is set: `job`, the name GitHub shows for the job, or a list of them (a job
 * in a called workflow reads "<caller job> / <its job>", and the caller's
 * file holds no steps to search); `step`, text a step's run holds, for a job
 * that runs a shell script; else `script`, the npm script a step runs.
 */
export function testWorkflow(text, { file, script, step, job, role }, branch = "main") {
  const doc = YAML.parse(text) ?? {};
  const base = { id: file, name: doc.name ?? file.replace(/\.ya?ml$/, ""), onMain: firesOn(doc.on, branch).push, ...(role ? { role } : {}) };
  if (job) {
    const names = (Array.isArray(job) ? job : [job]).map(String);
    return { ...base, jobs: names, skippedAs: names };
  }
  const npm = new RegExp(`\\bnpm run(?: -s)? ${script}(?![\\w:])`);
  const runs = step ? (run) => run.includes(step) : (run) => npm.test(run);
  const own = Object.entries(doc.jobs ?? {}).filter(([, j]) => (j?.steps ?? []).some((s) => runs(String(s?.run ?? ""))));
  const jobs = own.flatMap(([id, j]) => jobNames(id, j));
  if (!jobs.length) throw new Error(`.github/workflows/${file} has no job ${step ? `with a step that runs ${step}` : `that runs npm run ${script}`}`);
  const skippedAs = [...new Set(own.map(([id, j]) => String(j?.name ?? id)))];
  return { ...base, jobs, skippedAs };
}

// Jobs come from ci.mjs's runJobs; tests import it from here too.
export { runJobs };

/** The runs read, as targets/tests.json's run sources state it. */
export const WINDOW = `newest ${RUNS_PER_WORKFLOW} runs a workflow`;
/** The last N each run metric reads, as its source states it. */
export const LAST = `last ${LAST_RUNS}`;
const byNewest = (a, b) => ms(b.created_at) - ms(a.created_at);
const utc = (t) => `${new Date(t).toISOString().slice(0, 16).replace("T", " ")} UTC`;

// Each metric's source is its target's: one text, in targets/tests.json.
const SOURCE = Object.fromEntries(JSON.parse(readFileSync(new URL("../../targets/tests.json", import.meta.url), "utf8")).map((t) => [t.id, t.source]));

function readers({ root, gh, repo, now, listFiles, cfg, branch }) {
  const once = (fn) => {
    let p;
    return () => (p ??= fn());
  };
  const R = {};
  R.repo = once(() => readRepo(root, listFiles, cfg));
  R.branch = once(() => defaultBranch(gh, repo, branch));
  R.workflows = once(async () => loadWorkflows(root, cfg, await R.branch()));
  R.runs = once(() => loadRuns(gh, repo, R));
  R.jobs = once(() => loadJobs(gh, R));
  return R;
}

// The repo's default branch: a param when one names it, else GitHub's
// answer, one REST call. Never assumed to be main.
async function defaultBranch(gh, repo, branch) {
  if (branch) return branch;
  const found = (await gh.rest(`repos/${repo}`))?.default_branch;
  if (!found) throw new Skip(`gh api repos/${repo} named no default branch`);
  return found;
}

function loadWorkflows(root, cfg, main) {
  return cfg.workflows.map((w) => {
    let text;
    try {
      text = readFileSync(path.join(root, ".github", "workflows", w.file), "utf8");
    } catch {
      throw new Skip(`.github/workflows/${w.file} is missing`);
    }
    return testWorkflow(text, w, main);
  });
}

// Each workflow's newest RUNS_PER_WORKFLOW runs, newest first: one call each.
async function loadRuns(gh, repo, R) {
  const lists = [];
  for (const w of await R.workflows()) lists.push(await workflowRuns(gh, repo, w));
  return lists.flat().sort(byNewest);
}

// Finished runs that were not cancelled, each with `named`, its test jobs
// by name, skipped ones too, and `tests`, the ones that ran, timed by
// ci.mjs's describeRun. Per workflow, `since` is the first such run with a
// test job; `cut` says earlier runs had none, as before a job was renamed,
// so the workflow's metrics start at `since` and say so.
async function loadJobs(gh, R) {
  const done = (await R.runs()).filter((r) => r.status === "completed" && r.conclusion !== "cancelled");
  const jobs = await runJobs(gh, done);
  const ws = await R.workflows();
  const runs = done.map((r) => {
    const w = ws.find((x) => x.name === r.workflow);
    const all = jobs.get(r.id);
    return {
      ...r,
      named: all.filter((j) => w.jobs.includes(j.name) || w.skippedAs.includes(j.name)),
      tests: describeRun(r, all).jobs.filter((j) => w.jobs.includes(j.name)),
    };
  });
  const starts = new Map(
    ws.map((w) => {
      const own = runs.filter((r) => r.workflow === w.name);
      const since = Math.min(...own.filter((r) => r.named.length).map((r) => ms(r.created_at)));
      return [w.name, { since, cut: own.some((r) => ms(r.created_at) < since) }];
    }),
  );
  return { runs, starts };
}

/** A workflow's start, in words, when its window starts late; or null. */
function startNote(w, starts) {
  const { since, cut } = starts.get(w.name);
  return cut && Number.isFinite(since) ? `${w.name} from ${utc(since)}, its first run read with a test job` : null;
}

/** The last LAST_RUNS passing jobs with one of these names, newest first, each with its run's event. */
const lastPassing = (runs, names) =>
  runs
    .flatMap((r) => r.tests.filter((j) => names.includes(j.name) && j.conclusion === "success").map((j) => ({ ...j, event: r.event })))
    .sort((a, b) => ms(b.completed_at) - ms(a.completed_at))
    .slice(0, LAST_RUNS);

/** A test workflow's runs with their jobs from its start, and the note on where that is. `role` is params.workflows' suite or e2e. */
async function workflowJobs(R, { file, role }) {
  const w = (await R.workflows()).find((x) => (file ? x.id === file : x.role === role));
  if (!w) throw new Skip(`params.workflows names no ${role} workflow`);
  const { runs, starts } = await R.jobs();
  const { since } = starts.get(w.name);
  return { w, runs: runs.filter((r) => r.workflow === w.name && ms(r.created_at) >= since), note: startNote(w, starts) };
}

/** The suite workflow's test job: its last LAST_RUNS passing jobs and their median minutes. */
async function suiteJob(R) {
  const { w, runs, note } = await workflowJobs(R, { role: "suite" });
  const jobs = lastPassing(runs, w.jobs);
  if (!jobs.length) throw new Skip(`no ${w.jobs.join(" or ")} job passed in the ${WINDOW}`);
  return { w, jobs, note, minutes: median(jobs.map((j) => j.minutes)) };
}

// ---------------------------------------------------------------- metrics

function unlisted(routes, covered, more) {
  const left = routes.filter((r) => !covered.has(r));
  const rows = left.slice(0, LIST_ROWS).map((r) => ({ label: r, value: 0, unit: "specs" }));
  if (left.length > LIST_ROWS) rows.push({ label: more, value: left.length - LIST_ROWS, unit: "routes" });
  return rows;
}

/** How one run on main counts: no test job, all skipped, or passed or failed by the jobs that ran. */
function classify(r) {
  if (!r.named.length) return "none";
  const ran = r.named.filter((j) => j.conclusion !== "skipped");
  if (!ran.length) return r.conclusion === "success" ? "unchanged" : "skippedInFailed";
  return ran.every((j) => j.conclusion === "success") ? "success" : "failure";
}

// Per run on main from its workflow's start: cancelled runs; runs whose
// test job was skipped, as no site change only when the run passed (a
// failed change job also skips it); runs with no test job; and runs that
// passed only when every test job that ran passed. Adds each late start to notes.
function tallyMain({ onMain, all, runs, starts, main, notes }) {
  const tally = { success: 0, failure: 0, cancelled: 0, unchanged: 0, skippedInFailed: 0, none: 0 };
  for (const w of onMain) {
    const { since } = starts.get(w.name);
    if (!Number.isFinite(since)) continue;
    const note = startNote(w, starts);
    if (note) notes.push(note);
    // The last LAST_RUNS finished runs on main from the workflow's start.
    const last = new Set(
      all
        .filter((r) => r.workflow === w.name && r.event === "push" && r.head_branch === main && r.status === "completed" && ms(r.created_at) >= since)
        .slice(0, LAST_RUNS)
        .map((r) => r.id),
    );
    tally.cancelled += all.filter((r) => last.has(r.id) && r.conclusion === "cancelled").length;
    for (const r of runs.filter((x) => last.has(x.id))) tally[classify(r)] += 1;
  }
  return tally;
}

function passRows(tally) {
  const rows = [
    { label: "Passed", value: tally.success, unit: "runs" },
    { label: "Failed", value: tally.failure, unit: "runs" },
    { label: "Cancelled, left out", value: tally.cancelled, unit: "runs" },
    { label: "No site change, test job skipped, left out", value: tally.unchanged, unit: "runs" },
  ];
  if (tally.skippedInFailed) rows.push({ label: "Test job skipped in a failed run, left out", value: tally.skippedInFailed, unit: "runs" });
  if (tally.none) rows.push({ label: "No test job in the run, left out", value: tally.none, unit: "runs" });
  return rows;
}

const METRICS = {
  "tests.e2e_routes": {
    async run(R, ctx) {
      const { routes, visited, specCount } = await R.repo();
      if (!routes.length) return skip(`git ls-files listed no page in params.pages_dir (${ctx.cfg.pagesDir || "unset"})`);
      if (!specCount) return skip(`git ls-files listed no spec in the e2e suite of params.suites (${ctx.cfg.e2e?.dir ?? "none"})`);
      return measured(pct(visited.size, routes.length), unlisted(routes, visited, "More routes no spec opens"));
    },
  },
  "tests.axe_routes": {
    async run(R, ctx) {
      const { routes, axe, specCount } = await R.repo();
      if (!routes.length) return skip(`git ls-files listed no page in params.pages_dir (${ctx.cfg.pagesDir || "unset"})`);
      if (!specCount) return skip(`git ls-files listed no spec in the e2e suite of params.suites (${ctx.cfg.e2e?.dir ?? "none"})`);
      return measured(pct(axe.size, routes.length), unlisted(routes, axe, "More routes with no axe check"));
    },
  },
  "tests.skipped": {
    async run(R) {
      const { suites } = await R.repo();
      if (!suites.length) return skip("params.suites names no test suite");
      if (!sum(suites, "files")) return skip("git ls-files listed no test file in any suite folder");
      // The value is the tests that never run. Skips on a condition are read
      // from the code, not from a run, so they show in a row outside it.
      const all = suites.flatMap((s) => s.skipped);
      const files = all.filter((f) => f.skips).sort((a, b) => b.skips - a.skips || a.file.localeCompare(b.file));
      const rows = files.slice(0, LIST_ROWS).map((f) => ({ label: f.file, value: f.skips, unit: "" }));
      if (files.length > LIST_ROWS) rows.push({ label: "In other files", value: sum(files.slice(LIST_ROWS), "skips"), unit: "" });
      rows.push({ label: "Not counted, on a condition: skipIf, runIf or a skip at run time", value: sum(all, "conditional"), unit: "" });
      return measured(sum(files, "skips"), rows);
    },
  },
  "tests.main_pass_rate": {
    async run(R) {
      const ws = await R.workflows();
      const onMain = ws.filter((w) => w.onMain);
      const main = await R.branch();
      if (!onMain.length) return skip(`no test workflow runs on a push to ${main}, the default branch`);
      const { runs, starts } = await R.jobs();
      const notes = [];
      const tally = tallyMain({ onMain, all: await R.runs(), runs, starts, main, notes });
      const decided = tally.success + tally.failure;
      if (!decided) return skip(`no test job ran in the ${LAST} runs on main; ${tally.cancelled} cancelled runs left out`);
      const notOnMain = ws.filter((w) => !w.onMain).map((w) => w.name);
      if (notOnMain.length) notes.push(`${notOnMain.join(" and ")} runs only on pull requests`);
      return { ...measured(pct(tally.success, decided), passRows(tally)), note: notes.join("; ") || undefined };
    },
  },
  "tests.site_tests_p50": {
    async run(R) {
      const { jobs, note, minutes } = await suiteJob(R);
      const rows = [
        ["Pull requests", "pull_request"],
        ["Pushes to main", "push"],
      ]
        .map(([label, event]) => ({ label, minutes: jobs.filter((j) => j.event === event).map((j) => j.minutes) }))
        .filter((x) => x.minutes.length)
        .map((x) => ({ label: x.label, value: round1(median(x.minutes)) }));
      return { ...measured(round1(minutes), rows), note };
    },
  },
  "tests.e2e_shard_p50": {
    async run(R) {
      const { w, runs, note } = await workflowJobs(R, { role: "e2e" });
      const shards = w.jobs.map((name) => ({ label: name, minutes: lastPassing(runs, [name]).map((j) => j.minutes) }));
      // Every shard or none: the slowest of fewer shards would read faster.
      const missing = shards.find((s) => !s.minutes.length);
      if (missing) return skip(`no ${missing.label} job passed in the ${WINDOW}`);
      const detail = shards.map((s) => ({ label: s.label, value: round1(median(s.minutes)) }));
      return { ...measured(Math.max(...detail.map((d) => d.value)), detail), note };
    },
  },
  // Billed minutes of the test jobs in the latest completed run of each test
  // workflow whose test jobs ran: on main where the workflow runs there, else
  // its latest pull request run. GitHub bills each job by the whole minute
  // (ci.mjs's describeRun), so this reads no more than the runs and jobs above.
  "tests.ci_minutes_latest_main": {
    async run(R) {
      const rows = [];
      const notes = [];
      const main = await R.branch();
      for (const w of await R.workflows()) {
        const { runs, note } = await workflowJobs(R, { file: w.id });
        if (note) notes.push(note);
        const latest = runs.find((r) => r.tests.length && (!w.onMain || (r.event === "push" && r.head_branch === main)));
        if (!latest) return skip(`no ${w.name} run ${w.onMain ? "on main " : ""}ran a test job in the ${WINDOW}`);
        if (!w.onMain) notes.push(`${w.name} never runs on main: its latest pull request run, ${latest.id}`);
        for (const j of latest.tests) rows.push({ label: `${j.name}, run ${latest.id}`, value: j.billed });
      }
      return { ...measured(sum(rows, "value"), rows), note: notes.join("; ") || undefined };
    },
  },
};

export const METRIC_IDS = Object.keys(METRICS);

/**
 * Reads every Tests metric. gh (rest and graphql), now and listFiles are
 * injectable for tests; the defaults are the gh CLI, the clock and git. The
 * repo is github.json's params.repo, else this file's, else GITHUB_REPOSITORY;
 * the default branch is ci.json's or this file's params.default_branch,
 * else GitHub's answer for the repo.
 */
export async function collect({
  root = process.cwd(),
  params = PARAMS,
  allParams = {},
  gh = ghClient(),
  now = Date.now(),
  repo = allParams["github.json"]?.repo || params.repo || process.env.GITHUB_REPOSITORY || "",
  branch = allParams["ci.json"]?.default_branch || params.default_branch || "",
  listFiles = gitFiles,
} = {}) {
  const cfg = settings(params);
  const ctx = { root, gh, repo, now: Number(now), listFiles, cfg, branch };
  const R = readers(ctx);
  const needsRepo = new Set(["tests.main_pass_rate", "tests.site_tests_p50", "tests.e2e_shard_p50", "tests.ci_minutes_latest_main"]);
  const entries = await Promise.all(
    Object.entries(METRICS).map(async ([id, metric]) => {
      const source = SOURCE[id];
      if (needsRepo.has(id) && !/^[\w.-]+\/[\w.-]+$/.test(repo)) return [id, { could_not_check: "no repo: set params.repo in quality/targets/github.json", source }];
      if (needsRepo.has(id) && !cfg.workflows.length) return [id, { could_not_check: "params.workflows names no test workflow", source }];
      try {
        const { note, ...result } = await metric.run(R, ctx);
        if (result.could_not_check) return [id, { could_not_check: result.could_not_check, source }];
        return [id, { ...result, source: note ? `${source}; ${note}` : source, read_at: new Date().toISOString() }];
      } catch (err) {
        return [id, { could_not_check: err instanceof GhError ? reasonFor(err) : (err?.message ?? String(err)), source }];
      }
    }),
  );
  return Object.fromEntries(entries);
}
