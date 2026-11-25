// node --test tools/apply_setup_rows.test.mjs
// Offline: a fake gh answers each GET from a map and counts the reads.

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fill, reader, rowState } from "./apply_setup_rows.mjs";

const ROW = Object.fromEntries(JSON.parse(readFileSync(new URL("../templates/setup.json", import.meta.url), "utf8")).rows.map((r) => [r.id, r]));
const REPO = "repos/acme/widget";
const VARS = { owner: "acme", repo: "widget", node_id: () => "R_1", topics: ["b", "a"] };
const RULESETS = `${REPO}/rulesets?includes_parents=true&targets=branch,tag,push&per_page=100`;
const notFound = () => Object.assign(new Error("gh: Not Found (HTTP 404)"), { status: 404 });

// A context over `answers`: route to JSON, or "" for an empty 2xx; any other route is a 404.
function ctx(answers, optionalOn = []) {
  const gets = [];
  const run = ([, route]) => {
    gets.push(route);
    if (!(route in answers)) throw notFound();
    return typeof answers[route] === "string" ? answers[route] : JSON.stringify(answers[route]);
  };
  return { gets, read: reader(run), graphql: () => ({ data: {} }), vars: VARS, optionalOn: new Set(optionalOn) };
}
const state = (id, answers, optionalOn) => rowState(ROW[id], ctx(answers, optionalOn));

test("fill: a whole-string key takes the value as is, a key inside text is spelled, a missing key says which", () => {
  assert.deepEqual(fill({ names: "{topics}", p: "repos/{owner}/{repo}", id: "{node_id}", n: 2 }, VARS), { names: ["b", "a"], p: "repos/acme/widget", id: "R_1", n: 2 });
  assert.throws(() => fill("{homepage}", VARS), (err) => err.missing === "homepage");
});

test("a field row: same when it holds, would change with what it read when not, unreadable when the answer lacks it", () => {
  assert.equal(state("repo.wiki", { [REPO]: { has_wiki: true } }).status, "same");
  const off = state("repo.wiki", { [REPO]: { has_wiki: false } });
  assert.deepEqual([off.status, off.note, off.failed], ["would change", "has_wiki is false, want true", true]);
  assert.equal(state("repo.wiki", { [REPO]: {} }).status, "unreadable");
});

test("an exists row reads a 404 as off; a list of names matches in any order; a missing value is named", () => {
  assert.equal(state("security.dependabot_alerts", { [`${REPO}/vulnerability-alerts`]: "" }).status, "same");
  assert.equal(state("security.dependabot_alerts", {}).status, "would change");
  assert.equal(state("values.topics", { [REPO]: { topics: ["a", "b"] } }).status, "same");
  assert.equal(rowState(ROW["values.homepage"], { ...ctx({ [REPO]: {} }), vars: {} }).status, "no value");
});

test("an optional row is not read unless turned on; a row with no check is set by hand", () => {
  const off = ctx({});
  assert.equal(rowState(ROW["repo.template"], off).status, "optional");
  assert.deepEqual(off.gets, []);
  assert.equal(state("repo.template", { [REPO]: { is_template: false } }, ["repo.template"]).status, "would change");
  assert.equal(state("manual.push_limit", {}).status, "by hand");
});

// An active default-branch ruleset the way GitHub lists it, holding `rules`.
const branchSet = (rules, source_type = "Repository") => ({
  [REPO]: { default_branch: "main" },
  [RULESETS]: [{ id: 1, target: "branch", enforcement: "active", source_type }],
  [`${REPO}/rulesets/1`]: { id: 1, target: "branch", source_type, conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } }, rules },
});

test("a ruleset row: met when an active ruleset holds each rule, else it names what is lacking; an org's ruleset governs", () => {
  const held = ROW["rules.default_branch"].body.rules;
  assert.equal(state("rules.default_branch", branchSet(held)).status, "same");
  const loose = branchSet([...held.slice(0, 2), { type: "pull_request", parameters: { allowed_merge_methods: ["merge", "squash"], required_review_thread_resolution: true } }]);
  assert.match(state("rules.default_branch", loose).note, /holds pull_request/);
  assert.equal(state("rules.default_branch", branchSet(held.slice(0, 2), "Organization")).status, "org's rules");
});

test("a required checks rule: met when each wanted context is required, whatever app or extra checks the live rule names", () => {
  const [del, nff, pr] = ROW["rules.default_branch"].body.rules;
  const checks = (list) => branchSet([del, nff, pr, { type: "required_status_checks", parameters: { strict_required_status_checks_policy: false, required_status_checks: list } }]);
  const live = [{ context: "ci / ci-ok", integration_id: 15368 }, { context: "review" }, { context: "DCO" }];
  assert.equal(state("rules.default_branch", checks(live)).status, "same");
  assert.match(state("rules.default_branch", checks(live.slice(0, 1))).note, /holds required_status_checks/);
});

// An active org `target` ruleset on `refs` (the default branch unless named) of the repos `repos` names, holding `rules`.
const orgSet = (rules, repos = ["~ALL"], target = "branch", refs = ["~DEFAULT_BRANCH"]) => ({
  "orgs/acme/rulesets?targets=branch,tag,push&per_page=100": [{ id: 9, target, enforcement: "active", source_type: "Organization" }],
  "orgs/acme/rulesets/9": { id: 9, target, conditions: { ref_name: { include: refs, exclude: [] }, repository_name: { include: repos, exclude: [] } }, rules },
});
const scoped = (answers, scope = "org", row = ROW["rules.default_branch"], yes = []) => {
  const c = { ...ctx(answers), vars: { org: "acme" }, scope, paidYes: new Set(yes) };
  return { ...rowState(row, c), gets: c.gets };
};

test("under --org a ruleset row reads the org's rulesets, and one counts only when it reaches every repo", () => {
  const held = ROW["rules.default_branch"].body.rules;
  const all = scoped(orgSet(held));
  assert.equal(all.status, "same");
  assert.ok(all.gets.every((g) => g.startsWith("orgs/acme/")), "no repo is read");
  const some = scoped(orgSet(held, ["widget"]));
  assert.deepEqual([some.status, some.note], ["would change", "no active branch ruleset on every repo's ~DEFAULT_BRANCH holds deletion, non_fast_forward, pull_request, required_status_checks"]);
  assert.match(scoped({}, "user").note, /reads a repo or an organization, not a user/);
  const literal = scoped(orgSet(held), "org", { ...ROW["rules.default_branch"], check: { ruleset: { ...ROW["rules.default_branch"].check.ruleset, ref: "refs/heads/main" } } });
  assert.deepEqual([literal.status, literal.failed, literal.gets], ["unreadable", true, []], "never read, so --apply never POSTs a duplicate");
  assert.equal(scoped(orgSet(ROW["rules.release_tags"].body.rules, ["~ALL"], "tag", ["refs/tags/v*"]), "org", ROW["rules.release_tags"]).status, "same", "a tag row keeps its literal ref");
});

// Synthetic paid rows, since no setup file holds one yet: a flat one whose budget has a hard stop, and one billed per use.
const BUDGETS = "organizations/acme/settings/billing/budgets";
const FLAT = { id: "money.flat", why: "w", method: "PATCH", path: "orgs/{org}", body: { on: true }, check: { field: "on", value: true }, ui_url: "https://github.com/organizations/{org}/settings/billing", paid: { kind: "flat", price: "a flat monthly fee", budget: { get: "organizations/{org}/settings/billing/budgets", field: "budgets", where: { budget_product_sku: "x", prevent_further_usage: true } } } };
const PER_USE = { ...FLAT, id: "money.metered", paid: { kind: "per_use", price: "metered" } };
const paid = (row, answers, yes = []) => scoped(answers, "org", row, yes);

test("a paid row: refused when billed per use, paid until paid_yes names it, no budget until a hard stop holds, and read only then", () => {
  const refused = paid(PER_USE, {}, [PER_USE.id]);
  assert.deepEqual([refused.status, refused.failed, refused.gets], ["refused", undefined, []]);
  assert.match(refused.note, / \(https:\/\/github\.com\/organizations\/acme\/settings\/billing\)$/);
  const asked = paid(FLAT, {});
  assert.deepEqual([asked.status, asked.failed, asked.gets], ["paid", undefined, []]);
  const soft = paid(FLAT, { [BUDGETS]: { budgets: [{ budget_product_sku: "x", prevent_further_usage: false }] } }, [FLAT.id]);
  assert.deepEqual([soft.status, soft.failed, soft.gets], ["no budget", true, [BUDGETS]]);
  const hard = { [BUDGETS]: { budgets: [{ budget_product_sku: "x", prevent_further_usage: true, budget_amount: 0 }] }, "orgs/acme": { on: false } };
  assert.equal(paid(FLAT, hard, [FLAT.id]).status, "would change");
  assert.equal(paid(FLAT, { [BUDGETS]: {} }, [FLAT.id]).note, "the answer has no budgets list: an admin token reads it; set the hard stop first (https://github.com/organizations/acme/settings/billing)");
});

test("a row set by hand names its page, filled where the values allow", () => {
  const row = { id: "manual.x", why: "w", api: false, reason: "no API sets it", ui_url: "https://github.com/{owner}/{repo}/settings" };
  assert.equal(rowState(row, ctx({})).note, "no API sets it (https://github.com/acme/widget/settings)");
  assert.equal(scoped({}, "org", row).note, "no API sets it (https://github.com/{owner}/{repo}/settings)");
});

const KEYS = new Set(["id", "why", "source", "method", "path", "body", "check", "optional", "api", "reason", "when", "paid", "ui_url"]);
const METHODS = new Set(["PATCH", "POST", "PUT", "DELETE"]);

// What is wrong with a row's shape, as words; none for a sound row.
function shapeProblems(row) {
  const kinds = ["ruleset", "exists", "value"].filter((k) => k in (row.check ?? {}));
  const budget = row.paid?.budget;
  return [
    [Object.keys(row).some((k) => !KEYS.has(k)), `a key outside ${[...KEYS].join(", ")}`],
    [typeof row.id !== "string" || typeof row.why !== "string", "an id and a why"],
    [!(METHODS.has(row.method) && typeof row.path === "string") && !(row.api === false && typeof row.reason === "string"), "a method and a path, or api false and a reason"],
    [row.check && (kinds.length !== 1 || ("value" in row.check && !row.check.field)), "a check of one ruleset, exists or value, and a value names its field"],
    [!row.check && row.api !== false, "no check, so api false"],
    [row.ui_url !== undefined && !String(row.ui_url).startsWith("https://github.com/"), "ui_url on https://github.com/"],
    [row.paid && (!["flat", "per_use"].includes(row.paid.kind) || typeof row.paid.price !== "string" || !row.ui_url), "a paid row's kind, price and ui_url"],
    [row.paid?.kind === "flat" && !(budget?.get && budget.field && budget.where?.prevent_further_usage === true), "a flat row's budget: get, field and a where with prevent_further_usage true"],
  ].filter(([bad]) => bad).map(([, words]) => `${row.id}: ${words}`);
}

// Every setup row with its scope: templates/setup.json's for a repo, and each *.json file's under templates/setup/<scope>/.
function setupRows() {
  const dir = new URL("../templates/setup/", import.meta.url);
  const rows = (url) => JSON.parse(readFileSync(url, "utf8")).rows;
  const files = existsSync(dir) ? readdirSync(dir, { recursive: true }).filter((f) => f.endsWith(".json")).sort() : [];
  return [...Object.values(ROW).map((row) => ({ scope: "repo", row })), ...files.flatMap((f) => rows(new URL(f, dir)).map((row) => ({ scope: f.split(/[\\/]/)[0], row })))];
}

test("every row in templates/setup.json and templates/setup/** has a sound shape and an id its scope holds once", () => {
  const all = setupRows();
  const ids = all.map(({ scope, row }) => `${scope} ${row.id}`);
  assert.deepEqual([...all.flatMap(({ row }) => shapeProblems(row)), ...ids.filter((id, i) => ids.indexOf(id) !== i).map((id) => `${id}: twice`)], []);
  assert.ok(all.length >= 36, `${all.length} rows`);
  assert.deepEqual([shapeProblems(FLAT), shapeProblems(PER_USE)], [[], []]);
  const loose = { ...FLAT, paid: { ...FLAT.paid, budget: { ...FLAT.paid.budget, where: { budget_product_sku: "x" } } } };
  assert.deepEqual([shapeProblems(loose).length, shapeProblems({ ...ROW["repo.wiki"], extra: 1 }).length, shapeProblems({ ...PER_USE, ui_url: undefined }).length], [1, 1, 1]);
});

test("reader: one GET per route, null for a 404, and forget makes the next read ask again", () => {
  const c = ctx({ [REPO]: { id: 1 } });
  assert.deepEqual([c.read(REPO), c.read(REPO), c.read(`${REPO}/gone`)], [{ id: 1 }, { id: 1 }, null]);
  assert.equal(c.gets.length, 2);
  c.read.forget();
  c.read(REPO);
  assert.equal(c.gets.length, 3);
});
