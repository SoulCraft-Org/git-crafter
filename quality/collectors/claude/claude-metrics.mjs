// The Claude tab's metrics from the transcripts and the GitHub join (claude.mjs).

import { percentile } from '../github/github.mjs';
import { HOUR, item, lastN, metricIds, median, pct, per10, priceCall, round, sum, TOKEN_KEYS, usageCounts } from './claude-lib.mjs';

const PR_SOURCE = 'gh api graphql: each linked pullRequest, 50 to a query, with PULL_FIELDS from github.mjs plus state, author type, commits and head checks';
const BUG_SOURCE = 'gh issue list -R <repo> --type Bug --state all --json number,title,body,createdAt';
const NO_USAGE = 'no assistant usage in the transcripts';
const NO_MERGED = 'no Claude PR has merged';

// Every Claude metric as could_not_check with one reason and source.
export function allCouldNotCheck(reason, source) {
  return Object.fromEntries(metricIds.map((id) => [id, { could_not_check: reason, source }]));
}

// A bug escaped a PR when an issue naming it as the cause opened after the merge, up to now.
function escapedBugs(pr, issues, now) {
  const merged = Date.parse(pr.mergedAt);
  return issues.filter((i) => i.refs.has(pr.number) && i.createdAt > merged && i.createdAt <= now);
}

// Every Claude metric from the read transcripts and their linked PRs.
export function computeMetrics(t, github, { now, readAt, last, params, transcripts, notCode }) {
  const out = {};
  const c = {
    t,
    github,
    now,
    last,
    params,
    transcripts,
    notCode,
    val: (id, value, source, detail) => {
      out[id] = { value, ...(detail ? { detail } : {}), source, read_at: readAt };
    },
    cnc: (id, reason, source) => {
      out[id] = { could_not_check: reason, source };
    },
    NC: `the last ${last.calls} model calls`,
    NM: `the last ${last.prs} merged Claude PRs`,
    NO: `the last ${last.prs} opened Claude PRs`,
    NUSE: `the last ${last.consumption} merged Claude PRs`,
    tokenSource: `${transcripts}: message.usage, one count per message.id`,
    costSource: `${transcripts}: last cost-state record per session`,
  };
  // Tokens: the last N model calls, main sessions and their subagents.
  c.allMsgs = [...t.messages.values()].filter((m) => m.at <= now);
  c.msgs = lastN(c.allMsgs, last.calls, (m) => m.at, now);
  cacheMetric(c);
  subagentMetric(c);
  contextMetric(c);
  // Everything below needs the PRs from GitHub.
  if (github.error || !github.opened?.length) {
    const reason = github.error ?? (github.linked ? 'no linked PR was opened by the session that linked it' : 'no session has a pr-link entry yet');
    const noPrIds = ['claude.cache_read_share', 'claude.subagent_cost_share', 'claude.context_per_call'];
    for (const id of metricIds.filter((x) => !noPrIds.includes(x))) c.cnc(id, reason, PR_SOURCE);
    return order(out, transcripts);
  }
  prSets(c);
  mergeShareMetric(c);
  firstPushMetric(c);
  bugsMetric(c);
  testsMetric(c);
  deliveryMetric(c);
  if (!c.merged.length) {
    for (const id of ['claude.tokens_per_merged_pr', 'claude.cost_per_merged_pr_usd', 'claude.compactions_per_10_prs']) c.cnc(id, NO_MERGED, c.mergedSource);
    return order(out, transcripts);
  }
  const shares = sessionShares(c);
  tokensMetric(c, shares);
  costMetric(c, shares);
  compactionsMetric(c, shares);
  return order(out, transcripts);
}

function cacheMetric({ msgs, val, cnc, tokenSource, NC }) {
  const tot = Object.fromEntries(TOKEN_KEYS.map((k) => [k, sum(msgs.map((m) => m[k]))]));
  const inputSide = tot.input + tot.cacheWrite + tot.cacheRead;
  if (inputSide <= 0) return cnc('claude.cache_read_share', NO_USAGE, tokenSource);
  val('claude.cache_read_share', pct(tot.cacheRead, inputSide), `${tokenSource}; ${NC} (${msgs.length} read)`, [
    item('cache read', tot.cacheRead, 'tokens'),
    item('cache write', tot.cacheWrite, 'tokens'),
    item('fresh input', tot.input, 'tokens'),
  ]);
}

// The subagent share compares like with like: main and subagent rows alike
// from Claude Code 2.1.307 on, since only those hold real subagent usage.
// By API-equivalent cost, each call priced by its model (params.prices). A
// model with no price is left out of both sides and counted.
function subagentMetric({ msgs, params, val, cnc, tokenSource, NC }) {
  const current = msgs.filter((m) => usageCounts({ sidechain: true, version: m.version, at: m.at }));
  const shareSource = `${tokenSource}; ${NC}, of them rows from Claude Code 2.1.307 on (or, with no version, from 2026-10-21): earlier subagent transcripts held placeholder usage (github.com/anthropics/claude-code/releases/tag/v2.1.307)`;
  const priceOf = (m) => priceCall(m, params);
  const priced = current.filter((m) => priceOf(m) !== null);
  const pricedSource = `${shareSource}; each call priced by priceCall in claude.mjs: its model's input and output price per million, the long tier over ${params.long_context_tokens} prompt tokens, 5-minute writes x${params.cache_write_5m_x}, 1-hour writes x${params.cache_write_1h_x} and reads at the model's cache_read_x, else x${params.cache_read_x}, of input (params.prices, ${params.source})`;
  const spend = { all: sum(priced.map(priceOf)), side: sum(priced.filter((m) => m.sidechain).map(priceOf)) };
  if (spend.all <= 0) return cnc('claude.subagent_cost_share', `no priced model call in ${NC}; prices live in params.prices`, pricedSource);
  val('claude.subagent_cost_share', pct(spend.side, spend.all), pricedSource, [
    item('main sessions', round(spend.all - spend.side, 2), 'USD'),
    item('subagents', round(spend.side, 2), 'USD'),
    ...Object.entries(Object.groupBy(priced.filter((m) => m.sidechain), (m) => m.model)).map(([model, list]) => item(`subagents on ${model}`, round(sum(list.map(priceOf)), 2), 'USD')),
    item('calls with no price, left out', current.length - priced.length, 'calls'),
  ]);
}

// Context per call: what each model call carried in, cached or not.
function contextMetric({ msgs, allMsgs, val, cnc, tokenSource, NC }) {
  const context = (ms) => ms.map((m) => m.input + m.cacheWrite + m.cacheRead).filter((x) => x > 0);
  const calls = context(msgs);
  if (!calls.length) return cnc('claude.context_per_call', NO_USAGE, tokenSource);
  const main = context(msgs.filter((m) => !m.sidechain));
  const side = context(msgs.filter((m) => m.sidechain));
  val('claude.context_per_call', Math.round(median(calls)), `${tokenSource}; ${NC}`, [
    ...(main.length ? [item('main sessions, median', Math.round(median(main)), 'tokens')] : []),
    ...(side.length ? [item('subagents, median', Math.round(median(side)), 'tokens')] : []),
    item('p90, all calls', Math.round(percentile(calls, 0.9)), 'tokens'),
    item('all time, median', Math.round(median(context(allMsgs))), 'tokens'),
  ]);
}

// The PR sets every PR metric reads, added to the context.
function prSets(c) {
  const { github, now, last } = c;
  const created = (p) => Date.parse(p.createdAt);
  const mergedAtOf = (p) => (p.state === 'MERGED' ? Date.parse(p.mergedAt) : NaN);
  const openedAll = github.opened.filter((p) => created(p) <= now);
  const mergedAll = openedAll.filter((p) => mergedAtOf(p) <= now);
  Object.assign(c, {
    created,
    mergedAtOf,
    openedAll,
    mergedAll,
    opened: lastN(openedAll, last.prs, created, now),
    merged: lastN(mergedAll, last.prs, mergedAtOf, now),
    consumed: lastN(mergedAll, last.consumption, mergedAtOf, now),
    prSource: `${PR_SOURCE}; ${c.NO}`,
    mergedSource: `${PR_SOURCE}; ${c.NM}`,
  });
}

// Holds up: merged rather than closed, as a funnel of nested stages, over
// the last N opened PRs that finished. The last stage drops those reverted so far.
function mergeShareMetric({ github, openedAll, mergedAtOf, created, now, last, val, cnc }) {
  const wasReverted = (p) => (github.reverted.byRepo.get(p.repo)?.get(p.number) ?? Infinity) <= now;
  const finished = lastN(openedAll.filter((p) => p.state === 'CLOSED' || mergedAtOf(p) <= now), last.prs, created, now);
  const funnelSource = `${PR_SOURCE}; the last ${last.prs} opened Claude PRs that merged or closed`;
  if (!finished.length) return cnc('claude.pr_merge_share', 'no Claude PR has merged or closed', funnelSource);
  const finishedMerged = finished.filter((p) => p.state === 'MERGED');
  const kept = finishedMerged.filter((p) => !wasReverted(p));
  val('claude.pr_merge_share', pct(finishedMerged.length, finished.length), funnelSource, [
    item('merged or closed', finished.length, 'PRs'),
    item('merged', finishedMerged.length, 'PRs'),
    ...(github.reverted.error ? [] : [item('not reverted so far', kept.length, 'PRs')]),
  ]);
}

function firstPushMetric({ github, opened, notCode, NO, val, cnc }) {
  const pushSource = `${PR_SOURCE}; gh api graphql commit statusCheckRollup; a cancelled check is no verdict, and ${[...notCode].join(', ') || 'no check'} (params.not_code_checks: they read the PR, not run it) is left out; ${NO}`;
  const id = 'claude.first_push_green_share';
  const states = opened.map((p) => github.firstPush.byPr.get(p)).filter(Boolean);
  const count = (s) => states.filter((x) => x.state === s).length;
  const green = count('green');
  const red = count('red');
  if (github.firstPush.error) return cnc(id, github.firstPush.error, pushSource);
  if (!(green + red)) return cnc(id, `none of ${NO} has a finished check on its first push`, pushSource);
  const failedChecks = new Map();
  for (const s of states) for (const name of new Set(s.failed)) failedChecks.set(name, (failedChecks.get(name) ?? 0) + 1);
  val(id, pct(green, green + red), pushSource, [
    item('green', green, 'PRs'),
    item('red', red, 'PRs'),
    item('pending', count('pending'), 'PRs'),
    item('cancelled, no verdict', count('cancelled'), 'PRs'),
    item('no checks', count('none'), 'PRs'),
    ...[...failedChecks].sort((a, b) => b[1] - a[1]).map(([name, n]) => item(`failed: ${name}`, n, 'PRs')),
  ]);
}

function bugsMetric({ github, merged, mergedAll, now, NM, val, cnc }) {
  const id = 'claude.escaped_bugs_per_10_prs';
  const bugSource = `${BUG_SOURCE}; bugs naming a Claude PR as the cause (a Regressed-by: #N line, or a phrase such as "introduced in #N" or "caused by #N"; a mention for context is no cause) filed after it merged, up to now, per 10 of ${NM}`;
  if (github.bugs.error) return cnc(id, github.bugs.error, bugSource);
  if (!merged.length) return cnc(id, NO_MERGED, bugSource);
  const blame = (list) => {
    const byPr = list.map((p) => [p, escapedBugs(p, github.bugs.byRepo.get(p.repo) ?? [], now)]).filter(([, bugs]) => bugs.length);
    const issues = new Set(byPr.flatMap(([p, bugs]) => bugs.map((b) => `${p.repo}#${b.number}`)));
    return { byPr, issues: issues.size };
  };
  const scored = blame(merged);
  const ever = blame(mergedAll);
  val(id, per10(scored.issues, merged.length), bugSource, [
    item('bug issues naming a merged PR as the cause', scored.issues, 'issues'),
    item('merged Claude PRs', merged.length, 'PRs'),
    ...scored.byPr
      .sort((a, b) => b[1].length - a[1].length || b[0].number - a[0].number)
      .slice(0, 5)
      .map(([p, bugs]) => item(`#${p.number}`, bugs.length, 'issues')),
    item('all time, per 10 merged PRs', per10(ever.issues, mergedAll.length), 'bugs'),
  ]);
}

function testsMetric({ merged, mergedSource, NM, val, cnc }) {
  const id = 'claude.code_prs_with_tests_share';
  if (!merged.length) return cnc(id, NO_MERGED, mergedSource);
  const code = merged.filter((p) => p.code);
  if (!code.length) return cnc(id, `none of ${NM} changed code`, mergedSource);
  const tested = code.filter((p) => p.tests).length;
  val(id, pct(tested, code.length), `${mergedSource}; file paths only`, [
    item('code and a test', tested, 'PRs'),
    item('code without a test', code.length - tested, 'PRs'),
  ]);
}

// Delivery: from the session's first line to the PR, over the last N opened.
function deliveryMetric({ t, github, opened, openedAll, created, prSource, transcripts, val, cnc }) {
  if (!opened.length) return cnc('claude.hours_session_to_pr', 'no Claude PR has opened', prSource);
  const toOpen = (list) => list.map((p) => (created(p) - t.sessions.get(p.sessionId).start) / HOUR);
  val('claude.hours_session_to_pr', round(median(toOpen(opened)), 2), `${prSource}; ${transcripts}: first timestamp of the linking session`, [
    item('PRs opened', opened.length, 'PRs'),
    item('p90', round(percentile(toOpen(opened), 0.9), 2), 'h'),
    item('all time, median', round(median(toOpen(openedAll)), 2), 'h'),
    ...(github.missing ? [item('linked PRs GitHub does not have', github.missing, 'PRs')] : []),
  ]);
}

// Per merged PR: each PR takes its linking session's tokens, cost and
// compactions, split evenly over the PRs that session opened and merged.
function sessionShares({ mergedAll, allMsgs }) {
  const mergedBySession = new Map();
  for (const p of mergedAll) mergedBySession.set(p.sessionId, (mergedBySession.get(p.sessionId) ?? 0) + 1);
  const shareOfSession = (p, total) => total / mergedBySession.get(p.sessionId);
  const sessionSum = (f) => {
    const totals = new Map();
    for (const m of allMsgs) totals.set(m.sessionId, (totals.get(m.sessionId) ?? 0) + f(m));
    return (p) => shareOfSession(p, totals.get(p.sessionId) ?? 0);
  };
  return { shareOfSession, sessionSum };
}

function tokensMetric({ merged, consumed, tokenSource, NUSE, val }, { sessionSum }) {
  const meanOver = (f, list = merged) => sum(list.map(f)) / list.length;
  const consumedSource = `${tokenSource}; ${NUSE}, each with its linking session's tokens split evenly over the PRs that session opened and merged`;
  const [inputOf, outputOf, writeOf] = ['input', 'output', 'cacheWrite'].map((k) => sessionSum((m) => m[k]));
  val('claude.tokens_per_merged_pr', Math.round(meanOver((p) => inputOf(p) + outputOf(p) + writeOf(p), consumed)), consumedSource, [
    item('cache write', Math.round(meanOver(writeOf, consumed)), 'tokens'),
    item('output', Math.round(meanOver(outputOf, consumed)), 'tokens'),
    item('fresh input', Math.round(meanOver(inputOf, consumed)), 'tokens'),
  ]);
}

// Cost: only PRs whose linking session has a cost record; the rest are counted.
function costMetric({ t, mergedAll, consumed, costSource, NUSE, val, cnc }, { shareOfSession }) {
  const costOf = (p) => shareOfSession(p, t.sessions.get(p.sessionId).cost.usd);
  const withCost = consumed.filter((p) => t.sessions.get(p.sessionId).cost);
  const costSplit = `${costSource}; ${NUSE} whose linking session has one, its totalCostUSD split evenly over the PRs that session opened and merged`;
  if (!withCost.length) return cnc('claude.cost_per_merged_pr_usd', `no session that linked one of ${NUSE} has a cost record`, costSplit);
  const everCost = mergedAll.filter((p) => t.sessions.get(p.sessionId).cost);
  val('claude.cost_per_merged_pr_usd', round(sum(withCost.map(costOf)) / withCost.length, 2), costSplit, [
    item('API-equivalent cost, these PRs', round(sum(withCost.map(costOf)), 2), 'USD'),
    item('merged PRs with a costed session', withCost.length, 'PRs'),
    item('merged PRs without one, left out', consumed.length - withCost.length, 'PRs'),
    item('all time, per merged PR', round(sum(everCost.map(costOf)) / everCost.length, 2), 'USD'),
  ]);
}

function compactionsMetric({ t, merged, mergedAll, now, transcripts, NM, val }, { shareOfSession }) {
  const compactSource = `${transcripts}: type system, subtype compact_boundary (a field observed in transcripts, not in Anthropic's public docs); per 10 of ${NM}, each with its linking session's compactions split evenly over the PRs that session opened and merged`;
  const compactCount = new Map();
  for (const x of t.compactions) if (x.at <= now) compactCount.set(x.sessionId, (compactCount.get(x.sessionId) ?? 0) + 1);
  const compactOf = (p) => shareOfSession(p, compactCount.get(p.sessionId) ?? 0);
  const compacted = sum(merged.map(compactOf));
  val('claude.compactions_per_10_prs', per10(compacted, merged.length), compactSource, [
    item('compactions, these PRs', round(compacted, 2), 'compactions'),
    item('sessions that compacted', new Set(merged.filter((p) => compactOf(p) > 0).map((p) => p.sessionId)).size, 'sessions'),
    item('merged PRs', merged.length, 'PRs'),
    item('all time, per 10 merged PRs', per10(t.compactions.length, mergedAll.length), 'compactions'),
  ]);
}

// Same key order as the targets file, so diffs of the output stay readable.
function order(out, transcripts) {
  return Object.fromEntries(metricIds.map((id) => [id, out[id] ?? { could_not_check: 'collector produced no value', source: transcripts }]));
}
