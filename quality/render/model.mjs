// The numbers the Quality, Speed and Consumption page derives from scored tabs: the
// overall scores, the Fix first ranking, row order and groups, and the review
// heatmap's grid. Pure functions over score.mjs output; page.mjs draws them.

import { finite } from "./charts.mjs";

const mean = (nums) => nums.reduce((a, b) => a + b, 0) / nums.length;

// Overall Quality and Speed: the mean of the tab scores that are not null,
// each tab weighted equally, with how many tabs were measured.
export function overall(results) {
  // Each category's score is the mean of the tabs that have it measured; its
  // total counts the tabs that define a metric in it (every tab should).
  const part = (kind, tabs = results) => {
    const scores = tabs.map((r) => r[kind]?.score).filter(finite);
    return { score: scores.length ? Math.round(mean(scores)) : null, measured: scores.length, total: tabs.length };
  };
  const quality = part("quality");
  const speed = part("speed");
  const consumption = part("consumption", results.filter((r) => r.consumption?.total));
  return { quality, speed, consumption, master: master(results) };
}

// The master score: Quality, Speed and Consumption
// weigh a third each. Each category is the mean of the tabs scored in it,
// and the master is the mean of the three. A tab's own score is the mean of
// its categories, a third each. A tab or metric with nothing measured is
// counted and shown, never scored as 0.
const tabScore = (r) => {
  const parts = [r.quality.score, r.speed.score, r.consumption?.score].filter(finite);
  return parts.length ? mean(parts) : null;
};
const KINDS = ["quality", "speed", "consumption"];
const categoryScores = (results) =>
  Object.fromEntries(KINDS.map((k) => [k, results.map((r) => r[k]?.score).filter(finite)]));
// The page's overall score, the mean of each category's mean, with how many
// tabs, categories and metrics it rests on.
export function master(results) {
  const cats = categoryScores(results);
  const scored = KINDS.filter((k) => cats[k].length).map((k) => mean(cats[k]));
  const rows = results.flatMap((r) => r.rows ?? []);
  return {
    score: scored.length ? Math.round(mean(scored)) : null,
    measured: results.filter((r) => finite(tabScore(r))).length,
    total: results.length,
    categories: scored.length,
    metricsMeasured: rows.filter((row) => finite(row.points)).length,
    metricsTotal: rows.length,
  };
}

// Inside a kind and a group: misses, near, meets, not measured, then file
// order (Array.prototype.sort is stable).
const RANK = { misses: 0, near: 1, meets: 2, "not-measured": 3 };
// Rows worst status first, misses before near before meets.
export const sortRows = (rows) => [...rows].sort((a, b) => RANK[a.status] - RANK[b.status]);

// Rows without a group come first, then each group in the order its first
// row appears in the targets file. A group's mean is over its measured rows.
export function groupRows(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = typeof r.def.group === "string" && r.def.group ? r.def.group : "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return [...groups]
    .sort(([a], [b]) => (a === "" ? -1 : 0) - (b === "" ? -1 : 0))
    .map(([group, list]) => {
      const points = list.map((r) => r.points).filter(finite);
      return { group: group || null, rows: sortRows(list), mean: points.length ? Math.round(mean(points)) : null };
    });
}

// How far a miss is past its goal, in near-band widths, so a miss on
// "functions" and a miss on "seconds" rank on one scale.
export function gap(def, value) {
  const band = Math.max(Math.abs(def.goal - def.near), Math.abs(def.goal) * 0.1, 1);
  return def.direction === "lower" ? (value - def.goal) / band : (def.goal - value) / band;
}

// The work queue: every metric near or missing its
// goal, across all tabs and kinds, ranked by the master points it would add by
// meeting its goal, then by its gap. A metric's gain moves its tab's kind score
// by (100 - points) / the kind's measured metrics (halved where a review shares
// the quality score), its category by that over the tabs scored in it, and the
// master by that over the scored categories.
export function workQueue(results) {
  const cats = categoryScores(results);
  const nCats = KINDS.filter((k) => cats[k].length).length;
  return results
    .flatMap((r) => {
      return r.rows
        .filter((row) => (row.status === "misses" || row.status === "near") && finite(r[row.def.kind]?.score))
        .map((row) => {
          const part = r[row.def.kind];
          const share = row.def.kind === "quality" && r.review && finite(part.metricScore) ? 0.5 : 1;
          const gain = ((100 - row.points) / part.measured) * share / cats[row.def.kind].length / nCats;
          return { ...row, tab: r.tab, gain: Math.round(gain * 10) / 10, gap: gap(row.def, row.entry.value) };
        });
    })
    .sort((a, b) => b.gain - a.gain || b.gap - a.gap);
}

// The n missed goals farthest from their goal, across all tabs.
export function fixFirst(results, n = 8) {
  return results
    .flatMap((r) => r.rows.filter((row) => row.status === "misses").map((row) => ({ ...row, tab: r.tab, gap: gap(row.def, row.entry.value) })))
    .sort((a, b) => b.gap - a.gap)
    .slice(0, n);
}

// A tab's worst gaps: its rows near or missing
// their goal, furthest first, in near-band widths as Fix first measures.
export function worstGaps(rows, n = 5) {
  return rows
    .filter((row) => row.status === "misses" || row.status === "near")
    .map((row) => ({ ...row, gap: gap(row.def, row.entry.value) }))
    .sort((a, b) => b.gap - a.gap)
    .slice(0, n);
}

// One value a week from the history runs: the last read in each UTC week,
// labeled by its Monday, oldest first.
//
// Given the metric's definition, only points measured as it is defined now
// count (historyFor); given only an id, every point does.
export function weeklyHistory(history, def) {
  return historyFor(history, def).points;
}

// The week-by-week points of one metric, and how many older reads were left
// out as measured under another definition: a read dated before the target's
// `defined` day, or one stamped with a unit the metric no longer has. An
// older, unstamped read's unit is unknown: it counts only while no stamped
// read shows the unit changed.
//
// by "day" keeps the last read of each UTC day instead, labeled by its date:
// a process map step's trend line (pages/maps-tab.mjs).
export function historyFor(history, def, { by = "week" } = {}) {
  const id = typeof def === "string" ? def : def.id;
  const bucket = by === "day" ? (at) => new Date(at).toISOString().slice(0, 10) : mondayOf;
  const fits = fitsDefinition(history, def);
  const weeks = new Map();
  let dropped = 0;
  for (const run of history) {
    const entry = run?.metrics?.[id];
    const at = Date.parse(run?.generated_at);
    if (!isRead(entry, at)) continue;
    if (!fits(entry, new Date(at).toISOString().slice(0, 10))) {
      dropped += 1;
      continue;
    }
    const key = bucket(at);
    if (!(weeks.get(key)?.at > at)) weeks.set(key, { at, value: entry.value });
  }
  return { points: [...weeks].sort(([a], [b]) => (a < b ? -1 : 1)).map(([label, p]) => ({ label, value: p.value })), dropped };
}

// Whether a read, on a day, was measured as the definition says now.
function fitsDefinition(history, def) {
  const id = typeof def === "string" ? def : def.id;
  const unit = typeof def === "string" ? null : (def.unit ?? "");
  const defined = typeof def === "string" ? null : (def.defined ?? null);
  const stamped = (e) => typeof e?.unit === "string";
  const changed = unit !== null && history.some((run) => stamped(run?.metrics?.[id]) && run.metrics[id].unit !== unit);
  return (e, day) => unit === null || ((defined === null || day >= defined) && (stamped(e) ? e.unit === unit : !changed));
}

// A read with a number and a date.
const isRead = (entry, at) => Boolean(entry) && entry.could_not_check === undefined && finite(entry.value) && Number.isFinite(at);

// The Monday (UTC, YYYY-MM-DD) of the week holding a time.
function mondayOf(at) {
  const d = new Date(at);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7))).toISOString().slice(0, 10);
}

// Every row with no number yet, across all tabs.
export const notMeasured = (results) =>
  results.flatMap((r) => r.rows.filter((row) => row.status === "not-measured").map((row) => ({ ...row, tab: r.tab })));

// ---- Review heatmap -------------------------------------------------------

const SHORT_CRITERIA = {
  visual_hierarchy: "Hierarchy",
  typography: "Type",
  color_and_contrast: "Color",
  spacing_and_rhythm: "Spacing",
  consistency: "Consistency",
  imagery_and_art: "Imagery",
  interactive_states: "States",
  responsive_layout: "Responsive",
  "Visibility of system status": "System status",
  "Match between system and the real world": "Real world",
  "User control and freedom": "Control",
  "Consistency and standards": "Consistency",
  "Error prevention": "Error prevention",
  "Recognition rather than recall": "Recognition",
  "Flexibility and efficiency of use": "Efficiency",
  "Aesthetic and minimalist design": "Minimal",
  "Help users recognize, diagnose, and recover from errors": "Recovery",
  "Help and documentation": "Help",
  task: "Task",
  dead_code: "Dead code",
};

// A review criterion's short column label.
export function criterionLabel(c) {
  const s = String(c ?? "");
  if (SHORT_CRITERIA[s]) return SHORT_CRITERIA[s];
  const words = s.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// A review row's label: "Task 3" for task:3, else the page path.
export function pageLabel(page) {
  const s = String(page ?? "");
  const task = /^task:(\d+)$/.exec(s);
  if (task) return `Task ${task[1]}`;
  return s.replace(/^https?:\/\/[^/]+(?=\/|$)/, "") || "/";
}

// Review widths are viewport pixels (1280, 375). An item without one counts
// for both modes.
export function widthMode(w) {
  if (w === null || w === undefined || w === "") return null;
  const n = Number(w);
  return Number.isFinite(n) ? (n >= 768 ? "d" : "p") : null;
}

// The ramp step for a cell: a mean of 3.5 takes the weaker step, 3.
export const rampStep = (v) => Math.min(Math.max(Math.ceil(v - 0.5), 1), 5);
const round1 = (v) => Math.round(v * 10) / 10;

// Rows are pages, columns criteria; each cell holds the mean item score for
// desktop (d), phone (p) and both (b). Rows sort weakest first by their mean
// over "both". When a review has level: area rows, only those fill the grid
// (they are what scores) and the file rows are findings under it.
export function reviewGrid(review) {
  const items = review.items.filter((it) => finite(it.score));
  const hasArea = items.some((it) => it.level === "area");
  const cellItems = hasArea ? items.filter((it) => it.level === "area") : items;
  const findings = hasArea ? items.filter((it) => it.level !== "area") : [];
  const columns = [...new Set(cellItems.map((it) => it.criterion))];
  const pages = [...new Set(cellItems.map((it) => it.page))];
  const avg = (list) => (list.length ? round1(mean(list.map((it) => it.score))) : null);
  const rows = pages.map((page) => {
    const cells = columns.map((c) => {
      const here = cellItems.filter((it) => it.page === page && it.criterion === c);
      if (!here.length) return null;
      return {
        d: avg(here.filter((it) => widthMode(it.width) !== "p")),
        p: avg(here.filter((it) => widthMode(it.width) !== "d")),
        b: avg(here),
      };
    });
    const vals = cells.filter(Boolean).map((c) => c.b);
    return { page, cells, mean: mean(vals) };
  });
  rows.sort((a, b) => a.mean - b.mean);
  const histogram = [1, 2, 3, 4, 5].map((s) => cellItems.filter((it) => rampStep(it.score) === s).length);
  const modes = new Set(cellItems.map((it) => widthMode(it.width)));
  return { columns, rows, findings, histogram, scored: cellItems.length, hasArea, hasWidths: modes.has("d") && modes.has("p") };
}

// The weakest cell over "both": the one the drill-down opens on.
export function weakestCell(grid) {
  let best = null;
  grid.rows.forEach((row, r) =>
    row.cells.forEach((cell, c) => {
      if (cell && (!best || cell.b < best.value)) best = { r, c, value: cell.b };
    }),
  );
  return best;
}

// The items behind one cell: the cell's own rows (desktop first), then for a
// review with areas, the file findings in that area on that criterion.
export function cellItems(review, grid, page, criterion) {
  const items = review.items.filter((it) => it.page === page && it.criterion === criterion && (!grid.hasArea || it.level === "area"));
  items.sort((a, b) => (widthMode(a.width) === "p") - (widthMode(b.width) === "p"));
  const files = grid.hasArea ? grid.findings.filter((it) => it.criterion === criterion && String(it.page).startsWith(`${page}/`)) : [];
  return [...items, ...files.sort((a, b) => a.score - b.score)];
}
