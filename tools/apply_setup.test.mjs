// node --test tools/apply_setup.test.mjs
// Offline: a fake gh answers every call from an in-memory repo and records each call.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ghRunner, main, SETUP } from "./apply_setup.mjs";

const LIST = JSON.parse(readFileSync(SETUP, "utf8"));
const ROW = Object.fromEntries(LIST.rows.map((r) => [r.id, r]));
const REPO = "acme/widget";
const P = (route = "") => `repos/${REPO}${route}`;
const RULESETS = P("/rulesets?includes_parents=true&targets=branch,tag,push&per_page=100");
const VALUES = { topics: ["b", "a"], homepage: "https://example.org", description: "A widget" };

// A ruleset as GitHub answers it: the row's body with an id and a source.
const ruleset = (id, body, source = "Repository") => ({ id, source_type: source, ...structuredClone(body) });

// A repo that holds every required row of setup.json.
function standard() {
  const branch = ruleset(1, ROW["rules.default_branch"].body);
  const tag = ruleset(2, ROW["rules.release_tags"].body);
  return {
    [P()]: {
      node_id: "R_1", default_branch: "main", has_wiki: true, has_discussions: true, has_projects: true, allow_update_branch: true,
      web_commit_signoff_required: true, allow_squash_merge: true, allow_merge_commit: false, allow_rebase_merge: false,
      delete_branch_on_merge: true, allow_auto_merge: false, is_template: false, topics: ["a", "b"], homepage: "https://example.org", description: "A widget",
      security_and_analysis: { secret_scanning: { status: "enabled" }, secret_scanning_push_protection: { status: "enabled" } },
    },
    [P("/private-vulnerability-reporting")]: { enabled: true },
    [P("/vulnerability-alerts")]: "",
    [P("/automated-security-fixes")]: { enabled: true, paused: false },
    [P("/code-scanning/default-setup")]: { state: "configured" },
    [P("/actions/permissions/workflow")]: { default_workflow_permissions: "read", can_approve_pull_request_reviews: false },
    [P("/actions/permissions/fork-pr-contributor-approval")]: { approval_policy: "all_external_contributors" },
    [P("/immutable-releases")]: { enabled: true, enforced_by_owner: false },
    [RULESETS]: [branch, tag].map(({ id, target, enforcement, source_type }) => ({ id, target, enforcement, source_type })),
    [P("/rulesets/1")]: branch,
    [P("/rulesets/2")]: tag,
  };
}

const notFound = (what) => Object.assign(new Error(`gh: Not Found (HTTP 404) ${what}`), { status: 404 });

// What each write does to the fake repo; a write with no entry here fails as GitHub would (HTTP 404).
const WRITES = {
  [`PATCH ${P()}`]: (s, body) => Object.assign(s[P()], body),
  [`PUT ${P("/vulnerability-alerts")}`]: (s) => (s[P("/vulnerability-alerts")] = ""),
  [`PATCH ${P("/code-scanning/default-setup")}`]: (s, body) => (s[P("/code-scanning/default-setup")] = s.slowScan ? { state: "not-configured" } : body),
  [`PUT ${P("/topics")}`]: (s, body) => (s[P()].topics = body.names),
  "PATCH orgs/acme": (s, body) => Object.assign(s["orgs/acme"], body),
  "POST graphql": (s, body) => {
    if (body.variables.id !== s[P()].node_id) throw notFound(body.variables.id);
    s[P()].has_discussions = true;
  },
};

// A gh stand-in over `state`; calls records every call, and a -X call is a write.
function fakeGh(state) {
  const calls = [];
  const run = (args, input) => {
    calls.push({ args, body: input === undefined ? undefined : JSON.parse(input) });
    if (args[1] === "graphql") return JSON.stringify({ data: { repository: { usesCustomOpenGraphImage: false, hasSponsorshipsEnabled: false } } });
    if (args[1] !== "-X") {
      if (!(args[1] in state)) throw notFound(args[1]);
      return typeof state[args[1]] === "string" ? state[args[1]] : JSON.stringify(state[args[1]]);
    }
    const write = WRITES[`${args[2]} ${args[3]}`];
    if (!write) throw notFound(args[3]);
    write(state, calls.at(-1).body);
    return "";
  };
  return { run, calls, writes: () => calls.filter((c) => c.args[1] === "-X").map((c) => ({ call: `${c.args[2]} ${c.args[3]}`, body: c.body })) };
}

// Runs the tool on `state` with `flags`; values, when given, go in a temp file. byId is each row's status, the first 13 characters of its line.
function tool(state, flags = [], values = VALUES) {
  const gh = fakeGh(state);
  const lines = [];
  const dir = mkdtempSync(path.join(tmpdir(), "setup-"));
  try {
    const args = ["--repo", REPO, ...flags];
    if (values) {
      writeFileSync(path.join(dir, "v.json"), JSON.stringify(values));
      args.push("--values", "v.json");
    }
    const code = main(args, { run: gh.run, root: dir, log: (l) => lines.push(l) });
    const byId = Object.fromEntries(LIST.rows.map((r) => [r.id, lines.find((l) => l.includes(` ${r.id}`))?.slice(0, 13).trim()]));
    return { code, lines, byId, ...gh };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const count = (byId, status) => Object.values(byId).filter((s) => s === status).length;

test("a repo at the standard reads same everywhere, passes --check and is never written", () => {
  const got = tool(standard(), ["--check"]);
  assert.equal(got.code, 0, got.lines.join("\n"));
  assert.equal(count(got.byId, "same"), LIST.rows.filter((r) => !r.optional && r.check).length);
  assert.ok(!got.calls.some((c) => c.args[1] === "graphql"), "an optional row is not even read");
  assert.deepEqual(got.writes(), []);
  assert.equal(count(got.byId, "optional"), LIST.rows.filter((r) => r.optional).length);
  assert.equal(count(got.byId, "by hand"), LIST.rows.filter((r) => !r.optional && !r.check).length);
  assert.match(got.lines.at(-1), /dry run: nothing changed/);
});

test("drift reads would change with the value it read; only --check turns it into exit 1, naming each row", () => {
  const state = standard();
  state[P()].has_wiki = false;
  state[P()].allow_auto_merge = true;
  delete state[P("/vulnerability-alerts")];
  const plain = tool(state);
  assert.equal(plain.code, 0);
  assert.deepEqual(plain.writes(), []);
  for (const id of ["repo.wiki", "repo.no_auto_merge", "security.dependabot_alerts"]) assert.equal(plain.byId[id], "would change", id);
  assert.match(plain.lines.find((l) => l.includes("repo.wiki")), /has_wiki is false, want true/);
  const checked = tool(state, ["--check"]);
  assert.equal(checked.code, 1);
  assert.equal(checked.lines.at(-1), "check failed: repo.wiki, repo.no_auto_merge, security.dependabot_alerts");
});

test("apply: each changed row is set once, then read back as changed; --check then passes", () => {
  const state = standard();
  state[P()].has_wiki = false;
  state[P()].has_discussions = false;
  delete state[P("/vulnerability-alerts")];
  const got = tool(state, ["--apply"]);
  assert.equal(got.code, 0, got.lines.join("\n"));
  assert.deepEqual(got.writes(), [
    { call: `PATCH ${P()}`, body: { has_wiki: true } },
    { call: "POST graphql", body: { ...ROW["repo.discussions"].body, variables: { id: "R_1" } } },
    { call: `PUT ${P("/vulnerability-alerts")}`, body: undefined },
  ]);
  assert.equal(count(got.byId, "changed"), 3);
  assert.equal(tool(state, ["--check"]).code, 0, "the repo now passes --check");
});

test("apply: a write that does not read back fails, and the run exits 1", () => {
  const state = { ...standard(), slowScan: true, [P("/code-scanning/default-setup")]: { state: "not-configured" } };
  const got = tool(state, ["--apply"]);
  assert.equal(got.code, 1);
  assert.match(got.lines.find((l) => l.includes("security.code_scanning")), /^failed .*read back would change: state is "not-configured"/);
});

test("apply: after a failed write no row is written; the rest read skipped and the run exits 1", () => {
  const state = standard();
  state[P("/private-vulnerability-reporting")] = { enabled: false };
  delete state[P("/vulnerability-alerts")];
  const got = tool(state, ["--apply", "--check"]);
  assert.equal(got.byId["security.private_reporting"], "failed", "no write is defined for it: HTTP 404");
  assert.equal(got.byId["security.dependabot_alerts"], "skipped");
  assert.equal(got.writes().length, 1, "only the failed write was sent");
  assert.equal(got.code, 1);
});

test("setup.json never turns on a merge switch the repo forbids", () => {
  for (const r of LIST.rows) for (const k of ["allow_auto_merge", "allow_merge_commit", "allow_rebase_merge"]) assert.notEqual(r.body?.[k], true, `${r.id} sets ${k}`);
});

test("values: no values file reads no value with a warning, and never fails; optional_on turns a row on; topics apply as names", () => {
  const none = tool(standard(), ["--check"], null);
  assert.equal(none.code, 0);
  assert.equal(count(none.byId, "no value"), 3);
  assert.match(none.lines.at(-2), /^warning: 3 row\(s\) read no value .*values\.topics/);
  const on = tool(standard(), ["--apply", "--check"], { ...VALUES, optional_on: ["repo.template"] });
  assert.equal(on.code, 0, on.lines.join("\n"));
  assert.deepEqual(on.writes(), [{ call: `PATCH ${P()}`, body: { is_template: true } }]);
  assert.deepEqual(tool(standard(), ["--apply"], { ...VALUES, topics: ["a", "c"] }).writes(), [{ call: `PUT ${P("/topics")}`, body: { names: ["a", "c"] } }]);
});

test("optional_on naming no row exits 2, so a typo never leaves a row off and --check passing", () => {
  const got = tool(standard(), ["--check"], { ...VALUES, optional_on: ["repo.templte"] });
  assert.equal(got.code, 2);
  assert.deepEqual(got.calls, []);
});

test("--only without --apply says it sets nothing", () => {
  const got = tool(standard(), ["--only", "repo.wiki"]);
  assert.match(got.lines[0], /^note: --only names rows for --apply/);
});

test("--only: --apply sets just the rows named; the others stay would change", () => {
  const state = standard();
  state[P()].has_wiki = false;
  state[P()].allow_auto_merge = true;
  const got = tool(state, ["--apply", "--only", "repo.wiki,repo.projects"]);
  assert.deepEqual(got.writes(), [{ call: `PATCH ${P()}`, body: { has_wiki: true } }]);
  assert.deepEqual([got.byId["repo.wiki"], got.byId["repo.no_auto_merge"]], ["changed", "would change"]);
});

test("Git Crafter's values file fills every values row and turns on only optional rows", () => {
  const own = JSON.parse(readFileSync(new URL("../config/setup-values.json", import.meta.url), "utf8"));
  for (const r of LIST.rows.filter((x) => x.id.startsWith("values."))) assert.ok(own[r.id.slice("values.".length)], r.id);
  assert.ok(own.optional_on.every((id) => ROW[id]?.optional));
});

// Org rows: a field, the org's own node_id, and a default-branch ruleset.
const ORG_ROWS = [
  { id: "org.no_public_repos", method: "PATCH", path: "orgs/{org}", body: { members_can_create_public_repositories: false }, check: { field: "members_can_create_public_repositories", value: false } },
  { id: "org.node_id", method: "PATCH", path: "orgs/{org}", body: {}, check: { field: "node_id", value: "{node_id}" } },
  { id: "org.rules", method: "POST", path: "orgs/{org}/rulesets", body: {}, check: { ruleset: { target: "branch", ref: "~DEFAULT_BRANCH", rules: { deletion: {} } } } },
];
const ORG = {
  "orgs/acme": { node_id: "O_1", members_can_create_public_repositories: true },
  "orgs/acme/rulesets?targets=branch,tag,push&per_page=100": [{ id: 7, target: "branch", enforcement: "active", source_type: "Organization" }],
  "orgs/acme/rulesets/7": { id: 7, target: "branch", conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] }, repository_name: { include: ["~ALL"], exclude: [] } }, rules: [{ type: "deletion" }] },
};

// Runs the tool with `argv` over a temp folder holding `files` ({ name: rows }), or over a missing folder when `files` is null.
function scoped(argv, state, files) {
  const gh = fakeGh(state);
  const lines = [];
  const dir = mkdtempSync(path.join(tmpdir(), "setup-"));
  try {
    for (const [name, rows] of Object.entries(files ?? {})) writeFileSync(path.join(dir, name), JSON.stringify({ rows }));
    const code = main(argv, { run: gh.run, setup: files ? dir : path.join(dir, "none"), root: dir, log: (l) => lines.push(l) });
    return { code, lines, rows: lines.map((l) => /^(.{13}) (\S+)/.exec(l)?.slice(1).map((x) => x.trim())).filter(Boolean), ...gh };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("--org reads each file of its folder in name order, fills {org} and {node_id}, checks the org's ruleset and sets an org row", () => {
  const got = scoped(["--org", "acme", "--apply", "--check"], structuredClone(ORG), { "b.json": ORG_ROWS.slice(2), "a.json": ORG_ROWS.slice(0, 2) });
  assert.equal(got.code, 0, got.lines.join("\n"));
  assert.deepEqual(got.rows, [["changed", "org.no_public_repos"], ["same", "org.node_id"], ["same", "org.rules"]]);
  assert.deepEqual(got.writes(), [{ call: "PATCH orgs/acme", body: { members_can_create_public_repositories: false } }]);
  assert.ok(!got.calls.some((c) => c.args[1].startsWith("repos/")), "no repo is read");
  assert.equal(got.lines.at(-1), "org acme: 1 changed, 2 same");
});

test("--user and --enterprise fill their placeholders; a missing folder holds no rows", () => {
  const user = { id: "user.node_id", method: "PATCH", path: "user", body: {}, check: { get: "users/{user}", field: "node_id", value: "{node_id}" } };
  assert.deepEqual(scoped(["--user", "ada"], { "users/ada": { node_id: "U_1" } }, { "a.json": [user] }).rows, [["same", "user.node_id"]]);
  const ent = { id: "ent.actions", method: "PUT", path: "enterprises/{enterprise}/actions/permissions", body: { enabled_organizations: "all" }, check: { field: "enabled_organizations", value: "all" } };
  assert.deepEqual(scoped(["--enterprise", "bigco"], { "enterprises/bigco/actions/permissions": { enabled_organizations: "all" } }, { "a.json": [ent] }).rows, [["same", "ent.actions"]]);
  const none = scoped(["--org", "acme", "--check"], {}, null);
  assert.deepEqual([none.code, none.lines, none.calls], [0, ["org acme: no rows (dry run: nothing changed)"], []]);
});

test("usage errors exit 2 and read nothing", () => {
  for (const argv of [[], ["--repo", REPO, "--org", "acme"], ["--org", "ac/me"], ["--enterprise", "../x"], ["--repo", "nope"], ["--repo", REPO, "--force"], ["--repo", REPO, "--values", "missing.json"], ["--repo", REPO, "--only", "repo.nope"]]) {
    const gh = fakeGh(standard());
    const said = [];
    assert.equal(main(argv, { run: gh.run, root: tmpdir(), log: () => {}, error: (l) => said.push(l) }), 2, argv.join(" "));
    assert.match(said.join("\n"), /usage: node tools\/apply_setup\.mjs/);
    assert.deepEqual(gh.calls, []);
  }
});

test("ghRunner: gh's stdout, its stdin, and the HTTP status of a failure", () => {
  const seen = [];
  const exec = (cmd, args, opts) => (seen.push({ cmd, args, input: opts.input }), args[1] === "missing" ? { status: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" } : { status: 0, stdout: "{}" });
  const run = ghRunner(exec);
  assert.equal(run(["api", "x"], "{\"a\":1}"), "{}");
  assert.deepEqual(seen[0], { cmd: "gh", args: ["api", "x"], input: "{\"a\":1}" });
  assert.throws(() => run(["api", "missing"]), (err) => err.status === 404);
});
