// node --test quality/collectors/credits/providers.test.mjs
// Offline: every call is a fake fetch or a fake exec, and every key is a
// made-up string. Each provider is read with its key present, missing and
// failing; none reads as 0 when it could not read.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readUse } from './credits.mjs';
import { ciReadable, PROVIDERS, readProvider, scrub } from './providers.mjs';

const KEY = 'fake-key-value-1234';
const ENV = { MODAL_TOKEN_ID: 'fake-id-5678', MODAL_TOKEN_SECRET: 'fake-secret-9012', HF_TOKEN: KEY, GROQ_API_KEY: KEY, OPENROUTER_API_KEY: KEY };

// A fetch that answers one URL with `body` and `headers`, and records each call's URL and auth header.
function fakeFetch(url, { status = 200, body = {}, headers = {} } = {}, calls = []) {
  return async (got, init) => {
    calls.push({ url: got, auth: init?.headers?.Authorization });
    if (got !== url) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(body), { status, headers });
  };
}
const offline = async () => {
  throw new TypeError(`fetch failed: connect ECONNREFUSED, auth ${KEY}`);
};
const noExec = async () => {
  throw new Error('exec must not run');
};
const read = (provider, opts) => readProvider({ provider }, { env: ENV, exec: noExec, fetch: offline, ...opts });

test('every provider with no key is not read, names the env var, and makes no call', async () => {
  for (const [provider, p] of Object.entries(PROVIDERS)) {
    const calls = [];
    const r = await readProvider({ provider }, { env: {}, fetch: fakeFetch('x', {}, calls), exec: noExec });
    assert.equal(r.used, undefined, provider);
    for (const k of p.keys) assert.match(r.why, new RegExp(`${k}.*API key from the owner`), provider);
    assert.equal(calls.length, 0, provider);
  }
  assert.match((await readProvider({ provider: 'modal' }, { env: { MODAL_TOKEN_ID: 'x' } })).why, /^needs MODAL_TOKEN_SECRET in/);
  assert.match((await readProvider({ provider: 'huggingface' }, { env: {} })).why, /^needs HF_TOKEN in CI as a repo secret or in a --local collect's environment/);
  assert.match((await readProvider({ provider: 'groq' }, { env: {} })).why, /^needs GROQ_API_KEY in a --local collect's environment/, 'Groq stays local-only');
  assert.match((await readProvider({ provider: 'nope' }, { env: ENV })).why, /unknown provider "nope"/);
});

test('modal: billing summary metered_cost this month, keys in the CLI env only; a failed or bad run is not read', async () => {
  let seen;
  const exec = async (cmd, args, env) => {
    seen = { cmd, args, env };
    return JSON.stringify({ metered_cost: '12.345', billed_cost: '0', adjustments: {}, metered_cost_breakdown: {} });
  };
  const r = await read('modal', { exec });
  assert.equal(r.used.value, 12.35);
  assert.match(r.used.source, /modal billing summary --for "this month" --json: metered_cost/);
  assert.deepEqual(seen.args, ['billing', 'summary', '--for', 'this month', '--json']);
  assert.equal(seen.env.MODAL_TOKEN_SECRET, ENV.MODAL_TOKEN_SECRET);
  assert.ok(!seen.args.join(' ').includes('fake-'), 'no key on the command line');
  const failed = await read('modal', { exec: async () => { throw Object.assign(new Error('x'), { stderr: `Error: token fake-secret-9012 is not on a Team plan\nmore` }); } });
  assert.equal(failed.why, 'modal: Error: token [key] is not on a Team plan');
  assert.match((await read('modal', { exec: async () => { throw Object.assign(new Error('spawn modal ENOENT'), { code: 'ENOENT' }); } })).why, /modal CLI is not installed/);
  assert.match((await read('modal', { exec: async () => '{"billed_cost":"1"}' })).why, /no metered_cost/);
});

test('huggingface: ZeroGPU base less current, in minutes; a refused or odd answer is not read', async () => {
  const url = 'https://huggingface.co/api/spaces/zero-gpu/quota';
  const calls = [];
  const r = await read('huggingface', { fetch: fakeFetch(url, { body: { base: 300, current: 120, resetsAt: '2026-11-12T08:00:00Z', overquotaUsed: 0 } }, calls) });
  assert.equal(r.used.value, 3);
  assert.match(r.used.source, /of 5 minutes, resets 2026-11-12/);
  assert.deepEqual(calls, [{ url, auth: `Bearer ${KEY}` }]);
  assert.equal((await read('huggingface', { fetch: fakeFetch(url, { body: { base: 300, current: 300, resetsAt: null } }) })).used.value, 0, 'an unused window is a read 0');
  assert.equal((await read('huggingface', { fetch: fakeFetch(url, { status: 401, body: { error: KEY } }) })).why, `huggingface: GET ${url} answered HTTP 401`);
  assert.match((await read('huggingface', { fetch: fakeFetch(url, { body: { error: 'x' } }) })).why, /no base and current/);
  const down = await read('huggingface');
  assert.ok(!down.why.includes(KEY), 'the key is cut from the reason');
  assert.match(down.why, /fetch failed.*\[key\]/);
});

test('groq: requests a day from the models call\'s rate-limit headers; none, or a refusal, is not read', async () => {
  const url = 'https://api.groq.com/openai/v1/models';
  const headers = { 'x-ratelimit-limit-requests': '1000', 'x-ratelimit-remaining-requests': '940' };
  const r = await read('groq', { fetch: fakeFetch(url, { body: { data: [] }, headers }) });
  assert.equal(r.used.value, 60);
  assert.match(r.used.source, /of 1000 requests a day/);
  assert.match((await read('groq', { fetch: fakeFetch(url, { body: { data: [] } }) })).why, /without the x-ratelimit requests headers/);
  assert.equal((await read('groq', { fetch: fakeFetch(url, { status: 403 }) })).why, `groq: GET ${url} answered HTTP 403`);
  assert.match((await read('groq')).why, /^groq: fetch failed/);
});

test('openrouter: free-model requests used this UTC day; a refusal or no counter is not read', async () => {
  const url = 'https://openrouter.ai/api/v1/key';
  const body = { data: { label: 'x', usage: 0, is_free_tier: true, free_model_daily_requests: { used: 17, limit: 50, remaining: 33 } } };
  const r = await read('openrouter', { fetch: fakeFetch(url, { body }) });
  assert.equal(r.used.value, 17);
  assert.match(r.used.source, /free_model_daily_requests.used of 50, this UTC day/);
  assert.match((await read('openrouter', { fetch: fakeFetch(url, { body: { data: { usage: 3 } } }) })).why, /no data.free_model_daily_requests.used/);
  assert.equal((await read('openrouter', { fetch: fakeFetch(url, { status: 500 }) })).why, `openrouter: GET ${url} answered HTTP 500`);
});

test('readUse hands a provider reader its env, fetch and exec', async () => {
  const url = 'https://openrouter.ai/api/v1/key';
  const body = { data: { free_model_daily_requests: { used: 4, limit: 50, remaining: 46 } } };
  assert.equal((await readUse({ provider: 'openrouter' }, { providers: { env: ENV, fetch: fakeFetch(url, { body }) } })).used.value, 4);
  assert.match((await readUse({ provider: 'openrouter' }, { providers: { env: {} } })).why, /OPENROUTER_API_KEY/);
});

test('ciReadable: Hugging Face and OpenRouter with their key; never Modal or Groq, a blank key or an unknown reader', () => {
  assert.equal(ciReadable({ provider: 'huggingface' }, ENV), true);
  assert.equal(ciReadable({ provider: 'openrouter' }, ENV), true);
  for (const provider of ['modal', 'groq', 'nope']) assert.equal(ciReadable({ provider }, ENV), false, provider);
  assert.equal(ciReadable({ provider: 'huggingface' }, { HF_TOKEN: '  ' }), false);
  assert.equal(ciReadable({ github_billing: 'acme' }, ENV), false);
});

test('scrub cuts every key value and leaves short or empty ones alone', () => {
  assert.equal(scrub('a fake-key-value-1234 b fake-key-value-1234', [KEY, '']), 'a [key] b [key]');
  assert.equal(scrub('abc', ['ab']), 'abc');
});
