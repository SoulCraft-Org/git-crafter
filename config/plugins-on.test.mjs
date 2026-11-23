// Every plugin stays on in this repo (owner, 2026-11-23): Claudius "All on, app-wide".
// .claude/settings.json lists no plugin set to false, so a fresh checkout loads every plugin the
// account has installed. The five below are named on purpose, so they stay on in a session
// opened here. Do not add "claudius": public repos refuse that org name.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const ROOT = new URL("../", import.meta.url).pathname;
const tracked = execFileSync("git", ["-C", ROOT, "ls-files", ".claude/settings.json"], { encoding: "utf8" }).trim();
const settings = JSON.parse(readFileSync(`${ROOT}.claude/settings.json`, "utf8"));
const plugins = Object.entries(settings.enabledPlugins ?? {});
const NAMED_ON = [
  "feature-dev@claude-plugins-official",
  "code-review@claude-plugins-official",
  "pr-review-toolkit@claude-plugins-official",
  "session-report@claude-plugins-official",
  "claude-md-management@claude-plugins-official",
];

test("the settings are a tracked file, so a fresh checkout has them", () => {
  assert.equal(tracked, ".claude/settings.json");
});

test("no plugin is set to false, so every plugin stays on", () => {
  for (const [name, on] of plugins) assert.notEqual(on, false, `${name} must not be false`);
  assert.deepEqual(plugins.filter(([, on]) => on !== true), [], "every listed plugin is true");
  assert.deepEqual(plugins.map(([n]) => n), plugins.map(([n]) => n).sort(), "keys stay sorted");
});

test("the five named plugins are on", () => {
  for (const name of NAMED_ON) assert.equal(settings.enabledPlugins?.[name], true, `${name} must be true`);
});

test("claudius is not listed: public repos refuse that org name", () => {
  assert.ok(!plugins.some(([n]) => n.includes("claudius")), "no claudius entry");
});

test("the three denied servers are listed", () => {
  const names = (settings.deniedMcpServers ?? []).map((s) => s.serverName).sort();
  assert.deepEqual(names, ["claude-design", "comfy-cloud", "comfy-mcp"]);
});

test("the settings stay per repo: nothing here widens or narrows another repo", () => {
  assert.ok(!JSON.stringify(settings).includes("/.claude/"), "no user-scope paths");
  assert.ok(settings.permissions?.deny?.length > 0, "existing deny rules kept");
});
