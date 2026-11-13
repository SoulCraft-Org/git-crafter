// node --test quality/collectors/tools/tools.test.mjs
// Every input is synthetic: a repo in a temp folder (package.json files,
// package-lock.json, .nvmrc, one workflow) and npm, gh and Node's release
// index from fakes.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { loadTargets } from '../lib/score.mjs';
import { actionPins, area, collect, compareVersions, directDependencies, eligibleVersion, GITHUB_GROUPS, judge, lockfileVersions, heldMajors, metricIds, nodeKeys, nodeMajor, READS, setupNodeSteps } from './tools.mjs';

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
const daysAgo = (d) => new Date(now.getTime() - d * 864e5).toISOString();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-collector-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const write = (p, text) => {
  fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
  fs.writeFileSync(path.join(root, p), typeof text === 'string' ? text : JSON.stringify(text));
};
write('package.json', { workspaces: ['site'], devDependencies: { lib: '1.0.0' } });
write('site/package.json', { name: '@x/site', dependencies: { big: '1.0.0', fresh: '2.0.1', lib: '1.0.0', '@x/shared': '*' } });
write('package-lock.json', { packages: { 'node_modules/lib': { version: '1.0.0' }, 'node_modules/big': { version: '1.0.0' }, 'node_modules/fresh': { version: '2.0.1' } } });
write('.nvmrc', '26\n');
write('.github/workflows/ci.yml', `jobs:\n  a:\n    steps:\n      - uses: actions/checkout@${'a'.repeat(40)} # v7\n      - uses: acme/tools/actions/pages@${'b'.repeat(40)}\n      - uses: actions/setup-node@v4\n        with:\n          node-version-file: .nvmrc\n`);

// npm: lib is current; big is a major behind, its 1.1.0 eligible since 6 days;
// fresh 2.0.1 was installed at 3 days old, so it is too new.
const TIMES = {
  lib: { created: daysAgo(400), '1.0.0': daysAgo(100), '1.1.0-rc.1': daysAgo(30) },
  big: { '1.0.0': daysAgo(200), '1.1.0': daysAgo(20), '2.0.0': daysAgo(15), '3.0.0': daysAgo(2) },
  fresh: { '2.0.0': daysAgo(60), '2.0.1': daysAgo(3) },
};
const release = (tag, d, extra = {}) => ({ tag_name: tag, published_at: daysAgo(d), draft: false, prerelease: false, ...extra });
function fakeExec({ gh = true } = {}) {
  return async (cmd, args) => {
    if (cmd === 'npm') return JSON.stringify([TIMES[args[1]]]);
    if (cmd !== 'gh' || !gh) throw new Error('HTTP 403');
    const url = args[1];
    if (args[0] === 'pr' && args.includes('open')) return JSON.stringify([{ number: 5, createdAt: daysAgo(9), title: 'Bump big' }, { number: 6, createdAt: daysAgo(2), title: 'Bump lib' }]);
    if (args[0] === 'pr') return JSON.stringify([{ number: 3, headRefOid: 'c3', mergedAt: daysAgo(5) }, { number: 4, headRefOid: 'c4', mergedAt: daysAgo(1) }]);
    // checkout: v7.0.1 is the newest by version; a v2 backport came out later.
    if (url.endsWith('checkout/releases?per_page=30')) return JSON.stringify([release('v2.8.0', 20), release('v7.0.1', 30), release('v7.1.0', 5), release('v8.0.0-beta', 40, { prerelease: true })]);
    if (url.endsWith('setup-node/releases?per_page=30')) return JSON.stringify([release('v4.0.0', 300)]);
    if (url.includes('checkout/commits/v7.0.1')) return JSON.stringify({ sha: 'a'.repeat(40) });
    if (url.includes('setup-node/commits/')) return JSON.stringify({ sha: 'd'.repeat(40) });
    if (url.includes('head_sha=c3')) return JSON.stringify({ workflow_runs: [{ id: 30 }] });
    if (url.includes('head_sha=c4')) return JSON.stringify({ workflow_runs: [{ id: 40 }, { id: 41 }] });
    if (url.includes('runs/98/jobs')) return JSON.stringify({ jobs: [{ name: 'lint', steps: [{ name: 'Run voice lint', conclusion: 'success', started_at: daysAgo(1), completed_at: daysAgo(1) }] }] });
    if (url.includes('/jobs')) return JSON.stringify({ jobs: [{ name: 'build', started_at: daysAgo(1), completed_at: new Date(Date.parse(daysAgo(1)) + 90_000).toISOString(), steps: [{ name: 'Run npm ci --no-audit', conclusion: 'success', started_at: daysAgo(1), completed_at: new Date(Date.parse(daysAgo(1)) + 21_000).toISOString() }] }] });
    // The newest push runs on main, any workflow: run 98 has no install step, 99 has one.
    if (url.includes('/actions/runs?branch=main')) return JSON.stringify({ workflow_runs: [{ id: 98, head_sha: 'aaaaaa1' }, { id: 99, head_sha: 'abcdef1' }] });
    throw new Error(`unexpected ${args.join(' ')}`);
  };
}
const index = [{ version: 'v27.1.0', lts: false }, { version: 'v26.4.0', lts: 'Fable' }, { version: 'v24.9.0', lts: 'Krypton' }];
// The template's own defaults: the repo's owner owns acme/tools, and any workflow's install step counts.
const params = { repo: 'acme/r', release_age_days: 14, last_n: 10 };
const base = { root, mode: 'ci', now, params, fetchJson: async () => index };

test('targets: one per metric on the Dependabot tab, a third of the kinds each', () => {
  const defs = ownTargets('tools.json').filter((d) => d.file === 'tools.json');
  assert.equal(area, 'tools');
  assert.deepEqual(defs.map((d) => d.id), metricIds);
  for (const kind of ['quality', 'speed', 'consumption']) assert.ok(defs.some((d) => d.kind === kind), kind);
  for (const d of defs) assert.match(d.goal_source, /^(goal from |template goal, no public benchmark: )/, d.id);
});

test('versions: the newest stable release at least 14 days old', () => {
  assert.ok(compareVersions('1.10.0', '1.9.9') > 0);
  assert.equal(eligibleVersion(TIMES.big, now, 14), '2.0.0');
  assert.equal(eligibleVersion(TIMES.lib, now, 14), '1.0.0', 'a prerelease never counts');
  assert.deepEqual([judge('big', '1.0.0', TIMES.big, now, 14).status, judge('big', '1.0.0', TIMES.big, now, 14).majors_behind, judge('big', '1.0.0', TIMES.big, now, 14).waiting_days], ['behind', 1, 6]);
  assert.equal(judge('fresh', '2.0.1', TIMES.fresh, now, 14).status, 'too new');
});

test('the repo: direct dependencies once each, workspaces left out; third-party pins', () => {
  assert.deepEqual(directDependencies(root).map((d) => [d.name, d.installed]), [['big', '1.0.0'], ['fresh', '2.0.1'], ['lib', '1.0.0']]);
  assert.deepEqual(actionPins(root).map((p) => `${p.owner}/${p.repo}@${p.ref.slice(0, 2)}`), ['actions/checkout@aa', 'acme/tools@bb', 'actions/setup-node@v4']);
});

test('action pins: a tag that actions.lock records reads as its locked commit; $/ is the repo\'s own', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-lock-'));
  const flows = path.join(dir, '.github', 'workflows');
  fs.mkdirSync(flows, { recursive: true });
  fs.writeFileSync(path.join(flows, 'w.yml'), ['jobs:', '  a:', '    steps:', '      - uses: actions/checkout@v7.0.1', '      - uses: actions/cache@v4', '      - uses: $/actions/pages'].join('\n'));
  fs.writeFileSync(path.join(flows, 'actions.lock'), ["version: 'v0.0.3'", 'workflows: {}', 'dependencies:', "    'actions/checkout@v7.0.1':", "        ref: 'v7.0.1'", `        commit: 'sha1-${'a'.repeat(40)}'`].join('\n'));
  try {
    assert.deepEqual(actionPins(dir).map((p) => `${p.repo}@${p.ref}`), [`checkout@${'a'.repeat(40)}`, 'cache@v4']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('collect: every metric from a good fixture', async () => {
  const out = await collect({ ...base, exec: fakeExec() });
  assert.equal(out['tools.deps_latest_share'].value, 33.3, 'lib current; big behind; fresh too new');
  assert.equal(out['tools.majors_behind'].value, 1);
  assert.equal(out['tools.oldest_update_wait_days'].value, 6);
  // checkout matches v7.0.1; setup-node is pinned to a tag, not a SHA; acme/tools is the repo owner's own.
  assert.equal(out['tools.actions_latest_share'].value, 50);
  assert.deepEqual(out['tools.actions_latest_share'].detail.map((r) => r.status), ['current', 'not a SHA']);
  assert.equal(out['tools.node_lts'].value, 1);
  assert.equal(out['tools.open_dependency_prs'].value, 2);
  assert.equal(out['tools.oldest_dependency_pr_days'].value, 9);
  // PR 4, merged a day ago, is the latest: two runs (4 min). PR 3, five days ago: one 90 s job (2 min). No median.
  assert.equal(out['tools.latest_dependency_pr_ci_minutes'].value, 4);
  assert.deepEqual(out['tools.latest_dependency_pr_ci_minutes'].detail.map((r) => [r.label, r.value]), [['#4', 4], ['#3', 2]], 'newest first, by mergedAt, not list order');
  assert.match(out['tools.latest_dependency_pr_ci_minutes'].source, /the latest, #4, merged \d{4}-\d{2}-\d{2}/);
  assert.equal(out['tools.npm_ci_seconds'].value, 21);
  assert.match(out['tools.npm_ci_seconds'].source, /run 99 \(abcdef1\)/, 'the newest run with an install step');
});

// An exec that holds each call it counts for 20 ms and tracks how many are in flight.
function counting(inner, counts = (cmd) => cmd === 'gh') {
  const seen = { live: 0, peak: 0 };
  const exec = async (cmd, args, opts) => {
    if (!counts(cmd, args)) return inner(cmd, args, opts);
    seen.live += 1;
    seen.peak = Math.max(seen.peak, seen.live);
    try {
      await new Promise((r) => setTimeout(r, 20));
      return await inner(cmd, args, opts);
    } finally {
      seen.live -= 1;
    }
  };
  return { exec, seen };
}

test('collect: the groups read side by side, at most READS gh calls per group, with the same output', async () => {
  const plain = await collect({ ...base, exec: fakeExec() });
  const { exec, seen } = counting(fakeExec());
  const out = await collect({ ...base, exec });
  assert.ok(seen.peak >= 3, `${seen.peak} gh calls at once: the groups still run one after another`);
  assert.ok(seen.peak <= READS * GITHUB_GROUPS, `${seen.peak} gh calls at once, over ${READS} reads x ${GITHUB_GROUPS} groups`);
  const strip = (o) => JSON.parse(JSON.stringify(o, (k, v) => (k === 'read_at' ? undefined : v)));
  assert.deepEqual(strip(out), strip(plain), 'the same metrics, rows in the same order');
});

test('collect: ten merged PRs fill the CI minutes group to READS gh calls, never more', async () => {
  const inner = fakeExec();
  const merged = Array.from({ length: 10 }, (_, i) => ({ number: 10 + i, headRefOid: `m${i}`, mergedAt: daysAgo(10 - i) }));
  const ten = async (cmd, args, opts) => {
    if (args[0] === 'pr' && args.includes('merged')) return JSON.stringify(merged);
    const sha = /head_sha=m(\d)/.exec(args[1] ?? '');
    if (sha) return JSON.stringify({ workflow_runs: [{ id: 500 + Number(sha[1]) }, { id: 600 + Number(sha[1]) }] });
    return inner(cmd, args, opts);
  };
  const { exec, seen } = counting(ten, (cmd, args) => /head_sha=m|runs\/[56]\d\d\/jobs/.test(args[1] ?? ''));
  const out = await collect({ ...base, exec });
  assert.equal(seen.peak, READS, 'the PRs read READS at a time, and one PR reads its runs one by one');
  const m = out['tools.latest_dependency_pr_ci_minutes'];
  assert.deepEqual(m.detail.map((r) => r.label), merged.toReversed().map((p) => `#${p.number}`), 'newest first');
  assert.ok(m.detail.every((r) => r.value === 4), 'two 90 s jobs, 2 billed minutes each');
});

test('collect: a pin whose releases fail stays unread (null), and the share counts only the pins read', async () => {
  const inner = fakeExec();
  const exec = async (cmd, args, opts) => {
    if (cmd === 'gh' && /setup-node\/releases/.test(args[1] ?? '')) throw new Error('HTTP 502');
    return inner(cmd, args, opts);
  };
  const m = (await collect({ ...base, exec }))['tools.actions_latest_share'];
  const unread = m.detail.find((r) => r.label.startsWith('actions/setup-node'));
  assert.equal(unread.status, 'not read');
  assert.equal(unread.value, null, 'never 0');
  assert.match(unread.note, /HTTP 502/);
  assert.equal(m.value, 100, 'checkout, the one pin read, is current; the unread one is left out, not counted behind');
  assert.match(m.source, /1 of 2 read/);
});

test('collect: no gh, no npm answer or no index never read as 0', async () => {
  const noGh = await collect({ ...base, exec: fakeExec({ gh: false }) });
  for (const id of [
    'tools.actions_latest_share',
    'tools.open_dependency_prs',
    'tools.oldest_dependency_pr_days',
    'tools.latest_dependency_pr_ci_minutes',
    'tools.npm_ci_seconds',
  ]) assert.ok(noGh[id].could_not_check, id);
  const noNpm = await collect({ ...base, exec: async () => { throw new Error('ENOTFOUND'); } });
  assert.match(noNpm['tools.deps_latest_share'].could_not_check, /npm view answered for no dependency/);
  const noIndex = await collect({ ...base, exec: fakeExec(), fetchJson: async () => { throw new Error('offline'); } });
  assert.match(noIndex['tools.node_lts'].could_not_check, /offline/);
});

test('lockfiles: pnpm and Yarn pin versions as npm does', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-locks-'));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { lib: '^1.0.0' }, devDependencies: { peerish: '2.0.0' } }));
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      lib:\n        specifier: ^1.0.0\n        version: 1.2.0\n    devDependencies:\n      peerish:\n        specifier: 2.0.0\n        version: 2.0.0(lib@1.2.0)\n");
    assert.deepEqual(directDependencies(dir).map((d) => [d.name, d.installed, d.lockfile]), [['lib', '1.2.0', 'pnpm-lock.yaml'], ['peerish', '2.0.0', 'pnpm-lock.yaml']]);
    fs.rmSync(path.join(dir, 'pnpm-lock.yaml'));
    fs.writeFileSync(path.join(dir, 'yarn.lock'), '# yarn lockfile v1\n\n"lib@^1.0.0", lib@^1.1.0:\n  version "1.3.0"\n  resolved "x"\n\npeerish@2.0.0:\n  version "2.0.0"\n');
    assert.deepEqual(directDependencies(dir).map((d) => [d.name, d.installed]), [['lib', '1.3.0'], ['peerish', '2.0.0']]);
    fs.writeFileSync(path.join(dir, 'yarn.lock'), '"lib@npm:^1.0.0":\n  version: 1.4.0\n');
    assert.equal(lockfileVersions(dir).version('lib', '.', '^1.0.0'), '1.4.0', 'a later Yarn writes npm: ranges');
    fs.rmSync(path.join(dir, 'yarn.lock'));
    assert.throws(() => lockfileVersions(dir), /no lockfile/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('collect: a repo with no package.json or a .node-version file reads what it has', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-bare-'));
  try {
    fs.writeFileSync(path.join(dir, '.node-version'), 'v24.9.0\n');
    const out = await collect({ ...base, root: dir, exec: fakeExec() });
    assert.match(out['tools.deps_latest_share'].could_not_check, /package\.json or its lockfile unreadable/);
    assert.equal(out['tools.node_lts'].value, 0, '24 is an older LTS line than 26');
    assert.match(out['tools.node_lts'].source, /^state|\.node-version/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('setupNodeSteps reads each setup-node step; nodeMajor resolves its spec', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-node-'));
  try {
    fs.mkdirSync(path.join(dir, '.github/workflows'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.nvmrc'), '26\n');
    const wf = (body) => fs.writeFileSync(path.join(dir, '.github/workflows/w.yml'), `jobs:\n  a:\n    steps:\n${body}`);
    wf([
      '      - uses: actions/setup-node@v4 # v4',
      '        with:',
      '          node-version: 22',
      '      - name: from the file',
      '        uses: actions/setup-node@v4',
      '        with:',
      '          node-version-file: .nvmrc',
      '          cache: npm',
      '      - uses: actions/setup-node@v4',
      '        with:',
      "          node-version: ${{ inputs.node }}",
      '      - uses: actions/setup-node@v4',
      '        with: {node-version: 22, cache: npm}',
      '      - uses: actions/setup-node@v4',
      "        with: {cache: npm, node-version-file: '.nvmrc'}",
      '      - uses: actions/setup-node@v4',
      '        with: {node-version: ${{ inputs.node }}}',
      '      - uses: actions/setup-node@v4',
      '      - run: echo node-version: 99',
      '',
    ].join('\n'));
    assert.deepEqual(setupNodeSteps(dir), [
      { label: 'w.yml:4', spec: '22', file: null },
      { label: 'w.yml:8', spec: null, file: '.nvmrc' },
      { label: 'w.yml:15', spec: '22', file: null }, // flow style
      { label: 'w.yml:17', spec: null, file: '.nvmrc' },
      { label: 'w.yml:21', spec: null, file: null },
    ]);
    const idx = { line: 26, newest: 27 };
    assert.equal(nodeMajor('lts/*', idx), 26);
    assert.equal(nodeMajor('node', idx), 27);
    assert.equal(nodeMajor('v24.x', idx), 24);
    assert.equal(nodeMajor(null, idx), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('collect: tools.node_lts is 0 when one workflow step asks for an older Node than .nvmrc', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-node22-'));
  try {
    fs.mkdirSync(path.join(dir, '.github/workflows'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.nvmrc'), '26\n');
    fs.writeFileSync(path.join(dir, '.github/workflows/p.yml'), 'jobs:\n  a:\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 22\n');
    const out = await collect({ ...base, root: dir, exec: fakeExec() });
    assert.equal(out['tools.node_lts'].value, 0, 'pages.yml ran Node 22 while .nvmrc said 26 (#188)');
    assert.match(out['tools.node_lts'].detail[0].label, /p\.yml:4: node-version 22/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// An adopting org's fake GitHub: acme/std's tags (v2.8.0 30 days old, v2.9.0
// 10, v2.10.0 3) and each adopter's workflows. reads counts the commit reads.
// backport adds v2.8.1, cut 2 days ago: a lower version with a later commit.
function adopterExec(reads = [], backport = false) {
  const b64 = (t) => Buffer.from(t).toString('base64');
  const sha = { 'v2.8.0': 'd'.repeat(40), 'v2.9.0': 'e'.repeat(40), 'v2.10.0': 'f'.repeat(40), ...(backport ? { 'v2.8.1': 'c'.repeat(40) } : {}) };
  const age = { [sha['v2.8.0']]: 30, [sha['v2.9.0']]: 10, [sha['v2.10.0']]: 3, ['c'.repeat(40)]: 2 };
  const wf = (ref, note = '') => `jobs:\n  ci:\n    uses: acme/std/.github/workflows/ci.yml@${ref}${note}\n`;
  const files = {
    'acme/site': { 'ci.yml': wf(sha['v2.10.0'], ' # v2.10.0'), 'p.yml': '      - uses: acme/std/actions/pages@v2.10.0\n' },
    'acme/app': { 'ci.yml': wf(sha['v2.9.0'], ' # v2.9.0') },
    'acme/old': { 'ci.yml': wf(sha['v2.8.0'], ' # v2.10.0') },
    'acme/loose': { 'ci.yml': wf('9'.repeat(40), ' # v2.10.0') },
    'acme/none': { 'ci.yml': 'jobs: {}\n' },
  };
  return async (cmd, args) => {
    const url = args[1];
    if (url === 'repos/acme/std/tags?per_page=100&page=1') return JSON.stringify([...Object.entries(sha).map(([name, s]) => ({ name, commit: { sha: s } })), { name: 'latest', commit: { sha: '0'.repeat(40) } }]);
    const c = url.match(/^repos\/acme\/std\/git\/commits\/(\w+)$/);
    if (c && age[c[1]] !== undefined) return reads.push(c[1]) && JSON.stringify({ committer: { date: daysAgo(age[c[1]]) } });
    const m = url.match(/^repos\/(acme\/\w+)\/contents\/\.github\/workflows(?:\/(.+))?$/);
    if (m && files[m[1]] && !m[2]) return JSON.stringify(Object.keys(files[m[1]]).map((n) => ({ name: n, path: `.github/workflows/${n}` })));
    if (m && files[m[1]]?.[m[2]]) return JSON.stringify({ content: b64(files[m[1]][m[2]]) });
    if (cmd === 'gh') throw new Error('HTTP 404');
    return fakeExec()(cmd, args);
  };
}
const ADOPTERS = ['acme/site', 'acme/app', 'acme/old', 'acme/loose', 'acme/none', 'acme/gone'];
const adopterShare = async (extra, reads, backport) => (await collect({ ...base, exec: adopterExec(reads, backport), params: { ...base.params, repo: 'acme/std', adopters: ADOPTERS, ...extra } }))['tools.adopters_latest_share'];

test('collect: tools.adopters_latest_share judges each adopter against the newest tag a weekly run has had time to offer', async () => {
  const reads = [];
  const m = await adopterShare({}, reads);
  assert.equal(m.value, 50, 'the default is 7 days: v2.10.0 is 3 days old, so v2.9.0 is the bar: site is above it, app is on it, old is below, loose names no tag');
  assert.deepEqual(m.detail.map((r) => [r.adopter ?? r.label, r.status]), [['acme/site', 'current'], ['acme/app', 'current'], ['acme/old', 'behind'], ['acme/loose', 'behind'], ['acme/none', 'not read'], ['acme/gone', 'not read']]);
  assert.deepEqual(m.detail.slice(0, 4).map((r) => [r.pinned, r.judged_against, r.tag_age_days]), [['v2.10.0', 'v2.9.0', 10], ['v2.9.0', 'v2.9.0', 10], ['v2.8.0', 'v2.9.0', 10], ['999999999999 (no tag)', 'v2.9.0', 10]]);
  assert.equal(m.detail[2].label, 'acme/old: pin v2.8.0, judged against v2.9.0, 10 days old', 'the page shows a label and a value, so the label carries all three');
  assert.match(m.source, /newest tag at least 7 days old \(params\.adopter_cooldown_days, default 7: one weekly Dependabot run\).*v2\.9\.0.*4 of 6 read/);
  assert.deepEqual(reads, ['f'.repeat(40), 'e'.repeat(40)], 'the walk reads v2.10.0, then stops at v2.9.0: only tags younger than the grace, and the first old one');
});

test('collect: tools.adopters_latest_share is not fooled by a young backport tag', async () => {
  const m = await adopterShare({}, [], true);
  assert.equal(m.detail[0].judged_against, 'v2.9.0', 'v2.8.1 was cut 2 days ago, after v2.9.0, as a v2.7.1 cut after v3.0.0 would be: the bar stays v2.9.0, never v2.8.0');
  assert.equal(m.value, 50, 'old, on v2.8.0, is still behind');
});

test('collect: tools.adopters_latest_share follows params.adopter_cooldown_days and never scores with no tag that old', async () => {
  const two = await adopterShare({ adopter_cooldown_days: 14 });
  assert.equal(two.value, 75, 'at 14 days the bar is v2.8.0: only loose, which names no tag, is behind');
  assert.equal(two.detail[2].label, 'acme/old: pin v2.8.0, judged against v2.8.0, 30 days old');
  const none = await adopterShare({ adopter_cooldown_days: 0 });
  assert.equal(none.value, 25, 'with no grace the bar is the newest tag, v2.10.0: only site holds it');
  assert.equal(none.detail[1].label, 'acme/app: pin v2.9.0, judged against v2.10.0, 3 days old');
  const long = await adopterShare({ adopter_cooldown_days: 60 });
  assert.equal(long.value, undefined, 'no tag is 60 days old: nothing to judge against is not a 100');
  assert.match(long.could_not_check, /no version tag of acme\/std is 60 days old yet; the first, v2\.8\.0, is younger/);
  const bad = await adopterShare({ adopter_cooldown_days: -1 });
  assert.match(bad.could_not_check, /adopter_cooldown_days/);
  const empty = await collect({ ...base, exec: adopterExec(), params: { ...base.params, repo: 'acme/std', adopters: [] } });
  assert.match(empty['tools.adopters_latest_share'].could_not_check, /params\.adopters/);
});

test('collect: a major a Dependabot ignore holds is judged within its line, not behind', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-held-'));
  try {
    const put = (p, t) => { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), typeof t === 'string' ? t : JSON.stringify(t)); };
    put('package.json', { dependencies: { big: '1.0.0', lib: '1.0.0' } });
    put('package-lock.json', { packages: { 'node_modules/big': { version: '1.0.0' }, 'node_modules/lib': { version: '1.0.0' } } });
    put('.nvmrc', '26\n');
    put('.github/dependabot.yml', [
      'version: 2', 'updates:', '  - package-ecosystem: npm', '    directory: /', '    ignore:',
      '      - dependency-name: big', '        update-types: ["version-update:semver-major"]',
      '      - dependency-name: lib', '        versions: ["1.x"]', '',
    ].join('\n'));
    assert.deepEqual([...heldMajors(dir)], ['big'], 'only a semver-major ignore holds a major');
    const out = await collect({ ...base, root: dir, exec: fakeExec() });
    assert.equal(out['tools.majors_behind'].value, 0, 'big 2 is held, so not a major behind');
    const big = out['tools.deps_latest_share'].detail.find((r) => r.label === 'big');
    assert.equal(big.eligible, '1.1.0', 'judged against its own major line');
    assert.equal(big.status, 'behind');
    assert.match(big.held, /^major 2 held by a Dependabot ignore$/);
    assert.equal(out['tools.oldest_update_wait_days'].value, 6, '1.1.0 cleared the 14-day rule 6 days ago');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the collector holds no repo or account value', () => {
  const code = fs.readFileSync(new URL('./tools.mjs', import.meta.url), 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  for (const word of ['/Users/', 'Developer/', 'acme', 'quality-pages']) assert.ok(!code.includes(word), `${word} in the code`);
});

test('nodeKeys reads a plain key, a flow mapping, and nothing else', () => {
  assert.deepEqual(nodeKeys('          node-version: 22 # pinned'), [['node-version', '22']]);
  assert.deepEqual(nodeKeys("        with: {node-version-file: '.nvmrc', cache: npm}"), [['node-version-file', "'.nvmrc'"]]);
  assert.deepEqual(nodeKeys('        with: { cache: npm, node-version: "22" }'), [['node-version', '"22"']]);
  assert.deepEqual(nodeKeys('        cache: npm'), []);
});
