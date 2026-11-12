// node --test quality/collectors/desktop-app/desktop-app-turns.test.mjs
// Every input is synthetic and written to a temp folder at run time: one
// idle session with five turns and four subagent runs, and one live session.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { collect, PARAMS } from './desktop-app.mjs';

const now = new Date('2026-11-10T12:00:00Z');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-app-turns-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const write = (p, text) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};
const jsonl = (rows) => `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`;

const root = path.join(tmp, 'repo');
const home = path.join(tmp, 'home');
const folder = path.join(home, '.claude', 'projects', '-Users-someone-Developer-acme-site');

const PLAN = 'mcp__ccd_turn__update_plan';
const RECAP = 'mcp__ccd_turn__wrap_up';
const START = 'mcp__ccd_session__start_session';
const ARCHIVE = 'mcp__ccd_session_mgmt__archive_session';

// Records of one session; `at` is minutes after the session's start.
function session(sid, startIso) {
  const t = (min) => new Date(Date.parse(startIso) + min * 6e4).toISOString();
  const base = (min) => ({ timestamp: t(min), sessionId: sid, entrypoint: 'claude-desktop', isSidechain: false });
  return {
    human: (min, text = 'please do the work') => ({ ...base(min), type: 'user', origin: { kind: 'human' }, message: { content: text } }),
    say: (min, messageId, uses) => ({ ...base(min), type: 'assistant', message: { id: messageId, content: uses.map(([id, name, input = {}]) => ({ type: 'tool_use', id, name, input })) } }),
    result: (min, id, text, status) => ({ ...base(min), type: 'user', toolUseResult: status ? { status } : {}, message: { content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] }] } }),
    notice: (min, id, status) => ({ ...base(min), type: 'user', origin: { kind: 'task-notification' }, message: { content: `<task-notification>\n<task-id>x</task-id>\n<tool-use-id>${id}</tool-use-id>\n<status>${status}</status>\n</task-notification>` } }),
    interrupt: (min) => ({ ...base(min), type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } }),
  };
}

// t1 ended two days ago, so its last turn is judged.
const a = session('t1', '2026-11-08T08:00:00Z');
write(
  path.join(folder, 't1.jsonl'),
  jsonl([
    // Turn 1: an edit, a task list and a recap. Two agents start together, a third in the next message with nothing learned between.
    a.human(0),
    a.say(1, 'm1', [['p1', PLAN], ['e1', 'Edit']]),
    a.say(2, 'm2', [['a1', 'Agent', { subagent_type: 'Explore' }], ['a2', 'Agent', {}]]),
    a.result(2, 'a1', 'launched', 'async_launched'),
    a.result(2, 'a2', 'launched', 'async_launched'),
    a.say(3, 'm3', [['a3', 'Agent', { subagent_type: 'Explore' }], ['b1', 'Bash']]),
    a.result(3, 'a3', 'launched', 'async_launched'),
    // A fifth while the first three still run, but after the command's result came back: not late.
    a.result(3, 'b1', 'done'),
    a.say(3, 'm3a', [['a5', 'Agent', {}]]),
    a.result(3, 'a5', 'launched', 'async_launched'),
    a.notice(4, 'a1', 'completed'),
    a.notice(4, 'a2', 'killed'),
    a.notice(5, 'a3', 'completed'),
    // A background command's notice is no subagent's.
    a.notice(5, 'b1', 'killed'),
    // After the notices came in, a foreground agent: it may depend on them. Its answer is in
    // its tool result, so the agent after it may depend on that.
    a.say(6, 'm3c', [['a6', 'Agent', {}]]),
    a.result(6, 'a6', 'the answer', 'completed'),
    a.say(6, 'm3d', [['a7', 'Agent', {}]]),
    a.result(6, 'a7', 'launched', 'async_launched'),
    a.say(7, 'm4', [['w1', RECAP]]),
    // Turn 2: two commands and a task list, no recap. It starts two sub-sessions and archives one.
    a.human(10),
    a.say(11, 'm5', [['p2', PLAN], ['b2', 'Bash'], ['b3', 'Bash']]),
    a.say(12, 'm6', [['s1', START], ['s2', START]]),
    a.result(12, 's1', 'Started session "One" (session_id: local_aaaa-1111, name: one). It runs on its own.'),
    a.result(12, 's2', 'Started session "Two" (session_id: local_bbbb-2222, name: two). It runs on its own.'),
    a.say(13, 'm7', [['x1', ARCHIVE, { session_id: 'local_aaaa-1111' }]]),
    // Turn 3: a read only, so no work turn.
    a.human(20),
    a.say(21, 'm8', [['r1', 'Read']]),
    // Turn 4: ends by asking for a plan approval, so it is left out.
    a.human(30),
    a.say(31, 'm9', [['e2', 'Edit'], ['p3', PLAN], ['q1', 'ExitPlanMode']]),
    // Turn 5: interrupted, so it is left out.
    a.human(40),
    a.say(41, 'm10', [['e3', 'Edit']]),
    a.interrupt(42),
  ]),
);
// Subagent runs of t1: the context of each one's first model call.
const run = (id, version, usage) => jsonl([{ type: 'assistant', isSidechain: true, version, timestamp: '2026-11-08T08:02:00Z', message: { id: `${id}-1`, usage } }, { type: 'assistant', isSidechain: true, version, timestamp: '2026-11-08T08:03:00Z', message: { id: `${id}-2`, usage: { input_tokens: 900000 } } }]);
const sub = (id, type, version, usage) => {
  write(path.join(folder, 't1', 'subagents', `agent-${id}.jsonl`), run(id, version, usage));
  write(path.join(folder, 't1', 'subagents', `agent-${id}.meta.json`), JSON.stringify({ agentType: type, toolUseId: id }));
};
sub('a1', 'Explore', '2.1.321', { input_tokens: 10000, cache_creation_input_tokens: 2000, cache_read_input_tokens: 500, output_tokens: 7 });
sub('a2', 'general-purpose', '2.1.321', { input_tokens: 30000 });
sub('a3', 'Explore', '2.1.321', { input_tokens: 5000, cache_read_input_tokens: 15000 });
// Before Claude Code logged subagent usage: not counted.
sub('old', 'Explore', '2.1.100', { input_tokens: 999999 });

// t2 is live: its closed turn counts, its open last turn and the sub-session it started do not.
const b = session('t2', '2026-11-10T11:00:00Z');
write(
  path.join(folder, 't2.jsonl'),
  jsonl([
    b.human(0),
    b.say(1, 'n1', [['e9', 'Edit'], ['p9', PLAN], ['w9', RECAP]]),
    b.human(10),
    b.say(11, 'n2', [['e8', 'Edit'], ['p8', PLAN], ['s9', START]]),
    b.result(11, 's9', 'Started session "Three" (session_id: local_cccc-3333, name: three). It runs on its own.'),
  ]),
);

const params = { ...PARAMS, project_match: 'acme-site' };
const base = { root, mode: 'local', home, now, params };
const pick = (got, id) => got[`desktop_app.${id}`];
const rows = (entry) => Object.fromEntries(entry.detail.map((d) => [d.label, d.value]));

test('turns_closed: work turns a person started, with a task list and a recap', async () => {
  const got = pick(await collect(base), 'turns_closed');
  // Judged: turn 1 (closed), turn 2 (no recap), t2's first turn (closed).
  assert.equal(got.value, 66.7);
  assert.deepEqual(rows(got), { 'work turns judged': 3, 'with a task list and a recap': 2, 'left out: a question, an approval or an interrupt': 2, 'left out: still open': 1 });
  // N = 1: only the newest judged turn, t2's first.
  assert.equal(pick(await collect({ ...base, params: { ...params, turn_count: 1 } }), 'turns_closed').value, 100);
});

test('sub_sessions_closed: sub-sessions the session that started them archived', async () => {
  const got = pick(await collect(base), 'sub_sessions_closed');
  assert.equal(got.value, 50);
  assert.deepEqual(rows(got), { 'sub-sessions judged': 2, 'archived by their starter': 1, 'left out: started in a live session': 1 });
  assert.ok(!JSON.stringify(got).includes('local_'), 'no session id leaves the collector');
});

test('subagents_killed: only notices that answer an Agent call', async () => {
  const got = pick(await collect(base), 'subagents_killed');
  assert.equal(got.value, 33.3);
  assert.deepEqual(rows(got), { 'subagent notices': 3, 'killed or failed': 1 });
});

test('parallel_share: an Agent call sent after another with nothing learned between is not parallel', async () => {
  const got = pick(await collect(base), 'parallel_share');
  assert.equal(got.value, 83.3);
  assert.deepEqual(rows(got), { 'turns with two or more Agent calls': 1, 'Agent calls': 6, 'sent after an earlier one, with nothing learned between': 1 });
});

test('subagent_start_tokens: the heaviest agent type\'s median context at its first model call', async () => {
  const got = pick(await collect(base), 'subagent_start_tokens');
  assert.equal(got.value, 30000);
  assert.deepEqual(got.detail.map((d) => [d.label, d.value]), [['subagent runs read', 3], ['general-purpose (1 run)', 30000], ['Explore (2 runs)', 16250]]);
  assert.equal(pick(await collect({ ...base, params: { ...params, subagent_runs: 0 } }), 'subagent_start_tokens').could_not_check, 'params.subagent_runs must be at least one run');
});

test('a param a repo override broke reads could_not_check, and collect does not throw', async () => {
  // A status list that is no list counts nothing as killed.
  const noList = await collect({ ...base, params: { ...params, bad_statuses: 'killed' } });
  assert.equal(pick(noList, 'subagents_killed').value, 0);
  // A pattern that is no regex fails the four turn readings, not the whole collector.
  const got = await collect({ ...base, params: { ...params, session_id_pattern: '(' } });
  for (const id of ['turns_closed', 'sub_sessions_closed', 'subagents_killed', 'parallel_share']) assert.match(pick(got, id).could_not_check, /Invalid regular expression/, id);
  assert.equal(pick(got, 'subagent_start_tokens').value, 30000);
});

test('nothing to judge reads could_not_check, never 0 or 100', async () => {
  const quiet = path.join(tmp, 'quiet-home');
  const q = session('q1', '2026-11-08T08:00:00Z');
  write(path.join(quiet, '.claude', 'projects', '-Users-someone-Developer-acme-site', 'q1.jsonl'), jsonl([q.human(0), q.say(1, 'k1', [['r9', 'Read']])]));
  const got = await collect({ ...base, home: quiet });
  for (const id of ['turns_closed', 'sub_sessions_closed', 'subagents_killed', 'parallel_share', 'subagent_start_tokens']) {
    assert.ok(pick(got, id).could_not_check && !('value' in pick(got, id)), id);
  }
});
