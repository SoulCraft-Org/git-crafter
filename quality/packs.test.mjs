// Packs (packs.mjs): which entries config takes, and a fixture pack's tab drawn on the Quality page.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildPage } from "./build.mjs";
import { runCollectors, runRecord, runText } from "./collect.mjs";
import { loadConfig, QUALITY } from "./config.mjs";
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
});

test("packs: a local path is a --local run's only; CI refuses it", () => {
  const root = repoWith([FIXTURE]);
  assert.throws(() => loadConfig({ root, env: {}, ci: true }), /only a --local run takes/);
  const config = loadConfig({ root, env: {} });
  assert.deepEqual(config.tabs.at(-1), ["fixture-pack", "Fixture pack"], "the pack's tab joins the default list");
  assert.deepEqual(config.packs[0].tabs, [["fixture-pack", "Fixture pack"]]);
});

test("packs: the fixture pack's tab and collector draw on the Quality page", async () => {
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
  for (const text of ["Fixture pack", "Fixture steps done"]) assert.ok(page.html.includes(text), `the page shows "${text}"`);
});
