// node --test tools/apply_setup.test.mjs
// Offline: a fake gh answers every call from an in-memory repo and records each call.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ghRunner, main, SETUP } from "./apply_setup.mjs";

const LIST = JSON.parse(readFileSync(SETUP, "utf8"));
const ROW = Object.fromEntries(LIST.rows.map((r) => [r.id, r]));
const REPO = "acme/widget";
const P = (route = "") => `repos/${REPO}${route}`;
const RULESETS = P("/rulesets?includes_parents=true&targets=branch,tag,push&per_page=100");

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

// Runs the tool on `state` with `flags`; byId is each row's status, the first 13 characters of its line.
function tool(state, flags = []) {
  const gh = fakeGh(state);
  const lines = [];
  const code = main(["--repo", REPO, ...flags], { run: gh.run, log: (l) => lines.push(l) });
  const byId = Object.fromEntries(LIST.rows.map((r) => [r.id, lines.find((l) => l.includes(` ${r.id}`))?.slice(0, 13).trim()]));
  return { code, lines, byId, ...gh };
}

const count = (byId, status) => Object.values(byId).filter((s) => s === status).length;

test("a repo at the standard reads same everywhere, passes --check and is never written", () => {
  const got = tool(standard(), ["--check"]);
  assert.equal(got.code, 0, got.lines.join("\n"));
  assert.equal(count(got.byId, "same"), LIST.rows.filter((r) => !r.optional && r.check && !r.id.startsWith("values.")).length);
  assert.equal(count(got.byId, "no value"), 3, "the per-repo values rows have no value without a values file");
  assert.match(got.lines.at(-2), /^warning: 3 row\(s\) read no value .*values\.topics/);
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

test("usage errors exit 2 and read nothing", () => {
  for (const argv of [["--repo", "nope"], ["--repo", REPO, "--force"]]) {
    const gh = fakeGh(standard());
    const said = [];
    assert.equal(main(argv, { run: gh.run, log: () => {}, error: (l) => said.push(l) }), 2, argv.join(" "));
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
