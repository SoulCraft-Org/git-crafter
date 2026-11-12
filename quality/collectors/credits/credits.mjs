// Credits tab collector: every free tier, free credit and plan allowance the
// org has or could claim, and whether any sits idle while paid or
// over-budget work runs, so free and included capacity is used first.
//
// Reads, all local files, never a credential file, each named in params:
//   - systems_file: each system's free or included limit, its source page and
//     the day it was read ({ systems: [{ id, name, limits: [...] }] }, the
//     shape of Git Crafter systems.json)
//   - usage_file: what each allowance has used this cycle ({ metrics: { id:
//     { value } } }, the shape of Git Crafter data/org.json)
//   - registry and registry_files: a free-tier registry's rows (name, lane,
//     resets, card and the org's claim status only: the field
//     params.status_field names, default org_status)
// A relative path is from the Git Crafter checkout this file runs from; ~/ is
// home. Each is optional. The allowances to show, what each could take over
// and what claiming one needs are params.allowances, so this file holds no
// account's systems; the template lists none. Every other free, live,
// unclaimed registry row in params.claim_lanes is listed too, as unclaimed.
// params.no_usage_api names the allowances and registry rows whose use no API
// reads, each with why: they count as unreadable, never as pending a key.
//
// Every metric is a state now or a running total this cycle, never an
// average over days or a projection. A lane is over budget when an allowance
// in it has used all it includes this cycle. An allowance in that lane that
// is unclaimed, or claimed with use known to be under its limit, could take
// over: that count is the tab's headline, goal 0. A pool every repo draws on
// (pool: true, such as GitHub's included Actions minutes for an org) is read
// whole, never split into repo shares; params.pool_metrics names the metric
// id that reports each.
//
// Contract: quality/targets/credits.json lists every metric id. collect()
// never throws for a missing file, and never turns "could not read" into 0.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError } from '../github/github.mjs';

import { cnc, DAY, finite, metricsFrom, round } from './credits-metrics.mjs';
import { redact } from '../lib/redact.mjs';
import { ciReadable, readProvider } from './providers.mjs';

export const area = 'credits';

const TARGETS = JSON.parse(fs.readFileSync(new URL('../../targets/credits.json', import.meta.url), 'utf8'));
export const metricIds = TARGETS.map((t) => t.id);
// The template's own params, merged as the engine merges a file's: the
// defaults for a bare call. The engine passes the repo's merged params.
const TEMPLATE = Object.assign({}, ...TARGETS.map((t) => t.params ?? {}));
// The Git Crafter checkout this file runs from: quality/collectors/ is two below it.
const KIT_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const CI_REASON = 'reads local files named in params; refreshed by a --local collect';
const CLAIMED = new Set(['have', 'use']);

const expand = (p, home) => String(p ?? '').replace(/^~(?=\/|$)/, home);
// ~/ is home; any other relative path is from the Git Crafter checkout.
const resolveFrom = (p, home, kit) => path.resolve(kit, expand(p, home));
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

// "free.json#some-provider" -> that row of the registry, or null.
function registryRow(registry, ref) {
  if (!ref) return null;
  const [file, id] = String(ref).split('#');
  return registry[file]?.rows?.find((r) => r.id === id) ?? null;
}

// What an allowance has used this cycle, a running total: { used, ceiling,
// known, floor, note }. A reading with by_repo and an unread repo is a floor:
// the pool's use is at least the repos read, and its unused part is unknown.
export function usage(spec, org) {
  if (spec.used) return { used: spec.used.value, ceiling: spec.used.value, known: true, note: spec.used.source };
  if (!spec.usage) return { used: null, ceiling: null, known: false, note: spec.usage_why ?? 'no reader for this allowance' };
  const m = org?.metrics?.[spec.usage];
  if (!m) return { used: null, ceiling: null, known: false, note: `${spec.usage} is not in params.usage_file` };
  if (finite(m.value)) return { used: m.value, ceiling: m.value, known: true, note: m.source, read_at: m.read_at };
  const read = Object.values(m.by_repo ?? {}).filter(finite);
  if (read.length) return { used: read.reduce((a, b) => a + b, 0), ceiling: null, known: false, floor: true, note: `${m.source}: ${m.could_not_check ?? 'some repos unread'}` };
  return { used: null, ceiling: null, known: false, note: m.could_not_check ?? 'no value' };
}

// One table row per allowance.
export function allowances({ systems, org, registry, params }) {
  // The registry field holding the org's claim status: could_claim, have or use.
  const field = params.status_field || 'org_status';
  const ctx = { sys: new Map((systems?.systems ?? []).map((s) => [s.id, s])), registry, org, params, field };
  const rows = (params.allowances ?? []).map((spec) => specRow(spec, ctx));
  return rows.concat(unclaimedRows(registry, params, field));
}

const NOT_CLAIMED = { used: null, ceiling: null, known: false, note: 'not claimed' };

function specRow(spec, { sys, registry, org, params, field }) {
  const system = spec.system ? sys.get(spec.system) : null;
  const limit = spec.allowance ?? system?.limits?.[0] ?? null;
  const reg = registryRow(registry, spec.registry);
  const status = spec.status_override?.[field] ?? reg?.[field] ?? 'unknown';
  const why = spec.usage_why ?? system?.usage?.why;
  const noApi = noUsageApi(params, spec.id, spec.registry, spec.registry?.split('#')[1]);
  const claimed = CLAIMED.has(status);
  const u = claimed ? usage({ ...spec, usage_why: why }, org) : NOT_CLAIMED;
  const amt = amounts(spec, limit, u);
  return {
    ...identity(spec, system, reg),
    ...amt,
    claimed,
    status: rowStatus(claimed, u, amt),
    claim_needs: claimNeeds(spec, { claimed, u, noApi, why, reg }),
    unreadable: Boolean(noApi),
    ...provenance(limit, reg, u),
  };
}

function provenance(limit, reg, u) {
  return {
    source: [limit?.source, limit?.read ? `read ${limit.read}` : null].filter(Boolean).join(', '),
    usage_note: u.note,
    checked: limit?.read ?? reg?.checked ?? null,
  };
}

function identity(spec, system, reg) {
  return {
    id: spec.id,
    label: spec.name ?? system?.name ?? reg?.name ?? spec.id,
    lane: spec.lane ?? reg?.lane ?? system?.lane ?? null,
    pool: Boolean(spec.pool),
    resets: spec.resets ?? reg?.resets ?? null,
    could_take_over: spec.could_take_over ?? '',
  };
}

// What the allowance includes, what has been used, and what is left.
function amounts(spec, limit, u) {
  const allowance = finite(limit?.value) ? limit.value : null;
  const unused = allowance !== null && finite(u.ceiling) ? round(Math.max(allowance - u.ceiling, 0)) : null;
  return {
    allowance,
    unit: limit?.unit ?? spec.unit ?? '',
    per: spec.per ?? limit?.label ?? '',
    used: u.used,
    used_floor: Boolean(u.floor),
    unused,
    used_share: allowance && finite(u.used) ? round((u.used / allowance) * 100) : null,
  };
}

function rowStatus(claimed, u, { allowance, unused }) {
  if (!claimed) return 'unclaimed';
  if (u.used !== null && allowance !== null && u.used >= allowance) return 'over';
  if (unused === null) return 'not read';
  return unused > 0 ? 'idle' : 'used up';
}

function claimNeeds(spec, { claimed, u, noApi, why, reg }) {
  if (!claimed) return spec.claim_needs ?? claimSteps(reg, noApi);
  if (spec.read_needs !== undefined && spec.read_needs !== null) return spec.read_needs;
  if (u.known) return '';
  return u.floor ? u.note : noApi ?? why ?? '';
}

// Every other free, live, unclaimed registry row in a lane that matters.
function unclaimedRows(registry, params, field) {
  const listed = new Set((params.allowances ?? []).map((s) => s.registry).filter(Boolean));
  const lanes = new Set(params.claim_lanes ?? []);
  const alias = params.lane_alias ?? {};
  const rows = [];
  for (const [file, data] of Object.entries(registry)) {
    for (const r of data?.rows ?? []) {
      const lane = alias[r.id] ?? r.lane;
      if (!claimable(r, lane, { listed: listed.has(`${file}#${r.id}`), lanes, field })) continue;
      rows.push(registryRow2(r, file, lane, params));
    }
  }
  return rows;
}

// A free, live registry row the org could claim, in a lane that matters, that
// no allowance already lists.
function claimable(r, lane, { listed, lanes, field }) {
  return !listed && r.price_month === 0 && r.status === 'live' && !r.exclude && r[field] === 'could_claim' && lanes.has(lane);
}

function registryRow2(r, file, lane, params) {
  const noApi = noUsageApi(params, r.id, `${file}#${r.id}`);
  return {
    id: r.id,
    label: `${r.provider}: ${r.name}`,
    lane,
    allowance: null,
    unit: '',
    per: String(r.includes ?? '').split('. ')[0].slice(0, 140),
    used: null,
    used_floor: false,
    unused: null,
    used_share: null,
    pool: false,
    resets: r.resets ?? null,
    claimed: false,
    status: 'unclaimed',
    could_take_over: params.lane_work?.[lane] ?? '',
    claim_needs: claimSteps({ ...r, lane }, noApi),
    unreadable: Boolean(noApi),
    source: `${r.source}, read ${r.checked}`,
    usage_note: 'not claimed',
    checked: r.checked ?? null,
  };
}

// What claiming a registry row needs; each step is the account owner's. A row
// whose use no API reads (noApi, why) needs no key made to read it.
export function claimSteps(r, noApi = null) {
  if (!r) return 'sign up';
  const steps = ['sign up'];
  if (r.card) steps.push('add a card');
  if (r.lane === 'ci') steps.push('grant its GitHub app to the org');
  else if (noApi) steps.push(noApi);
  else if (['inference', 'gpu'].includes(r.lane)) steps.push('create an API key');
  return steps.join(', ');
}

// Why no API reads an allowance's use, from params.no_usage_api by its id, its
// registry row ('file#row') or the row's bare id, or null.
function noUsageApi(params, ...keys) {
  const map = params.no_usage_api ?? {};
  for (const k of keys) if (k && Object.hasOwn(map, k)) return map[k];
  return null;
}

// params.no_usage_api, checked: each value a reason, and each key an allowance
// id, a registry row ('file#row') or a row's bare id, with or without a
// registry. A key that names nothing would silently fall back to "create an
// API key".
export function checkNoUsageApi(params, registry = null) {
  const map = params.no_usage_api ?? {};
  const fail = (what) => {
    throw new ConfigError(`params.no_usage_api in targets/credits.json: ${what}`);
  };
  if (typeof map !== 'object' || Array.isArray(map)) fail('must be an object of id to reason');
  for (const [key, why] of Object.entries(map)) if (typeof why !== 'string' || !why.trim()) fail(`${key} must give a reason, a non-empty string`);
  const known = knownAllowanceKeys(params, registry);
  for (const key of Object.keys(map)) if (!known.has(key)) fail(`${key} names no allowance or registry row`);
}

// Every id, registry row ('file#row') and bare row id an allowance can be named by.
function knownAllowanceKeys(params, registry) {
  const known = new Set();
  for (const spec of params.allowances ?? []) for (const k of [spec.id, spec.registry, spec.registry?.split('#')[1]]) if (k) known.add(k);
  for (const [file, data] of Object.entries(registry ?? {})) for (const r of data?.rows ?? []) known.add(r.id).add(`${file}#${r.id}`);
  return known;
}

const execAsync = promisify(execFile);
const defaultExec = async (cmd, args) => (await execAsync(cmd, args, { maxBuffer: 16 * 1024 * 1024 })).stdout;
const PLAN_FRESH_MS = DAY;

// An allowance's reader, run in a local collect (in CI, a ci provider's alone,
// ciGather), gives its use this cycle as
// spec.used ({ value, source }); a reader that fails gives usage_why instead,
// so the row reads "not read" with why, never 0. Three readers:
//   { github_billing: 'org', product: 'Actions' }: gh api's org billing usage
//     summary for this month, the product's gross (list-rate) amount in USD,
//     which is what the included allowance is spent against
//   { plan_file: 'path', window: 'regex' }: the app's get_usage block a session
//     wrote (tokens.plan_used's file), that window's percent used; over a day
//     old it is not read. A relative path is from the repo root
//   { provider: 'modal' | 'huggingface' | 'groq' | 'openrouter' }: that
//     provider's own usage or limits call, its key from the environment
//     (providers.mjs cites each endpoint); `providers` passes it env, fetch
//     and exec in tests
export async function readUse(reader, { exec = defaultExec, root = '.', now = new Date(), providers = {} } = {}) {
  if (reader.github_billing) return readBilling(reader, exec);
  if (reader.provider) return readProvider(reader, providers);
  if (reader.plan_file) return readPlan(reader, root, now);
  return { why: `unknown reader ${JSON.stringify(reader)}` };
}

async function readBilling(reader, exec) {
  const api = `/organizations/${reader.github_billing}/settings/billing/usage/summary`;
  const product = reader.product ?? 'Actions';
  try {
    const doc = JSON.parse(await exec('gh', ['api', api]));
    const items = (doc.usageItems ?? []).filter((x) => x.product === product && finite(x.grossAmount));
    if (!items.length) return { why: `gh api ${api} lists no ${product} usage this month` };
    const period = doc.timePeriod ? `${doc.timePeriod.year}-${String(doc.timePeriod.month).padStart(2, '0')}` : 'this month';
    return { used: { value: round(items.reduce((a, x) => a + x.grossAmount, 0), 2), source: `gh api ${api}: ${product} grossAmount summed over ${items.length} SKUs, ${period}` } };
  } catch (err) {
    return { why: `gh api ${api} failed (${String(err?.stderr || err?.message || err).trim().split('\n')[0].slice(0, 160)})` };
  }
}

function readPlan(reader, root, now) {
  const file = reader.plan_file;
  try {
    const doc = readJson(path.resolve(root, file));
    const re = new RegExp(reader.window ?? 'weekly.*all models', 'i');
    const w = (doc.windows ?? []).find((x) => re.test(x.label ?? ''));
    const at = Date.parse(doc.read_at);
    if (!w || !finite(w.percentUsed)) return { why: `${file} has no window matching /${re.source}/` };
    if (!(at <= now.getTime() && now.getTime() - at <= PLAN_FRESH_MS)) return { why: `${file} was not read in the last day; a session refreshes it from get_usage` };
    return { used: { value: w.percentUsed, source: `${file}: ${w.label}, read ${doc.read_at}` } };
  } catch (err) {
    return { why: `${file}: ${err.code === 'ENOENT' ? 'absent; a session writes it from get_usage before a local run' : err.message}` };
  }
}

// Every Credits metric, read from the usage guard in local mode, with each
// home path and account name taken out of the text (redact.mjs).
export async function collect(opts = {}) {
  return redact(await gather(opts), opts.home);
}

async function gather({ mode, now = new Date(), home = os.homedir(), kit = KIT_ROOT, root = kit, exec = defaultExec, providers = {}, params = TEMPLATE } = {}) {
  const p = params;
  const named = sourceNames(p);
  // A repo's own pool metrics (params.pool_metrics) are answered too, read or not.
  const ids = [...new Set([...metricIds, ...Object.keys(p.pool_metrics ?? {})])];
  const every = (reason, source) => Object.fromEntries(ids.map((id) => [id, cnc(reason, source)]));
  if (mode !== 'local') return ciGather(p, { named, every, home, kit, root, now, exec, providers });
  if (!p.allowances?.length && !p.registry) return every('no allowance to read: list them in params.allowances on quality/targets/credits.json, or name a registry', named);
  let files;
  try {
    files = readSources(p, home, kit);
  } catch (err) {
    return every(`a source file is missing or unreadable (${String(err.message).split('\n')[0].slice(0, 160)})`, named);
  }
  try {
    checkNoUsageApi(p, files.registry);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    return every(err.message, 'quality/targets/credits.json');
  }
  const rows = allowances({ ...files, params: { ...p, allowances: await withReaders(p, { exec, root, now, providers }) } });
  return metricsFrom(rows, { p, src: usageSource(p, named, files.org), now });
}

// Readers run here; a spec that already gives used keeps it.
function withReaders(p, { exec, root, now, providers }) {
  return Promise.all((p.allowances ?? []).map(async (s) => {
    if (!s.reader || s.used) return s;
    const r = await readUse(s.reader, { exec, root, now, providers });
    return r.used ? { ...s, used: r.used } : { ...s, usage_why: r.why };
  }));
}

// A CI collect reads only the provider allowances ciReadable passes, whose keys
// are repo secrets in its env, and reports them in credits.highest_used_share
// alone. Every other metric keeps CI_REASON; none is partly read.
async function ciGather(p, { named, every, home, kit, root, now, exec, providers }) {
  const keyed = (p.allowances ?? []).filter((s) => s.reader && !s.used && ciReadable(s.reader, providers.env ?? process.env));
  if (!keyed.length) return every(CI_REASON, named);
  const src = `${named}; in CI only ${keyed.map((s) => s.id).join(', ')}, read with repo secrets; a --local collect reads every allowance`;
  let systems = {};
  try {
    if (p.systems_file) systems = readJson(resolveFrom(p.systems_file, home, kit));
  } catch (err) {
    return { ...every(CI_REASON, named), 'credits.highest_used_share': cnc(`a source file is missing or unreadable (${String(err.message).split('\n')[0].slice(0, 160)})`, src) };
  }
  const read = await withReaders({ allowances: keyed }, { exec, root, now, providers });
  const rows = allowances({ systems, org: {}, registry: {}, params: { ...p, allowances: read, claim_lanes: [] } });
  const top = metricsFrom(rows, { p, src, now })['credits.highest_used_share'];
  const why = rows.map((r) => `${r.label} (${r.claim_needs || r.usage_note})`).join('; ');
  return { ...every(CI_REASON, named), 'credits.highest_used_share': top.could_not_check ? cnc(`no allowance read in CI has a running total: ${why}`, src) : top };
}

function usageSource(p, named, org) {
  return p.usage_file ? named.replace(`${p.usage_file} (use)`, `${p.usage_file} (use, generated ${org.generated_at ?? 'at an unknown time'})`) : named;
}

// Where the figures come from, for a could_not_check's source.
function sourceNames(p) {
  const named = [p.systems_file && `${p.systems_file} (limits)`, p.usage_file && `${p.usage_file} (use)`, p.registry && `${p.registry} ${(p.registry_files ?? []).join(', ')} (${p.status_field || 'org_status'}, lane, resets)`].filter(Boolean).join('; ');
  return named || 'params.allowances';
}

// The systems, usage and registry files the params name; throws when one is unreadable.
function readSources(p, home, kit) {
  let systems = {};
  let org = {};
  const registry = {};
  if (p.systems_file) systems = readJson(resolveFrom(p.systems_file, home, kit));
  if (p.usage_file) org = readJson(resolveFrom(p.usage_file, home, kit));
  for (const f of p.registry_files ?? []) registry[f] = readJson(path.join(expand(p.registry, home), f));
  return { systems, org, registry };
}
