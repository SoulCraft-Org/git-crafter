// What one setup row reads as on a repo, an organization, a user or an
// enterprise: same, would change, set by hand, optional, org's rules, no value,
// unreadable, or for a paid row paid, refused or no budget. Used by
// tools/apply_setup.mjs; every read goes through a cached gh api GET.

import { reaches } from "../quality/collectors/settings/repo-settings-refs.mjs";

const RULESETS = "repos/{owner}/{repo}/rulesets?includes_parents=true&targets=branch,tag,push&per_page=100";
const ORG_RULESETS = "orgs/{org}/rulesets?targets=branch,tag,push&per_page=100";

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

// Whether `got` equals `want`: a list of scalars in any order, or a list of
// objects each held by some item of `got`, so a live check's extra keys
// (`integration_id`) and extra checks still match.
function same(got, want) {
  if (Array.isArray(want) && want.some((w) => w && typeof w === "object")) return Array.isArray(got) && want.every((w) => got.some((g) => holds(g, w)));
  return JSON.stringify(sorted(got)) === JSON.stringify(sorted(want));
}

/** Whether `params` holds every key of `want` with an equal value. */
function holds(params, want) {
  return Object.entries(want).every(([k, v]) => same(params?.[k], v));
}

const at = (obj, dotted) => dotted.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);

// Whether an organization ruleset reaches every repo: its repository_name condition includes ~ALL and excludes none.
function everyRepo(set) {
  const { include = [], exclude = [] } = set.conditions?.repository_name ?? {};
  return include.includes("~ALL") && !exclude.length;
}

// Where a ruleset row reads: the list, one ruleset by id, the ref and the default branch's ref, which sets count, and the words for where. An org's branch row names ~DEFAULT_BRANCH, since each repo has its own: a literal branch would read missing, and --apply would POST a duplicate.
function rulesetSource(read, want, vars, scope = "repo") {
  if (scope === "org" && want.target === "branch" && want.ref !== "~DEFAULT_BRANCH") throw new Error(`an organization's branch ruleset row names ~DEFAULT_BRANCH, not ${want.ref}`);
  if (scope === "org") return { list: fill(ORG_RULESETS, vars), one: (id) => fill(`orgs/{org}/rulesets/${id}`, vars), ref: want.ref, defaultRef: "~DEFAULT_BRANCH", counts: everyRepo, on: `every repo's ${want.ref}` };
  if (scope !== "repo") throw new Error(`a ruleset row reads a repo or an organization, not a ${scope}`);
  const defaultRef = `refs/heads/${read(fill("repos/{owner}/{repo}", vars)).default_branch}`;
  const ref = want.ref === "~DEFAULT_BRANCH" ? defaultRef : want.ref;
  return { list: fill(RULESETS, vars), one: (id) => fill(`repos/{owner}/{repo}/rulesets/${id}`, vars), ref, defaultRef, counts: () => true, on: ref };
}

// The ruleset check: met, or the reason it is not; org is true when an organization ruleset of the target applies to the repo.
function rulesetCheck(read, want, vars, scope) {
  const src = rulesetSource(read, want, vars, scope);
  const listed = (read(src.list) ?? []).filter((s) => s.target === want.target && s.enforcement === "active");
  const sets = listed.map((s) => read(src.one(s.id))).filter((s) => src.counts(s) && reaches(s, src.ref, src.defaultRef));
  const rules = sets.flatMap((s) => s.rules ?? []);
  const lacking = Object.entries(want.rules).filter(([type, params]) => !rules.some((r) => r.type === type && holds(r.parameters ?? {}, params))).map(([type]) => type);
  return { met: !lacking.length, note: lacking.length ? `no active ${want.target} ruleset on ${src.on} holds ${lacking.join(", ")}` : "", org: scope !== "org" && listed.some((s) => s.source_type === "Organization") };
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

// A check's answer, or { missing } for a key the values lack, or { unreadable }.
function guard(read) {
  try {
    return read();
  } catch (err) {
    return err.missing ? { missing: err.missing } : { unreadable: err.message };
  }
}

// Whether a row's check holds: { met, note, org }, { missing } or { unreadable }.
function checkRow(row, { read, graphql, vars, scope }) {
  return guard(() => (row.check.ruleset ? rulesetCheck(read, row.check.ruleset, vars, scope) : fieldCheck(read, row.check, row.path, vars, graphql)));
}

// A paid row's hard stop: met when an item of the list at field holds every key of where.
function budgetCheck(read, { get: route, field, where }, vars) {
  const answer = read(fill(route, vars));
  const items = answer === null ? [] : at(answer, field);
  if (!Array.isArray(items)) throw new Error(`the answer has no ${field} list: an admin token reads it`);
  return { met: items.some((b) => holds(b, fill(where, vars))), note: `no budget at ${fill(route, vars)} holds ${JSON.stringify(where)}` };
}

// The page where the owner sees or sets a row, as a note suffix.
function page(row, vars) {
  if (!row.ui_url) return "";
  const url = guard(() => fill(row.ui_url, vars));
  return ` (${typeof url === "string" ? url : row.ui_url})`;
}

// A paid row's state before its check (rules/compute.md, Money): refused when billed per use, paid until paid_yes names it, no budget until its hard stop holds; null once both hold.
function paidState(row, { read, vars, paidYes }) {
  if (row.paid.kind !== "flat") return { status: "refused", note: `billed per use, which rules/compute.md never turns on${page(row, vars)}` };
  if (!paidYes.has(row.id)) return { status: "paid", note: `${row.paid.price}; set only after the owner's yes, in paid_yes${page(row, vars)}` };
  const budget = guard(() => budgetCheck(read, row.paid.budget, vars));
  if (budget.met) return null;
  const why = budget.missing ? `the values file has no ${budget.missing}` : (budget.unreadable ?? budget.note);
  return { status: "no budget", note: `${why}; set the hard stop first${page(row, vars)}`, failed: true };
}

// The state a row takes before its check is read: optional, a paid row's, or by hand with no check; null when the check decides.
function gateState(row, ctx) {
  if (row.optional && !ctx.optionalOn.has(row.id)) return { status: "optional", note: "off by default; turn on with optional_on" };
  const paid = row.paid ? paidState(row, ctx) : null;
  if (paid) return paid;
  return row.check ? null : { status: "by hand", note: `${row.reason}${page(row, ctx.vars)}` };
}

/**
 * One row's state, as { status, note }. status: "same", "would change",
 * "by hand" (no API sets it), "optional" (off by default and not turned on),
 * "org's rules" (an organization ruleset governs it), "no value" (the values
 * file lacks a key), "unreadable", or for a paid row "paid" (no yes yet),
 * "refused" (billed per use) or "no budget" (no hard stop yet). `failed` is
 * true for a row --check fails.
 */
export function rowState(row, ctx) {
  const gate = gateState(row, ctx);
  if (gate) return gate;
  const got = checkRow(row, ctx);
  if (got.missing) return { status: "no value", note: `the values file has no ${got.missing}` };
  if (got.unreadable) return { status: "unreadable", note: got.unreadable, failed: true };
  if (got.met) return { status: "same", note: "" };
  if (row.when === "no_org_ruleset" && got.org) return { status: "org's rules", note: `${got.note}; the organization's rulesets govern it` };
  if (row.api === false) return { status: "by hand", note: `${got.note}; ${row.reason}${page(row, ctx.vars)}`, failed: true };
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
