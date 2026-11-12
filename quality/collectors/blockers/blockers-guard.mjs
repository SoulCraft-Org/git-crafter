// The Blockers metrics about the bash guard, tool refusals and git hooks (blockers.mjs).

import { percentile } from '../github/github.mjs';
import { LAST_GIT, LAST_GUARD, MARK_MS, iso, item, median, newestFirst, pct, round } from './blockers-core.mjs';
import { ledgerRow, readable } from './blockers-ledger.mjs';

// A guard block the log marks a misfire (same rule, within MARK_MS of the
// block) is a false alarm whatever came after it.
export function markMisfires(everyBlock, logEntries) {
  for (const b of everyBlock) {
    if (b.kind !== 'guard' || b.falseAlarm || b.outcome === 'unread') continue;
    const end = Number.isFinite(b.resultAt) ? b.resultAt : b.at;
    if (logEntries.some((e) => e.misfire && e.rules.some((r) => b.rules.includes(r)) && e.at >= b.at - MARK_MS && e.at <= end + MARK_MS)) {
      b.outcome = 'marked';
      b.falseAlarm = true;
    }
  }
}

// Bash guard: fires from its own log, outcomes from the transcripts.
export function guardRateMetric(c) {
  const { log, haveFiles, calls, logInSpan, cfg, GUARD_LOG, RATE, per, filesReason, noCalls, val, cnc } = c;
  const id = 'blockers.guard_blocks_per_100_calls';
  const logSource = `${GUARD_LOG}: ts, cwd and rules of blocks run in this repo's checkout (${cfg.checkout}), ${RATE}`;
  if (log.error) return cnc(id, `${GUARD_LOG}: ${log.error}`, logSource);
  if (!haveFiles) return cnc(id, filesReason, logSource);
  if (!calls.length) return cnc(id, noCalls, logSource);
  const ruleNames = [...new Set(logInSpan.flatMap((e) => e.rules))];
  const detail = ruleNames.map((r) => item(r, round(per(logInSpan.filter((e) => e.rules.includes(r)).length), 3))).sort((a, b) => b.value - a.value);
  val(id, round(per(logInSpan.length), 3), `${logSource}; ${logInSpan.length} blocks`, detail);
}

// The share of the last bash guard blocks that were false alarms, with a
// breakdown of each held and false-alarm outcome.
export function guardAlarmMetric(c) {
  const { everyBlock, replayed, cfg, TRANSCRIPTS, haveFiles, filesReason, val, cnc } = c;
  const id = 'blockers.guard_false_alarm_share';
  const lastGuard = everyBlock.filter((b) => b.kind === 'guard').sort(newestFirst).slice(0, LAST_GUARD);
  const replayNote = replayed.error ? `the replay through the current guard could not run (${replayed.error}), so no block reads as a misfire since fixed` : `${replayed.replayed ?? 0} recent blocks replayed through the current guard (${cfg.guardScript})`;
  const guardSource = `${TRANSCRIPTS}: the last ${LAST_GUARD} bash guard blocks. Held: no similar command succeeded within 10 minutes, or every one that did ran only the blocked command's own steps, as typed, steps that apply the named fix (params.fix_signals) and write no file, allowlisted read-only steps and, in a call that runs the fix, edits of steps the guard did not block. False alarm: anything else, a veto, the same command run unblocked, a current guard that breaks no rule on the blocked command on replay, or a misfire mark in the guard log (outcomeOf() in blockers.mjs); ${replayNote}`;
  const judged = readable(lastGuard);
  if (!haveFiles) return cnc(id, filesReason, guardSource);
  if (!lastGuard.length) return cnc(id, `no bash guard block in this repo's transcripts`, guardSource);
  if (!judged.length) return cnc(id, `none of the last ${lastGuard.length} guard blocks has a command that can be read`, guardSource);
  const count = (o) => lastGuard.filter((b) => b.outcome === o).length;
  const falseAlarms = judged.filter((b) => b.falseAlarm).length;
  val(id, pct(falseAlarms, judged.length), `${guardSource}; ${judged.length} judged of ${lastGuard.length}, ${iso(lastGuard.at(-1).at)} to ${iso(lastGuard[0].at)} UTC`, [
    item('held: the named fix ran', count('fixed'), 'blocks'),
    item('held: retried without the blocked part', count('dropped'), 'blocks'),
    item('held: rule since narrowed, still blocked', count('narrowed'), 'blocks'),
    item('held: not retried', count('none'), 'blocks'),
    item('false alarm: retried without the fix', count('unfixed'), 'blocks'),
    item('false alarm: the same command ran', count('same'), 'blocks'),
    item('false alarm: the current guard allows it', count('replayed'), 'blocks'),
    item('false alarm: marked a misfire', count('marked'), 'blocks'),
    ...(count('unread') ? [item('could not tell: no command to read', count('unread'), 'blocks')] : []),
  ]);
}

// Ledger rows: one per guard rule, then one per other refusal (tool hooks and
// permission checks). Git gates join their hook's row in gitMetrics.
export function refusalRows(c) {
  const { log, haveFiles, logInSpan, guardBlocks, blocks, ledger } = c;
  const rules = new Set([...logInSpan.flatMap((e) => e.rules), ...guardBlocks.flatMap((b) => b.rules)]);
  for (const rule of [...rules].sort()) {
    const mine = guardBlocks.filter((b) => b.rules.includes(rule));
    const fires = log.error ? (haveFiles ? mine.length : null) : logInSpan.filter((e) => e.rules.includes(rule)).length;
    ledger.push(ledgerRow(`guard: ${rule}`, 'Speed', { fires, alarms: mine, ms: mine.map((b) => b.ms), tokens: mine.map((b) => b.tokens) }));
  }
  const others = blocks.filter((b) => b.kind === 'hook' || b.kind === 'permission');
  for (const label of [...new Set(others.map((b) => b.label))].sort()) {
    const mine = others.filter((b) => b.label === label);
    ledger.push(ledgerRow(label, 'Speed', { fires: mine.length, alarms: mine, ms: mine.map((b) => b.ms), tokens: mine.map((b) => b.tokens) }));
  }
}

// What the latest block cost, read now: the newest block that has `key`, and
// each blocker's own latest beside it. How often blocks fire is
// guard_blocks_per_100_calls.
function latestBlock(blocks, key, scale) {
  const have = blocks.filter((b) => Number.isFinite(b[key])).sort((x, y) => y.at - x.at);
  if (!have.length) return null;
  const rows = [...new Set(have.map((b) => b.name))].map((name) => item(name, scale(have.find((b) => b.name === name)[key])));
  return { block: have[0], value: scale(have[0][key]), detail: rows.sort((x, y) => y.value - x.value) };
}

const when = (b) => `${b.name}, ${new Date(b.at).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

// Seconds and tokens the latest block cost, beside each blocker's latest.
export function latestBlockMetrics(c) {
  const { blocks, haveFiles, calls, SPAN, TRANSCRIPTS, noCalls, filesReason, val, cnc } = c;
  const blockSource = `${TRANSCRIPTS}: refusals by the bash guard, the write guard, app hooks, permission checks and git hooks, over ${SPAN}`;
  const on = haveFiles && calls.length;
  const seconds = on ? latestBlock(blocks, 'ms', (ms) => round(ms / 1000, 1)) : null;
  const tokens = on ? latestBlock(blocks, 'tokens', Math.round) : null;
  const noBlock = on ? `no block among ${SPAN}` : haveFiles ? noCalls : filesReason;
  if (!seconds) cnc('blockers.latest_block_seconds', noBlock, blockSource);
  else val('blockers.latest_block_seconds', seconds.value, `${blockSource}; the latest block (${when(seconds.block)}) to the next call, at most 10 minutes; beside it, each blocker's latest`, seconds.detail);
  if (!tokens) return cnc('blockers.latest_block_tokens', noBlock, blockSource);
  const fresh = Math.round(tokens.block.billable ?? 0);
  val('blockers.latest_block_tokens', tokens.value, `${blockSource}; message.usage of the call that answered the latest block (${when(tokens.block)}), in full, one share when blocks refused together share it; ${fresh} of them new tokens (input, output, cache write), the rest the conversation that call read again; beside it, each blocker's latest`, tokens.detail);
}

// Git hooks: commit and push time over the last LAST_GIT of each; their
// gates' blocks and their notes over the span.
export function gitMetrics(c) {
  const { haveFiles, allCalls, calls, blocks, notes, ledger, TRANSCRIPTS, filesReason, val, cnc } = c;
  const gitSource = (verb) => `${TRANSCRIPTS}: the last ${LAST_GIT} Bash calls that run git ${verb} alone, tool call to tool result`;
  for (const [verb, hook, id] of [
    ['commit', 'pre-commit', 'blockers.git_commit_seconds'],
    ['push', 'pre-push', 'blockers.git_push_seconds'],
  ]) {
    const finished = allCalls.filter((x) => x.git === verb && Number.isFinite(x.resultAt - x.at));
    const timed = finished.slice(0, LAST_GIT).map((x) => (x.resultAt - x.at) / 1000);
    if (!haveFiles) cnc(id, filesReason, gitSource(verb));
    else if (timed.length) {
      val(id, round(median(timed)), `${gitSource(verb)}; ${timed.length} read, from ${iso(finished[timed.length - 1].at)} UTC`, [item(`${hook} runs timed`, timed.length, ''), item('p90', round(percentile(timed, 0.9)), 's'), item('slowest', round(Math.max(...timed)), 's')]);
    } else cnc(id, `no git ${verb} call in this repo's transcripts`, gitSource(verb));
    if (!haveFiles) continue;
    const gates = blocks.filter((b) => b.kind === 'git' && b.label === hook);
    const runs = calls.filter((x) => x.git === verb || x.git === 'both').length;
    const spanMs = calls.filter((x) => x.git === verb && Number.isFinite(x.resultAt - x.at)).map((x) => x.resultAt - x.at);
    ledger.push(ledgerRow(`git ${hook} hook`, 'Quality', { fires: runs, alarms: gates, ms: spanMs, tokens: [...notes.filter((n) => n.label === hook).map((n) => n.tokens), ...gates.map((b) => b.tokens)] }));
  }
}
