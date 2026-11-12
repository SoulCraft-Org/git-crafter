// The card picture: wrapping, the meter's share, and the SVG a spec draws.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { picture, progress, wrap } from "./picture.mjs";

const SPEC = {
  pillar: "Speed",
  area: "ci",
  metric: { label: "main red minutes", now: 40, goal: 0, unit: "min" },
  steps: [["Seen", "Two green PRs turned main red"], ["Change", "A merge queue on main"], ["Done when", "main stays green <always>"]],
};

describe("card picture", () => {
  it("wraps words to short lines and marks what it cut", () => {
    assert.deepEqual(wrap("one two three four", 9), ["one two", "three", "four"]);
    assert.deepEqual(wrap("one two three four five six", 9, 2), ["one two", "three…"]);
    assert.deepEqual(wrap("~/Developer/Claude-OS to", 9), ["~/Develop", "er/Claude", "-OS to"], "a word longer than the box is cut to fit");
    assert.deepEqual(wrap(""), []);
  });

  it("fills the meter by how far now is toward goal, either direction", () => {
    assert.equal(progress({ now: 77, goal: 100 }), 0.77);
    assert.equal(progress({ now: 150, goal: 75 }), 0.5, "lower is better");
    assert.equal(progress({ now: 5, goal: 5 }), 1);
    assert.equal(progress({ now: 5, goal: 0 }), 0);
    assert.equal(progress({ now: "not read", goal: 80 }), 0, "a value not read yet is no progress");
    assert.equal(progress({ now: "40", goal: "100" }), 0.4, "numbers given as text compare as numbers");
  });

  it("draws the pillar, the metric from now to goal and every step", () => {
    const svg = picture(SPEC);
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    for (const text of ["Speed", "ci", "main red minutes", ">40<", ">0<", "1  Seen", "2  Change", "3  Done when"]) assert.ok(svg.includes(text), text);
    assert.ok(svg.includes("&lt;always&gt;") && !svg.includes("<always>"), "text is escaped");
    assert.ok(svg.includes("prefers-color-scheme:dark"), "one file serves light and dark");
  });

  it("draws the steps alone when the card has no measured number", () => {
    const { metric: _metric, ...steps } = SPEC;
    assert.ok(!picture(steps).includes('class="track"'));
  });

  it("refuses a pillar or steps it cannot draw", () => {
    assert.throws(() => picture({ ...SPEC, pillar: "Luck" }), /pillar must be one of Quality, Speed, Consumption/);
    assert.throws(() => picture({ ...SPEC, steps: [] }), /steps must list 1 to 4/);
  });
});
