// The Quality selftest's checks that render the page from fixture metrics.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PAGE_BUDGET, render, sizeCheck } from "./build.mjs";
import { DEFAULT_TABS, TABS } from "./score.mjs";
import { check, down, shown, up, val, blind } from "./selftest-lib.mjs";

check("the page renders every tab and escapes collector, target and review text", () => {
  const hostile = "<script>alert(1)</script>";
  // Every text field a target or a collector supplies, hostile at once.
  const h = (def) => ({ ...def, label: `${def.label} ${hostile}`, means: hostile, group: hostile, goal_source: hostile, source: hostile });
  const html = render({
    tabs: TABS,
    defs: [up, blind, down].map(h),
    metrics: { "t.up": val(95, { source: hostile, detail: [{ label: hostile, value: 3 }] }), "t.blind": { could_not_check: hostile, source: hostile }, "t.down": val(200, { source: hostile }) },
    reviews: { code: { file: "code.yaml", date: "2026-11-02", score: 50, items: [{ page: hostile, criterion: "c", score: 3, finding: "f", fix: "x", tracking: 7 }] } },
    meta: { commit: "abc1234def", builtAt: "2026-11-02 20:00 UTC", repoUrl: "https://github.com/example/repo" },
  });
  for (const [id] of TABS) assert.ok(html.includes(`<section id="${id}"`), `missing tab ${id}`);
  assert.ok(html.includes('<section id="overview"'), "missing the overview");
  assert.equal((html.match(/<a class="massif" href="#[\w-]+"/g) ?? []).length, TABS.length, "the range links each tab");
  assert.ok(!html.includes(hostile), "unescaped collector or review text");
  assert.ok(!/NaN|undefined|Infinity/.test(shown(html)), "NaN, undefined or Infinity on the page");
  assert.ok(html.includes("/issues/7"), "review tracking link");
  // Accessible names lead with the visible label (WCAG 2.5.3).
  assert.ok(/<a href="#overview" aria-label="Overview [\d–]+ [\d–]+\. Overview: quality/.test(html), "the Overview link's name starts with its visible text");
  assert.ok(/aria-label="Docs [\d–]+ [\d–]+\. Docs \(Documentation\): quality/.test(html), "a short nav label leads its name");
  assert.ok(/<button class="cell k3" data-b="3" aria-label="3: /.test(html), "a heatmap cell's name leads with its score");
});

check("a hostile </script> in a finding stays inside the embedded JSON", () => {
  const hostile = "</script><script>alert(1)</script><!--";
  const html = render({
    tabs: TABS,
    defs: [up],
    metrics: { "t.up": val(95) },
    reviews: { design: { file: "design.yaml", date: "2026-11-02", score: 50, items: [{ page: "/", width: 1280, criterion: "typography", score: 3, finding: hostile, fix: "<b>x</b>", tracking: null }] } },
  });
  assert.ok(!html.includes("</script><script>alert"), "the finding closed the script element");
  const json = /<script type="application\/json" class="rv-data">([\s\S]*?)<\/script>/.exec(html)[1];
  assert.ok(!json.includes("<"), "a raw < inside the JSON");
  const data = JSON.parse(json);
  assert.equal(data.i[0][6], hostile, "the finding round-trips through JSON.parse");
});

check("bullet zones: goal 0 ticks at 0, higher and lower both draw", () => {
  const zero = { id: "t.zero", tab: "code", kind: "quality", label: "Dead files", unit: "files", goal: 0, near: 3, direction: "lower" };
  const html = render({ defs: [zero, up], metrics: { "t.zero": val(0), "t.up": val(80) } });
  const zeroRow = /<details class="metric s-meets" id="m-t\.zero">[\s\S]*?<\/summary>/.exec(html)[0];
  assert.ok(zeroRow.includes('class="bl lo" style="--a:0%;--b:80%;--g:0%;--v:0%"'), "goal 0: no meets zone, tick and value at 0");
  assert.ok(!/:-/.test(zeroRow), "a negative position");
  const upRow = /<details class="metric s-near" id="m-t\.up">[\s\S]*?<\/summary>/.exec(html)[0];
  assert.ok(upRow.includes('class="bl hi" style="--a:70%;--b:90%;--g:90%;--v:80%"'), "higher zones run misses, near, meets");
});

check("the 1,000 KB page budget blocks one byte over, counted in UTF-8", () => {
  assert.equal(PAGE_BUDGET, 1_000_000);
  assert.deepEqual(sizeCheck("a".repeat(PAGE_BUDGET)), { bytes: PAGE_BUDGET, ok: true });
  assert.equal(sizeCheck("a".repeat(PAGE_BUDGET + 1)).ok, false);
  assert.equal(sizeCheck("é".repeat(PAGE_BUDGET / 2 + 1)).ok, false, "two bytes a character, not one");
});

check("the contract fields render: means, group, funnel, stack, partial", () => {
  const base = { tab: "claude", kind: "speed", unit: "PRs", goal: 10, near: 5, direction: "higher" };
  const defs = [
    { ...base, id: "c.funnel", label: "PR path", chart: "funnel", means: "Pull requests from session to merge", group: "Flow" },
    { ...base, id: "c.stack", label: "Token mix", unit: "tokens", chart: "stack", group: "Tokens" },
    { ...base, id: "c.week", label: "Merged PRs per week", chart: "spark", group: "Flow" },
  ];
  const html = render({
    defs,
    metrics: {
      "c.funnel": val(133, { detail: [{ label: "opened", value: 148 }, { label: "merged", value: 133 }] }),
      "c.stack": val(100, { detail: [{ label: "input", value: 25 }, { label: "output", value: 75 }] }),
      "c.week": val(9, { detail: [{ label: "2026-10-19", value: 4 }, { label: "2026-10-26", value: 12 }, { label: "2026-11-02", value: 9, partial: true }] }),
    },
  });
  assert.ok(html.includes('<p class="means">Pull requests from session to merge</p>'), "means");
  assert.equal((html.match(/<h4>Flow</g) ?? []).length, 1, "a group heads its rows once");
  assert.ok(html.includes("<h4>Tokens<"), "second group");
  assert.ok(html.includes('class="bars funnel"') && html.includes('<td class="num share">90%</td>'), "funnel with share of the first stage");
  assert.ok(html.includes('class="pbar"') && html.includes('<td class="num share">75%</td>'), "stack with shares");
  assert.ok(html.includes('class="dot hollow"') && html.includes("2026-11-02 so far"), "partial last point");
  assert.ok(!/NaN|undefined|Infinity/.test(shown(html)), "NaN, undefined or Infinity on the page");
});

check("a flow metric draws full width above its tab's rows and keeps its row", () => {
  const flow = { id: "t.flow", tab: "code", kind: "speed", label: "How CI runs", unit: "min", goal: 10, near: 15, direction: "lower", chart: "flow" };
  const stages = [
    { label: "pre-commit", value: 0.2, unit: "min", stage: "commit", kind: "hook", runs: "content lint", file: ".githooks/pre-commit", pass_rate: 99 },
    { label: "site-tests", value: 4.1, unit: "min", stage: "ci", kind: "workflow", runs: "vitest", file: ".github/workflows/site-tests.yml", pass_rate: 96 },
  ];
  const html = render({ defs: [flow, up], metrics: { "t.flow": val(4.3, { detail: stages }), "t.up": val(95) } });
  const code = /<section id="code"[\s\S]*?<\/section>\n<section id="/.exec(html)[0];
  const at = code.indexOf('<section class="flow" aria-labelledby="flow-t.flow">');
  assert.ok(at > 0, "no flow figure");
  assert.ok(at < code.indexOf('class="chips"'), "the flow is not above the metric rows");
  assert.ok(code.includes('id="m-t.flow"'), "the flow metric lost its row");
  assert.ok(code.includes("site-tests"), "a stage is missing from the drawing");
  assert.ok(!/NaN|undefined|Infinity/.test(shown(html)), "NaN, undefined or Infinity on the page");
});

check("a ledger metric draws its blockers full width above its tab's rows and keeps its row", () => {
  const def = { id: "t.ledger", tab: "code", kind: "quality", label: "Blockers that cost", unit: "blockers", goal: 0, near: 3, direction: "lower", chart: "ledger" };
  const rows = [{ label: "guard: some-rule", group: "Speed", fires: 2, false_alarm: 50, hours: 0.1, tokens: 900, verdict: "costs" }];
  const html = render({ defs: [def, up], metrics: { "t.ledger": val(1, { detail: rows }), "t.up": val(95) } });
  const code = /<section id="code"[\s\S]*?<\/section>\n<section id="/.exec(html)[0];
  const at = code.indexOf('<section class="flow ledger" aria-labelledby="flow-t.ledger">');
  assert.ok(at > 0, "no ledger figure");
  assert.ok(at < code.indexOf('class="chips"'), "the ledger is not above the metric rows");
  assert.ok(code.includes('id="m-t.ledger"'), "the ledger metric lost its row");
  assert.ok(code.includes("guard: some-rule") && code.includes("costs"), "a blocker row is missing");
  assert.ok(!/NaN|undefined|Infinity/.test(shown(html)), "NaN, undefined or Infinity on the page");
});

check("deploys and credits draw full width on their own tabs and keep their rows", () => {
  const dep = { id: "t.dep", tab: "deploy", kind: "speed", label: "Production deploys a week", unit: "deploys", goal: 14, near: 1, direction: "higher", chart: "deploys" };
  const cr = { id: "t.cr", tab: "credits", kind: "quality", label: "Free allowance idle", unit: "allowances", goal: 0, near: 1, direction: "lower", chart: "credits" };
  const deploys = [{ label: "2026-11-02 23:51", value: 45, unit: "merges", commit: "2549f97", commit_from: "tag", lead_hours: 2.3, rollback: false, failed: null, restore_hours: null }];
  const allowances = [{ label: "Blacksmith", lane: "ci", allowance: 3000, unit: "minutes", used: 1587, used_floor: true, unused: 513, status: "idle", replaces: true, could_take_over: "CI overflow", claim_needs: "a share" }];
  const html = render({ defs: [dep, cr], metrics: { "t.dep": val(4, { detail: deploys }), "t.cr": val(1, { detail: allowances }) } });
  for (const [tab, id, text] of [["deploy", "t.dep", "2549f97"], ["credits", "t.cr", "Blacksmith"]]) {
    const section = new RegExp(`<section id="${tab}"[\\s\\S]*?<\\/section>\\n(<section id="|<\\/main>)`).exec(html)[0];
    const at = section.indexOf(`aria-labelledby="flow-${id}"`);
    assert.ok(at > 0 && at < section.indexOf('class="chips"'), `${tab}: no full-width figure above the rows`);
    assert.ok(section.includes(`id="m-${id}"`) && section.includes(text), `${tab}: lost its row or its content`);
    assert.ok(section.includes('<section class="gaps"'), `${tab}: no worst gaps`);
  }
  assert.ok(!/NaN|undefined|Infinity/.test(shown(html)), "NaN, undefined or Infinity on the page");
});

check("the Blockers tab opens with its worst gaps and shows each row's gap", () => {
  const miss = { id: "t.miss", tab: "blockers", kind: "quality", label: "Rules said twice", unit: "sentences", goal: 0, near: 3, direction: "lower" };
  const share = { id: "t.share", tab: "blockers", kind: "quality", label: "False alarms", unit: "%", goal: 5, near: 15, direction: "lower" };
  const html = render({ defs: [miss, share], metrics: { "t.miss": val(12), "t.share": val(62.7) } });
  const tab = /<section id="blockers"[\s\S]*?<\/section>\n(<section id="|<\/main>)/.exec(html)[0];
  const at = tab.indexOf('<section class="gaps"');
  assert.ok(at > 0 && at < tab.indexOf('class="chips"'), "no worst gaps above the rows");
  assert.ok(tab.indexOf("False alarms") < tab.indexOf("Rules said twice"), "the furthest gap is not first");
  assert.ok(tab.includes("Gap: 57.7 pts over goal") && tab.includes("Gap: 12 sentences over goal"), "a row lost its gap");
  assert.ok(!html.slice(0, html.indexOf('<section id="blockers"')).includes('class="gaps"'), "another tab drew worst gaps");
});

check("the overall score is the mean of the measured tabs", () => {
  const html = render({ defs: [up, down], metrics: { "t.up": val(95), "t.down": val(200) } });
  assert.ok(html.includes(`1 of ${DEFAULT_TABS.length} tabs measured`), "only Code is measured");
  assert.ok(/Overall quality" role="meter"|aria-valuenow="100" aria-label="Overall quality"/.test(html), "overall quality is Code's 100");
});

check("the render unit tests pass", () => {
  const dir = fileURLToPath(new URL("./render/", import.meta.url));
  const files = readdirSync(dir).filter((f) => f.endsWith(".test.mjs")).map((f) => join(dir, f));
  assert.ok(files.length > 0, "no render tests found");
  const r = spawnSync(process.execPath, ["--test", ...files], { encoding: "utf8" });
  assert.equal(r.status, 0, (r.stdout + r.stderr).split("\n").filter((l) => /not ok|fail \d/.test(l)).join("; "));
});

check("a breakdown item's own unit wins over the metric's", () => {
  const html = render({
    defs: [down],
    metrics: { "t.down": val(45, { detail: [{ label: "steps", value: 7, unit: "" }, { label: "slowest", value: 30 }] }) },
  });
  assert.ok(html.includes('<td class="num">7</td>'), "a plain count kept the metric's unit");
  assert.ok(html.includes('<td class="num">30 s</td>'), "an item without a unit lost the metric's unit");
});
