// node --test tools/apply_setup_rows.test.mjs
// Offline: a fake gh answers each GET from a map and counts the reads.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("reader: one GET per route, null for a 404, and forget makes the next read ask again", () => {
  const c = ctx({ [REPO]: { id: 1 } });
  assert.deepEqual([c.read(REPO), c.read(REPO), c.read(`${REPO}/gone`)], [{ id: 1 }, { id: 1 }, null]);
  assert.equal(c.gets.length, 2);
  c.read.forget();
  c.read(REPO);
  assert.equal(c.gets.length, 3);
});
