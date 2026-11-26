// node --test quality/levels/user/collectors/email-privacy/email-privacy.test.mjs
// Every input is synthetic: a fake gh client answers from fixtures/email-privacy.
import assert from "node:assert/strict";
import { test } from "node:test";

import { fakeGh, routes } from "../../../fake-gh.mjs";
import { area, collect, metricIds, personal, scope } from "./email-privacy.mjs";

const GOOD = routes(new URL("../../fixtures/email-privacy/good.json", import.meta.url));

test("email-privacy: a private primary email, and one personal address in recent commits", async () => {
  assert.deepEqual([area, scope], ["email-privacy", "user"]);
  const out = await collect({ gh: fakeGh(GOOD) });
  assert.deepEqual(Object.keys(out).sort(), [...metricIds].sort());
  assert.equal(out["email_privacy.primary_private"].value, 1);
  assert.equal(out["email_privacy.personal_commit_emails"].value, 1, "one address, case folded");
  assert.ok(!JSON.stringify(out).includes("mail.example"), "a count, never an address");
  assert.equal(out["email_privacy.requests"].value, 3);
});

test("email-privacy: a token without user:email is not measured, never 0", async () => {
  const { "user/emails?per_page=100": _, ...rest } = GOOD;
  const out = await collect({ gh: fakeGh(rest, { status: 403 }) });
  assert.match(out["email_privacy.primary_private"].could_not_check, /user:email/);
  assert.equal(out["email_privacy.personal_commit_emails"].value, 1, "public commits read with any token");
  for (const id of metricIds) assert.match((await collect({ gh: fakeGh({}) }))[id].could_not_check, /gh api user/);
});

test("email-privacy: personal is any address but GitHub noreply", () => {
  assert.deepEqual(["1+a@users.noreply.github.com", "noreply@github.com", "me@mail.example", ""].map(personal), [false, false, true, false]);
});
