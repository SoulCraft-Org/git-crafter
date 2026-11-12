// The Code tab's collector. Quality is how small, simple, commented and current
// the code is; speed is how fast it runs and builds. Every value is read in this
// run from a file, a command or production. Anything that cannot be read is
// could_not_check with the reason, never 0, and nothing here throws.
//
// "The code" is the folders in params.areas, without tests, generated files (a
// "Do not edit" header) or build output. The steps run one at a time, the test
// suite last. Nothing writes to the repo; scratch output goes to the OS temp
// folder and is removed.
//
// Every repo-specific value is a param: the code folders, the folders never
// walked, the limits, the naming rules, the Workers, the built site and the
// test suites. The engine passes the params of quality/targets/code.json after
// the repo's override; without them, the template's own defaults apply.
import { readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { ciClient, runJobs, workflowRuns } from "../ci/ci.mjs";
import { clientJs } from "./code-client.mjs";
import { deadCode } from "./code-dead.mjs";
import { STATIC_IDS, staticMetrics } from "./code-files.mjs";
import { BUNDLE_SOURCE, CPU_SOURCE, cpuTime, STARTUP_SOURCE, WORKER_IDS, workerBundles, workerStartup } from "./code-prod.mjs";
import { STRUCTURE_IDS, STRUCTURE_SOURCE, structure } from "./code-structure.mjs";
import { TEST_SOURCE, testCoverage } from "./code-test.mjs";
import { isDir, measured, nestedIn, runCommand, top, unknown, unknownAll, walk } from "./code-util.mjs";
import { ghClient } from "../github/github.mjs";

export { cfJson, latestDeploy } from "./code-prod.mjs";
export { knipConfig, summarizeKnip } from "./code-dead.mjs";
export { runCommand } from "./code-util.mjs";

export const area = "code";
const TARGETS = JSON.parse(readFileSync(new URL("../../targets/code.json", import.meta.url), "utf8"));
export const PARAMS = Object.assign({}, ...TARGETS.map((t) => t.params ?? {}));

// Every Code metric for one run, keyed by id: measured, or could_not_check
// with the reason. mode "local" adds the steps that read production.
export async function collect({ root, mode, params = PARAMS, allParams = {}, targets = null, run = runCommand, gh = null }) {
  const local = mode === "local";
  const p = settings(params, allParams);
  const repo = allParams["github.json"]?.repo || process.env.GITHUB_REPOSITORY || "";
  // The bundle step goes first: it is the only step this run times, and later
  // in the run it shared the runner's CPUs with knip here and with the
  // Playwright collectors beside this one. A 0.65 s dry run read 5 to 10 s
  // there (a site repo's quality-pages run, after its
  // bundles halved). check_seconds reads a past run's time from GitHub.
  const steps = [
    [["code.worker_bundle_kb", "code.build_seconds"], BUNDLE_SOURCE, () => workerBundles(root, run, p.workers)],
    [["code.worker_startup_ms"], STARTUP_SOURCE, () => workerStartup(root, local, run, p.workers)],
    [STATIC_IDS, "files under " + p.areas.join(", "), () => staticMetrics(root, run, p)],
    [STRUCTURE_IDS, STRUCTURE_SOURCE, () => structure(root, run, p)],
    [WORKER_IDS, CPU_SOURCE, () => cpuTime(root, local, run, p.workers, p.lastRequests)],
    [["code.dead_files", "code.dead_exports", "code.dead_dependencies"], "knip", () => deadCode(root, run, p.areas)],
    [["code.client_js_kb"], "params.client_dist", () => clientJs(root, run, p.clientDist)],
    [["code.test_coverage_pct"], TEST_SOURCE, () => testCoverage(root, local, run, p.suites, { client: () => gh ?? ciClient(), repo, branch: p.branch })],
    [TOKEN_IDS, TOKENS_SOURCE, () => codeTokens(root, p)],
    [["code.check_seconds"], CHECK_SOURCE, () => checkSeconds(() => gh ?? ghClient(), repo, p)],
  ];
  // The engine passes the metrics that are on. A step whose metrics are all
  // off, dropped or on a hidden tab, does not run: no knip or wrangler run
  // whose result nobody reads.
  const on = targets && new Set(targets.map((t) => t.id));
  const out = {};
  for (const [ids, source, step] of steps) {
    if (on && !ids.some((id) => on.has(id))) continue;
    try {
      Object.assign(out, await step());
    } catch (err) {
      Object.assign(out, unknownAll(ids, `collector error: ${err instanceof Error ? err.message : err}`, source));
    }
  }
  return out;
}

// The params in the shapes the steps use. A missing one stays empty, and the
// step that needs it reports could_not_check naming the param. The default
// branch is ci.json's params.default_branch, where the Actions tab keeps it, else
// this file's main_branch; with neither, main's history is HEAD's.
function settings(params, allParams = {}) {
  const list = (x) => (Array.isArray(x) ? x : []);
  const branch = allParams["ci.json"]?.default_branch || params.main_branch || "";
  return {
    areas: list(params.areas),
    skip: new Set([".git", ...list(params.skip_dirs)]),
    mainRefs: branch ? [`origin/${branch}`, branch, "HEAD"] : ["HEAD"],
    mergedPrs: Number(params.merged_prs),
    lastRequests: Number(params.last_requests),
    limits: params.limits ?? {},
    naming: list(params.naming),
    workers: list(params.workers),
    clientDist: params.client_dist ?? null,
    suites: list(params.test_suites),
    check: params.check ?? null,
    bytesPerToken: Number(params.bytes_per_token),
    sizeExtra: list(params.size_extra),
    branch,
  };
}

// ---- Speed and consumption any repo has, Worker or not ----

// What a session reads to hold one area's code, since a session loads the area
// it works in just in time, not the whole repo: the bytes of every code file in
// the largest area of params.areas, tests included, at params.bytes_per_token bytes a token.
// The largest single file is read the same way: one Read call returns a file
// whole only up to a token limit, so a larger one costs a call per page. The
// folders in params.size_extra (tests, say) count for the largest file only:
// a session reads a test file whole too, but no area holds it (#738).
const TOKEN_IDS = ["code.code_tokens", "code.largest_file_tokens"];
const TOKENS_SOURCE = "state: bytes of the code files in the largest area of params.areas, tests included, over params.bytes_per_token";
const FILE_SOURCE = "state: bytes of the largest code file in params.areas and params.size_extra, tests included, over params.bytes_per_token";
function codeTokens(root, { areas, skip, bytesPerToken, sizeExtra = [] }) {
  if (!(bytesPerToken > 0)) return unknownAll(TOKEN_IDS, "params.bytes_per_token is not a positive number; set it in quality/targets/code.json", TOKENS_SOURCE);
  if (!areas.length) return unknownAll(TOKEN_IDS, "params.areas names no code folder", TOKENS_SOURCE);
  const missing = areas.filter((a) => !isDir(join(root, a)));
  if (missing.length) return unknownAll(TOKEN_IDS, `area not found: ${missing.join(", ")}; update params.areas in quality/targets/code.json`, TOKENS_SOURCE);
  // A missing size_extra folder blinds the largest file only, never an area's tokens.
  const extraMissing = sizeExtra.filter((a) => !isDir(join(root, a)));
  const files = [];
  const tokens = areas.map((a) => {
    let bytes = 0;
    for (const abs of walk(join(root, a), skip, nestedIn(root, a, areas))) {
      const size = statSync(abs).size;
      bytes += size;
      files.push({ label: relative(root, abs).split(sep).join("/"), value: Math.round(size / bytesPerToken), unit: "tokens" });
    }
    return { label: a, value: Math.round(bytes / bytesPerToken), unit: "tokens" };
  });
  for (const extra of extraMissing.length ? [] : sizeExtra) {
    for (const abs of walk(join(root, extra), skip, nestedIn(root, extra, areas))) {
      files.push({ label: relative(root, abs).split(sep).join("/"), value: Math.round(statSync(abs).size / bytesPerToken), unit: "tokens" });
    }
  }
  tokens.sort((x, y) => y.value - x.value);
  files.sort((x, y) => y.value - x.value);
  return {
    "code.code_tokens": measured(tokens[0].value, `${TOKENS_SOURCE}: ${tokens[0].label}`, tokens),
    "code.largest_file_tokens": extraMissing.length ? unknown(`size_extra folder not found: ${extraMissing.join(", ")}; update params.size_extra in quality/targets/code.json`, FILE_SOURCE) : files.length ? measured(files[0].value, `${FILE_SOURCE}: ${files[0].label}`, top(files, (f) => f, 10)) : unknown("no code file in the areas", FILE_SOURCE),
  };
}

// The check a change waits on: params.check { workflow, job } names it. Its
// wall time in the newest successful run of that workflow on the default
// branch, a latest-event basis. A job a reusable workflow runs is named
// "<caller job> / <job>", so a name ending in " / <job>" matches too.
const CHECK_SOURCE = "latest: wall time of params.check's job in its workflow's newest successful run on the default branch";
export const CHECK_RUNS = 10;
async function checkSeconds(client, repo, { check, branch }) {
  const id = "code.check_seconds";
  if (!check?.workflow || !check?.job) return { [id]: unknown("params.check names no { workflow, job }", CHECK_SOURCE) };
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return { [id]: unknown("no repo: set params.repo in quality/targets/github.json", CHECK_SOURCE) };
  const gh = client();
  const on = branch || (await gh.rest(`repos/${repo}`))?.default_branch;
  const w = await gh.rest(`repos/${repo}/actions/workflows/${encodeURIComponent(check.workflow)}`);
  const runs = (await workflowRuns(gh, repo, { id: w.id, name: w.name }))
    .filter((r) => r.head_branch === on && r.status === "completed" && r.conclusion === "success")
    .slice(0, CHECK_RUNS);
  if (!runs.length) return { [id]: unknown(`no successful run of ${check.workflow} on ${on}`, CHECK_SOURCE) };
  const jobs = await runJobs(gh, runs);
  const named = (j) => j.name === check.job || String(j.name).endsWith(` / ${check.job}`);
  // Newest first: the value is the newest run's time, and each run is a bar.
  const timed = runs.flatMap((r) => {
    const job = (jobs.get(r.id) ?? []).find((j) => named(j) && j.conclusion === "success" && j.started_at && j.completed_at);
    return job ? [{ run: r, job, seconds: Math.round((Date.parse(job.completed_at) - Date.parse(job.started_at)) / 1000) }] : [];
  });
  if (timed.length) {
    const { run, job, seconds } = timed[0];
    const detail = timed.map((t) => ({ label: `${String(t.run.created_at).slice(0, 10)} run ${t.run.id}`, value: t.seconds, unit: "s" }));
    return { [id]: measured(seconds, `${CHECK_SOURCE}: ${check.workflow} job ${job.name}, run ${run.id} (${String(run.created_at).slice(0, 10)}); detail is its newest ${timed.length} runs`, detail) };
  }
  return { [id]: unknown(`no job named ${check.job} passed in the newest ${runs.length} successful runs of ${check.workflow}`, CHECK_SOURCE) };
}
