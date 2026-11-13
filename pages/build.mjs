#!/usr/bin/env node
// Builds Git Crafter's two pages into pages/dist/: index.html (Process) and
// metrics.html (Metrics and goals), from goals.json, process.json, the
// repo's own maps (Git Crafter's: maps.json; optional), data/org.json, the
// repo's own Quality run (each map step's value) and data/history/*.json. CI runs it (pages.yml);
// it reads files and writes two, nothing else.
//
//   node pages/build.mjs
//   node pages/build.mjs --config quality/process/config.json
//       a repo's own Process page, through actions/pages: the collector's scope
//       (tools/collect_org.mjs SCOPE) plus PAGE_DEFAULTS' keys
//
// Prints each page's size. Exit 0 written, 1 a page over BUDGET bytes, 2 usage
// error (a doc or a map would draw wrong), 3 no data/org.json yet.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { CONFIG_DEFAULTS, loadConfig, QUALITY } from "../quality/config.mjs";
import { readTargetFiles } from "../quality/overlay.mjs";
import { configDefs } from "../quality/packs.mjs";
import { configScope, ownStepMetrics, readDocs, readOwnRun, SCOPE } from "../tools/collect_org.mjs";
import { withComputed } from "./model.mjs";
import { checkDocs, checkLibrary, checkMaps, inlineIdeal, MAX_STEPS, missingKinds } from "./checks.mjs";
import { renderMetrics, renderProcess } from "./render.mjs";

export { checkDocs, checkLibrary, checkMaps, inlineIdeal, MAX_STEPS, missingKinds };

const PAGES = fileURLToPath(new URL(".", import.meta.url));
// The orchestrator's page budget, 2026-11-03: each page under 700 KB.
export const BUDGET = 700_000;
const ROOT = join(PAGES, "..");

// Where a build writes, which pages and tabs it draws, and how they are
// framed. Git Crafter's own unless a repo's --config says otherwise. A nav item
// names one of these pages, or an href of its own (a repo's Quality page).
export const PAGE_DEFAULTS = {
  out: "pages/dist",
  pages: { process: "index.html", metrics: "metrics.html" },
  tabs: null, // every tab the docs allow
  heading: "Git Crafter",
  collector: "tools/collect_org.mjs",
  // The Quality page config (quality/config.mjs) whose metric ids the maps
  // must use. A repo's --config names its own; null reads the repo's
  // quality/config.json, else the template's defaults. Git Crafter's own build
  // reads CODE_OS_QUALITY_CONFIG (qualityConfigPath), never a repo's.
  quality_config: null,
  nav: [
    { page: "process", label: "Process", icon: "plan" },
    { page: "metrics", label: "Metrics and goals", icon: "measure" },
    // Git Crafter's own Quality, Speed and Consumption page, which pages.yml
    // builds into quality/ with config/quality.json.
    { href: "quality/", label: "Quality, Speed and Consumption", icon: "speed" },
  ],
};
// PAGE_DEFAULTS with the keys config sets that it knows; others are dropped.
export const pageConfig = (config = {}) => ({ ...PAGE_DEFAULTS, ...Object.fromEntries(Object.entries(config).filter(([k]) => k in PAGE_DEFAULTS)) });

// Git Crafter's own Quality page config (#78), for its own build, the one with no
// --config. A repo's config that names none gets null, its own default.
export const CODE_OS_QUALITY_CONFIG = "config/quality.json";
// The Quality config whose metric ids the maps use: the page config's,
// Git Crafter's own for its own build, else null (the repo's default).
export const qualityConfigPath = (config = null) => pageConfig(config ?? {}).quality_config ?? (config ? null : CODE_OS_QUALITY_CONFIG);

// The repo's Quality page definitions by id: Git Crafter's template targets with
// the repo's laid over them, on the tabs its Quality config shows, the same
// call the Quality page builds from; ids is their ids, and history the
// folder of its daily runs, which draw each step's trend line. When they cannot be
// read (an overlay that refuses the repo's targets, say), defs is null, with
// why, and ids falls back to every id the template's targets and the repo's
// own targets files name, so each map step's metric is still checked, unrated.
export function qualityDefs(root, file = null) {
  const template = join(QUALITY, "targets");
  let targets = resolve(root, CONFIG_DEFAULTS.targets);
  try {
    const config = loadConfig({ root, file });
    targets = config.targets;
    const { defs } = configDefs(config, template);
    return { defs: Object.fromEntries(defs.map((d) => [d.id, d])), ids: new Set(defs.map((d) => d.id)), history: config.history };
  } catch (err) {
    return { defs: null, ids: targetIds([template, targets]), why: err.message };
  }
}

// Every id the targets files in these folders name, whatever their shape; a
// folder or file that will not parse adds none. null when none name any.
function targetIds(dirs) {
  const ids = new Set();
  for (const dir of dirs) {
    try {
      for (const { list } of readTargetFiles(dir)) for (const d of list) if (typeof d?.id === "string") ids.add(d.id);
    } catch {}
  }
  return ids.size ? ids : null;
}

// A doc path as the footer shows it: Git Crafter's own by its name in Git Crafter,
// a repo's own as its repo path.
const shown = (p) => (p && isAbsolute(p) && !relative(ROOT, p).startsWith("..") ? `Git Crafter ${relative(ROOT, p)}` : p);

// Reads the docs a build draws from; null with the error when one cannot be read.
function loadDocs(root, config) {
  try {
    const scope = config ? configScope(config) : SCOPE;
    return { scope, docs: readDocs(root, scope.docs, qualityConfigPath(config)) };
  } catch (err) {
    return { error: `could not read the docs: ${err.message}` };
  }
}

// What a Quality config the engine cannot read costs the maps: its ids go
// unchecked, or checked against the targets files' ids, with a warning.
function qualityWarnings(mapsDoc, quality) {
  if (!mapsDoc || quality.defs) return [];
  const checked = quality.ids ? "the maps' metric ids were checked against the ids the template's and this repo's targets files name, and go unrated" : "the maps' metric ids went unchecked";
  return [`${checked}: could not read this repo's Quality page definitions (${quality.why})`];
}

// The history snapshots in a scope's folder, oldest first; none when it has no folder.
function readHistory(root, scope) {
  return readRuns(scope.history ? join(root, scope.history) : null);
}

// The JSON files in a folder, oldest first by name; none when there is no folder.
function readRuns(histDir) {
  if (!histDir || !existsSync(histDir)) return [];
  return readdirSync(histDir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(histDir, f), "utf8")));
}

// The nav, footer files and Metrics link both pages share.
function pageChrome(page, scope) {
  return {
    heading: page.heading,
    nav: page.nav.map((n) => (n.page ? { ...n, href: page.pages[n.page] } : n)).filter((n) => n.href),
    files: { data: scope.data, collector: page.collector, goals: shown(scope.docs.goals), process: shown(scope.docs.maps ?? scope.docs.process) },
    metricsHref: page.pages.metrics ?? null,
  };
}

// data/org.json with each map step, and each Quality id the docs name, read
// from the repo's own Quality run at build time, as the collector reads it, so
// no copy lags the run. A run the build cannot read leaves the copy.
export function withOwnRun(raw, root, scope, docs) {
  const run = readOwnRun(root, scope);
  return run.own ? { ...raw, metrics: { ...raw.metrics, ...ownStepMetrics(docs, scope, run) } } : raw;
}

// Builds both pages from the repo's docs and data/org.json; returns the
// pages by file name, or a nonzero code with the errors that stopped it.
export function build({ root = ROOT, now = new Date(), config = null } = {}) {
  const page = pageConfig(config ?? {});
  const loaded = loadDocs(root, config);
  if (loaded.error) return { code: 2, errs: [loaded.error] };
  const { scope, docs } = loaded;
  const { goals: goalsDoc, process: processDoc, maps: mapsDoc, systems: systemsDoc } = docs;
  // The Quality page's definitions check each map step's id and rate it. A
  // Quality config the engine cannot read is that page's error, not the
  // maps': the ids go unchecked, with a warning, and the page still builds.
  const quality = mapsDoc ? qualityDefs(root, qualityConfigPath(config)) : { defs: null };
  const warnings = qualityWarnings(mapsDoc, quality);
  const errs = [...checkDocs(goalsDoc, processDoc, systemsDoc), ...checkMaps(mapsDoc, quality.ids ?? null, shown(scope.docs.maps) ?? "maps")];
  if (errs.length) return { code: 2, errs };
  const dataPath = join(root, scope.data);
  if (!existsSync(dataPath)) return { code: 3, errs: [`no ${scope.data}; run node ${page.collector}`] };
  const data = { ...withComputed(withOwnRun(JSON.parse(readFileSync(dataPath, "utf8")), root, scope, docs), goalsDoc, now), built_at: now.toISOString() };
  // Each stylesheet and its second half read as one text: the split keeps each file under the length limit.
  const read = (...files) => files.map((f) => readFileSync(join(PAGES, f), "utf8")).join("");
  const css = [read("../quality/render/tokens.css"), read("../quality/render/page.css", "../quality/render/page-figures.css"), read("site.css", "site-tabs.css")].join("\n");
  const script = readFileSync(join(PAGES, "client.js"), "utf8");
  const chrome = pageChrome(page, scope);
  const pages = {};
  if (page.pages.process) pages[page.pages.process] = renderProcess({ data, goalsDoc, processDoc, mapsDoc, defs: quality.defs, history: readRuns(quality.history), css, script, chrome, tabs: page.tabs });
  if (page.pages.metrics) pages[page.pages.metrics] = renderMetrics({ data, goalsDoc, history: readHistory(root, scope), css, script, chrome });
  return { code: 0, pages, out: page.out, warnings };
}

// The --config file named on the command line, or null; exits 2 on a bad command line or file.
function readCliConfig(argv, at) {
  if (argv.length && (at !== 0 || argv.length !== 2)) {
    console.error("usage: build.mjs [--config FILE]");
    process.exit(2);
  }
  try {
    return at === 0 ? JSON.parse(readFileSync(join(process.cwd(), argv[1]), "utf8")) : null;
  } catch (err) {
    console.error(`pages: could not read --config: ${err.message}`);
    process.exit(2);
  }
}

// Writes each page into dist and prints its size; returns how many are over BUDGET.
function writePages(dist, out) {
  mkdirSync(dist, { recursive: true });
  let over = 0;
  for (const [name, html] of Object.entries(out.pages)) {
    const bytes = Buffer.byteLength(html);
    writeFileSync(join(dist, name), html);
    console.log(`wrote ${out.out}/${name}: ${bytes.toLocaleString("en-US")} bytes${bytes > BUDGET ? `, over the ${BUDGET.toLocaleString("en-US")}-byte budget` : ""}`);
    if (bytes > BUDGET) over += 1;
  }
  return over;
}

function main(argv) {
  const at = argv.indexOf("--config");
  const config = readCliConfig(argv, at);
  const root = at === 0 ? process.cwd() : ROOT;
  const out = build({ root, config });
  if (out.code) {
    for (const e of out.errs) console.error(`pages: ${e}`);
    process.exit(out.code);
  }
  for (const w of out.warnings) console.error(`${process.env.GITHUB_ACTIONS === "true" ? "::warning::" : ""}pages: ${w}`);
  if (writePages(join(root, out.out), out)) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
