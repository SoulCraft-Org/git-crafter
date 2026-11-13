// The template's process maps: pages/maps/<id>.json, one map a file, each
// with its ideal state, its dated sources, at most MAX_STEPS steps and every
// step scored by one template metric id. A repo's maps file names a library
// map by id ({ "use": "delivery" }) and changes only what differs, by step
// id, the way quality/overlay.mjs lays a repo's targets over the template's.
// A map of the repo's own, written out in full, sits beside them.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The folder that holds the template's maps (pages/maps/).
const LIBRARY = fileURLToPath(new URL("maps", import.meta.url));

// What a repo may change on a library map and on each of its steps. A step's
// id and the order of the steps are the library's, so every repo's map of the
// same name reads the same way; drop: true removes a step.
const MAP_OVERRIDES = ["name", "why", "ideal", "sources", "critical_path", "time_bar", "steps"];
const STEP_OVERRIDES = ["name", "short", "tools", "rule", "rule_ref", "metric", "icon", "gates", "gates_from", "drop"];

// Every library map by id, the template's and then each pack's maps folder
// (quality/packs.mjs). A file whose id is not its name, or a pack map with a
// library map's id, is a usage error.
export function loadLibrary(dir = LIBRARY, packDirs = []) {
  const maps = {};
  for (const d of [dir, ...packDirs]) readMaps(d, d === dir ? "pages/maps" : d, maps);
  return maps;
}

// Adds the maps in one folder to maps, by id; at is the folder as an error names it.
function readMaps(dir, at, maps) {
  if (!existsSync(dir)) return;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const map = JSON.parse(readFileSync(join(dir, file), "utf8"));
    if (map?.id !== file.replace(/\.json$/, "")) throw new Error(`${at}/${file}: id must be "${file.replace(/\.json$/, "")}", its file name`);
    if (maps[map.id]) throw new Error(`${at}/${file}: the library already has a map "${map.id}"; rename the pack's`);
    maps[map.id] = map;
  }
}

// A repo's maps file with each { use } entry replaced by its library map,
// the repo's changes laid over it. Throws on an unknown map, step or key: a
// typo would otherwise change nothing. checkMaps checks what this returns.
export function resolveMaps(doc, library = loadLibrary()) {
  if (!doc || !Array.isArray(doc.maps)) return doc;
  return { ...doc, maps: doc.maps.map((entry) => (entry && "use" in entry ? useMap(entry, library) : entry)) };
}

// Throws unless one step override changes only fields a library step allows.
function checkStepOverride(at, id, s) {
  const bad = Object.keys(s ?? {}).filter((k) => !STEP_OVERRIDES.includes(k));
  if (bad.length) throw new Error(`${at}, step "${id}": a step takes only ${STEP_OVERRIDES.join(", ")}, not ${bad.join(", ")}`);
  if (s.drop !== undefined && s.drop !== true) throw new Error(`${at}, step "${id}": drop must be true or absent`);
}

// Throws unless the repo's overrides name only keys, steps and fields the library map allows.
function checkOverrides(at, over, base) {
  const extra = Object.keys(over).filter((k) => !MAP_OVERRIDES.includes(k) && k !== "comment");
  if (extra.length) throw new Error(`${at}: a library map takes only ${MAP_OVERRIDES.join(", ")}, not ${extra.join(", ")}`);
  const steps = over.steps ?? {};
  if (typeof steps !== "object" || Array.isArray(steps)) throw new Error(`${at}: steps must be an object keyed by step id`);
  const known = new Set(base.steps.map((s) => s.id));
  for (const [id, s] of Object.entries(steps)) {
    if (!known.has(id)) throw new Error(`${at}: no step "${id}"; its steps are ${[...known].join(", ")}`);
    checkStepOverride(at, id, s);
  }
}

function useMap(entry, library) {
  const { use, ...over } = entry;
  const at = `map use "${use}"`;
  const base = library[use];
  if (!base) throw new Error(`${at}: no library map "${use}"; pages/maps has ${Object.keys(library).join(", ") || "none"}`);
  checkOverrides(at, over, base);
  const steps = over.steps ?? {};
  const kept = base.steps.filter((s) => steps[s.id]?.drop !== true).map((s) => {
    const { drop, ...o } = steps[s.id] ?? {};
    return { ...s, ...o };
  });
  const { steps: _, ...mapOver } = over;
  const critical = (mapOver.critical_path ?? base.critical_path)?.filter((id) => kept.some((s) => s.id === id));
  return { ...base, ...mapOver, ...(critical ? { critical_path: critical } : {}), steps: kept, library: use };
}
