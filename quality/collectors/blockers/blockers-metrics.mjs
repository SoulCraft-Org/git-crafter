// The Blockers metrics from what the collector read (blockers.mjs).

import { GH_SOURCE, LAST_CALLS, LAST_PRS, LAST_SESSIONS, MIN, PER, iso, item, metricIds, newestFirst, pct, round, sum } from './blockers-core.mjs';
import { gitMetrics, guardAlarmMetric, guardRateMetric, latestBlockMetrics, markMisfires, refusalRows } from './blockers-guard.mjs';
import { blocksOf, lastSessions, notesOf, sessionStart } from './blockers-outcome.mjs';
import { breaker, pushes, reviewRounds, verdict } from './blockers-github.mjs';
import { ledgerRow } from './blockers-ledger.mjs';

// Every Blockers metric from the read transcripts, guard log, instructions and GitHub answers.
export function computeMetrics({ files, log, instructions, github, replayed = {}, now, readAt, cfg }) {
  const out = {};
  const c = spanContext({ files, log, instructions, github, replayed, now, cfg });
  c.val = (id, value, source, detail) => {
    out[id] = { value, ...(detail ? { detail } : {}), source, read_at: readAt };
  };
  c.cnc = (id, reason, source) => {
    out[id] = { could_not_check: reason, source };
  };
  markMisfires(c.everyBlock, c.logEntries);
  guardRateMetric(c);
  guardAlarmMetric(c);
  refusalRows(c);
  latestBlockMetrics(c);
  gitMetrics(c);
  hookMetrics(c);
  instructionRows(c);
  githubMetrics(c);
  ledgerMetric(c);
  return Object.fromEntries(metricIds.map((id) => [id, out[id] ?? { could_not_check: 'collector produced no value', source: cfg.transcripts }]));
}

// What the metrics share: the span of the last LAST_CALLS tool calls (every
// transcript of this repo, subagents included; calls that tie the oldest one's
// time count too), its blocks and notes, and the guard log's entries.
function spanContext({ files, log, instructions, github, replayed, now, cfg }) {
  const TRANSCRIPTS = cfg.transcripts;
  const haveFiles = !files.error;
  const allCalls = haveFiles ? files.flatMap((f) => f.calls).filter((x) => x.at <= now).sort(newestFirst) : [];
  const cutoff = allCalls.length ? allCalls[Math.min(LAST_CALLS, allCalls.length) - 1].at : Infinity;
  const inSpan = (at) => at >= cutoff && at <= now;
  const calls = allCalls.filter((x) => inSpan(x.at));
  const SPAN = calls.length ? `the last ${calls.length} tool calls (${LAST_CALLS} wanted), ${iso(cutoff)} to ${iso(calls[0].at)} UTC` : `the last ${LAST_CALLS} tool calls`;
  const everyBlock = haveFiles ? blocksOf(files, now, { fixes: cfg.fixes }) : [];
  const logEntries = log.error ? [] : log.entries.filter((e) => e.here);
  return {
    files, log, instructions, github, replayed, now, cfg, TRANSCRIPTS, haveFiles, allCalls, inSpan, calls, SPAN, everyBlock,
    GUARD_LOG: cfg.guardLog,
    ledger: [],
    filesReason: `${TRANSCRIPTS}: ${files.error}`,
    per: (x) => (x * PER) / calls.length,
    RATE: `per ${PER} tool calls over ${SPAN}`,
    noCalls: `no tool call in ${TRANSCRIPTS}`,
    blocks: everyBlock.filter((b) => inSpan(b.at)),
    notes: haveFiles ? notesOf(files, inSpan) : [],
    logEntries,
    logInSpan: logEntries.filter((e) => inSpan(e.at)),
    guardBlocks: everyBlock.filter((b) => b.kind === 'guard' && inSpan(b.at)),
  };
}

// Hook text that entered the context: session start, app reminders, guard
// notes, git warnings. The metric is per session, over the last
// LAST_SESSIONS main sessions by start, each with its subagents; the ledger
// rows stay over the span of tool calls.
function hookMetrics(c) {
  const { files, haveFiles, now, calls, notes, ledger, TRANSCRIPTS, filesReason, val, cnc } = c;
  const sessions = haveFiles ? lastSessions(files, now) : [];
  const SN = `the last ${LAST_SESSIONS} main sessions by start, each with its subagents`;
  const hookSource = `${TRANSCRIPTS}: hook attachments and git WARN and INFRA lines, characters / 4, times the calls that read them again up to the next compaction, summed per session, mean over ${SN}`;
  const id = 'blockers.hook_tokens_per_session';
  if (!haveFiles) cnc(id, filesReason, hookSource);
  else if (!sessions.length) cnc(id, `no main session in ${TRANSCRIPTS}`, hookSource);
  else {
    const perSession = sessions.map((list) => notesOf(list, (at) => at <= now));
    const all = perSession.flat();
    const mean = (xs) => Math.round(sum(xs) / sessions.length);
    const starts = sessions.map((l) => sessionStart(l));
    val(id, mean(perSession.map((n) => sum(n.map((x) => x.tokens)))), `${hookSource}; ${sessions.length} read, started ${iso(Math.min(...starts))} to ${iso(Math.max(...starts))} UTC`, [
      ...byLabel(all).map((label) => item(label === 'pre-commit' || label === 'pre-push' ? `git ${label} warnings` : label, mean(all.filter((n) => n.label === label).map((n) => n.tokens)))).sort((a, b) => b.value - a.value),
      item('tool calls a session, these sessions', round(sum(sessions.map((l) => sum(l.map((f) => f.calls.filter((x) => x.at <= now).length)))) / sessions.length), ''),
    ]);
  }
  if (!haveFiles || !calls.length) return;
  for (const label of byLabel(notes).filter((l) => l !== 'pre-commit' && l !== 'pre-push')) {
    const mine = notes.filter((n) => n.label === label);
    ledger.push(ledgerRow(label, 'Tokens', { fires: mine.length, ms: mine.map((n) => n.ms), tokens: mine.map((n) => n.tokens) }));
  }
}

const byLabel = (list) => [...new Set(list.map((b) => b.label))].sort();

// Always-loaded instructions, ledger rows only (the metric is
// claude.instruction_tokens): tokens per call times the main-session model
// calls in the span.
function instructionRows({ files, haveFiles, instructions, inSpan, ledger }) {
  if (!haveFiles || instructions.error) return;
  const seen = new Set();
  const mainCalls = files.flatMap((f) => f.messages).filter((m) => !m.sidechain && inSpan(m.at) && !seen.has(m.id) && seen.add(m.id)).length;
  for (const f of instructions.files) ledger.push(ledgerRow(f.label, 'Tokens', { fires: mainCalls, tokens: [f.tokens * mainCalls] }));
}

// Review subagent tokens for the last LAST_PRS merged PRs. A reviewer whose
// Agent call names PRs charges its tokens to them, split evenly; one naming
// none counts between the merge before those PRs and the newest merge.
export function reviewerTokens(files, read, prs) {
  const numbers = new Set(prs.map((pr) => pr.number));
  const byPr = new Map();
  let unnamed = 0;
  const from = read.length > LAST_PRS ? Date.parse(read[LAST_PRS].mergedAt) : -Infinity;
  const to = prs.length ? Date.parse(prs[0].mergedAt) : -Infinity;
  for (const f of files.filter((x) => x.reviewer)) {
    const named = f.reviewPrs ?? [];
    if (!named.length) {
      unnamed += sum(f.messages.filter((m) => m.at > from && m.at <= to).map((m) => m.billable));
      continue;
    }
    const share = sum(f.messages.map((m) => m.billable)) / named.length;
    for (const n of named.filter((x) => numbers.has(x))) byPr.set(n, (byPr.get(n) ?? 0) + share);
  }
  return { total: Math.round(sum([...byPr.values()]) + unnamed), byPr, unnamed };
}

// Review loop and CI waits, from GitHub: the last LAST_PRS merged PRs.
function githubMetrics(c) {
  const { files, haveFiles, github, cfg, TRANSCRIPTS, ledger, val, cnc } = c;
  const read = github.error ? [] : github.prs;
  const prs = read.slice(0, LAST_PRS);
  c.prs = prs;
  c.LASTN = `last ${LAST_PRS} merged PRs`;
  c.ghSource = prs.length ? `${GH_SOURCE}; the ${c.LASTN}, ${prs.length} read, merged ${iso(Date.parse(prs.at(-1).mergedAt))} to ${iso(Date.parse(prs[0].mergedAt))} UTC` : `${GH_SOURCE}; the ${c.LASTN}`;
  const review = haveFiles ? reviewerTokens(files, read, prs) : null;
  if (github.error || !prs.length) {
    const reason = github.error ?? `no merged PR in ${cfg.repo}`;
    for (const id of ['blockers.review_tokens_per_pr', 'blockers.pushes_per_merged_pr']) cnc(id, reason, c.ghSource);
  } else {
    reviewMetrics(prs, review, { val, cnc, ghSource: c.ghSource, ledger, LASTN: c.LASTN, TRANSCRIPTS, reviewer: cfg.reviewer });
    ciMetrics(prs, { val, cnc, ghSource: c.ghSource, ledger, LASTN: c.LASTN });
  }
  breaker(prs, github, { val, cnc, LASTN: c.LASTN, enforcement: cfg.enforcement });
}

// The ledger: one row per blocker, grouped, costliest first.
function ledgerMetric(c) {
  const { files, log, github, ledger, SPAN, LASTN, GUARD_LOG, filesReason, val, cnc } = c;
  const ORDER = ['Quality', 'Speed', 'Tokens'];
  const rows = ledger.sort((a, b) => ORDER.indexOf(a.group) - ORDER.indexOf(b.group) || (b.tokens ?? -1) - (a.tokens ?? -1) || (b.hours ?? -1) - (a.hours ?? -1));
  const ledgerSource = `every blocker read above: fires, hours and tokens summed over ${SPAN}, the pinned review and CI checks over the ${LASTN}; verdict() in quality/collectors/blockers/blockers.mjs`;
  if (rows.some((r) => r.verdict !== 'not-measured')) return val('blockers.costly', rows.filter((r) => r.verdict === 'costs').length, ledgerSource, rows);
  cnc('blockers.costly', [files.error && filesReason, log.error && `${GUARD_LOG}: ${log.error}`, github.error].filter(Boolean).join('; ') || 'no blocker fired or cost anything in the span', ledgerSource);
}

// Review rounds and reviewer tokens per merged PR, plus their ledger row.
function reviewMetrics(prs, review, { val, cnc, ghSource, ledger, LASTN, TRANSCRIPTS, reviewer }) {
  const reviewed = prs.map((pr) => ({ pr, rounds: reviewRounds(pr, reviewer) })).filter((r) => r.rounds.length);
  const rounds = reviewed.flatMap((r) => r.rounds);
  const count = (kind) => rounds.filter((r) => r.kind === kind).length;
  const tokenSource = `${TRANSCRIPTS}: subagents whose meta.json says review, message.usage; one whose Agent call names PRs is charged to them, one naming none counts after the merge before the ${LASTN} up to the newest merge; ${ghSource}`;
  const tokens = review?.total ?? 0;
  if (review === null) cnc('blockers.review_tokens_per_pr', `${TRANSCRIPTS}: could not read`, tokenSource);
  else if (tokens > 0) {
    const perPr = [...review.byPr].sort((a, b) => b[1] - a[1]).map(([n, t]) => item(`#${n}`, Math.round(t), 'tokens'));
    const unnamed = review.unnamed ? [item('review subagents naming no PR', review.unnamed, 'tokens')] : [];
    val('blockers.review_tokens_per_pr', Math.round(tokens / prs.length), tokenSource, [item('review subagent tokens', tokens, 'tokens'), item('merged PRs', prs.length, 'PRs'), ...perPr, ...unnamed]);
  } else cnc('blockers.review_tokens_per_pr', `no review subagent ran while the ${LASTN} were open; reviews in a main session are not told apart`, tokenSource);

  // The loop's time: from each reviewed commit's push to its review.
  const pushedAt = (pr, oid) => pushes(pr).find((p) => p.oid === oid)?.pushedAt;
  const waits = reviewed.flatMap(({ pr, rounds: r }) => r.map((x) => x.at - (pushedAt(pr, x.oid) ?? NaN))).filter((ms) => ms >= 0);
  const found = count('found');
  const clean = count('clean');
  ledger.push(ledgerRow('pinned review', 'Quality', { fires: rounds.length, ms: waits, tokens: tokens ? [tokens] : [], falseAlarm: found + clean ? pct(clean, found + clean) : null }));
}

// Pushes per merged PR and CI's ledger row, from each PR's finished check runs.
function ciMetrics(prs, { val, cnc, ghSource, ledger, LASTN }) {
  const perPr = prs.map(pushes).filter((list) => list.length);
  const all = perPr.flat();
  const noPush = `no commit on the ${LASTN} has a finished check run`;
  if (!all.length) {
    cnc('blockers.pushes_per_merged_pr', noPush, ghSource);
    return;
  }
  const red = sum(all.map((p) => p.red));
  const flaky = sum(all.map((p) => p.flaky));
  const k = (n) => perPr.filter((list) => (n === 4 ? list.length >= 4 : list.length === n)).length;
  val('blockers.pushes_per_merged_pr', round(all.length / perPr.length, 2), ghSource, [item('1 push', k(1), 'PRs'), item('2 pushes', k(2), 'PRs'), item('3 pushes', k(3), 'PRs'), item('4 or more', k(4), 'PRs')]);
  const waits = all.map((p) => p.waitMin);
  ledger.push(ledgerRow('CI checks', 'Quality', { fires: all.length, ms: waits.map((m) => m * MIN), falseAlarm: red ? pct(flaky, red) : null }));
}
