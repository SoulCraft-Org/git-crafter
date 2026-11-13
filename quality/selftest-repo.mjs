// The Quality selftest's checks that build a seeded repo end to end.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildPage, readInputs, render } from "./build.mjs";
import { collectorFiles, runCollectors, runRecord } from "./collect.mjs";
import { loadConfig, resolveTabs } from "./config.mjs";
import { master } from "./render/model.mjs";
import { checkDef, checkIdeal, DEFAULT_TABS, isMeasured, loadDefs, loadIdeals, loadTargets, mergeMetrics, overlayTargets, scoreTab, TABS, tabGaps, WEB_TABS } from "./score.mjs";
import { at, check, down, seedRepo, shown, up, val, writeTargets, blind } from "./selftest-lib.mjs";

check("a missing value never scores 0, from the collector's return to the master score", async () => {
  const { base, template, root } = seedRepo();
  try {
    const config = loadConfig({ root, env: {} });
    const loaded = loadDefs({ templateDir: join(template, "targets"), repoDir: config.targets, tabs: config.tabs });
    const run = await runCollectors({ root, mode: "ci", dirs: [join(template, "collectors"), config.collectors], defs: loaded.defs, all: loaded.all, params: loaded.params });
    assert.deepEqual(run.ran.sort(), ["own", "seed"], "the repo's collector runs beside the template's");
    mkdirSync(config.data, { recursive: true });
    writeFileSync(join(config.data, "latest.json"), JSON.stringify({ generated_at: "2026-11-03T12:00:00Z", commit: "abc1234", mode: "ci", metrics: run.metrics }));
    const page = buildPage(config, { template, now: new Date("2026-11-03T12:00:00Z") });
    assert.equal(page.code, 0);
    const html = page.html;
    const code = /<section id="code"[\s\S]*?<\/section>\n<section id="/.exec(html)[0];
    scoresOf(code, html, page, run);
    echoOf(run, config, html);
    idealOf(code, html);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

check("ideal files: a summary and dated https sources, no other key; a tab gap is named", () => {
  const src = { title: "A guide", url: "https://example.org/x", date: "2026-11-03" };
  const ok = { ideal: "One sentence.", sources: [src] };
  checkIdeal(ok, "ok");
  assert.throws(() => checkIdeal({ ideal: "x" }), /sources must list at least one/);
  assert.throws(() => checkIdeal({ ...ok, sources: [] }), /sources must list at least one/);
  assert.throws(() => checkIdeal({ ...ok, sources: [{ ...src, url: "http://example.org" }] }), /url must be a public https link/);
  assert.throws(() => checkIdeal({ ...ok, sources: [{ title: src.title, url: src.url }] }), /date must be YYYY-MM-DD/);
  assert.throws(() => checkIdeal({ ...ok, sources: [{ ...src, date: "2026-02-30" }] }), /date must be YYYY-MM-DD/);
  assert.throws(() => checkIdeal({ ...ok, sources: [{ ...src, date: "2026-13-01" }] }), /date must be YYYY-MM-DD/, "an impossible month gets the field's message, not a RangeError");
  assert.throws(() => checkIdeal({ ...ok, sources: [{ ...src, title: "" }] }), /title must be text/);
  assert.throws(() => checkIdeal({ ...ok, sources: [{ ...src, note: "x" }] }), /unknown key note/);
  assert.throws(() => checkIdeal({ ...ok, source: src.url }), /unknown key source/);
  assert.throws(() => checkIdeal({ sources: ok.sources }), /ideal is required/);
  // Parts: optional rows of part, ideal and setup, each plain words within its limits.
  const part = { part: "Labels", ideal: "Area labels only.", setup: "Archive what nothing uses." };
  checkIdeal({ ...ok, parts: [part] }, "ok");
  assert.throws(() => checkIdeal({ ...ok, parts: [] }), /parts must list 1 to 8 rows/);
  assert.throws(() => checkIdeal({ ...ok, parts: Array(9).fill(part) }), /parts must list 1 to 8 rows/);
  assert.throws(() => checkIdeal({ ...ok, parts: [{ ...part, note: "x" }] }), /parts\[0\]: unknown key note/);
  assert.throws(() => checkIdeal({ ...ok, parts: [{ part: "Labels", ideal: "x" }] }), /parts\[0\]: setup must be text/);
  assert.throws(() => checkIdeal({ ...ok, parts: [{ ...part, setup: "Set blank_issues_enabled" }] }), /setup must be plain words/);
  assert.throws(() => checkIdeal({ ...ok, parts: [{ ...part, ideal: "word ".repeat(26).trim() }] }), /ideal must be at most 25 words/);
  idealWords(ok);
  idealPlain(ok, src);
  const dir = mkdtempSync(join(tmpdir(), "quality-ideals-"));
  try {
    writeFileSync(join(dir, "wiki.json"), JSON.stringify(ok));
    assert.throws(() => loadIdeals({ templateDir: dir }), /no tab "wiki"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const gaps = tabGaps([["code", "Code"]], [up, down], {});
  assert.deepEqual(gaps, [{ tab: "code", missing: "ideal" }, { tab: "code", missing: "consumption" }]);
  assert.throws(() => loadTargets(writeTargets([{ ...up, goal_source: " " }])), /goal_source must say/);
  const { goal, ...noGoal } = up;
  assert.throws(() => loadTargets(writeTargets([noGoal])), /goal and near must be numbers/);
});

// What a run file holds, and how an older one reads (Git Crafter issue #115).
check("a run file holds only current ids, each blank with its reason; an older file builds clean", async () => {
  const { base, template, root } = seedRepo();
  try {
    const config = loadConfig({ root, env: {} });
    const loaded = loadDefs({ templateDir: join(template, "targets"), repoDir: config.targets, tabs: config.tabs });
    const got = await runCollectors({ root, mode: "local", dirs: [join(template, "collectors"), config.collectors], defs: loaded.defs, all: loaded.all, params: loaded.params });
    // The seed collector returns s.dropme (dropped by the repo) and s.echo
    // (on Design, a tab the repo hides); a collector may also return a blank.
    got.metrics["s.cut"] = { value: 3, source: "a metric the template cut" };
    got.metrics["s.bad"] = { value: null, source: "seed" };
    got.metrics["s.fast"] = { value: 40, could_not_check: "", source: "seed" };
    const run = runRecord({ metrics: got.metrics, ran: got.ran, mode: "local", defs: loaded.defs, commit: "abc1234", now: new Date("2026-11-04T12:00:00Z") });
    assert.deepEqual(Object.keys(run.metrics), loaded.defs.map((d) => d.id), "one entry per current definition, in order");
    // Each entry records its definition's unit (Git Crafter issue #146), so a
    // trend never charts reads in an old unit against the new one.
    for (const def of loaded.defs) assert.equal(run.metrics[def.id].unit, def.unit ?? "", `${def.id} was written without its unit`);
    for (const id of ["s.dropme", "s.echo", "s.cut"]) assert.ok(!(id in run.metrics), `${id} was written`);
    assert.equal(run.metrics["s.blind"].could_not_check, "the seed has no tool for this", "a collector's reason is kept");
    assert.match(run.metrics["s.bad"].could_not_check, /no value and no reason/, "a blank gets a reason");
    assert.ok(run.metrics["s.bad"].weak, "a reason written for a blank is weak");
    assert.equal(run.metrics["s.fast"].could_not_check, "the collector returned an empty reason", "a value with an empty reason is not called no value");
    assert.ok(run.metrics["s.silent"].weak && run.metrics["s.silent"].could_not_check === "No collector reported this metric.", "an id nobody returned reads as the page's own sentence");
    for (const [id, e] of Object.entries(run.metrics)) assert.ok(isMeasured(e) || (typeof e.could_not_check === "string" && e.could_not_check.trim()), `${id} is a bare blank`);
    placeholdersLose(run);
    // An older history file still holds a dropped id, a cut id and a blank:
    // the page builds, never shows them, and the file stays as written.
    mkdirSync(config.data, { recursive: true });
    mkdirSync(config.history, { recursive: true });
    writeFileSync(join(config.data, "latest.json"), JSON.stringify(run));
    const old = { generated_at: "2026-11-03T12:00:00Z", commit: "0ld0000", mode: "local", metrics: { "s.good": { value: 80, read_at: "2026-11-03T12:00:00Z", source: "seed" }, "s.dropme": { value: 1, source: "seed" }, "s.cut": { value: 9, source: "seed" }, "s.bad": { source: "seed" } } };
    const oldFile = join(config.history, "2026-11-03.json");
    writeFileSync(oldFile, JSON.stringify(old));
    const page = buildPage(config, { template, now: new Date("2026-11-04T12:00:00Z") });
    assert.equal(page.code, 0);
    const inputs = readInputs(config, { template });
    assert.ok(!("s.dropme" in inputs.history[0].metrics) && !("s.cut" in inputs.history[0].metrics), "a dropped or cut id reached the page");
    assert.match(inputs.history[0].metrics["s.bad"].could_not_check, /no value and no reason/);
    assert.ok(!page.html.includes("m-s.dropme") && !page.html.includes("m-s.cut"), "the page drew a row for a dropped or cut id");
    assert.deepEqual(JSON.parse(readFileSync(oldFile, "utf8")), old, "the older file was rewritten");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

check("a week-by-week line drops reads measured before a redefinition, and says so", () => {
  const def = { id: "t.wait", tab: "code", kind: "speed", label: "Wait", unit: "s", goal: 1, near: 2, direction: "lower", goal_source: "fixture" };
  const at = (d, v, unit) => ({ generated_at: `${d}T12:00:00Z`, metrics: { "t.wait": { value: v, unit, read_at: `${d}T12:00:00Z`, source: "fixture" } } });
  const history = [at("2026-10-27", 900, "ms"), at("2026-11-03", 0.9, "s"), at("2026-11-10", 0.8, "s")];
  const html = render({ defs: [{ ...def, tab: "blockers" }], metrics: { "t.wait": val(0.8) }, history, tabs: [...DEFAULT_TABS, ["blockers", "Blockers"]] });
  const row = /<details class="metric[^"]*" id="m-t\.wait">[\s\S]*?<\/details>/.exec(html)[0];
  assert.ok(row.includes("Week by week; 1 older read left out, measured before the metric was redefined"), "the note");
  assert.ok(row.includes('aria-label="Wait, week by week: 2026-11-02 0.9 s, 2026-11-09 0.8 s"'), "only the two reads in seconds are drawn");
  assert.equal(/<polyline points="([^"]*)"/.exec(row)[1].split(" ").length, 2, "the line has two points, not three");
  for (const day of ["2026-02-30", "2026-13-01"]) assert.throws(() => checkDef({ ...def, defined: day }, "t"), /defined must be a real day/, day);
  assert.throws(() => checkDef({ ...def, defined: "2999-01-01" }, "t"), /defined is after today/);
  checkDef({ ...def, defined: new Date().toISOString().slice(0, 10) }, "t");
});

check("a repo's overrides take only goal, near, goal_source, params, drop and gate", () => {
  const template = [{ file: "a.json", list: [{ ...up }] }];
  assert.throws(() => overlayTargets(template, [{ file: "a.json", list: [{ id: "t.up", label: "Renamed" }] }]), /takes only goal, near, goal_source, params, drop, gate, not label/);
  assert.throws(() => overlayTargets(template, [{ file: "a.json", list: [{ id: "t.up", drop: false }] }]), /drop must be true/);
  // A repo's goal keeps no template evidence: it brings its own goal_source.
  assert.throws(() => overlayTargets(template, [{ file: "a.json", list: [{ id: "t.up", goal: 50, near: 30 }] }]), /own goal_source/);
  assert.throws(() => overlayTargets(template, [{ file: "a.json", list: [{ id: "t.up", near: 30, goal_source: " " }] }]), /own goal_source/);
  const moved = overlayTargets(template, [{ file: "a.json", list: [{ id: "t.up", goal: 50, near: 30, goal_source: "the repo's" }] }]).entries[0];
  assert.deepEqual([moved.goal, moved.near, moved.goal_source], [50, 30, "the repo's"]);
  // A repo may gate a template metric: a miss then fails its pull request.
  assert.equal(overlayTargets([{ file: "a.json", list: [{ ...up }] }], [{ file: "a.json", list: [{ id: "t.up", gate: true }] }]).entries[0].gate, true);
  // An override with no template metric under it names the id.
  assert.throws(() => overlayTargets(template, [{ file: "a.json", list: [{ id: "t.gone", goal: 1, near: 2, goal_source: "x" }] }]), /no template metric "t\.gone" to override/);
  assert.throws(() => overlayTargets(template, [{ file: "a.json", list: [{ id: "t.gone", drop: true }] }]), /no template metric "t\.gone"/);
  const dir = mkdtempSync(join(tmpdir(), "quality-overlay-"));
  try {
    mkdirSync(join(dir, "t"));
    mkdirSync(join(dir, "r"));
    writeFileSync(join(dir, "t", "a.json"), JSON.stringify([up]));
    writeFileSync(join(dir, "r", "a.json"), JSON.stringify([{ id: "t.up", goal: 50, goal_source: "the repo's" }]));
    assert.throws(() => loadDefs({ templateDir: join(dir, "t"), repoDir: join(dir, "r") }), /a\.json over the template's a\.json: t\.up: near must be on the worse side/);
    writeFileSync(join(dir, "r", "a.json"), JSON.stringify([{ id: "r.half", tab: "code", goal: 1 }]));
    assert.throws(() => loadDefs({ templateDir: join(dir, "t"), repoDir: join(dir, "r") }), /kind must be/, "a repo's own metric is a full definition");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check("a repo's config: tabs, web tabs, unknown keys, collector names", () => {
  assert.deepEqual(resolveTabs({}).map(([id]) => id), TABS.map(([id]) => id).filter((id) => !WEB_TABS.includes(id)));
  assert.deepEqual(resolveTabs({ web: true }), TABS);
  assert.deepEqual(resolveTabs({ tabs: ["code", ["evals", "Evals"]] }), [["code", "Code"], ["evals", "Evals"]]);
  assert.throws(() => resolveTabs({ tabs: ["claude"] }), /unknown tab "claude"/, "the Claude tabs load only from a pack");
  assert.throws(() => resolveTabs({ tabs: ["wiki"] }), /unknown tab "wiki"/);
  assert.throws(() => resolveTabs({ tabs: ["code", "code"] }), /listed twice/);
  const dir = mkdtempSync(join(tmpdir(), "quality-config-"));
  try {
    writeFileSync(join(dir, "c.json"), JSON.stringify({ tabz: [] }));
    assert.throws(() => loadConfig({ root: dir, file: "c.json" }), /unknown config key tabz/);
    writeFileSync(join(dir, "c.json"), JSON.stringify({ comment: "fine", budget: 5 }));
    const c = loadConfig({ root: dir, file: "c.json", env: { GITHUB_REPOSITORY: "o/r" } });
    assert.deepEqual([c.repo, c.name, c.budget, c.repoUrl], ["o/r", "r", 5, "https://github.com/o/r"]);
    assert.ok(existsSync(c.tokens_css), "the template's tokens are the default");
    for (const d of ["a", "b"]) {
      mkdirSync(join(dir, d));
      writeFileSync(join(dir, d, "same.mjs"), "export async function collect() { return {}; }\n");
    }
    assert.throws(() => collectorFiles([join(dir, "a"), join(dir, "b")]), /same\.mjs is in both/);
    assert.equal(collectorFiles([join(dir, "a"), join(dir, "a")]).length, 1, "one folder named twice runs once");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The template's own files, as the collector sessions land them: a tab with
// any target or ideal must have both, and a metric in every category.
check("every tab the template fills has an ideal and all three categories", () => {
  const dir = fileURLToPath(new URL("./targets/", import.meta.url));
  const ideals = loadIdeals({ templateDir: fileURLToPath(new URL("./ideals/", import.meta.url)) });
  const { all } = loadDefs({ templateDir: dir, tabs: TABS });
  const filled = TABS.filter(([id]) => ideals[id] || all.some((d) => d.tab === id));
  // The new tabs' ideals, and Scanning's speed metric, land later in this stack.
  const known = [["dependabot", "ideal"], ["scanning", "ideal"], ["scanning", "speed"], ["pages", "ideal"]].map(([tab, missing]) => ({ tab, missing }));
  assert.deepEqual(tabGaps(filled, all.filter((d) => d.drop !== true), ideals), known, "a filled tab lacks its ideal or a category");
  for (const d of all) assert.ok(!/\/Users\/|\/home\/[a-z]/.test(JSON.stringify(d.params ?? {})), `${d.id}: a home path in the template's params`);
  assert.ok(readFileSync(new URL("./render/client.js", import.meta.url), "utf8").includes("dataset.repo"), "the client reads the repo from the page");
});

// What the built page shows for the seeded repo: its scores, the collector's
// view of the repo, and its ideal.
function scoresOf(code, html, page, run) {
    // Quality: Good meets (100), Bad misses (0); Blind (could_not_check) and
    // Never reported (no entry) are left out. Scored as 0 they would make 25.
    assert.ok(code.includes("<p class=\"sb-l\">Quality</p><p class=\"sb-n\">") && /Quality<\/p><p class="sb-n">.*?50<\/p>/.test(code), "Code's quality is the mean of the two measured, 50");
    assert.ok(code.includes("2 of 4 measured"), "4 quality metrics, 2 measured; the dropped one is gone");
    assert.ok(!code.includes("Dropped by the repo"), "drop: true removes the metric");
    // The page's own numbers, recomputed: a third each over the categories
    // scored. Quality 50, speed 75 (Fast near its repo goal, 50; the repo's
    // own meets, 100) make 62.5, shown as 63. Missing as 0 would be 50.
    const results = ["code"].map((tab) => scoreTab(tab, page.defs, run.metrics));
    assert.equal(master(results).score, 63, "the master score counts only what was measured");
    assert.ok(html.includes('<p class="big">') && /Master score<\/p><p class="big">.*?63<span/.test(html), "the page shows the master score 63");
    // The repo's override moved Fast's goal: 40 s meets the template's 60 but
    // is near the repo's 30 (near 45).
    assert.ok(/<details class="metric s-near" id="m-s\.fast">/.test(code), "the repo's goal scores Fast");
    assert.ok(code.includes("the repo&#39;s own goal"), "the repo's goal_source shows");
}

function echoOf(run, config, html) {
    // The collector got the repo, the mode, its file's params (the template's,
    // then the repo's, key by key) and its active targets.
    const echo = JSON.parse(run.metrics["s.echo"].source);
    assert.deepEqual(echo.params, { path: "repo", keep: 1 });
    // Every file's params by name, the repo's own file's included, as the
    // engine merged them.
    assert.deepEqual(echo.allParams, { "seed.json": { path: "repo", keep: 1 }, "own.json": { reviewer: "a-bot" } });
    assert.deepEqual([echo.root, echo.mode], [config.root, "ci"]);
    assert.ok(!echo.targets.includes("s.dropme") && !echo.targets.includes("s.web") && echo.targets.includes("s.fast"), "targets are the active ones");
    // Web tabs are off by default; the repo's links and name frame the page.
    assert.ok(!html.includes('<section id="pages"'), "a web tab showed with no config");
    assert.ok(html.includes("<title>Quality, Speed and Consumption: seed</title>") && html.includes('href="https://github.com/example/seed/commit/abc1234"'), "the repo's name and link");
}

function idealOf(code, html) {
    // The repo's ideal replaces the template's and opens the tab, above its
    // three sections; a category with no metric says so.
    const ideal = code.indexOf('<section class="ideal"');
    assert.ok(ideal > 0 && code.includes("The repo&#39;s own ideal for its code.") && !code.includes("Code a newcomer"), "the repo's ideal opens the tab");
    assert.ok(ideal < code.indexOf('id="code-quality"') && code.indexOf('id="code-quality"') < code.indexOf('id="code-speed"') && code.indexOf('id="code-speed"') < code.indexOf('id="code-consumption"'), "ideal, then Quality, Speed, Consumption");
    assert.ok(code.includes('<p class="aim">Every change ships with its test.</p>') && code.includes("No consumption metric yet."), "each section's aim, and an empty one says so");
    assert.ok(code.includes('<details class="refs-fold"><summary>2 sources, newest 2026-10-01</summary><ol class="refs"><li><a href="https://example.org/repo-ideal">Newest guide&#39;s notes</a> <span class="small">2026-10-01</span></li><li><a href="https://example.org/older">Older guide</a> <span class="small">2025-06-30</span></li></ol></details>'), "the sources, folded, numbered, title as link, date beside it");
    assert.ok(code.indexOf('<ol class="refs">') < code.indexOf('id="code-quality"'), "the sources sit under the summary, above the sections");
    assert.ok(/<section id="actions"[\s\S]*?No ideal state written for this tab yet\./.test(html), "a tab with no ideal says so");
    assert.ok(!/NaN|undefined|Infinity/.test(shown(html)), "NaN, undefined or Infinity on the page");
}

// Ideal text rules: length in words, then plain words and public links.
function idealWords(ok) {
  assert.throws(() => checkIdeal({ ...ok, ideal: "x".repeat(301) }), /1 to 300/);
  const words = (n) => Array.from({ length: n }, () => "word").join(" ");
  checkIdeal({ ...ok, ideal: words(25), quality: words(25) }, "25 words");
  assert.throws(() => checkIdeal({ ...ok, ideal: words(26) }), /ideal must be at most 25 words, and has 26/);
  assert.throws(() => checkIdeal({ ...ok, consumption: words(26) }), /consumption must be at most 25 words/);
  assert.throws(() => checkIdeal({ ...ok, ideal: Array(13).fill("x".repeat(21)).join(" ") }), /at most 25 words, and has 26/, "a run of 21 letters counts as two words");
  checkIdeal({ ...ok, ideal: `${words(25)} 10 000 80% 2026` }, "numbers are free");
  assert.throws(() => checkIdeal({ ...ok, speed: "" }), /speed must be text/);
  assert.throws(() => checkIdeal({ ...ok, best: "y" }), /unknown key best/);
}

function idealPlain(ok, src) {
  // Plain words and public links, as a publish guard's validateIdeal takes them.
  checkIdeal({ ...ok, ideal: "Die\u0301 Re\u0301sume\u0301 is decomposed." }, "an accent after a letter");
  checkIdeal({ ...ok, ideal: "Diátaxis docs: 80% covered, (mostly) done; why? Fix it now! A/B, C+D, it's fine." }, "plain");
  for (const bad of ["Bold <b>this</b>", "Fish &amp; chips", "A \u2014 B", "A \u2013 B", 'A "quoted" word', " Leading space", "123 456", "Line\nbreak", "\u3164\u3164 \u3164", "A\uFE0F word", "A\u20DD word", "\u0301x word", "A\u034F word", "No\u00A0break"]) {
    assert.throws(() => checkIdeal({ ...ok, ideal: bad }), /ideal must be plain words/, bad);
  }
  assert.throws(() => checkIdeal({ ...ok, quality: "Fast \u2014 always" }), /quality must be plain words/);
  assert.throws(() => checkIdeal({ ...ok, sources: [{ ...src, title: "A <i>guide</i>" }] }), /title must be plain words/);
  for (const url of ["https://xn--e1afmkfd.xn--p1ai/x", "https://example.org:8443/x", "https://user:pass@example.org/x", "https://user@example.org/x", "https://localhost/x", "https://example.org/a b", "https://example.org/<x>", "https://1.2.3.4/x", "https://-bad.example.org/x"]) {
    assert.throws(() => checkIdeal({ ...ok, sources: [{ ...src, url }] }), /url must be a public https link/, url);
  }
  for (const url of ["https://example.org", "https://docs.github.com/en/actions?tool=cli#section-2", "https://EXAMPLE.org/Path_%20x"]) checkIdeal({ ...ok, sources: [{ ...src, url }] }, url);
}

function placeholdersLose(run) {
  // A collector's own reason beats every placeholder when the CI and local
  // runs merge, a file written before the weak mark (unreported) included.
  for (const placeholder of [run.metrics["s.silent"], run.metrics["s.bad"], run.metrics["s.fast"], { could_not_check: "no collector returned this metric", unreported: true }]) {
    const merged = mergeMetrics({ metrics: { x: placeholder } }, { metrics: { x: { could_not_check: "needs a login", source: "ci" } } });
    assert.equal(merged.x.could_not_check, "needs a login", `${placeholder.could_not_check} hid a real reason`);
  }
  const kept = mergeMetrics({ metrics: { x: { could_not_check: "rate limited", source: "local" } } }, { metrics: { x: run.metrics["s.silent"] } });
  assert.equal(kept.x.could_not_check, "rate limited", "a placeholder replaced a real reason");
}
