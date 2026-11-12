// node --test quality/collectors/simplicity/simplicity.test.mjs
// Every input is synthetic and written to a temp folder at run time: a repo,
// a home with rules and memory, and the Git Crafter answers (sync status, git
// grep) from a fake exec.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadTargets } from '../../score.mjs';
import { area, collect, figureDates, fileRefs, metricIds, noteFlags, resolves, sentences } from './simplicity.mjs';

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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'simplicity-collector-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const write = (p, text) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};

const RULE = 'Never push to main, force-push or hard-reset in any repo at all.';
const root = path.join(tmp, 'repo');
const home = path.join(tmp, 'home');
const managedPath = path.join(tmp, 'managed', 'CLAUDE.md');
const codeOs = path.join(tmp, 'code-os');
const projectsDir = path.join(home, '.claude', 'projects');
const memory = path.join(projectsDir, '-Users-someone-Developer-acme-site', 'memory');

// 1,200 bytes: 300 tokens. It restates RULE and names one path that exists and one that does not.
const claudeMd = `# Repo\n\n${RULE}\n\nSee \`quality/README.md\` and \`quality/gone.md\`, \`acme/tools\` and [docs](https://x.example/a/b).\nNever create \`quality/forbidden.md\`. Read another-repo's \`quality/theirs.md\`. Pages: \`/community/\`.\n`;
write(path.join(root, 'CLAUDE.md'), claudeMd.padEnd(1200, ' '));
write(path.join(root, 'quality', 'README.md'), 'x');
// Figures: one dated this week, one undated, one in a row dated over 30 days ago; code left out.
write(path.join(root, 'README.md'), 'A run took 12 minutes on 2026-11-01. It read 1,234 files\nacross the repo.\n\n| Share | Read |\n| --- | --- |\n| 45% | 2026-09-01 |\n\n`50%` stays code.\n\n```\n99% in a fence\n```\n');

write(managedPath, `Policy.\n\n- ${RULE}\n- Credentials live in \`~/.config/other/account/\`.\n`);
write(path.join(home, '.claude', 'rules', 'a.md'), `# Rule\n\n${RULE}\n\nSee \`~/.claude/rules/a.md\` and \`~/.claude/missing.md\`.\n`);
write(path.join(codeOs, 'README.md'), 'the checkout exists');
write(path.join(memory, 'MEMORY.md'), `- [Note](note.md): one note\n`.padEnd(400, ' '));
write(path.join(memory, 'note.md'), 'Run `npm run quality:collect -- --local` or `node x.mjs --gone-flag`; see `quality/gone.md`.\n');
write(path.join(memory, 'fine.md'), 'Run `npm run quality:collect -- --local` and read `quality/README.md`.\n');

function fakeExec(calls = []) {
  return async (cmd, args) => {
    calls.push(`${cmd} ${args.join(' ')}`);
    if (cmd === 'python3') return 'User-claude  (~/.claude)\n  in-sync    rules/a.md\n  drifted    rules/b.md\n  in-sync    code-os/bash_guard.py\n';
    if (args.includes('grep')) {
      if (args.at(-1) === '--local') return '';
      throw Object.assign(new Error('exit 1'), { code: 1 });
    }
    throw new Error(`unexpected: ${cmd} ${args.join(' ')}`);
  };
}
// The repo's own settings and the Docs tab's doc set, as its targets files would give them.
const params = { project_match: 'acme-site', not_living: ['baseline'], stale_days: 30 };
const docParams = { doc_set: ['README.md', '00_project_system/*.md'] };
const base = { root, mode: 'local', home, projectsDir, managedPath, codeOs, now, params, docParams };

test('targets: drift and bloat on the Instructions tab, undated figures on Documentation, every goal labeled', () => {
  const defs = ownTargets('simplicity.json');
  const mine = defs.filter((d) => d.file === 'simplicity.json');
  assert.equal(area, 'simplicity');
  assert.deepEqual(mine.map((d) => d.id), metricIds);
  for (const d of mine) {
    // Undated figures are about docs, so they sit on the Documentation tab; the rest are instructions.
    const undated = d.id === 'simplicity.undated_figures';
    const restated = d.id === 'simplicity.restated_rules';
    const [tab, group] = undated ? ['documentation', 'Current'] : ['instructions', restated ? 'Bloat' : 'Drift'];
    assert.deepEqual([d.tab, d.kind, d.group, d.direction], [tab, 'quality', group, 'lower'], d.id);
    assert.match(d.goal_source, /^template goal, no public benchmark: /, d.id);
    // Every row is a state read now; undated_figures' age rule is a freshness test of each figure, not a window.
    assert.notEqual(d.chart, 'spark', d.id);
  }
});

test('sentences: markdown, case and table cells set aside; short ones left out', () => {
  assert.ok(sentences(`- **${RULE}**`).has(RULE.toLowerCase().replace(/\.$/, '')));
  assert.equal(sentences('| Never push to main | ok |').size, 0, 'short cells are not rules');
  assert.equal(sentences('```\nNever push to main, force-push or hard-reset in any repo at all.\n```').size, 0);
});

test('fileRefs and noteFlags read paths and flags, not URLs, slugs or globs', () => {
  assert.deepEqual(fileRefs('`a/b.md:12` `owner/repo` `src/*.ts` [x](https://e.x/y) [y](../z.md#h) `~/p q/r.md`'), ['a/b.md', '../z.md', '~/p q/r.md']);
  assert.ok(resolves('.git/cs-deps-seed/', '/x/CLAUDE.md', ['/nowhere'], '/nowhere'), 'git internals are left out');
  assert.deepEqual(fileRefs('Never create `~/.local/bin/x`.\nIn another-repo\'s `.github/a.py`, see `b/c.md`.'), ['b/c.md'], 'forbidden and another repo\'s paths are left out');
  assert.deepEqual(noteFlags('`npm run x -- --local` and `--dry-run` but not --bare'), ['--local', '--dry-run']);
  assert.deepEqual(noteFlags('`gh issue create --type Bug` `git push --force-with-lease` `python3 -I tools/x.py --yes`'), ['--yes'], 'an outside program\'s flag is not this repo\'s to check');
});

test('figureDates: a figure needs a read date in its sentence or row, within the window', () => {
  const since = Date.parse('2026-10-04T00:00:00Z');
  assert.deepEqual(figureDates('Took 12 minutes on 2026-11-01. Read 1,234 files.', since), { undated: 1, old: 0 });
  assert.deepEqual(figureDates('| 45% | 2026-09-01 |', since), { undated: 0, old: 1 });
  assert.deepEqual(figureDates('`50%` and Node 22 and 2026.', since), { undated: 0, old: 0 });
});

test('figureDates: a wrapped list item is one unit, so its first-line date covers its next line', () => {
  const since = Date.parse('2026-10-04T00:00:00Z');
  assert.deepEqual(figureDates('- Owner, 2026-11-04: the tier gives\n  3,000 minutes a month.', since), { undated: 0, old: 0 });
  // A new item starts a new unit: the first item's date never covers it.
  assert.deepEqual(figureDates('- Read 2026-11-04.\n- Took 12 minutes.', since), { undated: 1, old: 0 });
  // A table row after an item still stands alone.
  assert.deepEqual(figureDates('- Read 2026-11-04 and\n| 45% |', since), { undated: 1, old: 0 });
});

test('collect: every metric from the fixture', async () => {
  const calls = [];
  const got = await collect({ ...base, exec: fakeExec(calls) });
  assert.deepEqual(Object.keys(got), metricIds);
  const v = Object.fromEntries(Object.entries(got).map(([id, e]) => [id.replace('simplicity.', ''), e.value ?? e.could_not_check]));
  assert.deepEqual(v, {
    restated_rules: 1, // RULE, in the managed CLAUDE.md, rules/a.md and the repo CLAUDE.md
    broken_refs: 3, // quality/gone.md in CLAUDE.md and note.md, ~/.claude/missing.md in rules/a.md; not the never line, another repo's file, the route or the managed file's path
    copy_drift: 1, // rules/b.md drifted
    undated_figures: 2, // 1,234 files undated, 45% read 2026-09-01; code left out
    memory_stale_refs: 1, // note.md: quality/gone.md and --gone-flag
  });
  assert.deepEqual(got['simplicity.restated_rules'].detail, [{ label: 'managed CLAUDE.md + repo CLAUDE.md + rules/a.md', value: 1, unit: 'sentences' }]);
  assert.deepEqual(got['simplicity.memory_stale_refs'].detail, [{ label: 'memory/note.md', value: 2, unit: 'names' }]);
  assert.deepEqual(got['simplicity.copy_drift'].detail, [{ label: 'drifted', value: 1, unit: 'copies' }]);
  assert.ok(!JSON.stringify(got).includes('force-push'), 'no rule text leaves the collector');
});

test('collect: the sync tool exits 1 when a copy drifted, and that report still counts', async () => {
  const exit1 = async (cmd, args) => {
    if (cmd !== 'python3') return fakeExec()(cmd, args);
    throw Object.assign(new Error('Command failed'), { code: 1, stdout: await fakeExec()(cmd, args) });
  };
  const got = await collect({ ...base, exec: exit1 });
  assert.deepEqual(got['simplicity.copy_drift'].detail, [{ label: 'drifted', value: 1, unit: 'copies' }]);
  const crash = await collect({ ...base, exec: async (cmd, args) => (cmd === 'python3' ? Promise.reject(Object.assign(new Error('usage'), { code: 2, stdout: '' })) : fakeExec()(cmd, args)) });
  assert.match(crash['simplicity.copy_drift'].could_not_check, /usage/, 'exit 2 is a read error');
});

test('collect: a part that cannot be read is not measured, never 0', async () => {
  const gone = path.join(tmp, 'gone');
  const got = await collect({ root: gone, mode: 'local', home: gone, projectsDir: gone, managedPath: gone, codeOs: gone, now, params, docParams, exec: async () => Promise.reject(new Error('no such checkout')) });
  for (const id of metricIds) assert.ok(got[id].could_not_check, `${id} is not measured`);
  const partial = await collect({ ...base, exec: async (cmd, args) => (cmd === 'python3' ? Promise.reject(new Error('python3 missing')) : fakeExec()(cmd, args)) });
  assert.match(partial['simplicity.copy_drift'].could_not_check, /python3 missing/, 'an unread status is not 0 copies');
  for (const id of metricIds) assert.ok((await collect({ mode: 'ci' }))[id].could_not_check, id);
});

test('the collector holds no repo-specific value: every one is in its targets params', () => {
  const code = fs.readFileSync(new URL('./simplicity.mjs', import.meta.url), 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  for (const word of ['/Users/', 'Developer/', 'acme', 'Website']) assert.ok(!code.includes(word), `${word} in the code`);
});

test('with no checkout given, the sync tool runs from the Git Crafter checkout this collector sits in', async () => {
  const kit = fileURLToPath(new URL('../../../', import.meta.url));
  const calls = [];
  await collect({ ...base, codeOs: undefined, exec: fakeExec(calls) });
  const sync = calls.find((c) => c.startsWith('python3'));
  assert.ok(sync.startsWith(`python3 -I ${kit}tools/`), sync);
  assert.match(sync, /_os_sync\.py status user-claude$/);
});

test('without a doc set, undated figures are not measured, never 0', async () => {
  const got = await collect({ ...base, docParams: {}, exec: fakeExec() });
  assert.match(got['simplicity.undated_figures'].could_not_check, /no params\.doc_set/);
});
test("the doc set is docs.json's when the engine passes every file's params", async () => {
  // A doc set of only a missing file reads nothing: not measured, never 0.
  const got = await collect({ ...base, docParams: undefined, allParams: { 'docs.json': { doc_set: ['nowhere.md'] } }, exec: fakeExec() });
  assert.match(got['simplicity.undated_figures'].could_not_check, /matches no living doc/);
  const own = await collect({ ...base, docParams: undefined, params: { ...params, doc_set: ['README.md'] }, exec: fakeExec() });
  assert.equal(own['simplicity.undated_figures'].value, 2, "this file's own doc set when no docs.json params come");
});

test('the memory folder is found under params.projects_dir', async () => {
  const got = await collect({ ...base, projectsDir: undefined, params: { ...params, projects_dir: projectsDir }, exec: fakeExec() });
  assert.equal(got['simplicity.memory_stale_refs'].value, 1);
  const elsewhere = await collect({ ...base, projectsDir: undefined, params: { ...params, projects_dir: path.join(tmp, 'nowhere') }, exec: fakeExec() });
  assert.ok(elsewhere['simplicity.memory_stale_refs'].could_not_check, 'no memory folder there: not measured, never 0');
});
