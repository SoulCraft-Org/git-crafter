// node --test quality/collectors/site/deploy-pages.test.mjs
// Every input is synthetic: a fake gh client answers each GitHub API route
// from quality/fixtures/deploy/pages-api.json.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { collect, metricIds } from './deploy.mjs';
import { collectPages, readDeploys } from './deploy-pages.mjs';

const API = JSON.parse(fs.readFileSync(new URL('../../fixtures/deploy/pages-api.json', import.meta.url), 'utf8'));
const now = new Date('2026-11-03T12:00:00Z');
const fakeGh = (routes = API) => ({
  rest: async (route) => {
    if (!(route in routes)) throw new Error(`no fixture for ${route}`);
    return structuredClone(routes[route]);
  },
});
const params = { platform: 'pages', repo: 'o/r' };

test('pages: every Deploy metric is read from the GitHub API', async () => {
  const m = await collectPages({ repo: 'o/r', gh: fakeGh(), now, params });
  assert.deepEqual(Object.keys(m).sort(), [...metricIds].sort(), 'the same ids as the Wrangler reader');
  assert.equal(m['deploy.waiting_merges'].value, 1);
  assert.equal(m['deploy.oldest_waiting_hours'].value, 1);
  assert.equal(m['deploy.latest_lead_hours'].value, 9.1, 'merge d at 01:00, live at 10:06');
  assert.equal(m['deploy.latest_failed'].value, 0);
  assert.equal(m['deploy.failure_rate_last10'].value, 25, '1 failure of 4 ended deploys');
  assert.equal(m['deploy.latest_restore_hours'].value, 7.9, 'failed 02:12, restored 10:06');
  assert.equal(m['deploy.latest_build_minutes'].value, 10, 'every run on the push: pages 3 + 1, verify 6');
  assert.deepEqual(m['deploy.latest_build_minutes'].detail.map((r) => r.label), ['pages', 'verify']);
  const rows = m['deploy.failure_rate_last10'].detail;
  assert.deepEqual(rows.map((r) => r.commit), ['bbbbbbb', 'ccccccc', 'ddddddd', 'eeeeeee']);
  assert.equal(rows[2].failed, 'its Pages deployment ended in failure');
  assert.equal(rows[2].restore_hours, 7.9);
  assert.equal(rows[3].value, 2, 'deploy e shipped d and e');
});

test('pages: a deploy still in progress is left out', async () => {
  const d = await readDeploys(fakeGh(), 'o/r');
  assert.deepEqual(d.map((x) => x.id), [2, 3, 4, 5]);
});

test('pages: deploy.mjs picks the reader by params.platform', async () => {
  const m = await collect({ root: '.', mode: 'ci', now, params, gh: fakeGh() });
  assert.equal(m['deploy.failure_rate_last10'].value, 25, 'read in CI too, unlike Wrangler');
});

test('pages: a failed read is could_not_check, never 0', async () => {
  const broken = { rest: async () => { throw new Error('HTTP 403: Resource not accessible'); } };
  for (const m of [await collectPages({ repo: 'o/r', gh: broken, now, params }), await collectPages({ repo: '', gh: fakeGh(), now, params })]) {
    for (const id of metricIds) {
      assert.equal(m[id].value, undefined, id);
      assert.ok(m[id].could_not_check, id);
    }
  }
  const none = await collectPages({ repo: 'o/r', gh: fakeGh({ ...API, 'repos/o/r/deployments?environment=github-pages&per_page=30': [] }), now, params });
  assert.match(none['deploy.latest_failed'].could_not_check, /no ended deploy/);
});

test('pages: a failure not yet restored runs to now', async () => {
  const routes = { ...API, 'repos/o/r/deployments/5/statuses?per_page=10': [{ state: 'error', created_at: '2026-11-03T10:06:00Z' }] };
  const m = await collectPages({ repo: 'o/r', gh: fakeGh(routes), now, params });
  assert.equal(m['deploy.latest_failed'].value, 1);
  assert.equal(m['deploy.failure_rate_last10'].value, 50);
  assert.equal(m['deploy.latest_restore_hours'].value, 1.9, 'failed 10:06, now 12:00');
  assert.match(m['deploy.latest_restore_hours'].source, /not restored yet/);
});

test('pages: the commit this run builds, and every merge before it, does not wait (#641)', async () => {
  const f = 'f'.repeat(40);
  const g = { sha: 'a'.repeat(40), commit: { committer: { date: '2026-11-03T11:30:00Z' } } };
  const routes = { ...API, 'repos/o/r/compare/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee...main': { commits: [...API['repos/o/r/compare/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee...main'].commits, g] } };
  const built = await collectPages({ repo: 'o/r', gh: fakeGh(), now, params, building: f });
  assert.equal(built['deploy.waiting_merges'].value, 0, 'the build of f ships f');
  assert.equal(built['deploy.oldest_waiting_hours'].value, 0);
  const later = await collectPages({ repo: 'o/r', gh: fakeGh(routes), now, params, building: f });
  assert.deepEqual(later['deploy.waiting_merges'].detail.map((r) => r.label), ['aaaaaaa'], 'a merge after the built one still waits');
  const pr = await collectPages({ repo: 'o/r', gh: fakeGh(routes), now, params, building: 'b'.repeat(40) });
  assert.equal(pr['deploy.waiting_merges'].value, 2, 'a pull request build is not on main, so nothing leaves the count');
});
