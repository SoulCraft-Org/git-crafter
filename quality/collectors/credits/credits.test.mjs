// node --test quality/collectors/credits/credits.test.mjs
// Every input is synthetic and written to a temp folder at run time: a
// systems file, a usage file and a free-tier registry.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { loadTargets } from '../lib/score.mjs';
import { ConfigError } from '../github/github.mjs';
import { area, checkNoUsageApi, claimSteps, collect, metricIds, readUse, usage } from './credits.mjs';

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
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'credits-collector-'));
after(() => fs.rmSync(home, { recursive: true, force: true }));
const write = (p, data) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data));
};
const limit = (value, unit, read = '2026-11-03') => [{ label: 'a month', value, unit, source: 'https://example.com/pricing', read }];
write(path.join(home, 'code-os', 'systems.json'), {
  systems: [
    { id: 'ci', name: 'Hosted CI', limits: limit(300, 'USD') },
    { id: 'runner', name: 'Free runner', limits: limit(3000, 'minutes') },
    { id: 'gpu', name: 'GPU plan', limits: limit(4200, 'credits', '2026-10-20') },
    { id: 'llm', name: 'Free LLM', limits: limit(1000, 'requests'), usage: { why: 'its usage needs an API key from the owner' } },
  ],
});
write(path.join(home, 'code-os', 'data', 'org.json'), {
  generated_at: '2026-11-03T10:00:00Z',
  metrics: {
    'systems.ci.spent': { value: 310, source: 'billing' },
    'systems.runner.minutes': { could_not_check: 'one repo unread', source: 'guards', by_repo: { a: 1500, b: null } },
    'systems.gpu.used': { value: 118, source: 'status' },
  },
});
const row = (id, lane, org_status, extra = {}) => ({ id, name: id, provider: 'P', lane, price_month: 0, status: 'live', exclude: null, org_status, resets: 'monthly', checked: '2026-11-02', source: 'https://example.com', includes: 'Some minutes. More text.', ...extra });
write(path.join(home, 'reg', 'free.json'), {
  rows: [
    row('runner-free', 'ci', 'could_claim'),
    row('llm-free', 'inference', 'have'),
    row('other-ci', 'cpu', 'could_claim', { card: true }),
    row('china-llm', 'inference', 'could_claim', { exclude: 'china' }),
    row('paid-gpu', 'gpu', 'could_claim', { price_month: 10 }),
    row('free-gpu', 'gpu', 'could_claim'),
  ],
});
write(path.join(home, 'reg', 'plans.json'), { rows: [row('ci-plan', 'ci', 'use', { price_month: 21 }), row('gpu-plan', 'gpu', 'use', { price_month: 20 })] });

const params = {
  systems_file: '~/code-os/systems.json',
  usage_file: '~/code-os/data/org.json',
  registry: '~/reg',
  registry_files: ['free.json', 'plans.json'],
  claim_lanes: ['ci', 'gpu', 'inference'],
  lane_alias: { 'other-ci': 'ci' },
  lane_work: { ci: 'CI overflow' },
  allowances: [
    { id: 'ci', system: 'ci', registry: 'plans.json#ci-plan', usage: 'systems.ci.spent', pool: true },
    { id: 'runner', system: 'runner', registry: 'free.json#runner-free', status_override: { org_status: 'use' }, usage: 'systems.runner.minutes', pool: true, could_take_over: 'CI past the plan' },
    { id: 'gpu', system: 'gpu', registry: 'plans.json#gpu-plan', usage: 'systems.gpu.used' },
    { id: 'llm', system: 'llm', registry: 'free.json#llm-free' },
  ],
  pool_metrics: {
    'credits.actions_pool_used': 'ci',
    'credits.runner_pool_used': 'runner',
  },
};
const base = { mode: 'local', now, home, params };
const T = JSON.parse(fs.readFileSync(new URL('../../targets/credits.json', import.meta.url), 'utf8'));
const template = Object.assign({}, ...T.map((d) => d.params ?? {}));

test('targets: one per metric on the Credits tab, each goal cited', () => {
  const defs = ownTargets('credits.json').filter((d) => d.file === 'credits.json');
  assert.equal(area, 'credits');
  assert.deepEqual(defs.map((d) => d.id), metricIds);
  for (const d of defs) {
    assert.equal(d.tab, 'credits', d.id);
    assert.match(d.goal_source, /^(goal from |template goal, no public benchmark: )/, d.id);
  }
  // The template names no service of any org: no allowance, registry or file.
  assert.deepEqual([template.allowances, template.registry, template.systems_file, template.usage_file], [[], '', '', '']);
});

test('usage: a running total, a floor when a repo is unread, and no reader', () => {
  const org = { metrics: { x: { value: 5 }, y: { by_repo: { a: 10, b: null }, could_not_check: 'b unread' } } };
  assert.equal(usage({ usage: 'x' }, org).used, 5);
  const floor = usage({ usage: 'y' }, org);
  assert.deepEqual([floor.used, floor.ceiling, floor.floor], [10, null, true]);
  assert.equal(usage({ usage_why: 'needs a key' }, org).note, 'needs a key');
  assert.equal(claimSteps({ lane: 'ci', card: true }), 'sign up, add a card, grant its GitHub app to the org');
  assert.equal(claimSteps({ lane: 'inference' }), 'sign up, create an API key', 'a key that will read its use');
  assert.equal(claimSteps({ lane: 'gpu' }, 'no API reads its use'), 'sign up, no API reads its use', 'no key: nothing could read with it');
});

test('collect: a pool used up makes its lane over budget; its idle and unclaimed allowances count', async () => {
  const out = await collect(base);
  const rows = Object.fromEntries(out['credits.idle_replaceable'].detail.map((r) => [r.id, r]));
  assert.equal(rows.ci.status, 'over', '310 of 300 used this cycle');
  assert.equal(rows.runner.status, 'not read', 'one repo unread, so the pool total is a floor');
  assert.equal(rows.runner.used, 1500);
  assert.equal(rows.gpu.status, 'idle');
  assert.equal(rows.llm.status, 'not read');
  assert.match(rows.llm.claim_needs, /API key from the owner/);
  // Auto rows: the aliased CI runner and the free GPU; not the excluded or the paid one.
  assert.equal(rows['other-ci'].status, 'unclaimed');
  assert.equal(rows['other-ci'].could_take_over, 'CI overflow');
  assert.equal(rows['other-ci'].claim_needs, 'sign up, add a card, grant its GitHub app to the org');
  assert.ok(rows['free-gpu'] && !rows['china-llm'] && !rows['paid-gpu']);
  // Counted: other-ci (unclaimed, in the over-budget ci lane); the runner's use is unknown, so it is not.
  assert.equal(out['credits.idle_replaceable'].value, 1);
  assert.equal(out['credits.actions_pool_used'].value, 103.3);
  assert.match(out['credits.runner_pool_used'].could_not_check, /at least 1500 minutes/);
  assert.equal(out['credits.highest_used_share'].value, 2.8, 'the GPU plan; the pools are left out');
  assert.equal(out['credits.unclaimed_free'].value, 2);
  assert.equal(out['credits.usage_read_share'].value, 50, 'ci and gpu read; the runner is a floor, llm unread');
  assert.equal(out['credits.registry_age_days'].value, 14, 'the GPU limit was read on 2026-10-20');
});

test('collect: an allowance no API reads counts as unreadable, never as pending a key', async () => {
  const before = await collect(base);
  const buckets = (out) => Object.fromEntries(out['credits.usage_read_share'].detail.map((d) => [d.label, d.value]));
  assert.deepEqual(buckets(before), { 'Use read': 2, 'No API reads its use': 0, 'Needs a key or login': 1, 'No reader yet': 1 }, "llm's why names a key; the runner is a floor");
  assert.match(before['credits.usage_read_share'].source, /Not read: Free runner \(.+\); Free LLM \(its usage needs an API key from the owner\)/);
  const marked = await collect({ ...base, params: { ...params, no_usage_api: { llm: 'no API reads its use', 'free.json#free-gpu': 'no API reads its use' } } });
  assert.deepEqual(buckets(marked), { 'Use read': 2, 'No API reads its use': 1, 'Needs a key or login': 0, 'No reader yet': 1 });
  assert.equal(marked['credits.usage_read_share'].value, 50, 'still counted: unreadable, not left out');
  assert.match(marked['credits.usage_read_share'].source, /Free LLM \(no API reads its use\)/);
  const rows = Object.fromEntries(marked['credits.idle_replaceable'].detail.map((r) => [r.id, r]));
  assert.equal(rows['free-gpu'].claim_needs, 'sign up, no API reads its use', 'no key to create');
  assert.equal(rows.llm.claim_needs, 'no API reads its use');
});

test('params.no_usage_api: a key that names nothing, or a value that is no reason, is a config error', async () => {
  const typo = await collect({ ...base, params: { ...params, no_usage_api: { 'free.json#free-gpuu': 'no API reads its use' } } });
  for (const id of metricIds) assert.equal(typo[id].could_not_check, 'params.no_usage_api in targets/credits.json: free.json#free-gpuu names no allowance or registry row', id);
  const registry = { 'free.json': { rows: [{ id: 'free-gpu' }] } };
  const spec = { allowances: [{ id: 'llm', registry: 'free.json#llm-free' }] };
  for (const key of ['llm', 'free.json#llm-free', 'llm-free', 'free-gpu', 'free.json#free-gpu']) assert.doesNotThrow(() => checkNoUsageApi({ ...spec, no_usage_api: { [key]: 'no API reads its use' } }, registry), key);
  for (const why of ['', '  ', true, 3]) assert.throws(() => checkNoUsageApi({ no_usage_api: { llm: why } }), (err) => err instanceof ConfigError && /llm must give a reason/.test(err.message), String(why));
  // With no registry, as in a repo that lists only its allowances, a typo is still an error.
  assert.throws(() => checkNoUsageApi({ no_usage_api: { 'any-row': 'no API reads its use' } }), (err) => err instanceof ConfigError && /any-row names no allowance or registry row/.test(err.message));
  assert.doesNotThrow(() => checkNoUsageApi({ allowances: [{ id: 'llm' }], no_usage_api: { llm: 'no API reads its use' } }), 'an allowance id needs no registry');
  const noRegistry = await collect({ ...base, params: { ...params, registry: '', registry_files: [], no_usage_api: { 'any-row': 'no API reads its use' } } });
  assert.equal(noRegistry['credits.usage_read_share'].could_not_check, 'params.no_usage_api in targets/credits.json: any-row names no allowance or registry row');
  // A bare row id matches the allowance that names its row.
  const bare = await collect({ ...base, params: { ...params, no_usage_api: { 'llm-free': 'no API reads its use' } } });
  assert.match(bare['credits.usage_read_share'].source, /Free LLM \(no API reads its use\)/);
});

test('collect: CI mode and a missing checkout never read as 0', async () => {
  const ci = await collect({ ...base, mode: 'ci' });
  for (const id of metricIds) assert.ok(ci[id].could_not_check, id);
  const gone = await collect({ ...base, params: { ...params, systems_file: '~/missing/systems.json' } });
  for (const id of [...metricIds, 'credits.runner_pool_used']) assert.match(gone[id].could_not_check, /missing or unreadable/, id);
});

// CI mode: only a ci provider whose key the env holds is read, into credits.highest_used_share alone.
const KEY = 'fake-ci-key-value-4321';
const ciParams = {
  systems_file: '~/code-os/systems.json',
  allowances: [
    { id: 'hf', system: 'gpu', lane: 'gpu', status_override: { org_status: 'use' }, allowance: { label: 'a day', value: 5, unit: 'minutes', read: '2026-11-03' }, reader: { provider: 'huggingface' } },
    { id: 'or', system: 'llm', lane: 'inference', status_override: { org_status: 'use' }, reader: { provider: 'openrouter' } },
    { id: 'groq', system: 'llm', lane: 'inference', status_override: { org_status: 'use' }, reader: { provider: 'groq' } },
    { id: 'ci', system: 'ci', lane: 'ci', pool: true, status_override: { org_status: 'use' }, reader: { github_billing: 'acme' } },
  ],
  pool_metrics: { 'credits.actions_pool_used': 'ci' },
};
const answers = {
  'https://huggingface.co/api/spaces/zero-gpu/quota': { base: 300, current: 120 },
  'https://openrouter.ai/api/v1/key': { data: { free_model_daily_requests: { used: 400, limit: 1000 } } },
};
function ciFetch(calls) {
  return async (url, init) => {
    calls.push({ url, auth: init?.headers?.Authorization });
    return answers[url] ? new Response(JSON.stringify(answers[url])) : new Response(`{"echo":"${KEY}"}`, { status: 401 });
  };
}
const noExec = async () => {
  throw new Error('exec must not run in CI');
};
// Whatever fn writes to stdout and stderr while it runs.
async function printed(fn) {
  const out = [];
  const keep = [process.stdout.write, process.stderr.write];
  process.stdout.write = process.stderr.write = (chunk) => out.push(String(chunk)) > 0;
  try {
    return { result: await fn(), text: out.join('') };
  } finally {
    [process.stdout.write, process.stderr.write] = keep;
  }
}

test('collect: CI mode with HF_TOKEN and OPENROUTER_API_KEY reads those two alone; every other metric keeps its CI reason', async () => {
  const calls = [];
  const env = { HF_TOKEN: KEY, OPENROUTER_API_KEY: KEY, GROQ_API_KEY: KEY };
  const { result: out, text } = await printed(() => collect({ ...base, mode: 'ci', exec: noExec, providers: { env, fetch: ciFetch(calls) }, params: ciParams }));
  assert.deepEqual(calls.map((c) => c.url).sort(), Object.keys(answers).sort(), 'no Groq call: Groq stays local-only');
  assert.ok(calls.every((c) => c.auth === `Bearer ${KEY}`));
  const top = out['credits.highest_used_share'];
  assert.equal(top.value, 60, 'HF 3 of 5 minutes over OpenRouter 400 of 1000 requests');
  assert.deepEqual(top.detail.map((d) => d.label), ['GPU plan', 'Free LLM']);
  assert.match(top.source, /in CI only hf, or, read with repo secrets/);
  for (const id of metricIds.filter((m) => m !== 'credits.highest_used_share')) assert.match(out[id].could_not_check, /refreshed by a --local collect/, id);
  assert.ok(!JSON.stringify(out).includes(KEY) && !text.includes(KEY), 'no key in the result or the output');
});

test('collect: CI mode with no key, or a refused key, never reads as 0 and never prints the key', async () => {
  const calls = [];
  const none = await collect({ ...base, mode: 'ci', exec: noExec, providers: { env: { HF_TOKEN: ' ' }, fetch: ciFetch(calls) }, params: ciParams });
  for (const id of metricIds) assert.match(none[id].could_not_check, /refreshed by a --local collect/, id);
  assert.equal(calls.length, 0, 'no key, no call');
  const refused = async () => new Response(`{"error":"bad ${KEY}"}`, { status: 401 });
  const { result: bad, text } = await printed(() => collect({ ...base, mode: 'ci', exec: noExec, providers: { env: { OPENROUTER_API_KEY: KEY }, fetch: refused }, params: ciParams }));
  assert.match(bad['credits.highest_used_share'].could_not_check, /no allowance read in CI has a running total: Free LLM \(openrouter: GET \S+ answered HTTP 401\)/);
  assert.ok(!JSON.stringify(bad).includes(KEY) && !text.includes(KEY), 'no key in the result or the output');
  const gone = await collect({ ...base, mode: 'ci', providers: { env: { HF_TOKEN: KEY } }, params: { ...ciParams, systems_file: '~/missing.json' } });
  assert.match(gone['credits.highest_used_share'].could_not_check, /missing or unreadable/);
});

test('collect: with the template alone, no allowance is named, so nothing reads as 0', async () => {
  const out = await collect({ ...base, params: template });
  for (const id of metricIds) assert.match(out[id].could_not_check, /no allowance to read/, id);
});

test('collect: a relative file is read from the Git Crafter checkout, a ~/ file from home', async () => {
  const kit = fs.mkdtempSync(path.join(os.tmpdir(), 'credits-kit-'));
  try {
    fs.cpSync(path.join(home, 'code-os'), kit, { recursive: true });
    const out = await collect({ ...base, kit, params: { ...params, systems_file: 'systems.json', usage_file: 'data/org.json' } });
    assert.equal(out['credits.actions_pool_used'].value, 103.3);
  } finally {
    fs.rmSync(kit, { recursive: true, force: true });
  }
});

test('collect: a registry that names its status field otherwise is read through params.status_field', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'credits-field-'));
  try {
    const rename = (doc) => ({ rows: doc.rows.map(({ org_status, ...r }) => ({ ...r, claim: org_status })) });
    for (const f of ['free.json', 'plans.json']) fs.writeFileSync(path.join(dir, f), JSON.stringify(rename(JSON.parse(fs.readFileSync(path.join(home, 'reg', f), 'utf8')))));
    const allowances = params.allowances.map((a) => (a.status_override ? { ...a, status_override: { claim: a.status_override.org_status } } : a));
    const out = await collect({ ...base, params: { ...params, registry: dir, status_field: 'claim', allowances } });
    assert.equal(out['credits.unclaimed_free'].value, 2, 'the same rows as with org_status');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readers: GitHub billing sums the product gross; a plan file a day old, or gh failing, is not read and never 0', async () => {
  const bill = { timePeriod: { year: 2026, month: 11 }, usageItems: [{ product: 'Actions', sku: 'linux', grossAmount: 98.08 }, { product: 'Actions', sku: 'mac', grossAmount: 9.05 }, { product: 'Packages', sku: 'x', grossAmount: 5 }] };
  const ok = async () => JSON.stringify(bill);
  assert.equal((await readUse({ github_billing: 'acme' }, { exec: ok })).used.value, 107.13);
  const fail = async () => { throw Object.assign(new Error('x'), { stderr: 'HTTP 403' }); };
  assert.match((await readUse({ github_billing: 'acme' }, { exec: fail })).why, /HTTP 403/);
  const root = path.join(home, 'repo');
  write(path.join(root, 'data', 'plan.json'), { read_at: '2026-11-03T10:00:00Z', windows: [{ label: 'Weekly · all models', percentUsed: 62 }] });
  assert.equal((await readUse({ plan_file: 'data/plan.json' }, { root, now })).used.value, 62);
  assert.match((await readUse({ plan_file: 'data/plan.json' }, { root, now: new Date('2026-11-05T12:00:00Z') })).why, /last day/);
  const params = {
    systems_file: '~/code-os/systems.json',
    allowances: [
      { id: 'ci', system: 'ci', lane: 'ci', pool: true, status_override: { org_status: 'use' }, reader: { github_billing: 'acme' } },
      { id: 'plan', system: 'ci', lane: 'agents', status_override: { org_status: 'use' }, allowance: { label: 'weekly', value: 100, unit: '%', read: '2026-11-03' }, reader: { plan_file: 'data/plan.json' } },
    ],
    pool_metrics: { 'credits.actions_pool_used': 'ci' },
  };
  const out = await collect({ mode: 'local', now, home, root, exec: ok, params });
  assert.equal(out['credits.actions_pool_used'].value, 35.7);
  assert.equal(out['credits.highest_used_share'].value, 62);
  assert.equal(out['credits.usage_read_share'].value, 100);
  const down = await collect({ mode: 'local', now, home, root, exec: fail, params });
  assert.match(down['credits.actions_pool_used'].could_not_check, /HTTP 403/);
});
