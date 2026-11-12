// Tokens tab collector: how well Claude's tokens turn into merged work, for
// every repo of params.owners and params.repos this account works in, or this
// repo alone when neither is set.
//
//   Quality      what each token buys: waste on PRs closed unmerged
//   Consumption  rework on the latest merged PR after a review found
//                something, the weekly plan used now, and what the latest
//                subagent returned to its parent
//                (Anthropic, "Effective context engineering for AI agents",
//                2025-09-29: a subagent returns a condensed summary)
//
// Tokens are billable: input, output and cache write, one count per
// message.id, the basis of claude.tokens_per_merged_pr. Cache reads are shown
// beside them, never added.
//
// Point in time: each metric reads the last N events up to now (LAST below,
// params.last overrides), and the plan its state as last read, never a
// calendar window.
// A PR's tokens are its linking session's, split evenly over the PRs that
// session linked and merged (or, for waste, linked and finished).
//
// Repos: a params.projects_dir folder belongs to the repo its sessions ran in,
// by `git remote get-url origin` of the folder's working directory (the main
// checkout when a worktree is gone). Which repos count (params.owners and
// params.repos; with neither, this repo alone), renamed repos (params.alias),
// and the folder names to fall back on when git cannot answer (a checkout
// moved or gone; params.folder_repos) are params on
// quality/targets/tokens.json, so the collector holds no account's repos.
// Every other folder is left out and counted by reason in the source. A
// session's tokens and the PRs it links count for its folder's repo, so each
// repo's ratios share one set of sessions.
//
// Privacy: `local` mode only, this account's own ~/.claude. From a transcript
// line it keeps usage numbers, ids, timestamps, PR links and its cwd. Prompts,
// replies and tool results are never read. The output holds counts and sums.
//
// Contract: quality/targets/tokens.json lists every metric id. collect()
// returns each as a value or { could_not_check }; it never throws for a
// missing tool, token or file, and never turns "could not read" into 0.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { reviewRounds } from '../blockers/blockers.mjs';
import { mapFolders, readFolders, readPlan, readPulls } from './tokens-io.mjs';
import { lastN, ownRepo, PROJECTS_DIR, resolvePath } from '../claude/claude.mjs';
import { redact } from '../lib/redact.mjs';

export { remoteRepo, returnedTokens } from './tokens-io.mjs';

export const area = 'tokens';

const TARGETS = JSON.parse(fs.readFileSync(new URL('../../targets/tokens.json', import.meta.url), 'utf8'));
export const metricIds = TARGETS.map((t) => t.id);
// The template's own params, merged as the engine merges a file's: the
// defaults for a bare call. The engine passes the repo's merged params.
const TEMPLATE = Object.assign({}, ...TARGETS.map((t) => t.params ?? {}));

const CI_REASON = 'transcripts live on the machine that ran the sessions; refreshed by a --local collect there';
const HOUR = 36e5;
const DAY = 24 * HOUR;
// How many of the latest events each metric reads; params.last overrides
// any of them. Consumption per merged PR reads the last 10.
export const LAST = { calls: 1000, prs: 20, sessions: 5, results: 20, consumption: 10 };

// Which repos count, from params: every repo of params.owners and each of
// params.repos, or this repo alone when neither is set; params.alias names a
// renamed repo by its current name; params.folder_repos gives folder-name
// patterns, matched without case, for checkouts git can no longer find.
export function scope(params, own = '') {
  const alias = params.alias ?? {};
  const owners = new Set(params.owners ?? []);
  const extra = new Set([...(params.repos ?? []), ...(owners.size || params.repos?.length ? [] : [own])].filter(Boolean).map((r) => String(r).toLowerCase()));
  return {
    alias,
    ours: (owner, name) => owners.has(owner) || extra.has(`${owner}/${name}`.toLowerCase()),
    folders: (params.folder_repos ?? []).map(([re, repo]) => [new RegExp(re, 'i'), repo]),
    empty: !owners.size && !extra.size,
  };
}

const run = promisify(execFile);
const defaultExec = async (cmd, args) => (await run(cmd, args, { maxBuffer: 64 * 1024 * 1024 })).stdout;

// Every metric of this tab, with each home path and account name taken out
// of the text (redact.mjs).
export async function collect(opts = {}) {
  return redact(await gather(opts), opts.home);
}

async function gather({ root = '.', data, mode, home = os.homedir(), projectsDir, exec = defaultExec, now = new Date(), last, params = TEMPLATE, allParams, reviewer } = {}) {
  const p = params;
  const projects = String(p.projects_dir || PROJECTS_DIR);
  const TRANSCRIPTS = `${projects}/*/**/*.jsonl`;
  const all = (reason, source = TRANSCRIPTS) => Object.fromEntries(metricIds.map((id) => [id, { could_not_check: reason, source }]));
  reviewer ??= pinnedReviewer(allParams, p);
  if (mode !== 'local') return all(CI_REASON);
  const own = p.owners?.length || p.repos?.length ? '' : await ownRepo(root, p, exec);
  const repos = scope(p, own);
  if (repos.empty) return all('no repo to count: set params.owners or params.repos on quality/targets/tokens.json, or give the checkout a GitHub origin');
  const dir = projectsDir ?? resolvePath(projects, { home, root });
  let folders;
  try {
    folders = await mapFolders(dir, exec, repos);
  } catch (err) {
    return all(`could not read ${dir} (${err.code ?? err.message})`);
  }
  const t = readFolders(folders.filter((f) => f.repo));
  const planFile = planFileFor(p, root, data);
  return computeMetrics({ t, folders, prs: await loadPulls(t.links, exec), plan: readPlan(root, now, planFile), planFile, now: now.getTime(), readAt: now.toISOString(), last: { ...LAST, ...p.last, ...last }, reviewer, TRANSCRIPTS });
}

// The pinned reviewer is a Blockers setting: blockers.json's when the engine
// passes every file's params, else this file's; any reviewer when unset.
const pinnedReviewer = (allParams, p) => String(allParams?.['blockers.json']?.reviewer ?? p.reviewer ?? '');

// The plan file defaults to plan-usage.json in the repo's data folder, the
// engine's `data` (#182); a bare call falls back to quality/data.
const planFileFor = (p, root, data) => String(p.plan_file || path.relative(path.resolve(root), path.join(path.resolve(root, data ?? 'quality/data'), 'plan-usage.json')));

async function loadPulls(links, exec) {
  try {
    return await readPulls(links, exec);
  } catch (err) {
    return { error: `gh api graphql failed (${String(err?.stderr || err?.message || err).trim().split('\n')[0].slice(0, 160)})` };
  }
}

// ---------------------------------------------------------------- metrics

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const round = (v, digits = 1) => Number(v.toFixed(digits));

function computeMetrics({ t, folders, prs, plan, planFile, now, readAt, last, reviewer, TRANSCRIPTS }) {
  const out = {};
  const val = (id, value, source, extra = {}) => {
    out[id] = { value, ...extra, source, read_at: readAt };
  };
  const cnc = (id, reason, source) => {
    out[id] = { could_not_check: reason, source };
  };
  const c = baseModel({ t, folders, now, last, TRANSCRIPTS });
  Object.assign(c, { val, cnc, t, now, last });
  planMetric(c, plan, planFile);
  // What subagents return needs no GitHub.
  subagentMetrics(t, c);
  const prSource = `${c.tokenSource}; pr-link entries joined with gh api graphql (state, merge time, pinned reviews), 50 PRs to a query`;
  if (prs.error) {
    for (const id of ['tokens.latest_pr_rework_tokens', 'tokens.waste_share', 'tokens.review_fix_rounds_per_pr']) cnc(id, prs.error, prSource);
    return order(out, TRANSCRIPTS);
  }
  prMetrics(c, prs, { reviewer, prSource });
  return order(out, TRANSCRIPTS);
}

// What the metrics share: the repos kept, the model calls and sessions read,
// and each session's tokens, per hour of active work.
function baseModel({ t, folders, now, last, TRANSCRIPTS }) {
  const ours = folders.filter((f) => f.repo);
  const reasons = new Map();
  for (const f of folders.filter((x) => !x.repo)) reasons.set(f.why, (reasons.get(f.why) ?? 0) + 1);
  const repos = [...new Set(ours.map((f) => f.repo))].sort();
  const left = [...reasons].sort((a, b) => b[1] - a[1]).map(([why, n]) => `${n} ${why}`).join(', ');
  const scope = `${ours.length} project folders in ${repos.length} repos (${repos.join(', ')}); ${folders.length - ours.length} left out: ${left || 'none'}`;
  const allMsgs = t.messages.filter((m) => m.at <= now);
  const sessionTotals = new Map();
  for (const m of allMsgs) sessionTotals.set(m.sessionId, (sessionTotals.get(m.sessionId) ?? 0) + m.billable);
  const tokensOfSession = (id) => sessionTotals.get(id) ?? 0;
  // Per hour of active work: the last N sessions with a cost record.
  const costedAll = [...t.sessions.entries()].filter(([, s]) => s.activeMs > 0);
  const perHour = (list) => {
    const latest = lastN(list, last.sessions, ([, s]) => s.start, now);
    const hours = sum(latest.map(([, s]) => s.activeMs)) / HOUR;
    return hours > 0 ? Math.round(sum(latest.map(([id]) => tokensOfSession(id))) / hours) : null;
  };
  return {
    repos,
    allMsgs,
    calls: lastN(allMsgs, last.calls, (m) => m.at, now),
    tokensOfSession,
    // The per-hour column is in the repo table, for reading only: as a goal,
    // slower work would lower it.
    hourByRepo: Object.fromEntries(repos.map((r) => [r, perHour(costedAll.filter(([, s]) => s.repo === r))])),
    tokenSource: `${TRANSCRIPTS}: message.usage input + output + cache write, one count per message.id; ${scope}`,
  };
}

// The weekly plan, as the app last reported it: the percent used now.
function planMetric({ val, cnc }, plan, planFile) {
  const planSource = `state: ${planFile}, the app's get_usage weekly all-models window as a session last read it: percent of the plan used now`;
  if (plan.error) return cnc('tokens.plan_used', plan.error, planSource);
  val('tokens.plan_used', plan.used, `${planSource}, read ${new Date(plan.readAt).toISOString().slice(0, 16)}Z`, {
    detail: [
      { label: 'used now', value: plan.used, unit: '%' },
      { label: 'days until it resets', value: round((plan.resetsAt - plan.readAt) / DAY), unit: 'days' },
    ],
  });
}

const repoOf = (r) => (x) => x.repo === r;
const countBy = (list) => {
  const n = new Map();
  for (const pr of list) n.set(pr.sessionId, (n.get(pr.sessionId) ?? 0) + 1);
  return n;
};

// The linked PRs, merged and finished, and what each costs in tokens.
function prModel(c, prs) {
  const { t, now, last, repos, tokensOfSession } = c;
  const linked = [...prs.found.values()]
    .map((pr) => ({ ...pr, repo: t.sessions.get(pr.link.sessionId)?.repo ?? null, sessionId: pr.link.sessionId }))
    .filter((pr) => pr.repo && Date.parse(pr.createdAt) <= now);
  const mergedAt = (pr) => (pr.state === 'MERGED' ? Date.parse(pr.mergedAt) : NaN);
  const mergedAll = linked.filter((pr) => mergedAt(pr) <= now);
  const finishedAll = linked.filter((pr) => pr.state === 'CLOSED' || mergedAt(pr) <= now);
  const mergedCount = countBy(mergedAll);
  const finishedCount = countBy(finishedAll);
  const latestMerged = (list) => lastN(list, last.prs, mergedAt, now);
  const consumption = last.consumption ?? 10;
  return {
    mergedAt,
    mergedAll,
    finishedAll,
    finishedCount,
    // A merged PR's tokens: its session's, split over that session's merged PRs.
    prTokens: (pr) => tokensOfSession(pr.sessionId) / mergedCount.get(pr.sessionId),
    merged: latestMerged(mergedAll),
    consumed: lastN(mergedAll, consumption, mergedAt, now),
    NUSE: `the last ${consumption} merged linked PRs`,
    mergedBy: Object.fromEntries(repos.map((r) => [r, latestMerged(mergedAll.filter(repoOf(r)))])),
  };
}

function prMetrics(c, prs, { reviewer, prSource }) {
  const pm = prModel(c, prs);
  Object.assign(pm, prHelpers(c, pm, reviewer));
  fixMetric(c, pm, { reviewer, prSource });
  const rows = repoRows(c, pm);
  wasteMetric(c, pm, rows, prSource);
  reworkMetric(c, pm, rows, { prSource, calls: prs.calls });
}

// Waste and rework readers over the PR model.
function prHelpers(c, pm, reviewer) {
  const { now, last, allMsgs, tokensOfSession } = c;
  // Waste: of the last N finished PRs, each with its session's tokens split
  // over that session's finished PRs, the share on PRs closed unmerged.
  const wasteOf = (list) => {
    const latest = lastN(list, last.prs, (pr) => Date.parse(pr.createdAt), now);
    const tok = (pr) => tokensOfSession(pr.sessionId) / pm.finishedCount.get(pr.sessionId);
    const all = sum(latest.map(tok));
    const waste = sum(latest.filter((pr) => pr.state === 'CLOSED').map(tok));
    return all > 0 ? { share: round((100 * waste) / all), waste, all, prs: latest.length } : null;
  };
  // Rework: the linking session's tokens after the first round that found something, until the merge.
  const bySession = new Map();
  for (const m of allMsgs) {
    if (!bySession.has(m.sessionId)) bySession.set(m.sessionId, []);
    bySession.get(m.sessionId).push(m);
  }
  const reworkOn = (pr) => {
    const found = reviewRounds(pr, reviewer).find((r) => r.kind === 'found');
    if (!found) return 0;
    const end = Date.parse(pr.mergedAt);
    return sum((bySession.get(pr.sessionId) ?? []).filter((m) => m.at > found.at && m.at <= end).map((m) => m.billable));
  };
  // The newest merged PR of a list, by merge time: what rework reads now.
  const newest = (list) => list.reduce((a, pr) => (!a || pm.mergedAt(pr) > pm.mergedAt(a) ? pr : a), null);
  return { wasteOf, reworkOn, newest };
}

// Review rounds that found something, per merged PR (reviewRounds in blockers.mjs).
function fixMetric({ val, cnc }, { consumed, NUSE }, { reviewer, prSource }) {
  const fixSource = `${prSource}; reviewRounds in blockers.mjs: pinned review rounds that found something, mean over ${NUSE}`;
  if (!consumed.length) return cnc('tokens.review_fix_rounds_per_pr', 'no linked PR has merged', fixSource);
  const found = consumed.map((pr) => reviewRounds(pr, reviewer).filter((r) => r.kind === 'found').length);
  val('tokens.review_fix_rounds_per_pr', round(sum(found) / consumed.length, 2), fixSource, {
    detail: [
      { label: 'merged PRs', value: consumed.length, unit: 'PRs' },
      { label: 'with a round that found something', value: found.filter((n) => n > 0).length, unit: 'PRs' },
      { label: 'rounds that found something', value: sum(found), unit: 'rounds' },
    ],
  });
}

// The repo table: tokens, share and cache reads over the last N model calls;
// PR ratios over each repo's last N merged or finished PRs; per hour over its last N costed sessions.
function repoRows(c, pm) {
  const { repos, calls, hourByRepo } = c;
  const callTokens = Object.fromEntries(repos.map((r) => [r, sum(calls.filter(repoOf(r)).map((m) => m.billable))]));
  const callTotal = sum(Object.values(callTokens));
  return repos
    .map((r) => {
      const mine = calls.filter(repoOf(r));
      const inputSide = sum(mine.map((m) => m.input + m.cacheRead));
      const list = pm.mergedBy[r];
      const waste = pm.wasteOf(pm.finishedAll.filter(repoOf(r)));
      return {
        label: r,
        value: callTokens[r],
        unit: 'tokens',
        share: callTotal > 0 ? round((100 * callTokens[r]) / callTotal) : null,
        cache_read_share: inputSide > 0 ? round((100 * sum(mine.map((m) => m.cacheRead))) / inputSide) : null,
        merged: list.length,
        tokens_per_pr: list.length ? Math.round(sum(list.map(pm.prTokens)) / list.length) : null,
        waste_share: waste ? waste.share : null,
        latest_rework: list.length ? pm.reworkOn(pm.newest(list)) : null,
        per_hour: hourByRepo[r],
      };
    })
    .filter((row) => row.value > 0 || row.merged > 0)
    .sort((a, b) => b.value - a.value);
}

const byRepoValue = (rows, key) => Object.fromEntries(rows.map((row) => [row.label, row[key]]));

function wasteMetric({ val, cnc, last }, pm, rows, prSource) {
  const wasteAll = pm.wasteOf(pm.finishedAll);
  const wasteSource = `${prSource}; the last ${last.prs} opened linked PRs that merged or closed, each with its linking session's tokens split evenly over that session's merged and closed PRs`;
  if (!wasteAll) return cnc('tokens.waste_share', 'no linked PR has merged or closed with tokens in its session', wasteSource);
  val('tokens.waste_share', wasteAll.share, wasteSource, {
    by_repo: byRepoValue(rows, 'waste_share'),
    detail: [
      { label: 'on PRs closed unmerged', value: Math.round(wasteAll.waste), unit: 'tokens' },
      { label: 'on merged PRs', value: Math.round(wasteAll.all - wasteAll.waste), unit: 'tokens' },
      { label: 'PRs read', value: wasteAll.prs, unit: 'PRs' },
    ],
  });
}

function reworkMetric({ val, cnc, last }, pm, rows, { prSource, calls }) {
  const latest = pm.newest(pm.merged);
  const NC = `the last ${last.calls} model calls`;
  const NS = `the last ${last.sessions} sessions with a cost record, by start`;
  const NM = `the last ${last.prs} merged linked PRs`;
  // Its detail is the repo table (chart: repos); the latest PR goes in its source.
  const reworkSource = `${prSource}; reviewRounds in blockers.mjs: the linking session's tokens after the first pinned review that found something, until the merge, on the latest merged PR among ${NM}; the table's tokens and shares are over ${NC}, its PR columns over each repo's own last ${last.prs}, its rework column each repo's latest merged PR, its per-hour column over ${NS}; ${calls} GraphQL calls`;
  if (!latest) return cnc('tokens.latest_pr_rework_tokens', 'no linked PR has merged', reworkSource);
  val('tokens.latest_pr_rework_tokens', pm.reworkOn(latest), `${reworkSource}; the latest, ${latest.repo}#${latest.link.number}, merged ${String(latest.mergedAt).slice(0, 10)}`, {
    by_repo: byRepoValue(rows, 'latest_rework'),
    detail: rows,
  });
}

// What the latest subagent returned to its parent: a condensed summary is the
// ideal (Anthropic, "Effective context engineering for AI agents", 2025-09-29).
function subagentMetrics(t, { val, cnc, repos, tokenSource, last, now }) {
  const returnedAll = t.subagents.filter((a) => a.returned !== null && a.last <= now);
  // The latest N to finish, newest first.
  const latestOf = (list) => lastN(list, last.results, (a) => a.replyAt, now).sort((a, b) => b.replyAt - a.replyAt);
  const returnSource = `${tokenSource}; a subagent transcript's last reply's text at 4 characters a token, which is what it returns to its parent (thinking is never returned; a reply with no text counts its output_tokens); the latest of the last ${last.results} subagents to finish`;
  const recent = latestOf(returnedAll);
  if (recent.length) {
    val('tokens.latest_subagent_return_tokens', recent[0].returned, returnSource, {
      by_repo: Object.fromEntries(repos.map((r) => {
        const mine = latestOf(returnedAll.filter((a) => a.repo === r));
        return [r, mine.length ? mine[0].returned : null];
      })),
      detail: recent.slice(0, 5).map((a) => ({ label: `${a.repo ?? 'unknown repo'}, ${new Date(a.replyAt).toISOString().slice(0, 16).replace('T', ' ')} UTC`, value: a.returned, unit: 'tokens' })),
    });
  } else cnc('tokens.latest_subagent_return_tokens', 'no subagent transcript holds a reply', returnSource);
}


function order(out, TRANSCRIPTS) {
  return Object.fromEntries(metricIds.map((id) => [id, out[id] ?? { could_not_check: 'collector produced no value', source: TRANSCRIPTS }]));
}
