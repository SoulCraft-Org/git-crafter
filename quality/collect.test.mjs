// node --test quality/collect.test.mjs

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { FULL_RUN_GUESS, fullRunNeed, quotaGate, quotaLine, recordLocal, reserveFloor, reserveShort } from './collect-quota.mjs';
import { collectorFiles, gateFailures, parseArgs, POOL, repoEnv, runCollectors, slowestLine } from './collect.mjs';
import { loadDefs } from './score.mjs';

test('repoEnv: a --local run hands collectors the config repo; a repo the environment names wins (#230)', () => {
  const env = {};
  assert.equal(repoEnv({ repo: 'acme/site' }, env), 'acme/site');
  assert.equal(env.GITHUB_REPOSITORY, 'acme/site');
  const ci = { GITHUB_REPOSITORY: 'acme/other' };
  assert.equal(repoEnv({ repo: 'acme/site' }, ci), 'acme/other');
  assert.equal(repoEnv({ repo: null }, {}), null);
});

test('collectorFiles: a collector in a tab subfolder runs, and a name in two subfolders is an error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'collectors-'));
  try {
    for (const f of ['flat.mjs', 'github/github.mjs', 'github/github-core.mjs', 'github/github.test.mjs', 'ci/ci.mjs']) {
      mkdirSync(join(dir, f, '..'), { recursive: true });
      writeFileSync(join(dir, f), '');
    }
    assert.deepEqual(collectorFiles([dir]).map((f) => [f.dir.slice(dir.length), f.file]), [['', 'flat.mjs'], ['/ci', 'ci.mjs'], ['/github', 'github-core.mjs'], ['/github', 'github.mjs']]);
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'docs', 'ci.mjs'), '');
    assert.throws(() => collectorFiles([dir]), /ci\.mjs is in both/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runCollectors: a collector that throws a path under home reports it as ~ (#393)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'collectors-'));
  try {
    writeFileSync(join(dir, 'leaky.mjs'), `export async function collect() { throw new Error(${JSON.stringify(`ENOENT: open '${homedir()}/x/usage.json'`)}); }`);
    const run = await runCollectors({ root: dir, mode: 'local', dirs: [dir], defs: [{ id: 'leaky.a', file: 'leaky.json' }], label: (d, f) => f });
    const reason = run.metrics['leaky.a'].could_not_check;
    assert.match(reason, /collector leaky\.mjs failed: ENOENT: open '~\/x\/usage\.json'/);
    assert.ok(!reason.includes(homedir()), reason);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a gate fails only a gated metric that reads worse than its goal', (t) => {
  t.mock.method(console, 'error', () => {});
  const defs = [
    { id: 'c.long', gate: true, direction: 'lower', goal: 0 },
    { id: 'c.share', gate: true, direction: 'higher', goal: 100 },
    { id: 'c.free', direction: 'lower', goal: 0 },
  ];
  // The seeded bad sample: one file over the limit, and a share under its goal.
  assert.equal(gateFailures(defs, { 'c.long': { value: 1, detail: [{ label: 'tools/big.py' }] }, 'c.share': { value: 99.9 }, 'c.free': { value: 5 } }), 2);
  assert.match(console.error.mock.calls[0].arguments[0], /^::error::quality: c\.long is 1, goal 0: tools\/big\.py$/);
  // The clean sample, a metric with no gate, and one that could not be read: none fails.
  assert.equal(gateFailures(defs, { 'c.long': { value: 0 }, 'c.share': { value: 100 }, 'c.free': { value: 5 } }), 0);
  assert.equal(gateFailures(defs, { 'c.long': { could_not_check: 'python3 is not on PATH' } }), 0);
});

const quota = (core, graphql) => ({ core: { limit: 5000, remaining: core, reset: 1762880400 }, graphql: { limit: 5000, remaining: graphql, reset: 1762880400 } });
const quotaGh = (resources) => ({ rest: async () => ({ resources }) });

test('parseArgs: --only names one collector and goes with --local', () => {
  assert.deepEqual(parseArgs(['--local', '--only', 'ci']), { config: null, local: true, out: null, from: null, only: 'ci' });
  assert.equal(parseArgs(['--only']), null);
});

test('fullRunNeed: the last full run\'s own spend, else the stated guess', () => {
  assert.deepEqual(fullRunNeed({ generated_at: '2026-11-11T10:00:00Z', api_spend: { core: 900, graphql: 300, read_at: '2026-11-11T10:05:00Z' } }).need, { core: 900, graphql: 300 });
  assert.deepEqual(fullRunNeed(null).need, FULL_RUN_GUESS);
  assert.deepEqual(fullRunNeed({ api_spend: { core: 'x' } }).need, FULL_RUN_GUESS);
});

test('quotaGate: stops a full --local run that would not fit, never a --only run', async () => {
  const low = quotaGh(quota(1000, 4800));
  const stopped = await quotaGate({ gh: low, prior: null, only: null });
  assert.match(stopped.stop, /would not fit.*REST requests: 1000 left.*--only NAME/);
  assert.equal((await quotaGate({ gh: low, prior: null, only: 'ci' })).stop, null);
  assert.equal((await quotaGate({ gh: quotaGh(quota(4850, 4783)), prior: null, only: null })).stop, null);
  // Unreadable: the run goes on without the check.
  const blind = await quotaGate({ gh: { rest: async () => { throw new Error('HTTP 401'); } }, prior: null, only: null });
  assert.deepEqual(blind, { before: null, stop: null });
});

test('runCollectors: --only runs the one collector named, and an unknown name is an error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'only-'));
  try {
    writeFileSync(join(dir, 'a.mjs'), 'export const collect = () => ({ "a.x": { value: 1 } });');
    writeFileSync(join(dir, 'b.mjs'), 'export const collect = () => ({ "b.x": { value: 2 } });');
    const defs = [{ id: 'a.x', file: 'a.json' }, { id: 'b.x', file: 'b.json' }];
    const run = await runCollectors({ root: dir, mode: 'local', dirs: [dir], defs, only: 'b', label: (d, f) => f });
    assert.deepEqual(Object.keys(run.metrics), ['b.x']);
    await assert.rejects(runCollectors({ root: dir, mode: 'local', dirs: [dir], defs, only: 'zz' }), /no collector zz\.mjs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runCollectors: POOL collectors run at once, so a slow one late in folder order starts early', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pool-'));
  try {
    const body = `export const collect = async () => {
      const g = globalThis.__pool;
      g.live += 1; g.peak = Math.max(g.peak, g.live);
      await new Promise((r) => setTimeout(r, 30));
      g.live -= 1;
      return {};
    };`;
    for (let i = 0; i < 10; i++) writeFileSync(join(dir, `c${i}.mjs`), body);
    globalThis.__pool = { live: 0, peak: 0 };
    await runCollectors({ root: dir, mode: 'local', dirs: [dir], defs: [], label: (d, f) => f });
    assert.equal(globalThis.__pool.peak, Math.min(POOL, 10), 'the pool fills');
    assert.ok(POOL >= 8, `a pool of ${POOL}: 250 s of collectors cannot finish near 45 s`);
  } finally {
    delete globalThis.__pool;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recordLocal: --only keeps the rest of local.json; a full run records its spend', async () => {
  const prior = { metrics: { 'a.x': { value: 1 } }, collectors: ['a'], api_spend: { core: 9, graphql: 9 } };
  const one = recordLocal({ prior, gate: { before: null } }, { metrics: { 'b.x': { value: 2 } }, ran: ['b'], only: 'b' });
  assert.deepEqual([Object.keys(one.metrics), one.ran, one.extra.api_spend.core], [['a.x', 'b.x'], ['a', 'b'], 9]);
  const full = recordLocal({ prior, gate: { before: quota(4850, 4783) } }, { metrics: {}, ran: [], only: null, after: quota(4000, 4700) });
  assert.deepEqual([full.extra.api_spend.core, full.extra.api_spend.graphql], [850, 83]);
  assert.deepEqual(recordLocal(null, { metrics: { 'c.x': {} }, ran: ['c'], only: null }), { metrics: { 'c.x': {} }, ran: ['c'], extra: {} }, 'a CI run is passed through');
});

// Two collectors, one that reads the GitHub API, each counting its calls.
function reserveFixture(dir) {
  writeFileSync(join(dir, 'gh.mjs'), 'export const githubApi = true; export const collect = () => { globalThis.ghCalls = (globalThis.ghCalls ?? 0) + 1; return { "gh.x": { value: 1 } }; };');
  writeFileSync(join(dir, 'local.mjs'), 'export const collect = () => ({ "local.x": { value: 2 } });');
  return [{ id: 'gh.x', file: 'gh.json' }, { id: 'local.x', file: 'local.json' }];
}

test('the API reserve: under the floor the GitHub collectors skip their reads; enough calls left runs them (#679)', async (t) => {
  t.mock.method(console, 'error', () => {});
  const floor = reserveFloor({ 'ci.json': { api_reserve: 300 } });
  assert.equal(floor, 300);
  assert.equal(reserveFloor({}), 0, 'no floor set: no reserve');
  const dir = mkdtempSync(join(tmpdir(), 'reserve-'));
  try {
    const defs = reserveFixture(dir);
    globalThis.ghCalls = 0;
    const reserve = reserveShort(quota(299, 4800), floor);
    assert.match(reserve, /^api reserve: 299 REST requests left, under the floor of 300/);
    const low = await runCollectors({ root: dir, mode: 'ci', dirs: [dir], defs, reserve, label: (d, f) => f });
    assert.equal(globalThis.ghCalls, 0, 'the GitHub collector made no read');
    assert.equal(low.metrics['gh.x'].could_not_check, reserve);
    assert.equal(low.metrics['gh.x'].source, 'gh.mjs');
    assert.deepEqual(low.metrics['local.x'], { value: 2 }, 'a collector with no GitHub reads still runs');
    // At the floor, and with rate_limit unread, the reads run.
    assert.equal(reserveShort(quota(300, 300), floor), null);
    assert.equal(reserveShort(null, floor), null);
    const ok = await runCollectors({ root: dir, mode: 'ci', dirs: [dir], defs, reserve: reserveShort(quota(4000, 4800), floor), label: (d, f) => f });
    assert.equal(globalThis.ghCalls, 1);
    assert.deepEqual(ok.metrics['gh.x'], { value: 1 });
  } finally {
    delete globalThis.ghCalls;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('quotaLine: one line of limit, used, left and calls spent per bucket', () => {
  const before = quota(4850, 4783);
  const after = { core: { ...quota(4000, 4700).core, used: 1000 }, graphql: { ...quota(4000, 4700).graphql, used: 300 } };
  assert.equal(quotaLine(before, after), 'GitHub API: REST requests limit 5000, used 1000, left 4000, spent 850; GraphQL points limit 5000, used 300, left 4700, spent 83');
  assert.match(quotaLine(before, null), /left 4850, spent unknown/);
  assert.equal(quotaLine(null, null), 'GitHub API: rate_limit unread, calls spent unknown');
});

test('a "warn" gate annotates its miss and passes; a true gate fails', (t) => {
  t.mock.method(console, 'error', () => {});
  const defs = [
    { id: 'c.dead', gate: 'warn', direction: 'lower', goal: 0 },
    { id: 'c.todo', gate: true, direction: 'lower', goal: 0 },
  ];
  assert.equal(gateFailures(defs, { 'c.dead': { value: 2, detail: [{ label: 'a.mjs: f' }] }, 'c.todo': { value: 0 } }), 0);
  assert.match(console.error.mock.calls[0].arguments[0], /^::warning::quality: c\.dead is 2, goal 0: a\.mjs: f$/);
  assert.equal(gateFailures(defs, { 'c.dead': { value: 2 }, 'c.todo': { value: 1 } }), 1);
  assert.match(console.error.mock.calls[2].arguments[0], /^::error::quality: c\.todo is 1/);
});

// Git Crafter's own Code tab: the template's targets with config/quality/targets laid over them.
test("Git Crafter's Code gate: a seeded TODO marker fails, a seeded unused export warns and passes", (t) => {
  t.mock.method(console, 'error', () => {});
  const quality = fileURLToPath(new URL('.', import.meta.url));
  const loaded = loadDefs({ templateDir: join(quality, 'targets'), repoDir: join(quality, '../config/quality/targets'), tabs: [['code', 'Code']] });
  const gate = (id) => loaded.gated.find((d) => d.id === id)?.gate;
  // The four guards that left the score in #643 still block, unscored; the four unused-code counts warn.
  for (const id of ['code.duplicated_pct', 'code.drift_markers', 'code.commented_code', 'code.purpose_comments_pct']) {
    assert.equal(gate(id), true, id);
    assert.ok(!loaded.defs.some((d) => d.id === id), `${id} stays out of the score`);
  }
  for (const id of ['code.dead_exports', 'code.dead_files', 'code.dead_dependencies', 'code.dead_functions']) assert.equal(gate(id), 'warn', id);
  assert.equal(gateFailures(loaded.gated, { 'code.drift_markers': { value: 1, detail: [{ label: 'tools/x.py:3 TODO' }] } }), 1);
  assert.match(console.error.mock.calls[0].arguments[0], /^::error::quality: code\.drift_markers is 1, goal 0/);
  assert.equal(gateFailures(loaded.gated, { 'code.dead_exports': { value: 1, detail: [{ label: 'quality/x.mjs: unused' }] } }), 0);
  assert.match(console.error.mock.calls[1].arguments[0], /^::warning::quality: code\.dead_exports is 1, goal 0/);
});

test('slowestLine: the run wall time and the slowest collectors, slowest first', () => {
  assert.equal(slowestLine({ 'a.mjs': 1.25, 'b.mjs': 30, 'c.mjs': 4 }, 31.04, 2), '31.0 s in all; slowest b.mjs 30.0, c.mjs 4.0');
});
