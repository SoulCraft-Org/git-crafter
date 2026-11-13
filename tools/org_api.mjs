// The API half of a run: every read that needs only the API.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { attempt, CI_WEEKS, DAY, notMeasured, ORG, PR_WEEKS, reasonOf, ROOT } from "./org_base.mjs";
import { fetchFiles, fetchHistory, fetchMerged, fetchOpen, fetchRuns, ghClient } from "./org_fetch.mjs";
import { ciMetrics, prMetrics } from "./org_flow.mjs";
import { readDocs, SCOPE } from "./org_scope.mjs";
import { alertMetrics, deployMetrics, modelMetrics, ORG_CONFIG, PUBLIC_SRC, publicMetrics, readTracked } from "./org_signals.mjs";
import { LAST_N, repoFlow, repoTests, workflowStats } from "./workflows.mjs";

// A scope with its own repos lists none: a repo's GITHUB_TOKEN cannot list
// the org. A repo whose default branch cannot be read is taken as main.
export function listRepos(gh, scope, errors) {
  if (!scope.repos) return gh.restLines(`orgs/${ORG}/repos?per_page=100`, ".[] | select(.archived | not) | {name, default_branch} | @json");
  return scope.repos.map((name) => attempt(`${name} default branch`, () => gh.rest(`repos/${ORG}/${name}`, "{name, default_branch} | @json"), errors) ?? { name, default_branch: "main" });
}

// The two halves of a run. collectApi makes every read that needs only the
// API, so a repo's CI can run it beside its own build. finishCollect adds what
// needs the site's data on disk (its Quality collector's latest.json): the
// site's metrics and pipeline, the not-measured fill and the Quality readers.
// collect() runs both, as one run always has. The API half's result is plain
// JSON, so it crosses runners as an artifact (actions/pages, mode collect).

// Each source per repo: its rows, or null with the reason when the read
// failed, so a failed read never counts as zero.
function readRepos(gh, repos, t, errors) {
  const reads = { merged: {}, open: {}, runs: {}, history: {} };
  const fails = { merged: {}, open: {}, runs: {}, history: {} };
  const took = { merged: 0, open: 0, runs: 0, history: 0 };
  const read = (source, r, fn) => {
    const started = Date.now();
    try {
      reads[source][r] = fn();
    } catch (err) {
      reads[source][r] = null;
      fails[source][r] = reasonOf(err);
      errors.push(`${r} ${source}: ${fails[source][r]}`);
    }
    took[source] += (Date.now() - started) / 1000;
  };
  for (const r of repos) {
    process.stderr.write(`reading ${r}\n`);
    read("merged", r, () => fetchMerged(gh, r, t - PR_WEEKS * 7 * DAY));
    read("open", r, () => fetchOpen(gh, r));
    read("runs", r, () => fetchRuns(gh, r, t - CI_WEEKS * 7 * DAY, t));
    read("history", r, () => fetchHistory(gh, r, t - CI_WEEKS * 7 * DAY));
  }
  // Where the read's time went, by source, over every repo. The job log is not always readable, but a run's
  // annotations are (gh api repos/{repo}/check-runs/{job id}/annotations).
  const line = `${repos.length} repos: ${Object.entries(took).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(", ")}`;
  if (process.env.GITHUB_ACTIONS === "true") console.log(`::notice title=collect_org read seconds::${line}`);
  else process.stderr.write(`read seconds, ${line}\n`);
  return { reads, fails };
}

// A repo's own run reads each repo's alerts, never the org's: a repo's
// token cannot read the org's, and they would count other repos.
function alertsOf(gh, scope, repos, errors, readAt) {
  const alertsSrc = scope.repos ? `gh api repos/${ORG}/{repo}/dependabot/alerts` : `gh api orgs/${ORG}/dependabot/alerts`;
  const alertJq = (repo) => `.[] | {repo: ${repo ? JSON.stringify(repo) : ".repository.name"}, severity: .security_advisory.severity, pkg: .dependency.package.name} | @json`;
  const alertQuery = "state=open&severity=critical,high&per_page=100";
  const alerts = attempt(
    "dependabot alerts",
    () => (scope.repos ? repos.flatMap((r) => gh.restLines(`repos/${ORG}/${r}/dependabot/alerts?${alertQuery}`, alertJq(r))) : gh.restLines(`orgs/${ORG}/dependabot/alerts?${alertQuery}`, alertJq(null))),
    errors,
  );
  if (alerts) return alertMetrics({ repos, alerts: alerts.filter((a) => repos.includes(a.repo)), readAt, source: `${alertsSrc} (state open, severity critical and high)` });
  return { "security.critical_high_open": notMeasured(`could not read Dependabot alerts: ${errors.at(-1)}`, alertsSrc) };
}

// Git Crafter's own public-readiness count, or why it could not be read.
function publicOf(errors, readAt) {
  if (!ORG_CONFIG) return { "public.private_refs": notMeasured("no org config (config/*.json with an org) in this checkout", PUBLIC_SRC) };
  const tracked = attempt("Git Crafter files", () => readTracked(ROOT), errors);
  const orgConfig = tracked && attempt(ORG_CONFIG, () => JSON.parse(readFileSync(join(ROOT, ORG_CONFIG), "utf8")), errors);
  if (orgConfig) return publicMetrics({ files: tracked, config: orgConfig, readAt });
  return { "public.private_refs": notMeasured(`could not read ${errors.at(-1)}`, PUBLIC_SRC) };
}

// Each repo's pipeline and test suites, read from its files. The site's
// pipeline is replaced by its own flow in finishCollect.
function repoPipelines(gh, repos, { reads, fails }, errors, readAt) {
  const files = attempt("workflow files", () => fetchFiles(gh, repos), errors) ?? {};
  const filesAt = readAt();
  const pipelines = {};
  const testing = {};
  const filesSrc = "gh api graphql: HEAD:.github/workflows, HEAD:.githooks and HEAD:.github/cloud-test.json";
  for (const r of repos) {
    const runsNote = reads.runs[r] === null ? `; runs not read (${fails.runs[r]}), so nothing is timed` : `; each workflow's latest run timed, its pass rate over its last ${LAST_N} runs`;
    if (!files[r]) {
      const why = notMeasured(`could not read the repo's workflow files${errors.find((e) => e.startsWith("workflow files")) ? `: ${errors.find((e) => e.startsWith("workflow files"))}` : ""}`, filesSrc);
      pipelines[r] = why;
      testing[r] = why;
      continue;
    }
    const stats = workflowStats(reads.runs[r] ?? []);
    pipelines[r] = { ...repoFlow(files[r], stats), source: `${filesSrc}${runsNote}`, read_at: filesAt };
    testing[r] = { ...repoTests(files[r], stats), source: `${filesSrc}${runsNote}`, read_at: filesAt };
  }
  return { pipelines, testing };
}

const WINDOWS = { last_events: LAST_N, pr_read_weeks: PR_WEEKS, ci_read_weeks: CI_WEEKS };

// The API half of a run that read nothing, with why in `errors`: no repos and no metrics, so the pages read
// every figure as not measured and none as 0.
export function unreadApi(errors, now = new Date()) {
  return { generated_at: now.toISOString(), org: ORG, repos: [], windows: WINDOWS, pipelines: {}, testing: {}, gh_calls: 0, rest_calls: 0, graphql_calls: 0, errors, metrics: {} };
}

// The API half of a run: every metric read from GitHub for the scope's repos.
export function collectApi({ gh = ghClient(), now = new Date(), scope = SCOPE, root = ROOT } = {}) {
  const errors = [];
  const readAt = () => new Date().toISOString();
  const docs = readDocs(root, scope.docs, scope.quality_config);
  const repoList = listRepos(gh, scope, errors).sort((a, b) => a.name.localeCompare(b.name));
  const repos = repoList.map((r) => r.name);
  const defaults = Object.fromEntries(repoList.map((r) => [r.name, r.default_branch]));
  const { reads, fails } = readRepos(gh, repos, now.getTime(), errors);
  const metrics = {
    ...prMetrics({ repos, merged: reads.merged, open: reads.open, defaults, now, readAt: readAt(), failures: { merged: fails.merged, open: fails.open } }),
    ...ciMetrics({ repos, runs: reads.runs, now, readAt: readAt(), failures: fails.runs }),
    ...deployMetrics({ repos, commits: reads.history, now, readAt: readAt(), failures: fails.history }),
    ...modelMetrics({ repos, commits: reads.history, now, readAt: readAt(), failures: fails.history }),
    ...alertsOf(gh, scope, repos, errors, readAt()),
    ...(scope.public ? publicOf(errors, readAt()) : {}),
  };
  const { pipelines, testing } = repoPipelines(gh, repos, { reads, fails }, errors, readAt);
  return {
    generated_at: now.toISOString(),
    org: ORG,
    repos: repoList.map((r) => ({ name: r.name, default_branch: r.default_branch })),
    windows: WINDOWS,
    pipelines,
    testing,
    gh_calls: gh.calls,
    // --paginate pages count once each here; the REST budget is about 300 a run.
    rest_calls: gh.calls - gh.graphqlCalls,
    graphql_calls: gh.graphqlCalls,
    errors,
    metrics,
  };
}
