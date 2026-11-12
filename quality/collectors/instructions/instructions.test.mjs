// node --test quality/collectors/instructions/instructions.test.mjs
// Every input is synthetic and written to a temp folder at run time: a repo,
// a home with rules, skills, memory and transcripts, and a Git Crafter checkout.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { CHARTS, loadTargets } from '../../score.mjs';
import { area, collect, frontmatter, globRegex, metricIds, normClause, PARAMS } from './instructions.mjs';

const now = new Date('2026-11-03T12:00:00Z');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'instructions-collector-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const write = (p, text) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};
const lines = (n, width = 100) => `${'x'.repeat(width - 1)}\n`.repeat(n);
const jsonl = (rows) => `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`;

const root = path.join(tmp, 'repo');
const home = path.join(tmp, 'home');
const managed = path.join(tmp, 'managed', 'CLAUDE.md');
const folder = path.join(home, '.claude', 'projects', '-Users-someone-Developer-acme-site');

// Always loaded: 400 + 400 + 800 + 200 bytes = 450 tokens, in 4 + 4 + 8 + 2 lines.
write(managed, lines(4));
write(path.join(root, 'CLAUDE.md'), lines(4));
write(path.join(root, '.claude', 'rules', 'always.md'), lines(2));
write(path.join(root, '.claude', 'rules', 'scoped.md'), '---\npaths:\n  - "**/*.yml"\n---\nOnly with YAML.\n');
write(path.join(home, '.claude', 'rules', 'h.md'), `${'Never push to MAIN,'.padEnd(99)}\n${'  force-push or hard-reset.'.padEnd(99)}\n${lines(6)}`);
write(path.join(home, '.claude', 'rules', 'p.md'), '---\npaths: ["site/**/*.astro", "{a,b}.md"]\n---\nPages.\n');
// Listings: a (1 + 6), r (1 + 7), merging (7 + 12), x (1 + 17) = 52 bytes, 13 tokens.
write(path.join(root, '.claude', 'skills', 'a', 'SKILL.md'), '---\nname: a\ndescription: Use a.\n---\nBody text is not listed.\n');
write(path.join(root, '.claude', 'agents', 'r.md'), '---\nname: r\ndescription: "Review."\ntools: Read\n---\nBody.\n');
write(path.join(home, '.claude', 'skills', 'merging', 'SKILL.md'), '---\nname: merging\ndescription: Merge rules.\n---\nOnly one session merges.\n');
write(path.join(home, '.claude', 'skills', 'x', 'SKILL.md'), '---\ndescription: >\n  Line one\n  line two\n---\n');
// The repo holds the sources of merging, x and p.md (params.installed_from_code_os), so unused counts them.
write(path.join(root, 'skills', 'merging', 'SKILL.md'), 'source\n');
write(path.join(root, 'skills', 'x', 'SKILL.md'), 'source\n');
write(path.join(root, 'rules', 'p.md'), 'source\n');
// Memory: 4 lines of 10 bytes.
write(path.join(folder, 'memory', 'MEMORY.md'), lines(4, 10));
// Git Crafter: one clause rewrapped and recased in the installed rule, one gone from the installed skill.
write(
  path.join(home, 'Developer', 'Code-OS', 'tools', 'protected_clauses.json'),
  JSON.stringify({ clauses: [{ file: 'rules/h.md', id: 'no-main', text: 'never push to main, force-push or hard-reset.' }, { file: 'skills/merging/SKILL.md', id: 'match-head', text: 'Merge with --match-head-commit.' }] }),
);

// Transcripts: s1 (older) calls agent r; s2 (newest) starts with a 3-line hook,
// calls skill a, reads an .astro page; its subagent calls skill merging.
const t = (min) => new Date(Date.parse('2026-11-03T08:00:00Z') + min * 6e4).toISOString();
const call = (sid, min, name, input, cwd = root) => ({ type: 'assistant', timestamp: t(min), sessionId: sid, cwd, message: { id: `${sid}${min}`, content: [{ type: 'tool_use', id: `u${min}`, name, input }] } });
write(path.join(folder, 's1.jsonl'), jsonl([{ type: 'user', timestamp: t(0), sessionId: 's1', message: { content: '<command-name>/compact</command-name>' } }, call('s1', 1, 'Agent', { subagent_type: 'r', prompt: 'p' })]));
write(
  path.join(folder, 's2.jsonl'),
  jsonl([
    { type: 'attachment', timestamp: t(60), sessionId: 's2', attachment: { type: 'hook_success', hookName: 'SessionStart:startup', hookEvent: 'SessionStart', content: 'one\ntwo\nthree\n' } },
    call('s2', 61, 'Skill', { skill: 'a' }),
    { type: 'attachment', timestamp: t(62), sessionId: 's2', attachment: { type: 'hook_success', hookName: 'SessionStart:compact', content: 'after the first reply\n' } },
    call('s2', 63, 'Read', { file_path: path.join(root, 'site', 'pages', 'x.astro') }),
    call('s2', 64, 'Read', { file_path: path.join(tmp, 'elsewhere', 'z.yml') }),
  ]),
);
write(path.join(folder, 's2', 'subagents', 'agent-1.jsonl'), jsonl([call('s2', 65, 'Skill', { skill: 'merging' })]));

// The template's params plus the fixture repo's own, as its targets file would give them.
const params = { ...PARAMS, managed_claude_md: managed, project_match: 'acme-site', code_os_checkout: path.join(home, 'Developer', 'Code-OS') };
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

test('targets: valid, on the Instructions tab, plain means, a goal basis and N or state in each source', () => {
  const defs = ownTargets('instructions.json');
  assert.equal(area, 'instructions');
  assert.deepEqual(defs.map((d) => d.id), metricIds);
  for (const d of defs) {
    assert.equal(d.tab, 'instructions', d.id);
    assert.ok(d.means && d.means.length <= 120 && !/\d/.test(d.means), `${d.id}: means`);
    assert.ok(d.group && CHARTS.has(d.chart), d.id);
    assert.match(d.goal_source, /^(goal from |template goal, no public benchmark: )/, d.id);
    assert.match(d.source, /^state|N = /, `${d.id}: a state or names N`);
    assert.notEqual(d.chart, 'spark', d.id);
  }
  const goal = Object.fromEntries(defs.map((d) => [d.id, [d.goal, d.near]]));
  assert.deepEqual(goal['instructions.memory_index_tokens'], [600, 900]);
  assert.deepEqual(goal['instructions.lines_before_action'], [200, 400], "the memory docs' 200-line target");
  assert.equal(goal['instructions.unused'][0], 0);
  assert.equal(goal['instructions.protected_clauses_missing'][0], 0);
});

test('helpers: frontmatter, globs and the clause normalisation of clause_check.py', () => {
  assert.deepEqual(frontmatter('---\nname: a\ndescription: >\n  one\n  two\npaths:\n  - "x/**"\n---\nbody'), { name: ['a'], description: ['one', 'two'], paths: ['x/**'] });
  assert.ok(globRegex('site/**/*.astro').test('site/pages/x.astro') && globRegex('site/**/*.astro').test('site/x.astro'));
  assert.ok(!globRegex('**/*.yml').test('a/b.yaml') && globRegex('{a,b}.md').test('b.md'));
  assert.equal(normClause('  Never push\n  to MAIN\t now '), 'never push to main now');
});

test('collect: every metric from the fixture', async () => {
  const got = await collect(base);
  assert.deepEqual(Object.keys(got), metricIds);
  assert.deepEqual(values(got), {
    'instructions.protected_clauses_missing': 1, // match-head is gone; no-main holds rewrapped and recased
    'instructions.unused': 2, // skill x and rule scoped.md; a, merging (in a subagent), r (in s1) and p.md (an .astro read) are used
    'instructions.lines_before_action': 4, // the largest of CLAUDE.md 4, the index head 4, always.md 2; the managed file and h.md (no source here) are not the repo's
    'claude.instruction_tokens': 450, // the scoped rules and the index left out
    'instructions.memory_index_tokens': 10,
    'instructions.description_tokens': 13,
  });
  assert.deepEqual(got['instructions.protected_clauses_missing'].detail.map((d) => d.label), ['clauses checked', 'skills/merging/SKILL.md: match-head']);
  assert.deepEqual(got['instructions.unused'].detail.filter((d) => d.value === 0).map((d) => d.label), ['skill: x', 'rule: scoped.md']);
  assert.deepEqual(got['claude.instruction_tokens'].detail.map((d) => [d.label, d.value]), [['managed CLAUDE.md', 100], ['repo CLAUDE.md', 100], ['house rules', 200], ['repo rules', 50]]);
  assert.deepEqual(got['instructions.lines_before_action'].detail.map((d) => [d.label, d.value]), [['CLAUDE.md', 4], ['memory index head', 4], [path.join('.claude', 'rules', 'always.md'), 2]]);
  // The source names the checkout as ~/..., never the absolute home path (#229).
  const src = got['instructions.protected_clauses_missing'].source;
  assert.match(src, /params\.code_os_checkout ~\/Developer\/Code-OS\)/);
  assert.ok(!src.includes(home), 'no home path in the source');
  assert.ok(!JSON.stringify(got).includes('force-push') && !JSON.stringify(got).includes('Body'), 'no file text leaves the collector');
  // The last N: with N = 1 only s2 counts, so agent r, called in s1, is unused.
  const one = await collect({ ...base, params: { ...params, unused_sessions: 1 } });
  assert.equal(one['instructions.unused'].value, 3);
});

test('a missing input reads could_not_check, never 0', async () => {
  for (const id of metricIds) assert.ok((await collect({ mode: 'ci' }))[id].could_not_check, id);
  const gone = path.join(tmp, 'gone');
  const none = await collect({ root: gone, mode: 'local', home: gone, now, params: { ...params, managed_claude_md: path.join(gone, 'm') } });
  for (const id of metricIds) assert.ok(none[id].could_not_check && !('value' in none[id]), id);
  // No transcript: unused is not measured; the states, the line count among them, still read.
  const early = await collect({ ...base, now: new Date('2026-11-01T00:00:00Z') });
  assert.equal(early['instructions.lines_before_action'].value, 4);
  assert.match(early['instructions.unused'].could_not_check, /no main session/);
  assert.equal(early['claude.instruction_tokens'].value, 450);
  // A clause's installed file that cannot be read, or one with no mapping, is not a pass.
  const noSkill = await collect({ ...base, params: { ...params, installed_from_code_os: { 'rules/': '~/.claude/rules/', 'skills/': '~/nowhere/' } } });
  assert.match(noSkill['instructions.protected_clauses_missing'].could_not_check, /ENOENT/);
  const unmapped = await collect({ ...base, params: { ...params, installed_from_code_os: { 'rules/': '~/.claude/rules/' } } });
  assert.match(unmapped['instructions.protected_clauses_missing'].could_not_check, /no installed path for skills\/merging/);
  // A path through a file is an error, not an absent file.
  const bad = await collect({ ...base, params: { ...params, managed_claude_md: path.join(managed, 'nested') } });
  assert.match(bad['claude.instruction_tokens'].could_not_check, /ENOTDIR/);
});

test('no path literal in the collector: every path comes from params', () => {
  const code = fs
    .readFileSync(new URL('./instructions.mjs', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l) && !/^(import |export \{)/.test(l) && !l.includes('new URL('))
    .join('\n');
  const literals = [...code.matchAll(/'[^'\n]*'|"[^"\n]*"|`[^`\n]*`/g)].map((m) => m[0]);
  // Path-shaped: a home path, an absolute or relative path with a file or
  // folder after a slash, a .claude folder, or a repo or account name.
  const paths = literals.filter((s) => /~\/[\w.]|(^|[\s'"`])\/?[\w.-]+\/[\w.-]+|\.claude\b|Developer|Library/.test(s));
  assert.deepEqual(paths, []);
});

test('lines_before_action: a house rule counts once the repo holds its source, and a long managed file never does', async () => {
  const src = path.join(root, 'rules', 'h.md');
  write(src, 'source\n');
  const longManaged = path.join(tmp, 'managed', 'long.md');
  write(longManaged, lines(500));
  try {
    const got = await collect({ ...base, params: { ...params, managed_claude_md: longManaged } });
    assert.equal(got['instructions.lines_before_action'].value, 8, 'h.md, 8 lines, is the largest the repo controls');
    assert.equal(got['instructions.lines_before_action'].detail[0].label, path.join('.claude', 'rules', 'h.md'));
  } finally {
    fs.rmSync(src);
    fs.rmSync(longManaged);
  }
});

test('unused leaves out a user-level skill or rule whose source this repo does not hold', async () => {
  // y and q.md came from another tool: no session here used them, and they are not this repo's to remove.
  const y = path.join(home, '.claude', 'skills', 'y', 'SKILL.md');
  const q = path.join(home, '.claude', 'rules', 'q.md');
  write(y, '---\nname: y\ndescription: Other.\n---\n');
  write(q, '---\npaths: ["**/*.png"]\n---\nImages.\n');
  try {
    const got = await collect(base);
    assert.equal(got['instructions.unused'].value, 2, 'still skill x and rule scoped.md');
    assert.ok(!got['instructions.unused'].detail.some((d) => /\b(y|q\.md)$/.test(d.label)));
    // Its listing still costs tokens: y adds 1 + 6 bytes to the 52.
    assert.equal(got['instructions.description_tokens'].value, Math.round(59 / 4));
  } finally {
    fs.rmSync(path.dirname(y), { recursive: true });
    fs.rmSync(q);
  }
});

test('unused sets aside a path-scoped rule params.kept_rules names', async () => {
  // scoped.md is kept for other repos: the reading drops from 2 to skill x alone.
  const kept = { ...params, kept_rules: ['scoped.md'] };
  const got = await collect({ ...base, params: kept });
  assert.equal(got['instructions.unused'].value, 1);
  assert.ok(!got['instructions.unused'].detail.some((d) => d.label === 'rule: scoped.md'));
  // Once a session calls x too, nothing is unused.
  const s4 = path.join(folder, 's4.jsonl');
  write(s4, jsonl([call('s4', 200, 'Skill', { skill: 'x' })]));
  try {
    assert.equal((await collect({ ...base, params: kept }))['instructions.unused'].value, 0);
  } finally {
    fs.rmSync(s4);
  }
});

test('the project match defaults to the repo path, and a typed command is read by its tag alone', async () => {
  // With no project_match, the repo at /Users/someone/Developer/acme site names the fixture's folder.
  const got = await collect({ ...base, root: '/Users/someone/Developer/acme site', params: { ...params, project_match: '' } });
  assert.equal(got['instructions.memory_index_tokens'].value, 10);
  // A prompt that only mentions a command name in its text is no use of it.
  const s3 = path.join(folder, 's3.jsonl');
  write(s3, jsonl([{ type: 'user', timestamp: t(120), sessionId: 's3', message: { content: 'Please run <command-name>/x</command-name> later.' } }]));
  try {
    const later = await collect({ ...base, now: new Date('2026-11-03T12:00:00Z') });
    assert.ok(later['instructions.unused'].detail.some((d) => d.label === 'skill: x' && d.value === 0), 'x is still unused');
  } finally {
    fs.rmSync(s3);
  }
});
