// node --test quality/collectors/github/github-quota.test.mjs
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { headroom, readQuota, shortfall, spent } from "./github-quota.mjs";

const RESET = 1762880400; // 2025-11-11T17:00:00Z
const res = (core, graphql) => ({ core: { limit: 5000, remaining: core, reset: RESET }, graphql: { limit: 5000, remaining: graphql, reset: RESET } });

describe("github-quota", () => {
  it("reads rate_limit's resources and refuses a body without them", async () => {
    assert.deepEqual(await readQuota({ rest: async (r) => (r === "rate_limit" ? { resources: res(1, 2) } : null) }), res(1, 2));
    await assert.rejects(readQuota({ rest: async () => ({}) }), /no resources/);
  });

  it("headroom is the lower bucket's share left, one decimal", () => {
    const h = headroom(res(2638, 4517));
    assert.equal(h.value, 52.8);
    assert.deepEqual(h.detail.map((d) => [d.label, d.value]), [["REST requests left of 5000", 52.8], ["GraphQL points left of 5000", 90.3]]);
    assert.equal(headroom({ core: res(1, 1).core }), null);
  });

  it("spent is each bucket's fall, never below 0", () => {
    assert.deepEqual(spent(res(4850, 4783), res(2500, 4300)), { core: 2350, graphql: 483 });
    assert.deepEqual(spent(res(100, 100), res(4999, 5000)), { core: 0, graphql: 0 }, "a reset in between");
  });

  it("shortfall names each short bucket and its reset, null when the run fits", () => {
    assert.equal(shortfall(res(4850, 4783), { core: 2362, graphql: 483 }), null);
    assert.equal(shortfall(res(1000, 4783), { core: 2362, graphql: 483 }), "REST requests: 1000 left, a full run needs about 2362, resets 17:00 UTC");
    assert.match(shortfall({ core: res(9, 9).core }, { core: 1 }), /no graphql bucket/);
  });
});
