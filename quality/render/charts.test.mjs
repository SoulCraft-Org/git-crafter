// Unit tests for the Quality and Speed drawing functions (charts.mjs) and the
// numbers the page derives (model.mjs). Run by quality/selftest.mjs, or alone:
//   node --test quality/render/

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  bars,
  bullet,
  bulletScale,
  bulletZones,
  fmt,
  fmtCompact,
  funnel,
  histogram,
  labelFirst,
  meter,
  miniMassif,
  range,
  RANGE,
  scoreStatus,
  sharePct,
  spark,
  splitPath,
  stack,
  statusCounts,
  statusStack,
} from "./charts.mjs";
import { cellItems, criterionLabel, fixFirst, gap, groupRows, historyFor, overall, workQueue, pageLabel, rampStep, reviewGrid, sortRows, weakestCell, weeklyHistory, widthMode, worstGaps } from "./model.mjs";

const BAD = /NaN|undefined|Infinity/;
const lower = { id: "t.l", unit: "functions", goal: 20, near: 41, direction: "lower" };
const higher = { id: "t.h", unit: "%", goal: 90, near: 70, direction: "higher" };
// The custom properties in a span's style attribute, as { "--a": "70%" }.
const cssVars = (html) => Object.fromEntries((/style="([^"]*)"/.exec(html)?.[1] ?? "").split(";").filter(Boolean).map((d) => d.split(":")));

test("fmt keeps the old format; fmtCompact shortens large values only", () => {
  assert.equal(fmt(14194, "lines"), "14,194 lines");
  assert.equal(fmt(74.1, "%"), "74.1%");
  assert.equal(fmt(0.92, "h"), "0.92 h");
  assert.equal(fmtCompact(22884, "lines"), "22,884 lines");
  assert.equal(fmtCompact(519361, "tokens"), "519K tokens");
  assert.equal(fmtCompact(34105970, "tokens"), "34.1M tokens");
  assert.equal(fmtCompact(2000000), "2M");
  assert.equal(sharePct(0.004), "<1%");
  assert.equal(sharePct(0), "0%");
});

test("a score's status: 80 up meets, 50 to 79 near, under 50 misses, null not measured", () => {
  assert.deepEqual([100, 80, 79, 50, 49, 0, null].map(scoreStatus), ["meets", "meets", "near", "near", "misses", "misses", "not-measured"]);
});

test("bullet scale: 100 for a percent, else past goal, near and value", () => {
  assert.equal(bulletScale(higher, 120), 100);
  assert.equal(bulletScale(lower, 42), 41 * 1.25);
  assert.equal(bulletScale(lower, 100), 105);
  assert.equal(bulletScale({ goal: 0, near: 0, direction: "lower" }, 0), 1, "an all-zero metric still has a scale");
});

test("bullet zones follow direction", () => {
  assert.deepEqual(bulletZones(higher, 100), [["misses", 0, 70], ["near", 70, 90], ["meets", 90, 100]]);
  assert.deepEqual(bulletZones(lower, 60), [["meets", 0, 20], ["near", 20, 41], ["misses", 41, 60]]);
});

test("bullet: lower with goal 0 puts the tick at 0 and draws nothing negative", () => {
  const html = bullet({ goal: 0, near: 3, direction: "lower" }, 4);
  assert.doesNotMatch(html, BAD);
  assert.match(html, /^<span class="bl lo" style="[^"]*" aria-hidden="true"><\/span>$/);
  const v = cssVars(html);
  assert.deepEqual(v, { "--a": "0%", "--b": "71.4%", "--g": "0%", "--v": "95.2%" }, "max is 4 x 1.05: meets is empty, the tick is at 0");
  assert.ok(Object.values(v).every((x) => !x.startsWith("-")), "a negative position");
});

test("bullet: higher zones run misses, near, meets on a 0 to 100 percent scale", () => {
  assert.deepEqual(cssVars(bullet(higher, 80)), { "--a": "70%", "--b": "90%", "--g": "90%", "--v": "80%" });
  assert.match(bullet(higher, 80), /class="bl hi"/);
});

test("bullet: a value past the scale is clamped with an arrow cap", () => {
  const html = bullet(higher, 140);
  assert.match(html, /class="bl hi over"/);
  assert.match(html, /<i><\/i><\/span>$/);
  assert.equal(cssVars(html)["--v"], undefined, "the bar runs to the cap, not to 140%");
});

test("bullet: a value that was not measured draws zones and the goal only", () => {
  const html = bullet(lower, null);
  assert.match(html, /class="bl lo nv"/);
  assert.deepEqual(cssVars(html), { "--a": "39%", "--b": "80%", "--g": "39%" });
  assert.doesNotMatch(html, BAD);
});

test("meter: a score gets meter semantics; null reads not measured", () => {
  assert.equal(meter(67, "Quality"), '<span class="meter" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="67" aria-label="Quality" style="--v:67%"></span>');
  assert.match(meter(130, "Quality"), /aria-valuenow="100".*--v:100%/, "clamped to 100");
  const none = meter(null, "Quality");
  assert.match(none, /role="img" aria-label="Quality: not measured"/);
  assert.doesNotMatch(none, /--v/);
});

test("status stack: counts in order, empty statuses skipped in the bar", () => {
  const counts = statusCounts([{ status: "meets" }, { status: "meets" }, { status: "misses" }]);
  assert.deepEqual(counts, { meets: 2, near: 0, misses: 1, "not-measured": 0 });
  const html = statusStack(counts);
  assert.match(html, /aria-label="2 meet, 1 miss"/);
  assert.doesNotMatch(html, /class="b-near"/);
  assert.match(html, /<b>0<\/b> near/, "the legend still lists a zero");
});

test("splitPath: file paths split, page paths and plain labels stay whole", () => {
  assert.deepEqual(splitPath("site/src/lib/seats/viz.ts:168 frontRangeMap"), { dir: "site/src/lib/seats/", base: "viz.ts:168 frontRangeMap" });
  assert.equal(splitPath("/regions/"), null);
  assert.equal(splitPath("example-site (4100 requests)"), null);
  assert.equal(splitPath("2026-09-07"), null);
});

test("bars: an item's own unit wins; more than 12 items says how many show", () => {
  const html = bars([{ label: "steps", value: 7, unit: "" }, { label: "slowest", value: 30 }], "s");
  assert.match(html, /<td class="num">7<\/td>/);
  assert.match(html, /<td class="num">30 s<\/td>/);
  const many = bars(Array.from({ length: 15 }, (_, i) => ({ label: `f${i}`, value: i })), "");
  assert.match(many, /12 of 15 shown/);
});

test("funnel: bars shrink from the first stage with its share", () => {
  const html = funnel([{ label: "opened", value: 148 }, { label: "merged", value: 133 }, { label: "reverted", value: 0 }], "PRs");
  assert.match(html, /<span style="width:100.0%"><\/span><\/td><td class="num">148 PRs<\/td><td class="num share">100%<\/td>/);
  assert.match(html, /<td class="num share">90%<\/td>/);
  assert.match(html, /<td class="num share">0%<\/td>/);
  assert.doesNotMatch(funnel([{ label: "a", value: 0 }, { label: "b", value: 0 }], ""), BAD);
});

test("stack: at most 5 parts, the tail folds into Other, shares sum to the whole", () => {
  const detail = [10, 20, 30, 40, 50, 60].map((value, i) => ({ label: `p${i}`, value, unit: "tokens" }));
  const html = stack(detail, "tokens");
  assert.equal((html.match(/<tr>/g) ?? []).length, 5);
  assert.match(html, /Other<\/th><td class="num">110 tokens<\/td><td class="num share">52%<\/td>/);
  assert.match(html, /class="p5"/);
  assert.doesNotMatch(html, /class="p6"/);
  assert.doesNotMatch(stack([{ label: "a", value: 0 }], ""), BAD, "an empty whole draws no bar and no NaN");
});

test("stack, labelled: each part carries its label and value in text, its color above", () => {
  const html = stack([{ label: "open to green", value: 1, unit: "h" }, { label: "merge to live", value: 3, unit: "h" }], "h", { labelled: true });
  assert.match(html, /<span class="pbar lab" role="img"/);
  assert.match(html, /<span style="flex-grow:250"[^>]*><i class="p1"><\/i><b>open to green 1 h<\/b><\/span>/);
  assert.match(html, /<i class="p2"><\/i><b>merge to live 3 h<\/b>/);
  assert.doesNotMatch(stack([{ label: "a", value: 1 }], ""), /pbar lab|<b>/, "unlabelled by default");
});

test("spark: a partial last point is hollow and joined by a lighter segment", () => {
  const pts = [{ label: "w1", value: 3 }, { label: "w2", value: 5 }, { label: "w3", value: 1, partial: true }];
  const svg = spark(pts, { label: "Sessions", unit: "sessions" });
  assert.match(svg, /<polyline class="tail"/);
  assert.match(svg, /class="dot hollow"/);
  assert.match(svg, /w3 1 sessions so far/);
  assert.equal((svg.match(/<text/g) ?? []).length, 1, "the value is labeled once");
  const full = spark(pts.slice(0, 2), { label: "Sessions" });
  assert.doesNotMatch(full, /tail|hollow/);
  assert.equal(spark([{ label: "w1", value: 3 }]), "", "one point is no line");
  assert.doesNotMatch(spark([{ label: "a", value: 2 }, { label: "b", value: 2 }]), BAD, "a flat line has no NaN");
});

test("histogram: five columns, the tallest 44 px", () => {
  const html = histogram([1, 5, 96, 245, 197]);
  assert.equal((html.match(/class="hc"/g) ?? []).length, 5);
  assert.match(html, /class="hb k4" style="height:44px"/);
  assert.match(histogram([0, 0, 0, 0, 0]), /height:0px/);
});

test("range: 12 linked massifs, snow only above 80, a mound for not measured", () => {
  const part = (score) => ({ score, measured: score === null ? 0 : 3, total: 3 });
  const tabs = Array.from({ length: 12 }, (_, i) => ({ id: `t${i}`, name: `Tab ${i}`, short: `T${i}`, quality: part(i === 5 ? null : 60 + i * 3), speed: part(i === 5 ? null : 100 - i * 4) }));
  const svg = range(tabs);
  assert.equal((svg.match(/<a class="massif" href="#t\d+"/g) ?? []).length, 12);
  assert.equal((svg.match(/class="r-mound"/g) ?? []).length, 2);
  const snows = (svg.match(/class="r-snow"/g) ?? []).length;
  const above = tabs.flatMap((t) => [t.quality.score, t.speed.score]).filter((s) => s > 80).length;
  assert.equal(snows, above);
  assert.match(svg, /aria-label="T5 – –\. T5 \(Tab 5\): quality not measured, 0 of 3; speed not measured, 0 of 3"/, "the name starts with the visible label");
  assert.doesNotMatch(svg, BAD);
  // A summit at 100 sits at the top of the drawing's scale.
  const top = range([{ ...tabs[0], quality: part(100) }]);
  assert.equal(RANGE.base - 100 * RANGE.k > 59.9, true);
  assert.match(top, /L38 60L/);
});

test("range: 15 tabs keep 92-unit slots, and summit labels never overlap, all at 100", () => {
  const part = { score: 100, measured: 1, total: 1 };
  const tabs = Array.from({ length: 15 }, (_, i) => ({ id: `t${i}`, name: `Tab ${i}`, short: `T${i}`, quality: part, speed: part }));
  const svg = range(tabs);
  assert.match(svg, /viewBox="0 0 1420 330"/, "15 slots of 92 plus the 40-unit gutter");
  assert.match(range(tabs.slice(0, 13)), /viewBox="0 0 1236 330"/, "13 tabs still share the 1200");
  // Each label: glyph (12) + gap (2) + digits at about 10.2 per digit, from its <use> x.
  const boxes = [...svg.matchAll(/<use href="#g-[^"]+" x="([\d.-]+)" y="[\d.-]+" width="12" height="12"\/><text class="r-num" x="[\d.-]+" y="[\d.-]+">(\d+)<\/text>/g)].map(([, x, t]) => [Number(x), Number(x) + 14 + t.length * 10.2]);
  assert.equal(boxes.length, 30);
  boxes.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < boxes.length; i++) assert.ok(boxes[i][0] >= boxes[i - 1][1], `label ${i} overlaps the one before it`);
  assert.ok(boxes[0][0] >= -4 && boxes.at(-1)[1] <= 1380, "labels stay inside the plot");
});

test("an accessible name starts with the visible label", () => {
  assert.equal(labelFirst("Docs", "Documentation"), "Docs (Documentation)");
  assert.equal(labelFirst("Code", "Code"), "Code");
  assert.equal(labelFirst("Overview"), "Overview");
});

test("mini massif draws for missing parts too", () => {
  assert.doesNotMatch(miniMassif(null, { score: 50 }), BAD);
});

// ---- model.mjs ------------------------------------------------------------

const row = (id, status, extra = {}) => ({ def: { id, ...extra.def }, status, points: { meets: 100, near: 50, misses: 0 }[status] ?? null, entry: extra.entry });

test("overall: the mean of measured tabs, each weighted equally", () => {
  const r = overall([{ quality: { score: 60 }, speed: { score: null } }, { quality: { score: 81 }, speed: { score: 90 } }, { quality: { score: null }, speed: { score: null } }]);
  assert.deepEqual(r.quality, { score: 71, measured: 2, total: 3 });
  assert.deepEqual(r.speed, { score: 90, measured: 1, total: 3 });
});

test("master: each category the mean of its tabs, the master the mean of the categories", () => {
  const rows = (points) => points.map((p) => ({ points: p }));
  const r = overall([
    { quality: { score: 60 }, speed: { score: null }, rows: rows([100, 0, null]) },
    { quality: { score: 80 }, speed: { score: 90 }, rows: rows([50]) },
    { quality: { score: null }, speed: { score: null }, rows: rows([null]) },
  ]);
  // Quality (60 + 80) / 2 = 70, speed 90 (tab two alone), tab three left out: (70 + 90) / 2.
  assert.deepEqual(r.master, { score: 80, measured: 2, total: 3, categories: 2, metricsMeasured: 3, metricsTotal: 5 });
});

test("master: quality, speed and consumption weigh a third each", () => {
  const r = overall([
    { quality: { score: 90 }, speed: { score: 60 }, consumption: { score: 0, total: 2 }, rows: [] },
    { quality: { score: 100 }, speed: { score: 100 }, consumption: { score: null, total: 0 }, rows: [] },
  ]);
  // Quality (90 + 100) / 2 = 95, speed (60 + 100) / 2 = 80, consumption 0 (tab one alone): (95 + 80 + 0) / 3.
  assert.equal(r.master.score, 58);
  assert.deepEqual(r.consumption, { score: 0, measured: 1, total: 1 });
});

test("rows sort misses, near, meets, not measured, then file order", () => {
  const rows = [row("a", "meets"), row("b", "not-measured"), row("c", "misses"), row("d", "near"), row("e", "misses")];
  assert.deepEqual(sortRows(rows).map((r) => r.def.id), ["c", "e", "d", "a", "b"]);
});

test("worstGaps: near and missing rows, furthest from goal first, at most five", () => {
  const r = (id, status, value, goal = 0, near = 10, direction = "lower") => ({ def: { id, goal, near, direction }, entry: { value }, status });
  const rows = [r("a", "misses", 30), r("b", "near", 5), r("c", "meets", 0), r("d", "misses", 100), r("e", "misses", 12, 90, 80, "higher"), r("f", "not-measured", null), r("g", "misses", 20), r("h", "misses", 15)];
  assert.deepEqual(worstGaps(rows).map((x) => x.def.id), ["d", "e", "a", "g", "h"]);
  assert.deepEqual(worstGaps(rows, 10).map((x) => x.def.id).at(-1), "b");
});

// Git Crafter issue #146: a metric redefined keeps its id; older reads are not
// charted against the new definition.
test("historyFor: only reads in the unit the metric has now, and none dated before its defined day", () => {
  const def = { id: "m", unit: "s" };
  const run = (at, entry) => ({ generated_at: `${at}T12:00:00Z`, metrics: { m: entry } });
  const history = [run("2026-10-20", { value: 900 }), run("2026-10-27", { value: 880, unit: "ms" }), run("2026-11-03", { value: 0.9, unit: "s" }), run("2026-11-10", { value: 0.8, unit: "s" })];
  assert.deepEqual(historyFor(history, def), { points: [{ label: "2026-11-02", value: 0.9 }, { label: "2026-11-09", value: 0.8 }], dropped: 2 }, "the ms read and the unknown one go once a change shows");
  assert.deepEqual(historyFor(history.slice(0, 1).concat(history.slice(2)), def).points.map((p) => p.value), [900, 0.9, 0.8], "with no unit change seen, an unknown read counts");
  assert.deepEqual(historyFor(history.slice(2), { ...def, defined: "2026-11-05" }), { points: [{ label: "2026-11-09", value: 0.8 }], dropped: 1 }, "a read dated before defined goes, unit or not");
  assert.equal(weeklyHistory(history, "m").length, 4, "given only an id, every read counts");
});

test("weeklyHistory: the last read of each UTC week, by its Monday, skipping unread runs", () => {
  const run = (at, value) => ({ generated_at: at, metrics: { m: value === null ? { could_not_check: "x" } : { value } } });
  const runs = [run("2026-11-03T10:00:00Z", 7), run("2026-11-02T09:00:00Z", 9), run("2026-10-28T09:00:00Z", 12), run("2026-10-29T09:00:00Z", null), { generated_at: "2026-10-20T00:00:00Z", metrics: {} }];
  assert.deepEqual(weeklyHistory(runs, "m"), [{ label: "2026-10-26", value: 12 }, { label: "2026-11-02", value: 7 }]);
});

test("groups: ungrouped rows first, then groups in file order, each with its mean", () => {
  const rows = [row("a", "meets", { def: { group: "Tokens" } }), row("b", "misses"), row("c", "near", { def: { group: "Tokens" } }), row("d", "meets", { def: { group: "Dead code" } })];
  const g = groupRows(rows);
  assert.deepEqual(g.map((x) => x.group), [null, "Tokens", "Dead code"]);
  assert.deepEqual(g[1].rows.map((r) => r.def.id), ["c", "a"]);
  assert.equal(g[1].mean, 75);
});

test("Fix first ranks misses by gap in near-band widths", () => {
  assert.equal(gap({ goal: 20, near: 41, direction: "lower" }, 42), 22 / 21);
  assert.equal(gap({ goal: 90, near: 70, direction: "higher" }, 0), 4.5);
  assert.equal(gap({ goal: 0, near: 0, direction: "lower" }, 143), 143, "a zero band counts as 1");
  const results = [
    { tab: "a", rows: [row("x", "misses", { def: { goal: 0, near: 0, direction: "lower" }, entry: { value: 5 } }), row("ok", "meets", { def: {}, entry: { value: 1 } })] },
    { tab: "b", rows: [row("y", "misses", { def: { goal: 90, near: 70, direction: "higher" }, entry: { value: 0 } })] },
  ];
  assert.deepEqual(fixFirst(results).map((r) => [r.tab, r.def.id]), [["a", "x"], ["b", "y"]]);
  assert.equal(fixFirst(results, 1).length, 1);
});

test("labels: criteria and pages in short plain words", () => {
  assert.equal(criterionLabel("visual_hierarchy"), "Hierarchy");
  assert.equal(criterionLabel("Help users recognize, diagnose, and recover from errors"), "Recovery");
  assert.equal(criterionLabel("some_new_thing"), "Some new thing");
  assert.equal(pageLabel("https://example.org/links/"), "/links/");
  assert.equal(pageLabel("https://example.org"), "/");
  assert.equal(pageLabel("task:3"), "Task 3");
  assert.deepEqual([1280, "375", null, "x"].map(widthMode), ["d", "p", null, null]);
  assert.deepEqual([1, 1.5, 3.5, 3.6, 5].map(rampStep), [1, 1, 3, 4, 5]);
});

test("review grid: widths split, rows weakest first, a page's empty cell stays null", () => {
  const items = [
    { page: "/a/", width: 1280, criterion: "typography", score: 5 },
    { page: "/a/", width: 375, criterion: "typography", score: 4 },
    { page: "/b/", width: 1280, criterion: "typography", score: 2 },
    { page: "/b/", width: 375, criterion: "color_and_contrast", score: 3 },
  ];
  const g = reviewGrid({ items });
  assert.deepEqual(g.columns, ["typography", "color_and_contrast"]);
  assert.deepEqual(g.rows.map((r) => r.page), ["/b/", "/a/"]);
  assert.deepEqual(g.rows[1].cells[0], { d: 5, p: 4, b: 4.5 });
  assert.deepEqual(g.rows[0].cells[0], { d: 2, p: null, b: 2 });
  assert.equal(g.rows[1].cells[1], null);
  assert.equal(g.hasWidths, true);
  assert.deepEqual(g.histogram, [0, 1, 1, 1, 1]);
  assert.deepEqual(weakestCell(g), { r: 0, c: 0, value: 2 });
});

test("review grid with areas: only area rows fill it; file rows are findings under their area", () => {
  const items = [
    { page: "site/src", level: "area", criterion: "drift", score: 3 },
    { page: "scripts", level: "area", criterion: "drift", score: 4 },
    { page: "site/src/a.ts", level: "file", criterion: "drift", score: 1 },
    { page: "site/srcx/b.ts", level: "file", criterion: "drift", score: 2 },
    { page: "site/src/c.ts", level: "file", criterion: "comments", score: 2 },
  ];
  const review = { items };
  const g = reviewGrid(review);
  assert.deepEqual(g.rows.map((r) => r.page), ["site/src", "scripts"]);
  assert.equal(g.findings.length, 3);
  assert.equal(g.hasWidths, false);
  assert.deepEqual(cellItems(review, g, "site/src", "drift").map((it) => it.page), ["site/src", "site/src/a.ts"]);
});

test("workQueue: every near or missing metric, ranked by the master points it adds", () => {
  const def = (id, kind) => ({ id, kind, goal: 10, near: 20, direction: "lower" });
  const rows = (list) => list.map(([id, kind, status, points, value]) => ({ def: def(id, kind), status, points, entry: { value } }));
  const results = [
    // Quality is scored on both tabs, speed on a alone, so 2 categories. a's miss lifts
    // a's quality by 100 / 2 metrics, quality by that / 2 tabs, the master by that / 2: 12.5.
    { tab: "a", quality: { score: 50, measured: 2 }, speed: { score: 100, measured: 1 }, consumption: { score: null, total: 0 }, rows: rows([["a.miss", "quality", "misses", 0, 40], ["a.ok", "quality", "meets", 100, 5], ["a.s", "speed", "meets", 100, 1]]) },
    // b's near metric: 50 / 1 metric / 2 tabs / 2 categories = 12.5; a's wider gap ranks first.
    { tab: "b", quality: { score: 50, measured: 1 }, speed: { score: null, measured: 0 }, consumption: { score: null, total: 0 }, rows: rows([["b.near", "quality", "near", 50, 15]]) },
  ];
  const q = workQueue(results);
  assert.deepEqual(q.map((r) => [r.def.id, r.gain]), [["a.miss", 12.5], ["b.near", 12.5]]);
  // The gain is exact: meeting b.near lifts quality from 50 to 75 and the master from 75 to 87.5.
  assert.equal(overall(results).master.score, 75);
});
