// node --test quality/levels/levels.test.mjs
// The built-in level packs (quality/levels/README.md): each tab has an ideal
// and all three kinds, each pack's map passes the library checks and links
// every tab, and a sample run builds the page under its byte budget.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { checkLibrary } from "../../pages/checks.mjs";
import { loadLibrary } from "../../pages/library.mjs";
import { buildPage, sizeCheck } from "../build.mjs";
import { runCollectors, runRecord, runText } from "../collect.mjs";
import { loadConfig, QUALITY } from "../config.mjs";
import { configDefs, configIdeals } from "../packs.mjs";
import { tabGaps } from "../score.mjs";

const LEVELS = { org: { owner: "octo-org" }, user: {} };

// A repo root whose quality config names this level, read from the real built-in packs.
function levelConfig(level) {
  const root = mkdtempSync(join(tmpdir(), `level-${level}-`));
  mkdirSync(join(root, "quality"));
  writeFileSync(join(root, "quality", "config.json"), JSON.stringify({ level, ...LEVELS[level] }));
  return loadConfig({ root, env: {}, ci: true });
}

for (const level of Object.keys(LEVELS)) {
  test(`levels: the ${level} pack's tabs each have an ideal and score quality, speed and consumption`, () => {
    const config = levelConfig(level);
    const { defs } = configDefs(config, join(QUALITY, "targets"));
    const own = defs.filter((d) => config.tabs.some(([id]) => id === d.tab));
    assert.ok(config.tabs.length >= 2, "the pack names its tabs");
    assert.deepEqual(tabGaps(config.tabs, own, configIdeals(config, join(QUALITY, "ideals"))), []);
    for (const [tab] of config.tabs) {
      const n = own.filter((d) => d.tab === tab).length;
      assert.ok(n >= 3 && n <= 4, `${tab} has ${n} metrics`);
    }
    for (const d of own) assert.match(d.goal_source, /https:\/\/docs\.github\.com\/\S+, read 2026-11-26/, d.id);
  });

  test(`levels: the ${level} pack's map passes the library checks and links every tab`, () => {
    const config = levelConfig(level);
    const { defs } = configDefs(config, join(QUALITY, "targets"));
    const library = loadLibrary(undefined, config.packs.map((p) => p.maps));
    const kindOf = Object.fromEntries(defs.map((d) => [d.id, d.kind]));
    const tabOf = Object.fromEntries(defs.map((d) => [d.id, d.tab]));
    const mine = Object.fromEntries(Object.entries(library).filter(([, m]) => m.steps.every((s) => config.tabs.some(([id]) => id === tabOf[s.metric]))));
    assert.equal(Object.keys(mine).length, 1, "one map per pack");
    assert.deepEqual(checkLibrary(mine, new Set(defs.map((d) => d.id)), kindOf), []);
    const linked = new Set(Object.values(mine)[0].steps.map((s) => tabOf[s.metric]));
    for (const [tab] of config.tabs) assert.ok(linked.has(tab), `the map links ${tab}`);
  });

  test(`levels: a sample run of the ${level} pack builds the page under its byte budget`, async () => {
    const config = levelConfig(level);
    const loaded = configDefs(config, join(QUALITY, "targets"));
    const { metrics, ran } = await runCollectors({ root: config.root, mode: "ci", dirs: config.packs.map((p) => p.collectors), defs: loaded.defs, all: loaded.all, params: loaded.params, data: config.data, level, owner: config.owner, sample: true });
    assert.equal(ran.length, config.tabs.length, "one collector per tab");
    for (const d of loaded.defs) assert.ok(metrics[d.id] && "value" in metrics[d.id], `${d.id} has a sample value`);
    mkdirSync(config.data, { recursive: true });
    writeFileSync(join(config.data, "latest.json"), runText(runRecord({ metrics, ran, mode: "ci", defs: loaded.defs, sample: true })));
    const page = buildPage(config);
    assert.equal(page.code, 0);
    assert.ok(sizeCheck(page.html, config.budget).ok);
    for (const [, name] of config.tabs) assert.ok(page.html.includes(name), `the page shows ${name}`);
  });
}
