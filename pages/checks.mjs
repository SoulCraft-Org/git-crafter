// The checks build.mjs runs before it draws: goals, process.json, systems.json
// and a repo's maps file. Each returns its errors as strings and
// reads nothing from disk; build.mjs re-exports them, so callers import from there.

import { checkIdeal } from "../quality/score.mjs";
import { READER_KINDS } from "../tools/systems.mjs";
import { ICON_IDS } from "./draw.mjs";
import { PROCESS_TABS } from "./render.mjs";

const https = (u) => /^https:\/\//.test(u ?? "");
const isCell = (at) => Array.isArray(at) && at.length === 2 && at.every((n) => Number.isInteger(n) && n >= 0);

// An optional ideal state on a map or an outcome: ideal and sources beside
// its other keys, held to the Quality page's rules (quality/score.mjs
// checkIdeal). One without the other is an error; neither is none.
export function inlineIdeal(doc, where) {
  if (doc?.ideal === undefined && doc?.sources === undefined) return [];
  try {
    checkIdeal({ ideal: doc.ideal, sources: doc.sources }, where);
    return [];
  } catch (err) {
    return [err.message];
  }
}

// process.json ideals: one ideal state per Process tab, keyed by tab id, in
// the shape of a Quality page ideals file.
function tabIdeals(ideals) {
  if (ideals === undefined) return [];
  if (!ideals || typeof ideals !== "object" || Array.isArray(ideals)) return ["process.json ideals: expected an object keyed by tab id"];
  const errs = [];
  for (const [tab, doc] of Object.entries(ideals)) {
    if (!PROCESS_TABS.includes(tab)) errs.push(`process.json ideals: no tab "${tab}"; the tabs are ${PROCESS_TABS.join(", ")}`);
    else
      try {
        checkIdeal(doc, `process.json ideals.${tab}`);
      } catch (err) {
        errs.push(err.message);
      }
  }
  return errs;
}

// The direction, goal and near edge of one goal.
function goalRating(g, where) {
  const errs = [];
  if (!["higher", "lower"].includes(g.direction)) errs.push(`${where}: direction must be higher or lower`);
  if (typeof g.goal !== "number" || typeof g.near !== "number") errs.push(`${where}: goal and near must be numbers`);
  else if (g.direction === "higher" ? g.near > g.goal : g.near < g.goal) errs.push(`${where}: near must sit on the worse side of goal`);
  return errs;
}

function checkGoal(g, seen) {
  const where = `goal ${g.id ?? "?"}`;
  const errs = [];
  if (!g.id || seen.has(g.id)) errs.push(`${where}: missing or duplicate id`);
  seen.add(g.id);
  if (!Array.isArray(g.metrics) || !g.metrics.length) errs.push(`${where}: metrics must list the rated id first`);
  errs.push(...goalRating(g, where));
  if (!g.goal_source || !g.measured) errs.push(`${where}: needs goal_source and measured`);
  return errs;
}

function checkOutcomes(goalsDoc) {
  const errs = [];
  const seen = new Set();
  for (const o of goalsDoc.outcomes ?? []) {
    if (!o.id || !o.name || !Array.isArray(o.goals)) errs.push(`outcome ${o.id ?? "?"}: needs id, name and goals`);
    errs.push(...inlineIdeal(o, `outcome ${o.id ?? "?"}`));
    for (const g of o.goals ?? []) errs.push(...checkGoal(g, seen));
  }
  return errs;
}

function checkProcess(processDoc) {
  const errs = [];
  if ("steps" in processDoc) errs.push("process.json: steps are gone; each repo's own maps file holds its process maps (maps.json is Git Crafter's)");
  if (processDoc.ci && !Array.isArray(processDoc.ci.metrics)) errs.push("ci: needs a metrics list");
  errs.push(...tabIdeals(processDoc.ideals));
  return errs;
}

const badLimit = (l) => typeof l.value !== "number" || !https(l.source) || !/^\d{4}-\d{2}-\d{2}$/.test(l.read ?? "");
const badRead = (r) => !READER_KINDS.includes(r.kind) || !r.metric;

// One system: its handoffs name systems, each limit says where it came from and when, and its map cell.
function checkSystem(x, sysIds) {
  const at = `systems.json ${x.id}`;
  return [
    ...[...(x.from ?? []), ...(x.to ?? [])].filter((t) => !sysIds.has(t)).map((t) => `${at}: unknown system ${t}`),
    ...(x.limits ?? []).filter(badLimit).map(() => `${at}: a limit needs a number, an https source and a read date`),
    ...(!x.usage?.metric && !x.usage?.why ? [`${at}: usage needs a metric or a why`] : []),
    ...(x.reads ?? []).filter(badRead).map(() => `${at}: a read needs a metric and one of the reader kinds ${READER_KINDS.join(", ")}`),
    ...(x.at !== undefined && !isCell(x.at) ? [`${at}: at needs [column, row]`] : []),
  ];
}

function checkSystemModels(systemsDoc) {
  const errs = [];
  const cols = systemsDoc?.models?.columns ?? [];
  for (const r of systemsDoc?.models?.rows ?? []) for (const c of cols) if (r[c.id] && !r[c.id].metric && !r[c.id].sum && !r[c.id].why) errs.push(`systems.json models "${r.label}": a ${c.id} cell needs a metric, a sum or a why`);
  return errs;
}

// systems.json: every handoff names a system, and every limit says where it came from and when.
function checkSystems(systemsDoc) {
  const sys = systemsDoc?.systems ?? [];
  const sysIds = new Set(sys.map((x) => x.id));
  const errs = [];
  if (sysIds.size !== sys.length) errs.push("systems.json: duplicate id");
  errs.push(...sys.flatMap((x) => checkSystem(x, sysIds)));
  const cells = sys.filter((x) => Array.isArray(x.at)).map((x) => x.at.join(","));
  if (new Set(cells).size !== cells.length) errs.push("systems.json: two systems share a map cell");
  for (const g of systemsDoc?.goals ?? []) if (!g.metric && !["under_goal", "past_limit"].includes(g.measure)) errs.push(`systems.json goal ${g.id}: needs a metric or a measure (under_goal, past_limit)`);
  return [...errs, ...checkSystemModels(systemsDoc)];
}

// Every goal must be ratable and every step drawable; a bad file is a usage
// error, not data.
export function checkDocs(goalsDoc, processDoc, systemsDoc = null) {
  return [...checkOutcomes(goalsDoc), ...checkProcess(processDoc), ...checkSystems(systemsDoc)];
}

// A map shows the fewest steps that show where quality, speed and
// consumption are decided (the owner, 2026-11-03: about six): six at most.
export const MAX_STEPS = 6;
// A library rule is read at a glance on every adopter's page; a repo's own rules may run longer, so only checkLibrary enforces it.
const MAX_RULE_WORDS = 20;
const SLUG = /^[a-z][a-z0-9-]*$/;
const GATE_SOURCES = ["hooks", "workflows", "deploys"];
const GONE = ["time", "pass", "tokens", "also", "target", "pass_invert", "time_key"];

// A step's metric: exactly one, an id on the repo's Quality page when ids is known.
function stepMetric(s, where, ids) {
  if (typeof s?.metric !== "string" || !s.metric) return [`${where}: needs exactly one metric, an id on this repo's Quality page`];
  if (ids && !ids.has(s.metric)) return [`${where}: ${s.metric} is not a metric on this repo's Quality page`];
  return [];
}

// A step's name, rule and tools, and the keys that are gone.
function stepShape(s, where) {
  const errs = [];
  if (!s?.name || !s?.rule || !s?.rule_ref || !Array.isArray(s?.tools)) errs.push(`${where}: needs a name, a rule, a rule_ref and tools`);
  const old = GONE.filter((k) => k in (s ?? {}));
  if (old.length) errs.push(`${where}: ${old.join(" and ")} ${old.length > 1 ? "are" : "is"} gone; a step names one metric, rated by its Quality page goal`);
  return errs;
}

// A step's optional icon, gate source and cell.
function stepExtras(s, where) {
  const errs = [];
  if (s?.icon !== undefined && !ICON_IDS.includes(s.icon)) errs.push(`${where}: icon must be one of ${ICON_IDS.join(", ")}`);
  if (s?.gates_from !== undefined && !GATE_SOURCES.includes(s.gates_from)) errs.push(`${where}: gates_from must be one of ${GATE_SOURCES.join(", ")}`);
  if (s?.at !== undefined && !isCell(s.at)) errs.push(`${where}: at needs [column, row]`);
  return errs;
}

function checkStep(s, at, stepIds, ids) {
  const where = `${at}, step "${s?.id ?? "?"}"`;
  const errs = [];
  if (!SLUG.test(s?.id ?? "") || stepIds.has(s.id)) errs.push(`${where}: needs an id of its own in the map, in lowercase letters, digits and dashes`);
  stepIds.add(s?.id);
  return [...errs, ...stepShape(s, where), ...stepMetric(s, where, ids), ...stepExtras(s, where)];
}

// A map's steps (one at least, MAX_STEPS at most, each drawable and scored) and its critical path.
// A fork places every step, each in a cell of its own: one left unplaced would draw nowhere.
function placementErrors(steps, at) {
  const errs = [];
  const placed = steps.filter((s) => s?.at !== undefined).length;
  if (placed && placed < steps.length) errs.push(`${at}: ${placed} of ${steps.length} steps have at; a fork places every step`);
  const cells = steps.filter((s) => isCell(s?.at)).map((s) => s.at.join());
  if (new Set(cells).size < cells.length) errs.push(`${at}: two steps share one cell; each step has its own at`);
  return errs;
}

function checkSteps(m, at, ids) {
  const errs = [];
  const steps = Array.isArray(m?.steps) ? m.steps : [];
  if (!steps.length) errs.push(`${at}: needs at least one step`);
  if (steps.length > MAX_STEPS) errs.push(`${at}: has ${steps.length} steps; a map keeps the fewest, ${MAX_STEPS} at most`);
  const stepIds = new Set();
  for (const s of steps) errs.push(...checkStep(s, at, stepIds, ids));
  errs.push(...placementErrors(steps, at));
  for (const id of m?.critical_path ?? []) if (!stepIds.has(id)) errs.push(`${at}: critical_path names "${id}", which is not one of its steps`);
  return errs;
}

// time_bar: one metric whose detail rows are the map's steps in hours, drawn
// as one stacked bar; null or absent draws none.
function timeBarErrors(bar, at, ids) {
  if (bar == null) return [];
  return typeof bar === "string" && !(ids && !ids.has(bar)) ? [] : [`${at}: time_bar "${bar}" is not a metric on this repo's Quality page`];
}

function checkMap(m, mapIds, ids, file) {
  const at = `${file} map "${m?.id ?? "?"}"`;
  const errs = [];
  if (!SLUG.test(m?.id ?? "") || mapIds.has(m.id)) errs.push(`${at}: needs an id of its own, in lowercase letters, digits and dashes`);
  mapIds.add(m?.id);
  if (!m?.name || !m?.why) errs.push(`${at}: needs a name and a why`);
  return [...errs, ...timeBarErrors(m?.time_bar, at, ids), ...inlineIdeal(m, at), ...checkSteps(m, at, ids)];
}

// A repo's maps file: every map and step drawable, and every step scored by
// exactly one metric on the repo's Quality page. ids: that page's metric
// ids, or null when they could not be read, which leaves the ids unchecked.
// Every error names the map and the step. No file named is no maps: the
// Maps tab says so.
export function checkMaps(doc, ids = null, file = "maps") {
  if (!doc) return [];
  const errs = [];
  if (!https(doc.repo_url)) errs.push(`${file}: repo_url must be an https link, the base each rule_ref is read from`);
  if (!Array.isArray(doc.maps) || !doc.maps.length) return [...errs, `${file}: maps must list at least one map`];
  const mapIds = new Set();
  for (const m of doc.maps) errs.push(...checkMap(m, mapIds, ids, file));
  return errs;
}

// The three kinds every map scores.
const KINDS = ["quality", "speed", "consumption"];
// The kinds a map's steps leave unscored; kindOf: each metric id's kind, from the Quality targets.
export const missingKinds = (steps, kindOf) => KINDS.filter((k) => !(steps ?? []).some((s) => kindOf[s.metric] === k));

// The template's map library (pages/library.mjs): every map passes checkMaps
// against the template's metric ids alone, opens with an ideal state and its
// dated sources, and links each rule over https, since a repo_url would point
// into whichever repo uses it.
export function checkLibrary(library, templateIds, kindOf = null) {
  const maps = Object.values(library);
  const errs = checkMaps({ repo_url: "https://example.org", maps }, templateIds, "pages/maps");
  for (const m of maps) {
    if (m.ideal === undefined) errs.push(`pages/maps/${m.id}.json: a library map needs an ideal and its sources`);
    for (const s of m.steps ?? []) {
      if (!https(s.rule_ref)) errs.push(`pages/maps/${m.id}.json, step "${s.id}": rule_ref must be an https link`);
      const words = String(s.rule ?? "").trim().split(/\s+/).filter(Boolean).length;
      if (words > MAX_RULE_WORDS) errs.push(`pages/maps/${m.id}.json, step "${s.id}": rule has ${words} words; a library rule keeps ${MAX_RULE_WORDS} at most`);
    }
    // The Process page's ideal: a map is where quality, speed and consumption are decided.
    const missing = kindOf ? missingKinds(m.steps, kindOf) : [];
    if (missing.length) errs.push(`pages/maps/${m.id}.json: no step scores ${missing.join(", ")}; a map scores quality, speed and consumption`);
  }
  return errs;
}
