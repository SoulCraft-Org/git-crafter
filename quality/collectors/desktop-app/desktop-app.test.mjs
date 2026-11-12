// node --test quality/collectors/desktop-app/desktop-app.test.mjs
// Every input is synthetic and written to a temp folder at run time: a home
// with three session transcripts and one subagent transcript.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { CHARTS, loadTargets } from '../../score.mjs';
import { pluginOfName, serverOf } from './desktop-app-listings.mjs';
import { area, collect, metricIds, PARAMS } from './desktop-app.mjs';

const now = new Date('2026-11-10T12:00:00Z');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-app-collector-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const write = (p, text) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};
const jsonl = (rows) => `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`;

const root = path.join(tmp, 'repo');
const home = path.join(tmp, 'home');
const projects = path.join(home, '.claude', 'projects');
const folder = path.join(projects, '-Users-someone-Developer-acme-site');
const ACCOUNT_A = '11111111-2222-3333-4444-555555555555';
const ACCOUNT_B = '22222222-3333-4444-5555-666666666666';

const t = (min) => new Date(Date.parse('2026-11-10T08:00:00Z') + min * 6e4).toISOString();
const row = (sid, min, entrypoint, rest) => ({ timestamp: t(min), sessionId: sid, entrypoint, ...rest });
const call = (sid, min, name, input = {}, entrypoint = 'claude-desktop') =>
  row(sid, min, entrypoint, { type: 'assistant', message: { id: `${sid}-${min}`, content: [{ type: 'tool_use', id: `u${min}`, name, input }] } });
const attach = (sid, min, attachment, entrypoint = 'claude-desktop') => row(sid, min, entrypoint, { type: 'attachment', attachment });

// The four listings of the newest desktop session, s2, sized so each part is a whole number of tokens.
const SKILLS = `- alpha:do: ${'a'.repeat(100)}\n- theta:idle: ${'b'.repeat(100)}\n- plain: ${'c'.repeat(100)}\n`.padEnd(400, ' ');
const AGENT_LINES = ['- beta:helper: helps'.padEnd(80), '- Explore: searches'.padEnd(80), '- iota:agent: idles'.padEnd(40)];
const BLOCKS = ['## plugin:gamma:srv\nUse the gamma server.'.padEnd(80)];
const TOOLS_1 = ['CronList', 'mcp__ccd_turn__update_plan', 'mcp__plugin_gamma_srv__x', 'mcp__plugin_delta_srv__y', `mcp__${ACCOUNT_A}__read`, `mcp__${ACCOUNT_B}__write`, 'mcp__local-tool__run'];
const TOOLS_2 = ['mcp__straggler__t'];
const bytes = (lines) => lines.reduce((n, l) => n + Buffer.byteLength(l), 0);
const delta = (names, pending, needsAuth, failed) => ({
  type: 'deferred_tools_delta',
  addedNames: names,
  addedLines: names,
  removedNames: [],
  pendingMcpServers: pending,
  needsAuthMcpServers: needsAuth,
  failedMcpServers: failed.map((name) => ({ name, error: 'secret server text', errorCode: 'E' })),
});

// s1, older: a skill of alpha, an agent of beta, the gamma server and account connector A are called.
write(
  path.join(folder, 's1.jsonl'),
  jsonl([
    call('s1', 0, 'Skill', { skill: 'alpha:do' }),
    call('s1', 1, 'Agent', { subagent_type: 'beta:helper', prompt: 'p' }),
    call('s1', 2, 'mcp__plugin_gamma_srv__x'),
    call('s1', 3, `mcp__${ACCOUNT_A}__read`),
  ]),
);
// s2, the newest desktop session: its listings arrive in two rounds.
write(
  path.join(folder, 's2.jsonl'),
  jsonl([
    attach('s2', 60, delta(TOOLS_1, ['a', 'b', 'c', 'ccd_turn', 'visualize'], ['plugin:eps:one', 'plugin:eps:two'], ['plugin:zeta:z'])),
    attach('s2', 60, { type: 'agent_listing_delta', addedTypes: ['beta:helper', 'Explore', 'iota:agent'], addedLines: AGENT_LINES, removedTypes: [], isInitial: true }),
    attach('s2', 60, { type: 'mcp_instructions_delta', addedNames: ['plugin:gamma:srv'], addedBlocks: BLOCKS, removedNames: [] }),
    attach('s2', 60, { type: 'skill_listing', content: SKILLS, names: ['alpha:do', 'theta:idle', 'plain'], skillCount: 3, isInitial: true }),
    call('s2', 61, 'Read', { file_path: 'x' }),
    attach('s2', 62, delta(TOOLS_2, [], ['plugin:eps:one'], ['plugin:zeta:z', 'plugin:eta:e'])),
  ]),
);
// Its subagent calls the delta plugin's server.
write(path.join(folder, 's2', 'subagents', 'agent-1.jsonl'), jsonl([call('s2', 63, 'mcp__plugin_delta_srv__y')]));
// s3, newer still, is a terminal session: not the desktop app's, so nothing of it counts.
write(
  path.join(folder, 's3.jsonl'),
  jsonl([
    attach('s3', 120, { type: 'skill_listing', content: 'x'.repeat(4000), names: ['kappa:one'], skillCount: 1, isInitial: true }, 'cli'),
    call('s3', 121, 'Skill', { skill: 'theta:idle' }, 'cli'),
  ]),
);

const params = { ...PARAMS, project_match: 'acme-site' };
const base = { root, mode: 'local', home, now, params };
// Only this collector's targets file, so another collector's file never fails these tests.
function ownTargets(file) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'own-targets-'));
  try {
    fs.copyFileSync(new URL(`../../targets/${file}`, import.meta.url), path.join(dir, file));
    return loadTargets(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const values = (got) => Object.fromEntries(Object.entries(got).map(([id, e]) => [id, e.value ?? e.could_not_check]));
const labels = (entry) => Object.fromEntries(entry.detail.map((d) => [d.label, d.value]));

test('targets: valid, on the desktop app tab, plain means, a goal basis and N or state in each source', () => {
  const defs = ownTargets('desktop-app.json');
  assert.equal(area, 'desktop_app');
  assert.deepEqual(defs.map((d) => d.id), metricIds);
  for (const d of defs) {
    assert.equal(d.tab, 'desktop-app', d.id);
    assert.ok(d.id.startsWith('desktop_app.'), d.id);
    assert.ok(d.means && d.means.length <= 120 && !/\d/.test(d.means), `${d.id}: means`);
    assert.ok(d.group && CHARTS.has(d.chart), d.id);
    assert.match(d.goal_source, /^(goal from |template goal, no public benchmark: )/, d.id);
    assert.match(d.source, /^state|N = /, `${d.id}: a state or names N`);
    assert.notEqual(d.chart, 'spark', d.id);
    assert.equal(d.needs, 'local-files', d.id);
  }
  for (const kind of ['quality', 'speed', 'consumption']) assert.ok(defs.some((d) => d.kind === kind), `a ${kind} metric`);
  const goal = Object.fromEntries(defs.map((d) => [d.id, [d.goal, d.near]]));
  assert.deepEqual(goal['desktop_app.listing_tokens'], [10000, 20000], "the skills docs' 1% listing budget, and its 2% example");
  for (const id of ['connectors_broken', 'plugins_unused', 'connectors_unused', 'connectors_pending']) assert.equal(goal[`desktop_app.${id}`][0], 0, id);
});

test('names: one server per tool name, one plugin per colon name', () => {
  assert.equal(serverOf('mcp__plugin_gamma_srv__x'), 'plugin_gamma_srv');
  // A double underscore inside the tool's own name starts no second server.
  assert.equal(serverOf('mcp__srv__a__b'), 'srv');
  // A server whose own name holds one still gives one key for all its tools.
  assert.equal(serverOf('mcp__Word__By_Someone___open'), serverOf('mcp__Word__By_Someone___close'));
  for (const builtIn of ['Read', 'mcp__', 'mcp__nameonly']) assert.equal(serverOf(builtIn), null, builtIn);
  assert.equal(pluginOfName('alpha:do'), 'alpha');
  assert.equal(pluginOfName('alpha:helper:AGENT'), 'alpha');
  assert.equal(pluginOfName('plugin:eps:one'), 'eps');
  assert.equal(pluginOfName('plain'), null);
});

test('collect: the listing metrics read the newest desktop session', async () => {
  const got = await collect(base);
  assert.deepEqual(Object.keys(got), metricIds);
  const v = values(got);
  // The last listing's state: one server needs sign-in, two failed.
  assert.equal(v['desktop_app.connectors_broken'], 3);
  assert.deepEqual(labels(got['desktop_app.connectors_broken']), { 'need sign-in': 1, 'failed to connect': 2 });
  // The first listing's state; the app's own servers (ccd_turn, visualize) are not the user's to speed up.
  assert.equal(v['desktop_app.connectors_pending'], 3);
  // Loaded: alpha, theta, beta, iota, eps, zeta, eta, gamma, delta. Called in s1, s2 or its subagent: alpha, beta, gamma, delta.
  assert.equal(v['desktop_app.plugins_unused'], 5);
  assert.deepEqual(got['desktop_app.plugins_unused'].detail.slice(0, 2).map((d) => [d.label, d.value]), [['plugins loaded', 9], ['plugins called', 4]]);
  assert.deepEqual(got['desktop_app.plugins_unused'].detail.slice(2).map((d) => d.label), ['eps', 'eta', 'iota', 'theta', 'zeta']);
  // Connected: gamma, delta, accounts A and B, local-tool, straggler; the app's own ccd_turn is set aside. Called: gamma, delta, A.
  assert.equal(v['desktop_app.connectors_unused'], 3);
  assert.deepEqual(labels(got['desktop_app.connectors_unused']), { 'servers connected': 6, 'servers called': 3, 'plugin servers unused': 0, 'account connectors unused': 1, 'other servers unused': 2 });
  // bytes / 4 of each listing.
  assert.equal(v['desktop_app.listing_tokens'], 100 + 50 + 20 + Math.round(bytes([...TOOLS_1, ...TOOLS_2]) / 4));
  assert.deepEqual(got['desktop_app.listing_tokens'].detail.map((d) => [d.label, d.value]), [
    ['tool names', Math.round(bytes([...TOOLS_1, ...TOOLS_2]) / 4)],
    ['skills', 100],
    ['agents', 50],
    ['server instructions', 20],
  ]);
});

test('collect: a kind of server the owner keeps is set aside from the unused count', async () => {
  const got = await collect({ ...base, params: { ...params, kept_kinds: ['account connectors'] } });
  // Accounts A and B are set aside; gamma and delta were called; local-tool and straggler were not.
  assert.equal(got['desktop_app.connectors_unused'].value, 2);
  assert.deepEqual(labels(got['desktop_app.connectors_unused']), { 'servers connected': 4, 'servers called': 2, 'plugin servers unused': 0, 'account connectors unused': 0, 'other servers unused': 2 });
});

test('collect: the window is the last N desktop sessions', async () => {
  const one = await collect({ ...base, params: { ...params, usage_sessions: 1 } });
  // Only s2 and its subagent: alpha, beta and gamma were called in s1 alone.
  assert.equal(one['desktop_app.plugins_unused'].value, 8);
  assert.equal(one['desktop_app.connectors_unused'].value, 5);
});

test('nothing private leaves the collector', async () => {
  const text = JSON.stringify(await collect(base));
  assert.ok(!text.includes('secret server text'), 'no server error text');
  assert.ok(!text.includes(ACCOUNT_A) && !text.includes(ACCOUNT_B), 'no account connector id');
  assert.ok(!text.includes('local-tool') && !text.includes('straggler'), 'no server name');
  assert.ok(!text.includes(home), 'no home path');
});

test('a missing input reads could_not_check, never 0', async () => {
  for (const id of metricIds) assert.ok((await collect({ mode: 'ci' }))[id].could_not_check, id);
  const gone = path.join(tmp, 'gone');
  const none = await collect({ root: gone, mode: 'local', home: gone, now, params });
  for (const id of metricIds) assert.ok(none[id].could_not_check && !('value' in none[id]), id);
  // Before the first desktop session started there is nothing to read.
  const early = await collect({ ...base, now: new Date('2026-11-01T00:00:00Z') });
  for (const id of metricIds) assert.match(early[id].could_not_check, /no desktop session/, id);
  // A folder with only terminal sessions is not the desktop app's.
  const cli = await collect({ ...base, params: { ...params, entrypoint: 'no-such-app' } });
  for (const id of metricIds) assert.match(cli[id].could_not_check, /no desktop session/, id);
  // A window of zero sessions is a bad param, not zero unused plugins.
  const zero = await collect({ ...base, params: { ...params, usage_sessions: 0 } });
  assert.match(zero['desktop_app.plugins_unused'].could_not_check, /usage_sessions/);
  assert.equal(zero['desktop_app.connectors_broken'].value, 3);
});

test('a desktop session with no listing: the listing metrics are not measured', async () => {
  const bare = path.join(tmp, 'bare-home');
  write(path.join(bare, '.claude', 'projects', '-Users-someone-Developer-acme-site', 'b1.jsonl'), jsonl([call('b1', 0, 'Read')]));
  const got = await collect({ ...base, home: bare });
  for (const id of ['connectors_broken', 'plugins_unused', 'connectors_unused', 'connectors_pending', 'listing_tokens']) assert.match(got[`desktop_app.${id}`].could_not_check, /no listing/, id);
  // The turn metrics need no listing: with no turn a person started they are not measured either.
  for (const id of metricIds) assert.ok(got[id].could_not_check && !('value' in got[id]), id);
});

test('no path literal in the collector: every path comes from params', () => {
  for (const file of fs.readdirSync(new URL('.', import.meta.url)).filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'))) {
    const code = fs
      .readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
      .split('\n')
      .filter((l) => !/^\s*\/\//.test(l) && !/^(import |export \{)/.test(l) && !l.includes('new URL('))
      .join('\n');
    const literals = [...code.matchAll(/'[^'\n]*'|"[^"\n]*"|`[^`\n]*`/g)].map((m) => m[0]);
    const paths = literals.filter((s) => /~\/[\w.]|(^|[\s'"`])\/?[\w.-]+\/[\w.-]+|\.claude\b|Developer|Library/.test(s));
    assert.deepEqual(paths, [], file);
  }
});
