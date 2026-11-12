// Shared helpers for the Code collector (code.mjs): running commands, result
// rows, small arithmetic and the folder walkers.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { CODE_EXTENSIONS } from "./complexity.mjs";
import { firstLine, isDir, measured, runCommand, unknown } from "../run.mjs";

// The run helpers live in ../run.mjs, which imports no package, so a collector
// outside the Code tab can use them without typescript (issue #715).
export { firstLine, isDir, measured, runCommand, unknown };

// Every id as could_not_check with one reason and source.
export function unknownAll(ids, reason, source) {
  return Object.fromEntries(ids.map((id) => [id, unknown(reason, source)]));
}

// The percent of items marked documented, with one detail row per group.
export function share(items, source, groups, inGroup) {
  if (!items.length) return unknown("nothing to count", source);
  const pct = (list) => round((100 * list.filter((x) => x.documented).length) / list.length, 1);
  const detail = groups
    .map((label) => ({ label, list: items.filter((x) => inGroup(x, label)) }))
    .filter((g) => g.list.length)
    .map((g) => ({ label: g.label, value: pct(g.list) }));
  return measured(pct(items), `${source}; ${items.filter((x) => x.documented).length} of ${items.length}`, detail);
}

// The first n rows of a list, each shaped by row.
export function top(list, row, n = 15) {
  return list.slice(0, n).map(row);
}

// [key, count] pairs of a list, largest count first.
export function countBy(list, key) {
  const counts = new Map();
  for (const x of list) counts.set(key(x), (counts.get(key(x)) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]);
}

// The sum of one field over a list.
export function sum(list, key) {
  return list.reduce((n, x) => n + x[key], 0);
}

// Rounds to places decimals.
export function round(n, places) {
  return Math.round(n * 10 ** places) / 10 ** places;
}

// Wrangler prints its warnings before the error that stopped it, so the
// reason is the first [ERROR] in stderr or stdout, color codes removed. When
// the [ERROR] line holds only the marker, the message is the next non-empty
// line. With no [ERROR], it is the first line of stderr, else of stdout.
export function errorLine(...outputs) {
  const texts = outputs.map((t) => (t ?? "").replace(/\x1b\[[0-9;]*m/g, ""));
  for (const text of texts) {
    const lines = text.split("\n");
    const at = lines.findIndex((l) => /\[ERROR\]/.test(l));
    if (at >= 0) return firstLine([lines[at].replace(/^\W*\[ERROR\]\s*/, ""), ...lines.slice(at + 1)].join("\n"));
  }
  return firstLine(texts.find((t) => t.trim()));
}

// A JSON file parsed, or null when it is missing or not JSON.
export function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

// A Worker folder's wrangler.jsonc or wrangler.json, comments allowed; null
// when there is neither.
export function readWrangler(dir) {
  const path = ["wrangler.jsonc", "wrangler.json"].map((n) => join(dir, n)).find((p) => existsSync(p));
  if (!path) return null;
  return ts.parseConfigFileTextToJson(path, readFileSync(path, "utf8")).config ?? null;
}

// An area holds the code files under it, less any folder that is an area of
// its own, so a repo can split a big folder ("quality" and "quality/collectors")
// and no file counts twice.
export function* walk(dir, skip, nested = new Set()) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const sub = join(dir, entry.name);
    if (entry.isDirectory() && !skip.has(entry.name) && !nested.has(sub)) yield* walk(sub, skip, nested);
    if (entry.isFile() && CODE_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf(".")))) yield sub;
  }
}

// The other areas inside area a, as absolute folders walk() leaves out.
export function nestedIn(root, a, areas) {
  return new Set(areas.filter((b) => b.startsWith(a + "/")).map((b) => join(root, b)));
}

// The area a repo path belongs to: the longest area it sits under.
export function areaOf(path, areas) {
  return areas.filter((a) => path.startsWith(a + "/")).sort((x, y) => y.length - x.length)[0];
}


// Every file under a folder, skipping build output, dependencies and .git.
export function* walkAll(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && !["node_modules", "dist", ".git", ".astro", ".wrangler", ".claude"].includes(entry.name)) {
      yield* walkAll(join(dir, entry.name));
    }
    if (entry.isFile()) yield join(dir, entry.name);
  }
}

// The rule staticMetrics applies to the files on disk, for a path in a tree.
export function countsAsCode(path, skip) {
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(path)) return false;
  if (path.split("/").slice(0, -1).some((d) => skip.has(d))) return false;
  return CODE_EXTENSIONS.has(path.slice(path.lastIndexOf(".")));
}
