// Tests for the Tokens tab's repo split. Run with `node --test quality/render/repos.test.mjs`;
// quality/selftest.mjs runs every render/*.test.mjs.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { COLUMNS, repos } from "./repos.mjs";

const row = (label, value, extra = {}) => ({ label, value, unit: "tokens", merged: 2, tokens_per_pr: 1_500_000, cache_read_share: 91.2, waste_share: null, latest_rework: 0, per_hour: 2_100_000, ...extra });

describe("repos", () => {
  const html = repos([row("example-site", 60_000_000), row("code-os", 9_000_000, { merged: 0, tokens_per_pr: null }), row("<x>", 1)]);

  it("draws one stacked bar of tokens by repo and one table row per repo", () => {
    assert.match(html, /<span class="pbar" role="img" aria-label="example-site 87%, code-os 13%, &lt;x&gt; &lt;1%">/);
    assert.equal((html.match(/<tr><th scope="row">/g) ?? []).length, 3);
    assert.equal((html.match(/<th scope="col">/g) ?? []).length, COLUMNS.length + 1);
  });

  it("writes an unread number as a dash, a zero as 0, and escapes names", () => {
    assert.match(html, /<th scope="row">code-os<\/th><td class="num">9M<\/td><td class="num">0<\/td><td class="num">–<\/td>/);
    assert.match(html, /<td class="num">91.2%<\/td><td class="num">–<\/td><td class="num">0<\/td>/);
    assert.ok(!html.includes("<x>"));
  });
});
