// How a repo's targets lie over the template's, by metric id. No package and
// no check here: score.mjs loadDefs checks what this returns, and the Process
// page's collector (tools/collect_org.mjs), which installs nothing, reads a
// repo's labels and goals through it as they are.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// What a repo's targets file may change on a template metric, by id. Anything
// else about a template metric (its tab, kind, direction, label) is the
// template's, so every repo's page reads the same way. gate: true makes a
// miss fail the repo's pull request (collect.mjs exits 3), even on a dropped
// metric; gate: "warn" only annotates the miss.
const OVERRIDES = ["goal", "near", "goal_source", "params", "drop", "gate"];

// Every *.json in a targets folder, by file name, as written. A missing folder
// is none; a file that is not an array is a usage error.
export function readTargetFiles(dir) {
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((file) => {
      const list = JSON.parse(readFileSync(join(dir, file), "utf8"));
      if (!Array.isArray(list)) throw new Error(`${file}: expected an array of metric definitions`);
      return { file, list };
    });
}

// The template's targets with a repo's laid over them, by metric id. An
// override entry names a template id and sets only OVERRIDES; drop: true
// turns the metric off. An entry whose id the template does not have is the
// repo's own metric, a full definition; one holding only override fields is
// a usage error, an override with nothing under it. An override of goal or
// near brings its own goal_source. Each file's params are the union of
// its entries' params, the template's first, then the repo's, key by key, so
// it does not matter which entry carries them; a dropped entry's params still
// count. Unchecked: loadDefs checks, and the Process page reads labels and
// goals from it as they are.
export function overlayTargets(templateFiles, repoFiles = []) {
  const entries = [];
  const byId = new Map();
  const params = {};
  const addParams = (file, p) => {
    if (p && typeof p === "object") params[file] = { ...params[file], ...p };
  };
  const add = (entry) => {
    byId.set(entry.id, entry);
    entries.push(entry);
    addParams(entry.file, entry.params);
  };
  for (const { file, list } of templateFiles) {
    for (const def of list) {
      if (byId.has(def.id)) throw new Error(`template ${file}: ${def.id}: duplicate id`);
      add({ ...def, file });
    }
  }
  const own = new Set();
  for (const { file, list } of repoFiles) {
    for (const o of list) {
      const where = `${file}: ${o.id ?? "(no id)"}`;
      if (own.has(o.id)) throw new Error(`${where}: duplicate id`);
      own.add(o.id);
      const base = byId.get(o.id);
      if (!base) add(ownMetric(o, file, where));
      else applyOverride(base, o, file, where, addParams);
    }
  }
  return { entries, params };
}

// A repo's own metric: a full definition, not an override with nothing under it.
function ownMetric(o, file, where) {
  if (Object.keys(o).every((k) => k === "id" || OVERRIDES.includes(k))) throw new Error(`${where}: no template metric "${o.id}" to override`);
  return { ...o, file };
}

// Lays a repo's override over a template metric, after checking it.
function applyOverride(base, o, file, where, addParams) {
  const extra = Object.keys(o).filter((k) => k !== "id" && !OVERRIDES.includes(k));
  if (extra.length) throw new Error(`${where}: overrides the template metric, which takes only ${OVERRIDES.join(", ")}, not ${extra.join(", ")}`);
  if (o.drop !== undefined && o.drop !== true) throw new Error(`${where}: drop must be true or absent`);
  // A goal the repo sets is the repo's to source: the template's
  // goal_source would credit the repo's number to the template's evidence.
  if ((o.goal !== undefined || o.near !== undefined) && (typeof o.goal_source !== "string" || !o.goal_source.trim())) {
    throw new Error(`${where}: an override of goal or near must give its own goal_source`);
  }
  const { params: p, ...rest } = o;
  Object.assign(base, rest, p ? { params: { ...base.params, ...p } } : {}, { overridden_in: file });
  addParams(base.file, p);
}
