// Tests for the Credits tab's allowance table. Run with `node --test quality/render/credits.test.mjs`;
// quality/selftest.mjs runs every render/*.test.mjs.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { credits, order } from "./credits.mjs";

const row = (label, status, extra = {}) => ({ label, lane: "ci", allowance: 3000, unit: "minutes", used: 100, unused: 2900, status, replaces: false, could_take_over: "", claim_needs: "", ...extra });

describe("credits", () => {
  const rows = [row("Comfy", "idle", { lane: "gpu" }), row("Actions", "over", { allowance: 300, unit: "USD", used: 310, used_share: 103.3, pool: true }), row("Tenki", "unclaimed", { replaces: true, allowance: null, used: null, unused: null, per: "One-time $100 credit", claim_needs: "an owner signs up" }), row("<x>", "not read", { used: null, unused: null })];

  it("puts the CI pools first, then the rows the goal counts, then by status", () => {
    assert.deepEqual(order(rows).map((r) => r.label), ["Actions", "Tenki", "Comfy", "<x>"]);
  });

  it("draws one row per allowance with its status as a glyph and a word", () => {
    const html = credits(rows);
    assert.equal((html.match(/<tr><th scope="row">/g) ?? []).length, 4);
    assert.match(html, /unclaimed, could take over/);
    assert.match(html, /310 USD \(103%\)/);
    assert.match(html, /One-time \$100 credit/);
    assert.ok(!html.includes("<x>") && html.includes("&lt;x&gt;"));
    assert.match(html, /class="pbar"/);
  });

  it("marks a floor reading as at least, its unused part unknown", () => {
    assert.match(credits([row("Blacksmith", "not read", { used: 1587, used_floor: true, unused: null, used_share: 52.9 })]), /at least 1,587 minutes<\/td><td class="num">–/);
  });
});
