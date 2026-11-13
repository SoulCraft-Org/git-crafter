// node --test quality/collectors/tokens/tokens.test.mjs
// Every input is synthetic and written to a temp folder at run time: project
// folders (the site, a renamed repo under its old name, a folder of another
// owner, one whose checkout is gone and one that moved), the GitHub answers
// and a plan read.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { loadTargets } from '../lib/score.mjs';
import { area, collect, LAST, metricIds, remoteRepo, returnedTokens, scope } from './tokens.mjs';

// Only this collector's targets files, so another collector's file never fails these tests.
function ownTargets(...files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'own-targets-'));
  try {
    for (const f of files) fs.copyFileSync(new URL(`../../targets/${f}`, import.meta.url), path.join(dir, f));
    return loadTargets(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}


const now = new Date('2026-11-03T12:00:00Z');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tokens-collector-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const write = (p, text) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};
const jsonl = (lines) => `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;
const at = (hhmm) => `2026-11-02T${hhmm}:00Z`;
// billable millions: input 0.1, output 0.4, cache write 0.5 per million; cache read 9 per million.
const msg = (session, cwd, id, hhmm, millions) => ({
  type: 'assistant', timestamp: at(hhmm), sessionId: session, cwd,
  message: { id, usage: { input_tokens: 1e5 * millions, output_tokens: 4e5 * millions, cache_creation_input_tokens: 5e5 * millions, cache_read_input_tokens: 9e6 * millions } },
});
const link = (session, hhmm, repo, number) => ({ type: 'pr-link', timestamp: at(hhmm), sessionId: session, prRepository: repo, prNumber: number });
// Active time: three quarters model, one quarter tools; the session sat open three times as long.
const cost = (session, hours) => ({ type: 'cost-state', sessionId: session, totalAPIDuration: hours * 0.75 * 36e5, totalToolDuration: hours * 0.25 * 36e5, totalDuration: hours * 3 * 36e5 });
// A subagent reply: output tokens only, what it hands back when it is the last.
const subMsg = (id, hhmm, output) => ({ type: 'assistant', timestamp: at(hhmm), sessionId: 's1', isSidechain: true, cwd: '/w/site', message: { id, usage: { input_tokens: 0, output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } });

const projectsDir = path.join(tmp, 'projects');
const SITE = path.join(projectsDir, '-Users-someone-Developer-acme-site');
write(path.join(SITE, 's1.jsonl'), jsonl([
  msg('s1', '/w/site', 'm1', '10:00', 1), link('s1', '10:05', 'acme/site', 7), link('s1', '10:06', 'acme/site', 8),
  msg('s1', '/w/site', 'm2', '12:30', 2), msg('s1', '/w/site', 'm2', '12:30', 2), msg('s1', '/w/site', 'm3', '14:00', 1), cost('s1', 2),
]));
// Two subagents of s1: a review that hands back 1,000 tokens (its last reply), and a fix that hands back 200.
write(path.join(SITE, 's1', 'subagents', 'agent-q1.jsonl'), jsonl([subMsg('q1a', '10:30', 500), subMsg('q1b', '10:35', 1000), subMsg('q1b', '10:35', 1000)]));
write(path.join(SITE, 's1', 'subagents', 'agent-q2.jsonl'), jsonl([subMsg('q2a', '10:50', 200)]));
write(path.join(projectsDir, '-Users-someone-Developer-Old-Tools', 'c1.jsonl'), jsonl([msg('c1', '/w/old-tools', 'm4', '11:00', 1), link('c1', '11:05', 'acme/Old-Tools', 3), cost('c1', 1)]));
write(path.join(projectsDir, '-Users-someone-Email', 'e1.jsonl'), jsonl([msg('e1', '/w/email', 'm5', '11:00', 50), cost('e1', 1)]));
write(path.join(projectsDir, '-Users-someone-Gone', 'g1.jsonl'), jsonl([msg('g1', '/w/gone/.claude/worktrees/x', 'm6', '11:00', 50)]));
// A listed repo whose checkout moved: git cannot answer, so the folder name decides.
write(path.join(projectsDir, '-Users-someone-Developer-Moved-App', 'p1.jsonl'), jsonl([msg('p1', '/w/moved', 'm7', '11:00', 1), cost('p1', 1)]));

const root = path.join(tmp, 'repo');
write(path.join(root, 'quality', 'data', 'plan-usage.json'), JSON.stringify({ read_at: '2026-11-03T11:00:00Z', windows: [{ label: 'Weekly · all models', percentUsed: 82, resetsAt: '2026-11-05T11:00:00Z' }] }));

const REMOTES = { '/w/site': 'https://github.com/acme/site.git\n', '/w/old-tools': 'git@github.com:acme/Old-Tools.git\n', '/w/email': 'https://github.com/someone/email\n' };
const PRS = {
  site: {
    p7: { state: 'MERGED', createdAt: at('10:05'), mergedAt: at('13:00'), headRefOid: 'bbb', reviews: { nodes: [{ author: { login: 'lead-reviewer' }, submittedAt: at('12:00'), commit: { oid: 'aaa' } }] } },
    p8: { state: 'CLOSED', createdAt: at('10:06'), mergedAt: null, headRefOid: 'ccc', reviews: { nodes: [] } },
  },
  'Old-Tools': { p3: { state: 'MERGED', createdAt: at('11:05'), mergedAt: at('11:30'), headRefOid: 'ddd', reviews: { nodes: [] } } },
};
function fakeExec(calls = []) {
  return async (cmd, args) => {
    calls.push(`${cmd} ${args.slice(0, 3).join(' ')}`);
    if (cmd === 'git') {
      if (REMOTES[args[1]]) return REMOTES[args[1]];
      throw new Error('not a git repository');
    }
    const [, name] = /name: "([^"]+)"/.exec(args[3]);
    return JSON.stringify({ data: { repository: PRS[name] } });
  };
}
// The account's repos, as its quality/targets/tokens.json would name them.
const params = { owners: ['acme'], alias: { 'old-tools': 'tools' }, folder_repos: [['Moved-App', 'moved-app']], plan_file: 'quality/data/plan-usage.json' };
const base = { root, mode: 'local', projectsDir, now, params, reviewer: 'lead-reviewer' };

test('returnedTokens: a reply hands back its text at 4 characters a token, never its thinking; no text falls back to output_tokens', () => {
  const usage = { output_tokens: 900 };
  const content = [{ type: 'thinking', thinking: 'x'.repeat(2000) }, { type: 'text', text: 'a'.repeat(401) }, { type: 'text', text: 'b'.repeat(399) }];
  assert.equal(returnedTokens({ content, usage }), 200);
  assert.equal(returnedTokens({ content: [{ type: 'tool_use', name: 'Read' }], usage }), 900);
  assert.equal(returnedTokens({ usage }), 900);
});

test('targets: the Tokens tab holds the token metrics, and every goal names its source', () => {
  const defs = ownTargets('tokens.json', 'claude.json');
  assert.equal(area, 'tokens');
  assert.deepEqual(defs.filter((d) => d.file === 'tokens.json').map((d) => d.id), metricIds);
  const onTab = defs.filter((d) => d.tab === 'tokens').map((d) => d.id);
  for (const id of [
    'claude.tokens_per_merged_pr',
    'claude.cache_read_share',
    'claude.compactions_per_10_prs',
    ...metricIds.filter((id) => id !== 'tokens.review_fix_rounds_per_pr'),
  ]) assert.ok(onTab.includes(id), id);
  // The tab scores all three categories (the engine's rule).
  for (const kind of ['quality', 'speed', 'consumption']) assert.ok(defs.some((d) => d.tab === 'tokens' && d.kind === kind), kind);
  assert.equal(defs.find((d) => d.id === 'tokens.review_fix_rounds_per_pr').tab, 'claude', 'review-fix rounds are Claude consumption');
  for (const d of defs.filter((x) => x.file === 'tokens.json')) {
    assert.match(d.goal_source, /^(goal from |template goal, no public benchmark: )/, d.id);
    assert.notEqual(d.chart, 'spark', d.id);
  }
});

test('remoteRepo reads both URL forms and names a renamed repo by its current name', () => {
  assert.deepEqual(remoteRepo('git@github.com:acme/Old-Tools.git', { 'old-tools': 'tools' }), { owner: 'acme', name: 'tools' });
  assert.deepEqual(remoteRepo('https://github.com/someone/notes'), { owner: 'someone', name: 'notes' });
  assert.equal(remoteRepo('/local/path'), null);
});


test('a plan read stamped after the run is refused', async () => {
  const early = await collect({ ...base, now: new Date('2026-11-03T10:00:00Z'), exec: fakeExec() });
  assert.match(early['tokens.plan_used'].could_not_check, /read after this run started/);
});


test('the plan reads as the state the app reports: percent used now, no pace', async () => {
  const got = await collect({ ...base, exec: fakeExec() });
  const plan = got['tokens.plan_used'];
  assert.equal(plan.value, 82);
  assert.deepEqual(plan.detail.map((d) => [d.label, d.unit]), [['used now', '%'], ['days until it resets', 'days']]);
  assert.match(plan.source, /^state: /);
  assert.doesNotMatch(plan.source, /week gone|pace/);
  assert.ok(!metricIds.includes('tokens.plan_week_use'), 'the pace ratio is gone');
});

test('collect: tokens, PRs, waste, rework, pace and the repo split, other folders left out', async () => {
  const calls = [];
  const got = await collect({ ...base, exec: fakeExec(calls) });
  assert.deepEqual(Object.keys(got), metricIds);
  const v = Object.fromEntries(Object.entries(got).map(([id, e]) => [id.replace('tokens.', ''), e.value ?? e.could_not_check]));
  assert.deepEqual(v, {
    latest_pr_rework_tokens: 2_000_000, // PR 7, the newest merged (13:00): m2 after its review found something; the old mean over 2 PRs was 1,000,000
    waste_share: 40, // s1's 4M split half to its closed PR 8, of 5M
    plan_used: 82, // the app's percent used now
    latest_subagent_return_tokens: 200, // q2 finished last (10:50); q1's 1,000 is older; the old median was 600
    review_fix_rounds_per_pr: 0.5, // PR 7's review found something; PR 3's had none
  });
  // The moved app spent tokens but merged nothing: no PR to divide by, so not measured, never 0.
  assert.deepEqual(got['tokens.latest_pr_rework_tokens'].by_repo, { site: 2_000_000, tools: 0, 'moved-app': null }, "each repo's newest merged PR: 7 for the site, 3 for tools");
  assert.deepEqual(got['tokens.waste_share'].by_repo, { site: 50, tools: 0, 'moved-app': null }, 'no finished PR is not measured, never 0');
  // s1's 4M plus its subagents' 1,700 output tokens.
  const site = got['tokens.latest_pr_rework_tokens'].detail[0];
  assert.deepEqual([site.label, site.value, site.share, site.cache_read_share, site.tokens_per_pr, site.latest_rework, site.per_hour], ['site', 4_001_700, 66.7, 93.8, 4_001_700, 2_000_000, 2_000_850]);
  assert.match(got['tokens.latest_pr_rework_tokens'].source, /; the latest, site#7, merged \d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(got['tokens.latest_subagent_return_tokens'].detail.map((d) => d.value), [200, 1000], 'the newest first, each its own value');
  assert.match(got['tokens.latest_pr_rework_tokens'].source, /2 left out: 1 a repo outside params.owners and params.repos, 1 no git remote/, 'counted by reason, no folder named');
  assert.equal(calls.filter((c) => c.startsWith('gh')).length, 2, 'one GraphQL query per repo');
  // Every source names its N, or says it is a state; none names a calendar window.
  for (const [id, e] of Object.entries(got)) {
    assert.match(e.source, id === 'tokens.plan_used' ? /state/ : /the last \d+ /, id);
    assert.doesNotMatch(e.source, /trailing|\b(7|14|28) days\b/, id);
  }
});


test('last N: only the latest events count', async () => {
  const v = (got, id) => got[id].value ?? got[id].could_not_check;
  // The latest subagent to finish is q2 (10:50), which handed back 200 tokens; q1's 1,000 drop out.
  const results = await collect({ ...base, exec: fakeExec(), last: { ...LAST, results: 1 } });
  assert.equal(v(results, 'tokens.latest_subagent_return_tokens'), 200);
  // The latest merged PR is 7 (13:00), after 3 (11:30): s1's rework.
  const prs = await collect({ ...base, exec: fakeExec(), last: { ...LAST, prs: 1, consumption: 1 } });
  assert.equal(v(prs, 'tokens.latest_pr_rework_tokens'), 2_000_000);
  // The latest opened PR that finished is 3 (11:05), merged: no waste.
  assert.equal(v(prs, 'tokens.waste_share'), 0);
  // The repo table's per-hour column reads each repo's latest costed sessions: the tools repo's c1, 1M tokens in 1 h.
  const sessions = await collect({ ...base, exec: fakeExec(), last: { ...LAST, sessions: 2 } });
  assert.equal(sessions['tokens.latest_pr_rework_tokens'].detail.find((r) => r.label === 'tools').per_hour, 1_000_000);
  // The latest 2 model calls, m2 (12:30) and m3 (14:00), are the site's: its share of them is all.
  const calls = await collect({ ...base, exec: fakeExec(), last: { ...LAST, calls: 2 } });
  const site = calls['tokens.latest_pr_rework_tokens'].detail.find((d) => d.label === 'site');
  assert.deepEqual([site.value, site.share], [3_000_000, 100]);
});

test('collect: missing inputs read as not measured, never as 0', async () => {
  const gone = path.join(tmp, 'gone');
  const none = await collect({ root: gone, mode: 'local', projectsDir: gone, now, exec: fakeExec() });
  for (const id of metricIds) assert.ok(none[id].could_not_check, id);
  const noGh = await collect({ ...base, root: gone, exec: async (cmd, args) => (cmd === 'gh' ? Promise.reject(new Error('gh: not logged in')) : fakeExec()(cmd, args)) });
  assert.match(noGh['tokens.waste_share'].could_not_check, /not logged in/);
  assert.match(noGh['tokens.latest_pr_rework_tokens'].could_not_check, /not logged in/, 'the PR metrics each say why, by their own id');
  assert.match(noGh['tokens.plan_used'].could_not_check, /absent/);
  assert.equal(noGh['tokens.latest_subagent_return_tokens'].value, 200, 'what subagents return needs no GitHub');
  for (const id of metricIds) assert.ok((await collect({ mode: 'ci' }))[id].could_not_check, id);
});

test('the collector holds no repo-specific value: every one is in its targets params', () => {
  const code = fs.readFileSync(new URL('./tokens.mjs', import.meta.url), 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  for (const word of ['/Users/', 'Developer/', 'acme', 'Website']) assert.ok(!code.includes(word), `${word} in the code`);
});


test('scope: with no owners or repos set, this repo alone counts', () => {
  const own = scope({}, 'acme/site');
  assert.ok(own.ours('acme', 'site'));
  assert.ok(!own.ours('acme', 'other'), "another of the owner's repos is not this repo");
  assert.ok(scope({}, '').empty, 'nothing to count');
  assert.ok(scope({ owners: ['acme'] }).ours('acme', 'other'));
});

test('a repo with no owners, repos or GitHub origin reads as not measured', async () => {
  const saved = process.env.GITHUB_REPOSITORY;
  delete process.env.GITHUB_REPOSITORY;
  try {
    const got = await collect({ ...base, params: {}, exec: async () => { throw new Error('not a git repository'); } });
    for (const id of metricIds) assert.match(got[id].could_not_check, /no repo to count/, id);
  } finally {
    if (saved !== undefined) process.env.GITHUB_REPOSITORY = saved;
  }
});

test('prompts, replies and tool results are never read: a reply full of text changes nothing', async () => {
  const dir = path.join(tmp, 'text');
  fs.cpSync(projectsDir, dir, { recursive: true });
  const noisy = { type: 'user', timestamp: at('10:40'), sessionId: 's1', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'y'.repeat(40_000) }] } };
  fs.appendFileSync(path.join(dir, '-Users-someone-Developer-acme-site', 's1.jsonl'), jsonl([noisy, { type: 'user', timestamp: at('10:41'), sessionId: 's1', message: { content: '<task-notification><tool-use-id>a</tool-use-id><result>' + 'r'.repeat(9000) + '</result></task-notification>' } }]));
  const a = await collect({ ...base, exec: fakeExec() });
  const b = await collect({ ...base, projectsDir: dir, exec: fakeExec() });
  assert.deepEqual(b['tokens.latest_subagent_return_tokens'].value, a['tokens.latest_subagent_return_tokens'].value);
});
test('the reviewer comes from blockers.json when the engine passes every file\'s params', async () => {
  // PR 7's only review is lead-reviewer's; with another login named, no round found anything.
  const other = await collect({ ...base, reviewer: undefined, allParams: { 'blockers.json': { reviewer: 'someone-else' } }, exec: fakeExec() });
  assert.equal(other['tokens.review_fix_rounds_per_pr'].value, 0);
  const named = await collect({ ...base, reviewer: undefined, allParams: { 'blockers.json': { reviewer: 'lead-reviewer' } }, exec: fakeExec() });
  assert.equal(named['tokens.review_fix_rounds_per_pr'].value, 0.5);
});

test('the transcript folder is params.projects_dir, and the source names it', async () => {
  const got = await collect({ ...base, projectsDir: undefined, params: { ...params, projects_dir: projectsDir }, exec: fakeExec() });
  assert.equal(got['tokens.latest_subagent_return_tokens'].value, 200);
  assert.ok(got['tokens.latest_subagent_return_tokens'].source.startsWith(`${projectsDir}/*/`), got['tokens.latest_subagent_return_tokens'].source);
});

test('plan_file: empty defaults to plan-usage.json in the data folder the engine passes, else quality/data (#182)', async () => {
  // A repo with its own data folder reads its plan file there.
  const own = path.join(root, 'data', 'own');
  write(path.join(own, 'plan-usage.json'), JSON.stringify({ read_at: '2026-11-03T11:00:00Z', windows: [{ label: 'Weekly · all models', percentUsed: 47, resetsAt: '2026-11-05T11:00:00Z' }] }));
  const mine = await collect({ ...base, exec: fakeExec(), params: { ...params, plan_file: '' }, data: own });
  assert.equal(mine['tokens.plan_used'].value, 47);
  const bare = { ...params, plan_file: '' };
  const def = await collect({ ...base, exec: fakeExec(), params: bare });
  assert.equal(def['tokens.plan_used'].value, 82);
  const moved = await collect({ ...base, exec: fakeExec(), params: bare, data: path.join(root, 'data', 'quality') });
  assert.match(moved['tokens.plan_used'].could_not_check, /data\/quality\/plan-usage\.json: absent/);
});
