// node --test quality/levels/org/collectors/org-rules/org-rules.test.mjs
// Every input is synthetic: a fake gh client answers from fixtures/org-rules.
import assert from "node:assert/strict";
import { test } from "node:test";

import { fakeGh, routes } from "../../../fake-gh.mjs";
import { area, collect, guardsDefault, metricIds, scope } from "./org-rules.mjs";

const GOOD = routes(new URL("../../fixtures/org-rules/good.json", import.meta.url));

test("org-rules: active rulesets on every repo, and one that guards the default branch", async () => {
  assert.deepEqual([area, scope], ["org-rules", "org"]);
  const out = await collect({ owner: "octo-org", gh: fakeGh(GOOD) });
  assert.deepEqual(Object.keys(out).sort(), [...metricIds].sort());
  assert.equal(out["org_rules.all_repo_rulesets"].value, 1, "the evaluate one and the docs-* one do not count");
  assert.deepEqual(out["org_rules.all_repo_rulesets"].detail, [{ label: "Every default branch", value: 1, unit: "ruleset" }]);
  assert.equal(out["org_rules.default_branch_guarded"].value, 1);
  assert.equal(out["org_rules.requests"].value, 3, "the list and two active rulesets");
});

test("org-rules: a plan or token without org rulesets is not measured, never 0", async () => {
  const out = await collect({ owner: "octo-org", gh: fakeGh({}, { status: 403 }) });
  for (const id of ["org_rules.all_repo_rulesets", "org_rules.default_branch_guarded"]) assert.match(out[id].could_not_check, /Team or Enterprise/, id);
  for (const id of metricIds) assert.match((await collect({ gh: fakeGh(GOOD) }))[id].could_not_check, /no org/);
});

test("org-rules: a ruleset missing the deletion rule does not guard the default branch", () => {
  const rs = structuredClone(GOOD["orgs/octo-org/rulesets/10"]);
  assert.equal(guardsDefault(rs), true);
  rs.rules = rs.rules.filter((x) => x.type !== "deletion");
  assert.equal(guardsDefault(rs), false);
});
