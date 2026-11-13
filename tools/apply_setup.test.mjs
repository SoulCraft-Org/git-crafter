// node --test tools/apply_setup.test.mjs
// Offline: a fake gh answers every call from an in-memory repo, applies each
// write to it and records every call, so a test sees what would be sent.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { collect, setupExpected } from "../quality/collectors/settings/repo-settings.mjs";
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

const merge = (a, b) => {
  for (const [k, v] of Object.entries(b)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
    a[k] = v && typeof v === "object" && !Array.isArray(v) && a[k] ? merge(a[k], v) : v;
  }
  return a;
};

// What each write does to the fake repo; a write with no entry here fails as GitHub would (HTTP 404).
const WRITES = {
  [`PATCH ${P()}`]: (s, body) => merge(s[P()], body),
  [`PUT ${P("/private-vulnerability-reporting")}`]: (s) => (s[P("/private-vulnerability-reporting")] = { enabled: true }),
  [`PUT ${P("/vulnerability-alerts")}`]: (s) => (s[P("/vulnerability-alerts")] = ""),
  [`PUT ${P("/automated-security-fixes")}`]: (s) => (s[P("/automated-security-fixes")] = { enabled: true, paused: false }),
  [`PUT ${P("/immutable-releases")}`]: (s) => (s[P("/immutable-releases")] = { enabled: true, enforced_by_owner: false }),
  [`PATCH ${P("/code-scanning/default-setup")}`]: (s, body) => (s[P("/code-scanning/default-setup")] = s.slowScan ? { state: "not-configured" } : body),
  [`PUT ${P("/actions/permissions/workflow")}`]: (s, body) => merge(s[P("/actions/permissions/workflow")], body),
  [`PUT ${P("/actions/permissions/fork-pr-contributor-approval")}`]: (s, body) => (s[P("/actions/permissions/fork-pr-contributor-approval")] = body),
  [`PUT ${P("/topics")}`]: (s, body) => (s[P()].topics = body.names),
  [`POST ${P("/rulesets")}`]: (s, body) => {
    const id = 100 + s[RULESETS].length;
    s[RULESETS].push({ id, target: body.target, enforcement: body.enforcement, source_type: "Repository" });
    s[P(`/rulesets/${id}`)] = ruleset(id, body);
  },
  "POST graphql": (s, body) => {
    if (body.variables.id !== s[P()].node_id) throw notFound(body.variables.id);
    if (body.query.includes("hasSponsorshipsEnabled: true")) s.sponsor = true;
    else s[P()].has_discussions = true;
  },
};

const notFound = (what) => Object.assign(new Error(`gh: Not Found (HTTP 404) ${what}`), { status: 404 });

// A gh stand-in over `state`; calls records every call, writes the -X ones.
function fakeGh(state) {
  const calls = [];
  const run = (args, input) => {
    calls.push({ args, body: input === undefined ? undefined : JSON.parse(input) });
    if (args[1] === "graphql") return JSON.stringify({ data: { repository: { usesCustomOpenGraphImage: Boolean(state.preview), hasSponsorshipsEnabled: Boolean(state.sponsor) } } });
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

// Runs the tool on `state` with `flags`; values, when given, go in a temp file.
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
    // Each row's status: its line's first 13 characters.
    const byId = Object.fromEntries(LIST.rows.map((r) => [r.id, lines.find((l) => l.includes(` ${r.id}`))?.slice(0, 13).trim()]));
    return { code, lines, byId, ...gh };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const count = (byId, status) => Object.values(byId).filter((s) => s === status).length;

test("setup.json: one row per switch, each with a short why, a way to set it or a reason, and a check", () => {
  assert.equal(new Set(LIST.rows.map((r) => r.id)).size, LIST.rows.length, "row ids are unique");
  for (const r of LIST.rows) {
    assert.ok(r.why.split(/\s+/).length <= 12, `${r.id}: why is 12 words or fewer`);
    assert.ok(!r.when || r.when === "no_org_ruleset", `${r.id}: when`);
    if (r.api === false) {
      assert.ok(r.reason && !r.method && !r.body, `${r.id}: an api: false row has a reason and no call`);
      continue;
    }
    assert.ok(["PATCH", "PUT", "POST"].includes(r.method) && r.check, `${r.id}: a method and a check`);
    assert.ok(r.path === "graphql" || r.path.startsWith("repos/{owner}/{repo}"), `${r.id}: path`);
    assert.deepEqual(r.path.match(/\{\w+\}/g)?.filter((k) => !["{owner}", "{repo}"].includes(k)) ?? [], [], `${r.id}: only {owner} and {repo} in a path`);
  }
  assert.deepEqual(LIST.rows.filter((r) => r.optional && r.api !== false).map((r) => r.id), ["rules.merge_queue", "repo.sponsor_button", "repo.template"]);
  const paid = LIST.paid_off.map((p) => p.id);
  assert.ok(LIST.paid_off.every((p) => p.reason && p.feature), "each paid feature says why it is off");
  assert.ok(!paid.some((id) => JSON.stringify(LIST.rows).includes(id)), "no row turns on a paid feature");
});

test("dry run: a repo at the standard reads same everywhere, writes nothing, and passes --check", () => {
  const got = tool(standard(), ["--check"]);
  assert.equal(got.code, 0, got.lines.join("\n"));
  const required = LIST.rows.filter((r) => !r.optional && r.check);
  assert.equal(count(got.byId, "same"), required.length);
  assert.equal(count(got.byId, "optional"), LIST.rows.filter((r) => r.optional).length);
  assert.equal(count(got.byId, "by hand"), LIST.rows.filter((r) => !r.optional && !r.check).length);
  assert.deepEqual(got.writes(), []);
  assert.match(got.lines.at(-1), /dry run: nothing changed/);
});

// The standard with four rows off.
function drifted() {
  const s = standard();
  s[P()].has_wiki = false;
  s[P()].has_discussions = false;
  s[P("/actions/permissions/fork-pr-contributor-approval")] = { approval_policy: "first_time_contributors" };
  delete s[P("/vulnerability-alerts")];
  return s;
}

test("dry run: drift reads would change, and nothing is written", () => {
  const got = tool(drifted());
  assert.equal(got.code, 0, "no --check: a dry run exits 0");
  for (const id of ["repo.wiki", "repo.discussions", "actions.fork_approval", "security.dependabot_alerts"]) assert.equal(got.byId[id], "would change", id);
  assert.match(got.lines.find((l) => l.includes("repo.wiki")), /has_wiki is false, want true/);
  assert.deepEqual(got.writes(), []);
});

test("apply: each changed row is set once, then read back as changed", () => {
  const state = drifted();
  const got = tool(state, ["--apply"]);
  assert.equal(got.code, 0, got.lines.join("\n"));
  assert.deepEqual(got.writes(), [
    { call: `PATCH ${P()}`, body: { has_wiki: true } },
    { call: "POST graphql", body: { ...ROW["repo.discussions"].body, variables: { id: "R_1" } } },
    { call: `PUT ${P("/vulnerability-alerts")}`, body: undefined },
    { call: `PUT ${P("/actions/permissions/fork-pr-contributor-approval")}`, body: { approval_policy: "all_external_contributors" } },
  ]);
  for (const id of ["repo.wiki", "repo.discussions", "security.dependabot_alerts", "actions.fork_approval"]) assert.equal(got.byId[id], "changed", id);
  assert.equal(tool(state, ["--check"]).code, 0, "the repo now passes --check");
});

test("apply: a write that does not read back fails, and the run exits 1", () => {
  const state = { ...standard(), slowScan: true, [P("/code-scanning/default-setup")]: { state: "not-configured" } };
  const got = tool(state, ["--apply"]);
  assert.equal(got.code, 1);
  assert.equal(got.byId["security.code_scanning"], "failed");
  assert.match(got.lines.find((l) => l.includes("security.code_scanning")), /read back would change: state is "not-configured"/);
});

test("check: a required row that differs fails it, named; --apply with --check passes once fixed", () => {
  const state = standard();
  state[P()].allow_auto_merge = true;
  const got = tool(state, ["--check"]);
  assert.equal(got.code, 1);
  assert.equal(got.lines.at(-1), "check failed: repo.no_auto_merge");
  const fixed = tool(state, ["--apply", "--check"]);
  assert.equal(fixed.code, 0);
  assert.deepEqual(fixed.writes(), [{ call: `PATCH ${P()}`, body: { allow_auto_merge: false } }]);
});

test("check: an unreadable field fails it; a token without admin never reads as off", () => {
  const state = standard();
  delete state[P()].allow_squash_merge;
  const got = tool(state, ["--check", "--apply"]);
  assert.equal(got.byId["repo.squash_merge"], "unreadable");
  assert.equal(got.code, 1);
  assert.deepEqual(got.writes(), [], "an unreadable row is never set");
});

test("optional rows: skipped unless optional_on names them; then they count like any other", () => {
  const off = tool(standard(), ["--check"]);
  assert.equal(off.byId["repo.sponsor_button"], "optional");
  assert.ok(!off.calls.some((c) => c.args[1] === "graphql"), "an optional row off is not even read");
  const on = { ...VALUES, optional_on: ["repo.sponsor_button", "repo.template", "rules.merge_queue"] };
  const state = standard();
  assert.equal(tool(state, ["--check"], on).code, 1);
  const applied = tool(state, ["--apply", "--check"], on);
  assert.equal(applied.code, 0, applied.lines.join("\n"));
  assert.deepEqual(applied.writes().map((w) => w.call), [`POST ${P("/rulesets")}`, "POST graphql", `PATCH ${P()}`]);
  assert.equal(applied.writes()[0].body.rules[0].type, "merge_queue");
  assert.match(applied.writes()[1].body.query, /hasSponsorshipsEnabled: true/);
  assert.deepEqual(applied.writes()[2].body, { is_template: true });
});

test("api: false rows: never written; a check-only one fails --check only when turned on and off", () => {
  const plain = tool(standard(), ["--apply", "--check"]);
  assert.deepEqual(plain.writes(), []);
  assert.match(plain.lines.find((l) => l.includes("manual.discussion_categories")), /^by hand .*No REST or GraphQL call/);
  const on = { ...VALUES, optional_on: ["manual.social_preview"] };
  const unset = tool(standard(), ["--apply", "--check"], on);
  assert.equal(unset.byId["manual.social_preview"], "by hand");
  assert.equal(unset.code, 1);
  assert.deepEqual(unset.writes(), []);
  assert.equal(tool({ ...standard(), preview: true }, ["--check"], on).byId["manual.social_preview"], "same");
});

test("values rows: no values file is no value; topics match in any order and apply as names", () => {
  const none = tool(standard(), ["--check"], null);
  assert.equal(none.code, 0);
  for (const id of ["values.topics", "values.homepage", "values.description"]) assert.equal(none.byId[id], "no value", id);
  const moved = tool(standard(), ["--apply"], { ...VALUES, topics: ["a", "c"] });
  assert.deepEqual(moved.writes(), [{ call: `PUT ${P("/topics")}`, body: { names: ["a", "c"] } }]);
});

test("rulesets: an org ruleset that meets the row is same; one that does not governs, and nothing is posted", () => {
  const org = standard();
  org[RULESETS] = org[RULESETS].map((s) => ({ ...s, source_type: "Organization" }));
  assert.equal(tool(org, ["--check"]).code, 0);
  org[P("/rulesets/1")].rules = [{ type: "deletion" }, { type: "non_fast_forward" }, { type: "pull_request", parameters: { allowed_merge_methods: ["merge", "squash"] } }];
  const governed = tool(org, ["--apply", "--check"]);
  assert.equal(governed.byId["rules.default_branch"], "org's rules");
  assert.equal(governed.code, 0);
  assert.deepEqual(governed.writes(), []);
  const bare = { ...standard(), [RULESETS]: [] };
  const posted = tool(bare, ["--apply", "--check"]);
  assert.equal(posted.code, 0, posted.lines.join("\n"));
  assert.deepEqual(posted.writes().map((w) => w.body.target), ["branch", "tag"]);
});

test("usage errors exit 2 and read nothing", () => {
  for (const argv of [["--repo", "nope"], ["--repo", REPO, "--force"], ["--repo", REPO, "--values", "missing.json"]]) {
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
  assert.equal(run(["api", "-X", "PUT", "x", "--input", "-"], "{\"a\":1}"), "{}");
  assert.deepEqual(seen[0], { cmd: "gh", args: ["api", "-X", "PUT", "x", "--input", "-"], input: "{\"a\":1}" });
  assert.throws(() => run(["api", "missing"]), (err) => err.status === 404);
});

test("general drift: expected_from_setup takes setup.json's General rows, with params.expected over them", async () => {
  assert.deepEqual(setupExpected(), {
    has_wiki: true, has_discussions: true, has_projects: true, allow_update_branch: true, web_commit_signoff_required: true,
    allow_squash_merge: true, allow_merge_commit: false, allow_rebase_merge: false, delete_branch_on_merge: true, allow_auto_merge: false,
  });
  const repo = { ...standard()[P()], has_wiki: false };
  const gh = { rest: async (route) => structuredClone(route === P() ? repo : null), restAll: async () => [] };
  const drift = (params) => collect({ mode: "local", params, gh, admin: null, repo: REPO, targets: [{ id: "settings.general_drift" }] }).then((got) => got["settings.general_drift"]);
  assert.equal((await drift({ expected_from_setup: true })).value, 1);
  assert.equal((await drift({ expected_from_setup: true, expected: { has_wiki: false } })).value, 0);
  assert.match((await drift({ expected_from_setup: "yes" })).could_not_check, /expected_from_setup .* true or false/);
});

test("Git Crafter's values file fills every values row and turns on only optional rows", () => {
  const own = JSON.parse(readFileSync(new URL("../config/setup-values.json", import.meta.url), "utf8"));
  for (const r of LIST.rows.filter((x) => x.id.startsWith("values."))) assert.ok(own[r.id.slice("values.".length)], r.id);
  assert.ok(own.optional_on.every((id) => ROW[id]?.optional));
});
