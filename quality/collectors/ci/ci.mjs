// CI collector for the Quality, Speed and Consumption page. It fills the CI
// tab (id `actions`) and the runner cost of three others. github.mjs checks
// the workflow files themselves (pinned actions, explicit permissions); this
// collector measures their runs: runs that did real work timed apart from
// light ones, flaky reruns, the npm cache, push to all green per pull
// request head, and which triggers skip work when nothing they check changed.
// Its flow metric draws the whole pipeline, edit to deploy, from the repo's
// own hook and workflow files and the stages its params name. Consumption:
// runner dollars per merged pull request (Pull requests tab), runner minutes
// per issue fixed (Issues tab), per pull request of the latest Done
// card (Projects tab, whose board github.mjs reads), per security scan (Security and
// settings tab) and per push to the default branch (this tab), in ci-spend.mjs.
//
// No metric uses a calendar window or averages over one. Each is a state of
// the repo's files or runs (the latest green head, each stage's latest run,
// how long the default branch has been red), the latest event (the latest
// merge's, fix's and scan's own runs, priced from their jobs), or a share of
// the last N events, where new work replaces old:
//   - the last LAST_RUNS runs of each workflow;
//   - the last LAST_PRS closed and merged pull requests.
//
// Every read is `gh api`, so the same code runs in CI on GITHUB_TOKEN and in a
// session. collect() never throws: a read that fails becomes could_not_check
// with its reason, never a 0 (the collector contract).
//
// Calls per read: 1 workflow list; 1 run list per workflow file (GitHub's
// dynamic Dependabot workflows are not read); the jobs of the last 20 runs per
// workflow in GraphQL nodes() calls of 25 runs; REST jobs for the newest
// QUEUE_SAMPLE runs per workflow, for queue times, and for any other run a
// Consumption metric prices, each read once; LOG_SAMPLE job logs; one
// attempts lookup per rerun that passed; 1 page of closed pull requests; 1
// GraphQL call for the issues each merged pull request closed; and, when
// params.deploy_apps names a deploy app, check runs for the last 20 merge
// commits.
//
// The engine calls collect({ root, mode, params, targets }), as for
// github.mjs. The repo is params.repo or GITHUB_REPOSITORY. The other params:
//   default_branch  the branch a push trigger must cover to count; empty reads
//                   the repo's default branch from gh api repos/{repo}
//   hooks_dir       the folder of versioned git hooks (".githooks")
//   hook_says       [{ match, says }]: a pattern in a hook's code and the words
//                   that say what it does
//   hook_checks     a pattern whose first matched group names a check a hook runs
//   stages          steps no file here records, such as a person's review or a
//                   deploy: [{ label, stage, kind, runs, file, key? }]. key
//                   "review" times a stage from all green to merged; key
//                   "deploy" from merged to each deploy app's check run
//   deploy_apps     slugs of the GitHub Apps whose check runs on a merge commit
//                   are deploys
//   security_workflows  a pattern for the names of the workflows that scan
//                   for vulnerabilities and secrets; GitHub's dynamic
//                   CodeQL - Code Quality run is read with them for the Code tab

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";

import { ConfigError, GhError, ghClient, projectSettings, readProject, refusingGh, repoOf } from "../github/github.mjs";
import { adminGh, gated } from "../github/github-core.mjs";
import { once } from "../github/github-loaders.mjs";
import { runsOnPush } from "./ci-workflows.mjs";
import { TARGETS_FILE, RUNS_PER_WORKFLOW, LAST_RUNS, LAST_PRS, QUEUE_SAMPLE, LOG_SAMPLE, LAST, CODE_QUALITY, round1, pct, skip, measured, ms, completed, newest, groupBy, mapLimit } from "./ci-core.mjs";
import { describeRun, pushToGreen, cacheVerdict, weightedLightShare, commonStart } from "./ci-describe.mjs";
import { skipTriggers } from "./ci-stages.mjs";
import { pipelineDetail } from "./ci-detail.mjs";
import { reasonFor, settings } from "./ci-settings.mjs";
import { workflowRuns, runJobs, flakyChecks } from "./ci-runs.mjs";
import { INSIGHT_METRICS } from "./ci-insights.mjs";
import { SPEND_METRICS } from "./ci-spend.mjs";
import { headroom, QUOTA_SOURCE, readQuota } from "../github/github-quota.mjs";
import { prRunRequests } from "../lib/quota.mjs";

export { workflowRuns, JOBS_BATCH, JOBS_BATCH_WITH_STEPS, runJobs, flakyChecks, prRuns, latestPriced, priceRuns } from "./ci-runs.mjs";
export { reasonFor, settings } from "./ci-settings.mjs";
export { pipelineStages, skipTriggers } from "./ci-stages.mjs";
export { LIGHT_SPAN_SECONDS, describeRun, pushToGreen, cacheVerdict, weightedLightShare, commonStart } from "./ci-describe.mjs";
export { RUNS_PER_WORKFLOW, LAST_RUNS, LAST_PRS, QUEUE_SAMPLE, LOG_SAMPLE, RUNNER_RATES, runnerRate, STAGE_ORDER } from "./ci-core.mjs";
export { firesOn, hookCode, hookRuns, shardCount, jobNames, jobGraph } from "./ci-workflows.mjs";

export const area = "ci";
// Reads the GitHub API: collect.mjs skips it under the API reserve (ci.json params.api_reserve).
export const githubApi = true;

// This file's own targets and params: the defaults when the engine passes none.
const OWN_TARGETS = JSON.parse(readFileSync(new URL("../../targets/ci.json", import.meta.url), "utf8"));
const OWN_PARAMS = Object.assign({}, ...OWN_TARGETS.map((t) => t.params ?? {}));
// ---------------------------------------------------------------- gh client

/**
 * `gh api` for a route that answers plain text, such as a job's log. Logs hold
 * color codes, which gh 2.103 refuses without --allow-escape-sequences; an
 * older gh has neither the flag nor the check, so the call retries without it.
 */
function ghText(route) {
  return gated(() => spawnText(route, ["--allow-escape-sequences"]));
}

// The retry stays inside the one slot ghText holds: a second gated call here could wait on itself.
function spawnText(route, flags) {
  const env = { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" };
  return new Promise((resolve, reject) => {
    execFile("gh", ["api", ...flags, route], { env, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      if (err.code === "ENOENT") return reject(new GhError("gh is not installed; install the GitHub CLI and run gh auth login"));
      if (flags.length && /unknown flag/i.test(stderr)) return resolve(spawnText(route, []));
      const status = Number(/\(HTTP (\d{3})\)/.exec(stderr)?.[1] ?? 0);
      reject(new GhError(stderr.trim() || err.message, { status }));
    });
  });
}

/** github.mjs's JSON client plus a plain-text call for logs. */
export function ciClient() {
  return { ...ghClient(), text: ghText };
}

// ---------------------------------------------------------------- loaders

const FIXING_PULLS = `query FixingPulls($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: MERGED, first: 100, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes { number closingIssuesReferences(first: 1) { totalCount } }
    }
  }
}`;

function loaders({ gh, repo, cfg }) {
  const L = {};
  return Object.assign(L, runLoaders(L, { gh, repo, cfg }), pullLoaders(L, { gh, repo, cfg }), {
    // The project board's cards, as github.mjs reads them; read only for the card metric.
    board: once(() => readProject(gh, repo, ...repo.split("/"), projectSettings(cfg.boardParams, repo))),
  });
}

/** Memoized reads of workflows and their runs. */
function runLoaders(L, { gh, repo, cfg }) {
  const jobs = new Map();
  return {
    // A run's REST jobs, read once, described: billed minutes, runner labels, queue times.
    jobsOf: (run) => {
      if (!jobs.has(run.id)) jobs.set(run.id, gh.rest(`repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`).then((b) => describeRun(run, b.jobs ?? [])));
      return jobs.get(run.id);
    },
    // The default branch: params.default_branch, else the repo's, as github.mjs reads it.
    branch: once(async () => {
      if (cfg.branch) return cfg.branch;
      const branch = (await gh.rest(`repos/${repo}`))?.default_branch;
      if (!branch) throw new Error(`gh api repos/${repo} answered without a default_branch`);
      return branch;
    }),
    // One call per workflow in .github/workflows for its newest runs. GitHub's
    // dynamic workflows (Dependabot) are left out: no file here changes them.
    listed: once(async () => (await gh.rest(`repos/${repo}/actions/workflows?per_page=100`)).workflows ?? []),
    lists: once(async () => {
      const own = (await L.listed()).filter((w) => !String(w.path ?? "").startsWith("dynamic/"));
      return mapLimit(own, 4, (w) => workflowRuns(gh, repo, w));
    }),
    // Every run read since the start of the shortest full list, so a head or a
    // pull request after that start has every workflow's runs.
    covered: once(async () => {
      const lists = await L.lists();
      const start = commonStart(lists, -Infinity);
      return { start, runs: lists.flat().filter((r) => ms(r.created_at) >= start) };
    }),
    runs: once(async () => (await L.lists()).flatMap((list) => list.slice(0, LAST_RUNS))),
    // The last LAST_RUNS runs per workflow with their jobs and steps, from GraphQL.
    described: once(async () => {
      const done = (await L.runs()).filter(completed);
      const jobs = await runJobs(gh, done, { steps: true });
      return done.map((r) => describeRun(r, jobs.get(r.id)));
    }),
    // REST jobs, which carry created_at, for the newest QUEUE_SAMPLE of those runs per workflow.
    queued: once(async () => {
      const picked = (await L.lists()).flatMap((list) => list.slice(0, LAST_RUNS).filter(completed).slice(0, QUEUE_SAMPLE));
      return mapLimit(picked, 8, (r) => L.jobsOf(r));
    }),
  };
}

/** Memoized reads of pull requests, scans, closing issues and deploy checks. */
function pullLoaders(L, { gh, repo, cfg }) {
  return {
    // One page of closed pull requests: the last LAST_PRS closed and the last LAST_PRS merged.
    pulls: once(async () => {
      const list = await gh.rest(`repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100`);
      if (!Array.isArray(list)) throw new GhError("the closed pull requests came back without a list");
      const closed = list.filter((p) => p.closed_at).sort((a, b) => ms(b.closed_at) - ms(a.closed_at));
      const merged = closed.filter((p) => p.merged_at).sort((a, b) => ms(b.merged_at) - ms(a.merged_at));
      return { closed: closed.slice(0, LAST_PRS), merged: merged.slice(0, LAST_PRS), allMerged: merged };
    }),
    // GitHub's own scan workflows (CodeQL default setup and Code Quality run as
    // dynamic workflows), which no file here holds: each one's latest passed
    // run, with its REST jobs. Read only for the scan metrics, so the run
    // metrics still cover only the repo's own workflows.
    dynamicScans: once(async () => {
      const scans = (await L.listed()).filter((w) => String(w.path ?? "").startsWith("dynamic/") && (w.name === CODE_QUALITY || cfg.securityWorkflows.test(w.name ?? "")));
      const out = [];
      for (const w of scans) {
        const passed = (await workflowRuns(gh, repo, w)).filter((r) => completed(r) && r.conclusion === "success");
        if (passed.length) out.push([w.name, await L.jobsOf(newest(passed))]);
      }
      return out;
    }),
    // How many issues each recently merged pull request closed, by number.
    closes: once(async () => {
      const [owner, name] = repo.split("/");
      const data = await gh.graphql(FIXING_PULLS, { owner, name });
      return new Map((data?.repository?.pullRequests?.nodes ?? []).map((p) => [p.number, p.closingIssuesReferences?.totalCount ?? 0]));
    }),
    // The check runs a deploy app (params.deploy_apps) posts on each of the
    // last LAST_PRS merge commits, each with its pull request's merge time. A
    // build posts its check run when it ends, so a deploy is timed from the
    // merge to that check run's finish. No call when no deploy app is named.
    deployChecks: once(async () => {
      if (!cfg.deployApps.length) return [];
      const merged = (await L.pulls()).merged.filter((p) => /^[0-9a-z]+$/i.test(String(p.merge_commit_sha ?? "")));
      const bodies = await mapLimit(merged, 8, (p) => gh.rest(`repos/${repo}/commits/${p.merge_commit_sha}/check-runs?per_page=100`));
      return bodies.flatMap((b, i) => (b.check_runs ?? []).filter((c) => cfg.deployApps.includes(c.app?.slug)).map((c) => ({ ...c, merged_at: merged[i].merged_at })));
    }),
  };
}

/** Per workflow, the wall minutes of its latest run that did real work. */
function latestFullRun(sample) {
  const full = sample.filter((r) => r.conclusion === "success" && !r.light && r.wall !== null);
  const detail = [...groupBy(full, (r) => r.workflow)].map(([label, g]) => ({ label, value: round1(newest(g).wall) }));
  if (!detail.length) return skip(`no run did real work in the ${LAST}`);
  return measured(Math.max(...detail.map((d) => d.value)), detail);
}

// ---------------------------------------------------------------- metrics

// ci.pr_run_requests reads at most this many runs: a docs-only run skips the collect, so no job prints a notice.
const PR_RUNS_READ = 3;

const METRICS = {
  "ci.flaky_reruns": {
    source: `gh api actions/workflows/{id}/runs (${LAST}) and runs/{id}/attempts/1 for every rerun that passed`,
    async run(L, { gh, repo }) {
      const { pairs, flaky, byWorkflow } = await flakyChecks(gh, repo, await L.runs());
      if (!pairs.size) return skip(`no run passed or failed in the ${LAST}`);
      return measured(pct(flaky.length, pairs.size), byWorkflow);
    },
  },
  "ci.cache_hit_rate": {
    source: `gh api repos/{repo}/actions/jobs/{id}/logs (setup-node's npm cache line, newest ${LOG_SAMPLE} jobs)`,
    async run(L, { gh, repo }) {
      const jobs = (await L.described())
        .flatMap((r) => r.jobs.filter((j) => j.restoresCache).map((j) => ({ ...j, workflow: r.workflow })))
        .sort((a, b) => ms(b.completed_at) - ms(a.completed_at))
        .slice(0, LOG_SAMPLE);
      if (!jobs.length) return skip("no job read ran setup-node with a cache");
      const verdicts = await mapLimit(jobs, 4, async (j) => cacheVerdict(await gh.text(`repos/${repo}/actions/jobs/${j.id}/logs`)));
      const read = jobs.map((j, i) => ({ workflow: j.workflow, v: verdicts[i] })).filter((x) => x.v);
      if (!read.length) return skip("no log read had setup-node's cache line");
      const detail = [...groupBy(read, (x) => x.workflow)].map(([label, g]) => ({ label, value: pct(g.filter((x) => x.v === "hit").length, g.length) }));
      return measured(pct(read.filter((x) => x.v === "hit").length, read.length), detail);
    },
  },
  // Point in time: the latest green head, each stage's latest run, never a median.
  "ci.latest_flow": {
    source: `.claude/settings.json, the git hooks in params.hooks_dir, .github/workflows, params.stages; gh api actions/workflows/{id}/runs (the latest pull request head that went all green; each stage's latest run, pass rates from the ${LAST}), pulls and check-runs (the latest of the last ${LAST_PRS} merges)`,
    async run(L, { root, cfg }) {
      const [latest] = pushToGreen((await L.covered()).runs, 1);
      if (!latest) return skip(`no pull request head went all green in the runs read`);
      return measured(round1(latest.minutes), await pipelineDetail(L, root, cfg));
    },
  },
  "ci.latest_full_run_minutes": {
    source: `GraphQL check runs and steps of the ${LAST}: each workflow's latest run that did real work`,
    async run(L) {
      return latestFullRun(await L.described());
    },
  },
  // State: how long the default branch has been red, now.
  "ci.main_red_minutes": {
    source: "gh api actions/workflows/{id}/runs: each active workflow whose file still runs on a push to the default branch, its runs there, newest first; red from the end of the first failure after its latest success",
    async run(L, { root, now }) {
      const branch = await L.branch();
      const decided = (r) => ["success", "failure", "timed_out", "startup_failure"].includes(r.conclusion);
      // A workflow deleted, disabled or no longer started by a push would stay red forever: only live ones count.
      const own = (await L.listed()).filter((w) => !String(w.path ?? "").startsWith("dynamic/"));
      const lists = await L.lists();
      const live = lists.filter((_, i) => own[i].state === "active" && runsOnPush(root, own[i].path, branch));
      const pushes = live.map((list) => list.filter((r) => r.event === "push" && r.head_branch === branch && completed(r) && decided(r))).filter((l) => l.length);
      if (!pushes.length) return skip(`no active workflow that runs on a push to ${branch} has a run there`);
      const red = [];
      for (const runs of pushes) {
        const streak = [];
        for (const r of [...runs].sort((a, b) => ms(b.created_at) - ms(a.created_at))) {
          if (r.conclusion === "success") break;
          streak.push(r);
        }
        if (streak.length) red.push({ workflow: streak[0].workflow ?? streak[0].name, since: ms(streak.at(-1).updated_at) });
      }
      if (!red.length) return measured(0, [{ label: `workflows green on ${branch}`, value: pushes.length, unit: "" }]);
      const detail = red.map((r) => ({ label: `${r.workflow}, red since ${new Date(r.since).toISOString().slice(0, 16)}Z`, value: round1(Math.max(0, (now - r.since) / 60_000)) }));
      return measured(Math.max(...detail.map((d) => d.value)), detail);
    },
  },
  "ci.light_run_share": {
    source: `GraphQL check runs and steps of the ${LAST}, weighted by each workflow and event's runs since the start of the shortest full list of ${RUNS_PER_WORKFLOW}`,
    async run(L) {
      const sample = await L.described();
      if (!sample.length) return skip(`no completed run in the ${LAST}`);
      const { share, detail } = weightedLightShare(sample, (await L.covered()).runs);
      return measured(share, detail);
    },
  },
  ...SPEND_METRICS,
  "ci.skip_unchanged_share": {
    source: "state: .github/workflows, each pull_request and push to the default branch trigger (params.default_branch, else gh api repos/{repo}): a paths or paths-ignore filter, a job whose if reads a needs.*.outputs value (a changes job), or a job calling ci-standard.yml with paths",
    async run(L, { root }) {
      const branch = await L.branch();
      const rows = skipTriggers(root, branch);
      if (!rows.length) return skip(`no workflow in .github/workflows runs on a pull request or a push to ${branch}`);
      const detail = rows.map((r) => ({ label: `${r.workflow}, ${r.trigger}: ${r.how ?? "runs its work on every change"}`, value: r.how ? 1 : 0, unit: "" }));
      return measured(pct(rows.filter((r) => r.how).length, rows.length), detail);
    },
  },
  ...INSIGHT_METRICS,
  // The token this run holds: the account's login in a --local run, the
  // workflow's token in Actions, so latest.json and local.json each read one.
  "ci.api_headroom": {
    source: `latest: ${QUOTA_SOURCE}, the share of each hourly bucket still unused, the lower of REST and GraphQL`,
    async run(L, { gh, mode }) {
      const h = headroom(await readQuota(gh));
      if (!h) return skip("rate_limit had no core or graphql bucket");
      const token = mode === "ci" ? "the CI run's token (the workflow token unless the repo passes another)" : "the account's login";
      return { ...measured(h.value, h.detail.map(({ label, value }) => ({ label, value }))), note: `read with ${token}` };
    },
  },
  "ci.pr_run_requests": {
    source: `latest: gh api actions/workflows/pages.yml/runs, the newest green pull_request run from {repo} whose jobs printed a notice, of the newest ${PR_RUNS_READ}; its jobs' check-run annotations, each job's GitHub requests notice (quality/gh-replay.mjs report), live REST plus GraphQL, summed`,
    async run(L, { gh, repo }) {
      const runs = (await gh.rest(`repos/${repo}/actions/workflows/pages.yml/runs?event=pull_request&status=success&per_page=10`)).workflow_runs ?? [];
      const ours = runs.filter((r) => r.head_repository?.full_name === repo).slice(0, PR_RUNS_READ);
      if (!ours.length) return skip("no green pull request run of pages.yml from this repo");
      for (const r of ours) {
        const jobs = ((await gh.rest(`repos/${repo}/actions/runs/${r.id}/jobs?per_page=100`)).jobs ?? []).filter((j) => j.conclusion && j.conclusion !== "skipped");
        const got = prRunRequests(jobs, await mapLimit(jobs, 4, (j) => gh.rest(`repos/${repo}/check-runs/${j.id}/annotations`)));
        if (got) return { ...measured(got.value, got.detail), note: `run ${r.id}` };
      }
      return skip(`the jobs of runs ${ours.map((r) => r.id).join(", ")} printed no GitHub requests notice`);
    },
  },
};

export const METRIC_IDS = Object.keys(METRICS);

/**
 * Reads the CI metrics among `targets`. `params` and `targets` come from the
 * engine; this file's own are the defaults. `gh` (with rest, graphql and
 * text), `now` and `repo` are injectable for tests; the defaults are the real
 * gh CLI, the clock, and params.repo or GITHUB_REPOSITORY. No metric reads the
 * clock: each counts the last N events or a state.
 */
export async function collect({ root = process.cwd(), mode = "local", params = OWN_PARAMS, targets = OWN_TARGETS, gh = ciClient(), admin = adminGh(), now = Date.now(), repo, allParams = {}, selfRun = process.env.GITHUB_RUN_ID ?? null } = {}) {
  // Only the metrics the engine keeps: a dropped one is never read.
  const active = Object.entries(METRICS).filter(([id]) => targets.some((t) => t.id === id));
  const slug = repoOf(repo, params);
  let cfg;
  try {
    cfg = { ...settings(params), boardParams: allParams["github.json"] ?? {} };
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    return Object.fromEntries(active.map(([id]) => [id, { could_not_check: err.message, source: TARGETS_FILE }]));
  }
  if (!slug) gh = refusingGh(`no repo to read: params.repo in ${TARGETS_FILE} is not owner/name, and GITHUB_REPOSITORY is unset`);
  // A CI run reads the board with the admin client (ADMIN_READ_TOKEN or the App token), as github.mjs does.
  const LA = admin && slug ? loaders({ gh: admin, repo: slug, cfg }) : null;
  const ctx = { root, mode, gh, repo: slug, now: Number(now), cfg, selfRun, LA };
  const L = loaders({ gh, repo: slug, cfg });
  const entries = await Promise.all(
    active.map(async ([id, metric]) => {
      const source = metric.source.replaceAll("{repo}", slug ?? "owner/name");
      try {
        const { note, ...result } = await metric.run(L, ctx);
        if (result.could_not_check) return [id, { could_not_check: result.could_not_check, source }];
        return [id, { ...result, source: note ? `${source}; ${note}` : source, read_at: new Date().toISOString() }];
      } catch (err) {
        return [id, { could_not_check: reasonFor(err), source }];
      }
    }),
  );
  return Object.fromEntries(entries);
}
