// Tests for the Blockers ledger drawing. Run with `node --test quality/render/ledger.test.mjs`;
// quality/selftest.mjs runs every render/*.test.mjs.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ledger, RANKED, ranked } from "./ledger.mjs";

const row = (label, group, tokens, hours, verdict, extra = {}) => ({ label, group, fires: 2, false_alarm: null, hours, tokens, verdict, ...extra });
const ROWS = [
  row("rules/<a>.md", "Tokens", 1_500_000, null, "costs"),
  row("guard: credential-file-read", "Speed", 3000, 0.5, "costs", { false_alarm: 62.5 }),
  row("pinned review", "Quality", null, 2, "helps", { false_alarm: 20 }),
  row("guard: git-push-main", "Speed", null, null, "not-measured", { fires: null }),
];

describe("ledger", () => {
  const html = ledger(ROWS);

  it("groups rows as Quality, Speed, Tokens, each under its own header row", () => {
    const groups = [...html.matchAll(/<th scope="rowgroup" colspan="6">(\w+)<\/th>/g)].map((m) => m[1]);
    assert.deepEqual(groups, ["Quality", "Speed", "Tokens"]);
    const table = html.slice(html.indexOf('<table class="lg">'));
    const at = (label) => table.indexOf(`<th scope="row">${label}`);
    assert.ok(at("pinned review") < at("guard: credential") && at("guard: credential") < at("rules/"), "rows sit under their group");
  });

  it("writes each verdict as a glyph and a word, and an unread number as a dash", () => {
    assert.match(html, /<td class="vd"><span><svg class="g" aria-hidden="true"><use href="#g-misses"\/><\/svg>costs<\/span><\/td>/);
    assert.match(html, /<use href="#g-meets"\/><\/svg>helps/);
    assert.match(html, /<use href="#g-not-measured"\/><\/svg>not measured/);
    assert.match(html, /<th scope="row">guard: git-push-main<\/th><td class="num">–<\/td><td class="num">–<\/td>/);
    assert.match(html, /<td class="num">62.5%<\/td>/);
    assert.match(html, /<td class="num">1.5M<\/td>/, "tokens compact");
  });

  it("escapes every label", () => {
    assert.ok(!html.includes("<a>"));
    assert.ok(html.includes("rules/&lt;a&gt;.md"));
  });

  it("ranks the costliest first, at most RANKED, leaving out what was not measured or cost nothing", () => {
    const many = Array.from({ length: RANKED + 3 }, (_, i) => row(`b${i}`, "Speed", (i + 1) * 10, 0, "costs"));
    const bars = ranked(many, "tokens", "tokens", "Tokens a week");
    const labels = [...bars.matchAll(/<th scope="row">(b\d+)<\/th>/g)].map((m) => m[1]);
    assert.equal(labels.length, RANKED);
    assert.equal(labels[0], `b${RANKED + 2}`);
    assert.equal(ranked(many, "hours", "h", "Hours a week"), "", "every hours value is 0");
    assert.equal(ranked(ROWS, "hours", "h", "Hours a week").match(/<tr>/g).length, 2);
  });
});
