// More tests for the GitHub collector, split out of github.test.mjs to keep each file under the Read limit:
// the Security and quality metrics. Shared fixtures live in github-test-lib.mjs.
// Run with `node --test quality/collectors/github/github-security.test.mjs`.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { collect, denyCovers, lockPackages, pulledBy, registryOf, runsPullRequestCode } from "./github.mjs";
import { adminGh, clientFor } from "./github-core.mjs";
import { HERE, FIXTURES, TARGETS, TEMPLATE_PARAMS, REST, GRAPHQL, PARAMS, NOW, REPO, HOUR_MS, fakeGh, fakeFetch, run } from "./github-test-lib.mjs";
import { EXPECTED } from "./github-expected.mjs";
describe("Security and quality: GitHub's five features, their findings, fix time and cost", () => {
  const withRest = (extra) => fakeGh({ rest: { ...REST, ...extra } });
  const repoAs = (fields) => ({ [`repos/${REPO}`]: { ...REST[`repos/${REPO}`], ...fields } });
  const ON = {
    ...repoAs({ security_and_analysis: { secret_scanning: { status: "enabled" }, secret_scanning_push_protection: { status: "enabled" }, dependabot_security_updates: { status: "enabled" } } }),
    [`repos/${REPO}/code-scanning/default-setup`]: { state: "configured" },
    [`repos/${REPO}/code-quality/setup`]: { state: "configured" },
    [`repos/${REPO}/code-scanning/alerts?per_page=100`]: [
      { state: "open", created_at: "2026-09-02T20:00:00Z", rule: { security_severity_level: "high" } },
      { state: "open", created_at: "2026-11-01T00:00:00Z", rule: { severity: "warning" } },
      { state: "fixed", created_at: "2026-10-20T00:00:00Z", fixed_at: "2026-10-21T00:00:00Z", rule: { security_severity_level: "medium" } },
    ],
    [`repos/${REPO}/secret-scanning/alerts?per_page=100&hide_secret=true`]: [
      // A secret value GitHub should not send; the test checks it never reaches the output.
      { state: "open", created_at: "2026-10-30T00:00:00Z", secret_type_display_name: "GitHub Personal Access Token", secret: "fixture-secret-value-must-not-leak" },
      { state: "resolved", resolution: "revoked", created_at: "2026-10-25T00:00:00Z", resolved_at: "2026-10-25T12:00:00Z" },
      { state: "resolved", resolution: "false_positive", created_at: "2026-10-01T00:00:00Z", resolved_at: "2026-10-30T00:00:00Z" },
    ],
    [`repos/${REPO}/code-quality/findings?state=open&per_page=100`]: [
      { state: "open", created_at: "2026-10-31T00:00:00Z", rule: { severity: "warning" } },
      { state: "open", created_at: "2026-10-31T00:00:00Z", rule: { severity: "note" } },
    ],
  };

  it("on: a 1 with no cost, and the findings of every feature counted", async () => {
    const gh = withRest(ON);
    const out = await run({ gh });
    assert.ok(gh.calls.includes(`repos/${REPO}/secret-scanning/alerts?per_page=100&hide_secret=true`), "secret scanning is read with hide_secret=true");
    assert.ok(!gh.calls.some((c) => /secret-scanning/.test(c) && !/hide_secret=true/.test(c)), "never without it");
    assert.ok(!JSON.stringify(out).includes("fixture-secret-value-must-not-leak"), "no secret value reaches the output");
    const paid = [
      "security.code_scanning_on",
      "security.secret_scanning_on",
      "security.code_quality_on",
    ];
    for (const id of paid) {
      assert.equal(out[id].value, 1, id);
      assert.ok(!(out[id].detail ?? []).some((d) => /paid|free/.test(d.label)), `${id}: no cost note`);
    }
    assert.equal(out["security.code_scanning_open"].value, 2);
    assert.deepEqual(out["security.code_scanning_open"].detail.slice(0, 2), [{ label: "critical", value: 0 }, { label: "high", value: 1 }]);
    assert.equal(out["security.secret_scanning_open"].value, 1);
    assert.equal(out["security.code_quality_open"].value, 2);
    // Fixed: Dependabot 2 and 6 days, code scanning 1, a revoked secret 0.5; a false positive is no fix.
    // The latest fix is the secret revoked 2026-10-25T12Z; the later false positive is no fix.
    assert.deepEqual(out["security.latest_fix_days"].detail, [{ label: "latest fix: secret scanning", value: 0.5, unit: "days" }]);
    // The open code scanning alert from 2026-09-02T20:00Z is the oldest: 61 days.
    assert.deepEqual(out["security.oldest_open_alert_days"].detail[0], { label: "oldest: code scanning", value: 61, unit: "days" });
  });

  it("off on a public repo: free to turn on, except Code Quality's licence", async () => {
    const out = await run({ gh: withRest(repoAs({ private: false })) });
    assert.deepEqual(out["security.code_scanning_on"].detail, [{ label: "free on a public repo: turn it on in the repo's settings", value: 0, unit: "" }]);
    assert.equal(out["security.code_scanning_on"].value, 0, "off is a miss, not could_not_check");
    assert.match(out["security.code_quality_on"].detail[0].label, /^paid on a private repo/);
  });

  it("off with no security policy: a miss that says where SECURITY.md goes", async () => {
    const graphql = { ...GRAPHQL, SecurityPolicy: { repository: { isSecurityPolicyEnabled: false } } };
    const out = await run({ gh: fakeGh({ graphql }) });
    assert.equal(out["security.policy_on"].value, 0);
    assert.match(out["security.policy_on"].detail[0].label, /add SECURITY\.md/);
  });

  it("could not read: a refused read is could_not_check, never off", async () => {
    const refused = { __error: { status: 403, message: "Resource not accessible by integration" } };
    const broken = { __error: { status: 500, message: "Server Error" } };
    const out = await run({
      gh: fakeGh({
        rest: {
          ...REST,
          [`repos/${REPO}/code-quality/setup`]: broken,
          [`orgs/fixture-org/settings/billing/advanced-security?advanced_security_product=code_security`]: refused,
        },
        graphql: { ...GRAPHQL, VulnerabilityAlerts: { __error: { message: "Must have admin rights to Repository." } } },
      }),
    });
    assert.match(out["security.code_quality_on"].could_not_check, /HTTP 500/);
    assert.match(out["security.code_quality_open"].could_not_check, /HTTP 500/);
    assert.equal(out["security.features_dollars_per_month"].could_not_check, "needs an admin token; refreshed by a --local collect run");
    assert.match(out["security.dependabot_alerts_on"].could_not_check, /admin rights/);
  });

  it("prices the paid features by the committers billed now", async () => {
    const billed = (n) => ({ total_advanced_security_committers: n });
    const out = await run({
      gh: withRest({
        [`orgs/fixture-org/settings/billing/advanced-security?advanced_security_product=code_security`]: billed(2),
        [`orgs/fixture-org/settings/billing/advanced-security?advanced_security_product=secret_protection`]: billed(1),
      }),
    });
    assert.equal(out["security.features_dollars_per_month"].value, 79, "2 x $30 + 1 x $19");
    const user = await run({ gh: withRest(repoAs({ owner: { type: "User" } })) });
    assert.match(user["security.features_dollars_per_month"].could_not_check, /no organization billing/);
  });

  it("counts malware apart from vulnerabilities, and an alert of any age", async () => {
    const alerts = [
      { state: "open", created_at: "2026-11-02T19:00:00Z", security_advisory: { severity: "low" } },
      { state: "open", created_at: "2026-11-02T19:00:00Z", security_advisory: { severity: "critical", classification: "malware", ghsa_id: "GHSA-mal" } },
    ];
    const out = await run({ gh: withRest({ [`repos/${REPO}/dependabot/alerts?per_page=100`]: alerts }) });
    assert.equal(out["security.dependabot_open"].value, 1);
    assert.equal(out["security.malware_open"].value, 1);
    assert.equal(out["security.oldest_open_alert_days"].value, 0, "an hour old rounds to 0 days");
    assert.equal(out["security.latest_fix_days"].could_not_check, "no alert has been fixed yet");
  });
});

describe("Security and quality: Actions hardening, supply chain and Claude Code", () => {
  const roots = [];
  const repoWith = (files) => {
    const dir = mkdtempSync(path.join(tmpdir(), "github-sec-"));
    roots.push(dir);
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      writeFileSync(path.join(dir, rel), typeof text === "string" ? text : JSON.stringify(text));
    }
    return dir;
  };
  after(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));
  const DAY_MS = 24 * HOUR_MS;
  const ago = (days) => new Date(NOW - days * DAY_MS);
  // A git repo whose commits land the given days before NOW, each writing its files.
  const gitRepo = (...commits) => {
    const root = repoWith({});
    const git = (args, when) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.org", "-c", "commit.gpgsign=false", ...args], { cwd: root, env: { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when } });
    git(["init", "-q"], ago(30).toISOString());
    for (const { daysAgo, files } of commits) {
      // A file given as null is deleted in that commit.
      for (const [rel, text] of Object.entries(files)) {
        if (text === null) rmSync(path.join(root, rel));
        else writeFileSync(path.join(root, rel), typeof text === "string" ? text : JSON.stringify(text));
      }
      git(["add", "-A"], ago(daysAgo).toISOString());
      git(["commit", "-q", "-m", `${daysAgo} days ago`], ago(daysAgo).toISOString());
    }
    return root;
  };
  const npm = (n, v) => `https://registry.npmjs.org/${n}/-/${n}-${v}.tgz`;
  // A fake npm registry: each package's Last-Modified and publish time, every request kept in calls.
  // A request that would follow a redirect is refused, so each test proves redirect: "error".
  const fakeRegistry = ({ header = {}, published = {}, overrides = {} }, calls = []) => async (url, opts = {}) => {
    if (url === PARAMS.site_url) return new Response(null, { status: 200 }); // the headers check
    calls.push(`${opts.method ?? "GET"} ${url}`);
    if (opts.redirect !== "error") throw new Error(`${url} would follow a redirect`);
    const name = url.endsWith(".tgz") ? url.split("/")[3] : decodeURIComponent(url.split("/").slice(3).join("/"));
    if (overrides[name]) return overrides[name](opts);
    if (opts.method === "HEAD") return new Response(null, { status: 200, headers: header[name] ? { "last-modified": header[name].toUTCString() } : {} });
    return new Response(JSON.stringify({ time: { "1.0.0": published[name]?.toISOString(), "2.0.0": published[name]?.toISOString() } }), { status: 200 });
  };
  const YOUNG = "security.young_lockfile_packages";

  it("the GITHUB_TOKEN default: read is on, write is a miss, a refused read is could_not_check", async () => {
    const write = await run({ gh: fakeGh({ rest: { ...REST, [`repos/${REPO}/actions/permissions/workflow`]: { default_workflow_permissions: "write", can_approve_pull_request_reviews: true } } }) });
    assert.equal(write["security.token_default_read"].value, 0);
    assert.deepEqual(write["security.token_default_read"].detail.map((d) => d.value), [0, 1]);
    const refused = await run({ gh: fakeGh({ rest: { ...REST, [`repos/${REPO}/actions/permissions/workflow`]: { __error: { status: 403, message: "Resource not accessible by integration" } } } }) });
    assert.equal(refused["security.token_default_read"].could_not_check, "needs an admin token; refreshed by a --local collect run");
  });

  it("the Actions policy: selected actions and required SHA pins are a row each; a refused read is could_not_check", async () => {
    const KEY = `repos/${REPO}/actions/permissions`;
    const ID = "security.actions_policy_share";
    const withPolicy = (policy) => run({ gh: fakeGh({ rest: { ...REST, [KEY]: policy } }) });
    const open = await withPolicy({ enabled: true, allowed_actions: "all", sha_pinning_required: false });
    assert.equal(open[ID].value, 0);
    assert.deepEqual(open[ID].detail.map((d) => d.value), [0, 0]);
    const tight = await withPolicy({ enabled: true, allowed_actions: "selected", sha_pinning_required: true });
    assert.equal(tight[ID].value, 100);
    const refused = await withPolicy({ __error: { status: 403, message: "Resource not accessible by integration" } });
    assert.equal(refused[ID].could_not_check, "needs an admin token; refreshed by a --local collect run");
    const off = await withPolicy({ enabled: false });
    assert.equal(off[ID].could_not_check, "GitHub Actions is off for this repo, so no policy applies");
  });

  it("locked workflows: one listed in actions.lock counts, a job-level call and a local action are left out", async () => {
    const ID = "actions.locked_share";
    const wf = (uses) => ["name: w", "on: push", "jobs:", "  a:", "    runs-on: ubuntu-latest", "    steps:", `      - uses: ${uses}`].join("\n");
    const call = ["name: v", "on: push", "jobs:", "  ci:", "    uses: ./.github/workflows/a.yml"].join("\n");
    const lock = (names) => ["version: 'v0.0.3'", "workflows:", ...names.map((n) => `    '.github/workflows/${n}': []`), "dependencies: {}"].join("\n");
    const files = {
      ".github/workflows/a.yml": wf("actions/checkout@v7.0.1"),
      ".github/workflows/b.yml": wf("actions/checkout@v7.0.1"),
      ".github/workflows/local.yml": wf("$/actions/pages"),
      ".github/workflows/v.yml": call,
    };
    const none = await run({ root: repoWith(files) });
    assert.equal(none[ID].value, 0, "no lockfile: nothing is locked");
    assert.deepEqual(none[ID].detail.map((d) => [d.label, d.value]), [["a.yml", 0], ["b.yml", 0]]);
    const half = await run({ root: repoWith({ ...files, ".github/workflows/actions.lock": lock(["a.yml", "v.yml"]) }) });
    assert.equal(half[ID].value, 50);
    const all = await run({ root: repoWith({ ...files, ".github/workflows/actions.lock": lock(["a.yml", "b.yml"]) }) });
    assert.equal(all[ID].value, 100);
    const nothing = await run({ root: repoWith({ ".github/workflows/v.yml": call, ".github/workflows/local.yml": wf("./actions/pages") }) });
    assert.equal(nothing[ID].could_not_check, "no workflow in .github/workflows calls an outside action in a step");
    const broken = await run({ root: repoWith({ ...files, ".github/workflows/actions.lock": "workflows: [unclosed" }) });
    assert.match(broken[ID].could_not_check, /actions\.lock/);
  });

  it("a tag the lockfile records for its workflow counts as pinned; the same tag unlocked does not", async () => {
    const wf = ["name: w", "on: push", "jobs:", "  a:", "    runs-on: ubuntu-latest", "    steps:", "      - uses: actions/checkout@v7.0.1", "      - uses: $/actions/pages"].join("\n");
    const lock = (file) => ["version: 'v0.0.3'", "workflows:", `    '.github/workflows/${file}':`, "        - 'actions/checkout@v7.0.1'", "dependencies: {}"].join("\n");
    const pinned = async (files) => (await run({ root: repoWith({ ".github/workflows/a.yml": wf, ...files }) }))["actions.pinned_share"].value;
    assert.equal(await pinned({ ".github/workflows/actions.lock": lock("a.yml") }), 100);
    assert.equal(await pinned({ ".github/workflows/actions.lock": lock("other.yml") }), 0, "locked for another workflow");
    assert.equal(await pinned({}), 0, "no lockfile");
  });

  it("finds a pull_request_target job that checks out the pull request's head, and only that", async () => {
    const wf = (ref) => ["name: label", "on: pull_request_target", "jobs:", "  label:", "    runs-on: ubuntu-latest", "    steps:", "      - uses: actions/checkout@1111111111111111111111111111111111111111", ...(ref ? ["        with:", `          ref: ${ref}`] : [])].join("\n");
    const bad = await run({ root: repoWith({ ".github/workflows/label.yml": wf("${{ github.event.pull_request.head.sha }}") }) });
    assert.equal(bad["security.prt_head_checkouts"].value, 1);
    assert.deepEqual(bad["security.prt_head_checkouts"].detail, [{ label: "label.yml: job label", value: 1, unit: "" }]);
    const base = await run({ root: repoWith({ ".github/workflows/label.yml": wf(null) }) });
    assert.equal(base["security.prt_head_checkouts"].value, 0, "the base branch's code is safe to run");
  });

  it("also finds gh pr checkout, a fetch of refs/pull, and workflow_run jobs that check out the head", async () => {
    const job = (on, steps) => [`name: w`, `on: ${on}`, "jobs:", "  j:", "    runs-on: ubuntu-latest", "    steps:", ...steps].join("\n");
    const files = {
      ".github/workflows/a.yml": job("pull_request_target", ["      - run: gh pr checkout ${{ github.event.pull_request.number }}"]),
      ".github/workflows/b.yml": job("pull_request_target", ["      - run: git fetch origin refs/pull/${{ github.event.number }}/head && git checkout FETCH_HEAD"]),
      ".github/workflows/c.yml": job("workflow_run", ["      - uses: actions/checkout@1111111111111111111111111111111111111111", "        with:", "          ref: ${{ github.event.workflow_run.head_sha }}"]),
      ".github/workflows/d.yml": job("workflow_run", ["      - uses: actions/checkout@1111111111111111111111111111111111111111"]),
      ".github/workflows/e.yml": job("pull_request", ["      - run: gh pr checkout 1"]),
    };
    const out = await run({ root: repoWith(files) });
    assert.deepEqual(out["security.prt_head_checkouts"].detail.map((d) => d.label), ["a.yml: job j", "b.yml: job j", "c.yml: job j"], "d checks out the base; e has no secrets to leak");
    assert.equal(runsPullRequestCode({ uses: "actions/checkout@v4", with: { repository: "${{ github.event.pull_request.head.repo.full_name }}" } }), true, "the head repo, not only the head ref");
    assert.equal(runsPullRequestCode({ run: "git checkout main" }), false);
  });

  it("reads each Dependabot feed's shortest cooldown against params.cooldown_days", async () => {
    const yml = ["version: 2", "updates:", "  - package-ecosystem: npm", '    directory: "/"', "    cooldown:", "      default-days: 14",
      "  - package-ecosystem: pip", '    directory: "/"', "    cooldown:", "      default-days: 3", "      semver-major-days: 30"].join("\n");
    const out = await run({ root: repoWith({ ".github/dependabot.yml": yml }) });
    assert.equal(out["security.dependabot_cooldown"].value, 50, "pip's default of 3 days is the shortest");
    assert.deepEqual(out["security.dependabot_cooldown"].detail, [{ label: "npm /", value: 14, unit: "days" }, { label: "pip /", value: 3, unit: "days" }]);
  });

  it("Git Crafter's own Dependabot config groups every feed and waits params.cooldown_days, and .nvmrc pins an LTS major", async () => {
    const codeOs = path.join(FIXTURES, "..", "..", "..");
    const out = await run({ root: codeOs });
    assert.equal(out["settings.dependabot_grouping"].value, 100, JSON.stringify(out["settings.dependabot_grouping"]));
    assert.equal(out["security.dependabot_cooldown"].value, 100, JSON.stringify(out["security.dependabot_cooldown"]));
    assert.deepEqual(out["security.dependabot_cooldown"].detail.map((d) => d.label).sort(), ["github-actions /", "npm /"]);
    // tools.node_lts reads a bare major; Node's LTS lines are even, and at or past package.json's engines floor.
    const nvmrc = readFileSync(path.join(codeOs, ".nvmrc"), "utf8");
    assert.match(nvmrc, /^\d+\n$/);
    const major = Number(nvmrc.trim());
    const floor = Number(/\d+/.exec(JSON.parse(readFileSync(path.join(codeOs, "package.json"), "utf8")).engines.node)[0]);
    assert.ok(major % 2 === 0 && major >= floor, `.nvmrc ${major}: an even line at or past ${floor}`);
  });

  it("counts lockfile packages that resolve somewhere other than the allowed registries", async () => {
    const lock = { lockfileVersion: 3, packages: {
      "": { dependencies: { a: "^1.0.0" } },
      "node_modules/a": { version: "1.0.0", resolved: "https://registry.npmjs.org/a/-/a-1.0.0.tgz" },
      "node_modules/b": { version: "1.0.0", resolved: "https://registry.npmjs.org/b/-/b-1.0.0.tgz" },
      "node_modules/c": { version: "1.0.0", resolved: "https://registry.npmjs.org/c/-/c-1.0.0.tgz" },
      "node_modules/d": { version: "1.0.0", resolved: "git+ssh://git@example.org/d.git#abc" },
      "packages/app": { version: "0.0.0" },
    } };
    const out = await run({ root: repoWith({ "package-lock.json": lock }) });
    assert.equal(out["security.lockfile_registry_share"].value, 75);
    assert.deepEqual(out["security.lockfile_registry_share"].detail.at(-1), { label: "d: git+ssh://git@example.org", value: 1, unit: "" });
  });

  it("finds a lockfile package younger than the cooldown with no cache: a HEAD first, a full document only where it is recent", async () => {
    // 20 days ago: a@1.0.0. A day ago: b@2.0.0 under a (new), c@1.0.0 (an old file), e@1.0.0
    // (an old version whose file was re-uploaded, so its header is recent) and d (a git URL).
    const lockOf = (pkgs) => ({ lockfileVersion: 3, packages: { "": { dependencies: { a: "^1.0.0", c: "^1.0.0", e: "^1.0.0" } }, ...pkgs } });
    const a = { "node_modules/a": { version: "1.0.0", resolved: npm("a", "1.0.0"), dependencies: { b: "^2.0.0" } } };
    const root = gitRepo({ daysAgo: 20, files: { "package-lock.json": lockOf(a) } }, { daysAgo: 1, files: { "package-lock.json": lockOf({
      ...a,
      "node_modules/a/node_modules/b": { version: "2.0.0", resolved: npm("b", "2.0.0") },
      "node_modules/c": { version: "1.0.0", resolved: npm("c", "1.0.0") },
      "node_modules/e": { version: "1.0.0", resolved: npm("e", "1.0.0") },
      "node_modules/d": { version: "1.0.0", resolved: "git+ssh://git@example.org/d.git#abc" },
    }) } });
    const times = { header: { b: ago(3), c: ago(400), e: ago(2) }, published: { b: ago(3), e: ago(900) } };
    const calls = [];
    const registry = (overrides) => fakeRegistry({ ...times, overrides }, calls);
    const out = await run({ root, fetch: registry() });
    assert.equal(out[YOUNG].value, 1, "b; e's file is recent but its version is not");
    assert.deepEqual(out[YOUNG].detail[0], { label: "b 2.0.0, via a", value: 3, unit: "days old" });
    assert.ok(!calls.some((c) => /\/a(\/|$)/.test(c)), "a, in the lockfile before the cooldown, is never fetched");
    assert.deepEqual(calls.filter((c) => c.startsWith("GET")).sort(), ["GET https://registry.npmjs.org/b", "GET https://registry.npmjs.org/e"], "c's old header settles it with no document");
    assert.equal(calls.filter((c) => c.startsWith("HEAD")).length, 3, "one HEAD each for b, c and e; d is a git URL");
    const down = await run({ root, fetch: registry({ c: () => new Response(null, { status: 503 }) }) });
    assert.equal(down[YOUNG].could_not_check, "the registry answered HTTP 503 for c 1.0.0", "an unreachable registry is never 0");
    const noTime = await run({ root, fetch: registry({ b: (o) => (o.method === "HEAD" ? new Response(null, { status: 200 }) : new Response(JSON.stringify({ time: {} }), { status: 200 })) }) });
    assert.equal(noTime[YOUNG].could_not_check, "no publish time for b 2.0.0", "a missing time is never old");
    // params.max_registry_reads caps every request: the HEADs before any is made, then the documents with them.
    calls.length = 0;
    const headsCapped = await run({ root, fetch: registry(), params: { ...PARAMS, max_registry_reads: 2 } });
    assert.equal(headsCapped[YOUNG].could_not_check, "3 downloads to ask for Last-Modified, over params.max_registry_reads (2)");
    assert.deepEqual(calls, [], "past the cap, nothing is asked");
    const docsCapped = await run({ root, fetch: registry(), params: { ...PARAMS, max_registry_reads: 4 } });
    assert.equal(docsCapped[YOUNG].could_not_check, "3 HEADs and 2 documents to read from the registry, over params.max_registry_reads (4)");
  });

  it("asks only an allowed registry's own host, parsed, never matched as text", async () => {
    const pkg = (resolved, name) => ({ ...(name && { name }), version: "1.0.0", resolved });
    const root = gitRepo({ daysAgo: 1, files: { "package-lock.json": { lockfileVersion: 3, packages: {
      "": {},
      "node_modules/x1": pkg("https://registry.npmjs.org.evil.example/x1/-/x1-1.0.0.tgz"),
      "node_modules/x2": pkg("https://registry.npmjs.org@evil.example/x2/-/x2-1.0.0.tgz"),
      "node_modules/x3": pkg("http://registry.npmjs.org/x3/-/x3-1.0.0.tgz"),
      "node_modules/x4": pkg("https://user:pw@registry.npmjs.org/x4/-/x4-1.0.0.tgz"),
      "node_modules/x5": pkg("https://registry.npmjs.org:8443/x5/-/x5-1.0.0.tgz"),
      // Names a lockfile can carry: each one's document stays on the registry.
      "node_modules/y1": pkg(npm("y1", "1.0.0"), ".evil.example"),
      "node_modules/y2": pkg(npm("y2", "1.0.0"), "@scope/y2"),
    } } } });
    const calls = [];
    // No trailing slash: before the fix, ".evil.example" made https://registry.npmjs.org.evil.example.
    const params = { ...PARAMS, registries: ["https://registry.npmjs.org"] };
    const published = { ".evil.example": ago(400), "@scope/y2": ago(400) };
    const out = await run({ root, params, fetch: fakeRegistry({ published }, calls) });
    assert.equal(out[YOUNG].value, 0);
    assert.deepEqual(out[YOUNG].detail.at(-1), { label: "entries from no allowed registry, not asked", value: 5, unit: "" });
    assert.deepEqual(calls.sort(), [
      "GET https://registry.npmjs.org/.evil.example",
      "GET https://registry.npmjs.org/@scope%2Fy2",
      `HEAD ${npm("y1", "1.0.0")}`,
      `HEAD ${npm("y2", "1.0.0")}`,
    ]);
    assert.equal(out["security.lockfile_registry_share"].value, 28.6, "the same test scores the share: 2 of 7");
    const team = [new URL("https://npm.example/team/")];
    assert.ok(registryOf("https://npm.example/team/a/-/a-1.0.0.tgz", team));
    const encoded = ["..%2Fother", "..%2fother", "..%5Cother", "..%5cother"].map((p) => `https://npm.example/team/${p}/a.tgz`);
    for (const url of ["https://npm.example/teamx/a.tgz", "https://npm.example/team/../other/a.tgz", "https://npm.example/team/%2e%2e/other/a.tgz", ...encoded, "not a url"]) {
      assert.equal(registryOf(url, team), null, url);
    }
  });

  it("keeps a document's path one name: only a scope's %2F is encoded, so no server decodes it into another path", async () => {
    const team = { ...PARAMS, registries: ["https://npm.example/team/"] };
    const lockWith = (name) => ({ "package-lock.json": { lockfileVersion: 3, packages: { "": {}, "node_modules/x": { name, version: "1.0.0", resolved: "https://npm.example/team/x/-/x-1.0.0.tgz" } } } });
    const calls = [];
    const scoped = await run({ root: gitRepo({ daysAgo: 1, files: lockWith("@scope/x") }), params: team, fetch: fakeRegistry({ published: { "team/@scope/x": ago(400) } }, calls) });
    assert.equal(scoped[YOUNG].value, 0);
    assert.ok(calls.includes("GET https://npm.example/team/@scope%2Fx"), calls.join(", "));
    for (const name of ["../other", "@scope/../../other", "//evil.example/x", "a\\b"]) {
      const out = await run({ root: gitRepo({ daysAgo: 1, files: lockWith(name) }), params: team, fetch: fakeRegistry({}) });
      assert.equal(out[YOUNG].could_not_check, `${name} names a document outside https://npm.example/team/`, name);
    }
  });

  it("never follows a redirect, and stops asking once one request fails", async () => {
    const pkgs = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`node_modules/p${i}`, { version: "1.0.0", resolved: npm(`p${i}`, "1.0.0") }]));
    const root = gitRepo({ daysAgo: 1, files: { "package-lock.json": { lockfileVersion: 3, packages: { "": {}, ...pkgs } } } });
    const calls = [];
    const signals = [];
    const fetch = async (url, opts = {}) => {
      if (url === PARAMS.site_url) return new Response(null, { status: 200 }); // the headers check
      calls.push(url);
      signals.push(opts.signal);
      // What fetch throws on a 3xx under redirect: "error".
      if (url === npm("p0", "1.0.0")) throw new TypeError("fetch failed", { cause: new Error("redirect mode is set to error") });
      await new Promise((resolve) => setTimeout(resolve, 50));
      return new Response(null, { status: 200, headers: { "last-modified": ago(400).toUTCString() } });
    };
    const out = await run({ root, fetch });
    assert.equal(out[YOUNG].could_not_check, "the registry could not be read for p0 1.0.0: redirect mode is set to error");
    await new Promise((resolve) => setTimeout(resolve, 200)); // the 7 in flight answer; a worker that kept going would ask again
    assert.equal(calls.length, 8, "the 8 in flight, none of the 12 queued");
    assert.ok(signals.every((sig) => sig.aborted), "those still in flight are told to stop");
  });

  it("could_not_check where git cannot show the lockfile's history; an old lockfile missing or v1 makes every entry new", async () => {
    const lock = { lockfileVersion: 3, packages: { "": {}, "node_modules/a": { version: "1.0.0", resolved: npm("a", "1.0.0") } } };
    const heads = (out) => out[YOUNG].detail.find((d) => d.label.startsWith("downloads asked")).value;
    const old = fakeRegistry({ header: { a: ago(400) } });
    const noLock = gitRepo({ daysAgo: 20, files: { "README.md": "x" } }, { daysAgo: 1, files: { "package-lock.json": lock } });
    assert.equal(heads(await run({ root: noLock, fetch: old })), 1, "no lockfile 20 days ago: a is new");
    const v1 = gitRepo({ daysAgo: 20, files: { "package-lock.json": { lockfileVersion: 1, dependencies: { a: { version: "1.0.0" } } } } }, { daysAgo: 1, files: { "package-lock.json": lock } });
    assert.equal(heads(await run({ root: v1, fetch: old })), 1, "a v1 lockfile 20 days ago has no packages map: a is new");
    const shallow = repoWith({});
    execFileSync("git", ["clone", "-q", "--depth", "1", `file://${noLock}`, shallow]);
    assert.match((await run({ root: shallow }))[YOUNG].could_not_check, /^the checkout is shallow/);
    const broken = repoWith({ "package-lock.json": lock, ".git": "gitdir: /nonexistent\n" });
    assert.match((await run({ root: broken }))[YOUNG].could_not_check, /^git could not read the lockfile's history: /);
  });

  it("in CI the open-alert counts read with the workflow's vulnerability-alerts permission, and say so when it is missing", async () => {
    const out = await run({ mode: "ci", admin: null });
    assert.equal(out["security.dependabot_open"].value, EXPECTED["security.dependabot_open"]);
    assert.equal(out["security.malware_open"].value, EXPECTED["security.malware_open"]);
    assert.equal(out["security.token_default_read"].could_not_check, "needs an admin token; refreshed by a --local collect run", "an admin read is still not tried in CI");
    const refused = { __error: { status: 403, message: "Resource not accessible by integration" } };
    const denied = await run({ mode: "ci", gh: fakeGh({ rest: { ...REST, [`repos/${REPO}/dependabot/alerts?per_page=100`]: refused } }) });
    for (const id of ["security.dependabot_open", "security.malware_open"]) {
      assert.equal(denied[id].could_not_check, "needs vulnerability-alerts: read on the workflow's token; refreshed by a --local collect run", id);
    }
  });

  it("in CI an admin metric reads with ADMIN_READ_TOKEN's client when one is given, and says why when it is refused", async () => {
    const workflow = fakeGh();
    const out = await run({ mode: "ci", gh: workflow, admin: fakeGh() });
    for (const id of ["security.token_default_read", "settings.main_protected"]) assert.equal(out[id].value, EXPECTED[id], id);
    assert.ok(!workflow.calls.some((c) => /actions\/permissions\/workflow/.test(c)), "the workflow token makes no admin read");
    const refused = { __error: { status: 403, message: "Must have admin rights to Repository." } };
    const rest = Object.fromEntries(Object.keys(REST).map((k) => [k, refused]));
    const denied = await run({ mode: "ci", admin: fakeGh({ rest, graphql: {} }) });
    assert.equal(denied["security.token_default_read"].could_not_check, "needs an admin token; refreshed by a --local collect run");
  });

  it("ADMIN_READ_TOKEN: unset or blank gives no admin client; set gives one, and each metric picks its client", () => {
    assert.equal(adminGh({}), null);
    assert.equal(adminGh({ ADMIN_READ_TOKEN: "  " }), null);
    assert.equal(typeof adminGh({ ADMIN_READ_TOKEN: "fake-value" }).rest, "function");
    const gh = {};
    const admin = {};
    assert.equal(clientFor({ mode: "ci", needs: "github-admin", gh, admin }).gh, admin);
    assert.equal(clientFor({ mode: "ci", needs: "github-admin", gh, admin: null }).skip, "needs an admin token; refreshed by a --local collect run");
    assert.equal(clientFor({ mode: "ci", needs: "project-scope", gh, admin }).gh, admin, "an App token with projects read reads the board in CI");
    assert.equal(clientFor({ mode: "ci", needs: "project-scope", gh, admin: null }).skip, "needs the project scope: gh auth refresh -s project; refreshed by a --local collect run");
    assert.equal(clientFor({ mode: "ci", needs: "none", gh, admin }).gh, gh);
    assert.equal(clientFor({ mode: "local", needs: "github-admin", gh, admin }).gh, gh, "a local run reads with the session's own login");
  });

  it("a threat model is current only when the code it covers has not changed since", async () => {
    const params = { ...PARAMS, threat_model_covers: ["worker.ts"] };
    const model = (root) => run({ root, params }).then((out) => out["security.threat_model_current"]);
    const stale = gitRepo({ daysAgo: 20, files: { "THREAT-MODEL.md": "# Threat model" } }, { daysAgo: 3, files: { "worker.ts": "a" } }, { daysAgo: 1, files: { "README.md": "b" } });
    assert.deepEqual((await model(stale)).detail, [{ label: "THREAT-MODEL.md 2026-10-13; the covered code 2026-10-30", value: 17, unit: "days behind" }], "a README change is not covered");
    assert.equal((await model(stale)).value, 0);
    const fresh = gitRepo({ daysAgo: 3, files: { "worker.ts": "a" } }, { daysAgo: 1, files: { "THREAT-MODEL.md": "# Threat model" } });
    assert.equal((await model(fresh)).value, 1);
    const none = gitRepo({ daysAgo: 3, files: { "worker.ts": "a" } });
    assert.deepEqual((await model(none)).detail, [{ label: "no THREAT-MODEL.md at HEAD; the covered code changed 2026-10-30", value: 0, unit: "" }]);
    // Deleted after the code changed: git log's latest commit to it is the delete, which must not read as current.
    const deleted = gitRepo({ daysAgo: 20, files: { "THREAT-MODEL.md": "# Threat model" } }, { daysAgo: 3, files: { "worker.ts": "a" } }, { daysAgo: 1, files: { "THREAT-MODEL.md": null } });
    assert.deepEqual([(await model(deleted)).value, (await model(deleted)).detail[0].label], [0, "no THREAT-MODEL.md at HEAD; the covered code changed 2026-10-30"]);
    assert.equal((await model(gitRepo({ daysAgo: 3, files: { "README.md": "a" } }))).could_not_check, "no commit touches params.threat_model_covers yet");
    // A repo may let the model trail its code by params.threat_model_grace_days; the template allows none.
    const graced = (days) => run({ root: stale, params: { ...params, threat_model_grace_days: days } }).then((out) => out["security.threat_model_current"]);
    assert.equal((await graced(17)).value, 1, "17 days behind, 17 allowed");
    assert.deepEqual([(await graced(16)).value, (await graced(16)).detail[0].value], [0, 17], "17 days behind, 16 allowed");
    // A model in two files: the newest commit to either dates it, and both must be at HEAD.
    const both = (root) => run({ root, params: { ...params, threat_model: ["THREAT-MODEL.md", "GUARDS.md"] } }).then((out) => out["security.threat_model_current"]);
    const split = gitRepo({ daysAgo: 20, files: { "THREAT-MODEL.md": "# Threat model" } }, { daysAgo: 3, files: { "worker.ts": "a" } }, { daysAgo: 1, files: { "GUARDS.md": "# Guards" } });
    assert.deepEqual([(await both(split)).value, (await both(split)).detail[0].label], [1, "THREAT-MODEL.md, GUARDS.md 2026-11-01; the covered code 2026-10-30"]);
    assert.deepEqual([(await both(fresh)).value, (await both(fresh)).detail[0].label], [0, "no GUARDS.md at HEAD; the covered code changed 2026-10-30"]);
    const shallow = repoWith({});
    execFileSync("git", ["clone", "-q", "--depth", "1", `file://${stale}`, shallow]);
    assert.match((await model(shallow)).could_not_check, /^the checkout is shallow/);
  });

  it("names the direct dependency that pulls a package in, from the root or a workspace folder", () => {
    const ws = { packages: {
      "": { workspaces: ["site"] },
      site: { dependencies: { astro: "^5.0.0" } },
      "node_modules/astro": { version: "5.0.0", dependencies: { "magic-string": "^1.0.0" } },
      "node_modules/astro/node_modules/magic-string": { version: "1.4.4" },
      "node_modules/magic-string": { version: "0.30.0" },
    } };
    const reach = pulledBy(ws);
    assert.deepEqual([...reach.get("node_modules/astro/node_modules/magic-string")], ["astro"]);
    assert.equal(reach.get("node_modules/magic-string"), undefined, "nothing in the tree needs the hoisted copy");
    assert.deepEqual(lockPackages(ws).map((p) => p.name), ["astro", "magic-string", "magic-string"]);
  });

  it("counts a security review only from Claude's app or bot: a forged comment or a user named claude never counts", async () => {
    const out = await run();
    assert.deepEqual(out["security.claude_review_share"].detail, [{ label: "with a security review from Claude", value: 2, unit: "" }, { label: "merged PRs read", value: 4, unit: "" }], "#20's check and #18's Bot review");
    const bots = await run({ params: { ...PARAMS, review_apps: [] } });
    assert.equal(bots["security.claude_review_share"].value, 25, "only #18: #17's comment is from a User account named claude");
    const others = await run({ params: { ...PARAMS, review_apps: [], review_authors: ["fixture-bot"] } });
    assert.equal(others["security.claude_review_share"].value, 25, "a repo can name its own reviewer; then only #19 counts");
  });

  it("scores only the PRs that change a file params.review_paths names", async () => {
    const ts = await run({ params: { ...PARAMS, review_paths: ["**/*.ts"] } });
    assert.equal(ts["security.claude_review_share"].value, 100, "only #18 changes a .ts file, and Claude's bot reviewed it");
    assert.deepEqual(ts["security.claude_review_share"].detail.at(-1), { label: "merged PRs outside params.review_paths, left out", value: 3, unit: "" });
    const astro = await run({ params: { ...PARAMS, review_paths: ["site/src/pages/**"] } });
    assert.equal(astro["security.claude_review_share"].value, 33.3, "#20, #19 and #17; only #20 reviewed");
    const none = await run({ params: { ...PARAMS, review_paths: ["docs/**"] } });
    assert.match(none["security.claude_review_share"].could_not_check, /no merged PR .* params\.review_paths names/);
  });

  it("counts the credential paths the repo's Claude Code settings deny reading", async () => {
    const settings = { permissions: { deny: ["Read(./.env)", "Read(./.env.*)", "Read(**/*.pem)", "Read(~/.ssh/**)", "Bash(curl *)"] } };
    const out = await run({ root: repoWith({ ".claude/settings.json": settings }) });
    // Covered: ./.env, ./.env.*, ./**/*.pem, ~/.ssh/**; not ./secrets/**, ./**/*.key, ~/.aws/**: 4 of 7.
    assert.equal(out["security.claude_deny_coverage"].value, 57.1);
    assert.equal(denyCovers("**/.env", "./.env"), true, "a glob that takes the path in");
    assert.equal(denyCovers("./.env", "./.env.*"), false, "a narrower rule does not cover a wider pattern");
    const none = await run({ params: { ...PARAMS, credential_patterns: [] } });
    assert.match(none["security.claude_deny_coverage"].could_not_check, /params\.credential_patterns .* is empty/);
  });

  // Git Crafter's own settings (#191): they only narrow what a session may read, so they grant nothing.
  it("Git Crafter's .claude/settings.json is deny-only and covers every template credential path", async () => {
    const root = path.join(HERE, "..", "..", "..");
    const file = path.join(root, ".claude", "settings.json");
    assert.ok(existsSync(file), "Git Crafter has a .claude/settings.json");
    const settings = JSON.parse(readFileSync(file, "utf8"));
    // autoCompactWindow sizes a session's context (#693); enabledPlugins false and deniedMcpServers only switch things off (#754). None grants anything, so they may sit beside the deny list.
    const granting = Object.keys(settings).filter((k) => !["permissions", "autoCompactWindow", "enabledPlugins", "deniedMcpServers"].includes(k));
    assert.ok(Object.values(settings.enabledPlugins ?? {}).every((v) => v === false), "enabledPlugins only switches off");
    assert.deepEqual(granting, [], "no hooks, env or other keys");
    assert.ok(Number.isInteger(settings.autoCompactWindow ?? 250000), "autoCompactWindow is a token count");
    assert.deepEqual(Object.keys(settings.permissions), ["deny"], "no allow or ask list");
    assert.ok(settings.permissions.deny.every((r) => /^Read\(.+\)$/.test(r)), "every rule is a Read(...) deny");
    const targets = TARGETS.filter((t) => t.id === "security.claude_deny_coverage");
    const out = await collect({ root, mode: "local", params: TEMPLATE_PARAMS, targets, gh: fakeGh(), fetch: fakeFetch(), now: NOW, repo: REPO });
    assert.equal(out["security.claude_deny_coverage"].value, 100);
  });

  it("holds the default branch to a pull request, no force pushes and no deletion", async () => {
    const rules = [{ type: "pull_request", ruleset_id: 1 }];
    const out = await run({ gh: fakeGh({ rest: { ...REST, [`repos/${REPO}/rules/branches/main`]: rules } }) });
    assert.equal(out["settings.main_protected"].value, 0);
    assert.deepEqual(out["settings.main_protected"].detail.slice(0, 3).map((d) => d.value), [1, 0, 0]);
  });
});
