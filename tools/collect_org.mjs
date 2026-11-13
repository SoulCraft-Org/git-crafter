#!/usr/bin/env node
// collect_org.mjs: reads every repo in the org with `gh api` and writes
// data/org.json, the data both Git Crafter pages draw from, plus a slim snapshot
// in data/history/<date>.json for the trend lines.
//
//   node tools/collect_org.mjs             read, then write both files
//   node tools/collect_org.mjs --dry-run   read and print, write nothing
//   node tools/collect_org.mjs --config quality/process/config.json
//                                          a repo's own run, in its CI (SCOPE),
//                                          through actions/pages
//   ... --phase api, then ... --phase site the same run in two halves, so
//                                          the API reads can run beside the
//                                          repo's build (actions/pages modes)
//
// Reading only: no clone, no build, no browser. A session runs it and commits
// the result by PR (no cron: scheduled work waits for the owner). It needs gh signed
// in with read access to the org's repos; Dependabot alerts also need an org
// admin's token, and without one that metric reads could_not_check.
//
// What it reads. No value averages over a calendar window: each is a state
// (open PRs), the latest event (merge, green commit, deploy), or a share of
// each repo's last LAST_N events; history sparks plot one reading per run.
//   PR flow      GraphQL pullRequests: merged over the last 42 days, open now
//   CI, tests    REST actions/runs over the last 28 days
//   Deploys      GraphQL default-branch history: Workers Builds check runs
//   Models       Co-authored-by trailers on default-branch commits
//   Public       this checkout's tracked files (git ls-files, no API call):
//                the org's names from config/ left in template files
//   Security     REST orgs/{org}/dependabot/alerts, open critical and high;
//                a repo's own run reads repos/{org}/{repo}/dependabot/alerts
//   Pipelines    one GraphQL query: every repo's .github/workflows, .githooks
//                and .github/cloud-test.json at HEAD, read by
//                tools/workflows.mjs and timed from the CI runs above
//   Site         the site repo's committed quality/data/local.json
//                through the contents API: claude.* entries and the site.*
//                ids goals.json names, copied with the site's
//                own goal from quality/targets. Its tab scores stay on its
//                Quality page, which the pages link.
//
// The org: CODE_OS_ORG, the org config (config/*.json with an "org"), or the
// repo's owner in Actions. The site repo: CODE_OS_SITE_REPO or the config's
// site_repo. With no org the run stops with exit 2.
//
// A source that fails marks its metrics could_not_check with the reason; it
// never scores as zero. Exit 0 written, 1 nothing could be read, 2 usage.
// GitHub's rate limit is the one failed run that exits 0: could not verify,
// never a failure of the repo (failedRun, below).
//
// The reads live in org_*.mjs (base, scope, flow, signals, fetch, site, api);
// this file finishes a run with the site's data, runs it and re-exports their names.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { collectApi, SITE_READERS, unreadApi } from "./org_api.mjs";
import { attempt, isMeasured, notMeasured, ORG, reasonOf, ROOT } from "./org_base.mjs";
import { ghClient, isRateLimit } from "./org_fetch.mjs";
import { configScope, ownQuality, readDocs, SCOPE } from "./org_scope.mjs";
import { fetchSite, LABELS, namedIds, ownSteps, ownTokens, readSiteFromDisk, referencedIds, siteMetrics } from "./org_site.mjs";
import { systemsMetrics } from "./systems.mjs";

// ---- Main -------------------------------------------------------------------

// The site's and the repo's own Quality data, read from disk (or the site's through the API). The site
// is the repo's own run (every repo's config by default): read once.
function readQuality(root, scope, gh, errors) {
  const ownSpec = attempt(`${scope.own_repo} quality config`, () => ownQuality(root, scope), errors);
  const siteSpec = scope.site.root === null ? null : { ...ownSpec, ...scope.site };
  const site = attempt("site quality data", () => (siteSpec ? readSiteFromDisk(root, siteSpec, gh) : fetchSite(gh, scope.site.repo)), errors);
  const siteError = site ? null : errors.at(-1);
  const same = siteSpec && ownSpec && JSON.stringify(siteSpec) === JSON.stringify(ownSpec);
  const own = same ? site : ownSpec && attempt(`${scope.own_repo} quality data`, () => readSiteFromDisk(root, ownSpec), errors);
  const ownError = own ? null : errors.at(-1);
  if (site?.defs_error) errors.push(`site targets, so copied metrics go unrated: ${site.defs_error}`);
  return { ownSpec, siteSpec, site, siteError, own, ownError };
}

// The repo's own Quality run alone, as readQuality reads it: what the
// Process page build overlays on data/org.json, so its steps never lag.
export function readOwnRun(root, scope) {
  const errors = [];
  const ownSpec = attempt(`${scope.own_repo} quality config`, () => ownQuality(root, scope), errors);
  const own = ownSpec && attempt(`${scope.own_repo} quality data`, () => readSiteFromDisk(root, ownSpec), errors);
  return { ownSpec, own, ownError: own ? null : (errors.at(-1) ?? null) };
}

// Map steps, and every other Quality id the Process docs name, read the
// repo's own run, last, so no copy stands in for it. An id its Quality page
// does not define (pr.*, systems.*) is this collector's own and stays.
export function ownStepMetrics(docs, scope, { own, ownSpec, ownError }) {
  // A map's time_bar reads the repo's own run too, like its steps.
  const stepIds = (docs.maps?.maps ?? []).flatMap((m) => [...(m.steps ?? []).map((s) => s.metric), m.time_bar]).filter(Boolean);
  const defined = new Set((own?.defs ?? []).map((d) => d.id));
  const docIds = [docs.process, docs.tokens, docs.systems].flatMap((d) => [...namedIds(d)]).filter((id) => defined.has(id));
  return ownSteps(own, [...new Set([...stepIds, ...docIds])], ownSpec ?? { repo: scope.own_repo, data: ["its Quality run"] }, ownError);
}

// The ci.flow fallback goes once the site reports ci.latest_flow (see siteMetrics).
// As before the split: the site's own flow replaces its pipeline only when
// its workflow files were read.
function withSiteFlow(pipelines, metrics, siteRepo) {
  const flow = metrics["site.ci.latest_flow"] ?? metrics["site.ci.flow"];
  if (pipelines[siteRepo] && !pipelines[siteRepo].could_not_check && flow && Array.isArray(flow.detail)) return { ...pipelines, [siteRepo]: { detail: flow.detail, apart: [], source: flow.source, read_at: flow.read_at } };
  return pipelines;
}

// An id the pages name that no reader gave says why it is not measured.
function fillNamed(metrics, docs, scope, { site, siteSpec, siteError }) {
  const siteData = siteSpec ? (siteSpec.data ?? ["its Quality run"]).join(" or ") : "the site's committed data";
  for (const id of referencedIds(docs)) {
    if (!metrics[id] && !id.startsWith("data.")) metrics[id] = notMeasured(site ? `not in ${siteData}` : `could not read the site's data: ${siteError}`, `${ORG}/${scope.site.repo} quality/data/local.json`);
  }
}

// The site half of a run: adds docs, Quality and site metrics to the API
// half's, and returns the data the pages draw from. site_read_at stamps this
// half's own read, so a page shows both dates, never only the API half's (#690).
export function finishCollect(api, { gh = ghClient(), scope = SCOPE, root = ROOT, now = new Date() } = {}) {
  const errors = [...api.errors];
  const docs = readDocs(root, scope.docs, scope.quality_config);
  const metrics = { ...api.metrics };
  const base = { calls: gh.calls, graphql: gh.graphqlCalls };
  const q = readQuality(root, scope, gh, errors);
  const { site } = q;
  // A site entry under an id Git Crafter reads itself (pr.*, ci.pass_rate) never
  // replaces Git Crafter's own reading.
  if (site) Object.assign(metrics, siteMetrics(site, referencedIds(docs), scope.site.repo), ownTokens(site, scope.own_repo), api.metrics);
  Object.assign(metrics, ownStepMetrics(docs, scope, q));
  const pipelines = withSiteFlow({ ...api.pipelines }, metrics, scope.site.repo);
  fillNamed(metrics, docs, scope, q);
  if (docs.systems) Object.assign(metrics, systemsMetrics({ gh, site, siteSource: `${ORG}/${scope.site.repo} quality/data/local.json`, doc: docs.systems, org: ORG, readAt: now.toISOString(), kinds: SITE_READERS }));
  for (const [id, e] of Object.entries(metrics)) if (!e.label) metrics[id] = { label: LABELS[id] ?? id, ...e };
  const graphql = gh.graphqlCalls - base.graphql;
  const rest = gh.calls - base.calls - graphql;
  return {
    ...api,
    site_read_at: now.toISOString(),
    own_repo: scope.own_repo,
    site: { repo: `${ORG}/${scope.site.repo}`, commit: site?.commit ?? null, pages_url: site?.pagesUrl ?? null },
    pipelines,
    gh_calls: api.gh_calls + rest + graphql,
    rest_calls: api.rest_calls + rest,
    graphql_calls: api.graphql_calls + graphql,
    errors,
    metrics: Object.fromEntries(Object.entries(metrics).sort(([a], [b]) => a.localeCompare(b))),
  };
}

// One run, both halves, on one gh client: what every caller did before the
// split, and still the default.
export function collect({ gh = ghClient(), now = new Date(), scope = SCOPE, root = ROOT } = {}) {
  return finishCollect(collectApi({ gh, now, scope, root }), { gh, scope, root, now });
}

function snapshot(data) {
  return {
    generated_at: data.generated_at,
    values: Object.fromEntries(Object.entries(data.metrics).map(([id, e]) => [id, isMeasured(e) ? e.value : null])),
  };
}

// --config FILE: a repo's scope (SCOPE's keys), paths relative to the folder
// the run starts in. Without it, Git Crafter's own run from the Git Crafter root.
// --phase all (the default) runs both halves; api writes the API half to
// --api FILE (default: the data path as .api.json); site reads that file,
// adds the site's half, and writes the data.
export const PHASES = ["all", "api", "site"];
// The CLI options (--config, --phase, --api, --dry-run), or null on a bad argument.
export function parseArgs(argv, cwd = process.cwd()) {
  const opts = { "--config": null, "--phase": "all", "--api": null };
  let dry = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--dry-run") dry = true;
    else if (argv[i] in opts && i + 1 < argv.length && !argv[i + 1].startsWith("--")) opts[argv[i]] = argv[++i];
    else return null;
  }
  if (!PHASES.includes(opts["--phase"])) return null;
  const file = opts["--config"];
  const scope = file ? configScope(JSON.parse(readFileSync(join(cwd, file), "utf8"))) : SCOPE;
  return { dry, phase: opts["--phase"], api: opts["--api"] ?? scope.data.replace(/\.json$/, "") + ".api.json", scope, root: file ? cwd : ROOT };
}

function write(root, rel, data) {
  const out = resolve(root, rel);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(data)}\n`);
  console.log(`wrote ${rel}`);
}

// One phase's data, or null (after saying why) when the API half to finish is missing.
function runPhase({ phase, api, scope, root }) {
  if (phase !== "site") return (phase === "api" ? collectApi : collect)({ scope, root });
  const path = resolve(root, api);
  if (!existsSync(path)) {
    console.error(`collect_org: no API half at ${api}; run --phase api first`);
    return null;
  }
  return finishCollect(JSON.parse(readFileSync(path, "utf8")), { scope, root });
}

// The run's one-line count and each read that failed.
function report(data, phase) {
  const measuredN = Object.values(data.metrics).filter(isMeasured).length;
  console.log(`${phase === "api" ? "API half: " : ""}${data.repos.length} repos, ${measuredN} of ${Object.keys(data.metrics).length} metrics measured, ${data.rest_calls} REST and ${data.graphql_calls} GraphQL calls`);
  for (const e of data.errors) console.log(`  could not read ${e}`);
}

// The API half goes to its own file; a whole run to the data path and, when the scope keeps one, today's history snapshot.
function writeOutputs(data, { phase, api, scope, root }) {
  if (phase === "api") return write(root, api, data);
  write(root, scope.data, data);
  if (scope.history) write(root, join(scope.history, `${data.generated_at.slice(0, 10)}.json`), snapshot(data));
}

// The run a rate limit stopped before it read anything, in the shape of the half or whole run the phase
// writes. The pages and tests look for the "site quality data" entry to read the site as could not verify.
function unreadRun(reason, phase, scope, now) {
  const api = unreadApi([`repos and docs: ${reason}`, `site quality data: not read, ${reason}`], now);
  if (phase === "api") return api;
  return { ...api, own_repo: scope.own_repo, site: { repo: `${ORG}/${scope.site.repo}`, commit: null, pages_url: null } };
}

// What a run that threw exits with. A rate limit is GitHub's answer about its own budget, not about the
// repo, so the run fails open (rules/gates.md; #484, #488): it warns and returns 0. Where no data stands
// it writes a run that read nothing, so a build and the tests after it read not measured; data an earlier
// run read is left as it is, and no history point is written. Any other failure returns 1.
export function failedRun(err, { dry, phase, api, scope, root }, { now = new Date(), env = process.env, log = console.log } = {}) {
  if (!isRateLimit(err)) {
    console.error(`collect_org: could not list the repos or read the docs: ${String(err.stderr || err.message).trim()}`);
    return 1;
  }
  const reason = reasonOf(err);
  const rel = phase === "api" ? api : scope.data;
  const stands = existsSync(resolve(root, rel));
  if (!stands && !dry) write(root, rel, unreadRun(reason, phase, scope, now));
  const mark = env.GITHUB_ACTIONS === "true" ? "::warning::" : "";
  log(`${mark}collect_org: could not verify, GitHub's rate limit refused the read (${reason}); ${stands ? `${rel} is left as it was` : "every metric reads not measured"}`);
  return 0;
}

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(`collect_org: could not read --config: ${err.message}`);
    return 2;
  }
  if (args && !ORG) {
    console.error("collect_org: no org; set CODE_OS_ORG or add an org config (config/*.json with an org)");
    return 2;
  }
  if (!args) {
    console.error("usage: collect_org.mjs [--dry-run] [--config FILE] [--phase all|api|site] [--api FILE]");
    return 2;
  }
  let data;
  try {
    data = runPhase(args);
  } catch (err) {
    return failedRun(err, args);
  }
  if (!data) return 2;
  report(data, args.phase);
  if (!args.dry) writeOutputs(data, args);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));

export { ORG, SITE_REPO, PR_WEEKS, CI_WEEKS } from "./org_base.mjs";
export { SCOPE, scopeFrom, CODE_OS_DOCS, configScope, ownQuality, readDocs } from "./org_scope.mjs";
export { prMetrics, TEST_WORKFLOW, pushToGreen, ciMetrics } from "./org_flow.mjs";
export { STAGING, deployMetrics, THIRD_PARTY, aiAuthors, modelMetrics, alertMetrics, ORG_CONFIG, PUBLIC_EXEMPT, HOME_PLACEHOLDERS, privatePattern, publicMetrics, readTracked } from "./org_signals.mjs";
export { RETRY_MS, isServerError, isRateLimit, ghClient, fetchMerged, fetchOpen, fetchRuns, fetchHistory, fetchFiles } from "./org_fetch.mjs";
export { readSiteFromDisk, fetchSite, namedIds, SITE_OWN, OWN_REPO, ownTokens, ownSteps, siteMetrics, LABELS } from "./org_site.mjs";
export { listRepos, collectApi } from "./org_api.mjs";
