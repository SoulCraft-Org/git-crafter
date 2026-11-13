// Shared synthetic inputs for the Blockers collector's tests (blockers.test.mjs, blockers-replay.test.mjs): transcripts, a guard log, instruction files and the GitHub answers, written to a temp folder at run time.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';
import { loadTargets } from '../lib/score.mjs';
// Only this collector's targets files, so another collector's file never fails these tests.
export function ownTargets(...files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'own-targets-'));
  try {
    for (const f of files) fs.copyFileSync(new URL(`../../targets/${f}`, import.meta.url), path.join(dir, f));
    return loadTargets(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// The fixed clock the tests run at.
export const now = new Date('2026-11-03T12:00:00Z');
// The temp folder every synthetic input is written to.
export const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blockers-collector-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
// Writes a file under the temp folder, making its folders.
export const write = (p, text) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};
// Lines of objects as JSON Lines text.
export const jsonl = (lines) => `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;

// ---- transcripts: one main session, one review subagent, one other project

// The synthetic transcripts folder.
export const projectsDir = path.join(tmp, 'projects');
// The synthetic project folder for the acme-site checkout.
export const site = path.join(projectsDir, '-Users-someone-Developer-acme-site');
// An ISO time a number of minutes after the transcripts' start.
export const at = (min) => new Date(Date.parse('2026-11-02T10:00:00Z') + min * 6e4).toISOString();
// A usage record of a given total tokens.
export const usage = (total) => ({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: total });
// A Bash tool_use block.
export const bash = (id, command) => ({ type: 'tool_use', id, name: 'Bash', input: { command } });
// An assistant transcript line.
export const asst = (min, id, total, tools = [], extra = {}) => ({ type: 'assistant', timestamp: at(min), sessionId: 's1', isSidechain: false, message: { id, usage: usage(total), content: tools }, ...extra });
// A tool_result transcript line.
export const result = (min, id, text, isError = false) => ({ type: 'user', timestamp: at(min), sessionId: 's1', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: text }] } });
// The text of a guard block for a rule.
export const guardText = (rule) => `PreToolUse:Bash hook error: [python3 -I /Users/someone/.claude/code-os/bash_guard.py]: Blocked by the Git Crafter bash guard (${rule}).\n- ${rule}: why.`;
// A voice-lint warning line.
export const WARN = '  WARN [sentence-length] data/x.md:3 one sentence runs long';

write(
  path.join(site, 's1.jsonl'),
  jsonl([
    { type: 'attachment', timestamp: at(0.5), sessionId: 's1', attachment: { type: 'hook_success', hookName: 'SessionStart:startup', content: 'x'.repeat(400), durationMs: 250 } },
    asst(0.5, 'm1', 1000, [bash('t1', 'cd /repo && cat site/a.mjs; git grep -n lastmod -- site/src')]),
    result(0.6, 't1', guardText('credential-file-read'), true),
    asst(1.5, 'm2', 2000, [bash('t2', 'head -n 5 site/a.mjs')]),
    result(1.6, 't2', 'export const a = 1;'),
    asst(2, 'm3', 1000, [bash('t3', 'cat ~/.env.local')]),
    result(2.1, 't3', guardText('credential-file-read'), true),
    asst(4, 'm4', 4000, [bash('t4', 'git commit -m x')]),
    result(4.2, 't4', `${WARN}\n[branch abc] x`),
    asst(5, 'm5', 1000, [bash('t5', 'git push origin main')]),
    result(5.05, 't5', 'BLOCKED [main]: this push targets refs/heads/main.', true),
    asst(6, 'm6', 6000, [bash('t6', 'git push origin HEAD:refs/heads/feature')]),
    result(6.5, 't6', 'To github.com:org/repo.git'),
    { type: 'system', subtype: 'compact_boundary', timestamp: at(6.6), sessionId: 's1' },
    asst(7, 'm7', 1000),
    // An old message, before the oldest of the last 1,000 tool calls: counted nowhere.
    asst(-30 * 24 * 60, 'm0', 9e9),
  ]),
);
write(
  path.join(site, 's1', 'subagents', 'agent-r1.jsonl'),
  jsonl([{ ...asst(3, 'r1', 0), isSidechain: true, message: { id: 'r1', usage: { input_tokens: 10_000, output_tokens: 40_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 900_000 }, content: [] } }, asst(3.5, 'r2', 0, [{ type: 'tool_use', id: 'u1', name: 'mcp__ccd_turn__update_plan', input: {} }], { isSidechain: true }), result(3.6, 'u1', 'PreToolUse:mcp__ccd_turn__update_plan hook error: Not shown: you are a subagent, and the app shows only the main task list.', true)]),
);
write(path.join(site, 's1', 'subagents', 'agent-r1.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'Adversarial review of PR #7' }));
write(path.join(projectsDir, '-Users-someone-Developer-Other', 'x.jsonl'), jsonl([asst(1, 'o1', 7e7, [bash('o', 'cat ~/.env')]), result(1.1, 'o', guardText('credential-file-read'), true)]));
write(path.join(site, 'memory', 'MEMORY.md'), 'x'.repeat(40));

// ---- instruction files: 400 + 800 + 1200 + the 40-byte index = 610 tokens a call

// The synthetic repo root.
export const root = path.join(tmp, 'repo');
// The synthetic home folder.
export const home = path.join(tmp, 'home');
// The synthetic managed CLAUDE.md.
export const managedPath = path.join(tmp, 'managed', 'CLAUDE.md');
write(path.join(root, 'CLAUDE.md'), 'x'.repeat(400));
write(managedPath, 'x'.repeat(800));
write(path.join(home, '.claude', 'rules', 'a.md'), 'x'.repeat(1200));
write(path.join(home, '.claude', 'rules', 'notes.txt'), 'x'.repeat(4000));
// Scoped by paths, so it loads only with matching files: not counted.
write(path.join(home, '.claude', 'rules', 'scoped.md'), `---\npaths:\n  - "**/*.yml"\n---\n${'x'.repeat(4000)}`);

// ---- guard log: three blocks within the fixture's tool calls (t1, t3, and a
// rule no transcript shows), one before them, one elsewhere

// The synthetic guard log.
export const guardLog = path.join(tmp, 'bash_guard.log');
// The checkout path the guard log names.
export const checkout = '/Users/someone/Developer/acme site';
const website = `${checkout}/.claude/worktrees/x`;
write(
  guardLog,
  [
    JSON.stringify({ ts: '2026-11-02T03:00:36-0700', session: 's1', cwd: website, rules: ['credential-file-read'], command: 'never read' }),
    JSON.stringify({ ts: '2026-11-02T03:02:06-0700', session: 's1', cwd: website, rules: ['credential-file-read'], command: 'never read' }),
    JSON.stringify({ ts: '2026-11-02T04:03:00-0600', session: 's2', cwd: website, rules: ['git-push-main'], command: 'never read' }),
    JSON.stringify({ ts: '2026-10-25T10:00:00-0600', session: 's2', cwd: website, rules: ['git-push-main'], command: 'never read' }),
    JSON.stringify({ ts: '2026-11-01T10:00:00-0600', session: 's3', cwd: `${checkout}-other`, rules: ['local-heavy-compute'], command: 'never read' }),
    'not json',
  ].join('\n'),
);

// ---- GitHub: PR 7 (found, then confirmed; a flaky lint), PR 8 (clean; a real
// failure), PR 9 (an old merge, no review, no checks). Fewer than 21 merged,
// so the walk reads every page.

const T = (s) => `2026-11-0${s}Z`;
// One fixture run record with its jobs' timestamps.
export const run = (name, start, end, conclusion) => ({ name, startedAt: T(start), completedAt: T(end), conclusion });
// A commit with its check suite and runs.
export const commit = (oid, suite, runs) => ({ commit: { oid, committedDate: T(suite), checkSuites: { nodes: [{ createdAt: T(suite), checkRuns: { nodes: runs } }, { createdAt: T(suite), checkRuns: { nodes: [] } }] } } });
// A review record.
export const review = (login, oid, when) => ({ author: { login }, submittedAt: T(when), commit: { oid } });
// The fixture pull requests with their runs and reviews.
export const PRS = [
  {
    number: 7,
    title: 'Tighten the gate',
    files: { nodes: [{ path: '.github/workflows/content-gates.yml' }] },
    createdAt: T('2T09:00:00'),
    mergedAt: T('2T13:00:00'),
    updatedAt: T('2T13:00:00'),
    headRefOid: 'bbb',
    reviews: { nodes: [review('lead-reviewer', 'aaa', '2T10:00:00'), review('someone', 'bbb', '2T11:30:00'), review('lead-reviewer', 'bbb', '2T12:00:00'), review('lead-reviewer', 'bbb', '2T14:00:00')] },
    commits: {
      nodes: [
        commit('aaa', '2T09:00:00', [run('lint', '2T09:00:10', '2T09:00:40', 'FAILURE'), run('lint', '2T09:05:00', '2T09:05:30', 'SUCCESS'), run('tests', '2T09:00:10', '2T09:06:00', 'SUCCESS')]),
        commit('bbb', '2T11:00:00', [run('lint', '2T11:00:05', '2T11:00:25', 'SUCCESS'), run('tests', '2T11:00:05', '2T11:00:05', 'SKIPPED'), run('dco', '2T11:00:01', '2T11:00:02', 'SUCCESS')]),
      ],
    },
  },
  {
    number: 8,
    title: 'Hook change',
    files: { nodes: [{ path: '.claude/hooks/content-guard.sh' }] },
    createdAt: T('1T10:00:00'),
    mergedAt: T('1T10:30:00'),
    updatedAt: T('1T10:30:00'),
    headRefOid: 'ccc',
    reviews: { nodes: [review('lead-reviewer', 'ccc', '1T10:20:00')] },
    commits: { nodes: [commit('ccc', '1T10:00:00', [run('e2e', '1T10:01:00', '1T10:11:00', 'FAILURE')])] },
  },
  { number: 9, createdAt: '2026-10-01T00:00:00Z', mergedAt: '2026-10-01T01:00:00Z', updatedAt: '2026-10-15T00:00:00Z', headRefOid: 'ddd', reviews: { nodes: [] }, commits: { nodes: [] } },
];
// A gh client that answers the pull request pages from PRS and records its calls.
export function fakeGh(calls = []) {
  return async (args) => {
    calls.push(args.join(' '));
    // PR 7 changed a workflow and a later PR reverted it, by title; no bug names a PR.
    if (args[0] === 'pr') return JSON.stringify([{ number: 20, title: 'Revert "Tighten the gate"', body: 'This reverts the gate.', mergedAt: T('3T09:00:00') }]);
    // Bug 31 blames PR 8; 32 and 33 mention a PR for context only, as real bug reports often do.
    if (args[0] === 'issue') {
      return JSON.stringify([
        { number: 31, title: 'Hook prints twice', body: 'Regressed-by: #8', createdAt: T('2T08:00:00') },
        { number: 32, title: 'DCO fails on PR #6', body: '- PR #8 passes DCO with a verified commit.\nRe-commit the way #5 became #8.', createdAt: T('2T09:00:00') },
        { number: 33, title: 'Small gaps', body: 'Found in the review of #8 (merged as db76b31). None is a regression; each existed before.', createdAt: T('2T09:30:00') },
      ]);
    }
    assert.equal(args[0], 'api');
    if (args.join(' ').includes('after: "c1"')) return JSON.stringify({ data: { repository: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } });
    return JSON.stringify({ data: { repository: { pullRequests: { pageInfo: { hasNextPage: true, endCursor: 'c1' }, nodes: PRS } } } });
  };
}
// The collector's own targets file, parsed.
export const targets = JSON.parse(fs.readFileSync(new URL('../../targets/blockers.json', import.meta.url), 'utf8'));
// The template's params plus the fixture repo's own, as its quality/targets/blockers.json would give them.
export const params = { ...Object.assign({}, ...targets.map((d) => d.params ?? {})), project_match: 'acme-site', checkout_path: checkout, repo: 'acme/site', reviewer: 'lead-reviewer' };
// The current guard, replayed: here it still blocks every command it blocked.
// A fake replay: each item's rule ids now, and the rules that read the checkout's branch.
export const verdictsOf = (items, rulesOf, branchRules = []) => ({ verdicts: new Map(items.map((it) => [it.id, rulesOf(it)])), branchRules: new Set(branchRules) });
const stillBlocks = async (script, items) => verdictsOf(items, () => ['credential-file-read', 'git-push-main']);
// The options every collect call shares.
export const base = { root, mode: 'local', projectsDir, home, guardLog, managedPath, now, params, replay: stillBlocks };

// ---- tests
