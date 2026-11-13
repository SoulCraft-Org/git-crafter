// Scores the Quality, Speed and Consumption page. Each metric is compared
// with its goal; each tab's quality, speed and consumption scores are the
// means of the metrics it could measure. Goals live in quality/targets/*.json
// (the template's, overlaid by a repo's own) and judgment scores in a repo's
// quality/reviews/*.yaml; this file holds neither.
//
// A metric a collector could not read ({ could_not_check }) is "not measured":
// it is left out of the mean and counted in "n of m measured", never scored 0,
// because could not verify is not the same as verified and red.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import { overlayTargets, readTargetFiles } from "./overlay.mjs";
import { checkPlainFields, checkWordCounts, IDEAL_MAX_WORDS, isDay, isPlain, isPublicUrl, PLAIN_WORDS, wordCount } from "./text-rules.mjs";

export { overlayTargets };

// The template's tabs, one per GitHub tab in GitHub's order (owner,
// 2026-11-12). Security's own pages Dependabot and Scanning get a tab each;
// Pages is a Settings page with a tab of its own. Settings holds every
// Settings page no other tab owns. A repo's config picks from these and may
// add its own (config.mjs).
export const TABS = [
  ["code", "Code"],
  ["documentation", "Documentation"],
  ["issues", "Issues"],
  ["pull-requests", "Pull requests"],
  ["discussions", "Discussions"],
  ["actions", "Actions"],
  ["projects", "Projects"],
  ["security", "Security and quality"],
  ["dependabot", "Dependabot"],
  ["scanning", "Scanning"],
  ["insights", "Insights"],
  ["settings", "Settings"],
  ["pages", "Pages"],
];
// Tabs that score a website a repo serves. Off unless a repo's config turns
// them on: most repos have no site to review.
export const WEB_TABS = ["pages"];
// A tab id the template no longer has, and where its metrics went: a config,
// target, ideal or review that names one stops with this (exit 2).
export const MOVED_TABS = {
  tests: '"actions", or "code" for test coverage',
  tools: '"dependabot"',
  deploy: '"pages"',
  design: '"pages"',
  usability: '"pages"',
  credits: "the pack SoulCraft-Org/compute-crafter",
  ...Object.fromEntries(["claude", "claude-settings", "desktop-app", "blockers", "tokens", "instructions"].map((id) => [id, "the pack Colorado-Startups/claudius"])),
};
// Why a tab id is unknown: where it moved, or how to add a tab of one's own.
export const unknownTab = (id) => (Object.hasOwn(MOVED_TABS, id) ? `tab "${id}" is gone; its metrics moved to ${MOVED_TABS[id]}` : `unknown tab "${id}"`);
export const DEFAULT_TABS = TABS.filter(([id]) => !WEB_TABS.includes(id));
const TAB_IDS = new Set(TABS.map(([id]) => id));
// Every tab scores all three, each a third of its score: a tab is held to an
// ideal state, and what moves it toward that state is its quality, its speed
// and what it consumes. A metric that moves none of them is not measured.
export const KIND_LIST = ["quality", "speed", "consumption"];
const KINDS = new Set(KIND_LIST);
const DIRECTIONS = new Set(["higher", "lower"]);
// How a metric's breakdown is drawn: bar and gauge as bars, spark as a line,
// number and table as a plain table, funnel as shrinking stages (largest
// first), stack as one 100% bar of at most 5 parts, flow as the CI pipeline's
// stages in order (render/ci-flow.mjs), ledger as one row per blocker with
// its verdict (render/ledger.mjs), repos as tokens by repo
// (render/repos.mjs), deploys as one row per production deploy
// (render/deploys.mjs), credits as one row per free or included allowance
// (render/credits.mjs), tools as one row per direct dependency
// (render/tools.mjs).
export const CHARTS = new Set(["number", "bar", "gauge", "spark", "table", "funnel", "stack", "flow", "ledger", "repos", "deploys", "credits", "tools"]);
// Optional display text and its longest length: `means` says in plain words
// what the number counts, `group` names a sub-section inside its kind.
// Neither changes the score.
export const TEXT_FIELDS = { means: 120, group: 30 };
// True when a text field is blank, not a string or longer than max.
const badText = (v, max) => typeof v !== "string" || !v.trim() || v.length > max;
const isObject = (x) => Boolean(x) && typeof x === "object" && !Array.isArray(x);

// Throws the first message whose condition holds: rules are [bad, message].
function throwFirst(rules, where) {
  const hit = rules.find(([bad]) => bad);
  if (hit) throw new Error(`${where}: ${hit[1]}`);
}

// Throws on an optional display-text field that is present and bad.
function checkTextFields(obj, fields, where) {
  for (const [field, max] of Object.entries(fields)) {
    if (obj[field] !== undefined && badText(obj[field], max)) throw new Error(`${where}: ${field} must be text of 1 to ${max} characters`);
  }
}

const identityRules = (def, tabIds) => [
  [typeof def.id !== "string" || !def.id.includes("."), 'id must be "<area>.<name>"'],
  [!tabIds.has(def.tab), unknownTab(def.tab)],
  [!KINDS.has(def.kind), "kind must be quality, speed or consumption"],
  [!DIRECTIONS.has(def.direction), "direction must be higher or lower"],
  [typeof def.goal !== "number" || typeof def.near !== "number", "goal and near must be numbers"],
  [typeof def.goal_source !== "string" || !def.goal_source.trim(), "goal_source must say where the goal comes from"],
];

const optionRules = (def) => [
  // The near band sits past the goal, on the worse side.
  [def.direction === "higher" ? def.near > def.goal : def.near < def.goal, `near must be on the worse side of goal (${def.direction} is better)`],
  [def.chart !== undefined && !CHARTS.has(def.chart), `unknown chart "${def.chart}"`],
  // A gate fails a pull request when missed (collect.mjs exits 3); "warn" only annotates it.
  [def.gate !== undefined && typeof def.gate !== "boolean" && def.gate !== "warn", 'gate must be true, false or "warn"'],
  // The day the metric's meaning last changed: a trend leaves out reads dated before it.
  [def.defined !== undefined && !isDay(def.defined), "defined must be a real day, YYYY-MM-DD"],
  [def.defined > new Date().toISOString().slice(0, 10), "defined is after today; it is the day the meaning changed"],
];

// Throws when the page could not score a definition: a usage error, not data.
export function checkDef(def, where, tabIds = TAB_IDS) {
  throwFirst(identityRules(def, tabIds), where);
  throwFirst(optionRules(def), where);
  checkTextFields(def, TEXT_FIELDS, where);
}

// Reads every quality/targets/*.json in one folder into one list and rejects
// a definition the page could not score. Throws on a bad file: that is a
// usage error, not data.
export function loadTargets(dir, { tabIds = TAB_IDS } = {}) {
  const defs = [];
  const seen = new Set();
  for (const { file, list } of readTargetFiles(dir)) {
    for (const def of list) {
      const where = `${file}: ${def.id ?? "(no id)"}`;
      checkDef(def, where, tabIds);
      if (seen.has(def.id)) throw new Error(`${where}: duplicate id`);
      seen.add(def.id);
      defs.push({ ...def, file });
    }
  }
  return defs;
}

// The definitions a page scores: the template's targets, the repo's laid over
// them, every one checked, then those dropped or on a tab the repo turned off
// left out. Returns the defs, each targets file's params (overlayTargets),
// every id the files define, so a caller can tell off from unknown, and the
// gated ones on a shown tab: a dropped metric may still gate, unscored.
export function loadDefs({ templateDir, packDirs = [], repoDir = null, tabs = DEFAULT_TABS, tabIds = new Set([...TAB_IDS, ...tabs.map(([id]) => id)]) }) {
  const repoFiles = repoDir && repoDir !== templateDir ? readTargetFiles(repoDir) : [];
  const { entries, params } = overlayTargets(baseFiles(templateDir, packDirs), repoFiles);
  for (const def of entries) checkDef(def, `${def.overridden_in ? `${def.overridden_in} over the template's ${def.file}` : def.file}: ${def.id ?? "(no id)"}`, tabIds);
  const on = new Set(tabs.map(([id]) => id));
  const defs = entries.filter((d) => d.drop !== true && on.has(d.tab));
  const gated = entries.filter((d) => (d.gate === true || d.gate === "warn") && on.has(d.tab));
  return { defs, params, all: entries, gated };
}

// The template's targets files, then each pack's (packs.mjs), which add
// tabs of their own; a pack file named like one before it is a usage error.
function baseFiles(templateDir, packDirs) {
  const files = readTargetFiles(templateDir);
  for (const dir of packDirs) {
    for (const f of readTargetFiles(dir)) {
      if (files.some((g) => g.file === f.file)) throw new Error(`pack targets ${f.file} is named like another targets file; rename the pack's`);
      files.push(f);
    }
  }
  return files;
}

// ---- Ideal states ---------------------------------------------------------

// quality/ideals/<tab>.json: the best practice for a tab's area, from the
// most recent documented sources, summarized in plain words, with the
// documents it rests on, and optionally one line per category on what ideal
// looks like there. The page opens each tab with it.
const IDEAL_FIELDS = { ideal: 300, quality: 160, speed: 160, consumption: 160 };
const SOURCE_KEYS = ["title", "url", "date"];

function checkSource(s, at) {
  if (!isObject(s)) throw new Error(`${at}: expected { title, url, date }`);
  const more = Object.keys(s).filter((k) => !SOURCE_KEYS.includes(k));
  if (more.length) throw new Error(`${at}: unknown key ${more.join(", ")}; a source takes ${SOURCE_KEYS.join(", ")}`);
  throwFirst([
    [badText(s.title, 160), "title must be text of 1 to 160 characters"],
    [!isPlain(s.title), `title must be plain words: ${PLAIN_WORDS}`],
    [!isPublicUrl(s.url), "url must be a public https link to a plain host name, with no punycode, port or credentials"],
    [!isDay(s.date), "date must be YYYY-MM-DD, the document's date or the day it was read"],
  ], at);
}

// A tab's parts: the pieces of its area, each with what ideal looks like there
// and how to set it up. The page draws them as a table under the summary.
const PART_FIELDS = { part: 30, ideal: 160, setup: 160 };
const PARTS_MAX = 8;

// Throws unless parts is absent or 1 to 8 rows of plain part, ideal and setup text.
function checkParts(parts, where) {
  if (parts === undefined) return;
  if (!Array.isArray(parts) || !parts.length || parts.length > PARTS_MAX) throw new Error(`${where}: parts must list 1 to ${PARTS_MAX} rows`);
  parts.forEach((row, i) => {
    const at = `${where}: parts[${i}]`;
    if (!isObject(row)) throw new Error(`${at}: expected { ${Object.keys(PART_FIELDS).join(", ")} }`);
    const more = Object.keys(row).filter((k) => !(k in PART_FIELDS));
    if (more.length) throw new Error(`${at}: unknown key ${more.join(", ")}; a part takes ${Object.keys(PART_FIELDS).join(", ")}`);
    for (const [field, max] of Object.entries(PART_FIELDS)) {
      // In order, each only once the one before passed: a missing field has no words to count.
      const v = row[field];
      if (badText(v, max)) throw new Error(`${at}: ${field} must be text of 1 to ${max} characters`);
      if (!isPlain(v)) throw new Error(`${at}: ${field} must be plain words: ${PLAIN_WORDS}`);
      if (wordCount(v) > IDEAL_MAX_WORDS) throw new Error(`${at}: ${field} must be at most ${IDEAL_MAX_WORDS} words`);
    }
  });
}

// Throws, naming where, unless doc is a valid ideal: known keys, plain
// words within their limits, dated public sources and, when given, parts.
export function checkIdeal(doc, where) {
  if (!isObject(doc)) throw new Error(`${where}: expected an object`);
  const extra = Object.keys(doc).filter((k) => k !== "sources" && k !== "parts" && !(k in IDEAL_FIELDS));
  if (extra.length) throw new Error(`${where}: unknown key${extra.length > 1 ? "s" : ""} ${extra.join(", ")}; an ideal takes ideal, sources, parts, ${KIND_LIST.join(", ")}`);
  if (typeof doc.ideal !== "string") throw new Error(`${where}: ideal is required`);
  checkPlainFields(doc, where, Object.keys(IDEAL_FIELDS));
  checkTextFields(doc, IDEAL_FIELDS, where);
  checkWordCounts(doc, where, Object.keys(IDEAL_FIELDS));
  if (!Array.isArray(doc.sources) || !doc.sources.length) throw new Error(`${where}: sources must list at least one document`);
  doc.sources.forEach((s, i) => checkSource(s, `${where}: sources[${i}]`));
  checkParts(doc.parts, where);
}

// The ideal per tab: the template's and each pack's, then a repo's file for
// the same tab in its place. A file for a tab no list knows is a usage error,
// and so is a pack's for a template tab or another pack's, as a pack map is.
export function loadIdeals({ templateDir, packDirs = [], repoDir = null, tabIds = TAB_IDS }) {
  const ideals = {};
  for (const dir of [templateDir, ...packDirs, repoDir && repoDir !== templateDir ? repoDir : null]) {
    if (dir && existsSync(dir)) readIdeals(dir, ideals, { tabIds, pack: packDirs.includes(dir) });
  }
  return ideals;
}

// Adds each ideal file in dir to ideals by tab; a pack's may not take a tab that has one.
function readIdeals(dir, ideals, { tabIds, pack }) {
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const tab = file.replace(/\.json$/, "");
    if (!tabIds.has(tab)) throw new Error(`ideals/${file}: ${Object.hasOwn(MOVED_TABS, tab) ? unknownTab(tab) : `no tab "${tab}"`}`);
    if (pack && (TAB_IDS.has(tab) || ideals[tab])) throw new Error(`${dir}/${file}: tab "${tab}" already has an ideal; a pack sets only its own tabs' ideals`);
    const doc = JSON.parse(readFileSync(join(dir, file), "utf8"));
    checkIdeal(doc, `ideals/${file}`);
    ideals[tab] = doc;
  }
}

// What a tab lacks against the rule that each one has an ideal and is scored
// on all three categories: [{ tab, missing }], missing "ideal" or a kind.
export function tabGaps(tabs, defs, ideals) {
  const gaps = [];
  for (const [tab] of tabs) {
    if (!ideals[tab]) gaps.push({ tab, missing: "ideal" });
    for (const kind of KIND_LIST) if (!defs.some((d) => d.tab === tab && d.kind === kind)) gaps.push({ tab, missing: kind });
  }
  return gaps;
}

// Reads a data file written by collect.mjs, or null when it does not exist.
export function loadData(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

// One metric's entry from the CI run and the local run together. A read value
// beats a could_not_check; between two read values the newer read wins; a
// collector's own reason beats a placeholder one (weak, from currentMetrics),
// and of two such reasons the newer run's wins.
export function mergeMetrics(...runs) {
  const merged = {};
  const at = {};
  for (const run of runs.filter(Boolean)) {
    for (const [id, entry] of Object.entries(run.metrics ?? {})) {
      if (replaces(merged[id], entry, at[id], run.generated_at)) [merged[id], at[id]] = [entry, run.generated_at];
    }
  }
  return merged;
}

// Whether `entry` should take the place of `prev` (undefined when none yet).
// Of two collector reasons, the newer run's says why now: a reason a
// maintainer's run wrote yesterday never hides CI's of today. `prevAt` and
// `at` are the runs' generated_at.
function replaces(prev, entry, prevAt = "", at = "") {
  if (!prev) return true;
  if (isMeasured(entry)) return readLater(prev, entry);
  if (isMeasured(prev) || isWeak(entry)) return false;
  return isWeak(prev) || (at ?? "") > (prevAt ?? "");
}

// A measured entry takes the place of a blank one, or of an older reading.
function readLater(prev, entry) {
  return !isMeasured(prev) || (entry.read_at ?? "") > (prev.read_at ?? "");
}

// True when the entry holds a finite number and no could_not_check.
export function isMeasured(entry) {
  return Boolean(entry) && entry.could_not_check === undefined && typeof entry.value === "number" && Number.isFinite(entry.value);
}

// The entries a run keeps: one per current definition, in definition order,
// and none for an id the definitions no longer hold (a metric the template
// cut or the repo dropped). An entry without a value always says why: the
// collector's could_not_check, or a reason written here, never a blank. The
// collector writes runs through this, and build.mjs reads older runs through
// it, so a file from before a cut builds clean and stays on disk as written.
//
// A reason written here, not by a collector, is weak: mergeMetrics lets a
// collector's reason from the other run win over it. The one for a metric no
// collector returned is the page's own sentence, so its rows read as before.
//
// With `stamp` (collect.mjs, writing a run), each entry also records the
// unit its definition had, so a trend charts only points in the unit the
// metric has now (render/model.mjs historyFor). Reading an older run never
// stamps it: its unit is unknown.
const NOT_REPORTED = "No collector reported this metric.";
function weakEntry(entry, def) {
  const valued = typeof entry.value === "number" && Number.isFinite(entry.value);
  const reason = valued ? "the collector returned an empty reason" : "the collector returned no value and no reason";
  return { ...entry, could_not_check: reason, source: entry.source ?? def.source, weak: true };
}

function keepEntry(entry, def) {
  if (isMeasured(entry)) return entry;
  if (!entry || typeof entry !== "object") return { could_not_check: NOT_REPORTED, source: def.source, weak: true };
  if (typeof entry.could_not_check === "string" && entry.could_not_check.trim()) return entry;
  return weakEntry(entry, def);
}

// Each def's current entry from metrics, weak or missing ones marked; with
// stamp, each entry also carries its def's unit.
export function currentMetrics(metrics, defs, { stamp = false } = {}) {
  const out = {};
  for (const def of defs) {
    const kept = keepEntry(metrics?.[def.id], def);
    out[def.id] = stamp ? { ...kept, unit: def.unit ?? "" } : kept;
  }
  return out;
}

// Weak: a placeholder reason (currentMetrics; files from before it say
// `unreported`).
const isWeak = (entry) => Boolean(entry?.weak || entry?.unreported);

// Compares one measured value with its goal and returns its points, 0 to 100,
// and a status for the page: "meets", "near" or "misses".
//   def.goal  the target; meeting it is worth 100
//   def.near  the edge of the near band, between the goal and a clear miss
//   def.direction  "higher" or "lower" is better
export function scoreMetric(def, entry) {
  if (!isMeasured(entry)) return { status: "not-measured", points: null };
  // Banded, so a reader can tell a score's meaning at a glance.
  const atLeast = (edge) => (def.direction === "higher" ? entry.value >= edge : entry.value <= edge);
  if (atLeast(def.goal)) return { status: "meets", points: 100 };
  if (atLeast(def.near)) return { status: "near", points: 50 };
  return { status: "misses", points: 0 };
}

function reviewDate(doc, file) {
  const date = doc.date instanceof Date ? doc.date.toISOString().slice(0, 10) : String(doc.date ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`${file}: date must be YYYY-MM-DD, got "${doc.date ?? ""}"`);
  return date;
}

function reviewItems(doc, file) {
  const items = (doc.items ?? []).filter((it) => typeof it.score === "number");
  const bad = items.find((it) => it.score < 1 || it.score > 5);
  if (bad) throw new Error(`${file}: score ${bad.score} on ${bad.page ?? "an item"} is outside 1 to 5`);
  return items;
}

// The 0 to 100 score of a review's items, or null when none score.
function reviewScore(items) {
  const areaRows = items.filter((it) => it.level === "area");
  const scored = areaRows.length ? areaRows : items;
  if (scored.length === 0) return null;
  const mean = scored.reduce((sum, it) => sum + it.score, 0) / scored.length;
  return Math.round(((mean - 1) / 4) * 100);
}

// One review file as { tab, entry }, or null when it scores nothing.
function readReview(dir, file, tabIds) {
  const doc = parseYaml(readFileSync(join(dir, file), "utf8"));
  if (!doc || !tabIds.has(doc.review)) throw new Error(`${file}: ${Object.hasOwn(MOVED_TABS, doc?.review ?? "") ? unknownTab(doc.review) : `review must name a tab, got "${doc?.review}"`}`);
  // The date places the review in the trend; without it the gauge and the
  // trend would disagree. YAML may read it as a Date, so normalize first.
  const date = reviewDate(doc, file);
  const items = reviewItems(doc, file);
  const score = reviewScore(items);
  return score === null ? null : { tab: doc.review, entry: { file, date, commit: doc.commit, score, items } };
}

// Judgment passes: quality/reviews/<review>-YYYY-MM.yaml, where <review> is a
// tab id (design, usability, code). Files sort by name, so by month. Item scores
// run 1 to 5; the tab's review score maps that mean onto 0 to 100. When any
// item has level: area, only those rows score: they are the reviewer's
// summary, and the per-file rows under them are findings. Throws on an unknown
// review tab or a score outside 1 to 5: a usage error, like a bad target.
export function loadAllReviews(dir, tabIds = TAB_IDS) {
  const byTab = {};
  if (!dir || !existsSync(dir)) return byTab;
  for (const file of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort()) {
    const r = readReview(dir, file, tabIds);
    if (r) (byTab[r.tab] ??= []).push(r.entry);
  }
  return byTab;
}

// The newest review per tab, or the newest dated on or before a day
// ("YYYY-MM-DD"), so an old run in the trend is scored with the review that
// existed then.
export function newestReviews(all, onOrBefore) {
  const out = {};
  for (const [tab, list] of Object.entries(all)) {
    const ok = list.filter((r) => onOrBefore === undefined || String(r.date) <= onOrBefore);
    if (ok.length) out[tab] = ok[ok.length - 1];
  }
  return out;
}

// The newest review per tab from a reviews folder.
export function loadReviews(dir, tabIds) {
  return newestReviews(loadAllReviews(dir, tabIds));
}

function mean(nums) {
  return nums.length ? Math.round(nums.reduce((a, b) => a + b, 0) / nums.length) : null;
}

// Scores one tab. Quality joins the two passes into one verdict: the mean of
// the measured quality metrics and the review score, each weighted equally.
// With no metric measured, the review is the whole quality score.
export function scoreTab(tab, defs, metrics, reviews = {}) {
  const rows = defs
    .filter((d) => d.tab === tab)
    .map((def) => ({ def, entry: metrics[def.id], ...scoreMetric(def, metrics[def.id]) }));
  const part = (kind) => {
    const of = rows.filter((r) => r.def.kind === kind);
    const measured = of.filter((r) => r.points !== null);
    return { score: mean(measured.map((r) => r.points)), measured: measured.length, total: of.length };
  };
  const quality = part("quality");
  const review = reviews[tab] ?? null;
  if (review) {
    quality.metricScore = quality.score;
    quality.score = quality.score === null ? review.score : mean([quality.score, review.score]);
  }
  return { tab, quality, speed: part("speed"), consumption: part("consumption"), rows, review };
}
