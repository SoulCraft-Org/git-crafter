// node --test quality/collectors/claude/claude-settings.test.mjs
// Every input is synthetic: a repo and a projects folder in temp folders.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { loadTargets } from '../../score.mjs';
import { area, collect, decisions, metricIds, ruleProblem, settingsProblems } from './claude-settings.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-settings-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const write = (p, text) => {
  fs.mkdirSync(path.dirname(path.join(tmp, p)), { recursive: true });
  fs.writeFileSync(path.join(tmp, p), typeof text === 'string' ? text : JSON.stringify(text));
};

test('targets load, every metric is on the tab, ids match the area', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'targets-'));
  fs.copyFileSync(new URL('../../targets/claude-settings.json', import.meta.url), path.join(dir, 'claude-settings.json'));
  const defs = loadTargets(dir);
  assert.deepEqual(defs.map((d) => d.id), metricIds);
  for (const d of defs) {
    assert.equal(d.tab, 'claude-settings');
    assert.ok(d.id.startsWith(`${area}.`));
  }
  assert.deepEqual(defs.map((d) => d.kind).sort(), ['quality', 'speed']);
});

test('ruleProblem: the shapes the permissions docs say are skipped or ignored', () => {
  for (const ok of ['Bash', 'Bash(npm run test *)', 'Bash(ls:*)', 'Read(./.env)', 'Read(~/.ssh/**)', 'WebFetch(domain:*.example.com)', 'mcp__puppeteer', 'mcp__github__get_*', 'mcp__plugin_my-plugin_db-tools__*', 'Agent(isolation:*)']) {
    assert.equal(ruleProblem(ok, 'allow'), null, ok);
  }
  assert.match(ruleProblem('mcp__github__get_issue(owner:x)', 'deny'), /parentheses is skipped/);
  assert.match(ruleProblem('*', 'allow'), /mcp__<server>__ prefix/);
  assert.match(ruleProblem('mcp__*', 'allow'), /mcp__<server>__ prefix/);
  assert.equal(ruleProblem('mcp__*', 'deny'), null, 'deny accepts a bare glob');
  assert.match(ruleProblem('Bash(command:rm *)', 'deny'), /is ignored/);
  assert.match(ruleProblem('Bash(git:* push)', 'allow'), /only at the end/);
  assert.match(ruleProblem('Stop Task', 'deny'), /not Tool/);
  assert.match(ruleProblem('', 'allow'), /not a rule/);
});

test('settingsProblems: unknown keys, modes a project file cannot set, bad lists', () => {
  assert.deepEqual(settingsProblems({ $schema: 'x', permissions: { deny: ['Read(./.env)'] } }), []);
  const got = settingsProblems({ modle: 'x', permissions: { defaultMode: 'bypassPermissions', allow: 'Bash', denny: [] } });
  assert.deepEqual(got.map((p) => p.where), ['modle', 'permissions.denny', 'permissions.defaultMode', 'permissions.allow']);
  assert.match(got[2].problem, /no effect from a project file/);
  assert.match(settingsProblems({ permissions: { defaultMode: 'yolo' } })[0].problem, /unknown mode/);
  assert.deepEqual(settingsProblems({ newKey: 1 }, ['newKey']), [], 'extra_keys admits a key newer than the index');
  assert.match(settingsProblems([])[0].problem, /not a JSON object/);
});

test('decisions: a prompt is a user source; asking tools and config decisions are not', () => {
  const lines = [
    { message: { content: [{ type: 'tool_use', id: 'a', name: 'Bash' }, { type: 'tool_use', id: 'b', name: 'ExitPlanMode' }, { type: 'tool_use', id: 'c', name: 'Read' }] } },
    { timestamp: '2026-11-04T10:00:00Z', message: { content: [{ type: 'tool_result', tool_use_id: 'a' }] }, permissionDecision: { decision: 'accept', source: 'user_temporary', reasonCode: 'bashMiss:cd-compound-read' } },
    { timestamp: '2026-11-04T10:01:00Z', message: { content: [{ type: 'tool_result', tool_use_id: 'b' }] }, permissionDecision: { decision: 'accept', source: 'user_temporary', reasonCode: 'mode:plan' } },
    { timestamp: '2026-11-04T10:02:00Z', message: { content: [{ type: 'tool_result', tool_use_id: 'c' }] }, permissionDecision: { decision: 'accept', source: 'config', reasonType: 'mode' } },
  ].map((r) => JSON.stringify(r));
  const got = decisions([...lines, 'not json "tool_use"'].join('\n'));
  assert.deepEqual(got.map((d) => [d.tool, d.prompt, d.reason]), [['Bash', true, 'bashMiss:cd-compound-read'], ['ExitPlanMode', false, 'mode:plan'], ['Read', false, 'mode']]);
});

test('collect: valid counts each problem; prompts read local transcripts only', async () => {
  const root = path.join(tmp, 'repo');
  write('repo/.claude/settings.json', { permissions: { allow: ['Bash(git:* push)'], deny: ['Read(./.env)'] } });
  const projects = path.join(tmp, 'projects');
  const rec = (i, source) => [
    JSON.stringify({ message: { content: [{ type: 'tool_use', id: `t${i}`, name: 'Bash' }] } }),
    JSON.stringify({ timestamp: new Date(Date.UTC(2026, 10, 4, 10, i)).toISOString(), message: { content: [{ type: 'tool_result', tool_use_id: `t${i}` }] }, permissionDecision: { decision: 'accept', source, reasonCode: 'bashMiss:cd-compound-read' } }),
  ];
  const lines = Array.from({ length: 50 }, (_, i) => rec(i, i === 7 ? 'user_permanent' : 'config')).flat();
  write('projects/-x-myrepo/s1.jsonl', lines.join('\n'));
  write('projects/-x-other/s2.jsonl', rec(1, 'user_temporary').join('\n'));
  const now = new Date('2026-11-05T00:00:00Z');
  const params = { project_match: 'myrepo' };

  const local = await collect({ root, mode: 'local', params, projectsDir: projects, now });
  assert.equal(local['claude_settings.valid'].value, 1);
  assert.match(local['claude_settings.valid'].detail[0].label, /\.claude\/settings\.json permissions\.allow: Bash\(git:\* push\)/);
  assert.equal(local['claude_settings.prompts_per_100_calls'].value, 2, '1 prompt in 50 calls; the other project is not read');
  assert.deepEqual(local['claude_settings.prompts_per_100_calls'].detail.map((d) => [d.label, d.value]), [['bashMiss:cd-compound-read', 1], ['tool calls read', 50]]);

  const ci = await collect({ root, mode: 'ci', params, projectsDir: projects, now });
  assert.equal(ci['claude_settings.valid'].value, 1, 'settings are read in CI too');
  assert.match(ci['claude_settings.prompts_per_100_calls'].could_not_check, /transcripts live on the machine/);

  write('repo/.claude/settings.json', '{ "permissions": { }, }');
  const broken = await collect({ root, mode: 'local', params: { project_match: 'nothing-here' }, projectsDir: projects, now });
  assert.match(broken['claude_settings.valid'].detail[0].label, /does not parse/);
  assert.match(broken['claude_settings.prompts_per_100_calls'].could_not_check, /no tool result/, 'no transcript: not measured, never 0');

  const empty = await collect({ root: path.join(tmp, 'bare'), mode: 'ci', now });
  assert.equal(empty['claude_settings.valid'].value, 0);
  assert.match(empty['claude_settings.valid'].source, /no settings file/);
});
