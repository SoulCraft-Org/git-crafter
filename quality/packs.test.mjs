// Packs (packs.mjs): which entries config takes, the checkouts actions/pages
// makes, and a fixture pack's tab and map drawn on the Quality and Process pages.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { qualityDefs } from "../pages/build.mjs";
import { mapsTab } from "../pages/maps-tab.mjs";
import { readDocs } from "../tools/org_scope.mjs";
import { buildPage } from "./build.mjs";
import { runCollectors, runRecord, runText } from "./collect.mjs";
import { loadConfig, QUALITY } from "./config.mjs";
import { checkoutLines } from "./pack-checkouts.mjs";
import { configDefs, resolvePacks } from "./packs.mjs";

const FIXTURE = join(QUALITY, "fixtures", "pack");
const SHA = "0123456789abcdef0123456789abcdef01234567";

// A repo root whose quality/config.json names these packs.
function repoWith(packs) {
  const root = mkdtempSync(join(tmpdir(), "packs-"));
  mkdirSync(join(root, "quality"));
  writeFileSync(join(root, "quality", "config.json"), JSON.stringify({ packs }));
  return root;
}

test("packs: a full SHA is taken; a tag, a branch or a short SHA is refused with the reason", () => {
  const [pack] = resolvePacks([`octo/pack@${SHA}`], { root: "/r", env: { CODE_OS_PACKS: "/p" }, ci: true });
  assert.equal(pack.dir, "/p/octo/pack");
  assert.equal(pack.collectors, "/p/octo/pack/collectors");
  for (const spec of ["octo/pack@v1.2.0", "octo/pack@main", `octo/pack@${SHA.slice(0, 39)}`]) {
    assert.throws(() => resolvePacks([spec], { root: "/r", env: {} }), /full 40-hex commit SHA after @, not a tag or branch/, spec);
  }
  assert.throws(() => resolvePacks([""], { root: "/r", env: {} }), /packs must list/);
  assert.deepEqual(checkoutLines({ packs: [pack] }), [`octo/pack ${SHA} /p/octo/pack`], "actions/pages fetches it at its SHA");
});

test("packs: a local path is a --local run's only; CI refuses it", () => {
  const root = repoWith([FIXTURE]);
  assert.throws(() => loadConfig({ root, env: {}, ci: true }), /only a --local run takes/);
  const config = loadConfig({ root, env: {} });
  assert.deepEqual(config.tabs.at(-1), ["fixture-pack", "Fixture pack"], "the pack's tab joins the default list");
  assert.deepEqual(config.packs[0].tabs, [["fixture-pack", "Fixture pack"]]);
});

test("packs: a pack that is not checked out is a usage error, never an empty tab", () => {
  const config = loadConfig({ root: repoWith([`octo/pack@${SHA}`]), env: { CODE_OS_PACKS: join(tmpdir(), "no-packs-here") } });
  assert.throws(() => configDefs(config, join(QUALITY, "targets")), /pack octo\/pack@\w+ is not at/);
});

test("packs: the fixture pack's tab, collector and ideal draw on the Quality page", async () => {
  const root = repoWith([FIXTURE]);
  const config = loadConfig({ root, env: {} });
  const loaded = configDefs(config, join(QUALITY, "targets"));
  const defs = loaded.defs.filter((d) => d.tab === "fixture-pack");
  assert.deepEqual(defs.map((d) => d.id), ["fixture_pack.done_share"]);
  const { metrics, ran } = await runCollectors({ root, mode: "ci", dirs: config.packs.map((p) => p.collectors), defs, all: loaded.all, params: loaded.params, data: config.data });
  assert.deepEqual(ran, ["fixture-pack"]);
  assert.equal(metrics["fixture_pack.done_share"].value, 75, "the collector read its params through lib");
  mkdirSync(config.data, { recursive: true });
  writeFileSync(join(config.data, "latest.json"), runText(runRecord({ metrics, ran, mode: "ci", defs: loaded.defs })));
  const page = buildPage(config);
  assert.equal(page.code, 0);
  for (const text of ["Fixture pack", "Fixture steps done", "A pack adds a tab to any repo&#39;s page"]) assert.ok(page.html.includes(text), `the page shows "${text}"`);
});

test("packs: the fixture pack's map draws on the Process page, its step rated by the pack's metric", () => {
  const root = repoWith([FIXTURE]);
  writeFileSync(join(root, "maps.json"), JSON.stringify({ repo_url: "https://github.com/octo/repo", maps: [{ use: "fixture-map" }] }));
  const top = join(QUALITY, "..");
  const docs = readDocs(root, { goals: join(top, "goals.json"), process: join(top, "process.json"), maps: "maps.json" });
  assert.deepEqual(docs.maps.maps.map((m) => m.library), ["fixture-map"]);
  const { defs } = qualityDefs(root);
  assert.equal(defs["fixture_pack.done_share"]?.tab, "fixture-pack");
  const html = mapsTab({ metrics: {} }, docs.goals, docs.maps, defs, ["repo"], null);
  for (const text of ["Fixture map", "Fixture step", "Each fixture step is done."]) assert.ok(html.includes(text), `the map shows "${text}"`);
});
