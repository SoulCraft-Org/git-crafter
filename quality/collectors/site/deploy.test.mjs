// node --test quality/collectors/site/deploy.test.mjs
// Every input is synthetic: Wrangler's JSON, git's first-parent log, the
// Regressed-by issues and the Actions runs come from a fake exec; the repo is
// a temp folder whose site/ holds a Wrangler config.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { loadTargets } from '../../score.mjs';
import { area, collect, median, metricIds, parseJsonList, parseLog, resolveDeploys } from './deploy.mjs';

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
const sha = (n) => String(n).repeat(40);
const short = (n) => sha(n).slice(0, 7);
const at = (h) => new Date(now.getTime() - h * 36e5).toISOString();

// main, newest first (sha(n) is merge n): 4 (an hour ago, not live), 3 (a regression, PR 13),
// 2, 1 (a docs-only merge, so it ships nothing), 0 before the window.
const commits = [
  [sha(4), at(1), 'Merge pull request #14 from o/fix'],
  [sha(3), at(30), 'Merge pull request #13 from o/regress'],
  [sha(2), at(50), 'Merge pull request #12 from o/feature'],
  [sha(1), at(60), 'Merge pull request #11 from o/docs'],
  [sha(0), at(24 * 40), 'Merge pull request #10 from o/old'],
];
const log = (rows) => rows.map((r) => r.join('\t')).join('\n');
const deployments = [
  { id: 'd1', created_on: at(48), annotations: { 'workers/triggered_by': 'deployment' }, versions: [{ version_id: 'v1', percentage: 100 }] },
  { id: 'd2', created_on: at(47), annotations: { 'workers/triggered_by': 'secret' }, versions: [{ version_id: 'v2', percentage: 100 }] },
  { id: 'd3', created_on: at(28), annotations: { 'workers/triggered_by': 'deployment' }, versions: [{ version_id: 'v3', percentage: 100 }] },
  { id: 'd4', created_on: at(20), annotations: { 'workers/triggered_by': 'deployment' }, versions: [{ version_id: 'v1', percentage: 100 }] },
];
const versions = [
  { id: 'v1', number: 1, metadata: { created_on: at(48) }, annotations: {} },
  { id: 'v2', number: 2, metadata: { created_on: at(47) }, annotations: {} },
  { id: 'v3', number: 3, metadata: { created_on: at(28) }, annotations: { 'workers/tag': `main-${short(3)}` } },
];

function fakeExec({ wrangler = true, gh = true } = {}) {
  return async (cmd, args) => {
    if (cmd === 'npx') {
      if (!wrangler) throw new Error('Not logged in');
      return `notice\n${JSON.stringify(args[1] === 'deployments' ? deployments : versions)}`;
    }
    if (cmd === 'git' && args[0] === 'log') return args.includes('--') ? log(commits.filter((c) => c[0] !== sha(1))) : log(commits);
    if (cmd === 'gh' && args[0] === 'api') {
      if (!gh) throw new Error('HTTP 403');
      // The push of merge 2 (d4's commit) ran one workflow: jobs of 61 s and 30 s bill 2 + 1 minutes.
      if (args[1].includes('/jobs')) return JSON.stringify({ jobs: [{ started_at: '2026-11-01T00:00:00Z', completed_at: '2026-11-01T00:01:01Z' }, { started_at: '2026-11-01T00:00:00Z', completed_at: '2026-11-01T00:00:30Z' }] });
      return JSON.stringify({ workflow_runs: args[1].includes(`head_sha=${sha(2)}`) ? [{ id: 7, name: 'site-tests' }] : [] });
    }
    if (cmd === 'gh') {
      if (!gh) throw new Error('HTTP 403');
      return JSON.stringify([{ number: 99, body: 'Regressed-by: #13', closedAt: at(22) }]);
    }
    throw new Error(`unexpected ${cmd} ${args.join(' ')}`);
  };
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-collector-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
fs.mkdirSync(path.join(root, 'site'));
fs.writeFileSync(path.join(root, 'site', 'wrangler.jsonc'), '{ "name": "site" }');
const params = { worker_dir: 'site', branch: 'origin/main', deploy_paths: ['site'], repo: 'o/r' };
const base = { root, mode: 'local', now, params };

test('targets: one per metric on the Deploy tab, each goal cited', () => {
  const defs = ownTargets('deploy.json').filter((d) => d.file === 'deploy.json');
  assert.equal(area, 'deploy');
  assert.deepEqual(defs.map((d) => d.id), metricIds);
  for (const d of defs) {
    assert.equal(d.tab, 'deploy');
    assert.match(d.goal_source, /^(goal from |template goal, no public benchmark: )/, d.id);
  }
});

test('helpers: median, JSON after a notice, the first-parent log', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([]), null);
  assert.deepEqual(parseJsonList('npm notice\n[1]'), [1]);
  assert.equal(parseLog(log(commits))[1].pr, 13);
});

test('resolveDeploys: a tag names the commit, else main at upload; an older version is a rollback', () => {
  const history = parseLog(log(commits));
  const d = resolveDeploys(deployments, versions, history);
  assert.deepEqual(d.map((x) => [x.id, x.commit, x.from, x.secret, x.rollback]), [
    ['d1', short(2), 'time', false, false],
    ['d2', short(2), 'time', true, false],
    ['d3', short(3), 'tag', false, false],
    // A rollback to v1 ships v1's code again.
    ['d4', short(2), 'time', false, true],
  ]);
});

test('collect: each metric a state now, the latest deploy or the last 10', async () => {
  const out = await collect({ ...base, exec: fakeExec() });
  // The latest code deploy, d4, rolled back to v1 (merge 2), so merges 3 and 4 wait.
  assert.equal(out['deploy.waiting_merges'].value, 2);
  assert.deepEqual(out['deploy.waiting_merges'].detail.map((d) => [d.label, d.value]), [['#14', 1], ['#13', 30]]);
  assert.equal(out['deploy.oldest_waiting_hours'].value, 30);
  // d3 is the latest deploy that shipped a merge: 3, merged 2 h before it.
  assert.equal(out['deploy.latest_lead_hours'].value, 2);
  assert.equal(out['deploy.latest_failed'].value, 1, 'the latest deploy is a rollback');
  // d3 shipped PR 13 (Regressed-by) and was rolled back: one failure in three code deploys.
  assert.equal(out['deploy.failure_rate_last10'].value, 33.3);
  assert.equal(out['deploy.failure_rate_last10'].detail.length, 3);
  assert.equal(out['deploy.latest_restore_hours'].value, 8, 'rolled back 8 h after it went out');
  // Consumption: d4 holds merge 2, whose push billed 3 minutes.
  assert.equal(out['deploy.latest_build_minutes'].value, 3);
});

test('collect: no Wrangler login, CI mode or no issues never read as 0', async () => {
  const noLogin = await collect({ ...base, exec: fakeExec({ wrangler: false }) });
  for (const id of metricIds) assert.match(noLogin[id].could_not_check, /wrangler login/, id);
  const ci = await collect({ ...base, mode: 'ci', exec: fakeExec() });
  for (const id of metricIds) assert.ok(ci[id].could_not_check, id);
  const noGh = await collect({ ...base, exec: fakeExec({ gh: false }) });
  assert.match(noGh['deploy.failure_rate_last10'].could_not_check, /gh issue list failed/);
  assert.match(noGh['deploy.latest_build_minutes'].could_not_check, /gh api failed/);
  assert.equal(noGh['deploy.waiting_merges'].value, 2);
});

test('collect: no Wrangler config where the target points is not measured, never 0', async () => {
  const out = await collect({ ...base, params: { ...params, worker_dir: 'worker' }, exec: fakeExec() });
  for (const id of metricIds) assert.match(out[id].could_not_check, /no Wrangler config in worker/, id);
});

test('collect: a Worker at the repo root counts every merge as one that ships', async () => {
  fs.writeFileSync(path.join(root, 'wrangler.toml'), 'name = "root"');
  try {
    const out = await collect({ ...base, params: { repo: 'o/r' }, exec: fakeExec() });
    // Merges 4 and 3 still wait. Merge 1 (docs only) now counts as shipping, but production already holds it.
    assert.equal(out['deploy.waiting_merges'].value, 2);
    assert.doesNotMatch(out['deploy.waiting_merges'].source, / -- /, 'no path filter');
  } finally {
    fs.rmSync(path.join(root, 'wrangler.toml'));
  }
});
