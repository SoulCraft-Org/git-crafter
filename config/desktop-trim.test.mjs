// The desktop app's per-repo trim (card "Desktop app setup: keep Git Crafter's plugin trim reproducible").
// The 94 plugin switches and 3 denied servers used to live only in the main checkout's git-ignored
// .claude/settings.local.json, so a fresh checkout loaded every plugin. They now live in the tracked
// .claude/settings.json, which every checkout and worktree has. Trim per repo only, never in
// ~/.claude/settings.json (owner, 2026-11-10).
//
// To rebuild the list: take the "unused" plugins from the Quality page's desktop-app tab
// (desktop_app.plugins_unused detail), add each as "<name>@<marketplace>": false under enabledPlugins,
// and list unused servers under deniedMcpServers, both in .claude/settings.json. Keep keys sorted.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const ROOT = new URL("../", import.meta.url).pathname;
const tracked = execFileSync("git", ["-C", ROOT, "ls-files", ".claude/settings.json"], { encoding: "utf8" }).trim();
const settings = JSON.parse(readFileSync(`${ROOT}.claude/settings.json`, "utf8"));
const plugins = Object.entries(settings.enabledPlugins ?? {});

test("the trim is a tracked file, so a fresh checkout has it", () => {
  assert.equal(tracked, ".claude/settings.json");
});

test("every listed plugin is switched off, so a fresh checkout reads 0 unused plugins loaded", () => {
  assert.ok(plugins.length >= 94, `expected at least 94 plugin switches, got ${plugins.length}`);
  for (const [name, on] of plugins) assert.equal(on, false, `${name} must be false`);
  assert.deepEqual(plugins.map(([n]) => n), plugins.map(([n]) => n).sort(), "keys stay sorted");
});

test("the three denied servers are listed", () => {
  const names = (settings.deniedMcpServers ?? []).map((s) => s.serverName).sort();
  assert.deepEqual(names, ["claude-design", "comfy-cloud", "comfy-mcp"]);
});

test("the trim is per repo: nothing here widens or narrows another repo", () => {
  assert.ok(!JSON.stringify(settings).includes("/.claude/"), "no user-scope paths");
  assert.ok(settings.permissions?.deny?.length > 0, "existing deny rules kept");
});
