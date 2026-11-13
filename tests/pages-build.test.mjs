// node --test tests/pages-build.test.mjs: a build of both pages from a small
// fixture, the maps, the templates and the drawn trails. CI runs every
// tests/pages*.test.mjs through tools/verify.sh.

import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { configScope, namedIds, ownQuality, ownSteps, finishCollect, readDocs as readDocsFrom, readSiteFromDisk, SCOPE } from "../tools/collect_org.mjs";
import { systemsMetrics } from "../tools/systems.mjs";
import { loadLibrary, resolveMaps } from "../pages/library.mjs";
import { TABS as TEMPLATE_TABS } from "../quality/score.mjs";
import { BUDGET, build, checkDocs, checkMaps, checkTokens, CODE_OS_QUALITY_CONFIG, MAX_STEPS, qualityDefs } from "../pages/build.mjs";
import { figureOf, goalOf, modelsLane, PROCESS_TABS, renderMetrics, renderProcess } from "../pages/render.mjs";
import { GAP, places, systemsMap, tokenFlow, trail, TRAIL } from "../pages/draw.mjs";
import { GRID, grid } from "../pages/draw-grid.mjs";
import { stepReadout } from "../pages/model.mjs";
import { stripAll } from "../quality/collectors/lib/strip.mjs";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const NOW = new Date("2026-11-03T12:00:00Z");
const ago = (h) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const readAt = NOW.toISOString();
const readJson = (name) => JSON.parse(readFileSync(join(ROOT, name), "utf8"));


test("maps: a known-good file passes, a known-bad one fails on every rule, and Git Crafter's own maps.json is its own Quality page's", () => {
  const { defs } = qualityDefs(ROOT);
  assert.ok(defs && Object.keys(defs).length > 100, "Git Crafter's Quality page definitions read");
  const ids = new Set(Object.keys(defs));
  assert.deepEqual(checkMaps(readJson("tests/fixtures/maps/good.json"), ids, "good.json"), []);
  const own = qualityDefs(ROOT, "config/quality.json").defs;
  // By id, not by count: the own page also adds a metric and the web tabs.
  assert.ok(own && Object.keys(defs).some((id) => !(id in own)), "Git Crafter's own Quality page turns some of the template off");
  assert.deepEqual(checkMaps(resolveMaps(readJson("maps.json")), new Set(Object.keys(own)), "maps.json"), [], "Git Crafter's own maps name only its own Quality page's ids");
  const errs = checkMaps(readJson("tests/fixtures/maps/bad.json"), ids, "bad.json");
  const expect = [
    /^bad\.json: repo_url must be an https link/,
    /^bad\.json map "delivery", step "plan": needs exactly one metric, an id on this repo's Quality page$/,
    /^bad\.json map "delivery", step "build": time is gone; a step names one metric/,
    /^bad\.json map "delivery", step "check": ci\.pass_rate is not a metric on this repo's Quality page$/,
    /^bad\.json map "delivery", step "review": needs exactly one metric/,
    /^bad\.json map "delivery", step "review": needs an id of its own in the map/,
    /^bad\.json map "delivery", step "review": icon must be one of /,
    /^bad\.json map "delivery", step "review": gates_from must be one of hooks, workflows, deploys$/,
    /^bad\.json map "delivery": critical_path names "ship", which is not one of its steps$/,
    /^bad\.json map "long": needs a name and a why$/,
    new RegExp(`^bad\\.json map "long": has 7 steps; a map keeps the fewest, ${MAX_STEPS} at most$`),
    /^bad\.json map "fork", step "b": at needs \[column, row\]$/,
    /^bad\.json map "fork": 2 of 3 steps have at; a fork places every step$/,
    /^bad\.json map "overlap": two steps share one cell; each step has its own at$/,
  ];
  for (const re of expect) assert.ok(errs.some((e) => re.test(e)), `${re} in:\n${errs.join("\n")}`);
  assert.equal(errs.length, expect.length, errs.join("\n"));
  assert.deepEqual(checkMaps(readJson("tests/fixtures/maps/good.json"), null), [], "no ids read: the ids go unchecked");
  assert.match(checkMaps({ repo_url: "https://x", maps: [] }).join(), /maps must list at least one map/);
  assert.deepEqual(checkMaps(null), [], "a repo that names no maps file has none");
  const unread = qualityDefs(ROOT, "no-such-config.json");
  assert.match(unread.why, /no-such-config\.json/, "an unreadable Quality config is a reason, not a throw");
  assert.ok(unread.ids.has("pull_requests.reviewed"), "and the template's ids still check the maps");
});

test("Git Crafter's own Quality page turns every tab on, and each of its map steps names a tool, a rule and a metric", () => {
  assert.deepEqual(readJson("config/quality.json").tabs.slice().sort(), TEMPLATE_TABS.map(([id]) => id).sort(), "every template tab, Design, Usability and Deploy included");
  const steps = resolveMaps(readJson("maps.json")).maps.flatMap((m) => m.steps);
  assert.ok(steps.every((s) => s.tools?.length && s.rule && s.metric), "each step names a tool, a rule and a metric");
});

test("the starters: the Quality config turns every tab on, and the Process config is its own maps file, each step a metric on that page", () => {
  const dir = mkdtempSync(join(tmpdir(), "cos-starter-"));
  try {
    mkdirSync(join(dir, "quality", "process"), { recursive: true });
    cpSync(join(ROOT, "templates/quality/config.json"), join(dir, "quality", "config.json"));
    cpSync(join(ROOT, "templates/process/config.json"), join(dir, "quality", "process", "config.json"));
    assert.deepEqual(readJson("templates/quality/config.json").tabs, TEMPLATE_TABS.map(([id]) => id), "every template tab, in the template's order");
    const scope = configScope(readJson("templates/process/config.json"));
    const { maps } = readDocsFrom(dir, scope.docs);
    assert.deepEqual(maps.maps.map((m) => m.id), ["delivery", "deploy", "adopt", "measure", "code", "triage", "secure"]);
    const { defs, why } = qualityDefs(dir);
    assert.ok(defs, why);
    assert.deepEqual(checkMaps(maps, new Set(Object.keys(defs)), "config.json"), []);
    const pagesYml = readFileSync(join(ROOT, "templates/ci/pages.yml"), "utf8");
    for (const want of [/pages: process quality/, /config: quality\/process\/config\.json/, /quality-config: quality\/config\.json/, /"\*\*\/\*\.md"/]) assert.match(pagesYml, want, "pages.yml builds both pages from the starters' paths, on doc changes too");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the delivery map scores review by reviews at the head and merge by minutes from green, each goaled on Git Crafter's page", () => {
  const steps = Object.fromEntries(loadLibrary().delivery.steps.map((s) => [s.id, s]));
  assert.deepEqual([steps.review.metric, steps.merge.metric], ["pull_requests.reviewed", "pull_requests.green_to_merge_minutes"]);
  assert.equal(steps.review.tools[0], "Pull request reviews");
  const { defs, why } = qualityDefs(ROOT, CODE_OS_QUALITY_CONFIG);
  assert.ok(defs, why);
  assert.deepEqual([defs["pull_requests.green_to_merge_minutes"].goal, defs["pull_requests.green_to_merge_minutes"].near], [30, 120]);
  const goal = readJson("goals.json").outcomes.flatMap((o) => o.goals).find((g) => g.id === "green-to-merge");
  assert.deepEqual([goal.metrics[0], goal.goal, goal.near], ["pull_requests.green_to_merge_minutes", 30, 120]);
});

test("Git Crafter's Deploy tab reads its GitHub Pages deploys, each with Git Crafter's own goal", () => {
  const { defs, why } = qualityDefs(ROOT, CODE_OS_QUALITY_CONFIG);
  assert.ok(defs, why);
  assert.equal(defs["deploy.waiting_merges"].params.platform, "pages");
  for (const [id, goal] of [["deploy.waiting_merges", 0], ["deploy.oldest_waiting_hours", 1], ["deploy.latest_lead_hours", 1]]) {
    assert.equal(defs[id].goal, goal, id);
    assert.match(defs[id].goal_source, /^Git Crafter goal: pages\.yml publishes/, id);
  }
});

test("both pages build from a fixture, escape untrusted labels, and show every goal and step", () => {
  const dir = mkdtempSync(join(tmpdir(), "cos-pages-"));
  try {
    cpSync(join(ROOT, "goals.json"), join(dir, "goals.json"));
    cpSync(join(ROOT, "process.json"), join(dir, "process.json"));
    cpSync(join(ROOT, "maps.json"), join(dir, "maps.json"));
    cpSync(join(ROOT, "systems.json"), join(dir, "systems.json"));
    cpSync(join(ROOT, "tokens.json"), join(dir, "tokens.json"));
    mkdirSync(join(dir, "data", "history"), { recursive: true });
    const org = {
      generated_at: ago(2),
      org: "example-org",
      repos: [{ name: "one", default_branch: "main" }],
      gh_calls: 1,
      rest_calls: 120,
      errors: [],
      site: { pages_url: "https://example.pages.github.io/" },
      pipelines: {
        one: {
          detail: [{ label: "ci <i>", value: 2, unit: "minutes", stage: "ci", kind: "workflow", runs: "On every pull request: test on ubuntu-latest", file: ".github/workflows/ci.yml", pass_rate: 90 }],
          apart: [{ label: "nightly", value: null, unit: "minutes", stage: "Scheduled", kind: "workflow", runs: "On a schedule", file: ".github/workflows/n.yml", pass_rate: null }],
          source: "gh api graphql",
          read_at: ago(2),
        },
      },
      testing: { one: { rows: [{ suite: "tests", file: ".github/workflows/t.yml", when: "every pull request", checks: "Unit", value: 3, pass_rate: 100, jobs: [{ name: "Web test", checks: "Vitest", when: "every pull request" }, { name: "Swift Test", checks: "", when: "every pull request" }] }, { suite: "secret-scan", file: ".github/workflows/s.yml", when: "every pull request", checks: "Self-test", value: 1, pass_rate: 100, jobs: [{ name: "secret-scan", checks: "Self-test", when: "every pull request" }] }], dispatch: ["test:unit"], source: "gh api graphql", read_at: ago(2) } },
      metrics: {
        "pr.latest_merge_hours": { label: "PR open to merge, the latest", value: 3, unit: "h", by_repo: { one: 3 }, detail: [{ label: "one#1", value: 3, unit: "h" }], source: "s", read_at: ago(2) },
        "pr.latest_10_merges_hours": { label: "Hours since the 10th-latest merge", value: 1008, unit: "h", by_repo: { one: 1008 }, bound: true, bound_repos: ["one"], detail: [{ label: "fewer than 10 merges in the 6 weeks read: at least", value: 1008, unit: "h" }], source: "s", read_at: ago(2) },
        "pr.conflicts_open": { label: "Open PRs with conflicts", value: 1, unit: "PRs", by_repo: { one: 1 }, detail: [{ label: "one#3 <script>alert(1)</script>", value: 2, unit: "days open" }], source: "s", read_at: ago(2) },
        "ci.pass_rate": { label: "CI runs that pass", could_not_check: "gh failed", source: "s" },
      },
    };
    writeFileSync(join(dir, "data", "org.json"), JSON.stringify(org));
    writeFileSync(join(dir, "data", "history", "2026-11-03.json"), JSON.stringify({ generated_at: ago(2), values: { "pr.latest_merge_hours": 3 } }));
    const out = build({ root: dir, now: NOW });
    assert.equal(out.code, 0);
    const proc = out.pages["index.html"];
    const met = out.pages["metrics.html"];
    // A lower bound reads "≥ x" wherever the value shows: the goal row and the goal mark's tooltip.
    assert.match(met, /<span data-r="" class="val">≥ 1,008 h<\/span>/, "the goal row's headline");
    assert.match(`${met}${proc}`, /aria-label="Hours since the 10th-latest merge: ≥ 1,008 h; goal ≤ 24 h"/, "the goal mark's tooltip");
    assert.doesNotMatch(`${met}${proc}`, /: 1,008 h; goal|class="val">1,008 h|class="mt-n">1,008 h/, "no headline or tooltip reads a bare 1,008 h");
    assert.match(proc, /<svg class="trail"/);
    const idx = proc.match(/<div class="map-index" role="navigation" aria-label="Maps">[^]*?<\/div>/)?.[0] ?? "";
    assert.deepEqual([...idx.matchAll(/<a href="(#map-[^"]+)" aria-label="[^"]+: \d+ of \d+ steps meet their goal"/g)].map((m) => m[1]), resolveMaps(readJson("maps.json")).maps.map((m) => `#map-${m.id}`), "the strip links every map, in order");
    for (const tab of ["build", "ci", "testing"]) assert.match(proc, new RegExp(`id="tab-${tab}"`));
    assert.match(proc, /class="cf-node/, "the CI tab draws the pipeline");
    assert.ok(!proc.includes("ci <i>"), "a workflow name is escaped");
    assert.match(proc, /No suite runs on a local machine/);
    assert.match(proc, /<code>test:unit<\/code>/);
    assert.match(proc, /Apart from the pipeline/);
    assert.match(proc, /<tr class="job"><th scope="row">Web test/);
    assert.match(proc, /3 suites/, "a job named like its workflow counts once");
    assert.doesNotMatch(proc, /<tr class="job"><th scope="row">secret-scan/, "and gets no row of its own");
    assert.doesNotMatch(proc, /id="tab-claude"/, "the Claude tab left for Claudius");
    const ciTab = proc.slice(proc.indexOf('id="tab-ci"'), proc.indexOf('id="tab-testing"'));
    const std = readJson("process.json").ci.metrics;
    assert.doesNotMatch(ciTab, /class="cmap|How a repo gets CI/, "the CI standard shows its metrics, not a map");
    const stdSec = ciTab.slice(ciTab.indexOf('aria-label="The CI standard"'));
    assert.equal((stdSec.slice(0, stdSec.indexOf("</section>")).match(/<div class="mt[ "]/g) ?? []).length, std.length, "one tile for each of the standard's metrics");
    assert.match(stdSec, /data-tip="not measured: /, "a metric no collector builds yet says so");
    assert.match(proc, /id="tab-systems"/);
    assert.match(proc, /<svg class="smap"/);
    assert.equal((proc.match(/class="sy-node"/g) ?? []).length, 11, "every system on the map");
    assert.match(proc, /needs an API key from the owner/);
    assert.match(proc, /<table class="mlane">/);
    assert.match(proc, /<div class="sypanel" id="sy-actions"[^]*?<div class="mts">/, "a system's panel shows its usage tiles");
    const tok = proc.slice(proc.indexOf('id="tab-tokens"'), proc.indexOf('id="tab-systems"'));
    const tdoc = readJson("tokens.json");
    assert.match(tok, /<svg class="tflow"/);
    assert.equal((tok.match(/class="tf-node"/g) ?? []).length, tdoc.flow.nodes.length, "every flow node is drawn");
    assert.equal((tok.match(/<tr><th scope="row"><a href=/g) ?? []).length, tdoc.practices.length, "every practice is a row");
    assert.match(tok, /no metric yet/);
    assert.match(tok, /<p class="reason">not measured: no collector reported it<\/p>/, "the stack says why it has no bar");
    assert.match(tok, /120 calls/, "a field figure reads data/org.json");
    assert.ok(Buffer.byteLength(proc) < BUDGET && Buffer.byteLength(met) < BUDGET);
    assert.equal((proc.match(/<article class="panel"/g) ?? []).length, resolveMaps(readJson("maps.json")).maps.flatMap((m) => m.steps).length, "one panel per map step");
    for (const panel of proc.match(/<article class="panel"[^]*?<\/article>/g)) assert.equal((panel.match(/<div class="tile[ "]/g) ?? []).length, 1, "each step shows one metric");
    assert.doesNotMatch(proc, /<ul class="also">/);
    assert.match(met, /<svg class="strip"/);
    for (const g of readJson("goals.json").outcomes.flatMap((o) => o.goals)) assert.ok(met.includes(`id="goal-${g.id}"`), g.id);
    assert.ok(!met.includes("<script>alert(1)"), "a PR title is escaped");
    assert.match(met, /gh failed/);
    assert.match(met, /href="https:\/\/example\.pages\.github\.io\/">Site Quality page/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("when the site's data could not be read, the Process tabs say why", () => {
  const dir = mkdtempSync(join(tmpdir(), "cos-pages-"));
  try {
    cpSync(join(ROOT, "goals.json"), join(dir, "goals.json"));
    cpSync(join(ROOT, "process.json"), join(dir, "process.json"));
    cpSync(join(ROOT, "maps.json"), join(dir, "maps.json"));
    mkdirSync(join(dir, "data"));
    writeFileSync(join(dir, "data", "org.json"), JSON.stringify({ generated_at: ago(1), site: { repo: "org/example-site" }, repos: [{ name: "example-site" }], errors: ["site quality data: gh: Internal Server Error (HTTP 500)"], metrics: {}, pipelines: {}, testing: { "example-site": { rows: [], dispatch: [], source: "s", read_at: ago(1) } } }));
    const proc = build({ root: dir, now: NOW }).pages["index.html"];
    assert.match(proc, /not measured: could not read the site&#39;s data: site quality data: gh: Internal Server Error \(HTTP 500\)/);
    assert.match(proc, /Test cases by suite: not measured: could not read the site/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("systems.json is a template: another repo's doc draws its own map, readers and lane", () => {
  const doc = {
    usage_goal: 70,
    goals: [{ id: "u", measure: "under_goal", label: "Under goal", unit: "%", direction: "higher", goal: 100, near: 80 }],
    lanes: [{ id: "a", label: "Apps", row: 0 }, { id: "b", label: "Data", row: 1 }],
    models: { columns: [{ id: "k", label: "Kept", icon: "build" }], rows: [{ label: "Runs", k: { sum: ["x.one", "x.two"] } }, { label: "Spend", k: { why: "no reader" } }] },
    systems: [
      { id: "web", name: "Web", lane: "a", icon: "build", role: "r", from: [], to: ["db"], limits: [], usage: { why: "none" }, rule: "r", at: [0, 0], reads: [{ metric: "x.one", kind: "app_sessions", app: "Tool", dir: "~/tool" }] },
      { id: "db", name: "Store", lane: "b", icon: "repo", role: "r", from: ["web"], to: [], limits: [], usage: { why: "none" }, rule: "r", at: [1, 1], reads: [{ metric: "x.two", kind: "no_such_reader" }] },
    ],
  };
  const out = systemsMetrics({ gh: { rest: () => { throw new Error("no gh"); } }, site: null, doc, org: "O", readAt: NOW.toISOString(), home: "/nonexistent-home" });
  assert.match(out["x.one"].source, /^~\/tool: no session folder/, "~ expands to the home it was given, and shows as ~");
  assert.match(out["x.two"].could_not_check, /names no reader "no_such_reader"/);
  assert.match(checkDocs(readJson("goals.json"), readJson("process.json"), doc).join("\n"), /db: a read needs a metric and one of the reader kinds/);
  const svg = systemsMap(doc.systems.map((x) => ({ ...x, use: { pct: null, status: "not-measured", text: "not measured", tip: "t" } })), "web", doc.lanes, doc.usage_goal);
  assert.match(svg, />Apps</);
  assert.match(svg, />Data</);
  assert.doesNotMatch(svg, /Build and ship|Renders/, "no Git Crafter lane is drawn into another repo's map");
  assert.match(svg, /viewBox="0 0 430 /, "the map is as wide as its own columns");
  const lane = modelsLane(doc.models, { "x.one": { value: 3, unit: "sessions", source: "s", read_at: NOW.toISOString() }, "x.two": { could_not_check: "no" } });
  assert.match(lane, />Kept</);
  assert.match(lane, />3 sessions</);
  assert.match(lane, /not measured: no reader/);
});

test("tokens.json is a template: figures, rows, fields and goals from the repo's own data", () => {
  const data = {
    generated_at: ago(1),
    rest_calls: 250,
    metrics: {
      "x.call": { label: "Call", value: 1000, unit: "tokens", target: { direction: "lower", goal: 800, near: 1200 }, source: "s", read_at: ago(1) },
      "x.parts": { label: "Parts", value: 90, unit: "tokens", detail: [{ label: "repo CLAUDE.md", value: 60, unit: "tokens" }, { label: "house rules", value: 20, unit: "tokens" }, { label: "memory index", value: 10, unit: "tokens" }], source: "s", read_at: ago(1) },
      "x.used": { label: "Used", value: 4500, unit: "requests", source: "s", read_at: ago(1) },
    },
  };
  assert.equal(figureOf({ metric: "x.parts", row: "CLAUDE\\.md|rules" }, data).value, 80, "rows matching the pattern are summed");
  assert.match(figureOf({ metric: "x.parts", row: "nothing" }, data).could_not_check, /no row matching nothing/);
  assert.equal(figureOf({ field: "rest_calls", unit: "calls" }, data).value, 250);
  assert.match(figureOf({ field: "nope" }, data).could_not_check, /has no nope/);
  assert.match(figureOf({ metric: "x.missing" }, data).could_not_check, /no collector reported it/);
  const sys = { usage_goal: 80, systems: [{ id: "gh", name: "GitHub", limits: [{ label: "REST requests", value: 5000, unit: "an hour" }] }] };
  const goals = [{ metric: "x.used", system: "gh", limit: 0 }, { field: "rest_calls", direction: "lower", goal: 300, near: 300, goal_source: "g" }];
  assert.deepEqual(goalOf({ metric: "x.used" }, data.metrics["x.used"], goals, sys), { direction: "lower", goal: 4000, near: 5000, unit: "requests", goal_source: "systems.json: under 80% of GitHub's REST requests, 5,000 an hour" });
  assert.equal(goalOf({ metric: "x.call" }, data.metrics["x.call"], goals, sys).goal, 800, "a metric's own target wins");
  assert.equal(goalOf({ field: "rest_calls" }, null, goals, sys).goal, 300);
  assert.equal(goalOf({ metric: "x.parts", row: "memory" }, data.metrics["x.parts"], goals, sys), null, "a row is not the metric its goal rates");
  const doc = readJson("tokens.json");
  assert.deepEqual(checkTokens(doc, readJson("systems.json")), []);
  const bad = structuredClone(doc);
  bad.flow.edges.push({ from: "workers", to: "nowhere" });
  bad.goals.push({ metric: "m", system: "nope", limit: 0 });
  bad.practices[0].doc = "http://insecure";
  const errs = checkTokens(bad, readJson("systems.json")).join("\n");
  assert.match(errs, /edge workers to nowhere: unknown node/);
  assert.match(errs, /systems.json has no limit 0 for nope/);
  assert.match(errs, /needs an https doc link/);
  const svg = tokenFlow({
    groups: [{ id: "a", label: "Alpha", figs: [{ text: "1K tokens", tip: "t" }], cache: { text: "cache 5 min", tip: "q" } }],
    nodes: [{ id: "n1", label: "One", icon: "plan", group: "a", at: [0, 0] }, { id: "n2", label: "Two", icon: "ci", group: "a", at: [1, 1], fig: { text: "2 runs", tip: "s" } }],
    edges: [{ from: "n1", to: "n2", word: "hands" }],
    ring: null,
  });
  assert.match(svg, />Alpha</);
  assert.match(svg, />hands</);
  assert.match(svg, />2 runs</);
  assert.doesNotMatch(svg, /Orchestrator|Subagents/, "no Git Crafter node is drawn into another repo's flow");
});

// Every rules/ or skills/ link with an anchor must land on a heading of that
// file, by GitHub's slug: lower case, punctuation dropped, spaces to hyphens
// (issue #45: #36 moved headings and left 21 links dead).
test("every trail is spaced evenly: a map's steps spread over the width, a long list widens it, the main line ends at the last critical step", () => {
  const [own] = resolveMaps(readJson("maps.json")).maps;
  const p = places(own.steps, new Set(own.critical_path));
  assert.deepEqual([p.first, p.end, p.last], ["plan", "merge", "merge"]);
  assert.equal(p.width, TRAIL.width, "a map's steps fit the trail's width");
  assert.equal(Math.round(p.x.merge), TRAIL.width - TRAIL.x0, "and spread to its far edge");
  const off = places(own.steps, new Set(["plan", "build"]));
  assert.deepEqual([off.end, off.last], ["build", "merge"], "a step past the critical path sits past the main line's end");
  const twelve = Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, name: `s${i}` }));
  const t = places(twelve, new Set());
  assert.deepEqual([t.gap, t.width >= TRAIL.x0 * 2 + 11 * GAP], [GAP, true], "a long list widens the trail rather than crowding it");
});

// A step link's name from its content: its one text, spaced, less the hidden per-repo variants.
const shownWords = (link) => stripAll(link.match(/<text>(.*)<\/text>/)[1].replace(/<tspan[^>]* hidden>[^<]*<\/tspan>/g, ""), /<[^>]+>/g);
test("a trail step's link name starts with the words the step shows (axe label-content-name-mismatch)", () => {
  const map = { id: "m", name: "Map", steps: [{ id: "plan", name: "Plan the work", short: "Plan" }, { id: "ship", name: "Ship" }] };
  const readouts = { plan: { label: "Session start to PR open", value: 0.59, unit: "h", kind: "speed" }, ship: { label: "Latest deploy", value: null, unit: "h" } };
  const svg = trail(map, readouts, new Set(["plan"]), "plan");
  const links = [...svg.matchAll(/<a class="t-step[^>]*data-tip="([^"]*)"><desc>([^<]*)<\/desc>.*?<\/a>/g)];
  assert.deepEqual(links.map((m) => shownWords(m[0])), ["1 Plan speed 0.59 h", "2 Ship –"], "the words it shows, spaced, name the link");
  for (const m of links) assert.equal(m[2], m[1], "the tooltip is its description");
});

test("a fork's nodes keep the trail's link markup and accessible name, and every column joins every step in the next", () => {
  const fork = readJson("tests/fixtures/maps/good.json").maps.find((m) => m.steps.some((s) => s.at));
  const readouts = Object.fromEntries(fork.steps.map((s) => [s.id, { label: s.name, value: s.id === "fix" ? 1 : null, unit: s.id === "fix" ? "on/off" : "h", kind: "speed" }]));
  const critical = new Set(fork.critical_path);
  const svg = grid(fork, readouts, critical, "intake");
  const links = [...svg.matchAll(/<a class="t-step[^"]*" href="#step-triage-(\w+)" data-step="triage-\1"[^>]* data-tip="([^"]*)"><desc>([^<]*)<\/desc>.*?<\/a>/g)];
  assert.deepEqual(links.map((m) => shownWords(m[0])), ["1 Intake speed –", "2 Fix speed on", "3 Defer speed –", "4 Close speed –"], "an on/off value reads on");
  for (const m of links) assert.equal(m[3], m[2], "the tooltip is its description");
  assert.equal((svg.match(/aria-current="step"/g) ?? []).length, 1);
  assert.equal((svg.match(/<path class="t-(main|off)"/g) ?? []).length, 4, "intake to fix and defer, each to close");
  assert.equal((svg.match(/class="t-main"/g) ?? []).length, 2, "thick where both ends are critical");
  assert.doesNotMatch(svg, /t-back|t-note/, "a fork draws no loop back");
  assert.match(svg, new RegExp(`viewBox="0 0 ${TRAIL.width} ${GRID.top + GRID.row + GRID.foot}"`), "its height fits its rows");
  const trailNode = trail({ ...fork, steps: fork.steps.map(({ at, ...s }) => s) }, readouts, critical, "intake").match(/<a class="t-step[^>]*>/)[0];
  assert.equal(svg.match(/<a class="t-step[^>]*>/)[0], trailNode, "the first step's link is the trail's");
});

test("a repo's Process page: its own maps, tabs, nav and heading, and no link to a page it does not build", () => {
  const dir = mkdtempSync(join(tmpdir(), "cos-repo-"));
  try {
    mkdirSync(join(dir, "code-os", "docs"), { recursive: true });
    for (const f of ["goals.json", "process.json", "systems.json", "tokens.json"]) cpSync(join(ROOT, f), join(dir, "code-os", "docs", f));
    mkdirSync(join(dir, "quality", "process", "data"), { recursive: true });
    const metric = "pull_requests.latest_merge_hours";
    const step = (id, extra = {}) => ({ id, name: id === "ci" ? "Cloud <CI>" : id, rule: `rule for ${id}`, rule_ref: "rules/compute.md", tools: ["a tool"], metric, ...extra });
    const maps = {
      repo_url: "https://github.com/acme/site/blob/main",
      maps: [
        { id: "delivery", name: "Delivery", why: "plan to merged", critical_path: ["plan", "push", "ci", "review", "merge"], steps: [step("plan"), step("push", { gates_from: "hooks" }), step("ci"), step("review"), step("merge"), step("learn", { rule_ref: "https://github.com/acme/site/blob/main/CLAUDE.md", rule_label: "the repo's CLAUDE.md", icon: "measure" })] },
        { id: "deploy", name: "Deploy", why: "merged to live", steps: [step("build"), step("live", { icon: "production" })] },
      ],
    };
    writeFileSync(join(dir, "quality", "process", "maps.json"), JSON.stringify(maps));
    const org = {
      generated_at: ago(1),
      own_repo: "one",
      repos: [{ name: "one", default_branch: "main" }],
      rest_calls: 40,
      graphql_calls: 6,
      errors: [],
      pipelines: { one: { detail: [{ label: "pre-push", value: null, kind: "hook", stage: "push", runs: "On every push", file: ".githooks/pre-push", pass_rate: null }], source: "s", read_at: ago(1) } },
      testing: { one: { rows: [], dispatch: [], source: "s", read_at: ago(1) } },
      metrics: { [metric]: { label: "Median hours to merge", value: 30, unit: "hours", by_repo: { one: 30 }, source: "s", read_at: ago(1), copied_from: "one" } },
    };
    writeFileSync(join(dir, "quality", "process", "data", "org.json"), JSON.stringify(org));
    const config = {
      repos: ["one"],
      docs: { goals: "code-os/docs/goals.json", process: "code-os/docs/process.json", maps: "quality/process/maps.json", systems: "code-os/docs/systems.json", tokens: "code-os/docs/tokens.json", rules: null },
      data: "quality/process/data/org.json",
      history: null,
      out: "quality/dist",
      pages: { process: "process.html" },
      tabs: ["build", "ci", "testing", "tokens"],
      heading: "one",
      collector: "code-os/tools/collect_org.mjs",
      nav: [{ href: "index.html", label: "Quality and Speed", icon: "measure" }, { page: "process", label: "Process", icon: "plan" }],
    };
    const out = build({ root: dir, now: NOW, config });
    assert.equal(out.code, 0, out.errs?.join("; "));
    assert.deepEqual(out.warnings, [], "the template's Quality page definitions read, so every id was checked");
    // A repo config that names no quality_config reads its own quality/config.json, never Git Crafter's
    // config/quality.json: here that file would leave the map's pull-requests metric off the page.
    mkdirSync(join(dir, "config"), { recursive: true });
    writeFileSync(join(dir, "config", "quality.json"), JSON.stringify({ tabs: ["code"] }));
    const notOurs = build({ root: dir, now: NOW, config });
    assert.deepEqual([notOurs.code, notOurs.warnings], [0, []], notOurs.errs?.join("; "));
    rmSync(join(dir, "config"), { recursive: true, force: true });
    assert.deepEqual([Object.keys(out.pages), out.out], [["process.html"], "quality/dist"]);
    const html = out.pages["process.html"];
    for (const tab of config.tabs) assert.match(html, new RegExp(`id="tab-${tab}"`), tab);
    assert.doesNotMatch(html, /id="tab-systems"/, "a tab the config leaves out is not drawn, even with its doc");
    assert.match(html, /<h1>one<\/h1>/);
    assert.match(html, /<title>one: Process<\/title>/);
    assert.match(html, /<span>1 repo<\/span>/);
    assert.match(html, /<a href="index.html"><span class="nl">[^]*?Quality and Speed<\/span><\/a><a href="process.html" aria-current="page">/);
    assert.doesNotMatch(html, /metrics\.html/, "no metrics page, so no link to one");
    assert.deepEqual(html.match(/<section class="map" id="map-[a-z-]+"/g), ['<section class="map" id="map-delivery"', '<section class="map" id="map-deploy"'], "one section per map, in order");
    assert.equal((html.match(/<article class="panel"/g) ?? []).length, 8);
    assert.match(html, /aria-label="Delivery: 6 steps; the critical path is the thick line"/);
    assert.match(html, /aria-label="Deploy: 2 steps; the critical path is the thick line"/);
    assert.match(html, /data-step="delivery-plan"[^>]*aria-current="step"/, "30 hours is near the template's goal (24, near 168) on every step, so the map opens on its first step near it");
    assert.match(html, /<tspan class="t-k">speed<\/tspan>/, "the step's kind keys its value");
    assert.match(html, /class="tile s-(meets|near|misses)"/, "rated by the Quality page's goal");
    assert.ok(!html.includes("Cloud <CI>"), "a step name is escaped");
    assert.match(html, /<a href="https:\/\/github.com\/acme\/site\/blob\/main\/CLAUDE.md">the repo&#39;s CLAUDE.md<\/a>/);
    assert.match(html, /<a href="https:\/\/github.com\/acme\/site\/blob\/main\/rules\/compute.md">/, "a rule_ref reads from the maps file's repo_url");
    assert.match(html, /id="step-delivery-push"[^]*?<b>one<\/b> pre-push/, "gates_from puts the repo's hooks on its push step");
    assert.match(html, /Data: <code>quality\/process\/data\/org.json<\/code>, written by <code>code-os\/tools\/collect_org.mjs<\/code>/);
    assert.match(html, /Maps: <code>quality\/process\/maps.json<\/code>/);
    // A repo that names no maps has none: never Git Crafter's.
    const none = build({ root: dir, now: NOW, config: { ...config, docs: { ...config.docs, maps: undefined } } });
    assert.equal(none.code, 0, none.errs?.join("; "));
    assert.doesNotMatch(none.pages["process.html"], /<section class="map"/);
    assert.match(none.pages["process.html"], /This repo names no process maps yet/);
    // A step whose metric is not on the repo's Quality page is a usage error naming its map and step.
    writeFileSync(join(dir, "quality", "process", "maps.json"), JSON.stringify({ ...maps, maps: [{ ...maps.maps[1], steps: [step("build", { metric: "pr.latest_merge_hours" })] }] }));
    const off = build({ root: dir, now: NOW, config });
    assert.equal(off.code, 2);
    assert.deepEqual(off.errs, ['quality/process/maps.json map "deploy", step "build": pr.latest_merge_hours is not a metric on this repo\'s Quality page']);
    assert.equal(build({ root: dir, now: NOW, config: { ...config, docs: { ...config.docs, maps: "missing.json" } } }).code, 2, "a maps file the config names must exist");
    assert.equal(build({ root: dir, now: NOW, config: { ...config, docs: { ...config.docs, process: "missing.json" } } }).code, 2, "an unreadable doc is a usage error, not a crash");
    assert.throws(() => configScope({ ...config, docs: { steps: "quality/process/steps.json" } }), /docs\.steps is gone/);
    // A targets folder the overlay refuses (an older one of full definitions):
    // the ids are still checked, against what the template's and the repo's
    // targets files name, and the steps go unrated with a warning.
    mkdirSync(join(dir, "quality", "targets"), { recursive: true });
    writeFileSync(join(dir, "quality", "targets", "ci.json"), JSON.stringify([{ id: "ci.latest_flow", tab: "actions", kind: "speed" }, { id: "site.own_count", tab: "actions", kind: "quality" }]));
    const refused = qualityDefs(dir);
    assert.equal(refused.defs, null);
    assert.match(refused.why, /ci\.json: ci\.latest_flow: overrides the template metric/);
    assert.ok(refused.ids.has("pull_requests.latest_merge_hours") && refused.ids.has("site.own_count"), "the template's ids and the repo's own");
    const own = { ...maps, maps: [{ ...maps.maps[1], steps: [step("build"), step("live", { metric: "site.own_count" })] }] };
    writeFileSync(join(dir, "quality", "process", "maps.json"), JSON.stringify(own));
    const loose = build({ root: dir, now: NOW, config });
    assert.equal(loose.code, 0, loose.errs?.join("; "));
    assert.match(loose.warnings.join(), /checked against the ids the template's and this repo's targets files name, and go unrated: could not read this repo's Quality page definitions/);
    assert.doesNotMatch(loose.pages["process.html"], /class="tile s-(meets|near|misses)"/, "unrated");
    const bad = { ...maps, maps: [{ ...maps.maps[1], steps: [step("build"), step("live", { metric: "site.not_a_metric" })] }] };
    writeFileSync(join(dir, "quality", "process", "maps.json"), JSON.stringify(bad));
    const caught = build({ root: dir, now: NOW, config });
    assert.equal(caught.code, 2);
    assert.deepEqual(caught.errs, ['quality/process/maps.json map "deploy", step "live": site.not_a_metric is not a metric on this repo\'s Quality page'], "a bad id is still a usage error with the definitions refused");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- Ideal states and the repo's own numbers ---------------------------------

test("an ideal state opens each map, Process tab and outcome that has one, held to the Quality page's rules", () => {
  const sources = [{ title: "A doc's notes", url: "https://example.org/doc", date: "2026-11-04" }];
  const good = readJson("tests/fixtures/maps/good.json");
  good.maps[0] = { ...good.maps[0], ideal: "Small changes, merged the same day.", sources };
  assert.deepEqual(checkMaps(good), []);
  const bad = structuredClone(good);
  bad.maps[0].sources = [{ ...sources[0], url: "http://example.org" }];
  bad.maps[1].ideal = "No sources.";
  assert.deepEqual(checkMaps(bad), ['maps map "delivery": sources[0]: url must be a public https link to a plain host name, with no punycode, port or credentials', `maps map "${bad.maps[1].id}": sources must list at least one document`]);
  const goalsDoc = { outcomes: [{ id: "flow", name: "Flow", means: "m", ideal: "Fast, it's.", sources, goals: [{ id: "g", metrics: ["pr.latest_merge_hours"], direction: "lower", goal: 24, near: 48, goal_source: "s", measured: "m" }] }] };
  const processDoc = { repo_url: "https://example.org", ideals: { build: { ideal: "Every step scored.", sources } } };
  assert.deepEqual(checkDocs(goalsDoc, processDoc), []);
  assert.match(checkDocs(goalsDoc, { ideals: { nope: { ideal: "x", sources } } }).join(), /no tab "nope"/);
  assert.match(checkDocs(goalsDoc, { ideals: { ci: { ideal: "x" } } }).join(), /ideals\.ci: sources must list/);
  assert.match(checkDocs({ outcomes: [{ ...goalsDoc.outcomes[0], sources: undefined }] }, {}).join(), /outcome flow: sources must list/);
  const data = { repos: [{ name: "one" }], metrics: {}, org: "o" };
  const page = renderProcess({ data, goalsDoc, processDoc, mapsDoc: good, css: "", script: "", tabs: ["build"] });
  assert.match(page, /<section class="ideal" aria-label="Ideal state: [^"]+"><h2 id="tab-build-ideal">.*Every step scored\./s);
  assert.match(page, /<h3 id="map-delivery-ideal">.*Small changes, merged the same day\..*A doc&#39;s notes.*2026-11-04/s);
  assert.doesNotMatch(page, new RegExp(`map-${good.maps[1].id}-ideal`), "a map with no ideal draws none");
  assert.match(renderMetrics({ data, goalsDoc, history: [], css: "", script: "" }), /aria-label="Ideal state: Flow"><h3 id="o-flow-ideal">Ideal state<\/h3><p>Fast, it&#39;s\.<\/p>/);
});

test("map steps read the repo's own Quality run, rated by its goal; the site's copy never stands in", () => {
  const dir = mkdtempSync(join(tmpdir(), "cos-own-"));
  try {
    mkdirSync(join(dir, "cfg", "targets"), { recursive: true });
    mkdirSync(join(dir, "out"));
    writeFileSync(join(dir, "cfg", "quality.json"), JSON.stringify({ data: "out", targets: "cfg/targets" }));
    writeFileSync(join(dir, "out", "local.json"), JSON.stringify({ metrics: { "pull_requests.fixed_after_review": { value: 10, unit: "%", source: "local", read_at: ago(1) } } }));
    writeFileSync(join(dir, "out", "latest.json"), JSON.stringify({ metrics: { "pull_requests.fixed_after_review": { value: 5, unit: "%", source: "ci", read_at: ago(1) } } }));
    const scope = { ...SCOPE, own_repo: "code-os", quality_config: "cfg/quality.json" };
    const spec = ownQuality(dir, scope);
    assert.deepEqual(spec, { repo: "code-os", root: ".", data: ["out/latest.json", "out/local.json"], targets: "cfg/targets" });
    const own = readSiteFromDisk(dir, spec, null, () => "abcdef1234");
    const m = ownSteps(own, ["pull_requests.fixed_after_review", "pull_requests.reviewed"], spec);
    const fixed = m["pull_requests.fixed_after_review"];
    assert.deepEqual([fixed.value, fixed.copied_from, typeof fixed.target?.goal], [5, "code-os", "number"], "CI's latest.json wins, rated by the template's goal");
    assert.match(fixed.source, /code-os@\w{7} out\/latest\.json or out\/local\.json/);
    assert.match(m["pull_requests.reviewed"].could_not_check, /code-os's Quality run does not measure it/);
    assert.match(ownSteps(null, ["x"], spec, "no files").x.could_not_check, /could not read code-os's Quality run: no files/);
    assert.equal(stepReadout({ metric: "pull_requests.fixed_after_review" }, m, { ownRepo: "code-os" }).value, 5);
    // A repo's config reads its own numbers with no site or own_repo named.
    const repo = configScope({ repos: ["one", "two"] });
    assert.deepEqual([repo.own_repo, repo.site, repo.quality_config], ["one", { repo: "one", root: "." }, null]);
    assert.throws(() => configScope({ repos: ["one"], own_repo: "two" }), /own_repo "two" is not one of its repos/);
    assert.equal(readJson("tests/action-config.json").site, undefined, "the action job proves the defaults: it names no site");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Git Crafter's Process page opens every tab with its ideal state", () => {
  const processDoc = readJson("process.json");
  assert.deepEqual(Object.keys(processDoc.ideals ?? {}).sort(), [...PROCESS_TABS].sort(), "one ideal per Process tab");
  assert.deepEqual(checkDocs(readJson("goals.json"), processDoc), []);
});

test("every Quality id the Process docs name reads the repo's own run; the collector's own ids stay its own", () => {
  const dir = mkdtempSync(join(tmpdir(), "cos-own-ids-"));
  try {
    mkdirSync(join(dir, "quality", "data"), { recursive: true });
    mkdirSync(join(dir, "docs"));
    for (const f of ["goals.json", "process.json", "systems.json", "tokens.json"]) cpSync(join(ROOT, f), join(dir, "docs", f));
    writeFileSync(join(dir, "quality", "data", "latest.json"), JSON.stringify({ metrics: { "credits.actions_pool_used": { value: 40, unit: "%", source: "ci", read_at: ago(1) } } }));
    const scope = configScope({ repos: ["one"], docs: { goals: "docs/goals.json", process: "docs/process.json", systems: "docs/systems.json", tokens: "docs/tokens.json", rules: null }, data: "org.json" });
    const refuse = () => { throw new Error("HTTP 403"); };
    const gh = { calls: 0, graphqlCalls: 0, rest: refuse, restLines: refuse, raw: refuse, graphql: refuse };
    const api = { errors: [], pipelines: {}, gh_calls: 0, rest_calls: 0, graphql_calls: 0, repos: [{ name: "one" }], metrics: { "pr.latest_merge_hours": { value: 3, unit: "h", source: "api" } } };
    const m = finishCollect(api, { gh, scope, root: dir }).metrics;
    assert.deepEqual([m["credits.actions_pool_used"].value, m["credits.actions_pool_used"].copied_from], [40, "one"], "the CI tab's pool reads the repo's own run");
    assert.match(m["claude.context_per_call"].could_not_check, /one's Quality run does not measure it/, "a Quality id its run lacks is not measured, never a copy");
    assert.equal(m["pr.latest_merge_hours"].value, 3, "the collector's own id stays its own");
    assert.ok(namedIds(readJson("process.json")).has("credits.actions_pool_used"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the build draws a step from the repo's own Quality run, not data/org.json's older copy", () => {
  const dir = mkdtempSync(join(tmpdir(), "cos-own-run-"));
  try {
    const metric = "pull_requests.latest_merge_hours";
    const step = (id) => ({ id, name: id, rule: `rule for ${id}`, rule_ref: "https://example.com/rule", tools: ["a tool"], metric });
    writeFileSync(join(dir, "maps.json"), JSON.stringify({ repo_url: "https://github.com/acme/one/blob/main", maps: [{ id: "flow", name: "Flow", why: "w", ideal: "i", sources: [{ title: "t", url: "https://example.com", date: "2026-11-10" }], steps: [step("merge")] }] }));
    mkdirSync(join(dir, "data"));
    mkdirSync(join(dir, "quality", "data"), { recursive: true });
    const old = { label: "Latest PR's hours to merge", value: 30, unit: "h", source: "s", read_at: ago(48), copied_from: "one" };
    writeFileSync(join(dir, "data", "org.json"), JSON.stringify({ generated_at: ago(48), own_repo: "one", org: "example-org", repos: [{ name: "one", default_branch: "main" }], errors: [], metrics: { [metric]: old } }));
    const config = { repos: ["one"], docs: { maps: "maps.json" }, history: null, tabs: ["build"], pages: { process: "process.html" } };
    const tile = (out) => out.pages["process.html"].match(/class="t-nv">.*?(?=<\/span><\/p>)/)[0];
    assert.match(tile(build({ root: dir, now: NOW, config })), /30/, "no Quality run to read: the copy stands");
    writeFileSync(join(dir, "quality", "data", "local.json"), JSON.stringify({ metrics: { [metric]: { value: 2.5, unit: "h", source: "gh api graphql", read_at: ago(1) } } }));
    const out = build({ root: dir, now: NOW, config });
    assert.equal(out.code, 0, out.errs?.join("; "));
    assert.match(tile(out), /2\.5/, "the run's newer value, with no collector re-run");
    assert.doesNotMatch(tile(out), /30/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a map's time_bar: one labelled stacked bar of its step hours, the missing step named, an unknown id an error", () => {
  const good = readJson("tests/fixtures/maps/good.json");
  good.maps[0].time_bar = "x.hours";
  const ids = new Set(["x.hours", ...good.maps.flatMap((m) => m.steps.map((s) => s.metric))]);
  assert.deepEqual(checkMaps(good, ids), []);
  assert.deepEqual(checkMaps({ ...good, maps: [{ ...good.maps[0], time_bar: "nope.hours" }] }, ids), ['maps map "delivery": time_bar "nope.hours" is not a metric on this repo\'s Quality page']);
  assert.equal(resolveMaps({ maps: [{ use: "delivery" }] }).maps[0].time_bar, undefined, "the library's Delivery map draws none");
  // The CI shape: unscored, the read steps kept in detail.
  const entry = {
    could_not_check: "not scored: session start to PR open not read",
    unit: "h",
    target: { goal: 24, near: 168, direction: "lower", unit: "h" },
    detail: [{ label: "PR open to all green", value: 0.14, unit: "h", part: 2 }, { label: "all green to merge", value: 0.02, unit: "h", part: 3 }, { label: "merge to live", value: 0.04, unit: "h", part: 4 }],
    missing: [{ label: "session start to PR open", reason: "transcripts live on the machine that ran the sessions" }],
    source: "s",
    read_at: readAt,
  };
  const draw = (metrics) => renderProcess({ data: { repos: [{ name: "one" }], metrics, org: "o" }, goalsDoc: { outcomes: [] }, processDoc: { repo_url: "https://example.org" }, mapsDoc: good, css: "", script: "", tabs: ["build"] });
  const fig = /<figure class="time-bar" id="time-delivery">.*?<\/figure>/s.exec(draw({ "x.hours": entry }))?.[0] ?? "";
  assert.match(fig, /<\/span> not scored, goal ≤ 24 h<\/figcaption><span class="pbar lab" role="img" aria-label="PR open to all green 70%/, "no status mark, the bar and its text alternative still drawn");
  assert.doesNotMatch(fig, /<svg class="g"/);
  const full = /<figure class="time-bar".*?<\/figcaption>/s.exec(draw({ "x.hours": { ...entry, could_not_check: undefined, value: 6.91 } }))?.[0] ?? "";
  assert.match(full, /aria-label="meets goal".*6\.91 h, goal ≤ 24 h/s, "the full total scores");
  assert.equal((fig.match(/<b>/g) ?? []).length, 3, "each GitHub step labelled on the bar");
  assert.match(fig, /<i class="p4"><\/i><b>merge to live 0\.04 h<\/b>/, "a step keeps its color when the session step is missing");
  assert.match(fig, /<li>session start to PR open: not read here; transcripts live on the machine/);
  assert.match(draw({}), /<figure class="time-bar" id="time-delivery">.*?<p class="reason">not measured<\/p><\/figure>/s, "no entry: said, never a zero bar");
});

test("a map step's trend line: drawn from 2 daily Quality history points, nothing with fewer", () => {
  const good = readJson("tests/fixtures/maps/good.json");
  const id = good.maps[0].steps[0].metric;
  const run = (day, value) => ({ generated_at: `${day}T12:00:00.000Z`, mode: "ci", metrics: { [id]: { value, unit: "h" } } });
  const draw = (history) => renderProcess({ data: { repos: [{ name: "one" }], metrics: { [id]: { value: 3, unit: "h", source: "s", read_at: readAt } }, org: "o" }, goalsDoc: { outcomes: [] }, processDoc: { repo_url: "https://example.org" }, mapsDoc: good, history, css: "", script: "", tabs: ["build"] });
  const trends = (html) => html.match(/<figure class="t-trend".*?<\/figure>/gs) ?? [];
  assert.deepEqual(trends(draw([])), [], "no history: no line");
  assert.deepEqual(trends(draw([run("2026-11-10", 5)])), [], "one point: no line");
  assert.deepEqual(trends(draw([run("2026-11-10", 5), { ...run("2026-11-10", 9), generated_at: "2026-11-10T08:00:00.000Z" }])), [], "two reads on one day are one point");
  const two = trends(draw([run("2026-11-10", 5), run("2026-11-11", 3), { generated_at: "2026-11-12T12:00:00.000Z", metrics: { [id]: { could_not_check: "x" } } }]));
  const uses = good.maps.flatMap((m) => m.steps).filter((s) => s.metric === id).length;
  assert.equal(two.length, uses, "only the steps whose metric has 2 points, on every map that uses it");
  assert.match(two[0], /<svg class="spark"[^>]*aria-label="[^"]*2026-11-10 5 h, 2026-11-11 3 h"/, "one point a day, an unread day skipped");
  assert.match(two[0], /data-tip="2026-11-10 5 h; 2026-11-11 3 h"/);
  assert.match(two[0], /2 days, 2026-11-10 to 2026-11-11/);
});
