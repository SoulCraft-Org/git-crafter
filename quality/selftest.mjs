#!/usr/bin/env node
// Self-test for the Quality, Speed and Consumption engine (every gate ships
// one). Seeds known-good and known-bad samples and fails if either behaves
// wrong:
//   - a could_not_check metric is left out of the mean, never scored 0, from
//     a collector's return to the built page's tab and master scores
//   - a repo's config: its targets override the template's by id (goal, near,
//     goal_source, params, drop), its own collectors run beside the
//     template's, its tab list holds, and the web tabs stay off by default
//   - every tab the template fills has an ideal state with a public source,
//     and a metric in each of quality, speed and consumption, each with a goal
//     and a goal_source; the page opens each tab with its ideal
//   - meeting a goal scores 100 and a clear miss scores 0, either direction
//   - a broken targets file is a usage error, not data
//   - a review joins the metric mean as one equal half of the quality score
//   - the page renders every tab it is given and a range link for each, and
//     escapes collector and review text, inside embedded JSON too
//   - bullet zones, goal 0, and the contract fields (means, group, funnel,
//     stack, partial) render, with no NaN, undefined or Infinity
//   - a flow and a ledger draw full width above their tab's rows, and the
//     Blockers tab opens with its worst gaps
//   - the page's 1,000 KB budget blocks one byte over
//   - the render unit tests (quality/render/*.test.mjs) pass
//
//   node quality/selftest.mjs
//
// Exit 0 pass, 1 fail.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { annotation, runCollectors } from "./collect.mjs";
import { loadAllReviews, loadReviews, loadTargets, mergeMetrics, newestReviews, scoreMetric, scoreTab } from "./score.mjs";
import { check, checks, down, up, val, blind } from "./selftest-lib.mjs";
import "./selftest-render.mjs";
import "./selftest-repo.mjs";

check("could_not_check is not measured, never 0", () => {
  const r = scoreMetric(blind, { could_not_check: "no tool", source: "fixture" });
  assert.equal(r.points, null);
  assert.equal(r.status, "not-measured");
});

check("higher is better: goal met, near, clear miss", () => {
  assert.equal(scoreMetric(up, val(95)).points, 100);
  assert.equal(scoreMetric(up, val(90)).points, 100);
  const near = scoreMetric(up, val(80));
  assert.equal(near.status, "near");
  assert.ok(near.points > 0 && near.points < 100, `near scored ${near.points}`);
  assert.equal(scoreMetric(up, val(50)).points, 0);
  assert.equal(scoreMetric(up, val(50)).status, "misses");
});

check("lower is better: goal met, near, clear miss", () => {
  assert.equal(scoreMetric(down, val(45)).points, 100);
  const near = scoreMetric(down, val(90));
  assert.ok(near.points > 0 && near.points < 100, `near scored ${near.points}`);
  assert.equal(scoreMetric(down, val(200)).points, 0);
});

check("a tab's mean skips what was not measured", () => {
  const metrics = { "t.up": val(95), "t.blind": { could_not_check: "no tool", source: "fixture" }, "t.down": val(45) };
  const tab = scoreTab("code", [up, blind, down], metrics);
  assert.deepEqual([tab.quality.score, tab.quality.measured, tab.quality.total], [100, 1, 2]);
  assert.equal(tab.speed.score, 100);
});

check("a read value beats a could_not_check when runs merge", () => {
  const ci = { metrics: { "t.up": { could_not_check: "needs admin", source: "ci" } } };
  const local = { metrics: { "t.up": val(92) } };
  assert.equal(mergeMetrics(ci, local)["t.up"].value, 92);
  assert.equal(mergeMetrics(local, ci)["t.up"].value, 92);
});

check("of two reasons, the newer run's says why when runs merge", () => {
  const local = { generated_at: "2026-11-05T01:09:27Z", metrics: { "t.up": { could_not_check: "#357 has a run still going", source: "local" } } };
  const ci = { generated_at: "2026-11-06T05:43:10Z", metrics: { "t.up": { could_not_check: "#411 has runs this push started still going", source: "ci" } } };
  assert.equal(mergeMetrics(local, ci)["t.up"].source, "ci");
  assert.equal(mergeMetrics(ci, local)["t.up"].source, "ci", "order does not matter");
  assert.equal(mergeMetrics({ metrics: local.metrics }, { metrics: ci.metrics })["t.up"].source, "local", "with no times, the first reason stays");
});

check("a broken targets file is a usage error", () => {
  const dir = mkdtempSync(join(tmpdir(), "quality-targets-"));
  try {
    writeFileSync(join(dir, "a.json"), JSON.stringify([up, up]));
    assert.throws(() => loadTargets(dir), /duplicate id/);
    writeFileSync(join(dir, "a.json"), JSON.stringify([{ ...up, tab: "wiki" }]));
    assert.throws(() => loadTargets(dir), /unknown tab/);
    writeFileSync(join(dir, "a.json"), JSON.stringify([up, down]));
    assert.equal(loadTargets(dir).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check("a review is one equal half of the quality score", () => {
  const dir = mkdtempSync(join(tmpdir(), "quality-reviews-"));
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "code-2026-11.yaml"),
      "review: code\ndate: 2026-11-02\ncommit: abc1234\nitems:\n  - { page: a.ts, criterion: simplicity, score: 3, finding: x, fix: y, tracking: null }\n",
    );
    const reviews = loadReviews(dir);
    assert.equal(reviews.code.score, 50);
    const tab = scoreTab("code", [up], { "t.up": val(95) }, reviews);
    assert.equal(tab.quality.score, 75);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check("no collectors folder yet is an empty run, not a crash", async () => {
  const r = await runCollectors({ root: tmpdir(), mode: "ci", dirs: [join(tmpdir(), "quality-no-such-dir")], defs: [] });
  assert.deepEqual([r.ran.length, Object.keys(r.metrics).length], [0, 0]);
});

check("a collector that fails to import blanks only its own metrics", async () => {
  const dir = mkdtempSync(join(tmpdir(), "quality-collectors-"));
  try {
    writeFileSync(join(dir, "broken.mjs"), 'import "no-such-package-anywhere";\nexport async function collect() { return {}; }\n');
    writeFileSync(join(dir, "good.mjs"), 'export const area = "good";\nexport async function collect() { return { "g.one": { value: 1, source: "x", read_at: "2026-11-02" }, "g.bad": null }; }\n');
    const defs = [{ ...up, id: "issues.open", file: "broken.json" }];
    const r = await runCollectors({ root: dir, mode: "ci", dirs: [dir], defs });
    assert.match(r.metrics["issues.open"].could_not_check, /broken\.mjs failed/);
    assert.equal(r.metrics["g.one"].value, 1);
    assert.ok(r.metrics["g.bad"].could_not_check, "a null entry must become could_not_check");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check("a gate's error line escapes %, CR and LF, so a label cannot start another workflow command", () => {
  assert.equal(annotation("50% done\r\n::warning::x"), "50%25 done%0D%0A::warning::x");
});

check("targets reject a near band on the wrong side, an unknown chart and a gate that is not a boolean", () => {
  const dir = mkdtempSync(join(tmpdir(), "quality-targets-"));
  try {
    writeFileSync(join(dir, "a.json"), JSON.stringify([{ ...up, near: 95 }]));
    assert.throws(() => loadTargets(dir), /worse side/);
    writeFileSync(join(dir, "a.json"), JSON.stringify([{ ...up, chart: "pie" }]));
    assert.throws(() => loadTargets(dir), /unknown chart/);
    writeFileSync(join(dir, "a.json"), JSON.stringify([{ ...up, gate: "yes" }]));
    assert.throws(() => loadTargets(dir), /gate must be true, false or "warn"/);
    writeFileSync(join(dir, "a.json"), JSON.stringify([{ ...up, gate: "warn" }]));
    assert.equal(loadTargets(dir).length, 1);
    writeFileSync(join(dir, "a.json"), JSON.stringify([{ ...up, gate: true }]));
    assert.equal(loadTargets(dir).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check("reviews reject bad scores and score area rows only", () => {
  const dir = mkdtempSync(join(tmpdir(), "quality-reviews-"));
  const write = (body) => writeFileSync(join(dir, "code-2026-11.yaml"), `review: code\ndate: 2026-11-02\nitems:\n${body}`);
  try {
    write("  - { page: a.ts, criterion: c, score: 7 }\n");
    assert.throws(() => loadReviews(dir), /outside 1 to 5/);
    write("  - { page: site, level: area, criterion: c, score: 5 }\n  - { page: a.ts, level: file, criterion: c, score: 1 }\n");
    const r = loadReviews(dir).code;
    assert.equal(r.score, 100, "file rows must not pull the area score down");
    assert.equal(r.items.length, 2, "file rows still show as findings");
    writeFileSync(join(dir, "code-2026-11.yaml"), "review: wiki\nitems: []\n");
    assert.throws(() => loadReviews(dir), /must name a tab/);
    writeFileSync(join(dir, "code-2026-11.yaml"), "review: code\nitems:\n  - { page: a, criterion: c, score: 3 }\n");
    assert.throws(() => loadReviews(dir), /date must be YYYY-MM-DD/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check("each run in the trend uses the review that existed by its date", () => {
  const dir = mkdtempSync(join(tmpdir(), "quality-reviews-"));
  try {
    writeFileSync(join(dir, "code-2026-11.yaml"), "review: code\ndate: 2026-11-02\nitems:\n  - { page: a, criterion: c, score: 5 }\n");
    writeFileSync(join(dir, "code-2026-12.yaml"), "review: code\ndate: 2026-12-01\nitems:\n  - { page: a, criterion: c, score: 1 }\n");
    const all = loadAllReviews(dir);
    assert.equal(all.code.length, 2);
    assert.equal(newestReviews(all).code.score, 0, "today uses December");
    assert.equal(newestReviews(all, "2026-11-15").code.score, 100, "a mid-November run uses November");
    assert.equal(newestReviews(all, "2026-10-30").code, undefined, "a run before any review has none");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

let failed = 0;
for (const [name, fn] of checks) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL ${name}: ${err.message}`);
  }
}
console.log(`quality selftest: ${failed ? "FAIL" : "PASS"} (${checks.length - failed} of ${checks.length})`);
process.exit(failed ? 1 : 0);
