// Tests for the pipeline drawing. Run with `node --test quality/render/ci-flow.test.mjs`;
// quality/selftest.mjs runs every render/*.test.mjs.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { ciFlow, layout, passStatus, STAGES } from "./ci-flow.mjs";

const DEF = { id: "ci.latest_flow", label: "Pipeline: the latest push to all green" };
const step = (label, stage, value, pass_rate, extra = {}) => ({
  label,
  value,
  unit: "minutes",
  stage,
  kind: "job",
  runs: `${label} runs`,
  file: `.github/workflows/${label}.yml`,
  pass_rate,
  ...extra,
});
const STEPS = [
  step("pre-commit", "commit", null, null, { kind: "hook", file: ".githooks/pre-commit" }),
  step("site-tests", "ci", 3.1, 96, { light_share: 30 }),
  step("quality-pages build", "ci", 3.6, 80),
  step("content-gates", "ci", 0.2, 100),
  step("Pinned review and merge", "review", 13.1, 90.7, { kind: "manual", file: "CLAUDE.md" }),
  step("Production deploy", "deploy", null, null, { kind: "manual", file: "CLAUDE.md" }),
];

describe("passStatus", () => {
  it("uses the success-rate bands, 95 and 85", () => {
    assert.equal(passStatus(95), "meets");
    assert.equal(passStatus(94.9), "near");
    assert.equal(passStatus(85), "near");
    assert.equal(passStatus(84.9), "misses");
    assert.equal(passStatus(null), "not-measured");
    assert.equal(passStatus(Number.NaN), "not-measured");
  });
});

describe("layout", () => {
  it("orders columns by stage and puts each column's slowest step on top", () => {
    const cols = layout(STEPS);
    assert.deepEqual(cols.map((c) => c.id), ["commit", "ci", "review", "deploy"]);
    const ci = cols.find((c) => c.id === "ci");
    assert.deepEqual(ci.steps.map((s) => [s.label, s.critical]), [
      ["quality-pages build", true],
      ["site-tests", false],
      ["content-gates", false],
    ]);
    assert.equal(ci.minutes, 3.6);
    assert.equal(ci.name, STAGES.find(([id]) => id === "ci")[1]);
    const commit = cols.find((c) => c.id === "commit");
    assert.equal(commit.minutes, null, "a stage with no timed step has no time");
    assert.equal(commit.steps[0].critical, true, "its first step still carries the rail");
  });

  it("puts an unknown stage after the known ones", () => {
    const cols = layout([...STEPS, step("later thing", "later", 1, 100)]);
    assert.equal(cols.at(-1).id, "later");
    assert.equal(cols.at(-1).name, "later");
  });
});

describe("ciFlow", () => {
  const html = ciFlow(STEPS, DEF);

  it("draws one column per stage, in order, with one rail step each", () => {
    const at = (text) => html.indexOf(`<span>${text}</span>`);
    const names = ["Commit", "Pull request checks", "Review", "Deploy"];
    for (const n of names) assert.ok(at(n) > 0, n);
    assert.deepEqual([...names].sort((a, b) => at(a) - at(b)), names);
    assert.equal((html.match(/class="cf-node crit"/g) ?? []).length, 4);
  });

  it("gives every node a popover it opens, with unique ids", () => {
    const pops = [...html.matchAll(/<div class="cf-pop" id="([^"]+)" popover>/g)].map((m) => m[1]);
    assert.equal(pops.length, STEPS.length);
    assert.equal(new Set(pops).size, pops.length, "duplicate popover id");
    const targets = new Set([...html.matchAll(/popovertarget="([^"]+)"/g)].map((m) => m[1]));
    assert.deepEqual([...targets].sort(), [...pops].sort());
    assert.equal((html.match(/<button type="button" class="cf-btn"/g) ?? []).length, STEPS.length);
  });

  it("draws a magnitude bar only for timed steps, the slowest at full width", () => {
    assert.equal((html.match(/class="cf-bar"/g) ?? []).length, 4);
    assert.ok(html.includes('class="cf-bar" style="width:100.0%"'), "the 13.1 minute step is the full bar");
    assert.ok(html.includes("not timed"));
  });

  it("says how often a step skipped its work", () => {
    assert.ok(html.includes("30% of sampled runs found nothing to check"));
    assert.ok(html.includes("3.1 minutes when it does its work"));
  });

  it("scrolls sideways in its own box and keeps a table twin", () => {
    assert.ok(html.includes('<div class="cf-scroll" role="region"'));
    const css = readFileSync(new URL("./page-figures.css", import.meta.url), "utf8");
    assert.ok(css.includes(".cf-scroll { overflow-x: auto"), "the styles live in page-figures.css");
    assert.ok(!html.includes("<style"), "no inline styles");
    assert.equal((html.match(/<tr><td>/g) ?? []).length, STEPS.length);
  });

  it("lets a keyboard reach both scroll boxes", () => {
    const boxes = html.match(/<div class="cf-scroll"[^>]*>/g) ?? [];
    assert.equal(boxes.length, 2, "the drawing and the table twin");
    for (const box of boxes) assert.match(box, /tabindex="0"/);
  });

  it("says the pass rate leaves cancelled runs out", () => {
    assert.ok(html.includes("96% of runs passed; cancelled runs are left out"));
  });
});

describe("ciFlow on bad input", () => {
  it("escapes every label, text and file", () => {
    const hostile = ciFlow([step('<img src=x onerror="alert(1)">', "ci", 1, 100, { runs: "</div><script>alert(1)</script>", file: '"><b>' })], DEF);
    assert.ok(!hostile.includes("<img src=x"));
    assert.ok(!hostile.includes("<script>"));
    assert.ok(!hostile.includes('"><b>'));
    assert.ok(hostile.includes("&lt;img src=x"));
  });

  it("never prints NaN, undefined or Infinity", () => {
    const odd = ciFlow([step("a", "ci", Number.NaN, Number.POSITIVE_INFINITY), step("b", "ci", undefined, undefined), { stage: "deploy" }], DEF);
    for (const out of [ciFlow(STEPS, DEF), odd]) assert.ok(!/NaN|undefined|Infinity/.test(out.replace(/<style>[\s\S]*?<\/style>/, "")));
  });

  it("returns a short note, not a throw, when there is nothing to draw", () => {
    for (const detail of [[], undefined, null, [null, 5]]) assert.match(ciFlow(detail, DEF), /No pipeline steps were read/);
  });
});
