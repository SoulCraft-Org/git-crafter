// The v7.0.0 tab re-map loses no metric silently: every id at v6.0.0, the
// template's and Git Crafter's own page's, has a row in ledger/tab-remap.json
// with its old tab, its new home and a status, and the targets agree.
// Run with: node --test quality/ledger.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { loadConfig } from "./config.mjs";
import { loadDefs, TABS } from "./score.mjs";

const read = (f) => JSON.parse(readFileSync(new URL(`./ledger/${f}`, import.meta.url), "utf8"));
const SNAP = read("v6.0.0-ids.json");
const LEDGER = read("tab-remap.json");
const TEMPLATE = new URL("./targets/", import.meta.url).pathname;
const tabOf = (defs) => new Map(defs.map((d) => [d.id, d.tab]));
// Each id at v6.0.0 by its tab then.
const was = (part) => new Map(Object.entries(SNAP[part]).flatMap(([tab, ids]) => ids.map((id) => [id, tab])));
// Each ledger row's ids, by id; an id in two rows is a usage error.
function rowsById(rows) {
  const out = new Map();
  for (const r of rows) for (const id of r.ids) {
    assert.ok(!out.has(id), `${id} is in two ledger rows`);
    out.set(id, r);
  }
  return out;
}

// Whether a row's status fits its tabs, and its home holds the id now.
function checkRow(id, r, from, now) {
  assert.equal(r.from, from ?? null, `${id}: old tab`);
  if (r.status === "dropped") return assert.ok(r.reason?.trim(), `${id}: a drop gives its reason`);
  if (r.to.startsWith("pack ")) {
    assert.equal(r.status, "moved", `${id}: a move to a pack is moved`);
    return assert.ok(!now.has(id), `${id}: moved to a pack, still here`);
  }
  assert.equal(r.status, from === undefined ? "new" : from === r.to ? "kept" : "moved", `${id}: status`);
  assert.equal(now.get(id), r.to, `${id}: not in the targets under tab ${r.to}`);
}

test("every template id at v6.0.0, and every new one, has its row, and the targets agree", () => {
  const before = was("template");
  assert.equal(before.size, 184, "the snapshot holds the 184 template ids at v6.0.0");
  const now = tabOf(loadDefs({ templateDir: TEMPLATE, tabs: TABS }).all);
  const rows = rowsById(LEDGER.template);
  for (const id of new Set([...before.keys(), ...now.keys()])) {
    assert.ok(rows.has(id), `${id} is missing from the ledger`);
    checkRow(id, rows.get(id), before.get(id), now);
  }
  for (const r of LEDGER.template) assert.ok(TABS.some(([t]) => t === r.to) || r.to.startsWith("pack ") || r.status === "dropped", `${r.to}: no such tab`);
});

test("every id Git Crafter's own page scored at v6.0.0 has a home or a recorded drop", () => {
  const before = was("own");
  assert.equal(before.size, 156, "the snapshot holds the 156 ids the page scored at v6.0.0");
  const config = loadConfig({ root: new URL("..", import.meta.url).pathname, file: "config/quality.json", env: {} });
  const now = tabOf(loadDefs({ templateDir: TEMPLATE, repoDir: config.targets, tabs: config.tabs }).defs);
  const own = rowsById(LEDGER.own);
  const template = rowsById(LEDGER.template);
  for (const id of new Set([...before.keys(), ...now.keys()])) {
    const r = own.get(id) ?? (before.has(id) ? template.get(id) : undefined);
    assert.ok(r, `${id} is on the page now and in no own row as new`);
    checkRow(id, r, before.get(id), now);
  }
});
