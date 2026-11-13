// node --test quality/collectors/claude/lead-time.test.mjs
// Every PR, check and deploy is synthetic; the local test reads the Claude
// tab's synthetic transcripts under quality/fixtures/claude/projects/.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadTargets, scoreMetric } from '../lib/score.mjs';
import { area, collect, ID, leadTime, liveTimes, STEPS } from './lead-time.mjs';

const T0 = Date.parse('2026-11-01T00:00:00Z');
const iso = (h) => new Date(T0 + h * 36e5).toISOString();
const pull = (number, { opened, green, merged, state = 'SUCCESS' }) => ({
  number,
  createdAt: iso(opened),
  mergedAt: iso(merged),
  headCommit: { nodes: [{ commit: { statusCheckRollup: { state, contexts: { nodes: [{ __typename: 'CheckRun', name: 'verify', conclusion: state, completedAt: iso(green) }] } } } }] },
});
const deploy = (created, live, state = 'SUCCESS') => ({ createdAt: iso(created), statuses: { nodes: [{ state: 'IN_PROGRESS', createdAt: iso(created) }, { state, createdAt: iso(live) }] } });

// Spans in hours, session start to PR open, PR open to green, green to merge, merge to live:
// #1 2, 1, 2, 1; #2 1, 0.5, 0.5, 0.5; #3 4, 4, 6, 1. Medians 2, 1, 2, 1: total 6.
const PULLS = [
  pull(1, { opened: 0, green: 1, merged: 3 }),
  pull(2, { opened: 10, green: 10.5, merged: 11 }),
  pull(3, { opened: 20, green: 24, merged: 30 }),
  pull(4, { opened: 21, green: 22, merged: 23, state: 'FAILURE' }), // red head: left out
  pull(5, { opened: 39, green: 39.5, merged: 40 }), // merged after the last deploy: not live yet
];
const DEPLOYS = [deploy(3.5, 4), deploy(11.2, 11.5), deploy(30.05, 30.08, 'FAILURE'), deploy(30.1, 31)];
const STARTS = new Map([[1, T0 - 2 * 36e5], [2, T0 + 9 * 36e5], [3, T0 + 16 * 36e5]]);
const rows = (r) => Object.fromEntries(r.detail.map((d) => [d.label, d.value]));
const sum = (r) => Math.round(r.detail.reduce((a, d) => a + d.value, 0) * 100) / 100;

test('local: the four segments, over the same PRs, add up to the total', () => {
  const r = leadTime(PULLS, liveTimes(DEPLOYS), { starts: STARTS });
  assert.deepEqual(rows(r), { [STEPS[0]]: 2, [STEPS[1]]: 1, [STEPS[2]]: 2, [STEPS[3]]: 1 });
  assert.equal(r.value, 6);
  assert.equal(sum(r), r.value);
  assert.equal(r.prs, 3, 'the red head and the PR not live yet are left out');
  assert.deepEqual(r.missing, []);
});

test('CI: the three GitHub segments over the same PRs, and the session step named missing, never a zero', () => {
  const r = leadTime(PULLS, liveTimes(DEPLOYS), { starts: null });
  assert.deepEqual(r.detail.map((d) => d.label), STEPS.slice(1));
  assert.deepEqual(r.detail.map((d) => d.part), [2, 3, 4], 'each step keeps its color');
  assert.equal(r.value, 4);
  assert.equal(sum(r), r.value);
  assert.equal(r.prs, 3);
  assert.deepEqual(r.missing.map((m) => m.label), [STEPS[0]]);
  assert.match(r.missing[0].reason, /transcripts live on the machine/);
});

test('local with no linked session falls back to the GitHub steps and says why', () => {
  const r = leadTime(PULLS, liveTimes(DEPLOYS), { starts: new Map() });
  assert.equal(r.value, 4);
  assert.match(r.missing[0].reason, /none of these PRs was linked/);
});

test('no deploy read: merge to live is named missing; nothing timed is null', () => {
  const r = leadTime(PULLS, [], { starts: STARTS, environment: 'github-pages' });
  assert.deepEqual(r.detail.map((d) => d.label), STEPS.slice(0, 3));
  assert.deepEqual(r.missing.map((m) => m.label), [STEPS[3]]);
  assert.equal(sum(r), r.value);
  assert.equal(leadTime([PULLS[3]], liveTimes(DEPLOYS)), null);
});

test('a check that finishes after the merge is no part of the wait for green', () => {
  const p = pull(1, { opened: 0, green: 1, merged: 3 });
  p.headCommit.nodes[0].commit.statusCheckRollup.contexts.nodes.push({ __typename: 'CheckRun', name: 'cleanup', conclusion: 'SUCCESS', completedAt: iso(3.01) });
  assert.deepEqual(rows(leadTime([p], liveTimes(DEPLOYS))), { [STEPS[1]]: 1, [STEPS[2]]: 2, [STEPS[3]]: 1 });
});

test('only the last N timed PRs count', () => {
  const r = leadTime(PULLS, liveTimes(DEPLOYS), { starts: STARTS, n: 1 });
  assert.equal(r.prs, 1);
  assert.deepEqual(rows(r), { [STEPS[0]]: 4, [STEPS[1]]: 4, [STEPS[2]]: 6, [STEPS[3]]: 1 }, '#3, the latest merge');
});

const fakeGh = (fail) => ({
  graphql: async (query, vars) => {
    if (fail) throw new Error('HTTP 502: Bad Gateway\nmore');
    assert.deepEqual(vars, { owner: 'acme', name: 'site', env: 'github-pages' });
    return { repository: { pullRequests: { nodes: PULLS }, deployments: { nodes: DEPLOYS } } };
  },
});
const now = new Date('2026-11-03T12:00:00Z');

test('collect in CI: unscored, naming the missing step, its read steps kept; a failed read is could_not_check', async () => {
  assert.equal(area, 'lead_time');
  const r = await collect({ mode: 'ci', params: { repo: 'acme/site' }, gh: fakeGh(), now });
  assert.ok(!('value' in r[ID]), 'a partial total carries no value');
  assert.equal(r[ID].could_not_check, `not scored: ${STEPS[0]} not read (transcripts live on the machine that ran the sessions; refreshed by a --local collect there); the 3 steps read add up to 4 h`);
  assert.deepEqual(scoreMetric(def(), r[ID]), { status: 'not-measured', points: null });
  assert.deepEqual(r[ID].detail.map((d) => d.label), STEPS.slice(1));
  assert.equal(r[ID].missing[0].label, STEPS[0]);
  assert.equal(r[ID].read_at, now.toISOString());
  assert.match(r[ID].source, /3 PRs$/);
  const bad = await collect({ mode: 'ci', params: { repo: 'acme/site' }, gh: fakeGh(true), now });
  assert.equal(bad[ID].could_not_check, 'gh api graphql failed: HTTP 502: Bad Gateway');
  assert.ok(!('value' in bad[ID]));
});

test('collect in local mode reads session starts from the Claude tab transcripts', async () => {
  const projects = fileURLToPath(new URL('../../fixtures/claude/projects/', import.meta.url));
  const allParams = { 'claude.json': { projects_dir: projects, project_match: 'acme-site' } };
  const r = await collect({ mode: 'local', params: { repo: 'acme/site' }, allParams, gh: fakeGh(), now });
  // The fixture sessions link acme/site #1 to #7 and start before each opens here, so all four steps read.
  assert.deepEqual(r[ID].detail.map((d) => d.label), STEPS);
  assert.deepEqual(r[ID].missing, []);
  assert.equal(sum(r[ID]), r[ID].value);
  assert.equal(r[ID].could_not_check, undefined);
  // The fixture sessions start well before these PRs open: 52 h in all, scored, near the 24 h goal.
  assert.equal(r[ID].value, 52);
  assert.deepEqual(scoreMetric(def(), r[ID]), { status: 'near', points: 50 }, 'the full total scores against 24 h');
  assert.deepEqual(scoreMetric(def(), { ...r[ID], value: 6 }), { status: 'meets', points: 100 });
  assert.deepEqual(scoreMetric(def(), { ...r[ID], value: 200 }), { status: 'misses', points: 0 });
});

// The template's definition of the metric, as the engine loads it.
function def() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lead-def-'));
  try {
    fs.copyFileSync(new URL('../../targets/lead-time.json', import.meta.url), path.join(dir, 'lead-time.json'));
    return loadTargets(dir)[0];
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('the targets file loads, with a stack chart and a sourced goal', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lead-targets-'));
  try {
    fs.copyFileSync(new URL('../../targets/lead-time.json', import.meta.url), path.join(dir, 'lead-time.json'));
    const [def] = loadTargets(dir);
    assert.deepEqual([def.id, def.chart, def.goal, def.near, def.unit], [ID, 'stack', 24, 168, 'h']);
    assert.match(def.goal_source, /^goal from DORA/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
