// Tests for the Blockers collector: metrics, the ledger, missing inputs and the walk.
// The held-or-false-alarm cases are in blockers-replay.test.mjs; shared inputs in blockers-fixtures.mjs.
// node --test quality/collectors/blockers/blockers.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { CHARTS } from '../lib/score.mjs';
import { causes, prRefs } from '../github/github.mjs';
import { area, classifyBlock, collect, config, ENFORCEMENT, gitKind, metricIds, pushes, reviewRounds, similar, verdict, words } from './blockers.mjs';
import { managedClaudeMd } from '../claude/claude.mjs';
import { ownTargets, now, tmp, write, jsonl, projectsDir, site, at, usage, bash, asst, result, guardText, WARN, root, home, managedPath, guardLog, checkout, run, commit, review, PRS, fakeGh, targets, params, base } from "./blockers-fixtures.mjs";
test('targets: valid, on the Blockers tab, every one with means, group and a goal', () => {
  const defs = ownTargets('blockers.json').filter((d) => d.file === 'blockers.json');
  assert.equal(area, 'blockers');
  assert.deepEqual(defs.map((d) => d.id), metricIds);
  assert.ok(CHARTS.has('ledger'));
  for (const d of defs) {
    // Hook output is an instruction cost, so it sits on the Instructions tab.
    assert.equal(d.tab, d.id === 'blockers.hook_tokens_per_session' ? 'claude-settings' : 'blockers', d.id);
    assert.ok(['Quality', 'Speed', 'Tokens', 'Simplicity and drift', 'What tokens buy', 'Use', 'Hooks'].includes(d.group), d.id);
    assert.ok(d.means && !/\d/.test(d.means), `${d.id}: means holds no figures`);
    assert.match(d.goal_source, /^(goal from |template goal, no public benchmark: )/, `${d.id}: a public source or a template default`);
  }
});

test('words and similar: a trimmed retry matches, a push to another ref does not', () => {
  assert.deepEqual([...words('cd "/a b" && cat site/a.mjs; git grep -n lastmod -- site/src | head -5')], ['site/a.mjs', 'lastmod', 'site/src']);
  assert.ok(similar(words('cat site/a.mjs; git grep -n lastmod -- site/src'), words('cat site/a.mjs')));
  assert.ok(!similar(words('git push origin main'), words('git push origin HEAD:refs/heads/feature')));
  assert.ok(!similar(words('ls'), words('ls -la')), 'no arguments, nothing to match');
});

test('classifyBlock names the guard rule, the hook or check, and the git gate', () => {
  assert.deepEqual(classifyBlock(guardText('a, b')), { kind: 'guard', rules: ['a', 'b'], fixNamed: false });
  assert.deepEqual(classifyBlock(guardText('c').replace('Git Crafter', 'Claude-OS')), { kind: 'guard', rules: ['c'], fixNamed: false }, 'the name before the rename');
  assert.deepEqual(classifyBlock(guardText('c').replace('Git Crafter', 'Code-OS')), { kind: 'guard', rules: ['c'], fixNamed: false }, 'the name from 2026-11-02 to 2026-11-11');
  assert.equal(classifyBlock(`${guardText('d')} Fix: push your branch by name.`).fixNamed, true, 'the message names its fix');
  assert.equal(classifyBlock('PreToolUse:Write hook error: [python3 -I /x/write_guard.py]: no').label, 'write guard');
  assert.equal(classifyBlock('PreToolUse:Edit hook error: This session is running in an isolated git worktree at x').label, 'app: edit outside the worktree');
  assert.equal(classifyBlock('Permission for this command was denied by a built-in Claude Code safety check, not by the user.').label, 'built-in safety check');
  assert.equal(classifyBlock('BLOCKED [not-head]: x', { git: 'push' }).label, 'pre-push');
  assert.equal(classifyBlock('BLOCKED [secret]', { git: 'both' }).label, 'pre-commit');
  assert.equal(classifyBlock('BLOCKED [secret]', {}), null, 'only a git call has git gates');
  assert.equal(classifyBlock('Exit code 1\nnot found'), null);
});

test('gitKind finds git commit and push after cd, VAR=value, time and -C', () => {
  assert.equal(gitKind('cd "/a b" && git -C "/a b" commit -m x'), 'commit');
  assert.equal(gitKind('PATH="/x y:/bin" git -C clone push bare main'), 'push');
  assert.equal(gitKind('time git push origin HEAD'), 'push');
  assert.equal(gitKind('git add . && git commit -m x && git push'), 'both');
  assert.equal(gitKind('grep -n "git push" .githooks/pre-push'), null);
  assert.equal(gitKind('echo git commit'), null);
});

test('verdict: false alarms decide when measured, else any cost counts against it', () => {
  assert.equal(verdict({ fires: 4, false_alarm: 25 }), 'helps');
  assert.equal(verdict({ fires: 4, false_alarm: 50 }), 'costs');
  assert.equal(verdict({ fires: 4, false_alarm: null, tokens: 10 }), 'not-measured', 'a cost with no catch measure is not a verdict');
  assert.equal(verdict({ fires: 4, false_alarm: null, hours: 0, tokens: null }), 'not-measured');
  assert.equal(verdict({ fires: null, false_alarm: 0 }), 'not-measured');
});

test('reviewRounds and pushes read rounds, waits and flaky checks', () => {
  assert.deepEqual(reviewRounds(PRS[0]).map((r) => r.kind), ['found', 'confirm'], 'one round per commit, the post-merge review left out');
  assert.deepEqual(reviewRounds(PRS[1]).map((r) => r.kind), ['clean']);
  const [a, b] = pushes(PRS[0]);
  assert.deepEqual({ wait: a.waitMin, red: a.red, flaky: a.flaky }, { wait: 6, red: 1, flaky: 1 });
  assert.deepEqual({ wait: b.waitMin.toFixed(3), red: b.red }, { wait: '0.417', red: 0 });
});

test('collect: every metric from synthetic transcripts, the guard log and GitHub', async () => {
  const calls = [];
  const got = await collect({ ...base, gh: fakeGh(calls) });
  assert.deepEqual(Object.keys(got), metricIds, 'every id, in the targets order');
  assert.equal(calls.filter((c) => c.startsWith('api')).length, 2, 'fewer than 21 merged PRs: every page');
  assert.equal(calls.length, 4, 'plus one revert search and one bug list');
  assert.match(calls.find((c) => c.startsWith('issue')), /created:>=2026-10-01/, 'bugs since the oldest of the last 20 merges');
  assert.match(calls.find((c) => c.startsWith('issue')), /--type Bug/, 'bugs by the Bug issue type, never the bug label');
  assert.doesNotMatch(calls.find((c) => c.startsWith('issue')), /--label/);
  assert.match(calls[0], /filterBy: \{checkType: ALL\}/, 'reruns are read');
  const v = Object.fromEntries(Object.entries(got).map(([id, e]) => [id.replace('blockers.', ''), e.value ?? e.could_not_check]));
  assert.deepEqual(v, {
    costly: 3, // guard credential-file-read, pinned review and CI checks, each at 50% false alarms
    guard_false_alarm_share: 50, // t1's retry t2 reads the same file another way, without the fix (ls, test -e or stat): a false alarm; t3 was not retried
    enforcement_reverts: 2, // PR 7 (a workflow) reverted by PR 20; PR 8 (a hook) blamed by bug 31, not by 32 or 33
    guard_blocks_per_100_calls: 42.857, // 3 log blocks at or after t1, over the 7 tool calls; the Oct 25 one and the other repo's left out
    latest_block_seconds: 60, // t5, the latest block, 60 s to t6 (t1 and t3 took 60 and 120: no mean)
    git_commit_seconds: 12,
    git_push_seconds: 16.5, // 3 and 30
    pushes_per_merged_pr: 1.5,
    latest_block_tokens: 6000, // m6 answered t5, the latest block; the other project's block left out
    hook_tokens_per_session: 100 * 6 + Math.ceil(WARN.length / 4) * 2, // s1, its one session: reads stop at the compaction
    review_tokens_per_pr: 16_667, // the review subagent's 50,000 over the 3 merged PRs
  });
  assert.deepEqual(got['blockers.guard_blocks_per_100_calls'].detail.map((d) => [d.label, d.value]), [['credential-file-read', 28.571], ['git-push-main', 14.286]]);
  assert.deepEqual(got['blockers.review_tokens_per_pr'].detail.find((d) => d.label === '#7'), { label: '#7', value: 50_000, unit: 'tokens' }, 'its Agent call names PR #7');
  assert.deepEqual(got['blockers.latest_block_seconds'].detail.map((d) => [d.label, d.value]), [['guard: credential-file-read', 120], ['pre-push', 60]], 't3 for the guard, not the 90 s mean of t1 and t3; t5 for the hook');
  assert.match(got['blockers.hook_tokens_per_session'].source, /mean over the last 5 main sessions by start, each with its subagents; 1 read/);
  assert.match(got['blockers.guard_blocks_per_100_calls'].source, /the last 7 tool calls \(1000 wanted\), 2026-11-02 10:00 to 2026-11-02 10:06 UTC/);
});

test('collect: the ledger has one row per blocker, grouped, with a verdict each', async () => {
  const rows = (await collect({ ...base, gh: fakeGh() }))['blockers.costly'].detail;
  const by = Object.fromEntries(rows.map((r) => [r.label, r]));
  assert.deepEqual([...new Set(rows.map((r) => r.group))], ['Quality', 'Speed', 'Tokens']);
  assert.deepEqual(by['guard: credential-file-read'], { label: 'guard: credential-file-read', group: 'Speed', fires: 2, false_alarm: 50, hours: 0.05, tokens: 6000, value: 6000, verdict: 'costs' });
  assert.deepEqual([by['guard: git-push-main'].fires, by['guard: git-push-main'].verdict], [1, 'not-measured'], 'in the log, never in a transcript: no outcome, no cost');
  assert.deepEqual([by['git pre-push hook'].false_alarm, by['git pre-push hook'].verdict], [0, 'helps']);
  assert.equal(by['app: task list in a subagent'].verdict, 'helps', 'the subagent did not call it again');
  assert.deepEqual([by['pinned review'].fires, by['pinned review'].hours, by['pinned review'].verdict], [3, 2.33, 'costs'], 'rounds of the last 20 merged PRs, not halved');
  assert.deepEqual([by['CI checks'].fires, by['CI checks'].false_alarm, by['CI checks'].tokens], [3, 50, null]);
  assert.deepEqual(
    rows.filter((r) => r.group === 'Tokens').map((r) => [r.label, r.tokens]),
    [['rules/a.md', 2100], ['managed CLAUDE.md', 1400], ['repo CLAUDE.md', 700], ['session start hooks', 600], ['memory index', 70]],
    'instruction files times the 7 main-session calls in the span; no instruction metric of its own',
  );
  assert.match((await collect({ ...base, gh: fakeGh() }))['blockers.costly'].source, /summed over the last 7 tool calls.*last 20 merged PRs/);
});

test('collect: missing inputs read as not measured, never as 0', async () => {
  const gone = path.join(tmp, 'gone');
  const got = await collect({ root: gone, mode: 'local', projectsDir: gone, home: gone, guardLog: path.join(gone, 'log'), managedPath: gone, now, params: { repo: 'acme/site' }, gh: async () => Promise.reject(new Error('gh: not logged in')) });
  for (const id of metricIds) assert.ok(got[id].could_not_check, `${id} is not measured`);
  assert.match(got['blockers.pushes_per_merged_pr'].could_not_check, /not logged in/);
  const ci = await collect({ mode: 'ci' });
  for (const id of metricIds) assert.ok(ci[id].could_not_check && ci[id].value === undefined, id);
});

test('the collector holds no repo-specific value: every one is in its targets params', () => {
  const code = fs.readFileSync(new URL('./blockers.mjs', import.meta.url), 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  for (const word of ['/Users/', 'Developer/', 'acme', 'Website']) assert.ok(!code.includes(word), `${word} in the code`);
});

test('the revert breaker: which paths enforce, which numbers are PRs, which bugs blame one', () => {
  const enforced = (p) => ENFORCEMENT.some((re) => re.test(p));
  assert.ok(['.github/workflows/ci.yml', '.githooks/pre-push', '.claude/hooks/x.sh', 'tools/bash_guard.py', '.claude/settings.json', 'bash_guard_rules.json'].every(enforced));
  assert.ok(!enforced('scripts/canvas/lib/replace-guard.mjs'), 'a file merely named guard is not a guard');
  for (const p of ['tools/verify.sh', 'manifest.json', '.github/cloud-test.json', 'tools/protected_clauses.json']) assert.ok(enforced(p), `${p}: a verify script, manifest or protected rule text the breaker counts`);
  assert.ok(!enforced('README.md'), 'a doc is not enforcement');
  assert.deepEqual([...prRefs('See #12, org/repo#13 and /pull/14; not &#15; or a#16')], [12, 13, 14]);
  assert.deepEqual([...causes('Regressed-by: #7\nThis was introduced in PR #9, and #10 is context.')], [7, 9]);
  assert.equal(causes('Found in the review of #343. None is a regression; each existed before.').size, 0, 'a review finding names a PR without blaming it');
  assert.equal(causes('PR #106 passes DCO with a verified commit, the way #103 became #106.').size, 0, 'a PR named as an example is not a cause');
});

test('collect: blocks refused together share the one call that answered them', async () => {
  const dir = path.join(tmp, 'parallel');
  write(
    path.join(dir, '-Users-someone-Developer-acme-site', 'p1.jsonl'),
    jsonl([
      asst(0.5, 'p1', 1000, [bash('a', 'cat ~/.env'), bash('b', 'cat ~/.env.local')]),
      result(0.6, 'a', guardText('credential-file-read'), true),
      result(0.6, 'b', guardText('credential-file-read'), true),
      asst(1, 'p2', 8000),
    ]),
  );
  const got = await collect({ ...base, projectsDir: dir, gh: fakeGh() });
  assert.equal(got['blockers.latest_block_tokens'].value, 4000, "p2's 8,000 once, a share for each of its 2 blocks; not 8,000 a block");
  assert.match(got['blockers.latest_block_tokens'].source, /; 0 of them new tokens/, 'the fixture holds only cache reads');
});

test('targets: no calendar window, no spark, and every source names its N', () => {
  const defs = ownTargets('blockers.json').filter((d) => d.file === 'blockers.json');
  for (const d of defs) {
    assert.notEqual(d.chart, 'spark', d.id);
    assert.ok(!/trailing|a week\b|\d+ days\b(?! to)/.test(`${d.label} ${d.means}`), `${d.id}: no window in its label or means`);
    assert.ok(!/trailing \d+ days|, halved/.test(d.source), `${d.id}: no window in its source`);
    assert.match(d.source, /N = |state/, `${d.id}: source names N and why`);
  }
});

test('the walk: last 20 merged PRs by merge time, stopping at the page before them', async () => {
  const hour = (h) => new Date(Date.parse('2026-11-03T00:00:00Z') + h * 36e5).toISOString();
  // 22 merges an hour apart, newest update first, and more pages that must not be read.
  const nodes = Array.from({ length: 22 }, (_, i) => {
    const h = 22 - i;
    return { number: 100 + h, createdAt: hour(h - 0.5), mergedAt: hour(h), updatedAt: hour(h), headRefOid: `h${h}`, reviews: { nodes: [] }, commits: { nodes: [commit(`h${h}`, '3T00:00:00', [run('lint', '3T00:00:10', '3T00:00:20', 'SUCCESS')])] } };
  });
  const calls = [];
  const gh = async (args) => {
    calls.push(args.join(' '));
    if (args[0] !== 'api') return '[]';
    return JSON.stringify({ data: { repository: { pullRequests: { pageInfo: { hasNextPage: true, endCursor: 'c1' }, nodes } } } });
  };
  const got = await collect({ ...base, now: new Date(hour(30)), gh });
  assert.equal(calls.filter((c) => c.startsWith('api')).length, 1, 'the page ends before the 21st newest merge');
  assert.equal(got['blockers.pushes_per_merged_pr'].detail[0].value, 20, '20 PRs of one push each, not 22');
  assert.match(got['blockers.pushes_per_merged_pr'].source, /20 read, merged 2026-11-03 03:00 to 2026-11-03 22:00 UTC/);
  assert.match(calls.find((c) => c.startsWith('issue')), /created:>=2026-11-03/);
});

test('hook output per session: the newest 5 main sessions, each with its subagents', async () => {
  const dir = path.join(tmp, 'sessions');
  const folder = path.join(dir, '-Users-someone-Developer-acme-site');
  // Seven sessions an hour apart, each a 40-character start hook read by 2 calls (20 tokens);
  // the newest one's subagent adds a 400-character hook read once (100 tokens).
  for (let i = 0; i < 7; i += 1) {
    const sid = `h${i}`;
    const m = (min, id) => ({ type: 'assistant', timestamp: at(i * 60 + min), sessionId: sid, message: { id: `${sid}${id}`, usage: usage(10), content: [] } });
    write(path.join(folder, `${sid}.jsonl`), jsonl([{ type: 'attachment', timestamp: at(i * 60), sessionId: sid, attachment: { type: 'hook_success', hookName: 'SessionStart:startup', content: 'x'.repeat(i === 0 ? 4000 : 40) } }, m(1, 'a'), m(2, 'b')]));
  }
  write(path.join(folder, 'h6', 'subagents', 'agent-x.jsonl'), jsonl([{ type: 'attachment', timestamp: at(361), sessionId: 'h6', isSidechain: true, attachment: { type: 'hook_success', hookName: 'PreToolUse:Bash', content: 'x'.repeat(400) } }, { type: 'assistant', timestamp: at(362), sessionId: 'h6', isSidechain: true, message: { id: 'x1', usage: usage(10), content: [] } }]));
  const got = await collect({ ...base, projectsDir: dir, now: new Date(at(600)), gh: fakeGh() });
  // h2 to h6: 5 x 20 + 100 = 200 over 5; h0's large hook is older than the newest 5.
  assert.equal(got['blockers.hook_tokens_per_session'].value, 40);
  const none = await collect({ ...base, projectsDir: dir, now: new Date(at(-10)), gh: fakeGh() });
  assert.match(none['blockers.hook_tokens_per_session'].could_not_check, /no main session/, 'before any session: not measured, never 0');
});

test('last N: the newest 15 guard blocks, the newest 20 commits, the newest 1,000 calls', async () => {
  const dir = path.join(tmp, 'many');
  const lines = [];
  // 1,045 calls a minute apart: 20 guard blocks first (each followed by its retry), then commits.
  for (let i = 0; i < 1045; i += 1) {
    const id = `c${i}`;
    if (i < 40 && i % 2 === 0) {
      lines.push(asst(i, `m${i}`, 10, [bash(id, `cat secret/file${i}.txt`)]), result(i + 0.1, id, guardText('credential-file-read'), true));
    } else if (i < 40) {
      // The retry of the first 5 blocks runs; the later 15 are never retried.
      const retry = i < 10;
      lines.push(asst(i, `m${i}`, 10, [bash(id, retry ? `cat secret/file${i - 1}.txt` : 'ls')]), result(i + 0.1, id, 'ok'));
    } else {
      lines.push(asst(i, `m${i}`, 10, [bash(id, 'git commit -m x')]), result(i + (i >= 1025 ? 0.5 : 0.1), id, 'done'));
    }
  }
  write(path.join(dir, '-Users-someone-Developer-acme-site', 'many.jsonl'), jsonl(lines));
  const got = await collect({ ...base, projectsDir: dir, now: new Date(at(2000)), gh: fakeGh() });
  assert.equal(got['blockers.guard_false_alarm_share'].value, 0, 'the last 15 blocks held; the 5 false alarms before them are older');
  assert.equal(got['blockers.git_commit_seconds'].value, 30, 'the newest 20 commits took 30 s; the 985 before them 6 s');
  assert.match(got['blockers.latest_block_seconds'].could_not_check, /no block among the last 1000 tool calls \(1000 wanted\)/, 'every block is older than the newest 1,000 calls');
});

test('config: each default names no repo, path or person', () => {
  const cfg = config({}, '/Users/someone/Developer/acme site/.claude/worktrees/fix-1');
  assert.equal(cfg.match, '-Users-someone-Developer-acme-site');
  assert.equal(cfg.checkout, '/Users/someone/Developer/acme site', 'the main checkout, so every worktree counts');
  assert.equal(cfg.guardLog, '~/.claude/code-os/bash_guard.log');
  assert.equal(cfg.managed, managedClaudeMd());
  assert.equal(cfg.reviewer, '', 'any reviewer');
  assert.deepEqual(cfg.enforcement, []);
  assert.equal(managedClaudeMd('darwin'), '/Library/Application Support/ClaudeCode/CLAUDE.md');
  assert.equal(managedClaudeMd('linux'), '/etc/claude-code/CLAUDE.md');
});

test('the guard log counts this checkout and its worktrees, never a sibling folder that shares its name', async () => {
  // Both lines fall inside the fixture's span of tool calls (10:00 to 10:06 UTC).
  const log = path.join(tmp, 'sibling.log');
  write(log, [
    JSON.stringify({ ts: '2026-11-02T10:02:00+0000', cwd: checkout, rules: ['own-rule'] }),
    JSON.stringify({ ts: '2026-11-02T10:03:00+0000', cwd: `${checkout}/.claude/worktrees/y`, rules: ['own-rule'] }),
    JSON.stringify({ ts: '2026-11-02T10:04:00+0000', cwd: `${checkout}-other`, rules: ['sibling-rule'] }),
  ].join('\n'));
  const got = await collect({ ...base, guardLog: log, gh: fakeGh() });
  assert.deepEqual(got['blockers.guard_blocks_per_100_calls'].detail.map((d) => d.label), ['own-rule']);
  assert.equal(got['blockers.guard_blocks_per_100_calls'].value, 28.571, '2 blocks over the 7 tool calls');
});

test('any reviewer counts when params.reviewer is empty', () => {
  assert.deepEqual(reviewRounds(PRS[0], 'lead-reviewer').map((r) => r.kind), ['found', 'confirm']);
  // someone's review of bbb at 11:30 comes first, so with anyone counted bbb's round still confirms aaa's finding.
  assert.deepEqual(reviewRounds(PRS[0]).map((r) => r.kind), ['found', 'confirm']);
  assert.deepEqual(reviewRounds(PRS[0], 'nobody'), []);
});

test('with no GitHub repo to read, every metric is not measured', async () => {
  const saved = process.env.GITHUB_REPOSITORY;
  delete process.env.GITHUB_REPOSITORY;
  try {
    const got = await collect({ ...base, params: { ...params, repo: '' }, exec: async () => { throw new Error('not a git repository'); }, gh: fakeGh() });
    for (const id of metricIds) assert.match(got[id].could_not_check, /no GitHub repo/, id);
  } finally {
    if (saved !== undefined) process.env.GITHUB_REPOSITORY = saved;
  }
});

test('the transcript folder is params.projects_dir, and the source names it', async () => {
  const got = await collect({ ...base, projectsDir: undefined, params: { ...params, projects_dir: projectsDir }, gh: fakeGh() });
  assert.equal(got['blockers.guard_false_alarm_share'].value, 50);
  assert.ok(got['blockers.guard_false_alarm_share'].source.startsWith(`${projectsDir}/*acme-site*/`), got['blockers.guard_false_alarm_share'].source);
});

// ---- held or false alarm: what came after a block
