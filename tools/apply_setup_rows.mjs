// What one templates/setup.json row reads as on a repo: same, would change,
// set by hand, optional, org's rules, no value or unreadable. Used by
// tools/apply_setup.mjs; every read goes through a cached gh api GET.

import { reaches } from "../quality/collectors/settings/repo-settings-reads.mjs";

const RULESETS = "repos/{owner}/{repo}/rulesets?includes_parents=true&targets=branch,tag,push&per_page=100";

/** A value with each `{key}` filled from `vars`: a whole-string `{key}` takes the value as is. Throws { missing } for an unknown key. */
export function fill(value, vars) {
  if (typeof value === "string") {
    const whole = /^\{(\w+)\}$/.exec(value);
    if (whole) return lookup(vars, whole[1]);
    return value.replace(/\{(\w+)\}/g, (_, k) => String(lookup(vars, k)));
  }
  if (Array.isArray(value)) return value.map((v) => fill(v, vars));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, vars)]));
  return value;
}

function lookup(vars, key) {
  const v = typeof vars[key] === "function" ? vars[key]() : vars[key];
  if (v === undefined) throw Object.assign(new Error(`no value for {${key}}`), { missing: key });
  return v;
}

const sorted = (v) => (Array.isArray(v) && v.every((x) => typeof x !== "object") ? [...v].sort() : v);

// Whether `got` equals `want`; a list of scalars in any order.
function same(got, want) {
  return JSON.stringify(sorted(got)) === JSON.stringify(sorted(want));
}

/** Whether `params` holds every key of `want` with an equal value. */
const holds = (params, want) => Object.entries(want).every(([k, v]) => same(params?.[k], v));

const at = (obj, dotted) => dotted.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);

// The ruleset check: met, or the reason it is not; org is true when an organization ruleset of the target applies.
function rulesetCheck(read, want, vars) {
  const repo = read(fill("repos/{owner}/{repo}", vars));
  const ref = want.ref === "~DEFAULT_BRANCH" ? `refs/heads/${repo.default_branch}` : want.ref;
  const listed = (read(fill(RULESETS, vars)) ?? []).filter((s) => s.target === want.target && s.enforcement === "active");
  const sets = listed.map((s) => read(fill(`repos/{owner}/{repo}/rulesets/${s.id}`, vars))).filter((s) => reaches(s, ref, `refs/heads/${repo.default_branch}`));
  const rules = sets.flatMap((s) => s.rules ?? []);
  const lacking = Object.entries(want.rules).filter(([type, params]) => !rules.some((r) => r.type === type && holds(r.parameters ?? {}, params))).map(([type]) => type);
  return { met: !lacking.length, note: lacking.length ? `no active ${want.target} ruleset on ${ref} holds ${lacking.join(", ")}` : "", org: listed.some((s) => s.source_type === "Organization") };
}

// A field, exists or graphql check: met, or what it read.
function fieldCheck(read, check, path, vars, graphql) {
  const want = check.exists === undefined ? fill(check.value, vars) : check.exists;
  const answer = check.graphql ? graphql(check.graphql) : read(fill(check.get ?? path, vars));
  if (check.exists !== undefined) return { met: (answer !== null) === want, note: answer === null ? "off (HTTP 404)" : "on" };
  const got = answer === null ? undefined : at(answer, check.field);
  if (answer !== null && got === undefined) return { unreadable: `the answer has no ${check.field}: an admin token reads it` };
  return { met: same(got, want), note: `${check.field} is ${JSON.stringify(got ?? null)}, want ${JSON.stringify(want)}` };
}

// Whether a row's check holds on the repo: { met, note, org }, { missing } or { unreadable }.
function checkRow(row, { read, graphql, vars }) {
  try {
    if (row.check.ruleset) return rulesetCheck(read, row.check.ruleset, vars);
    return fieldCheck(read, row.check, row.path, vars, graphql);
  } catch (err) {
    if (err.missing) return { missing: err.missing };
    return { unreadable: err.message };
  }
}

/**
 * One row's state, as { status, note }. status: "same", "would change",
 * "by hand" (no API sets it), "optional" (off by default and not turned on),
 * "org's rules" (an organization ruleset governs it), "no value" (the values
 * file lacks a key) or "unreadable". `failed` is true for a row --check fails.
 */
export function rowState(row, ctx) {
  if (row.optional && !ctx.optionalOn.has(row.id)) return { status: "optional", note: "off by default; turn on with optional_on" };
  if (!row.check) return { status: "by hand", note: row.reason };
  const got = checkRow(row, ctx);
  if (got.missing) return { status: "no value", note: `the values file has no ${got.missing}` };
  if (got.unreadable) return { status: "unreadable", note: got.unreadable, failed: true };
  if (got.met) return { status: "same", note: "" };
  if (row.when === "no_org_ruleset" && got.org) return { status: "org's rules", note: `${got.note}; the organization's rulesets govern it` };
  if (row.api === false) return { status: "by hand", note: `${got.note}; ${row.reason}`, failed: true };
  return { status: "would change", note: got.note, failed: true };
}

/** A cached GET reader over `run`: null for an HTTP 404, {} for an empty 2xx answer. `forget` clears the cache after a write. */
export function reader(run) {
  const cache = new Map();
  const read = (path) => {
    if (!cache.has(path)) cache.set(path, get(run, path));
    return cache.get(path);
  };
  read.forget = () => cache.clear();
  return read;
}

function get(run, path) {
  try {
    const out = run(["api", path]);
    return out.trim() ? JSON.parse(out) : {};
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}
