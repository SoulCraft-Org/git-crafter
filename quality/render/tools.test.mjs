// Tests for the Tools tab's dependency table. Run with `node --test quality/render/tools.test.mjs`;
// quality/selftest.mjs runs every render/*.test.mjs.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { order, tools } from "./tools.mjs";

const row = (label, status, extra = {}) => ({ label, where: "site", installed: "1.0.0", eligible: "1.0.0", newest: "1.0.1", status, majors_behind: 0, waiting_days: null, ...extra });

describe("tools", () => {
  const rows = [row("a", "current"), row("b", "behind", { eligible: "2.0.0", majors_behind: 1, waiting_days: 3 }), row("<c>", "too new"), row("d", "behind", { waiting_days: 40 }), row("e", "not read", { eligible: null })];

  it("lists behind first, the longest wait on top, then too new, current, not read", () => {
    assert.deepEqual(order(rows).map((r) => r.label), ["d", "b", "<c>", "a", "e"]);
  });

  it("draws a row per dependency, links the Security tab, and escapes names", () => {
    const html = tools(rows);
    assert.equal((html.match(/<tr><th scope="row">/g) ?? []).length, 5);
    assert.match(html, /href="#security"/);
    assert.match(html, /40 days/);
    assert.ok(!html.includes("<c>") && html.includes("&lt;c&gt;"));
    assert.ok(!/NaN|undefined/.test(html));
  });
});
