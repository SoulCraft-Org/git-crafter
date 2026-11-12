// Shared pieces of the Claude collector (claude.mjs): its metric ids and
// params, pricing, which subagent rows count, and small arithmetic.

import fs from 'node:fs';
import { percentile } from '../github/github.mjs';

const TARGETS = JSON.parse(fs.readFileSync(new URL('../../targets/claude.json', import.meta.url), 'utf8'));
export const metricIds = TARGETS.map((t) => t.id);
// The template's own params, merged as the engine merges a file's: the
// defaults for a bare call, priceCall and classifyChecks.
export const TEMPLATE = Object.assign({}, ...TARGETS.map((t) => t.params ?? {}));

export const HOUR = 36e5;
export const TOKEN_KEYS = ['input', 'output', 'cacheWrite', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h'];
// A finite number, else 0.
export const num = (v) => (Number.isFinite(v) ? v : 0);
// The sum of a list of numbers.
export const sum = (xs) => xs.reduce((a, b) => a + b, 0);
// Rounds to digits decimals (one by default).
export const round = (v, digits = 1) => Number(v.toFixed(digits));
// part as a percent of whole, to one decimal.
export const pct = (part, whole) => round((100 * part) / whole);
// part per 10 of whole, to two decimals.
export const per10 = (part, whole) => round((10 * part) / whole, 2);

// Medians and p90s are github.mjs's percentile, the Pull requests tab's rule.
export const median = (xs) => percentile(xs, 0.5);

// A breakdown row. Every row names its own unit, because a breakdown often
// counts something other than the headline (PRs under an hours metric).
export const item = (label, value, unit) => ({ label, value, unit });

// An error's first line, from stderr or its message, cut to 160 characters.
export function firstLine(err) {
  return String(err?.stderr || err?.message || err).trim().split('\n')[0].slice(0, 160);
}

// One call's API-equivalent cost in dollars, or null for a model with no
// price. A prompt over params.long_context_tokens (input plus cache) takes the
// model's long tier when it has one. 5-minute and 1-hour cache writes take
// their own multiples of input; a write the usage does not split is priced as
// 5-minute, the API's default lifetime. A cache read takes the model's own
// cache_read_x when it has one, else params.cache_read_x (the pricing page
// named in params.source).
export function priceCall(m, params = TEMPLATE) {
  const base = params.prices?.[m.model];
  if (!base) return null;
  const prompt = m.input + m.cacheWrite + m.cacheRead;
  const p = base.long && prompt > params.long_context_tokens ? base.long : base;
  const write1h = m.cacheWrite1h ?? 0;
  const write5m = Math.max(m.cacheWrite - write1h, m.cacheWrite5m ?? 0);
  return (m.input * p.input + write5m * p.input * params.cache_write_5m_x + write1h * p.input * params.cache_write_1h_x + m.cacheRead * p.input * (base.cache_read_x ?? params.cache_read_x) + m.output * p.output) / 1e6;
}

// Before Claude Code 2.1.307, subagent transcripts held placeholder usage
// (github.com/anthropics/claude-code/releases/tag/v2.1.307). A subagent row
// counts from that version on, or, with no version, from its release day.
// Every collector that sums subagent usage asks this one function.
export const SUBAGENT_USAGE_FROM = { version: [2, 1, 307], date: Date.parse('2026-10-21T00:00:00Z') };
// Whether a Claude Code version is at least min; null when it cannot be parsed.
export function versionAtLeast(version, min = SUBAGENT_USAGE_FROM.version) {
  const v = String(version ?? '').split('.').map(Number);
  if (v.length < 3 || v.some((n) => !Number.isInteger(n))) return null;
  for (let i = 0; i < min.length; i++) if (v[i] !== min[i]) return v[i] > min[i];
  return true;
}
// Whether a call's usage counts: always for a main call, for a subagent from the version or date its usage was logged.
export function usageCounts({ sidechain, version, at }) {
  if (!sidechain) return true;
  const ok = versionAtLeast(version);
  return ok === null ? at >= SUBAGENT_USAGE_FROM.date : ok;
}

// The latest n of a list by a time, among those at or before now, oldest first.
export function lastN(list, n, at, now) {
  return list
    .filter((x) => Number.isFinite(at(x)) && at(x) <= now)
    .sort((a, b) => at(a) - at(b))
    .slice(-n);
}
