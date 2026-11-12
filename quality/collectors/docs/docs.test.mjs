// node --test quality/collectors/docs/docs.test.mjs
// The fixture's expected values were counted by hand from quality/fixtures/docs/.
// Each test copies it to a temp dir, so git history and the lint stub are the test's own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  collect as collectDocs, areaFor, expandGlobs, slugify, npmScripts, pathTokens, folderMapRows, PARAMS,
} from './docs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const fixture = path.join(here, '../../fixtures/docs');

// The fixture repo keeps its own override in quality/targets/docs.json, as a
// repo would. Its params, folded as the engine folds them, are what the
// collector gets; a test edits that file to change one.
function paramsOf(root) {
  try {
    return Object.assign({}, ...JSON.parse(fs.readFileSync(path.join(root, 'quality/targets/docs.json'), 'utf8')).map((t) => t.params ?? {}));
  } catch {
    return {};
  }
}
const collect = ({ root, mode }) => collectDocs({ root, mode, params: paramsOf(root) });
const IDS = [
  'docs.dead_paths', 'docs.dead_scripts', 'docs.broken_links', 'docs.lint_warn', 'docs.markup_faults',
  'docs.stale_markers', 'docs.stale_dates', 'docs.oldest_lag_days', 'docs.unmapped',
  'docs.folder_coverage', 'docs.runbooks_verified', 'docs.community_files',
  'docs.over_read_goal', 'docs.interactive_share', 'docs.text_only',
  'docs.tokens_past_read_goal',
];
// Metrics that read their own inputs, not the doc set.
const OWN_INPUTS = ['docs.folder_coverage', 'docs.runbooks_verified', 'docs.community_files'];
const INTERACTIVE = ['mermaid diagram', 'mermaid chart (pie, xychart-beta)', '<details> block'];

const STUB = `import sys
print("guide/setup.md:5: WARN [demo] fixture finding")
print("README.md:3: FAIL [demo] fixture finding")
print("README.md:13: WARN [demo] fixture finding")
print("lint: 2 file(s) checked, 1 FAIL, 2 WARN")
sys.exit(1)
`;

// Isolated from the user's git config and from a hook's GIT_DIR.
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
Object.assign(gitEnv, {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
});
function commit(dir, message, date) {
  const env = { ...gitEnv, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  execFileSync('git', ['add', '-A'], { cwd: dir, env });
  execFileSync('git', ['commit', '-q', '-m', message], { cwd: dir, env });
}

function copyFixture({ withGit = true, stub = STUB } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-fixture-'));
  fs.cpSync(fixture, dir, { recursive: true });
  if (stub != null) {
    fs.mkdirSync(path.join(dir, 'tools'));
    fs.writeFileSync(path.join(dir, 'tools/lint.py'), stub);
  }
  if (withGit) {
    execFileSync('git', ['init', '-q'], { cwd: dir, env: gitEnv });
    commit(dir, 'A: everything (#1)', '2026-01-10T12:00:00Z');
    fs.appendFileSync(path.join(dir, 'tools/lint.py'), '# touched\n');
    commit(dir, 'D: the CONTRIBUTING area (#2)', '2026-01-13T12:00:00Z');
    fs.appendFileSync(path.join(dir, 'src/app.txt'), 'changed\n');
    commit(dir, 'Merge pull request #3 from fixture/b', '2026-01-20T12:00:00Z');
    fs.appendFileSync(path.join(dir, 'README.md'), '\n');
    commit(dir, 'C: README after its area (#4)', '2026-01-25T12:00:00Z');
  }
  return dir;
}

// Rewrites the copied targets file; `edit` gets the parsed list.
function editTargets(dir, edit) {
  const file = path.join(dir, 'quality/targets/docs.json');
  const targets = JSON.parse(fs.readFileSync(file, 'utf8'));
  edit(targets, (key) => targets.find((t) => t.params && key in t.params).params[key]);
  fs.writeFileSync(file, JSON.stringify(targets));
}

const value = (r, id) => {
  assert.ok(r[id], `${id} missing`);
  assert.equal(r[id].could_not_check, undefined, `${id}: ${r[id].could_not_check}`);
  return r[id].value;
};
const cnc = (r, id) => {
  assert.equal(typeof r[id]?.could_not_check, 'string', `${id} should be could_not_check, got ${JSON.stringify(r[id])}`);
  assert.equal(r[id].value, undefined, `${id} must not carry a value when it could not check`);
};

test('known-good fixture returns the hand-counted values', async () => {
  const r = await collect({ root: copyFixture(), mode: 'local' });
  assert.deepEqual(Object.keys(r).sort(), [...IDS].sort());

  // 10 words a minute: setup 28, CONTRIBUTING 26, README 18, notes 14 words.
  // Over the 2-minute goal (20 words): setup and CONTRIBUTING.
  assert.equal(value(r, 'docs.over_read_goal'), 2);
  assert.deepEqual(r['docs.over_read_goal'].detail, [{ label: 'guide/', value: 1 }, { label: 'repo root', value: 1 }]);
  // Tokens past the goal, bytes / 4 times the share of words past 20:
  // CONTRIBUTING 282 bytes, 70.5 x 6/26 = 16; setup 216 bytes, 54 x 8/28 = 15.
  assert.equal(value(r, 'docs.tokens_past_read_goal'), 31);
  assert.deepEqual(r['docs.tokens_past_read_goal'].detail, [
    { label: 'CONTRIBUTING.md', value: 16, unit: 'tokens' }, { label: 'guide/setup.md', value: 15, unit: 'tokens' },
  ]);
  // Lag: setup trails src/ by 10 days, CONTRIBUTING trails tools/ by 3, README is newer than its area.
  // The oldest single lag, not the mean (4.3 days): setup.md's 10.
  assert.equal(value(r, 'docs.oldest_lag_days'), 10);
  assert.match(r['docs.oldest_lag_days'].source, /trails its area most, guide\/setup\.md$/);
  assert.deepEqual(r['docs.oldest_lag_days'].detail, [
    { label: 'guide/setup.md', value: 10 }, { label: 'CONTRIBUTING.md', value: 3 }, { label: 'README.md', value: 0 },
  ]);
  // Every doc maps, and src/, package.json and {dir}/tools/ (./tools/) each match a tracked file.
  assert.equal(value(r, 'docs.unmapped'), 0);
  assert.deepEqual(r['docs.unmapped'].detail, []);
  // TODO in README; "waits for" in CONTRIBUTING (not the TODO in its comment); "upcoming" in setup.
  assert.equal(value(r, 'docs.stale_markers'), 3);
  assert.deepEqual(r['docs.stale_markers'].detail.map((d) => d.label).sort(), ['CONTRIBUTING.md', 'README.md', 'guide/setup.md']);
  // setup's date is older than src/'s last change; notes has no area, so its date is not judged.
  assert.equal(value(r, 'docs.stale_dates'), 1);
  assert.deepEqual(r['docs.stale_dates'].detail, [
    { label: 'guide/setup.md:5 current as of 2026-01-01, area changed 2026-01-20', value: 19, unit: 'days' },
  ]);
  assert.match(r['docs.stale_dates'].source, /^1 "current as of", "last verified" dates/);
  assert.equal(value(r, 'docs.broken_links'), 2);
  assert.deepEqual(r['docs.broken_links'].detail, [
    { label: 'relative links checked', value: 5 },
    { label: 'CONTRIBUTING.md:13 #nowhere', value: 1 },
    { label: 'README.md:13 guide/gone.md', value: 1 },
  ]);
  // src/app.txt exists, src/build/out.js is git-ignored, src/gone.txt is dead.
  assert.equal(value(r, 'docs.dead_paths'), 1);
  assert.deepEqual(r['docs.dead_paths'].detail, [
    { label: 'repo paths checked', value: 3 }, { label: 'CONTRIBUTING.md:10 src/gone.txt', value: 1 },
  ]);
  // README's code block runs npm test, which the root package.json defines.
  assert.equal(value(r, 'docs.dead_scripts'), 0);
  assert.deepEqual(r['docs.dead_scripts'].detail, [{ label: 'npm script references checked', value: 1 }]);
  // Seven folders; facts, guide and src are in the map (src by a src/tool/ row), img has a README.
  assert.equal(value(r, 'docs.folder_coverage'), 57.1);
  assert.deepEqual(r['docs.folder_coverage'].detail, [
    { label: 'extra/ (neither)', value: 0, unit: '' }, { label: 'quality/ (neither)', value: 0, unit: '' },
    { label: 'tools/ (neither)', value: 0, unit: '' }, { label: 'facts/ (folder map)', value: 1, unit: '' },
    { label: 'guide/ (folder map)', value: 1, unit: '' }, { label: 'img/ (README)', value: 1, unit: '' },
    { label: 'src/ (folder map)', value: 1, unit: '' },
  ]);
  // a.md carries two dates (the newest shows), b.md none, c.md only inside code.
  assert.equal(value(r, 'docs.runbooks_verified'), 33.3);
  assert.deepEqual(r['docs.runbooks_verified'].detail, [
    { label: 'facts/runbooks/b.md (no date)', value: 0, unit: '' },
    { label: 'facts/runbooks/c.md (no date)', value: 0, unit: '' },
    { label: 'facts/runbooks/a.md (2026-01-05)', value: 1, unit: '' },
  ]);
  assert.equal(value(r, 'docs.lint_warn'), 2);
  assert.deepEqual(r['docs.lint_warn'].detail.slice(0, 2), [
    { label: 'docs checked', value: 2, unit: 'docs' }, { label: 'docs outside lint scope', value: 2, unit: 'docs' },
  ]);
  // Visual lines: README 6 of 9, setup 3 of 8 (image and indented code), CONTRIBUTING 0 of 5, notes 0 of 2.
  // Under 20% visual: CONTRIBUTING and notes.
  assert.equal(value(r, 'docs.text_only'), 2);
  assert.deepEqual(r['docs.text_only'].detail, [{ label: 'guide/', value: 1 }, { label: 'repo root', value: 1 }]);
  // Community files: README.md and CONTRIBUTING.md are there, LICENSE and a code of conduct are not.
  assert.equal(value(r, 'docs.community_files'), 50);
  assert.deepEqual(r['docs.community_files'].detail, [
    { label: 'Code of conduct (missing)', value: 0, unit: '' }, { label: 'License (missing)', value: 0, unit: '' },
    { label: 'Contributing guide (CONTRIBUTING.md)', value: 1, unit: '' }, { label: 'README (README.md)', value: 1, unit: '' },
  ]);
  // Markup: 5 headings, none skipped or repeated, and setup's one image, whose
  // alt text "diagram" is 7 characters against the fixture's limit of 5.
  assert.equal(value(r, 'docs.markup_faults'), 1);
  assert.deepEqual(r['docs.markup_faults'].detail, [
    { label: 'headings and images checked', value: 6 }, { label: 'guide/setup.md:7 alt text of 7 characters', value: 1 },
  ]);
  // No doc here has an interactive element: a measured 0, not could_not_check.
  assert.equal(value(r, 'docs.interactive_share'), 0);
  assert.deepEqual(r['docs.interactive_share'].detail, INTERACTIVE.map((label) => ({ label, value: 0, unit: '' })));
  for (const id of IDS) {
    assert.match(r[id].read_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(r[id].source);
  }
});

test('the fact checks: npm scripts, decision numbers, paths in code and dated claims', async () => {
  const dir = copyFixture();
  editTargets(dir, (_, param) => { param('doc_set').splice(0, Infinity, 'facts/*.md'); });
  const r = await collect({ root: dir, mode: 'local' });
  // Seven npm script references; --if-present, npm ci, pnpm and the ledger (a record) are not checked.
  assert.equal(value(r, 'docs.dead_scripts'), 3);
  assert.deepEqual(r['docs.dead_scripts'].detail, [
    { label: 'npm script references checked', value: 7 },
    { label: 'facts/run.md:7 build in src/tool', value: 1 },
    { label: 'facts/run.md:8 lint:docs in @fx/nope (no such workspace)', value: 1 },
    { label: 'facts/run.md:9 gone:script', value: 1 },
  ]);
  assert.match(r['docs.dead_scripts'].source, /package\.json, src\/tool\/package\.json/);
  // Words of code spans and code lines: src/tool and src/app.txt exist, src/build/out.js is ignored,
  // and the ledger's src/old.txt is history in a record.
  assert.equal(value(r, 'docs.dead_paths'), 2);
  assert.deepEqual(r['docs.dead_paths'].detail, [
    { label: 'repo paths checked', value: 5 },
    { label: 'facts/run.md:21 tools/missing.py', value: 1 },
    { label: 'facts/run.md:23 facts/gone.md', value: 1 },
  ]);
  // dated.md covers src/ (last changed 2026-01-20); the date inside code does not count.
  assert.equal(value(r, 'docs.stale_dates'), 2);
  assert.deepEqual(r['docs.stale_dates'].detail, [
    { label: 'facts/dated.md:7 Last verified 2026-01-01, area changed 2026-01-20', value: 19, unit: 'days' },
    { label: 'facts/dated.md:3 Current as of 2026-01-15, area changed 2026-01-20', value: 5, unit: 'days' },
  ]);
  assert.match(r['docs.stale_dates'].source, /^3 "current as of"/);
});

test('fact checks with an input missing: could not check, never 0', async () => {
  const dir = copyFixture({ withGit: false });
  fs.rmSync(path.join(dir, 'package.json'));
  fs.rmSync(path.join(dir, 'FOLDERS.md'));
  editTargets(dir, (_, param) => { param('runbooks').splice(0, Infinity, 'nothing/*.md'); });
  const r = await collect({ root: dir, mode: 'local' });
  for (const id of ['docs.dead_scripts', 'docs.folder_coverage', 'docs.runbooks_verified']) cnc(r, id);
  assert.match(r['docs.dead_scripts'].could_not_check, /package\.json/);
  assert.equal(value(r, 'docs.over_read_goal'), 2);

  // A workspace that is not JSON, a folder map with no such heading.
  fs.cpSync(path.join(fixture, 'package.json'), path.join(dir, 'package.json'));
  fs.writeFileSync(path.join(dir, 'src/tool/package.json'), '{ not json');
  fs.writeFileSync(path.join(dir, 'FOLDERS.md'), '# Folders\n\n## Elsewhere\n\n- `src/`\n');
  const again = await collect({ root: dir, mode: 'local' });
  for (const id of ['docs.dead_scripts', 'docs.folder_coverage']) cnc(again, id);
  assert.match(again['docs.dead_scripts'].could_not_check, /src\/tool\/package\.json/);
  assert.match(again['docs.folder_coverage'].could_not_check, /no "Folder map" heading/);

  // Params gone from the targets file.
  editTargets(dir, (targets) => {
    for (const t of targets) {
      for (const k of ['verified', 'folder_map', 'as_of', 'words_per_minute', 'text_only_below', 'lint', 'community_files', 'alt_max_chars']) delete t.params[k];
    }
  });
  const bare = await collect({ root: dir, mode: 'local' });
  for (const id of [
    'docs.runbooks_verified', 'docs.folder_coverage', 'docs.stale_dates', 'docs.over_read_goal',
    'docs.text_only', 'docs.lint_warn', 'docs.tokens_past_read_goal', 'docs.community_files', 'docs.markup_faults',
  ]) {
    cnc(bare, id);
  }
});

test('folder coverage skips dot folders and git-ignored folders', async () => {
  const dir = copyFixture();
  for (const d of ['.hidden', 'build']) {
    fs.mkdirSync(path.join(dir, d));
    fs.writeFileSync(path.join(dir, d, 'x.txt'), 'x\n');
  }
  const r = await collect({ root: dir, mode: 'local' });
  assert.equal(value(r, 'docs.folder_coverage'), 57.1);
  assert.equal(r['docs.folder_coverage'].detail.length, 7);
});

test('interactive elements: counted by type outside code; mermaid lines count as visual', async () => {
  const dir = copyFixture({ withGit: false });
  editTargets(dir, (_, param) => { param('doc_set').splice(0, Infinity, 'extra/*.md', 'README.md'); });
  const r = await collect({ root: dir, mode: 'local' });
  // extra/interactive.md has every type; README.md has none. The ```text block's
  // <details> does not count, nor do task items or a table row with a link:
  // a link is not something to open, pan or zoom. The flowchart is a diagram,
  // the pie and the xychart are charts.
  assert.equal(value(r, 'docs.interactive_share'), 50);
  assert.deepEqual(r['docs.interactive_share'].detail, [1, 2, 1].map((v, i) => ({ label: INTERACTIVE[i], value: v, unit: '' })));
  // interactive.md: 4 table lines and 23 lines in four fences, of 34 non-blank (79.4%), so not text-only.
  assert.equal(value(r, 'docs.text_only'), 0);

  // params.agent_docs: a doc written for an agent is no reader doc, so only
  // extra/interactive.md is counted. A malformed list, or one that names
  // every doc, could not check.
  const agentDocs = (list) => editTargets(dir, (targets) => { targets.find((t) => t.params.mermaid_charts).params.agent_docs = list; });
  agentDocs([{ glob: 'README.md', why: 'loaded by an agent' }]);
  const readers = await collect({ root: dir, mode: 'local' });
  assert.equal(value(readers, 'docs.interactive_share'), 100);
  assert.match(readers['docs.interactive_share'].source, /^1 reader docs/);
  agentDocs([{ glob: 'README.md' }]);
  cnc(await collect({ root: dir, mode: 'local' }), 'docs.interactive_share');
  agentDocs([{ glob: '**', why: 'every doc' }]);
  cnc(await collect({ root: dir, mode: 'local' }), 'docs.interactive_share');

  editTargets(dir, (targets) => { delete targets.find((t) => t.params.mermaid_charts).params; });
  cnc(await collect({ root: dir, mode: 'local' }), 'docs.interactive_share');
});

test('markup faults: a skipped level, a second H1, a repeated heading and images with no alt text', async () => {
  const dir = copyFixture({ withGit: false });
  fs.writeFileSync(path.join(dir, 'guide/markup.md'), [
    '# Markup',
    '',
    '### Skips a level',
    '',
    '## Twice',
    '',
    '## twice',
    '',
    '# A second H1',
    '',
    '![](../img/flow.svg) and <img src="../img/flow.svg"> and <img src="../img/flow.svg" alt="ok">',
    "<img src='../img/flow.svg' alt='ok'> and <img src=../img/flow.svg alt=ok> and <img data-alt=\"no\" src=\"../img/flow.svg\">",
    '',
    '## Under the second H1',
    '',
    '### Twice',
    '',
    '```md',
    '#### not a heading',
    '![](not-an-image.png)',
    '```',
    '',
  ].join('\n'));
  const r = await collect({ root: dir, mode: 'local' });
  // The new doc's four heading faults and two images with no alt text, beside
  // setup's long alt text. What sits in the code block is not read.
  assert.deepEqual(r['docs.markup_faults'].detail.slice(1).map((d) => d.label), [
    'guide/markup.md:3 heading level 1 to 3',
    'guide/markup.md:7 repeated heading "twice"',
    'guide/markup.md:9 second H1',
    'guide/markup.md:11 image with no alt text',
    'guide/markup.md:11 image with no alt text',
    'guide/markup.md:12 image with no alt text',
    'guide/setup.md:7 alt text of 7 characters',
  ]);
  // Line 12: an alt in single quotes or bare counts, data-alt does not. The
  // H3 "Twice" is no repeat of the H2s: a repeat is the same level, page-wide.
  assert.equal(value(r, 'docs.markup_faults'), 7);
  // A file at a later glob counts: the contributing guide moves to docs/.
  fs.mkdirSync(path.join(dir, 'docs'));
  fs.renameSync(path.join(dir, 'CONTRIBUTING.md'), path.join(dir, 'docs/CONTRIBUTING.md'));
  fs.writeFileSync(path.join(dir, 'LICENSE'), 'A license.\n');
  const moved = await collect({ root: dir, mode: 'local' });
  assert.equal(value(moved, 'docs.community_files'), 75);
  // A malformed list could not check, never 0.
  editTargets(dir, (targets) => { targets.find((t) => t.params.community_files).params.community_files = [{ name: 'README' }]; });
  cnc(await collect({ root: dir, mode: 'local' }), 'docs.community_files');
});

test('params.doc_set_left_out drops its globs; a malformed list could not check', async () => {
  const dir = copyFixture({ withGit: false });
  editTargets(dir, (targets) => {
    targets.find((t) => t.params.doc_set).params.doc_set_left_out = [{ glob: 'guide/notes.md', why: 'a record' }];
  });
  const r = await collect({ root: dir, mode: 'local' });
  // notes (0% visual) is left out, so only CONTRIBUTING is text-only.
  assert.deepEqual(r['docs.text_only'].detail, [{ label: 'repo root', value: 1 }]);
  editTargets(dir, (_, param) => { param('doc_set_left_out').push('guide/setup.md'); });
  const bad = await collect({ root: dir, mode: 'local' });
  for (const id of IDS.filter((i) => !OWN_INPUTS.includes(i))) cnc(bad, id);
  assert.match(bad['docs.text_only'].could_not_check, /doc_set_left_out/);
});

test('no git history: lag, dated claims, ignore checks and folders could not check; the rest still measure', async () => {
  const r = await collect({ root: copyFixture({ withGit: false }), mode: 'ci' });
  for (const id of ['docs.oldest_lag_days', 'docs.unmapped', 'docs.stale_dates', 'docs.dead_paths', 'docs.folder_coverage']) cnc(r, id);
  assert.match(r['docs.stale_dates'].could_not_check, /^2 dated claim/);
  assert.equal(value(r, 'docs.stale_markers'), 3);
  assert.equal(value(r, 'docs.over_read_goal'), 2);
  assert.equal(value(r, 'docs.broken_links'), 2);
  assert.equal(value(r, 'docs.dead_scripts'), 0);
  assert.equal(value(r, 'docs.runbooks_verified'), 33.3);
});

test('docs.unmapped names a doc with no params.areas entry and an area path no tracked file matches', async () => {
  const dir = copyFixture();
  // SECURITY.md is in the doc set with no areas entry; README's lib/ does not exist.
  fs.writeFileSync(path.join(dir, 'SECURITY.md'), '# Security\n');
  editTargets(dir, (_, param) => { param('areas').find((a) => a.doc === 'README.md').area.push('lib/'); });
  const r = await collect({ root: dir, mode: 'ci' });
  assert.equal(value(r, 'docs.unmapped'), 2);
  assert.deepEqual(r['docs.unmapped'].detail, [
    { label: 'SECURITY.md (no params.areas entry)', value: 1 },
    { label: 'lib/ (area of README.md) matches no tracked file', value: 1 },
  ]);
  // An untracked area is dead too: the lag check reads it through git.
  fs.mkdirSync(path.join(dir, 'lib'));
  fs.writeFileSync(path.join(dir, 'lib/new.txt'), 'not committed\n');
  assert.equal(value(await collect({ root: dir, mode: 'ci' }), 'docs.unmapped'), 2);
});

test('bad areas entries, a record and an area that matches only its doc', async () => {
  const dir = copyFixture();
  // missing/only/x.md sits alone in its folder, so {dir}/ matches only itself.
  fs.mkdirSync(path.join(dir, 'missing/only'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'missing/only/x.md'), '# Alone\n');
  commit(dir, 'E: a doc alone in its folder (#5)', '2026-01-26T12:00:00Z');
  editTargets(dir, (_, param) => {
    const areas = param('areas');
    const entry = (doc) => areas.find((a) => a.doc === doc);
    entry('README.md').area = ['README.md'];
    entry('CONTRIBUTING.md').area = [42];
    entry('guide/setup.md').area = 'src/';
    areas.push({ doc: 'missing/**', area: ['{dir}/'] });
  });
  const r = await collect({ root: dir, mode: 'ci' });
  // guide/notes.md maps to [] (a record), so it passes.
  assert.deepEqual(r['docs.unmapped'].detail.map((d) => d.label).sort(), [
    'CONTRIBUTING.md (its params.areas entry "CONTRIBUTING.md" needs area: a list of paths)',
    'README.md (its area README.md matches only the doc)',
    'guide/setup.md (its params.areas entry "guide/setup.md" needs area: a list of paths)',
    'missing/only/x.md (its area missing/only/ matches only the doc)',
  ]);
  // A bad entry is named, never a throw that turns every docs metric off.
  assert.equal(value(r, 'docs.stale_markers'), 3);
});

test('an area is judged whole, as the lag check reads it: a lone folder beside other paths passes', async () => {
  const dir = copyFixture();
  // a.md is alone in missing/notes/, but its area also names src/; b.md's area
  // is that folder, which holds a.md, not b.md. Both docs have a lag to read.
  fs.mkdirSync(path.join(dir, 'missing/notes'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'missing/notes/a.md'), '# A\n');
  fs.writeFileSync(path.join(dir, 'missing/b.md'), '# B\n');
  commit(dir, 'F: a lone note and a doc about it (#6)', '2026-01-27T12:00:00Z');
  editTargets(dir, (_, param) => {
    param('areas').push({ doc: 'missing/notes/a.md', area: ['{dir}/', 'src/'] }, { doc: 'missing/b.md', area: ['missing/notes/'] });
  });
  const r = await collect({ root: dir, mode: 'ci' });
  assert.equal(value(r, 'docs.unmapped'), 0, JSON.stringify(r['docs.unmapped'].detail));
});

test('an exclude that narrows an area to only its doc is flagged, as the lag check would skip it (#139)', async () => {
  const dir = copyFixture();
  // missing/notes/ holds a.md and old.txt; the area excludes old.txt, so
  // git log -- missing/notes/ ':(exclude)…old.txt' ':(exclude)…a.md' is empty.
  fs.mkdirSync(path.join(dir, 'missing/notes'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'missing/notes/a.md'), '# A\n');
  fs.writeFileSync(path.join(dir, 'missing/notes/old.txt'), 'old\n');
  commit(dir, 'G: a note and an old file (#7)', '2026-01-28T12:00:00Z');
  editTargets(dir, (_, param) => {
    param('areas').push({ doc: 'missing/notes/a.md', area: ['{dir}/', ':(exclude)missing/notes/old.txt'] });
  });
  let r = await collect({ root: dir, mode: 'ci' });
  assert.equal(value(r, 'docs.unmapped'), 1);
  assert.deepEqual(r['docs.unmapped'].detail.map((d) => d.label), [
    'missing/notes/a.md (its area missing/notes/, :(exclude)missing/notes/old.txt matches only the doc)',
  ]);
  // One more tracked file the exclude leaves in: the area has a lag to read.
  fs.writeFileSync(path.join(dir, 'missing/notes/new.txt'), 'new\n');
  commit(dir, 'H: a new file beside the note (#8)', '2026-01-29T12:00:00Z');
  r = await collect({ root: dir, mode: 'ci' });
  assert.equal(value(r, 'docs.unmapped'), 0);
});

// public/ is exported as another repo's root (params.overlays, onto ""): its
// links are written for that root. Its CONTRIBUTING.md is the public copy,
// with a heading the repo's own CONTRIBUTING.md lacks.
function overlayFixture(overlays) {
  const dir = copyFixture();
  fs.mkdirSync(path.join(dir, 'public'));
  fs.writeFileSync(path.join(dir, 'public/CONTRIBUTING.md'), '# Contributing\n\n## Public only\n\nHow to help.\n');
  fs.writeFileSync(path.join(dir, 'public/README.md'), [
    '# Public',
    '',
    'Run [the lint](tools/lint.py) on [the app](/src/app.txt).',
    'Read [how to help](CONTRIBUTING.md#public-only).',
    'This one is [gone](nowhere/file.md), and this one [climbs out](../outside.md).',
    '',
    'The lint is `tools/lint.py`; the old app was `src/gone.txt`.',
    '',
  ].join('\n'));
  editTargets(dir, (targets, param) => {
    param('doc_set').push('public/**/*.md');
    if (overlays !== undefined) targets.find((t) => t.params).params.overlays = overlays;
  });
  return dir;
}
const PUBLIC = [{ dir: 'public/', onto: '', why: 'exported as the public repo root' }];
const inPublic = (r, id) => r[id].detail.map((d) => d.label).filter((l) => l.startsWith('public/'));

test('params.overlays: an exported folder resolves links from its export root, overlay first', async () => {
  const r = await collect({ root: overlayFixture(PUBLIC), mode: 'ci' });
  // tools/lint.py and /src/app.txt resolve at the root; the anchor is read
  // from public/CONTRIBUTING.md, the overlay's copy. Real breaks still count.
  assert.deepEqual(inPublic(r, 'docs.broken_links'), ['public/README.md:5 nowhere/file.md', 'public/README.md:5 ../outside.md']);
  assert.match(r['docs.broken_links'].source, /under public\/ \(as the root\), overlay first, then the repository \(params\.overlays\)$/);
  // The same lookup for paths named in code: tools/lint.py is found, src/gone.txt is dead.
  assert.deepEqual(inPublic(r, 'docs.dead_paths'), ['public/README.md:7 src/gone.txt']);
  // Without the overlay, tools/lint.py resolves from public/ and breaks.
  const plain = await collect({ root: overlayFixture(), mode: 'ci' });
  assert.deepEqual(inPublic(plain, 'docs.broken_links'), ['public/README.md:3 tools/lint.py', 'public/README.md:5 nowhere/file.md', 'public/README.md:5 ../outside.md']);
});

test('params.overlays: a malformed entry makes the link metrics could not check, never a silent pass', async () => {
  for (const [overlays, reason] of [
    [[{ dir: 'public/', onto: '' }], /params\.overlays\[0\] needs dir, onto and why/],
    [[{ dir: 'nope/', onto: '', why: 'x' }], /params\.overlays\[0\]: nope\/ matches no file/],
    [[{ dir: '../public/', onto: '', why: 'x' }], /params\.overlays\[0\]: dir must be a folder inside the repo/],
    [{ dir: 'public/' }, /params\.overlays must be a list/],
    // onto must be an existing folder, or dead paths would be skipped silently.
    [[{ dir: 'public/', onto: 'nope', why: 'x' }], /params\.overlays\[0\]: onto nope is no folder in the repo/],
    // An absolute path is refused before any trimming; the root is no overlay.
    [[{ dir: '/etc', onto: '', why: 'x' }], /params\.overlays\[0\]: dir and onto are paths inside the repo, never absolute ones/],
    [[{ dir: 'public/', onto: '/', why: 'x' }], /never absolute ones/],
    ...['.', './', 'public/..'].map((dir) => [[{ dir, onto: '', why: 'x' }], /dir must be a folder inside the repo other than its root/]),
  ]) {
    const r = await collect({ root: overlayFixture(overlays), mode: 'ci' });
    for (const id of ['docs.broken_links', 'docs.dead_paths']) {
      cnc(r, id);
      assert.match(r[id].could_not_check, reason, id);
    }
    assert.equal(value(r, 'docs.stale_markers'), 3, 'the other metrics still read');
  }
});

test('params.overlays: a path git ignores in the overlay or in onto is not dead', async () => {
  const dir = overlayFixture(PUBLIC);
  // public/dist/ holds a build; app.js is not built yet, and the overlay's
  // .gitignore line covers it. The root has no dist/ at all.
  fs.mkdirSync(path.join(dir, 'public/dist'));
  fs.writeFileSync(path.join(dir, 'public/dist/other.js'), '');
  fs.appendFileSync(path.join(dir, 'public/README.md'), 'The build writes `dist/app.js`.\n');
  let r = await collect({ root: dir, mode: 'ci' });
  assert.deepEqual(inPublic(r, 'docs.dead_paths'), ['public/README.md:7 src/gone.txt', 'public/README.md:8 dist/app.js']);
  fs.appendFileSync(path.join(dir, '.gitignore'), 'public/dist/\n');
  r = await collect({ root: dir, mode: 'ci' });
  assert.deepEqual(inPublic(r, 'docs.dead_paths'), ['public/README.md:7 src/gone.txt']);
});

test('params.overlays: a dir or onto that a symlink points outside the repo is refused', async (t) => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-outside-'));
  fs.writeFileSync(path.join(outside, 'secret.md'), '# Not this repo\n');
  for (const key of ['dir', 'onto']) {
    const dir = overlayFixture();
    try {
      fs.symlinkSync(outside, path.join(dir, 'away'), 'dir');
    } catch (e) {
      return t.skip(`no symlinks here (${e.code})`);
    }
    editTargets(dir, (targets) => {
      targets.find((x) => x.params).params.overlays = [{ dir: key === 'dir' ? 'away/' : 'public/', onto: key === 'onto' ? 'away' : '', why: 'x' }];
    });
    const r = await collect({ root: dir, mode: 'ci' });
    for (const id of ['docs.broken_links', 'docs.dead_paths']) assert.match(r[id].could_not_check ?? '', new RegExp(`params\\.overlays\\[0\\]: ${key} away/? resolves outside the repo`), `${key} ${id}`);
  }
});

test('a missed gate: collect.mjs writes the run, names each row, then exits 3 (2 stays a usage error)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-gate-'));
  fs.mkdirSync(path.join(dir, 'guide'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.mkdirSync(path.join(dir, 'quality/targets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), '# Fixture\n');
  fs.writeFileSync(path.join(dir, 'guide/a.md'), '# A\n');
  fs.writeFileSync(path.join(dir, 'src/app.txt'), 'app\n');
  fs.writeFileSync(path.join(dir, 'quality/config.json'), JSON.stringify({ tabs: ['documentation'] }));
  const areas = (list) => fs.writeFileSync(path.join(dir, 'quality/targets/docs.json'), JSON.stringify([{ id: 'docs.dead_paths', params: { areas: list } }]));
  areas([{ doc: 'README.md', area: ['src/'] }]);
  execFileSync('git', ['init', '-q'], { cwd: dir, env: gitEnv });
  commit(dir, 'A: fixture (#1)', '2026-01-10T12:00:00Z');
  const run = () => spawnSync(process.execPath, [path.join(repo, 'quality/collect.mjs'), '--out', path.join(dir, 'run.json')], { cwd: dir, env: gitEnv, encoding: 'utf8' });
  let got = run();
  assert.equal(got.status, 3, got.stderr);
  assert.match(got.stderr, /::error::quality: docs\.unmapped is 1, goal 0: guide\/a\.md \(no params\.areas entry\)/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8')).metrics['docs.unmapped'].value, 1, 'the run is written before the exit');
  // guide/a.md is alone in guide/, so {dir}/ would match only itself: src/.
  areas([{ doc: 'README.md', area: ['src/'] }, { doc: 'guide/*.md', area: ['src/'] }]);
  got = run();
  assert.equal(got.status, 0, got.stderr);
});

test('no params at all, or no repo: every metric could not check, nothing throws', async () => {
  const dir = copyFixture({ withGit: false });
  fs.rmSync(path.join(dir, 'quality/targets/docs.json'));
  const r = await collect({ root: dir, mode: 'local' });
  assert.deepEqual(Object.keys(r).sort(), [...IDS].sort());
  for (const id of IDS) cnc(r, id);
  const gone = await collectDocs({ root: path.join(dir, 'no-such-dir'), mode: 'local' });
  for (const id of IDS) cnc(gone, id);
});

test("the template's defaults on the fixture: every markdown file, less build and left-out folders", async () => {
  const dir = copyFixture();
  fs.mkdirSync(path.join(dir, 'node_modules/pkg'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules/pkg/README.md'), '# vendored\n');
  fs.mkdirSync(path.join(dir, 'quality/fixtures'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'quality/fixtures/x.md'), '# fixture\n');
  const r = await collectDocs({ root: dir, mode: 'local' });
  // The fixture's 12 markdown files; node_modules/ is skipped and quality/fixtures/x.md left out.
  assert.match(r['docs.over_read_goal'].source, /over 12 docs/);
  // The default area is each doc's own folder. extra/interactive.md is alone in
  // extra/, so its area has no other history: 11 of the 12 docs have a lag.
  assert.equal(r['docs.oldest_lag_days'].detail.length, 11);
  // No content lint is named, and README.md has no folder map: not measured, never 0.
  cnc(r, 'docs.lint_warn');
  cnc(r, 'docs.folder_coverage');
  // **/runbooks/*.md finds the fixture's three runbooks.
  assert.equal(value(r, 'docs.runbooks_verified'), 33.3);
});

test('lint missing, exiting 3 or checking nothing: could not check, never 0', async () => {
  const missing = await collect({ root: copyFixture({ withGit: false, stub: null }), mode: 'local' });
  cnc(missing, 'docs.lint_warn');
  const infra = await collect({
    root: copyFixture({ withGit: false, stub: 'import sys\nprint("INFRA: rules unreadable", file=sys.stderr)\nsys.exit(3)\n' }),
    mode: 'local',
  });
  cnc(infra, 'docs.lint_warn');
  assert.match(infra['docs.lint_warn'].could_not_check, /exited 3/);
  const none = await collect({
    root: copyFixture({ withGit: false, stub: 'print("lint: 0 file(s) checked, 0 FAIL, 0 WARN")\n' }),
    mode: 'local',
  });
  cnc(none, 'docs.lint_warn');
});

test("Git Crafter's voice_lint.py is a content lint docs.lint_warn reads: its last line is the summary", async () => {
  const dir = copyFixture({ withGit: false, stub: null });
  fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
  fs.copyFileSync(path.join(repo, 'tools/voice_lint.py'), path.join(dir, 'tools/voice_lint.py'));
  const params = { ...paramsOf(dir), lint: { interpreter: 'python3', script: 'tools/voice_lint.py', args: [] } };
  const r = await collectDocs({ root: dir, mode: 'local', params });
  // The lint's own summary of the same docs is the number docs.lint_warn shows.
  const docs = expandGlobs(dir, params.doc_set);
  const own = execFileSync('python3', ['-I', 'tools/voice_lint.py', ...docs], { cwd: dir, encoding: 'utf8' }).trim().split('\n').at(-1);
  const [, checked, , warns] = /^voice_lint: (\d+) file\(s\) checked, (\d+) FAIL, (\d+) WARN$/.exec(own);
  assert.equal(value(r, 'docs.lint_warn'), Number(warns));
  assert.deepEqual(r['docs.lint_warn'].detail.slice(0, 2), [
    { label: 'docs checked', value: Number(checked), unit: 'docs' }, { label: 'docs outside lint scope', value: 0, unit: 'docs' },
  ]);
  // Git Crafter's own override names it, so its Documentation tab reads its lint.
  const own_override = JSON.parse(fs.readFileSync(path.join(repo, 'config/quality/targets/docs.json'), 'utf8'));
  const lint = Object.assign({}, ...own_override.map((t) => t.params ?? {})).lint;
  assert.equal(lint.script, 'tools/voice_lint.py');
  assert.ok(fs.existsSync(path.join(repo, lint.script)));
});

test('a doc set that matches nothing: doc metrics could not check, metrics with their own inputs still count', async () => {
  const dir = copyFixture();
  editTargets(dir, (_, param) => { param('doc_set').splice(0, Infinity, 'nothing/*.md'); });
  const r = await collect({ root: dir, mode: 'local' });
  assert.equal(value(r, 'docs.folder_coverage'), 57.1);
  assert.equal(value(r, 'docs.runbooks_verified'), 33.3);
  assert.equal(value(r, 'docs.community_files'), 50);
  for (const id of IDS.filter((i) => !OWN_INPUTS.includes(i))) cnc(r, id);
});

test('GitHub heading slugs', () => {
  assert.equal(slugify('Install it'), 'install-it');
  assert.equal(slugify('Wave 1b: Lanes (`L7`)'), 'wave-1b-lanes-l7');
  assert.equal(slugify('[Link](x.md) and snake_case'), 'link-and-snake_case');
});

test('the parsers behind the fact checks', () => {
  assert.deepEqual(npmScripts('cd site && npm run -w @cs/site test:content -- --x; npm t'), [
    { name: 'test:content', ws: '@cs/site' }, { name: 'test', ws: null },
  ]);
  assert.deepEqual(npmScripts('npm --prefix=site run build; npm -ws run lint; npm run'), [
    { name: 'build', ws: 'site' }, { name: 'lint', ws: '*' },
  ]);
  assert.deepEqual(npmScripts('npm run -w; npm install x; pnpm run y; npm run <name>'), []);
  assert.deepEqual(pathTokens('python3 tools/x.py --root=site/dist ops/a.md:12 b.py::test_c, c.mjs:43-44'),
    ['python3', 'tools/x.py', 'site/dist', 'ops/a.md', 'b.py', 'c.mjs']);
  assert.deepEqual(pathTokens('site/src/[slug].astro data/<id>.yaml https://x.dev/a ../up ./here'), []);
  const map = folderMapRows('# R\n\n## Folder map\n\n```\nsite/ x\n## not a heading in a fence\nops/  y\n```\n\n- `data/` z\n\n## Next\n\nart/ no\n', 'folder map');
  assert.deepEqual([...map].sort(), ['data', 'ops', 'site']);
  assert.equal(folderMapRows('# R\n', 'Folder map'), null);
});

test('expandGlobs drops what a "!" glob matches', () => {
  assert.deepEqual(expandGlobs(fixture, ['**/README.md', '!img/**']), ['README.md']);
  assert.deepEqual(expandGlobs(fixture, ['facts/**/*.md', '!facts/runbooks/*.md']), ['facts/dated.md', 'facts/run.md']);
});

// ---- the template's targets file, read as a contract ----

const template = JSON.parse(fs.readFileSync(path.join(here, '../../targets/docs.json'), 'utf8'));
const skipOf = (params) => new Set(['.git', ...params.skip_dirs]);

test('docs.mjs names no repo path, so any repo can run it unchanged', () => {
  const src = fs.readFileSync(path.join(here, 'docs.mjs'), 'utf8');
  for (const p of ['tools/', '.astro', '.wrangler', 'ops/', 'site/', '/runbooks/', 'CLAUDE.md']) {
    assert.ok(!src.includes(p), `docs.mjs names ${p}; move it to a param in quality/targets/docs.json`);
  }
});

test('targets/docs.json: one params block, and every category has a metric', () => {
  assert.equal(template.filter((t) => t.params).length, 1);
  assert.equal(template.find((t) => t.params).id, template[0].id, 'the params sit on the first entry');
  for (const kind of ['quality', 'speed', 'consumption']) assert.ok(template.some((t) => t.kind === kind), kind);
});

test('targets/docs.json: every metric definition follows the contract', () => {
  const enums = {
    kind: ['quality', 'speed', 'consumption'], direction: ['higher', 'lower'],
    needs: ['none', 'github-admin', 'cloudflare', 'local-files', 'project-scope'],
    chart: ['number', 'bar', 'gauge', 'spark', 'table'],
  };
  // Form is quality, time is speed: the visual-share metrics count a doc's
  // form, so they are quality, and reading time is the tab's speed.
  const groups = { quality: ['Correct', 'Current', 'Complete', 'Visual share'], speed: ['Reading time'], consumption: ['Tokens'] };
  assert.deepEqual(template.map((t) => t.id).sort(), [...IDS].sort());
  for (const t of template) {
    assert.equal(t.tab, 'documentation', t.id);
    for (const [k, allowed] of Object.entries(enums)) assert.ok(allowed.includes(t[k]), `${t.id} ${k}=${t[k]}`);
    assert.ok(groups[t.kind].includes(t.group), `${t.id} group "${t.group}" is not one of ${groups[t.kind].join(', ')}`);
    assert.ok(t.label.split(/\s+/).length <= 6, `${t.id} label over 6 words`);
    assert.equal(typeof t.means, 'string', `${t.id} means`);
    assert.ok(t.means.length <= 120, `${t.id} means over 120 characters`);
    assert.doesNotMatch(t.means, /\d/, `${t.id} means holds a figure`);
    assert.equal(typeof t.goal, 'number', t.id);
    assert.equal(typeof t.near, 'number', t.id);
    assert.ok(t.direction === 'higher' ? t.near <= t.goal : t.near >= t.goal, `${t.id} near band is on the wrong side`);
    assert.match(t.goal_source, /\bgoal\b/i, `${t.id} goal_source must label the goal as a goal`);
    assert.match(t.source, /^state: /, `${t.id} source names its basis`);
    for (const k of ['unit', 'source']) assert.ok(t[k], `${t.id} ${k}`);
  }
});

test('targets/docs.json: the reading goal and the verified phrase agree everywhere they appear', () => {
  const minutes = PARAMS.minutes_goal;
  const byId = Object.fromEntries(template.map((t) => [t.id, t]));
  const over = byId['docs.over_read_goal'];
  assert.ok(over.label.includes(`${minutes} minutes`), 'the over-goal label names params.minutes_goal');
  assert.ok(over.goal_source.includes(`${minutes} minutes`), 'docs.over_read_goal goal_source names params.minutes_goal');
  assert.ok(over.goal_source.includes(`${PARAMS.words_per_minute} words a minute`), 'docs.over_read_goal names the reading rate');
  const tokens = byId['docs.tokens_past_read_goal'];
  assert.ok(tokens.goal_source.includes(`${minutes} minutes at ${PARAMS.words_per_minute} words a minute`), 'the token goal uses the same reading goal');
  assert.match(over.goal_source, /Brysbaert, 2019/, 'the reading rate cites its source');
  assert.ok(PARAMS.as_of.includes(PARAMS.verified), 'a runbook verified date is also judged as a dated claim');
  assert.ok(byId['docs.text_only'].goal_source.includes(`${PARAMS.text_only_below}%`), 'docs.text_only goal_source names params.text_only_below');
});

// The tab's rule, held as a test: a metric stays only while it moves the docs
// toward a named source of the ideal, and a source stays only while a metric
// measures it.
test('targets/docs.json: every metric names a source of the ideal, and every source backs a metric', () => {
  const ideal = JSON.parse(fs.readFileSync(path.join(here, '../../ideals/documentation.json'), 'utf8'));
  const titles = ideal.sources.map((s) => s.title);
  for (const t of template) {
    assert.ok(titles.some((title) => t.goal_source.includes(title)), `${t.id}: goal_source names no source of quality/ideals/documentation.json`);
  }
  for (const title of titles) {
    assert.ok(template.some((t) => t.goal_source.includes(title)), `no docs metric names the source "${title}": drop it or add its metric`);
  }
  for (const { glob, why } of PARAMS.agent_docs) assert.ok(glob && why && why.length <= 120, `agent_docs ${glob}: why`);
});

test('targets/docs.json: the default doc set is every markdown file, less vendored and build folders', () => {
  assert.deepEqual(PARAMS.doc_set, ['**/*.md']);
  for (const d of ['node_modules', 'vendor', 'dist', 'build', 'worktrees']) assert.ok(PARAMS.skip_dirs.includes(d), d);
  assert.equal(PARAMS.lint, undefined, 'the template names no content lint');
  for (const { glob, why } of PARAMS.doc_set_left_out) {
    assert.ok(why && why.length <= 120, `${glob}: why`);
    assert.ok(expandGlobs(repo, [glob], skipOf(PARAMS)).length > 0, `${glob} matches no file in Git Crafter; drop it`);
  }
});

test('targets/docs.json: every doc in Git Crafter maps to an area that exists', () => {
  const docs = expandGlobs(repo, [...PARAMS.doc_set, ...PARAMS.doc_set_left_out.map((l) => `!${l.glob}`)], skipOf(PARAMS));
  assert.ok(docs.length > 0);
  assert.ok(!docs.some((d) => d.startsWith('quality/fixtures/')), 'fixtures are test data, not docs');
  for (const doc of docs) {
    const spec = areaFor(doc, PARAMS.areas);
    assert.ok(spec, `${doc} has no params.areas entry`);
    for (const p of spec) assert.ok(fs.existsSync(path.join(repo, p)), `${doc}: area path ${p} does not exist`);
  }
});

test('Git Crafter itself, on the template defaults: every metric is a number or a could_not_check reason', async () => {
  const r = await collectDocs({ root: repo, mode: 'local' });
  assert.deepEqual(Object.keys(r).sort(), [...IDS].sort());
  for (const id of IDS) {
    if ('could_not_check' in r[id]) assert.equal(typeof r[id].could_not_check, 'string', id);
    else assert.ok(Number.isFinite(r[id].value), `${id} = ${r[id].value}`);
  }
});

test('a one-column table is a list, so its rows are not visual lines', async () => {
  const { parseMarkdown } = await import('./docs-markdown.mjs');
  const visual = (md) => parseMarkdown(md).visualLines;
  assert.equal(visual('| Rule |\n|---|\n| Never push to main |\n| Never force-push |\n'), 0);
  assert.equal(visual('| Rule | Why |\n|---|---|\n| Never push to main | review first |\n'), 3);
  assert.equal(visual('| Rule |\n|---|\n| run `a \\| b`, never `c` |\n'), 0, 'a pipe in code or an escaped pipe is no column');
  assert.equal(visual('Rule | Why\n---|---\n'), 0, 'a line with no leading pipe was never counted');
});
