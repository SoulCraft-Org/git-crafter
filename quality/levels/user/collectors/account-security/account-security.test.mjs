// node --test quality/levels/user/collectors/account-security/account-security.test.mjs
// Every input is synthetic: a fake gh client answers from fixtures/account-security.
import assert from "node:assert/strict";
import { test } from "node:test";

import { fakeGh, routes } from "../../../fake-gh.mjs";
import { area, collect, metricIds, scope } from "./account-security.mjs";

const GOOD = routes(new URL("../../fixtures/account-security/good.json", import.meta.url));

test("account-security: the signed-in user's 2FA and signing keys", async () => {
  assert.deepEqual([area, scope], ["account-security", "user"]);
  const out = await collect({ gh: fakeGh(GOOD) });
  assert.deepEqual(Object.keys(out).sort(), [...metricIds].sort());
  assert.equal(out["account_security.two_factor_on"].value, 1);
  assert.equal(out["account_security.signing_keys"].value, 3);
  assert.equal(out["account_security.requests"].value, 3);
});

test("account-security: another login's 2FA is not measured; no gh sign-in is not measured", async () => {
  const other = await collect({ owner: "someone-else", gh: fakeGh(GOOD) });
  assert.match(other["account_security.two_factor_on"].could_not_check, /account itself only/);
  assert.match(other["account_security.signing_keys"].could_not_check, /404/, "that login's keys are not in the fixture");
  for (const id of metricIds) assert.match((await collect({ gh: fakeGh({}, { status: 401 }) }))[id].could_not_check, /gh api user/);
});
