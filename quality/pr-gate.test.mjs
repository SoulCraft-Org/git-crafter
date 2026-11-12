// The pull request gate: known-clean and known-bad descriptions for each goal, the exemption and the fail-open paths.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { diffFiles, FIX, main, misses, movedPairs, rules, sizeMiss } from './pr-gate.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TEMPLATE = rules(ROOT);
const TABLE = '| Item | Detail |\n|---|---|\n| What changed | one file |';
const CLEAN = `Closes #12\n\n${TABLE}`;
const SCRATCH = mkdtempSync(join(tmpdir(), 'pr-gate-files-'));
const OK = 'pr-gate: the description links an issue, shows a table and is within the word goal, and the change within the lines goal';
// A git patch, as pr-body.yml writes it, of `files`: { name, sign, lines }, every line added (+) or removed (-).
const diff = (files) => files.map(({ name, sign, lines }) => [
  `diff --git a/${name} b/${name}`,
  sign === '+' ? 'new file mode 100644' : 'deleted file mode 100644',
  sign === '+' ? '--- /dev/null' : `--- a/${name}`,
  sign === '+' ? `+++ b/${name}` : '+++ /dev/null',
  `@@ ${sign === '+' ? `-0,0 +1,${lines.length}` : `-1,${lines.length} +0,0`} @@`,
  ...lines.map((l) => sign + l),
].join('\n')).join('\n') + '\n';
const diffAt = (name, files) => {
  const path = join(SCRATCH, `${name}.diff`);
  writeFileSync(path, diff(files));
  return path;
};
// A patch holding `lines` added lines in one file.
const filesAt = (lines) => diffAt(`add-${lines}`, [{ name: 'a.mjs', sign: '+', lines: Array.from({ length: lines }, (_, i) => `new ${i}`) }]);
const run = (env, argv = []) => {
  const lines = [];
  return { code: main(env, argv, (l) => lines.push(l)), lines };
};

describe('pr-gate', () => {
  it('passes a draft card link with no API call: no gh, no network, no token', () => {
    const calls = [];
    const real = globalThis.fetch;
    globalThis.fetch = (...a) => (calls.push(a), Promise.reject(new Error('network')));
    try {
      const { code } = run({ PR_BODY: `Card: PVTI_lADOE8y6T84BqPGMzhHt8f0\n\n${TABLE}`, PR_AUTHOR: 'someone' }, ['--config', 'config/quality.json']);
      assert.equal(code, 0);
    } finally {
      globalThis.fetch = real;
    }
    assert.deepEqual(calls, []);
  });

  it('reads the word goal and the ignored text from the template, and a repo goal over it', () => {
    assert.equal(TEMPLATE.words, 150);
    assert.equal(TEMPLATE.ignore.length, 1);
    assert.equal(rules(ROOT, 'config/quality.json').words, 50, "Git Crafter's own goal");
  });

  it('holds no word goal in a repo that drops the metric', () => {
    const repo = mkdtempSync(join(tmpdir(), 'pr-gate-'));
    try {
      mkdirSync(join(repo, 'targets'));
      writeFileSync(join(repo, 'targets', 'github.json'), JSON.stringify([{ id: 'pull_requests.latest_body_words', drop: true }]));
      writeFileSync(join(repo, 'quality.json'), JSON.stringify({ targets: 'targets' }));
      const held = rules(repo, 'quality.json');
      assert.equal(held.words, Infinity);
      assert.deepEqual(misses(`${CLEAN}\n\n${'word '.repeat(400)}`, 'someone', held), []);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('passes a description that links an issue, shows a table and is short', () => {
    for (const body of [CLEAN, `Part of #450\n\n${TABLE}`, `fixes #3\n${TABLE}`, `Card: PVTI_lADOE8y6T84BqPGMzhHt8f0\n\n${TABLE}`]) assert.deepEqual(misses(body, 'someone', TEMPLATE), [], body);
  });

  it('fails one with no link, a bare mention, or a link only inside code or an ignored footer', () => {
    const footer = `<!-- codesmith:footer -->\nCloses #9\n<!-- /codesmith:footer -->\n${TABLE}`;
    for (const body of [TABLE, `See #12 for context.\n${TABLE}`, '```\nCloses #9\n```\n' + TABLE, footer]) {
      assert.deepEqual(misses(body, 'someone', TEMPLATE), [`the description links no issue: ${FIX}`], body);
    }
  });

  it('fails one with no table, and one over the word goal, naming the count and the goal', () => {
    assert.match(misses('Closes #12\n\nOne line.', 'someone', TEMPLATE)[0], /^the description shows no table/);
    // CLEAN holds 2 prose words outside its table ("Closes" and "12"), so 48 more make 50 and 49 make 51.
    const at = (extra) => `${CLEAN}\n\n${'word '.repeat(extra)}`;
    assert.deepEqual(misses(at(49), 'someone', TEMPLATE), [], '51 words pass the template goal of 150');
    assert.deepEqual(misses(at(48), 'someone', { ...TEMPLATE, words: 50 }), [], '50 words meet a goal of 50');
    assert.match(misses(at(49), 'someone', { ...TEMPLATE, words: 50 })[0], /^the description has 51 prose words, goal 50/);
    assert.equal(misses('', 'someone', TEMPLATE).length, 2, 'an empty description misses the link and the table');
  });

  it('exempts Dependabot, which writes its own description', () => {
    assert.deepEqual(misses('Bumps a package.', 'dependabot[bot]', TEMPLATE), []);
    assert.deepEqual(misses('Bumps a package.', 'app/dependabot', TEMPLATE), []);
  });

  it('fails a change over the reviewed-lines goal and names the stack as the fix', () => {
    const held = rules(ROOT, 'config/quality.json');
    assert.equal(held.lines, 200, 'the template goal for pull_requests.latest_lines');
    const file = (filename, additions, deletions = 0) => ({ filename, additions, deletions });
    assert.equal(sizeMiss([file('a.mjs', 120, 79)], 'someone', held), null, '199 lines pass');
    assert.equal(sizeMiss([file('a.mjs', 150), file('b.md', 30, 20)], 'someone', held), null, '200 lines meet the goal');
    assert.match(sizeMiss([file('a.mjs', 150, 51)], 'someone', held), /^the change asks a reviewer to read 201 lines, goal 200: split it into a GitHub stack/);
    // A lockfile and a data snapshot are not read, so 900 of their lines leave 150.
    assert.equal(sizeMiss([file('a.mjs', 150), file('package-lock.json', 600), file('data/quality/history/2026-11-11.json', 300)], 'someone', held), null);
    assert.equal(sizeMiss([file('a.mjs', 150), file('vendor/x.js', 300)], 'someone', { ...held, notReviewed: [/^vendor\//] }), null, "a repo's not_reviewed pattern");
    assert.equal(sizeMiss([file('package-lock.json', 5000)], 'dependabot[bot]', held), null, 'Dependabot');
    assert.equal(sizeMiss([file('a.mjs', 5000)], 'someone', {}), null, 'no goal, no miss');
  });

  it('counts no moved line: a pure move reads 0, a move plus an edit reads the edit, a file with no patch in full', () => {
    const held = rules(ROOT, 'config/quality.json');
    const body = Array.from({ length: 300 }, (_, i) => `line ${i}`);
    const patch = (sign, lines) => lines.map((l) => sign + l).join('\n');
    const from = { filename: 'old.test.mjs', additions: 0, deletions: 300, patch: patch('-', body) };
    // Indented in its new file: the trim still matches it.
    const to = { filename: 'new.test.mjs', additions: 300, deletions: 0, patch: patch('+', body.map((l) => `  ${l}`)) };
    assert.equal(movedPairs([from, to]), 300);
    assert.equal(sizeMiss([from, to], 'someone', held), null, 'a pure move of 600 changed lines');
    // 5 of the 300 lines rewritten on the way: 5 removed and 5 added are read, 10 in all.
    const edited = { ...to, patch: patch('+', [...body.slice(0, 295), 'a', 'b', 'c', 'd', 'e']) };
    assert.equal(600 - 2 * movedPairs([from, edited]), 10);
    assert.match(sizeMiss([from, { ...to, patch: undefined }], 'someone', held), /read 600 lines/, 'no patch counts in full');
  });

  it("parses git's patch, and passes #795's shape, one file moved into three, through main", () => {
    const body = Array.from({ length: 1500 }, (_, i) => `test line ${i}`);
    const moved = diffAt('795', [
      { name: 'tests/pages.test.mjs', sign: '-', lines: body },
      ...[0, 1, 2].map((n) => ({ name: `tests/pages-${n}.test.mjs`, sign: '+', lines: body.slice(n * 500, n * 500 + 500).map((l) => `  ${l}`) })),
    ]);
    const files = diffFiles(readFileSync(moved, 'utf8'));
    assert.deepEqual(files.map((f) => [f.filename, f.additions, f.deletions]), [['tests/pages.test.mjs', 0, 1500], ...[0, 1, 2].map((n) => [`tests/pages-${n}.test.mjs`, 500, 0])]);
    assert.deepEqual(run({ PR_BODY: CLEAN, PR_DIFF: moved }, ['--config', 'config/quality.json']), { code: 0, lines: [OK] }, '3000 changed lines, 0 read');
    // A removed line reading "-- x" shows as "--- x" after its hunk header: a line, not a file header.
    const dashes = diffFiles('diff --git a/x.md b/x.md\n--- a/x.md\n+++ b/x.md\n@@ -1 +1 @@\n--- x\n+++ y\n');
    assert.deepEqual(dashes, [{ filename: 'x.md', additions: 1, deletions: 1, patch: '--- x\n+++ y' }]);
    assert.deepEqual(diffFiles('diff --git a/old.mjs b/new.mjs\nsimilarity index 100%\nrename from old.mjs\nrename to new.mjs\n'), [{ filename: 'new.mjs', additions: 0, deletions: 0, patch: '' }], 'a pure rename');
  });

  it('exits 1 with one error line per miss, 0 when clean, and 0 with a warning when it cannot read', () => {
    const bad = run({ PR_BODY: 'No issue here.', PR_AUTHOR: 'someone', PR_DIFF: filesAt(10) });
    assert.equal(bad.code, 1);
    assert.equal(bad.lines.length, 2);
    assert.ok(bad.lines.every((l) => l.startsWith('::error::pr-gate: ')));
    assert.deepEqual(run({ PR_BODY: CLEAN, PR_DIFF: filesAt(10) }), { code: 0, lines: [OK] });
    const blind = run({});
    assert.deepEqual([blind.code, /^::warning::pr-gate: no PR_BODY/.test(blind.lines[0])], [0, true]);
    for (const argv of [['--config', 'no/such/file.json'], ['--config']]) {
      const lost = run({ PR_BODY: 'No issue here.' }, argv);
      assert.deepEqual([lost.code, /^::warning::pr-gate: could not read the targets/.test(lost.lines[0])], [0, true], argv.join(' '));
    }
  });

  it('fails an over-goal change in main, and skips only the size check when it cannot read the files', () => {
    const big = run({ PR_BODY: CLEAN, PR_DIFF: filesAt(201) }, ['--config', 'config/quality.json']);
    assert.equal(big.code, 1);
    assert.match(big.lines[0], /^::error::pr-gate: the change asks a reviewer to read 201 lines, goal 200: split it into a GitHub stack/);
    for (const PR_DIFF of [undefined, join(SCRATCH, 'missing.diff')]) {
      const blind = run({ PR_BODY: CLEAN, PR_DIFF }, ['--config', 'config/quality.json']);
      assert.equal(blind.code, 0, String(PR_DIFF));
      assert.match(blind.lines[0], /^::warning::pr-gate: could not read the changed files/);
    }
    rmSync(SCRATCH, { recursive: true, force: true });
  });
});
