// node --test quality/collectors/settings/repo-settings.test.mjs
// Offline: every gh answer comes from fixtures/settings/rest.json.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { GhError, NEEDS } from "../github/github-core.mjs";
import { loadTargets } from "../../score.mjs";
import { area, collect, METRIC_IDS } from "./repo-settings.mjs";
import { reaches, secretsRead } from "./repo-settings-reads.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "..", "..", "fixtures", "settings");
const REST = JSON.parse(readFileSync(path.join(FIXTURES, "rest.json"), "utf8"));
const REPO = "fixture-org/fixture-repo";
const R = (route) => `repos/${REPO}${route}`;
const AGE = "settings.admin_read_age_hours";
const EXPECTED = { allow_squash_merge: true, allow_merge_commit: false, allow_auto_merge: false };

// A gh client that answers from the fixture; `over` replaces or adds routes.
function fakeGh(over = {}) {
  const rest = { ...REST, ...over };
  const answer = async (route) => {
    const entry = rest[route];
    if (entry === undefined) throw new GhError(`no fixture for ${route}`, { status: 404 });
    if (entry?.__error) throw new GhError(entry.__error.message, entry.__error);
    return structuredClone(entry);
  };
  return { rest: answer, restAll: answer };
}

const run = (over = {}, opts = {}) => collect({ root: path.join(FIXTURES, "repo"), mode: "local", params: { expected: EXPECTED }, gh: fakeGh(over), repo: REPO, ...opts });
const values = (got) => Object.fromEntries(Object.entries(got).map(([id, e]) => [id, e.could_not_check ?? e.value]));
// The fixture's ruleset `id` with `change` laid over it.
const ruleset = (id, change) => ({ [R(`/rulesets/${id}`)]: { ...REST[R(`/rulesets/${id}`)], ...change } });
const rows = (entry) => Object.fromEntries(entry.detail.map((d) => [d.label, d.value]));

test("targets load, sit on the Settings tab and match the collector's ids", () => {
  const defs = loadTargets(path.join(HERE, "..", "..", "targets")).filter((d) => d.file === "repo-settings.json");
  assert.deepEqual(defs.map((d) => d.id), METRIC_IDS);
  for (const d of defs) {
    assert.equal(d.tab, "settings");
    assert.ok(d.id.startsWith(`${area}.`));
    assert.match(d.goal_source, /GitHub docs|template goal/);
  }
  assert.deepEqual([...new Set(defs.map((d) => d.kind))].sort(), ["consumption", "quality", "speed"]);
});

test("a repo at its ideal reads 0 everywhere but its one unread secret", async () => {
  const got = await run();
  assert.deepEqual(values(got), {
    "settings.protections_missing": 0,
    "settings.general_drift": 0,
    "settings.outside_access": 0,
    "settings.unused_secrets": 1,
    "settings.person_waits": 0,
    "settings.metered_on": 0,
    "settings.open_repo_missing": "a private repo takes no outside contributions, so no open-repo setting applies",
    "settings.admin_read_age_hours": "this run is the refresh; the next CI run reads its age",
  });
  assert.equal(Object.keys(rows(got["settings.protections_missing"])).length, 4);
  assert.deepEqual(rows(got["settings.unused_secrets"]), { "secrets stored": 2, "read by a workflow": 1 });
  for (const e of Object.values(got).filter((m) => !m.could_not_check)) assert.match(e.read_at, /^\d{4}-\d{2}-\d{2}T/);
});

test("detail rows hold counts and flags, never a secret's name or a login", async () => {
  const text = JSON.stringify(Object.values(await run()).map((e) => e.detail));
  assert.doesNotMatch(text, /DEPLOY_TOKEN|OLD_TOKEN/);
});

test("protections: each missing guard counts once", async () => {
  const id = "settings.protections_missing";
  const bypass = await run(ruleset(1, { bypass_actors: [{ actor_type: "OrganizationAdmin", bypass_mode: "always" }] }));
  assert.equal(bypass[id].value, 1);
  const tagOnlyDeletion = await run(ruleset(2, { rules: [{ type: "deletion" }] }));
  assert.equal(tagOnlyDeletion[id].value, 1);
  const tagElsewhere = await run(ruleset(2, { conditions: { ref_name: { include: ["refs/tags/release-*"], exclude: [] } } }));
  assert.equal(rows(tagElsewhere[id])["Tags cannot be deleted or moved"], 0);
  const pushShort = await run(ruleset(3, { rules: [{ type: "file_path_restriction", parameters: { restricted_file_paths: [".env"] } }] }));
  assert.equal(pushShort[id].value, 1);
  const openEnv = await run({ [R("/environments?per_page=100")]: { environments: [{ name: "production", protection_rules: [], deployment_branch_policy: null }] } });
  assert.equal(openEnv[id].value, 1);
});

test("protections: classic rules that admins skip count as a bypass", async () => {
  const classic = { enforce_admins: { enabled: false }, required_pull_request_reviews: { required_approving_review_count: 0 } };
  const got = await run({ [R("/branches/main/protection")]: classic });
  assert.equal(rows(got["settings.protections_missing"])["No one can bypass the default branch's rules"], 0);
});

test("protections: a guard with nothing to guard has no row", async () => {
  const id = "settings.protections_missing";
  const isPublic = await run({ [R("")]: { ...REST[R("")], private: false, visibility: "public" } });
  assert.equal(Object.keys(rows(isPublic[id])).length, 3);
  const bare = await run({ [R("/tags?per_page=1")]: [], [R("/environments?per_page=100")]: { environments: [] } });
  assert.deepEqual(Object.keys(rows(bare[id])), ["No one can bypass the default branch's rules", "A push rule blocks secret file names"]);
});

test("protections: a hidden bypass list is not measured, never read as none", async () => {
  const { bypass_actors: _, ...hidden } = REST[R("/rulesets/1")];
  const got = await run({ [R("/rulesets/1")]: hidden });
  assert.match(got["settings.protections_missing"].could_not_check, /bypass list is hidden/);
});

test("general drift: counts fields off the repo's standard; no standard is not measured", async () => {
  const id = "settings.general_drift";
  const drift = await run({ [R("")]: { ...REST[R("")], allow_auto_merge: true } });
  assert.equal(drift[id].value, 1);
  assert.equal(rows(drift[id])["allow_auto_merge is false"], 0);
  assert.match((await run({}, { params: {} }))[id].could_not_check, /params\.expected .* is empty/);
  const { allow_auto_merge: _, ...withheld } = REST[R("")];
  assert.match((await run({ [R("")]: withheld }))[id].could_not_check, /answered without allow_auto_merge/);
});

test("outside access: collaborators and open invitations add up", async () => {
  const got = await run({ [R("/collaborators?affiliation=outside&per_page=100")]: [{}, {}], [R("/invitations?per_page=100")]: [{}] });
  assert.equal(got["settings.outside_access"].value, 3);
});

test("unused secrets: environment secrets count; a workflow that hides its reads is not measured", async () => {
  const id = "settings.unused_secrets";
  const env = await run({ [R("/environments/production/secrets?per_page=100")]: { secrets: [{ name: "EDGE_KEY" }] } });
  assert.equal(env[id].value, 2);
  const none = await run({ [R("/actions/secrets?per_page=100")]: { secrets: [] } });
  assert.equal(none[id].value, 0);
  assert.equal(secretsRead(["A"], [{ text: "secrets: inherit" }]), null);
  assert.equal(secretsRead(["A"], [{ text: "x: ${{ secrets[matrix.name] }}" }]), null);
  assert.equal(secretsRead(["TOKEN", "TOKEN_2"], [{ text: "${{ secrets.token_2 }}" }]), 1, "case is ignored and a longer name is not a shorter one");
});

test("person waits: approvals, code owners, last push, named reviewers, environment reviewers and timers", async () => {
  const id = "settings.person_waits";
  const parameters = { required_approving_review_count: 1, require_code_owner_review: true, require_last_push_approval: true, required_reviewers: [{ minimum_approvals: 1 }] };
  const strict = await run(ruleset(1, { rules: [{ type: "pull_request", parameters }] }));
  assert.equal(strict[id].value, 4);
  const classic = { required_pull_request_reviews: { required_approving_review_count: 2, require_code_owner_reviews: true, require_last_push_approval: false } };
  assert.equal((await run({ [R("/branches/main/protection")]: classic }))[id].value, 2);
  const gated = { environments: [{ name: "production", deployment_branch_policy: {}, protection_rules: [{ type: "required_reviewers" }, { type: "wait_timer", wait_timer: 30 }, { type: "wait_timer", wait_timer: 0 }] }] };
  assert.equal((await run({ [R("/environments?per_page=100")]: gated }))[id].value, 2);
});

test("metered: a raised cache limit and a Copilot review rule count; no cache setting is no row", async () => {
  const id = "settings.metered_on";
  const raised = await run({ [R("/actions/cache/storage-limit")]: { max_cache_size_gb: 20 } });
  assert.equal(raised[id].value, 1);
  const copilot = await run(ruleset(1, { rules: [{ type: "copilot_code_review", parameters: { review_on_push: true } }] }));
  assert.equal(copilot[id].value, 1);
  const isPublic = await run({ [R("")]: { ...REST[R("")], private: false }, [R("/actions/cache/storage-limit")]: { max_cache_size_gb: 20 } });
  assert.match(isPublic[id].could_not_check, /public repo is not billed/);
  const noSetting = await run({ [R("/actions/cache/storage-limit")]: undefined });
  assert.deepEqual(Object.keys(rows(noSetting[id])), ["rulesets that ask for a Copilot review"]);
});

test("open repo: on a public repo each missing setting counts once; a private one is not measured", async () => {
  const id = "settings.open_repo_missing";
  const open = (repo, fork, vuln) => ({
    [R("")]: { ...REST[R("")], private: false, has_discussions: true, security_and_analysis: { secret_scanning_push_protection: { status: "enabled" } }, ...repo },
    [R("/actions/permissions/fork-pr-contributor-approval")]: { approval_policy: "all_external_contributors", ...fork },
    [R("/private-vulnerability-reporting")]: { enabled: true, ...vuln },
  });
  assert.equal((await run(open()))[id].value, 0);
  const weak = (await run(open({ has_discussions: false, security_and_analysis: { secret_scanning_push_protection: { status: "disabled" } } }, { approval_policy: "first_time_contributors" }, { enabled: false })))[id];
  assert.equal(weak.value, 4);
  assert.equal(Object.values(rows(weak)).filter((v) => v === 0).length, 4);
  const hidden = await run({ [R("")]: { ...REST[R("")], private: false } });
  assert.equal(hidden[id].could_not_check, `gh api repos answered without security_and_analysis: ${NEEDS["github-admin"]}`);
  const noSetting = { ...open() };
  delete noSetting[R("/actions/permissions/fork-pr-contributor-approval")];
  assert.equal((await run(noSetting))[id].value, 1, "an unread fork policy counts as missing, never as set");
});

test("reaches: the default branch, every ref, a pattern and an exclusion", () => {
  const set = (include, exclude = []) => ({ conditions: { ref_name: { include, exclude } } });
  assert.ok(reaches(set(["~DEFAULT_BRANCH"]), "refs/heads/main", "refs/heads/main"));
  assert.ok(!reaches(set(["~DEFAULT_BRANCH"]), "refs/heads/dev", "refs/heads/main"));
  assert.ok(reaches(set(["~ALL"]), "refs/tags/v1.0.0"));
  assert.ok(reaches(set(["refs/tags/v*"]), "refs/tags/v1.0.0"));
  assert.ok(!reaches(set(["refs/tags/v*"], ["refs/tags/v1.*"]), "refs/tags/v1.0.0"));
  assert.ok(!reaches({}, "refs/heads/main", "refs/heads/main"));
});

test("could not check: a CI run, an admin refusal, bad params and no repo each say why", async () => {
  const ci = await run({}, { mode: "ci", admin: null });
  for (const id of METRIC_IDS.filter((m) => m !== AGE)) assert.equal(ci[id].could_not_check, NEEDS["github-admin"]);
  const denied = await run({ [R("/collaborators?affiliation=outside&per_page=100")]: { __error: { message: "Must have admin rights to Repository.", status: 403 } } }, { targets: loadTargets(path.join(HERE, "..", "..", "targets")) });
  assert.equal(denied["settings.outside_access"].could_not_check, NEEDS["github-admin"]);
  const bad = await run({}, { params: { blocked_paths: "*.pem" } });
  for (const id of METRIC_IDS) assert.match(bad[id].could_not_check, /params\.blocked_paths/);
  const lost = await collect({ root: path.join(FIXTURES, "repo"), mode: "local", params: { expected: EXPECTED }, gh: fakeGh(), repo: "not a repo" });
  for (const id of METRIC_IDS.filter((m) => m !== AGE)) assert.match(lost[id].could_not_check, /no repo to read/);
});

test("admin token in CI: each admin metric reads as a local run does; a refused token says why, never 0", async () => {
  const local = values(await run());
  const calls = [];
  const spy = fakeGh();
  const workflow = { rest: async (r) => (calls.push(r), spy.rest(r)), restAll: async (r) => (calls.push(r), spy.restAll(r)) };
  const ci = await collect({ root: path.join(FIXTURES, "repo"), mode: "ci", params: { expected: EXPECTED }, gh: workflow, admin: fakeGh(), repo: REPO });
  const fromCi = values(ci);
  for (const id of METRIC_IDS.filter((m) => m !== AGE)) assert.equal(fromCi[id], local[id], id);
  assert.equal(calls.length, 0, "every Settings metric needs github-admin, so the workflow token reads none");
  const refused = { __error: { message: "Must have admin rights to Repository.", status: 403 } };
  const denied = await run({}, { mode: "ci", admin: fakeGh({ [R("/collaborators?affiliation=outside&per_page=100")]: refused }) });
  assert.equal(denied["settings.outside_access"].could_not_check, NEEDS["github-admin"]);
});

test("admin read age: a CI run reads the hours since the last signed-in run; that run itself does not", async () => {
  const data = mkdtempSync(path.join(tmpdir(), "settings-age-"));
  const now = Date.parse("2026-11-10T12:00:00Z");
  const ci = (opts = {}) => run({}, { mode: "ci", data, now, ...opts });
  assert.match((await ci())[AGE].could_not_check, /no signed-in run is recorded/);
  writeFileSync(path.join(data, "local.json"), JSON.stringify({ generated_at: "2026-11-09T06:00:00Z" }));
  assert.equal((await ci())[AGE].value, 30);
  assert.equal((await ci({ now: Date.parse("2026-11-08T00:00:00Z") }))[AGE].value, 0, "a clock behind the file never reads below 0");
  assert.match((await run({}, { data, now }))[AGE].could_not_check, /this run is the refresh/);
  writeFileSync(path.join(data, "local.json"), "{}");
  assert.match((await ci())[AGE].could_not_check, /no generated_at/);
  rmSync(data, { recursive: true, force: true });
});
