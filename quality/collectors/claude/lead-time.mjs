// Lead time, one sample: for the last N merged PRs it can time end to end,
// the median hours of each step from a session's start to the change live,
// drawn as one stacked bar on the Delivery map (pages/maps/delivery.json).
//
//   session start to PR open   this Mac's transcripts (claude.mjs), local mode only
//   PR open to all green       gh api graphql: createdAt, then the last check on the merged head (greenAt)
//   all green to merge         mergedAt
//   merge to live              the first successful deploy in params.environment created at or after the merge
//
// The steps join end to end, so each PR's four spans add up to its whole
// time. The value is the sum of the four medians, so the bar's parts add up
// to it exactly. In CI, where no transcript is, the first step is named in
// `missing` and the metric is could_not_check, unscored: detail keeps the
// three GitHub steps over the same PRs for the bar, never a zero for the
// step it could not read.
//
// Contract: quality/targets/lead-time.json. Never throws; a failed read is
// could_not_check.

import { ghClient } from '../github/github-core.mjs';
import { greenAt } from '../github/github-reviews.mjs';
import { redact } from '../lib/redact.mjs';
import { median, round } from './claude-lib.mjs';
import { ownRepo, prSessionStarts, projectMatch, PROJECTS_DIR, resolvePath } from './claude.mjs';

export const area = 'lead_time';
// Reads the GitHub API: collect.mjs skips it under the API reserve (ci.json params.api_reserve).
export const githubApi = true;
export const ID = 'lead_time.hours';
// The steps in order, as the bar draws them.
export const STEPS = ['session start to PR open', 'PR open to all green', 'all green to merge', 'merge to live'];
const HOUR = 36e5;
const DEFAULTS = { last_prs: 10, environment: 'github-pages' };
const NO_TRANSCRIPTS = 'transcripts live on the machine that ran the sessions; refreshed by a --local collect there';

const QUERY = `query($owner: String!, $name: String!, $env: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: MERGED, first: 50, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes { number createdAt mergedAt
        headCommit: commits(last: 1) { nodes { commit { statusCheckRollup { state
          contexts(first: 100) { nodes { __typename ... on CheckRun { name conclusion completedAt } ... on StatusContext { context state createdAt } } }
        } } } } }
    }
    deployments(environments: [$env], first: 50, orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes { createdAt statuses(first: 10) { nodes { state createdAt } } }
    }
  }
}`;

// When each successful deploy went live, oldest first: { at, live } in ms.
export function liveTimes(deployments) {
  return (deployments ?? [])
    .map((d) => ({ at: Date.parse(d.createdAt), ok: (d.statuses?.nodes ?? []).find((s) => s.state === 'SUCCESS') }))
    .filter((d) => d.ok && Number.isFinite(d.at))
    .map((d) => ({ at: d.at, live: Date.parse(d.ok.createdAt) }))
    .sort((a, b) => a.at - b.at);
}

// The last check on the merged head that finished by the merge, in ms, or
// null. A check the closing of the PR starts finishes after the merge, so it
// is no part of the wait for green (seen 2026-11-11: a check finishing 4 s
// after each of the last 12 merges).
function lastCheckBefore(pull, merged) {
  const nodes = pull.headCommit?.nodes[0]?.commit.statusCheckRollup?.contexts?.nodes ?? [];
  const times = nodes.map((c) => Date.parse(c.completedAt ?? c.createdAt)).filter((t) => t <= merged);
  return times.length ? Math.max(...times) : null;
}

// One PR's step times in ms, each clamped into order so they join end to
// end, or null when GitHub lacks one. start: its session start, or
// undefined. With no deploy read at all, live is null; with deploys, a PR
// none of them shipped yet is left out.
export function stepTimes(pull, deploys, start) {
  const opened = Date.parse(pull.createdAt);
  const merged = Date.parse(pull.mergedAt);
  const green = greenAt(pull) === null ? null : lastCheckBefore(pull, merged);
  const deploy = deploys.find((d) => d.at >= merged);
  if (green === null || (deploys.length && !deploy) || !Number.isFinite(opened) || !Number.isFinite(merged)) return null;
  const g = Math.min(Math.max(green, opened), merged);
  return { start: Number.isFinite(start) && start <= opened ? start : null, opened, green: g, merged, live: deploy ? Math.max(deploy.live, merged) : null };
}

// Each step's span in ms, in STEPS order.
const SPANS = [(t) => t.opened - t.start, (t) => t.green - t.opened, (t) => t.merged - t.green, (t) => t.live - t.merged];

// The four segments' medians over the same PRs, in hours, and the total as
// their sum; a step it could not read is named in missing, never a zero.
// starts: PR number to session start (local), or null (CI).
export function leadTime(pulls, deploys, { starts = null, n = DEFAULTS.last_prs, environment = DEFAULTS.environment } = {}) {
  const timed = [...pulls]
    .sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt))
    .map((p) => stepTimes(p, deploys, starts?.get(p.number)))
    .filter(Boolean);
  const full = timed.filter((t) => t.start !== null).slice(0, n);
  const sample = full.length ? full : timed.slice(0, n);
  if (!sample.length) return null;
  const missing = [];
  if (!full.length) missing.push({ label: STEPS[0], reason: starts ? 'none of these PRs was linked by a session in the transcripts' : NO_TRANSCRIPTS });
  if (!deploys.length) missing.push({ label: STEPS[3], reason: `no successful ${environment} deployment read` });
  const detail = STEPS.map((label, i) => ({ label, i })).filter((s) => !missing.some((m) => m.label === s.label));
  const rows = detail.map(({ label, i }) => ({ label, value: round(median(sample.map((t) => SPANS[i](t) / HOUR)), 2), unit: 'h', part: i + 1 }));
  return { value: round(rows.reduce((a, d) => a + d.value, 0), 2), detail: rows, missing, prs: sample.length };
}

// Session starts by PR number for this repo, in local mode; null in CI or
// when the transcripts cannot be read.
function startsFor({ mode, root, repo, claude, home }) {
  if (mode !== 'local') return null;
  const match = String(claude.project_match || projectMatch(root));
  try {
    const all = prSessionStarts(resolvePath(claude.projects_dir || PROJECTS_DIR, { home, root }), match);
    return new Map([...all].filter(([k]) => k.startsWith(`${repo}#`)).map(([k, v]) => [Number(k.split('#')[1]), v]));
  } catch {
    return new Map();
  }
}

// The lead-time metric. gh: a github-core client (graphql); allParams: the
// Claude tab's params name the transcripts.
export async function collect({ root = '.', mode, params = {}, allParams = {}, gh = ghClient(), now = new Date(), home } = {}) {
  const p = { ...DEFAULTS, ...params };
  const repo = await ownRepo(root, p);
  const source = `gh api graphql: the last ${p.last_prs} merged pullRequests timed end to end (N = ${p.last_prs}, a template choice: a median that turns over within a day), each step's median in hours, summed; live is the first successful ${p.environment} deployment created at or after the merge; session start from this Mac's transcripts, local runs only`;
  if (!repo) return { [ID]: { could_not_check: 'no GitHub repo: set params.repo, or give the checkout a GitHub origin', source } };
  let data;
  try {
    const [owner, name] = repo.split('/');
    data = (await gh.graphql(QUERY, { owner, name, env: p.environment })).repository;
  } catch (err) {
    return { [ID]: { could_not_check: `gh api graphql failed: ${String(err?.message ?? err).split('\n')[0].slice(0, 160)}`, source } };
  }
  const starts = startsFor({ mode, root, repo, claude: allParams['claude.json'] ?? {}, home });
  const got = leadTime(data?.pullRequests?.nodes ?? [], liveTimes(data?.deployments?.nodes), { starts, n: p.last_prs, environment: p.environment });
  if (!got) return { [ID]: { could_not_check: `no merged PR has an all-green head and, when ${p.environment} deploys exist, one after its merge`, source } };
  return redact({ [ID]: { ...scored(got), source: `${source}; ${got.prs} PRs`, read_at: now.toISOString() } }, home);
}

// A total that lacks a step is no lead time: it is could_not_check, naming
// the step, and keeps the steps it read in detail for the map's bar.
function scored({ value, detail, missing }) {
  if (!missing.length) return { value, detail, missing };
  const why = missing.map((m) => `${m.label} not read (${m.reason})`).join('; ');
  return { could_not_check: `not scored: ${why}; the ${detail.length} steps read add up to ${value} h`, detail, missing };
}
