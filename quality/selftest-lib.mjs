// Shared fixtures and the check registry for the Quality selftest
// (selftest.mjs, selftest-repo.mjs).

import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadTargets } from "./score.mjs";
import { stripAll } from "./collectors/lib/strip.mjs";

export const up = { id: "t.up", tab: "code", kind: "quality", label: "Pass rate", unit: "%", goal: 90, near: 70, direction: "higher", goal_source: "fixture" };
export const down = { id: "t.down", tab: "code", kind: "speed", label: "Build time", unit: "s", goal: 60, near: 120, direction: "lower", goal_source: "fixture" };
export const blind = { id: "t.blind", tab: "code", kind: "quality", label: "Coverage", unit: "%", goal: 80, near: 60, direction: "higher", goal_source: "fixture" };
export const at = "2026-11-02T20:00:00Z";
// A fixture metric entry with this value, read at the fixture time.
export const val = (value, extra = {}) => ({ value, source: "fixture", read_at: at, ...extra });

// The page as a reader sees it: markup without the client script's source and
// the review JSON (whose escaping has its own check).
export const shown = (html) => stripAll(html, /<script\b[\s\S]*?<\/script\b[^>]*>/gi);

// One targets file in a fresh temp folder, for loadTargets.
export const writeTargets = (list) => {
  const dir = mkdtempSync(join(tmpdir(), "quality-targets-"));
  writeFileSync(join(dir, "a.json"), JSON.stringify(list));
  return dir;
};
export const checks = [];
// Registers a self-test; selftest.mjs runs every one in order.
export const check = (name, fn) => checks.push([name, fn]);
const SEED_COLLECTOR = `const at = "2026-11-03T12:00:00Z";
export async function collect({ root, mode, params, targets, allParams }) {
  return {
    "s.good": { value: 95, source: "seed", read_at: at },
    "s.bad": { value: 10, source: "seed", read_at: at },
    "s.blind": { could_not_check: "the seed has no tool for this", source: "seed" },
    "s.fast": { value: 40, source: "seed", read_at: at },
    "s.dropme": { value: 100, source: "seed", read_at: at },
    "s.echo": { value: 1, read_at: at, source: JSON.stringify({ root, mode, params, targets: targets.map((t) => t.id), allParams }) },
  };
}
`;

// A template and a repo in temp folders: the template's targets and one
// collector, the repo's config, overrides, own metric and own collector.
export function seedRepo() {
  const base = mkdtempSync(join(tmpdir(), "quality-seed-"));
  const template = join(base, "template");
  const root = join(base, "repo");
  const q = (def) => ({ tab: "code", kind: "quality", unit: "%", goal: 90, near: 70, direction: "higher", goal_source: "seed", ...def });
  const files = {
    [join(template, "targets", "seed.json")]: [
      q({ id: "s.good", label: "Good", params: { path: "template", keep: 1 } }),
      q({ id: "s.bad", label: "Bad" }),
      q({ id: "s.blind", label: "Blind" }),
      q({ id: "s.silent", label: "Never reported" }),
      q({ id: "s.dropme", label: "Dropped by the repo" }),
      q({ id: "s.web", tab: "design", label: "A web metric" }),
      q({ id: "s.echo", tab: "design", label: "What the collector got, on a tab the repo does not show" }),
      { id: "s.fast", tab: "code", kind: "speed", unit: "s", goal: 60, near: 120, direction: "lower", goal_source: "seed", label: "Fast" },
    ],
    [join(root, "quality", "targets", "seed.json")]: [
      { id: "s.fast", goal: 30, near: 45, goal_source: "the repo's own goal" },
      { id: "s.good", params: { path: "repo" } },
      { id: "s.dropme", drop: true },
    ],
    [join(root, "quality", "targets", "own.json")]: [
      { id: "own.count", tab: "code", kind: "speed", unit: "", goal: 5, near: 10, direction: "lower", goal_source: "seed", label: "The repo's own", params: { reviewer: "a-bot" } },
    ],
    [join(template, "ideals", "code.json")]: { ideal: "Code a newcomer can change safely the same day.", sources: [{ title: "Template guide", url: "https://example.org/template-ideal", date: "2026-01-15" }], quality: "Template quality line." },
    [join(root, "quality", "ideals", "code.json")]: {
      ideal: "The repo's own ideal for its code.",
      sources: [{ title: "Newest guide's notes", url: "https://example.org/repo-ideal", date: "2026-10-01" }, { title: "Older guide", url: "https://example.org/older", date: "2025-06-30" }],
      quality: "Every change ships with its test.",
      consumption: "Nothing ships that no page uses.",
    },
    [join(root, "quality", "config.json")]: { repo: "example/seed", targets: "quality/targets", collectors: "quality/collectors" },
  };
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify(body));
  }
  mkdirSync(join(template, "collectors"), { recursive: true });
  mkdirSync(join(root, "quality", "collectors"), { recursive: true });
  writeFileSync(join(template, "collectors", "seed.mjs"), SEED_COLLECTOR);
  writeFileSync(join(root, "quality", "collectors", "own.mjs"), 'export async function collect() { return { "own.count": { value: 3, source: "seed", read_at: "2026-11-03T12:00:00Z" } }; }\n');
  return { base, template, root };
}
