// node --test quality/docs-gate.test.mjs
// Each test builds a small git repo: a base commit, then a head commit, and
// runs the docs gate between them with a 10-word reading goal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gate, main } from './docs-gate.mjs';

const PARAMS = { doc_set: ['**/*.md'], doc_set_left_out: [], words_per_minute: 5, minutes_goal: 2, text_only_below: 20, alt_max_chars: 150 };

// Isolated from the user's git config and from a hook's GIT_DIR.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
Object.assign(env, {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
});
const run = (dir, ...args) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' }).trim();

// A doc of three table lines (4 words in cells) and one prose line of `n`
// words: n + 4 words, 75% visual.
const doc = (n) => `| a | b |\n|---|---|\n| x | y |\n\n${Array.from({ length: n }, (_, i) => `w${i}`).join(' ')}\n`;

// A repo whose base commit holds `base` and whose HEAD holds `head`, each
// { file: text }; a file missing from head is deleted. Returns { dir, base }.
function repo(base, head) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-gate-'));
  run(dir, 'init', '-q', '-b', 'main');
  const write = (files) => {
    for (const f of fs.readdirSync(dir)) if (f !== '.git') fs.rmSync(path.join(dir, f), { recursive: true });
    for (const [f, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), text);
    }
    run(dir, 'add', '-A');
    run(dir, 'commit', '-q', '--allow-empty', '-m', 'step');
  };
  write(base);
  const sha = run(dir, 'rev-parse', 'HEAD');
  write(head);
  return { dir, base: sha };
}

test('a doc that crosses the goal fails, naming its old and new words and the goal', () => {
  const { dir, base } = repo({ 'README.md': doc(5) }, { 'README.md': doc(15) });
  const { worse } = gate({ root: dir, base, params: PARAMS });
  assert.deepEqual(worse, [{ doc: 'README.md', what: '9 to 19 words, over the 10-word reading goal (2 minutes at 5 words a minute)' }]);
});

test('a doc already over the goal on the base passes, even when it grows', () => {
  const { dir, base } = repo({ 'README.md': doc(15) }, { 'README.md': doc(20) });
  assert.deepEqual(gate({ root: dir, base, params: PARAMS }).worse, []);
});

test('a new doc over the goal fails as new; a renamed doc keeps its base', () => {
  const { dir, base } = repo({ 'old.md': doc(15) }, { 'moved.md': doc(15), 'guide/new.md': doc(12) });
  assert.deepEqual(gate({ root: dir, base, params: PARAMS }).worse.map((w) => `${w.doc}: ${w.what.split(',')[0]}`), ['guide/new.md: new to 16 words']);
});

test('a doc that drops under the visual bar or gains a heading fault fails', () => {
  const prose = `${'w\n'.repeat(5)}| a | b |\n`;
  const { dir, base } = repo({ 'a.md': doc(3), 'b.md': '# One\n\nText\n' }, { 'a.md': prose, 'b.md': '# One\n\n### Three\n\nText\n' });
  const what = gate({ root: dir, base, params: PARAMS }).worse.map((w) => `${w.doc}: ${w.what}`);
  assert.deepEqual(what, [
    'a.md: 75% to 16.7% visual lines, under the 20% bar',
    'b.md: 0 to 1 heading and image faults, goal 0 (line 3 heading level 1 to 3)',
  ]);
});

test('a changed file outside the doc set is not read', () => {
  const { dir, base } = repo({ 'notes.txt': 'a' }, { 'notes.txt': doc(40) });
  assert.deepEqual(gate({ root: dir, base, params: PARAMS }).worse, []);
});

test('the command line exits 1 on a worse doc, 0 when it cannot verify, 2 with no base', () => {
  const { dir, base } = repo({ 'README.md': doc(5) }, { 'README.md': doc(500) });
  const log = console.log;
  const lines = [];
  console.log = (s) => lines.push(s);
  try {
    assert.equal(main(['--base', base], dir), 1);
    assert.match(lines[0], /^::error file=README\.md::README\.md: 9 to 504 words/);
    assert.match(lines.at(-1), /^To fix: cut each doc named to 476 words or fewer/);
    assert.equal(main(['--base', 'no-such-ref'], dir), 0);
    assert.match(lines.at(-1), /^::warning::docs gate could not verify: git merge-base failed/);
  } finally {
    console.log = log;
  }
  const err = console.error;
  console.error = () => {};
  try { assert.equal(main([], dir), 2); } finally { console.error = err; }
});
