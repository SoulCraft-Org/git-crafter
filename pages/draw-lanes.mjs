// A map whose steps each name an actor, drawn as lanes: one band per actor, in
// the order each first appears, the steps left to right in their own band. It
// reuses the trail's node and the grid's elbow lines, so the client and the
// tests see one markup. The drawing is as wide as a phone's scroll area
// (920 px), so its text reads at full size there.

import { esc } from "../quality/render/charts.mjs";
import { ACTORS, hitWidth, stepNode } from "./draw.mjs";
import { edges } from "./draw-grid.mjs";

// row: one lane's height; the node sits y from its top, so its click area clears the lane's name above it.
export const LANES = { width: 920, x0: 100, minGap: 120, row: 160, y: 72 };

// Each step's column (its fork column, or its place in the list), the lane it sits in and, where two
// steps of a fork share a column and a lane, the row of that lane it takes.
export function place(steps) {
  const order = [...new Set(steps.map((s) => s.actor))];
  const col = Object.fromEntries(steps.map((s, i) => [s.id, s.at ? s.at[0] : i]));
  const slot = {};
  const used = {};
  for (const s of steps) {
    const cell = `${col[s.id]} ${s.actor}`;
    slot[s.id] = used[cell] ?? 0;
    used[cell] = slot[s.id] + 1;
  }
  let top = 0;
  const lanes = order.map((actor) => {
    const rows = 1 + Math.max(...steps.filter((s) => s.actor === actor).map((s) => slot[s.id]));
    const lane = { actor, top, rows };
    top += rows * LANES.row;
    return lane;
  });
  const last = Math.max(...Object.values(col));
  const gap = last ? Math.max(LANES.minGap, (LANES.width - 2 * LANES.x0) / last) : 0;
  const xy = Object.fromEntries(steps.map((s) => [s.id, [LANES.x0 + col[s.id] * gap, lanes[order.indexOf(s.actor)].top + slot[s.id] * LANES.row + LANES.y]]));
  return { lanes, col, xy, gap, width: Math.max(LANES.width, 2 * LANES.x0 + last * gap), height: top };
}

// One map drawn as lanes, a band and a name for each actor; the critical path and the selected step are marked.
export function lanes(map, readouts, critical, selected) {
  const steps = map.steps;
  const P = place(steps);
  const names = P.lanes.map((l) => ACTORS[l.actor] ?? l.actor);
  const bands = P.lanes
    .map((l, i) => `<rect class="t-lane${i % 2 ? " alt" : ""}" x="0" y="${l.top}" width="${P.width}" height="${l.rows * LANES.row}"/><text class="t-actor" x="10" y="${l.top + 16}">${esc(names[i])}</text>`)
    .join("");
  const placed = steps.map((s) => ({ ...s, at: [P.col[s.id], 0] }));
  const hitW = hitWidth(P.gap);
  const nodes = steps.map((s, i) => stepNode({ key: `${map.id}-${s.id}`, s, i, ro: readouts[s.id], x: P.xy[s.id][0], y: P.xy[s.id][1], hitW, crit: critical.has(s.id), selected })).join("");
  return `<svg class="trail lanes" viewBox="0 0 ${P.width} ${P.height}" role="group" aria-label="${esc(map.name)}: ${steps.length} steps in ${names.length} lanes, one each for ${esc(names.join(", "))}; the critical path is the thick line">${bands}${edges(placed, P.xy, critical).join("")}${nodes}</svg>`;
}
