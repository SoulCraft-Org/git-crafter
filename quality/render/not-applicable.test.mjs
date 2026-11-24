// Tests for the does-not-apply state: a collector's { not_applicable } is scored, merged and drawn apart from an unread metric.
// Run with `node --test quality/render/not-applicable.test.mjs`.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { currentMetrics, DEFAULT_TABS, isMeasured, isNotApplicable, mergeMetrics, scoreMetric, scoreTab } from "../score.mjs";
import { overall } from "./model.mjs";
import { render } from "./page.mjs";

const def = (id, kind, extra = {}) => ({ id, tab: "scanning", kind, label: id, unit: "", goal: 0, near: 2, direction: "lower", goal_source: "test", ...extra });
const DEFS = [def("t.on", "quality"), def("t.open", "quality"), def("t.blind", "quality"), def("t.fast", "speed")];
const OFF = { not_applicable: "Code scanning is off, so it has no findings to count", source: "test" };
const METRICS = { "t.on": { value: 0, source: "test" }, "t.open": OFF, "t.blind": { could_not_check: "needs an admin token", source: "test" }, "t.fast": { value: 1, source: "test" } };

describe("a metric that does not apply", () => {
  it("is neither measured nor not-measured, and has no points", () => {
    assert.equal(isNotApplicable(OFF), true);
    assert.equal(isMeasured(OFF), false);
    assert.deepEqual(scoreMetric(DEFS[1], OFF), { status: "not-applicable", points: null });
    assert.equal(isNotApplicable({ not_applicable: "  ", source: "test" }), false, "a reason in words is required");
    assert.equal(isNotApplicable({ not_applicable: "off", value: 3 }), false, "a number means it was read");
  });

  it("leaves the tab's mean and its m: 1 of 2 measured, not 1 of 3", () => {
    const tab = scoreTab("scanning", DEFS, METRICS);
    assert.deepEqual([tab.quality.score, tab.quality.measured, tab.quality.total], [100, 1, 2]);
  });

  it("survives currentMetrics, where an entry with neither value nor could_not_check is made blank", () => {
    assert.deepEqual(currentMetrics({ "t.open": OFF }, [DEFS[1]])["t.open"], OFF);
  });

  it("beats a could_not_check when runs merge, and the newer run beats a measurement", () => {
    const blind = { generated_at: "2026-11-23T01:00:00Z", metrics: { "t.open": { could_not_check: "needs an admin token", source: "ci" } } };
    const off = { generated_at: "2026-11-22T01:00:00Z", metrics: { "t.open": OFF } };
    assert.equal(mergeMetrics(blind, off)["t.open"].not_applicable, OFF.not_applicable);
    assert.equal(mergeMetrics(off, blind)["t.open"].not_applicable, OFF.not_applicable);
    const old = { generated_at: "2026-11-01T01:00:00Z", metrics: { "t.open": { value: 4, source: "local", read_at: "2026-11-01T01:00:00Z" } } };
    assert.equal(mergeMetrics(old, off)["t.open"].not_applicable, OFF.not_applicable, "the feature went off after the old count");
    const fresh = { generated_at: "2026-11-23T01:00:00Z", metrics: { "t.open": { value: 4, source: "local", read_at: "2026-11-23T01:00:00Z" } } };
    assert.equal(mergeMetrics(off, fresh)["t.open"].value, 4, "and a count read since then stands");
  });

  it("is counted apart in the master: m leaves out what cannot apply", () => {
    const master = overall([scoreTab("scanning", DEFS, METRICS)]).master;
    assert.deepEqual([master.metricsMeasured, master.metricsTotal, master.metricsNotApplicable], [2, 3, 1]);
  });
});

describe("the page", () => {
  const html = render({ defs: DEFS, metrics: METRICS, tabs: DEFAULT_TABS, meta: { commit: "abc1234", builtAt: "2026-11-23 12:00 UTC" } });
  const row = (id) => new RegExp(`<details class="metric s-([\\w-]+)" id="m-${id.replace(".", "\\.")}">`).exec(html)?.[1];

  it("draws the row in its own state, with the reason where an unread row has its own", () => {
    assert.equal(row("t.open"), "not-applicable");
    assert.equal(row("t.blind"), "not-measured");
    assert.match(html, /<use href="#g-not-applicable"\/>/);
    assert.match(html, /<p class="reason">Code scanning is off, so it has no findings to count<\/p>/);
  });

  it("lists it under Does not apply, not under Not measured", () => {
    const fold = (title) => new RegExp(`<h3>${title}</h3><b>(\\d+)</b></summary>(.*?)</details>`, "s").exec(html);
    assert.equal(fold("Does not apply")[1], "1");
    assert.match(fold("Does not apply")[2], /m-t\.open/);
    assert.equal(fold("Not measured")[1], "1");
    assert.doesNotMatch(fold("Not measured")[2], /m-t\.open/);
  });

  it("offers a filter chip on the tab that has one, and none where nothing is left out", () => {
    assert.match(html, /<button type="button" data-f="not-applicable" aria-pressed="false"><svg[^>]*><use href="#g-not-applicable"\/><\/svg>Does not apply<b>1<\/b><\/button>/);
    const plain = render({ defs: DEFS, metrics: { ...METRICS, "t.open": { value: 1, source: "test" } }, tabs: DEFAULT_TABS });
    assert.doesNotMatch(plain, /data-f="not-applicable"|Does not apply/);
  });
});
