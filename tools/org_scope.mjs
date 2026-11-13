// What a run reads: the scope (repos, docs, site) for Git Crafter and for a repo's
// --config, and the docs it names.

import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { loadLibrary, resolveMaps } from "../pages/library.mjs";
import { loadConfig } from "../quality/config.mjs";

import { ROOT, SITE_REPO } from "./org_base.mjs";
import { OWN_REPO } from "./org_site.mjs";

// ---- Scope ----------------------------------------------------------------

// Which repos a run reads, and where its inputs and outputs live. Git Crafter's own
// run reads every repo in the org and the site's data through the contents API.
// A repo that installs the Process page (claude_os_sync.py kit) passes its own
// --config: its repos, its data on disk, and its docs. Paths are relative to
// the folder the run starts in.
export const SCOPE = {
  repos: null, // null: every unarchived repo in the org
  own_repo: OWN_REPO, // the repo this run is for: its map steps, its row of each tokens.* split
  // The repo's own Quality config: its map steps read that page's run (its
  // data folder's latest.json, else its committed local.json), never another
  // repo's numbers. null: quality/config.json, else the template's defaults.
  quality_config: "config/quality.json",
  // root null: read through the contents API at main. A folder: read from disk,
  // the first file in data where a metric is measured winning.
  site: { repo: SITE_REPO, root: null, data: ["quality/data/local.json"], targets: "quality/targets" },
  // maps: the repo's own process maps (maps.json is Git Crafter's, and the format's
  // example). A repo's config names its own; it never gets Git Crafter's.
  docs: { goals: "goals.json", process: "process.json", maps: "maps.json", systems: "systems.json", tokens: "tokens.json", rules: "rules/delegation.md" },
  data: "data/org.json",
  history: "data/history",
  public: true, // Git Crafter's own public.private_refs
};

// The default scope with a JSON file's keys laid over it, site and docs merged.
export function scopeFrom(json = {}) {
  return { ...SCOPE, ...json, site: { ...SCOPE.site, ...json.site }, docs: { ...SCOPE.docs, ...json.docs } };
}

// A repo's --config: it must name its repos, so its run never falls back to
// the org's list, and Git Crafter's own public.* stays off unless it asks. A doc
// the config does not name is Git Crafter's own, as an absolute path into this
// checkout (the pages action's, in a repo's CI), so a repo names only what
// is its own. The maps are the exception: a repo has only the maps it names.
const REPO_NAME = /^[\w.-]+$/;
export const CODE_OS_DOCS = Object.fromEntries(Object.entries(SCOPE.docs).map(([k, p]) => [k, p ? join(ROOT, p) : p]));
// Throws unless the config holds an object naming its repos, and no gone docs key.
function checkConfig(json) {
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error("--config must hold a JSON object");
  if (!Array.isArray(json.repos) || !json.repos.length || !json.repos.every((r) => typeof r === "string" && REPO_NAME.test(r))) {
    throw new Error("--config needs repos: a list of repo names, so the run reads only those");
  }
  if (json.docs && "steps" in json.docs) throw new Error("docs.steps is gone: name the repo's own process maps as docs.maps (Git Crafter maps.json is the example)");
}

// A repo's --config, checked, as a scope that reads its own repo first.
export function configScope(json) {
  checkConfig(json);
  // The repo reads its own numbers by default: own_repo is the first repo
  // listed, and the site whose data it copies is that repo's own Quality run
  // on disk (ownQuality fills its data and targets).
  const own = json.own_repo ?? json.repos[0];
  if (!json.repos.includes(own)) throw new Error(`--config own_repo "${own}" is not one of its repos`);
  return { ...SCOPE, public: false, quality_config: null, ...json, own_repo: own, site: { repo: own, root: ".", ...json.site }, docs: { ...CODE_OS_DOCS, maps: null, ...json.docs } };
}

// The repo's own Quality run on disk, as a site spec: the data folder and
// targets its Quality config names, CI's fresh latest.json ahead of the
// committed local.json. Paths relative to root.
export function ownQuality(root, scope) {
  const c = loadConfig({ root, file: scope.quality_config ?? null, env: {} });
  const rel = (p) => relative(resolve(root), p) || ".";
  return { repo: scope.own_repo, root: ".", data: ["latest.json", "local.json"].map((f) => rel(join(c.data, f))), targets: rel(c.targets) };
}

// The maps folders of the packs a Quality config names; none when it cannot
// be read, since the Quality page build reports why.
function packMaps(root, file) {
  try {
    return loadConfig({ root, file, env: { CODE_OS_PACKS: process.env.CODE_OS_PACKS } }).packs.map((p) => p.maps);
  } catch {
    return [];
  }
}

// The docs a run and a page read. goals and process are required, and so is a
// maps file the config names (a typo would show no maps), its { use } entries
// resolved to the template's library maps (pages/library.mjs); each other doc
// is null when its path is null or the file is missing. quality is the Quality
// config whose packs add maps to the library (null: the repo's default).
export function readDocs(root, docs, quality = null) {
  const path = (p) => (p ? resolve(root, p) : null);
  const json = (p) => JSON.parse(readFileSync(p, "utf8"));
  const optional = (p) => (path(p) && existsSync(path(p)) ? path(p) : null);
  return {
    goals: json(path(docs.goals)),
    process: json(path(docs.process)),
    maps: docs.maps ? resolveMaps(json(path(docs.maps)), loadLibrary(undefined, packMaps(root, quality))) : null,
    systems: optional(docs.systems) ? json(optional(docs.systems)) : null,
    tokens: optional(docs.tokens) ? json(optional(docs.tokens)) : null,
    rules: optional(docs.rules) ? readFileSync(optional(docs.rules), "utf8") : "",
  };
}
