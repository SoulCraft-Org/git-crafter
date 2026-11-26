// node --test quality/levels/org/collectors/org-security/org-security.test.mjs
// Every input is synthetic: a fake gh client answers from fixtures/org-security.
import assert from "node:assert/strict";
import { test } from "node:test";

import { fakeGh, routes } from "../../../fake-gh.mjs";
import { area, collect, coversAll, metricIds, scope } from "./org-security.mjs";

const GOOD = routes(new URL("../../fixtures/org-security/good.json", import.meta.url));

test("org-security: an owner's token reads 2FA required and a default configuration", async () => {
  assert.deepEqual([area, scope], ["org-security", "org"]);
  const out = await collect({ owner: "octo-org", gh: fakeGh(GOOD) });
  assert.deepEqual(Object.keys(out).sort(), [...metricIds].sort());
  assert.equal(out["org_security.two_factor_required"].value, 1);
  assert.equal(out["org_security.new_repo_security_config"].value, 1);
  assert.equal(out["org_security.requests"].value, 2);
  assert.ok(out["org_security.read_seconds"].value >= 0);
});

test("org-security: a member's token is not measured, never 0", async () => {
  const out = await collect({ owner: "octo-org", gh: fakeGh({ "orgs/octo-org": { login: "octo-org" } }, { status: 403 }) });
  assert.match(out["org_security.two_factor_required"].could_not_check, /admin:org/);
  assert.match(out["org_security.new_repo_security_config"].could_not_check, /security manager/);
});

test("org-security: no org, or an org gh cannot read, is not measured", async () => {
  for (const id of metricIds) assert.match((await collect({ gh: fakeGh(GOOD) }))[id].could_not_check, /no org/);
  for (const id of metricIds) assert.match((await collect({ owner: "gone", gh: fakeGh({}) }))[id].could_not_check, /orgs\/gone/);
});

test("org-security: a default for public repos alone does not cover private ones", () => {
  assert.equal(coversAll([{ default_for_new_repos: "public" }]), false);
  assert.equal(coversAll([{ default_for_new_repos: "all" }]), true);
  assert.equal(coversAll([]), false);
});
