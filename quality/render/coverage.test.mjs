// Tests for the page's coverage line: N of M metrics read, K that do not apply, J dropped by the repo.
// Run with `node --test quality/render/coverage.test.mjs`.

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { after, describe, it } from "node:test";

import { loadDefs, DEFAULT_TABS } from "../score.mjs";
import { writeTargets } from "../selftest-lib.mjs";
import { render } from "./page.mjs";

const def = (id, tab = "code", kind = "quality", extra = {}) => ({ id, tab, kind, label: id, unit: "", goal: 0, near: 2, direction: "lower", goal_source: "test", ...extra });
const META = { commit: "abc1234", builtAt: "2026-11-23 12:00 UTC" };

describe("loadDefs.dropped", () => {
  const dirs = [];
  const targets = (list) => (dirs.push(writeTargets(list)), dirs.at(-1));
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  it("lists the metrics a repo drops on a shown tab, and not the ones on a hidden tab", () => {
    const template = targets([def("t.a"), def("t.b"), def("t.c"), def("t.hidden", "settings")]);
    const repo = targets([{ id: "t.b", drop: true, goal_source: "this repo has no b" }, { id: "t.hidden", drop: true }]);
    const { defs, dropped } = loadDefs({ templateDir: template, repoDir: repo, tabs: DEFAULT_TABS.filter(([id]) => id === "code") });
    assert.deepEqual(defs.map((d) => d.id), ["t.a", "t.c"]);
    assert.deepEqual(dropped.map((d) => [d.id, d.goal_source]), [["t.b", "this repo has no b"]]);
  });
});

describe("the page's coverage line", () => {
  const defs = [def("t.on"), def("t.blind"), def("t.off")];
  const metrics = { "t.on": { value: 0, source: "test" }, "t.blind": { could_not_check: "needs a token", source: "test" }, "t.off": { not_applicable: "the feature is off", source: "test" } };
  const dropped = [def("t.gone", "code", "quality", { goal_source: "No such thing here (2026-11-23)" }), def("t.gone2", "actions", "speed", { goal_source: undefined })];
  const html = render({ defs, dropped, metrics, tabs: DEFAULT_TABS, meta: META });

  it("says N of M read, what does not apply and what the repo dropped", () => {
    assert.match(html, /1 of 2 metrics read, 1 do not apply, 2 dropped; one not read is shown, never scored as 0\./);
  });

  it("reads at most 50 words before the overview's first action, the score explainer being a fold", () => {
    const overview = /<section id="overview"[^>]*>(.*?)<\/section>/s.exec(html)[1];
    const before = overview.slice(0, overview.search(/<(a|button|summary)\b/));
    const words = before.replace(/<[^>]+>/g, " ").split(/\s+/).filter(Boolean).length;
    assert.ok(words <= 50, `${words} words before the first action`);
    assert.match(overview, /<details class="refs-fold"><summary>How the score is made<\/summary><p class="small">Quality, Speed and Consumption weigh a third each/);
  });

  it("lists each dropped metric with its reason, as plain text", () => {
    const fold = /<h3>Dropped<\/h3><b>2<\/b><\/summary>(.*?)<\/details>/s.exec(html)[1];
    assert.match(fold, /<span>t\.gone<\/span><span class="reason">No such thing here \(2026-11-23\)<\/span>/);
    assert.match(fold, /<span>t\.gone2<\/span><span class="reason">No reason given\.<\/span>/, "a drop with no reason says so");
    assert.doesNotMatch(fold, /<a href="#m-/, "a dropped metric has no row to link to");
  });

  it("leaves both clauses and the fold out when nothing is dropped or inapplicable", () => {
    const plain = render({ defs: [def("t.on")], metrics: { "t.on": metrics["t.on"] }, tabs: DEFAULT_TABS, meta: META });
    assert.match(plain, /1 of 1 metrics read; one not read/);
    assert.doesNotMatch(plain, /dropped|do not apply|<h3>Dropped/);
  });
});
