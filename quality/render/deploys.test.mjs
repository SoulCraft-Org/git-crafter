// Tests for the Deploy tab's deploy list. Run with `node --test quality/render/deploys.test.mjs`;
// quality/selftest.mjs runs every render/*.test.mjs.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { deploys } from "./deploys.mjs";

const row = (label, extra = {}) => ({ label, value: 3, unit: "merges", commit: "abc1234", commit_from: "time", lead_hours: 1.5, rollback: false, failed: null, restore_hours: null, ...extra });

describe("deploys", () => {
  const html = deploys([row("2026-11-01 10:00"), row("2026-11-02 10:00", { failed: "issue #9 names PR #8", restore_hours: 4, commit_from: "tag" }), row("2026-11-02 14:00", { rollback: true, value: 0, lead_hours: null })]);

  it("lists deploys newest first with each result as a glyph and a word", () => {
    const order = [...html.slice(html.indexOf("lg dp")).matchAll(/<tr><th scope="row">([^<]+)</g)].map((m) => m[1]);
    assert.deepEqual(order, ["2026-11-02 14:00", "2026-11-02 10:00", "2026-11-01 10:00"]);
    assert.match(html, /rollback<\/span>/);
    assert.match(html, /failed: issue #9 names PR #8/);
    assert.match(html, /version tag/);
  });

  it("writes an unread number as a dash", () => {
    assert.match(html, /<td class="num">0<\/td><td class="num">–<\/td>/);
    assert.ok(!/NaN|undefined/.test(html));
  });
});
