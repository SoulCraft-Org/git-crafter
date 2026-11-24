// Tests for the GitHub collector's Caches metric. Run with `node --test quality/collectors/github/github-caches.test.mjs`.
// The fixture's repo holds 12 active caches of 3 GiB, against a 10 GB limit.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { REST, GRAPHQL, PARAMS, REPO, fakeGh, run } from "./github-test-lib.mjs";

const ID = "actions.cache_storage_pct";
const ROUTE = `repos/${REPO}/actions/cache/usage`;
const GIB = 1024 ** 3;
const LIMIT_ROUTE = `repos/${REPO}/actions/cache/storage-limit`;
const read = async ({ usage, params, limit } = {}) => {
  const rest = { ...REST, ...(usage ? { [ROUTE]: usage } : {}), ...(limit ? { [LIMIT_ROUTE]: limit } : {}) };
  return (await run({ gh: fakeGh({ rest, graphql: GRAPHQL }), ...(params ? { params: { ...PARAMS, ...params } } : {}) }))[ID];
};

describe("actions.cache_storage_pct", () => {
  it("reads the share of the limit the active caches fill", async () => {
    const out = await read();
    assert.equal(out.value, 30);
    assert.deepEqual(out.detail, [{ label: "stored", value: 3, unit: "GB" }, { label: "limit", value: 10, unit: "GB" }, { label: "active caches", value: 12, unit: "" }]);
  });

  it("follows params.cache_limit_gb, as a repo that raised its limit sets it", async () => {
    assert.equal((await read({ params: { cache_limit_gb: 30 } })).value, 10);
  });

  it("takes the limit the repo set in Actions settings over params.cache_limit_gb, and falls back when it cannot read it", async () => {
    const out = await read({ limit: { max_cache_size_gb: 30 } });
    assert.equal(out.value, 10);
    assert.deepEqual(out.detail[1], { label: "limit", value: 30, unit: "GB" });
    assert.equal((await read({ limit: { __error: { message: "Forbidden", status: 403 } } })).value, 30, "10 GB from params");
  });

  it("reads 0, not could_not_check, with no cache stored", async () => {
    const out = await read({ usage: { active_caches_size_in_bytes: 0, active_caches_count: 0 } });
    assert.equal(out.value, 0);
  });

  it("reads past 100 when the caches outgrow the limit", async () => {
    assert.equal((await read({ usage: { active_caches_size_in_bytes: 12 * GIB, active_caches_count: 40 } })).value, 120);
  });

  it("takes a failed read as could_not_check, never 0", async () => {
    const out = await read({ usage: { __error: { message: "Resource not accessible by integration", status: 403 } } });
    assert.ok(out.could_not_check && out.value === undefined);
  });
});
