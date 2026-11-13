// Packs: folders of Quality tabs and Process maps a repo adds to its pages
// from another repo, each with targets/, collectors/, ideals/, maps/ and a
// pack.json naming its tabs. config.mjs reads the config's `packs` list here.
//
//   owner/repo@<40-hex sha>  checked out by actions/pages at CODE_OS_PACKS/owner/repo
//   a folder path            a --local run only
//
// A pack is code that runs in CI, so it is pinned the way an action is: by a
// full commit SHA. A tag or a branch can move under the repo; it is refused.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { loadDefs, loadIdeals, TABS } from "./score.mjs";

const PINNED = /^(?!\.)([\w.-]+)\/(?!\.)([\w.-]+)@([0-9a-f]{40})$/;
const REMOTE = /^[\w.-]+\/[\w.-]+@/;
const DOT = /^(?:\.[\w.-]*\/[\w.-]+|[\w.-]+\/\.[\w.-]*)@/;

// The folder a pack is read from, or a usage error naming why the entry is refused.
function packDir(spec, { root, env, ci }) {
  const pin = PINNED.exec(spec);
  if (pin) return join(env.CODE_OS_PACKS ?? join(root, ".code-os-packs"), pin[1], pin[2]);
  if (DOT.test(spec)) throw new Error(`packs: "${spec}" has an owner or repo name that starts with a dot, which a pack may not: it could name a folder above the checkout`);
  if (REMOTE.test(spec)) throw new Error(`packs: "${spec}" needs a full 40-hex commit SHA after @, not a tag or branch: a pack runs in CI, and a tag or branch can move`);
  if (ci) throw new Error(`packs: "${spec}" is a local path, which only a --local run takes; CI takes owner/repo@<40-hex sha>`);
  return resolve(root, spec);
}

// The pack's tabs from its pack.json, as [id, name]; none until it is checked out.
function packTabs(dir) {
  const file = join(dir, "pack.json");
  if (!existsSync(file)) return [];
  const tabs = JSON.parse(readFileSync(file, "utf8")).tabs ?? [];
  if (!Array.isArray(tabs) || !tabs.every((t) => Array.isArray(t) && t.length === 2 && t.every((x) => typeof x === "string"))) throw new Error(`${file}: tabs must list ["id", "Name"] pairs`);
  return tabs;
}

// The config's packs, each { spec, dir, targets, collectors, ideals, maps, tabs }.
export function resolvePacks(list, { root, env = process.env, ci = false }) {
  if (!Array.isArray(list) || !list.every((s) => typeof s === "string" && s.trim())) throw new Error('packs must list "owner/repo@<40-hex sha>" entries');
  return list.map((spec) => {
    const dir = packDir(spec, { root, env, ci });
    const sub = (name) => join(dir, name);
    return { spec, dir, targets: sub("targets"), collectors: sub("collectors"), ideals: sub("ideals"), maps: sub("maps"), tabs: packTabs(dir) };
  });
}

// A config's packs; a config object built by hand may have none.
const packsOf = (config) => config.packs ?? [];

// Throws unless every pack's folder is there: a missing checkout is a usage error, never an empty tab.
function checkedOut(packs) {
  const gone = packs.find((p) => !existsSync(p.dir));
  if (gone) throw new Error(`pack ${gone.spec} is not at ${gone.dir}; actions/pages checks it out, and a --local run names a folder`);
}

// Every tab id a definition or an ideal may name: the template's, the pack's and the page's.
const tabIdsOf = (config) => new Set([...TABS.map(([id]) => id), ...packsOf(config).flatMap((p) => p.tabs.map(([id]) => id)), ...config.tabs.map(([id]) => id)]);

// The page's metric definitions (score.mjs loadDefs) with each pack's targets beside the template's.
export function configDefs(config, templateDir) {
  checkedOut(packsOf(config));
  return loadDefs({ templateDir, packDirs: packsOf(config).map((p) => p.targets), repoDir: config.targets, tabs: config.tabs, tabIds: tabIdsOf(config) });
}

// The page's ideals (score.mjs loadIdeals): the template's, each pack's, then the repo's.
export function configIdeals(config, templateDir) {
  return loadIdeals({ templateDir, packDirs: packsOf(config).map((p) => p.ideals), repoDir: config.ideals, tabIds: tabIdsOf(config) });
}
