// node --test quality/levels/org/collectors/org-members/org-members.test.mjs
// Every input is synthetic: a fake gh client answers from fixtures/org-members.
import assert from "node:assert/strict";
import { test } from "node:test";

import { fakeGh, routes } from "../../../fake-gh.mjs";
import { area, collect, metricIds, scope } from "./org-members.mjs";

const GOOD = routes(new URL("../../fixtures/org-members/good.json", import.meta.url));

test("org-members: members without 2FA are counted, and a write base permission misses", async () => {
  assert.deepEqual([area, scope], ["org-members", "org"]);
  const out = await collect({ owner: "octo-org", gh: fakeGh(GOOD) });
  assert.deepEqual(Object.keys(out).sort(), [...metricIds].sort());
  assert.equal(out["org_members.without_2fa"].value, 2);
  assert.equal(out["org_members.base_permission_least"].value, 0);
  assert.ok(!JSON.stringify(out).includes("member-one"), "a count, never a login");
  assert.equal(out["org_members.requests"].value, 2);
});

test("org-members: a token that is not an owner's is not measured, never 0", async () => {
  const out = await collect({ owner: "octo-org", gh: fakeGh({ "orgs/octo-org": { login: "octo-org" } }, { status: 422 }) });
  assert.match(out["org_members.without_2fa"].could_not_check, /owners only/);
  assert.match(out["org_members.base_permission_least"].could_not_check, /admin:org/);
  for (const id of metricIds) assert.match((await collect({ gh: fakeGh(GOOD) }))[id].could_not_check, /no org/);
});
