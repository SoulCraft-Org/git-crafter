// Work metrics for the desktop app collector (desktop-app.mjs): the four
// readings of how sessions run their turns, sub-sessions and subagents, and
// the context a subagent starts with. Each takes the last N events, so new
// work replaces old; an empty N is could_not_check, never 0 or 100.

import fs from 'node:fs';
import { item, median, pct, usageCounts } from '../claude/claude-lib.mjs';
import { eachLine, firstTime } from '../instructions/instructions-sessions.mjs';
import { judge } from './desktop-app-turns.mjs';

const TRANSCRIPT = '.jsonl';
const list = (v) => (Array.isArray(v) ? v : []);
const newest = (rows, n) => [...rows].sort((a, b) => a.at - b.at).slice(-n);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// The last n of rows, or a reason when n is no count or nothing was found.
function window(rows, n, param, what) {
  if (!(n >= 1)) return { reason: `params.${param} must be at least one ${what}` };
  const last = newest(rows, n);
  return last.length ? { last } : { reason: `no ${what} in this repo's desktop sessions` };
}

function turnsClosed(judged, params, { val, cnc }) {
  const n = Number(params.turn_count);
  const source = `the last ${n} work turns a person started; N = ${n} turns`;
  const w = window(judged.turns, n, 'turn_count', 'work turn');
  if (w.reason) return cnc('turns_closed', w.reason, source);
  const closed = w.last.filter((t) => t.closed).length;
  val('turns_closed', pct(closed, w.last.length), source, [
    item('work turns judged', w.last.length, 'turns'),
    item('with a task list and a recap', closed, 'turns'),
    item('left out: a question, an approval or an interrupt', judged.asked, 'turns'),
    item('left out: still open', judged.open, 'turns'),
  ]);
}

function subSessionsClosed(judged, params, { val, cnc }) {
  const n = Number(params.sub_session_count);
  const source = `the last ${n} sub-sessions started; N = ${n} sub-sessions`;
  const w = window(judged.subs, n, 'sub_session_count', 'sub-session');
  if (w.reason) return cnc('sub_sessions_closed', w.reason, source);
  const archived = w.last.filter((s) => s.archived).length;
  val('sub_sessions_closed', pct(archived, w.last.length), source, [
    item('sub-sessions judged', w.last.length, 'sessions'),
    item('archived by their starter', archived, 'sessions'),
    item('left out: started in a live session', judged.liveSubs, 'sessions'),
  ]);
}

function subagentsKilled(judged, params, { val, cnc }) {
  const n = Number(params.notice_count);
  const source = `the last ${n} notices that answer an Agent call; N = ${n} notices`;
  const w = window(judged.notices, n, 'notice_count', 'subagent notice');
  if (w.reason) return cnc('subagents_killed', w.reason, source);
  const bad = w.last.filter((x) => list(params.bad_statuses).includes(x.status)).length;
  val('subagents_killed', pct(bad, w.last.length), source, [item('subagent notices', w.last.length, 'notices'), item('killed or failed', bad, 'notices')]);
}

function parallelShare(judged, params, { val, cnc }) {
  const n = Number(params.agent_turn_count);
  const source = `the last ${n} turns with two or more Agent calls; N = ${n} turns`;
  const w = window(judged.agentTurns, n, 'agent_turn_count', 'turn with two or more Agent calls');
  if (w.reason) return cnc('parallel_share', w.reason, source);
  const calls = w.last.reduce((sum, t) => sum + t.calls, 0);
  const late = w.last.reduce((sum, t) => sum + t.late, 0);
  val('parallel_share', pct(calls - late, calls), source, [
    item('turns with two or more Agent calls', w.last.length, 'turns'),
    item('Agent calls', calls, 'calls'),
    item('sent after an earlier one, with nothing learned between', late, 'calls'),
  ]);
}

const TURN_IDS = ['turns_closed', 'sub_sessions_closed', 'subagents_killed', 'parallel_share'];

// The four readings of turns, sub-sessions and subagent notices. A session
// whose turns could not be read (a broken param) leaves all four unmeasured.
export function workMetrics(sessions, params, now, write) {
  const broken = sessions.find((s) => s.turnsError);
  if (broken) {
    for (const id of TURN_IDS) write.cnc(id, broken.turnsError, 'the turns of this repo\'s desktop sessions');
    return;
  }
  const judged = judge(sessions.map((s) => s.turns), now.getTime(), params);
  turnsClosed(judged, params, write);
  subSessionsClosed(judged, params, write);
  subagentsKilled(judged, params, write);
  parallelShare(judged, params, write);
}

// The context of a subagent run's first model call, or null when the run
// logged no usage or predates subagent usage in transcripts.
function firstContext(file) {
  let context = null;
  eachLine(file, (record) => {
    const usage = record.type === 'assistant' ? record.message?.usage : null;
    if (!usage) return true;
    if (usageCounts({ sidechain: true, version: record.version, at: Date.parse(record.timestamp) })) {
      context = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
    }
    return false;
  });
  return context;
}

// A run's agent type, from the meta file beside its transcript.
function agentType(file, params) {
  try {
    return String(JSON.parse(fs.readFileSync(file.slice(0, -TRANSCRIPT.length) + params.subagent_meta_suffix, 'utf8')).agentType || 'unknown');
  } catch {
    return 'unknown';
  }
}

// The context the heaviest agent type starts with: the largest of the
// per-type medians over the last N runs, with a row for each type. One lean
// type run often must not hide a heavy one.
export function subagentMetric(sessions, params, now, { val, cnc }) {
  const n = Number(params.subagent_runs);
  const source = `the last ${n} subagent runs: the context of each run's first model call, the median of each agent type, the largest; N = ${n} runs`;
  const files = sessions.flatMap((s) => s.subagents).map((file) => ({ file, at: firstTime(file) })).filter((f) => f.at <= now.getTime());
  // Newest first, and no further than N runs that logged usage.
  const runs = [];
  for (const f of files.sort((a, b) => b.at - a.at)) {
    if (!(runs.length < n)) break;
    const context = firstContext(f.file);
    if (context !== null) runs.push({ ...f, context });
  }
  const w = window(runs, n, 'subagent_runs', 'run');
  if (w.reason) return cnc('subagent_start_tokens', w.reason.replace('no run in', 'no subagent run with usage in'), source);
  const types = new Map();
  for (const r of w.last) {
    const type = agentType(r.file, params);
    types.set(type, [...(types.get(type) ?? []), r.context]);
  }
  const byType = [...types].map(([type, xs]) => item(`${type} (${plural(xs.length, 'run')})`, Math.round(median(xs)), 'tokens')).sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
  val('subagent_start_tokens', byType[0].value, source, [item('subagent runs read', w.last.length, 'runs'), ...byType]);
}
