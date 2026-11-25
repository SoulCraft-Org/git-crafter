// node --test tools/apply_setup_personal.test.mjs
// templates/open/PERSONAL-PRIVATE.md names real setup.json rows and real stand-in files.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SETUP } from "./apply_setup.mjs";

const DOC_URL = new URL("../templates/open/PERSONAL-PRIVATE.md", import.meta.url);
const DOC = readFileSync(DOC_URL, "utf8");
const IDS = new Set(JSON.parse(readFileSync(SETUP, "utf8")).rows.map((r) => r.id));
const SKIPPED = [...DOC.matchAll(/^\| `([a-z_]+\.[a-z_]+)` \|/gm)].map((m) => m[1]);

test("the page names eight rows to skip, each a row of setup.json", () => {
  assert.equal(SKIPPED.length, 8);
  assert.equal(new Set(SKIPPED).size, SKIPPED.length);
  for (const id of SKIPPED) assert.ok(IDS.has(id), `${id} is not in setup.json`);
});

test("the free rows stay out of the skip list", () => {
  for (const id of ["security.dependabot_alerts", "security.dependabot_updates", "rules.default_branch"]) {
    assert.ok(IDS.has(id));
    assert.ok(!SKIPPED.includes(id), `${id} is free and must not be skipped`);
  }
});

test("every relative link on the page resolves", () => {
  const links = [...DOC.matchAll(/\]\((\.\.\/[^)#\s]+)\)/g)].map((m) => m[1]);
  assert.ok(links.length >= 2);
  for (const link of links) assert.ok(existsSync(fileURLToPath(new URL(link, DOC_URL))), `${link} is missing`);
});
