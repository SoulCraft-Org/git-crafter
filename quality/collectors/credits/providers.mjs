// The Credits tab's provider readers (#836): one read-only call a provider, its
// use this cycle in the unit of its systems.json limit. Each reads its key from
// the collect's environment, never from a file, and sends it only in the
// call's own header or the vendor CLI's environment. A --local collect reads
// all four. A CI collect reads only those marked ci, from repo secrets that
// actions/pages passes into the collect step's env on main alone. A missing key or a
// failed call gives { why }, so the row reads "not read" with the reason, never
// 0. No reason holds a response body or a header, and every key value is cut
// from an error's text before it becomes one.
//
// Endpoints, each read on its vendor's docs on 2026-11-11:
//   modal: `modal billing summary --for "this month" --json`, its metered_cost
//     in USD before credits, against the monthly credit. Modal has no REST
//     billing API; the CLI fronts Workspace.billing.
//     https://modal.com/docs/reference/cli/billing and
//     https://modal.com/docs/guide/billing (Team and Enterprise workspaces).
//   huggingface: GET https://huggingface.co/api/spaces/zero-gpu/quota, base
//     less current (GPU-seconds) in minutes, this daily window.
//     https://huggingface.co/.well-known/openapi.json ("Get ZeroGPU quota").
//   groq: GET https://api.groq.com/openai/v1/models, a call that runs no model;
//     the x-ratelimit-limit-requests less x-ratelimit-remaining-requests
//     headers, which Groq says always count requests per day. Groq documents no
//     usage endpoint below Enterprise. https://console.groq.com/docs/rate-limits
//   openrouter: GET https://openrouter.ai/api/v1/key, its
//     data.free_model_daily_requests.used this UTC day.
//     https://openrouter.ai/docs/api/reference/limits and
//     https://openrouter.ai/docs/api/api-reference/api-keys/get-current-key

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { finite, round } from './credits-metrics.mjs';

const TIMEOUT_MS = 20_000;
const execAsync = promisify(execFile);
// The vendor CLI's stdout; its env carries the keys, never its arguments.
const defaultExec = async (cmd, args, env) => (await execAsync(cmd, args, { env, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 })).stdout;

// Each provider: the env vars it needs, how it reads them, and ci when a CI
// collect may read it: its keys are Git Crafter repo secrets (the compute repo's
// DECISIONS.md, 2026-11-11).
export const PROVIDERS = {
  modal: { keys: ['MODAL_TOKEN_ID', 'MODAL_TOKEN_SECRET'], read: readModal },
  huggingface: { keys: ['HF_TOKEN'], read: readHuggingFace, ci: true },
  groq: { keys: ['GROQ_API_KEY'], read: readGroq },
  openrouter: { keys: ['OPENROUTER_API_KEY'], read: readOpenRouter, ci: true },
};

// The env vars a provider needs that env lacks or holds blank.
const absentKeys = (p, env) => p.keys.filter((k) => !String(env[k] ?? '').trim());

// True when a CI collect may run this { provider } reader: a ci provider whose keys env holds.
export function ciReadable(reader, env = process.env) {
  const p = PROVIDERS[reader?.provider];
  return Boolean(p?.ci) && !absentKeys(p, env).length;
}

// { used: { value, source } } or { why } for a { provider } reader.
export async function readProvider(reader, { env = process.env, fetch = globalThis.fetch, exec = defaultExec } = {}) {
  const p = PROVIDERS[reader.provider];
  if (!p) return { why: `unknown provider ${JSON.stringify(reader.provider)}; one of ${Object.keys(PROVIDERS).join(', ')}` };
  const absent = absentKeys(p, env);
  const where = p.ci ? "in CI as a repo secret or in a --local collect's environment" : "in a --local collect's environment";
  if (absent.length) return { why: `needs ${absent.join(' and ')} ${where}, an API key from the owner` };
  const secrets = p.keys.map((k) => String(env[k]));
  try {
    return await p.read({ env, fetch, exec, key: secrets[0] });
  } catch (err) {
    return { why: `${reader.provider}: ${scrub(reasonOf(err), secrets)}` };
  }
}

// The first line of an error, cut to 160 characters.
const reasonOf = (err) => String(err?.stderr || err?.message || err).trim().split('\n')[0].slice(0, 160);

// Text with every key value taken out.
export function scrub(text, secrets) {
  let out = String(text);
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join('[key]');
  return out;
}

// GET url with the key as a bearer token: the response, or a throw naming the status only.
async function get(fetch, url, key) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`GET ${url} answered HTTP ${res.status}`);
  return res;
}

async function readModal({ env, exec }) {
  const args = ['billing', 'summary', '--for', 'this month', '--json'];
  let out;
  try {
    out = await exec('modal', args, { ...env, NO_COLOR: '1', TERM: 'dumb' });
  } catch (err) {
    if (err?.code === 'ENOENT') throw new Error('the modal CLI is not installed', { cause: err });
    throw err;
  }
  const cost = Number(JSON.parse(out).metered_cost);
  if (!finite(cost)) throw new Error('modal billing summary gave no metered_cost');
  return { used: { value: round(cost, 2), source: 'modal billing summary --for "this month" --json: metered_cost in USD, before credits' } };
}

async function readHuggingFace({ fetch, key }) {
  const url = 'https://huggingface.co/api/spaces/zero-gpu/quota';
  const q = await (await get(fetch, url, key)).json();
  if (!finite(q?.base) || !finite(q?.current)) throw new Error(`GET ${url} gave no base and current GPU-seconds`);
  const resets = q.resetsAt ? `, resets ${q.resetsAt}` : ', unused this window';
  return { used: { value: round(Math.max(q.base - q.current, 0) / 60, 2), source: `GET ${url}: base less current, of ${round(q.base / 60, 1)} minutes${resets}` } };
}

async function readGroq({ fetch, key }) {
  const url = 'https://api.groq.com/openai/v1/models';
  const res = await get(fetch, url, key);
  const limit = Number(res.headers.get('x-ratelimit-limit-requests'));
  const left = Number(res.headers.get('x-ratelimit-remaining-requests'));
  if (!res.headers.get('x-ratelimit-limit-requests') || !finite(limit) || !finite(left)) throw new Error(`GET ${url} answered without the x-ratelimit requests headers, and Groq documents no usage endpoint below Enterprise`);
  return { used: { value: Math.max(limit - left, 0), source: `GET ${url}: x-ratelimit-limit-requests less x-ratelimit-remaining-requests, of ${limit} requests a day` } };
}

async function readOpenRouter({ fetch, key }) {
  const url = 'https://openrouter.ai/api/v1/key';
  const free = (await (await get(fetch, url, key)).json())?.data?.free_model_daily_requests;
  if (!finite(free?.used)) throw new Error(`GET ${url} gave no data.free_model_daily_requests.used`);
  const of = finite(free.limit) ? ` of ${free.limit}` : '';
  return { used: { value: free.used, source: `GET ${url}: data.free_model_daily_requests.used${of}, this UTC day` } };
}
