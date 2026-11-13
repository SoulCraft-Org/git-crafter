// node --test tests/pages-docs.test.mjs: the docs check, the model's
// ratings, the rule and account references, and the map library. CI runs
// every tests/pages*.test.mjs through tools/verify.sh.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  collect,
  LABELS,
  namedIds,
  readOwnRun,
  fetchSite,
  ORG_CONFIG,
  publicMetrics,
  readTracked,
  readDocs as readDocsFrom,
  SCOPE,
} from "../tools/collect_org.mjs";
import { findOrgConfig, orgSettings } from "../tools/org_base.mjs";
import { loadLibrary, resolveMaps } from "../pages/library.mjs";
import { readTargetFiles } from "../quality/overlay.mjs";
import {
  build,
  checkDocs,
  checkLibrary,
  CODE_OS_QUALITY_CONFIG,
  MAX_STEPS,
  missingKinds,
  PAGE_DEFAULTS,
  pageConfig,
  qualityConfigPath,
  qualityDefs,
  withOwnRun,
} from "../pages/build.mjs";
import { openingStep, position, rate, rateGoals, stepReadout } from "../pages/model.mjs";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const NOW = new Date("2026-11-03T12:00:00Z");
const ago = (h) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const readAt = NOW.toISOString();
const readJson = (name) => JSON.parse(readFileSync(join(ROOT, name), "utf8"));


test("private references: org names and home paths outside config/ and data/, the guard files included, never a public name", (t) => {
  const config = { org: "Example-Org", private: { mac_accounts: { this: "acme", admin: "rootco", others: ["acmelabs"] }, github_users: ["acme-gh"], repos: { keys: "acme-gh/keys" }, paths: { keys_checkout: "~/Vault" } } };
  // Split, so this file's own scan below does not count the fixture's home path.
  const home = "/Users" + "/acme/x";
  const files = [
    { path: "rules/bad.md", text: `Homebrew belongs to rootco. Keys: \`~/Vault\` (acme-gh/keys). cat ~acme/.zshrc ${home}` },
    { path: "rules/clean.md", text: "acme-site, acme.org, acmelabs-tool, /Users/someone/x, /Users/Shared/y, /Users/runner, /Users/someone., /Users/_/x" },
    { path: "config/other.json", text: "acme rootco" },
    { path: "data/org.json", text: "acme" },
    { path: "tools/bash_guard_rules.json", text: "acme rootco" },
    { path: "configs/leak.md", text: "acmelabs" },
  ];
  const m = publicMetrics({ files, config, readAt })["public.private_refs"];
  assert.equal(m.value, 8);
  assert.deepEqual(m.detail.map((d) => [d.label, d.value]), [["rules/bad.md", 5], ["tools/bash_guard_rules.json", 2], ["configs/leak.md", 1]]);
  assert.match(publicMetrics({ files, config: { private: {} }, readAt })["public.private_refs"].could_not_check, /lists no private names/);
  // This checkout, against the real org config: the count is the PR's figure. A public tree has none.
  if (!ORG_CONFIG || !existsSync(join(ROOT, ORG_CONFIG))) return t.diagnostic("no org config in this checkout");
  const real = publicMetrics({ files: readTracked(ROOT), config: readJson(ORG_CONFIG), readAt })["public.private_refs"];
  assert.ok(Number.isFinite(real.value), JSON.stringify(real));
  t.diagnostic(`this checkout: ${real.value} private references; ${real.detail.map((d) => `${d.label} ${d.value}`).join(", ") || "none"}`);
});

test("the org and site come from the environment or the org config, never a constant", () => {
  const dir = mkdtempSync(join(tmpdir(), "org-"));
  try {
    assert.equal(findOrgConfig(dir), null, "no config folder");
    mkdirSync(join(dir, "config"));
    writeFileSync(join(dir, "config", "quality.json"), "{}");
    writeFileSync(join(dir, "config", "bad.json"), "{");
    assert.deepEqual(orgSettings({ GITHUB_REPOSITORY_OWNER: "owner-x" }, dir), { config: null, org: "owner-x", site: null });
    assert.deepEqual(orgSettings({}, dir), { config: null, org: null, site: null });
    writeFileSync(join(dir, "config", "acme.json"), JSON.stringify({ org: "Acme", site_repo: "acme-site" }));
    assert.equal(findOrgConfig(dir), "config/acme.json");
    assert.deepEqual(orgSettings({ GITHUB_REPOSITORY_OWNER: "owner-x" }, dir), { config: "config/acme.json", org: "Acme", site: "acme-site" });
    assert.deepEqual(orgSettings({ CODE_OS_ORG: "Other", CODE_OS_SITE_REPO: "other-site" }, dir), { config: "config/acme.json", org: "Other", site: "other-site" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.throws(() => fetchSite({}, null), /no site repo/);
});

test("rating: bands by direction, and positions put near at 0 and the goal at 1", () => {
  const lower = { direction: "lower", goal: 4, near: 24 };
  assert.equal(rate(lower, 4).status, "meets");
  assert.equal(rate(lower, 10).status, "near");
  assert.equal(rate(lower, 30).status, "misses");
  assert.equal(rate(lower, null).status, "not-measured");
  assert.equal(position(lower, 24), 0);
  assert.equal(position(lower, 4), 1);
  assert.equal(position(lower, 1000), -1);
  assert.equal(position({ direction: "higher", goal: 95, near: 85 }, 100), 1.5);
});

test("goals rate per repo, and an inverted pass reads 100 less the share", () => {
  const doc = { outcomes: [{ id: "o", name: "O", goals: [{ id: "g", label: "G", metrics: ["m"], unit: "%", direction: "higher", goal: 90, near: 80 }] }] };
  const data = { repos: [{ name: "a" }, { name: "b" }], metrics: { m: { value: 85, unit: "%", by_repo: { a: 95, b: null } } } };
  const [o] = rateGoals(doc, data);
  assert.equal(o.goals[0].status, "near");
  assert.equal(o.goals[0].byRepo.a.status, "meets");
  assert.equal(o.goals[0].byRepo.b.status, "not-measured");
  assert.equal(o.score, 50);
  const total = rateGoals({ outcomes: [{ ...doc.outcomes[0], goals: [{ ...doc.outcomes[0].goals[0], per_repo: false }] }] }, data)[0].goals[0];
  assert.equal(total.hasRepos, false, "an org-wide total is not rated per repo");
  assert.deepEqual(total.byRepo, {});
});

test("quality_config: only Git Crafter's own build reads config/quality.json; a repo's config that names none never resolves to it", () => {
  assert.equal(PAGE_DEFAULTS.quality_config, null);
  assert.equal(pageConfig({ repos: ["one"] }).quality_config, null);
  assert.equal(qualityConfigPath(), CODE_OS_QUALITY_CONFIG);
  assert.equal(CODE_OS_QUALITY_CONFIG, "config/quality.json");
  assert.equal(qualityConfigPath({ repos: ["one"] }), null, "the repo's own quality/config.json, else the template's");
  assert.equal(qualityConfigPath({ repos: ["one"], quality_config: "q.json" }), "q.json");
});

test("a map step reads its one metric, rated by the repo's Quality page goal, never another repo's number", () => {
  const def = { id: "f", kind: "quality", label: "Fixed after review", unit: "%", direction: "lower", goal: 20, near: 40 };
  const ro = stepReadout({ metric: "f" }, { f: { value: 25, unit: "%" } }, { def });
  assert.deepEqual([ro.value, ro.status, ro.kind, ro.label], [25, "near", "quality", "Fixed after review"], "lower is better needs no flag: the definition says so");
  const copied = stepReadout({ metric: "s" }, { s: { value: 93, unit: "%", target: { direction: "higher", goal: 90, near: 75 } } });
  assert.equal(copied.status, "meets", "with no definitions read, a copied target rates it");
  const theirs = { s: { value: 93, unit: "%", copied_from: "example-site", source: "x" } };
  const foreign = stepReadout({ metric: "s" }, theirs, { def: { ...def, id: "s" }, ownRepo: "code-os" });
  assert.equal(foreign.value, null);
  assert.equal(foreign.status, "not-measured");
  assert.match(foreign.entry.could_not_check, /example-site's number, not code-os's/);
  assert.equal(stepReadout({ metric: "s" }, theirs, { ownRepo: "example-site" }).value, 93, "the repo's own copy is its own");
});

test("a map opens on its first step that misses, then near, then its first step", () => {
  const steps = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.equal(openingStep(steps, { a: { status: "meets" }, b: { status: "near" }, c: { status: "misses" } }), "c");
  assert.equal(openingStep(steps, { a: { status: "meets" }, b: { status: "near" }, c: { status: "meets" } }), "b");
  assert.equal(openingStep(steps, { a: { status: "not-measured" } }), "a");
});

test("goals.json and process.json pass the docs check; a goal with near on the wrong side fails", () => {
  const goals = readJson("goals.json");
  const proc = readJson("process.json");
  assert.deepEqual(checkDocs(goals, proc), []);
  const bad = structuredClone(goals);
  bad.outcomes[0].goals[0].near = 99;
  assert.match(checkDocs(bad, proc).join("\n"), /near must sit on the worse side/);
  // The maps are each repo's own file: process.json holds none.
  assert.equal("steps" in proc, false);
  assert.match(checkDocs(goals, { ...proc, steps: [] }).join("\n"), /process.json: steps are gone/);
});

// The maps self-test: a known-good file passes and a known-bad one fails on
// every rule, each error naming its map and step, against the ids of
// Git Crafter's own Quality page.
test("every id process.json names resolves: on Git Crafter's Quality page, or written by the Process collector", () => {
  const { ids } = qualityDefs(ROOT, CODE_OS_QUALITY_CONFIG);
  assert.ok(ids?.size > 50, "the Quality page's ids were read");
  const dead = [...namedIds(readJson("process.json"))].filter((id) => !ids.has(id) && !(id in LABELS));
  assert.deepEqual(dead, [], "process.json names ids no page measures");
  assert.deepEqual([...namedIds({ a: [{ metric: "x" }, { metrics: ["y"], usage: { metric: "z" } }] })].sort(), ["x", "y", "z"], "the walk finds nested ids");
});

// Each account's facts live in its own overlay's code-os/account.json, so a
// rule names a field there instead of a value. Every field a rule names must
// be documented in the placeholder file a new account copies.
const ACCOUNT_ROOTS = ["machine", "keys", "compute", "ci", "delegate"];
function undocumentedFields(text, example) {
  const refs = [...text.matchAll(/`([a-z_]+(?:\.[a-z_]+)+)`/g)].map((m) => m[1]).filter((r) => ACCOUNT_ROOTS.includes(r.split(".")[0]));
  return [...new Set(refs)].filter((r) => r.split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), example) === undefined);
}

test("every account.json field a rule names is documented in config/account.example.json", () => {
  const example = readJson("config/account.example.json");
  assert.deepEqual(undocumentedFields("see `ci.budget` and `compute.gpu`, not `a.b`", { ci: { budget: "x" }, compute: { gpu: [] } }), [], "known-clean sample");
  assert.deepEqual(undocumentedFields("`ci.budget` and `machine.gone`", { ci: { budget: "x" } }), ["machine.gone"], "known-bad sample");
  for (const root of ACCOUNT_ROOTS) assert.ok(example[root] && typeof example[root] === "object", `account.example.json documents ${root}`);
  const rules = readdirSync(join(ROOT, "rules")).filter((f) => f.endsWith(".md"));
  for (const f of rules) assert.deepEqual(undocumentedFields(readFileSync(join(ROOT, "rules", f), "utf8"), example), [], `rules/${f}`);
  const keys = readFileSync(join(ROOT, "rules/keys-detail.md"), "utf8");
  for (const field of ["naming", "use", "use_runs", "check", "owner_runs"]) {
    assert.ok(keys.includes(`\`${field}\``) && field in example.keys, `rules/keys-detail.md's keys.${field} is documented`);
  }
});

const slug = (h) => h.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
const RULE_LINK = /\b((?:rules|skills)\/[a-z_/-]+?(?:\.md|\/SKILL\.md))#([a-z0-9-]+)/g;
function deadRuleAnchors(texts, readTarget) {
  const dead = [];
  for (const [where, text] of texts) {
    for (const [, path, anchor] of text.matchAll(RULE_LINK)) {
      const target = readTarget(path);
      const heads = new Set((target ?? "").split("\n").filter((l) => /^#{1,6} /.test(l)).map((l) => slug(l.replace(/^#+ /, ""))));
      if (!heads.has(anchor)) dead.push(`${where}: ${path}#${anchor}${target === null ? " (no such file)" : ""}`);
    }
  }
  return dead;
}

test("every rules/ and skills/ anchor resolves to a heading", () => {
  const rule = "# Rules\n\n## Pull requests\n\n## Owner's queue\n";
  const read = (p) => (p === "rules/x.md" ? rule : null);
  assert.deepEqual(deadRuleAnchors([["ok", "see rules/x.md#pull-requests and rules/x.md#owners-queue"]], read), [], "known-clean sample");
  assert.deepEqual(deadRuleAnchors([["bad", "rules/x.md#who-merges, skills/y/SKILL.md#a"]], read), ["bad: rules/x.md#who-merges", "bad: skills/y/SKILL.md#a (no such file)"], "known-bad sample");
  const skip = new Set([".git", "node_modules", "data", "dist", "shots"]);
  const texts = [];
  const walk = (dir) => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(d.name)) continue;
      const p = join(dir, d.name);
      if (d.isDirectory()) walk(p);
      else if (/\.(json|md|mjs|js|yml|sh|py)$/.test(d.name) && !p.endsWith("pages-docs.test.mjs")) texts.push([relative(ROOT, p), readFileSync(p, "utf8")]);
    }
  };
  walk(ROOT);
  const readRepo = (p) => (existsSync(join(ROOT, p)) ? readFileSync(join(ROOT, p), "utf8") : null);
  assert.deepEqual(deadRuleAnchors(texts, readRepo), []);
});

// ---- The map library ----------------------------------------------------------

const templateIds = () => new Set(readTargetFiles(join(ROOT, "quality", "targets")).flatMap(({ list }) => list.filter((d) => d.drop !== true).map((d) => d.id)));
const templateKinds = () => Object.fromEntries(readTargetFiles(join(ROOT, "quality", "targets")).flatMap(({ list }) => list.filter((d) => d.drop !== true).map((d) => [d.id, d.kind])));

test("the library: every map has its ideal and dated sources, at most MAX_STEPS steps, each step one template metric, and a step of each kind", () => {
  const library = loadLibrary();
  assert.deepEqual(Object.keys(library).sort(), ["adopt", "board", "code", "contribute", "delivery", "deploy", "document", "measure", "secure", "triage"]);
  assert.ok(library.document.steps.every((s) => s.metric.startsWith("docs.")), "every Document step reads a docs metric");
  assert.deepEqual(checkLibrary(library, templateIds(), templateKinds()), [], "a template metric a step names was removed, or a map lost a kind: ask the orchestrator before dropping it");
  // Git Crafter's own maps too, Spend and each override included: the library check never sees them.
  const own = readDocsFrom(ROOT, { goals: "goals.json", process: "process.json", maps: "maps.json" }).maps.maps;
  assert.deepEqual(own.filter((m) => missingKinds(m.steps, templateKinds()).length).map((m) => m.id), [], "each map scores quality, speed and consumption (pages/maps/README.md)");
  const broken = { x: { ...library.delivery, id: "x", ideal: undefined, sources: undefined, critical_path: undefined, steps: [{ ...library.delivery.steps[0], rule: "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twentyone", rule_ref: "rules/x.md", metric: "gone.metric" }] } };
  assert.deepEqual(checkLibrary(broken, templateIds(), templateKinds()), ['pages/maps map "x", step "plan": gone.metric is not a metric on this repo\'s Quality page', "pages/maps/x.json: a library map needs an ideal and its sources", 'pages/maps/x.json, step "plan": rule_ref must be an https link', 'pages/maps/x.json, step "plan": rule has 21 words; a library rule keeps 20 at most', "pages/maps/x.json: no step scores quality, speed, consumption; a map scores quality, speed and consumption"]);
});

test("a repo uses a library map by id and changes a step by id; a typo is an error, never a no-op", () => {
  const library = loadLibrary();
  const doc = { repo_url: "https://example.org", maps: [{ use: "delivery", why: "Ours", steps: { review: { rule: "Two reviewers.", rule_ref: "REVIEW.md" }, plan: { drop: true } } }, { id: "own", name: "Own", why: "w", steps: [] }] };
  const [m, own] = resolveMaps(doc, library).maps;
  assert.deepEqual([m.id, m.why, m.library, m.ideal], ["delivery", "Ours", "delivery", library.delivery.ideal]);
  assert.deepEqual(m.steps.map((s) => s.id), ["build", "ci", "review", "merge"], "the library's order, less the dropped step");
  assert.deepEqual(m.critical_path, ["build", "ci", "review", "merge"]);
  const review = m.steps.find((s) => s.id === "review");
  assert.deepEqual([review.rule, review.rule_ref, review.metric], ["Two reviewers.", "REVIEW.md", "pull_requests.reviewed"]);
  assert.equal(own, doc.maps[1], "a map of the repo's own passes through");
  for (const [bad, re] of [
    [{ use: "nope" }, /no library map "nope"/],
    [{ use: "delivery", steps: { nope: {} } }, /no step "nope"/],
    [{ use: "delivery", steps: { plan: { id: "x" } } }, /a step takes only/],
    [{ use: "delivery", steps: { plan: { drop: false } } }, /drop must be true/],
    [{ use: "delivery", gates: [] }, /a library map takes only/],
  ]) assert.throws(() => resolveMaps({ maps: [bad] }, library), re);
});

test("a repo with only library maps and template defaults, web on for the deploy map, builds every section with its ideal", () => {
  const dir = mkdtempSync(join(tmpdir(), "cos-library-"));
  try {
    const uses = ["delivery", "deploy", "adopt", "measure", "code"];
    // The deploy map reads deploy.* ids, on Pages, a web tab (#97).
    mkdirSync(join(dir, "quality"));
    writeFileSync(join(dir, "quality", "config.json"), JSON.stringify({ web: true }));
    writeFileSync(join(dir, "maps.json"), JSON.stringify({ repo_url: "https://github.com/example/one/blob/main", maps: uses.map((use) => ({ use })) }));
    mkdirSync(join(dir, "data"));
    writeFileSync(join(dir, "data", "org.json"), JSON.stringify({ generated_at: ago(1), org: "example-org", repos: [{ name: "one", default_branch: "main" }], errors: [], metrics: {} }));
    const out = build({ root: dir, now: NOW, config: { repos: ["one"], docs: { maps: "maps.json" }, history: null, tabs: ["build"], pages: { process: "process.html" } } });
    assert.deepEqual([out.code, out.errs, out.warnings], [0, undefined, []]);
    const html = out.pages["process.html"];
    for (const id of uses) assert.match(html, new RegExp(`aria-label="Ideal state: [^"]+"><h3 id="map-${id}-ideal">`), `${id} opens with its ideal`);
    assert.equal((html.match(/class="panel/g) ?? []).length >= uses.length, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Git Crafter's maps use nine library maps, and its own Quality run reads every step's metric (#330)", (t) => {
  // This repo tracks no Mac's run (.gitignore), so only a local checkout holds it.
  if (!existsSync(join(ROOT, "data/quality/local.json"))) return t.skip("no data/quality/local.json in this tree");
  const maps = readJson("maps.json").maps;
  assert.deepEqual(maps.map((m) => m.use ?? m.id), ["delivery", "deploy", "board", "adopt", "measure", "code", "triage", "document", "secure"]);
  const own = readJson("data/quality/local.json").metrics;
  const steps = readDocsFrom(ROOT, { goals: "goals.json", process: "process.json", maps: "maps.json" }).maps.maps.flatMap((m) => m.steps.map((s) => s.metric));
  const unread = steps.filter((id) => !own[id] || String(own[id].could_not_check ?? "").includes("no repo to read"));
  assert.deepEqual(unread, [], "collect it with node quality/collect.mjs --config config/quality.json --local, which hands the collectors the repo");
  // The build reads each step from the Quality run itself, so no copy in data/org.json lags it (#508, #531): no session step re-copies them.
  if (!existsSync(join(ROOT, "data/org.json"))) return t.skip("no data/org.json in this tree");
  const docs = readDocsFrom(ROOT, SCOPE.docs);
  const drawn = withOwnRun(readJson("data/org.json"), ROOT, SCOPE, docs).metrics;
  const run = readOwnRun(ROOT, SCOPE).own.data.metrics;
  const stale = steps.filter((id) => drawn[id]?.copied_from !== "code-os" || drawn[id].value !== run[id].value);
  assert.deepEqual(stale, [], "step values older than the Quality snapshot: goal 0");
});

