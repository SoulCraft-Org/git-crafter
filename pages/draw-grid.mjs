// The trail's node, scale and classes, so the client and the phone layout treat a fork as a trail.

import { esc } from "../quality/render/charts.mjs";
import { GAP, TRAIL, stepNode } from "./draw.mjs";

// Rows sit far enough apart that one node's value line clears the next's halo.
export const GRID = { top: 60, row: 150, foot: 90 };

// Columns spread over the trail's width, so a fork reads at a trail's scale.
function cells(steps) {
  const cols = Math.max(...steps.map((s) => s.at[0]));
  const rows = Math.max(...steps.map((s) => s.at[1]));
  const gap = cols ? Math.max(GAP, (TRAIL.width - 2 * TRAIL.x0) / cols) : 0;
  const xy = Object.fromEntries(steps.map((s) => [s.id, [TRAIL.x0 + s.at[0] * gap, GRID.top + s.at[1] * GRID.row]]));
  return { xy, gap, width: Math.max(TRAIL.width, 2 * TRAIL.x0 + cols * gap), height: GRID.top + rows * GRID.row + GRID.foot };
}

// One map drawn as a grid of step cells, each with its readout; the critical path and the selected step are marked.
export function grid(map, readouts, critical, selected) {
  const steps = map.steps;
  const G = cells(steps);
  const cols = [...new Set(steps.map((s) => s.at[0]))].sort((a, b) => a - b);
  const gap = TRAIL.r + 8;
  const edges = cols.slice(1).flatMap((c, k) => {
    const from = steps.filter((s) => s.at[0] === cols[k]);
    const to = steps.filter((s) => s.at[0] === c);
    return from.flatMap((a) =>
      to.map((b) => {
        const [ax, ay] = G.xy[a.id];
        const [bx, by] = G.xy[b.id];
        const mx = (ax + bx) / 2;
        // Thick only where both ends are on the critical path, as on a trail.
        return `<path class="${critical.has(a.id) && critical.has(b.id) ? "t-main" : "t-off"}" d="M${ax + gap} ${ay}H${mx}V${by}H${bx - gap}"/>`;
      }),
    );
  });
  const hitW = Math.min(132, G.gap - 4 || 132);
  const nodes = steps.map((s, i) => stepNode({ key: `${map.id}-${s.id}`, s, i, ro: readouts[s.id], x: G.xy[s.id][0], y: G.xy[s.id][1], hitW, crit: critical.has(s.id), selected })).join("");
  return `<svg class="trail" viewBox="0 0 ${G.width} ${G.height}" role="group" aria-label="${esc(map.name)}: ${steps.length} steps in ${cols.length} columns; the critical path is the thick line">${edges.join("")}${nodes}</svg>`;
}
